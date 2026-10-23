import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApeEventSchema,
  generateApiKey,
  generateSourceKeyPair,
  verifyEvent,
  type JWK,
} from '@halvorai/schema';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HalvorClient, type ClientOptions, type SdkError } from './client.js';
import { withAgentContext } from './context.js';

const SOURCE_ID = 'src_01TESTSOURCE0000000000000A';
let privateJwk: JWK;
let publicJwk: JWK;
const apiKey = generateApiKey('test');

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
  publicJwk = pair.publicJwk;
});

const payment = {
  payment_id: 'pi_1',
  rail: 'stripe' as const,
  amount: { value: '41200', unit: 'minor' as const, currency: 'USD' },
  status: 'settled' as const,
  rail_ref: { payment_intent: 'pi_1' },
};
const payee = { type: 'merchant' as const, name: 'Shop' };
const base = { type: 'payment.settled' as const, payment, payee };

interface Sent {
  url: string;
  headers: Record<string, string>;
  events: { event: Record<string, any>; sig: string }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function server(respond?: (sent: Sent, attempt: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  sent: Sent[];
  attempts: () => number;
} {
  const sent: Sent[] = [];
  let attempts = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    attempts++;
    const body = JSON.parse(String(init?.body)) as { events: Sent['events'] };
    const record: Sent = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      events: body.events,
    };
    sent.push(record);
    if (respond) return respond(record, attempts);
    return accepted(record);
  };
  return { fetch: fakeFetch, sent, attempts: () => attempts };
}

const accepted = (sent: Sent, status = 'accepted') =>
  new Response(
    JSON.stringify({
      results: sent.events.map((e, i) => ({ id: e.event['id'], status, chain_seq: i + 1 })),
    }),
    { status: 202, headers: { 'content-type': 'application/json' } },
  );

const openClients: HalvorClient[] = [];

afterEach(() => {
  while (openClients.length > 0) {
    openClients.pop()?.dispose();
  }
  vi.useRealTimers();
});

function makeClient(overrides: Partial<ClientOptions> = {}) {
  const errors: SdkError[] = [];
  const srv = server();
  const client = new HalvorClient({
    apiKey,
    sourceKey: privateJwk,
    fetch: srv.fetch,
    onError: (e) => errors.push(e),
    exitHook: false,
    ...overrides,
  });
  openClients.push(client);
  return { client, errors, srv };
}

function trackClient(client: HalvorClient): HalvorClient {
  openClients.push(client);
  return client;
}

const allSent = (srv: { sent: Sent[] }) => srv.sent.flatMap((s) => s.events);

const realSetTimeout = globalThis.setTimeout;
const realTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 1));

/** Pump fake timers until `job` settles. Signing can schedule the first retry after the initial advance. */
async function advanceUntil(job: Promise<unknown>, totalMs: number): Promise<void> {
  let settled = false;
  void job.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const step = 500;
  for (let advanced = 0; !settled && advanced < totalMs; advanced += step) {
    await vi.advanceTimersByTimeAsync(step);
    // Signing runs on real time (WebCrypto), so let a real tick pass between fake steps.
    await realTick();
  }
  await job;
}

