import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateApiKey, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HalvorClient, type ClientOptions, type SdkError } from './client.js';
import { createSpool } from './spool.js';

const SOURCE_ID = 'src_01TESTSOURCE0000000000000B';
let privateJwk: JWK;
const apiKey = generateApiKey('test');

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
});

const base = {
  type: 'payment.settled' as const,
  payment: {
    payment_id: 'pi_1',
    rail: 'stripe' as const,
    amount: { value: '100', unit: 'minor' as const, currency: 'USD' },
    status: 'settled' as const,
    rail_ref: { payment_intent: 'pi_1' },
  },
  payee: { type: 'merchant' as const, name: 'Shop' },
};

type Envelope = { event: Record<string, unknown>; sig: string };
type Respond = (events: Envelope[]) => Response;

const accept: Respond = (events) =>
  new Response(JSON.stringify({ results: events.map((e) => ({ id: e.event['id'], status: 'accepted' })) }), {
    status: 202,
  });

function fakeFetch(respond: Respond): { fetch: typeof fetch; sent: Envelope[][] } {
  const sent: Envelope[][] = [];
  const f: typeof fetch = async (_input, init) => {
    const events = (JSON.parse(String(init?.body)) as { events: Envelope[] }).events;
    sent.push(events);
    return respond(events);
  };
  return { fetch: f, sent };
}

let dir: string;
const clients: HalvorClient[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halvor-delivery-'));
});
afterEach(() => {
  while (clients.length > 0) clients.pop()?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function client(respond: Respond, extra: Partial<ClientOptions> = {}) {
  const errors: SdkError[] = [];
  const srv = fakeFetch(respond);
  const c = new HalvorClient({
    apiKey,
    sourceKey: privateJwk,
    fetch: srv.fetch,
    spoolDir: dir,
    retryDelaysMs: [],
    exitHook: false,
    onError: (e) => errors.push(e),
    ...extra,
  });
  clients.push(c);
  return { c, errors, srv };
}

/** Spools events signed by a real client while the API is down. */
async function spoolEvents(count: number): Promise<string[]> {
  const { c } = client(() => new Response('down', { status: 503 }));
  const ids = Array.from({ length: count }, () => c.emit(base));
  await c.flush({ replaySpool: false });
  c.dispose();
  return ids;
}

const pending = () => readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const dead = () => {
  try {
    return readdirSync(join(dir, 'dead')).flatMap((f) =>
      readFileSync(join(dir, 'dead', f), 'utf8').trim().split('\n'),
    );
  } catch {
    return [];
  }
};

describe('spool replay (JS-1)', () => {
  it('dead-letters a file the API rejects for good and still replays the files after it', async () => {
    const idsA = await spoolEvents(2);
    const idsB = await spoolEvents(1);
    expect(pending()).toHaveLength(2);

    const rejected = new Set(idsA);
    const { c, errors, srv } = client((events) =>
      events.some((e) => rejected.has(String(e.event['id'])))
        ? new Response(JSON.stringify({ error: { code: 'unknown_source', message: 'no such source' } }), {
            status: 401,
          })
        : accept(events),
    );
    await c.flush();

    expect(pending()).toEqual([]);
    expect(dead()).toHaveLength(2);
    expect(srv.sent.flat().map((e) => e.event['id'])).toContain(idsB[0]);
    expect(c.stats()).toMatchObject({ dropped: 2, replayed: 1 });
    expect(errors).toContainEqual(expect.objectContaining({ code: 'unauthorized', serverCode: 'unknown_source' }));

    // A second replay does not count the same events as dropped again.
    await c.flush();
    expect(c.stats().dropped).toBe(2);
  });
});

describe('payload too large (JS-2)', () => {
  it('drops a single oversized event instead of spooling it', async () => {
    const { c, errors } = client(() => new Response('', { status: 413 }));
    const id = c.emit(base);
    await c.flush();
    expect(pending()).toEqual([]);
    expect(c.stats()).toMatchObject({ dropped: 1, spooled: 0 });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'delivery_failed', serverCode: 'payload_too_large', eventId: id }),
    );
  });

  it('keeps only the undelivered half of a spool file after a partial replay', async () => {
    const ids = await spoolEvents(4);
    const delivered = new Set(ids.slice(0, 2));
    // Batches of more than two are too large; the second half then hits an outage.
    const { c } = client((events) => {
      if (events.length > 2) return new Response('', { status: 413 });
      return events.every((e) => delivered.has(String(e.event['id'])))
        ? accept(events)
        : new Response('down', { status: 503 });
    });
    await c.flush();
    const files = pending();
    expect(files).toHaveLength(1);
    const left = readFileSync(join(dir, files[0] ?? ''), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as Envelope).event['id']);
    expect(left).toEqual(ids.slice(2));
    expect(c.stats().replayed).toBe(2);
  });
});

