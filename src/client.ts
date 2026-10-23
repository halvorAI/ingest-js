import {
  ApeEventSchema,
  evidenceSha256,
  newId,
  nowUtc,
  parseApiKey,
  signEvent,
  type JWK,
} from '@halvorai/schema';
import { currentContext, type AgentContext } from './context.js';
import { hashInstruction } from './hash.js';
import { redactDeep, redactText, type RedactOptions } from './redact.js';
import { createSpool, type SpoolLimits, type SpoolStore } from './spool.js';
import { postEvents, type ServerError, type SignedEnvelope } from './transport.js';

const SDK_NAME = `@halvorai/ingest@${__SDK_VERSION__}`;
const DEFAULT_BATCH = 100;
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000];
const EXIT_FLUSH_MS = 2000;
const SIGNAL_FLUSH_MS = 5000;

/** Reads an environment variable without crashing in runtimes that have no `process`. */
function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

export type SdkErrorCode =
  'invalid_event' | 'unauthorized' | 'delivery_failed' | 'rejected' | 'spool' | 'config';

export interface SdkError {
  code: SdkErrorCode;
  message: string;
  eventId?: string;
  serverCode?: string;
  details?: unknown[];
  /** The API's request id, to quote to support. */
  requestId?: string;
}

export interface ClientStats {
  emitted: number;
  queued: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  dropped: number;
  droppedInvalid: number;
  droppedDisabled: number;
  droppedClosed: number;
  retries: number;
  spooled: number;
  replayed: number;
}

export interface ClientOptions {
  apiKey?: string;
  sourceKey?: string | JWK;
  environment?: 'test' | 'live';
  endpoint?: string;
  sink?: (envelopes: SignedEnvelope[]) => void | Promise<void>;
  spoolDir?: string;
  /** Spool size before the oldest files are evicted. Default 50 MB. */
  spoolMaxBytes?: number;
  /** Spooled files older than this are evicted. Default 7 days. */
  spoolMaxAgeMs?: number;
  onError?: (error: SdkError) => void;
  redact?: RedactOptions;
  fetch?: typeof fetch;
  batchSize?: number;
  flushIntervalMs?: number;
  retryDelaysMs?: number[];
  /**
   * Flush on `beforeExit` (default true). This does not run on `process.exit()`, on signals or when
   * a serverless runtime freezes the function: in request handlers, `await halvor.flush()` before
   * responding, or pass `halvor.flush()` to the platform's `waitUntil`/`after`.
   */
  exitHook?: boolean;
  /**
   * Flush (up to 5 s) on SIGTERM and SIGINT, then re-raise the signal so the process still exits.
   * Opt in for long-running servers and containers. Default false.
   */
  signals?: boolean;
}

interface PendingRaw {
  id: string;
  input: Record<string, unknown>;
  context: AgentContext | undefined;
}

interface ReadyItem extends SignedEnvelope {
  id: string;
}