describe('emit: building the event', () => {
  it('returns an id synchronously and sends a complete, signed, valid event', async () => {
    const { client, srv, errors } = makeClient();
    const id = client.emit(base);
    expect(id).toMatch(/^evt_[0-9A-Z]{26}$/);
    await client.flush();

    const [item] = allSent(srv);
    expect(errors).toEqual([]);
    expect(item?.event).toMatchObject({
      ape_version: '0.1',
      id,
      type: 'payment.settled',
      environment: 'test',
      source: { id: SOURCE_ID, sdk: `@halvorai/ingest@${__SDK_VERSION__}`, adapter: 'custom' },
    });
    expect(new Date(String(item?.event['occurred_at'])).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(ApeEventSchema.safeParse(item?.event).success).toBe(true);
    expect(await verifyEvent(item?.event ?? {}, item?.sig ?? '', publicJwk)).toBe(true);
  });

  it('posts to the endpoint implied by the key, with the key as a bearer token', async () => {
    const { client, srv } = makeClient();
    client.emit(base);
    await client.flush();
    expect(srv.sent[0]?.url).toBe('https://api.sandbox.halvorai.com/v1/events');
    expect(srv.sent[0]?.headers['authorization']).toBe(`Bearer ${apiKey}`);

    const live = makeClient({ apiKey: generateApiKey('live') });
    live.client.emit({ ...base, environment: 'live' });
    await live.client.flush();
    expect(live.srv.sent[0]?.url).toBe('https://api.halvorai.com/v1/events');
    expect(allSent(live.srv)[0]?.event['environment']).toBe('live');
  });

  it('honours an explicit endpoint, id and occurred_at', async () => {
    const { client, srv } = makeClient({ endpoint: 'http://localhost:8787/' });
    client.emit({ ...base, id: 'evt_custom_id_0001', occurred_at: '2026-10-17T09:00:00.000Z' });
    await client.flush();
    expect(srv.sent[0]?.url).toBe('http://localhost:8787/v1/events');
    expect(allSent(srv)[0]?.event).toMatchObject({
      id: 'evt_custom_id_0001',
      occurred_at: '2026-10-17T09:00:00.000Z',
    });
  });

  it('takes agent, owner and instruction from the agent context', async () => {
    const { client, srv } = makeClient();
    await withAgentContext(
      {
        agent: { id: 'agt_travel_12', name: 'Travel agent' },
        owner: { id: 'own_u_4410', type: 'person', country: 'US' },
        instruction: {
          id: 'ins_8890',
          text: 'Book a return flight to Austin under $500 for next Friday.',
          summary: 'Book a flight',
          channel: 'chat',
        },
      },
      async () => {
        client.emit(base);
      },
    );
    await client.flush();
    const event = allSent(srv)[0]?.event;
    expect(event?.['agent']).toEqual({ id: 'agt_travel_12', name: 'Travel agent' });
    expect(event?.['owner']).toEqual({ id: 'own_u_4410', type: 'person', country: 'US' });
    expect(event?.['instruction']).toEqual({
      id: 'ins_8890',
      hash: 'sha256:10dff3ca7c8369a72e80e33eb5cd4dd91c8f55749497f25d38b4c0566845e4fb',
      summary: 'Book a flight',
      channel: 'chat',
    });
    expect(JSON.stringify(event)).not.toContain('Austin'); // the text itself never leaves
  });

  it('lets explicit fields override the context', async () => {
    const { client, srv } = makeClient();
    await withAgentContext(
      { agent: { id: 'agt_ctx' }, owner: { id: 'own_ctx', type: 'business' } },
      async () => {
        client.emit({ ...base, agent: { id: 'agt_explicit' } });
      },
    );
    await client.flush();
    expect(allSent(srv)[0]?.event['agent']).toEqual({ id: 'agt_explicit' });
    expect(allSent(srv)[0]?.event['owner']).toEqual({ id: 'own_ctx', type: 'business' });
  });

  it('marks events without attribution as unattributed instead of dropping them', async () => {
    const { client, srv, errors } = makeClient();
    client.emit(base);
    await client.flush();
    const event = allSent(srv)[0]?.event;
    expect(event?.['agent']).toEqual({ id: 'unattributed' });
    expect(event?.['owner']).toEqual({ id: 'unattributed', type: 'business' });
    expect(errors).toEqual([]);
  });

  it('redacts card numbers, CVCs and secrets from free text before sending', async () => {
    const { client, srv } = makeClient();
    client.emit({
      ...base,
      payment: { ...payment, description: 'paid with 4242 4242 4242 4242, cvc: 123' },
      labels: { note: 'key sk_live_51H8abcDEFghi1234567890' },
    });
    await client.flush();
    const text = JSON.stringify(allSent(srv)[0]?.event);
    expect(text).not.toContain('4242 4242');
    expect(text).not.toContain('sk_live_');
    expect(text).toContain('[redacted:pan]');
    expect(allSent(srv)).toHaveLength(1); // redacted, so the server accepts it
  });

  it('redacts inside JSON evidence and recomputes its digest', async () => {
    const { client, srv } = makeClient();
    const value = { card: { number: '4242424242424242' }, ok: true };
    client.emit({
      ...base,
      evidence: [
        { kind: 'stripe.object', format: 'json', value, sha256: 'sha256:' + '0'.repeat(64) },
      ],
    });
    await client.flush();
    const evidence = allSent(srv)[0]?.event['evidence'][0];
    expect(evidence.value.card.number).toBe('[redacted:pan]');
    expect(evidence.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.sha256).not.toBe('sha256:' + '0'.repeat(64));
  });

  it('leaves signed credentials (JWS and SD-JWT) untouched', async () => {
    const { client, srv } = makeClient();
    const sdjwt =
      'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI0MjQyNDI0MjQyNDI0MjQyIn0.c2ln~WyJzYWx0IiwiayIsInYiXQ~';
    client.emit({
      ...base,
      evidence: [
        {
          kind: 'ap2.payment_mandate',
          format: 'kb-sd-jwt',
          value: sdjwt,
          sha256: 'sha256:' + 'a'.repeat(64),
        },
      ],
    });
    await client.flush();
    const evidence = allSent(srv)[0]?.event['evidence'][0];
    expect(evidence.value).toBe(sdjwt);
    expect(evidence.sha256).toBe('sha256:' + 'a'.repeat(64));
  });

  it('copies its input, so later changes by the caller do not leak in', async () => {
    const { client, srv } = makeClient();
    const input = structuredClone(base);
    client.emit(input);
    input.payment.amount.value = '999999';
    await client.flush();
    expect(allSent(srv)[0]?.event['payment'].amount.value).toBe('41200');
  });
});

describe('invalid input', () => {
  it('is reported to onError and dropped, never thrown', async () => {
    const { client, srv, errors } = makeClient();
    const id = client.emit({ type: 'payment.settled', payment } as never);
    await client.flush();
    expect(id).toMatch(/^evt_/);
    expect(srv.sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'invalid_event', eventId: id });
    expect(errors[0]?.details?.length).toBeGreaterThan(0);
    expect(client.stats()).toMatchObject({ emitted: 1, droppedInvalid: 1, accepted: 0 });
  });

  it('a bad event does not hold up the good ones around it', async () => {
    const { client, srv } = makeClient();
    client.emit(base);
    client.emit({ type: 'nonsense' } as never);
    client.emit(base);
    await client.flush();
    expect(allSent(srv)).toHaveLength(2);
  });
});