describe('error details (JS-8) and permanent statuses', () => {
  it('reports the server code, details and request id on a fatal response', async () => {
    const { c, errors } = client(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'environment_mismatch', message: 'live key, test event', details: [{ path: 'environment' }], request_id: 'req_123' },
          }),
          { status: 422 },
        ),
    );
    c.emit(base);
    await c.flush();
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'delivery_failed',
        serverCode: 'environment_mismatch',
        message: 'live key, test event',
        details: [{ path: 'environment' }],
        requestId: 'req_123',
      }),
    );
  });

  it('treats 404 as permanent: no retries, no spool', async () => {
    const { c, srv } = client(() => new Response('not found', { status: 404 }), { retryDelaysMs: [1, 1, 1] });
    c.emit(base);
    await c.flush();
    expect(srv.sent).toHaveLength(1);
    expect(c.stats()).toMatchObject({ dropped: 1, spooled: 0, retries: 0 });
    expect(pending()).toEqual([]);
  });
});

describe('bounded spool (JS-5)', () => {
  it('evicts the oldest files beyond the size limit', async () => {
    const spool = createSpool(dir, { maxBytes: 1 });
    const env = { event: { id: 'evt_a' }, sig: 's' };
    await spool.write([env]);
    const evicted = await spool.write([env, env]);
    // Both files exceed a 1-byte budget; the oldest goes first, then the newest.
    expect(evicted.files).toBeGreaterThanOrEqual(1);
    expect(evicted.events).toBeGreaterThanOrEqual(1);
  });

  it('evicts files older than the age limit', async () => {
    const old = join(dir, 'halvor-spool-000000000000001-aaaa.jsonl');
    writeFileSync(old, JSON.stringify({ event: { id: 'evt_old' }, sig: 's' }) + '\n');
    const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    const spool = createSpool(dir, { maxAgeMs: 24 * 60 * 60 * 1000 });
    const evicted = await spool.write([{ event: { id: 'evt_new' }, sig: 's' }]);
    expect(evicted).toEqual({ files: 1, events: 1 });
    expect(pending()).toHaveLength(1);
  });

  it('reports evictions and counts the evicted events as dropped', async () => {
    const { c, errors } = client(() => new Response('down', { status: 503 }), { spoolMaxBytes: 1 });
    c.emit(base);
    await c.flush({ replaySpool: false });
    expect(c.stats().dropped).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.code === 'spool' && e.message.includes('evicted'))).toBe(true);
  });
});

describe('client setup (JS-10, JS-3, JS-13)', () => {
  it('refuses a source key that is not Ed25519 when the client is created', async () => {
    const errors: SdkError[] = [];
    const { generateKeyPair, exportJWK } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const p256 = { ...(await exportJWK(privateKey)), kid: 'src_p256' };
    const c = new HalvorClient({ apiKey, sourceKey: p256, exitHook: false, onError: (e) => errors.push(e) });
    clients.push(c);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'config' }));
    c.emit(base);
    expect(c.stats().droppedDisabled).toBe(1);
  });

  it('adds SIGTERM and SIGINT handlers only when asked, and removes them on dispose', () => {
    const before = process.listenerCount('SIGTERM');
    const plain = new HalvorClient({ apiKey, sourceKey: privateJwk, exitHook: false });
    clients.push(plain);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    const withSignals = new HalvorClient({ apiKey, sourceKey: privateJwk, exitHook: false, signals: true });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    withSignals.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('stamps the package version on every event', async () => {
    const got: Envelope[] = [];
    const c = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (e) => {
        got.push(...e);
      },
      exitHook: false,
    });
    clients.push(c);
    c.emit(base);
    await c.flush();
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect((got[0]?.event['source'] as { sdk: string }).sdk).toBe(`@halvorai/ingest@${version}`);
  });
});