interface Delivery {
  /** Events to try again later. */
  pending: ReadyItem[];
  reason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withJitter(baseMs: number): number {
  return Math.floor(baseMs * (1 + Math.random() * 0.2));
}

function cloneInput(input: unknown): Record<string, unknown> | null {
  try {
    return structuredClone(input) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function parseSourceKey(raw: string | JWK | undefined): { jwk: JWK; kid: string } | null {
  if (raw === undefined) return null;
  let jwk: JWK;
  if (typeof raw === 'string') {
    try {
      jwk = JSON.parse(raw) as JWK;
    } catch {
      return null;
    }
  } else {
    jwk = raw;
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null;
  if (typeof jwk.d !== 'string' || jwk.d.length === 0) return null;
  if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) return null;
  return { jwk, kid: jwk.kid };
}

function buildInstruction(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  if (typeof id !== 'string') return undefined;
  let hash = obj['hash'];
  const text = obj['text'];
  if (typeof hash !== 'string' && typeof text === 'string') {
    hash = hashInstruction(text);
  }
  if (typeof hash !== 'string') return undefined;
  const out: Record<string, unknown> = { id, hash };
  if (typeof obj['summary'] === 'string') out['summary'] = obj['summary'];
  if (typeof obj['channel'] === 'string') out['channel'] = obj['channel'];
  if (typeof obj['issued_at'] === 'string') out['issued_at'] = obj['issued_at'];
  if (typeof obj['tool_call_id'] === 'string') out['tool_call_id'] = obj['tool_call_id'];
  return out;
}

export class HalvorClient {
  private readonly apiKey: string | undefined;
  private readonly sourceJwk: JWK | undefined;
  private readonly sourceId: string | undefined;
  private readonly environment: 'test' | 'live' | undefined;
  private readonly endpoint: string | undefined;
  private readonly sink: ClientOptions['sink'];
  private readonly onError: ClientOptions['onError'];
  private readonly redact: RedactOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly retryDelaysMs: number[];
  private readonly spool: SpoolStore | undefined;

  private readonly statsInternal: ClientStats = {
    emitted: 0,
    queued: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    dropped: 0,
    droppedInvalid: 0,
    droppedDisabled: 0,
    droppedClosed: 0,
    retries: 0,
    spooled: 0,
    replayed: 0,
  };

  private readonly rawQueue: PendingRaw[] = [];
  private readonly readyQueue: ReadyItem[] = [];
  private disabled = false;
  private closed = false;
  private configReported = false;
  private draining: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private exitHandler: (() => void) | null = null;
  private signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
  /** When set, interval drains skip spool replay until this time (avoids retry storms). */
  private spoolCooldownUntil = 0;
  private drainReplaySpool = true;
  private rerunDrain = false;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env('HALVOR_API_KEY');
    const sourceRaw = options.sourceKey ?? env('HALVOR_SOURCE_KEY');
    const parsed = parseSourceKey(sourceRaw);
    const keyEnv = typeof apiKey === 'string' ? parseApiKey(apiKey) : null;

    this.sink = options.sink;
    this.onError = options.onError;
    this.redact = options.redact ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    const spoolLimits: Partial<SpoolLimits> = {};
    if (options.spoolMaxBytes !== undefined) spoolLimits.maxBytes = options.spoolMaxBytes;
    if (options.spoolMaxAgeMs !== undefined) spoolLimits.maxAgeMs = options.spoolMaxAgeMs;
    this.spool = options.spoolDir ? createSpool(options.spoolDir, spoolLimits) : undefined;

    if (!parsed) {
      this.disable('source key is missing or is not a private Ed25519 JWK (kty OKP, crv Ed25519) with a kid');
      this.sourceJwk = undefined;
      this.sourceId = undefined;
    } else {
      this.sourceJwk = parsed.jwk;
      this.sourceId = parsed.kid;
    }

    if (this.sink) {
      this.apiKey = undefined;
      this.endpoint = undefined;
      this.environment = options.environment;
      if (!this.environment) {
        this.disable('environment is required when using sink without an API key');
      }
    } else if (!apiKey || !keyEnv) {
      this.disable('api key is missing or malformed');
      this.apiKey = undefined;
      this.endpoint = undefined;
      this.environment = options.environment ?? keyEnv?.env;
    } else {
      this.apiKey = apiKey;
      this.endpoint =
        options.endpoint ??
        env('HALVOR_ENDPOINT') ??
        (keyEnv.env === 'live' ? 'https://api.halvorai.com' : 'https://api.sandbox.halvorai.com');
      this.environment = options.environment ?? keyEnv.env;
    }

    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;

    if (options.exitHook !== false && typeof process !== 'undefined') {
      this.exitHandler = () => {
        void this.flush({ timeoutMs: EXIT_FLUSH_MS });
      };
      process.once('beforeExit', this.exitHandler);
    }

    if (options.signals === true && typeof process !== 'undefined') {
      const handler = (signal: NodeJS.Signals): void => {
        process.off('SIGTERM', handler);
        process.off('SIGINT', handler);
        void this.flush({ timeoutMs: SIGNAL_FLUSH_MS, replaySpool: false }).finally(() => {
          process.kill(process.pid, signal);
        });
      };
      this.signalHandler = handler;
      process.once('SIGTERM', handler);
      process.once('SIGINT', handler);
    }

    // Replay any spool left by a previous process; in-memory queue is empty at construction.
    if (!this.disabled && this.spool) void this.kickDrain({ replaySpool: true });
  }

  /**
   * Debounced background flush. Each emit resets a one-shot timer (same default 1s cadence
   * as a setInterval tick). Prefer setTimeout over setInterval: vitest fake timers are
   * unreliable with setInterval in this suite.
   */
  private scheduleFlushTimer(): void {
    if (this.disabled || this.closed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      return this.kickDrain({ replaySpool: false });
    }, this.flushIntervalMs);
    if (env('VITEST') === undefined) this.flushTimer.unref?.();
  }

  stats(): ClientStats {
    return {
      ...this.statsInternal,
      queued: this.rawQueue.length + this.readyQueue.length,
    };
  }

  emit(input: unknown): string {
    let id: string = newId('evt');
    try {
      if (this.closed) {
        this.statsInternal.droppedClosed++;
        this.statsInternal.emitted++;
        return id;
      }
      if (this.disabled) {
        this.statsInternal.droppedDisabled++;
        this.statsInternal.emitted++;
        this.reportConfigOnce();
        return id;
      }

      if (
        input &&
        typeof input === 'object' &&
        typeof (input as { id?: unknown }).id === 'string'
      ) {
        id = (input as { id: string }).id;
      }

      const cloned = cloneInput(input);
      const context = currentContext();
      this.statsInternal.emitted++;

      if (cloned === null) {
        this.statsInternal.droppedInvalid++;
        this.report({
          code: 'invalid_event',
          message: 'event could not be cloned',
          eventId: id,
          details: [],
        });
        return id;
      }

      this.rawQueue.push({ id, input: cloned, context });
      this.scheduleFlushTimer();
      if (this.rawQueue.length + this.readyQueue.length >= this.batchSize) {
        // Schedule on the timer queue; return the promise so fake timers await it.
        setTimeout(() => this.kickDrain({ replaySpool: false }), 0);
      }
      return id;
    } catch {
      this.statsInternal.emitted++;
      this.statsInternal.droppedInvalid++;
      this.report({
        code: 'invalid_event',
        message: 'emit failed',
        eventId: id,
        details: [],
      });
      return id;
    }
  }

  /**
   * Sends everything queued. Without `timeoutMs` this waits for the full retry schedule (about
   * a minute per batch while the API is down). In request handlers pass a timeout, for example
   * `await halvor.flush({ timeoutMs: 5000 })`; undelivered events stay queued or spooled.
   */
  async flush(
    options: { timeoutMs?: number; replaySpool?: boolean } = {},
  ): Promise<{ drained: boolean }> {
    if (this.disabled && this.rawQueue.length === 0 && this.readyQueue.length === 0) {
      return { drained: true };
    }

    // Cancel the debounced flush so it cannot interleave with retry backoff sleeps.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const replaySpool = options.replaySpool !== false;
    if (replaySpool) this.spoolCooldownUntil = 0;

    const waitIdle = async (): Promise<void> => {
      for (;;) {
        await this.kickDrain({ replaySpool });
        if (this.rawQueue.length === 0 && this.readyQueue.length === 0) return;
      }
    };

    if (options.timeoutMs === undefined) {
      await waitIdle();
      return { drained: true };
    }

    let timedOut = false;
    await Promise.race([
      waitIdle(),
      sleep(options.timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    return { drained: !timedOut && this.rawQueue.length === 0 && this.readyQueue.length === 0 };
  }

  /** Stop timers and refuse new emits. Does not wait for in-flight delivery. */
  dispose(): void {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.exitHandler && typeof process !== 'undefined') {
      process.off('beforeExit', this.exitHandler);
      this.exitHandler = null;
    }
    if (this.signalHandler && typeof process !== 'undefined') {
      process.off('SIGTERM', this.signalHandler);
      process.off('SIGINT', this.signalHandler);
      this.signalHandler = null;
    }
  }

  async close(options: { timeoutMs?: number } = {}): Promise<void> {
    this.dispose();
    // Drain in-memory events only; spool stays on disk for the next process.
    await this.flush({ ...options, replaySpool: false });
  }

  private kickDrain(options: { replaySpool?: boolean } = {}): Promise<void> {
    if (options.replaySpool !== undefined) {
      this.drainReplaySpool = options.replaySpool;
    }
    if (this.draining) {
      this.rerunDrain = true;
      return this.draining;
    }
    const replay = this.drainReplaySpool;
    this.draining = this.drainLoop(replay).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainLoop(replaySpool: boolean): Promise<void> {
    if (replaySpool) await this.replaySpool();

    for (;;) {
      this.rerunDrain = false;
      await this.prepareReady();

      while (this.readyQueue.length > 0) {
        const batch = this.readyQueue.splice(0, this.batchSize);
        const { pending, reason } = await this.deliverBatch(batch);
        await this.park(pending, reason);
        await this.prepareReady();
      }

      if (!this.rerunDrain && this.rawQueue.length === 0 && this.readyQueue.length === 0) {
        break;
      }
    }
  }

  private async prepareReady(): Promise<void> {
    if (this.rawQueue.length === 0) return;
    const pending = this.rawQueue.splice(0, this.rawQueue.length);
    const prepared = await Promise.all(pending.map((item) => this.prepareEvent(item)));
    for (const item of prepared) {
      if (item) this.readyQueue.push(item);
    }
  }

  private async prepareEvent(pending: PendingRaw): Promise<ReadyItem | null> {
    try {
      const event = this.buildEvent(pending);
      this.redactEvent(event);
      const parsed = ApeEventSchema.safeParse(event);
      if (!parsed.success) {
        this.statsInternal.droppedInvalid++;
        this.report({
          code: 'invalid_event',
          message: 'event failed schema validation',
          eventId: pending.id,
          details: parsed.error.issues,
        });
        return null;
      }
      const key = this.sourceJwk;
      if (!key) return null;
      const sig = await signEvent(parsed.data, key);
      return { id: pending.id, event: parsed.data as unknown as Record<string, unknown>, sig };
    } catch (err) {
      this.statsInternal.droppedInvalid++;
      this.report({
        code: 'invalid_event',
        message: err instanceof Error ? err.message : 'prepare failed',
        eventId: pending.id,
        details: [],
      });
      return null;
    }
  }

  private buildEvent(pending: PendingRaw): Record<string, unknown> {
    const input = pending.input;
    const ctx = pending.context;
    const instruction = buildInstruction(input['instruction'] ?? ctx?.instruction);

    const event: Record<string, unknown> = {
      ape_version: '0.1',
      id: pending.id,
      type: input['type'],
      occurred_at: typeof input['occurred_at'] === 'string' ? input['occurred_at'] : nowUtc(),
      environment: (input['environment'] as string | undefined) ?? this.environment,
      source: {
        id: this.sourceId,
        sdk: SDK_NAME,
        adapter: 'custom',
        ...(input['source'] !== null &&
        typeof input['source'] === 'object' &&
        !Array.isArray(input['source'])
          ? (input['source'] as Record<string, unknown>)
          : {}),
      },
      agent: input['agent'] ?? ctx?.agent ?? { id: 'unattributed' },
      owner: input['owner'] ?? ctx?.owner ?? { id: 'unattributed', type: 'business' },
      payment: input['payment'],
      payee: input['payee'],
    };
    if (instruction) event['instruction'] = instruction;
    if (input['instrument'] !== undefined) event['instrument'] = input['instrument'];
    if (input['evidence'] !== undefined) event['evidence'] = input['evidence'];
    if (input['related'] !== undefined) event['related'] = input['related'];
    if (input['labels'] !== undefined) event['labels'] = input['labels'];
    return event;
  }

  private redactEvent(event: Record<string, unknown>): void {
    const payment = event['payment'];
    if (payment && typeof payment === 'object') {
      const p = payment as Record<string, unknown>;
      for (const key of ['description', 'category', 'failure_reason'] as const) {
        if (typeof p[key] === 'string') p[key] = redactText(p[key], this.redact);
      }
    }
    for (const path of [
      ['agent', 'name'],
      ['owner', 'display_name'],
      ['payee', 'name'],
      ['instruction', 'summary'],
    ] as const) {
      const parent = event[path[0]];
      if (parent && typeof parent === 'object') {
        const obj = parent as Record<string, unknown>;
        if (typeof obj[path[1]] === 'string') {
          obj[path[1]] = redactText(obj[path[1]] as string, this.redact);
        }
      }
    }
    if (event['labels'] && typeof event['labels'] === 'object') {
      event['labels'] = redactDeep(event['labels'], this.redact);
    }

    const evidence = event['evidence'];
    if (!Array.isArray(evidence)) return;
    for (const item of evidence) {
      if (!item || typeof item !== 'object') continue;
      const ev = item as Record<string, unknown>;
      if (ev['format'] !== 'json') continue;
      if (ev['value'] !== undefined) {
        ev['value'] = redactDeep(ev['value'], this.redact);
        ev['sha256'] = evidenceSha256(ev['value'] as string | object);
      }
    }
  }

  /**
   * Sends one batch. Returns the events that should be tried again later (the API or sink was
   * unavailable). Everything else is settled: accepted, duplicate, rejected by the server, or
   * dropped because the API will never accept it.
   */
  private async deliverBatch(batch: ReadyItem[]): Promise<Delivery> {
    if (batch.length === 0) return { pending: [] };
    if (this.sink) return this.deliverViaSink(batch);
    return this.deliverViaHttp(batch);
  }

  private async deliverViaSink(batch: ReadyItem[]): Promise<Delivery> {
    const sink = this.sink;
    if (!sink) return { pending: batch, reason: 'no sink' };
    const delays = this.retryDelaysMs;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await sink(batch.map(({ event, sig }) => ({ event, sig })));
        this.statsInternal.accepted += batch.length;
        return { pending: [] };
      } catch (err) {
        if (attempt >= delays.length) {
          return { pending: batch, reason: err instanceof Error ? err.message : 'sink failed' };
        }
        this.statsInternal.retries++;
        await sleep(withJitter(delays[attempt] ?? 1000));
      }
    }
    return { pending: batch, reason: 'sink failed' };
  }

  private async deliverViaHttp(batch: ReadyItem[]): Promise<Delivery> {
    const endpoint = this.endpoint;
    const apiKey = this.apiKey;
    if (!endpoint || !apiKey) return { pending: batch, reason: 'no endpoint' };
    const delays = this.retryDelaysMs;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const outcome = await postEvents(
        this.fetchImpl,
        endpoint,
        apiKey,
        batch.map(({ event, sig }) => ({ event, sig })),
      );

      if (outcome.kind === 'ok') {
        this.applyResults(batch, outcome.results);
        return { pending: [] };
      }

      if (outcome.kind === 'too_large') {
        if (batch.length === 1) {
          // One event the API will never take: retrying or spooling it cannot help.
          await this.dropFatal(batch, 'delivery_failed', {
            ...outcome.error,
            code: outcome.error.code ?? 'payload_too_large',
            message: 'event is larger than the API accepts',
          });
          return { pending: [] };
        }
        const mid = Math.ceil(batch.length / 2);
        const left = await this.deliverViaHttp(batch.slice(0, mid));
        const right = await this.deliverViaHttp(batch.slice(mid));
        const pending = [...left.pending, ...right.pending];
        const reason = right.reason ?? left.reason;
        return reason === undefined ? { pending } : { pending, reason };
      }

      if (outcome.kind === 'fatal') {
        const code: SdkErrorCode =
          outcome.status === 401 || outcome.status === 403 ? 'unauthorized' : 'delivery_failed';
        await this.dropFatal(batch, code, outcome.error);
        return { pending: [] };
      }

      // retryable
      if (attempt >= delays.length) {
        return { pending: batch, reason: outcome.error.message };
      }
      this.statsInternal.retries++;
      await sleep(withJitter(delays[attempt] ?? 1000));
    }
    return { pending: batch, reason: 'delivery failed' };
  }

  /** Counts a batch the API will never accept as dropped, once, and keeps a copy in `dead/`. */
  private async dropFatal(batch: ReadyItem[], code: SdkErrorCode, error: ServerError): Promise<void> {
    this.statsInternal.dropped += batch.length;
    const report: SdkError = { code, message: error.message };
    if (error.code !== undefined) report.serverCode = error.code;
    if (error.details !== undefined) report.details = error.details;
    if (error.requestId !== undefined) report.requestId = error.requestId;
    if (batch.length === 1 && batch[0]) report.eventId = batch[0].id;
    this.report(report);
    if (this.spool) {
      try {
        await this.spool.deadLetter(batch.map(({ event, sig }) => ({ event, sig })));
      } catch (err) {
        this.report({
          code: 'spool',
          message: err instanceof Error ? err.message : 'dead-letter write failed',
        });
      }
    }
  }

  /** Spools events that could not be delivered now, or drops them loudly when there is no spool. */
  private async park(pending: ReadyItem[], reason: string | undefined): Promise<void> {
    if (pending.length === 0) return;
    if (this.spool) {
      try {
        const evicted = await this.spool.write(pending.map(({ event, sig }) => ({ event, sig })));
        this.statsInternal.spooled += pending.length;
        if (evicted.events > 0) {
          this.statsInternal.dropped += evicted.events;
          this.report({
            code: 'spool',
            message: `spool limit reached: evicted ${evicted.events} oldest event(s) in ${evicted.files} file(s)`,
          });
        }
        return;
      } catch (err) {
        this.report({
          code: 'spool',
          message: err instanceof Error ? err.message : 'spool write failed',
        });
      }
    }
    this.statsInternal.dropped += pending.length;
    this.report({ code: 'delivery_failed', message: reason ?? 'delivery failed' });
  }

  private applyResults(
    batch: ReadyItem[],
    results: { id: string; status: string; error?: { code: string } }[],
  ): void {
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const item of batch) {
      const result = byId.get(item.id);
      const status = result?.status ?? 'accepted';
      if (status === 'accepted') this.statsInternal.accepted++;
      else if (status === 'duplicate') this.statsInternal.duplicates++;
      else if (status === 'rejected') {
        this.statsInternal.rejected++;
        const error: SdkError = {
          code: 'rejected',
          message: 'server rejected event',
          eventId: item.id,
        };
        if (result?.error?.code !== undefined) error.serverCode = result.error.code;
        this.report(error);
      } else {
        this.statsInternal.accepted++;
      }
    }
  }