describe('batching and timing', () => {
  afterEach(() => vi.useRealTimers());

  it('sends batches of at most 100', async () => {
    const { client, srv } = makeClient();
    for (let i = 0; i < 250; i++) client.emit(base);
    await client.flush();
    expect(srv.sent.map((s) => s.events.length)).toEqual([100, 100, 50]);
    expect(client.stats()).toMatchObject({ emitted: 250, accepted: 250, queued: 0 });
  });

  it('keeps its timers from holding the process open', () => {
    const { client } = makeClient();
    client.emit(base);
    // If a ref'd timer were pending, vitest would hang at exit; closing must also be safe.
    return client.close();
  });
});

describe('server responses', () => {
  it('counts duplicates quietly and reports rejected items', async () => {
    const srv = server(
      (sent) =>
        new Response(
          JSON.stringify({
            results: [
              { id: sent.events[0]?.event['id'], status: 'accepted', chain_seq: 1 },
              { id: sent.events[1]?.event['id'], status: 'duplicate' },
              {
                id: sent.events[2]?.event['id'],
                status: 'rejected',
                error: { code: 'unknown_source', message: 'Unknown or revoked source' },
              },
            ],
          }),
          { status: 202 },
        ),
    );
    const errors: SdkError[] = [];
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: srv.fetch,
        onError: (e) => errors.push(e),
        exitHook: false,
      }),
    );
    const ids = [client.emit(base), client.emit(base), client.emit(base)];
    await client.flush();
    expect(client.stats()).toMatchObject({ accepted: 1, duplicates: 1, rejected: 1 });
    expect(errors).toEqual([
      expect.objectContaining({ code: 'rejected', eventId: ids[2], serverCode: 'unknown_source' }),
    ]);
    expect(srv.attempts()).toBe(1); // a rejection is final: never retried
  });

  it('drops a batch the server will never accept (400, 401, 403, 422) and says why', async () => {
    for (const status of [400, 401, 403, 422]) {
      const srv = server(
        () => new Response(JSON.stringify({ error: { code: 'x', message: 'no' } }), { status }),
      );
      const errors: SdkError[] = [];
      const client = trackClient(
        new HalvorClient({
          apiKey,
          sourceKey: privateJwk,
          fetch: srv.fetch,
          onError: (e) => errors.push(e),
          exitHook: false,
        }),
      );
      client.emit(base);
      await client.flush();
      expect(srv.attempts(), String(status)).toBe(1);
      expect(client.stats().dropped, String(status)).toBe(1);
      expect(errors[0]?.code, String(status)).toBe(
        status === 401 || status === 403 ? 'unauthorized' : 'delivery_failed',
      );
    }
  });

  it('splits a batch that is too large (413) and sends the halves', async () => {
    const srv = server((sent) =>
      sent.events.length > 2 ? new Response('{}', { status: 413 }) : accepted(sent),
    );
    const client = trackClient(
      new HalvorClient({ apiKey, sourceKey: privateJwk, fetch: srv.fetch, exitHook: false }),
    );
    for (let i = 0; i < 5; i++) client.emit(base);
    await client.flush();
    expect(client.stats()).toMatchObject({ accepted: 5, dropped: 0 });
    expect(
      allSent(srv).filter(
        (e, i, all) => all.findIndex((x) => x.event['id'] === e.event['id']) === i,
      ),
    ).toHaveLength(5);
  });
});

describe('retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a 500 and delivers the same signed event once the API recovers', async () => {
    const srv = server((sent, attempt) =>
      attempt < 3 ? new Response('oops', { status: 503 }) : accepted(sent),
    );
    const client = trackClient(
      new HalvorClient({ apiKey, sourceKey: privateJwk, fetch: srv.fetch, exitHook: false }),
    );
    const id = client.emit(base);
    const done = client.flush();
    await advanceUntil(done, 10_000);
    expect(srv.attempts()).toBe(3);
    expect(client.stats()).toMatchObject({ accepted: 1, retries: 2, dropped: 0 });
    const ids = new Set(allSent(srv).map((e) => e.event['id']));
    expect(ids).toEqual(new Set([id]));
    const sigs = new Set(allSent(srv).map((e) => e.sig));
    expect(sigs.size).toBe(1);
  });

  it('retries 429 and network errors too', async () => {
    const srv = server((sent, attempt) => {
      if (attempt === 1) return new Response('slow down', { status: 429 });
      if (attempt === 2) throw new TypeError('fetch failed');
      return accepted(sent);
    });
    const client = trackClient(
      new HalvorClient({ apiKey, sourceKey: privateJwk, fetch: srv.fetch, exitHook: false }),
    );
    client.emit(base);
    const done = client.flush();
    await advanceUntil(done, 10_000);
    expect(client.stats()).toMatchObject({ accepted: 1, retries: 2 });
  });

  it('loses nothing when the API is down for 60 seconds', async () => {
    const start = Date.now();
    const down = () => Date.now() < start + 60_000;
    const srv = server((sent) => {
      if (down()) throw new TypeError('connect ECONNREFUSED');
      return accepted(sent);
    });
    const errors: SdkError[] = [];
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: srv.fetch,
        onError: (e) => errors.push(e),
        exitHook: false,
      }),
    );
    const ids = Array.from({ length: 5 }, () => client.emit(base));
    // Events keep arriving during the outage.
    await vi.advanceTimersByTimeAsync(20_000);
    ids.push(client.emit(base), client.emit(base));
    await vi.advanceTimersByTimeAsync(80_000);
    await client.flush();

    const delivered = new Set(
      allSent(srv)
        .filter(() => !down())
        .map((e) => e.event['id']),
    );
    for (const id of ids) expect(delivered.has(id), id).toBe(true);
    expect(client.stats()).toMatchObject({
      emitted: 7,
      accepted: 7,
      dropped: 0,
      spooled: 0,
      queued: 0,
    });
    expect(errors).toEqual([]);
  });

  it('after six retries without a spool it gives up loudly, then keeps working', async () => {
    let healthy = false;
    const srv = server((sent) =>
      healthy ? accepted(sent) : new Response('down', { status: 502 }),
    );
    const errors: SdkError[] = [];
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: srv.fetch,
        onError: (e) => errors.push(e),
        exitHook: false,
      }),
    );
    client.emit(base);
    const done = client.flush();
    await advanceUntil(done, 200_000);
    expect(srv.attempts()).toBe(7); // the first try plus six retries
    expect(client.stats()).toMatchObject({ dropped: 1, accepted: 0, retries: 6 });
    expect(errors.some((e) => e.code === 'delivery_failed')).toBe(true);

    healthy = true;
    client.emit(base);
    await client.flush();
    expect(client.stats().accepted).toBe(1);
  });
});