  /**
   * Sends spooled files oldest first, one file in memory at a time. A file the API rejects for
   * good is dead-lettered and the next file is tried. When the API is unavailable, the file keeps
   * only the events that are still undelivered and replay backs off.
   */
  private async replaySpool(): Promise<void> {
    const spool = this.spool;
    if (!spool || this.disabled) return;
    if (Date.now() < this.spoolCooldownUntil) return;
    let names: string[];
    try {
      names = await spool.files();
    } catch (err) {
      this.report({ code: 'spool', message: err instanceof Error ? err.message : 'spool read failed' });
      return;
    }
    for (const file of names) {
      const { envelopes, corrupt } = await spool.read(file);
      if (corrupt > 0) {
        this.report({ code: 'spool', message: `skipped ${corrupt} corrupt spool line(s)` });
      }
      if (envelopes.length === 0) {
        await spool.remove(file);
        continue;
      }

      const items: ReadyItem[] = envelopes.map((e) => ({
        id: String(e.event['id'] ?? ''),
        event: e.event,
        sig: e.sig,
      }));

      const droppedBefore = this.statsInternal.dropped;
      const { pending } = await this.deliverBatch(items);
      const dropped = this.statsInternal.dropped - droppedBefore;
      this.statsInternal.replayed += items.length - pending.length - dropped;

      if (pending.length === 0) {
        await spool.remove(file);
        continue;
      }
      // API still unavailable: keep only what was not delivered, then back off.
      await spool.rewrite(
        file,
        pending.map(({ event, sig }) => ({ event, sig })),
      );
      this.spoolCooldownUntil = Date.now() + (this.retryDelaysMs.at(-1) ?? 32_000);
      return;
    }
  }

  private disable(message: string): void {
    this.disabled = true;
    this.reportConfigOnce(message);
  }

  private reportConfigOnce(message = 'client is disabled due to bad configuration'): void {
    if (this.configReported) return;
    this.configReported = true;
    this.report({ code: 'config', message });
    console.warn(`[halvorai/ingest] ${message}`);
  }

  /** Adapters use this for decode/mapping failures; never throws. */
  notify(error: SdkError): void {
    this.report(error);
  }

  private report(error: SdkError): void {
    try {
      this.onError?.(error);
    } catch {
      // onError must never break the client
    }
  }
}