describe('spool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halvor-spool-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes undeliverable batches to disk and replays them once the API is back', async () => {
    let healthy = false;
    const srv = server((sent) =>
      healthy ? accepted(sent) : new Response('down', { status: 503 }),
    );
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: srv.fetch,
        spoolDir: dir,
        exitHook: false,
      }),
    );
    const ids = [client.emit(base), client.emit(base)];
    const done = client.flush();
    await advanceUntil(done, 200_000);

    expect(client.stats()).toMatchObject({ spooled: 2, dropped: 0 });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0] ?? ''), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: { id: ids[0] },
      sig: expect.any(String),
    });

    healthy = true;
    client.emit(base);
    await client.flush();
    expect(client.stats()).toMatchObject({ replayed: 2, accepted: 3 });
    expect(readdirSync(dir)).toEqual([]);
    const delivered = new Set(allSent(srv).map((e) => e.event['id']));
    for (const id of ids) expect(delivered.has(id)).toBe(true);
  });

  it('replays what a previous process left behind', async () => {
    let healthy = false;
    const first = server((sent) =>
      healthy ? accepted(sent) : new Response('down', { status: 503 }),
    );
    const a = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: first.fetch,
        spoolDir: dir,
        exitHook: false,
      }),
    );
    const id = a.emit(base);
    const done = a.flush();
    await advanceUntil(done, 200_000);
    await a.close();
    expect(readdirSync(dir)).toHaveLength(1);

    healthy = true;
    vi.useRealTimers();
    const second = server();
    const b = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: second.fetch,
        spoolDir: dir,
        exitHook: false,
      }),
    );
    await b.flush();
    expect(allSent(second).map((e) => e.event['id'])).toEqual([id]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('skips corrupt spool lines and reports them', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(dir, 'halvor-spool-0-bad.jsonl'),
      'not json\n{"event":{"id":"evt_x"},"sig":"s"}\n',
    );
    const errors: SdkError[] = [];
    const srv = server();
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: srv.fetch,
        spoolDir: dir,
        onError: (e) => errors.push(e),
        exitHook: false,
      }),
    );
    await client.flush();
    expect(allSent(srv)).toHaveLength(1);
    expect(errors.some((e) => e.code === 'spool')).toBe(true);
  });
});

describe('sink (self-hosting)', () => {
  it('hands signed envelopes to the sink and never touches the network', async () => {
    const got: { event: Record<string, unknown>; sig: string }[] = [];
    const fetchSpy = vi.fn();
    const client = trackClient(
      new HalvorClient({
        sourceKey: privateJwk,
        environment: 'test',
        sink: async (envelopes) => {
          got.push(...envelopes);
        },
        fetch: fetchSpy as never,
        exitHook: false,
      }),
    );
    client.emit(base);
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(got).toHaveLength(1);
    expect(await verifyEvent(got[0]?.event ?? {}, got[0]?.sig ?? '', publicJwk)).toBe(true);
    expect(client.stats().accepted).toBe(1);
  });

  it('a failing sink is retried like an API outage', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = trackClient(
        new HalvorClient({
          sourceKey: privateJwk,
          environment: 'test',
          retryDelaysMs: [50, 50, 50],
          sink: async () => {
            if (++calls < 3) throw new Error('disk full');
          },
          exitHook: false,
        }),
      );
      client.emit(base);
      const done = client.flush();
      await advanceUntil(done, 60_000);
      expect(calls).toBe(3);
      expect(client.stats().accepted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

describe('flush and close', () => {
  it('flush gives up at the time cap and says it did not finish', async () => {
    const client = trackClient(
      new HalvorClient({
        apiKey,
        sourceKey: privateJwk,
        fetch: (() => new Promise(() => undefined)) as typeof fetch, // never answers
        exitHook: false,
      }),
    );
    client.emit(base);
    const started = Date.now();
    const result = await client.flush({ timeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.drained).toBe(false);
    await client.close({ timeoutMs: 10 });
  });

  it('flush on an empty client returns at once', async () => {
    const { client } = makeClient();
    expect(await client.flush()).toEqual({ drained: true });
  });

  it('emit after close is counted and ignored, not thrown', async () => {
    const { client, srv } = makeClient();
    await client.close();
    expect(() => client.emit(base)).not.toThrow();
    await client.flush();
    expect(srv.sent).toEqual([]);
    expect(client.stats().droppedClosed).toBe(1);
  });
});

describe('configuration', () => {
  it('never throws for a missing or malformed key; reports once and drops events', async () => {
    for (const options of [
      {},
      { apiKey: 'nope', sourceKey: privateJwk },
      { apiKey, sourceKey: '{not json' },
      { apiKey, sourceKey: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } }, // public key only
      { apiKey, sourceKey: { ...privateJwk, kid: undefined } }, // no source id
    ]) {
      const errors: SdkError[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const client = trackClient(
        new HalvorClient({
          ...(options as ClientOptions),
          onError: (e) => errors.push(e),
          exitHook: false,
        }),
      );
      expect(() => client.emit(base)).not.toThrow();
      await client.flush();
      expect(
        errors.filter((e) => e.code === 'config'),
        JSON.stringify(options),
      ).toHaveLength(1);
      expect(client.stats().droppedDisabled).toBe(1);
      warn.mockRestore();
    }
  });

  it('reads the key, source key and endpoint from the environment', async () => {
    const srv = server();
    vi.stubEnv('HALVOR_API_KEY', apiKey);
    vi.stubEnv('HALVOR_SOURCE_KEY', JSON.stringify(privateJwk));
    try {
      const client = trackClient(new HalvorClient({ fetch: srv.fetch, exitHook: false }));
      client.emit(base);
      await client.flush();
      expect(allSent(srv)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts the source key as a JSON string or an object', async () => {
    for (const sourceKey of [JSON.stringify(privateJwk), privateJwk]) {
      const { client, srv } = makeClient({ sourceKey });
      client.emit(base);
      await client.flush();
      expect(allSent(srv)).toHaveLength(1);
    }
  });
});

describe('stats', () => {
  it('start at zero', () => {
    const { client } = makeClient();
    expect(client.stats()).toEqual({
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
    });
  });
});
