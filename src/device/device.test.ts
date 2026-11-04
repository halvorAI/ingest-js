import { generateApiKey, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceRoutes, DeviceRequestError, forwardEnvelopes, registerDeviceSource } from './index.js';

const apiKey = generateApiKey('live');
const endpoint = 'https://api.example';
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  publicJwk = pair.publicJwk;
});

interface Call {
  url: string;
  authorization: string | null;
  body: Uint8Array;
}

/** A fake HalvorAI that records requests and answers with [respond]. */
function fakeApi(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch: fetchImpl };
}

const accepted = (call: Call): Response => {
  const { events } = JSON.parse(new TextDecoder().decode(call.body)) as {
    events: { event: { id: string } }[];
  };
  return Response.json({ results: events.map((e) => ({ id: e.event.id, status: 'accepted' })) });
};

function envelope(over: Record<string, unknown> = {}) {
  return {
    event: { id: 'evt_01JA8Q4K3T9V2C7M5N6P8R0S1W', environment: 'live', owner: { id: 'own_u_1', type: 'person' }, ...over },
    sig: 'eyJhbGciOiJFZERTQSJ9..c2ln',
  };
}

describe('registerDeviceSource', () => {
  it('registers only the public half and returns the source id', async () => {
    const api = fakeApi(() => Response.json({ id: 'src_device_1' }, { status: 201 }));
    const { sourceId } = await registerDeviceSource({
      apiKey,
      endpoint,
      fetch: api.fetch,
      publicJwk: { ...publicJwk, kid: 'src_pending', alg: 'EdDSA' },
      name: 'iOS app',
    });

    expect(sourceId).toBe('src_device_1');
    expect(api.calls[0]?.url).toBe('https://api.example/v1/sources');
    expect(api.calls[0]?.authorization).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(new TextDecoder().decode(api.calls[0]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'iOS app',
      adapter: 'custom',
      public_jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
    });
  });

  it.each([
    ['a private key', () => ({ ...publicJwk, d: 'secret' }), 'private key'],
    ['another curve', () => ({ ...publicJwk, crv: 'P-256' }), 'Ed25519'],
    ['a short x', () => ({ ...publicJwk, x: 'abc' }), '32 bytes'],
    ['not an object', () => 'key', 'JSON object'],
  ])('refuses %s with 400 and never calls HalvorAI', async (_label, jwk, message) => {
    const api = fakeApi(() => Response.json({ id: 'src_x' }, { status: 201 }));
    const err = await registerDeviceSource({ apiKey, endpoint, fetch: api.fetch, publicJwk: jwk() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceRequestError);
    expect((err as DeviceRequestError).status).toBe(400);
    expect((err as DeviceRequestError).message).toContain(message);
    expect(api.calls).toHaveLength(0);
  });

  it('answers 502 when HalvorAI does not register the key, so the app retries', async () => {
    const api = fakeApi(() => new Response('down', { status: 503 }));
    const err = await registerDeviceSource({ apiKey, endpoint, fetch: api.fetch, publicJwk }).catch(
      (e: unknown) => e,
    );
    expect((err as DeviceRequestError).status).toBe(502);
    expect((err as DeviceRequestError).code).toBe('upstream_error');
  });

  it('refuses to start without a well-formed API key', async () => {
    await expect(registerDeviceSource({ apiKey: 'hk_nope', publicJwk })).rejects.toThrow('api key');
  });
});

describe('forwardEnvelopes', () => {
  it('passes the body to HalvorAI byte for byte and returns its answer unchanged', async () => {
    const api = fakeApi(accepted);
    // Unusual spacing and key order: re-serializing would change these bytes.
    const raw = `{ "events" : [ ${JSON.stringify(envelope())} ] , "extra": 1 }`;
    const result = await forwardEnvelopes(raw, {
      apiKey,
      endpoint,
      fetch: api.fetch,
      expectedOwnerId: 'own_u_1',
    });

    expect(api.calls[0]?.url).toBe('https://api.example/v1/events');
    expect(api.calls[0]?.authorization).toBe(`Bearer ${apiKey}`);
    expect(new TextDecoder().decode(api.calls[0]?.body)).toBe(raw);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      results: [{ id: 'evt_01JA8Q4K3T9V2C7M5N6P8R0S1W', status: 'accepted' }],
    });
  });

  it('returns HalvorAI errors unchanged, such as a per-event rejection or a 503', async () => {
    const api = fakeApi(() => new Response('{"error":{"code":"unavailable"}}', { status: 503 }));
    const result = await forwardEnvelopes(JSON.stringify({ events: [envelope()] }), {
      apiKey,
      endpoint,
      fetch: api.fetch,
      expectedOwnerId: 'own_u_1',
    });
    expect(result.status).toBe(503);
    expect(result.body).toBe('{"error":{"code":"unavailable"}}');
  });

  it.each([
    ['another user as owner', { events: [envelope({ owner: { id: 'own_someone_else', type: 'person' } })] }, 422, 'owner_mismatch'],
    ['no owner', { events: [envelope({ owner: undefined })] }, 422, 'owner_mismatch'],
    ['the other environment', { events: [envelope({ environment: 'test' })] }, 422, 'environment_mismatch'],
    ['no events', { events: [] }, 400, 'invalid_request'],
    ['an envelope without sig', { events: [{ event: envelope().event }] }, 400, 'invalid_request'],
    ['too many envelopes', { events: Array.from({ length: 101 }, () => envelope()) }, 413, 'payload_too_large'],
  ])('refuses %s without calling HalvorAI', async (_label, body, status, code) => {
    const api = fakeApi(accepted);
    const result = await forwardEnvelopes(JSON.stringify(body), {
      apiKey,
      endpoint,
      fetch: api.fetch,
      expectedOwnerId: 'own_u_1',
    });
    expect(result.status).toBe(status);
    expect((JSON.parse(result.body) as { error: { code: string } }).error.code).toBe(code);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses a body that is not JSON, or too large', async () => {
    const api = fakeApi(accepted);
    const options = { apiKey, endpoint, fetch: api.fetch, expectedOwnerId: 'own_u_1' };
    expect((await forwardEnvelopes('not json', options)).status).toBe(400);
    expect((await forwardEnvelopes('x'.repeat(1_000_001), options)).status).toBe(413);
    expect(api.calls).toHaveLength(0);
  });

  it('answers 502 when HalvorAI cannot be reached, so the app retries', async () => {
    const result = await forwardEnvelopes(JSON.stringify({ events: [envelope()] }), {
      apiKey,
      endpoint,
      fetch: () => Promise.reject(new Error('ECONNRESET')),
      expectedOwnerId: 'own_u_1',
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain('upstream_error');
  });
});

describe('deviceRoutes', () => {
  const routes = (fetchImpl: typeof fetch, ownerId: string | null = 'own_u_1') =>
    deviceRoutes({ apiKey, endpoint, fetch: fetchImpl, ownerId: () => ownerId });

  it('register answers {source_id} for a signed-in user', async () => {
    const api = fakeApi(() => Response.json({ id: 'src_device_7' }, { status: 201 }));
    const res = await routes(api.fetch).register(
      new Request('https://app.example/halvor/sources', {
        method: 'POST',
        body: JSON.stringify({ public_jwk: publicJwk, name: 'Android app' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source_id: 'src_device_7' });
  });

  it('register refuses a private key with 400 in HalvorAI error format', async () => {
    const api = fakeApi(() => Response.json({ id: 'src_x' }, { status: 201 }));
    const res = await routes(api.fetch).register(
      new Request('https://app.example/halvor/sources', {
        method: 'POST',
        body: JSON.stringify({ public_jwk: { ...publicJwk, d: 'secret' } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('forward checks the owner against the session and relays HalvorAI', async () => {
    const api = fakeApi(accepted);
    const res = await routes(api.fetch).forward(
      new Request('https://app.example/halvor/events', {
        method: 'POST',
        body: JSON.stringify({ events: [envelope()] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(api.calls).toHaveLength(1);
  });

  it.each([204, 205])('forward relays a bodyless %i from HalvorAI', async (status) => {
    const api = fakeApi(() => new Response(null, { status }));
    const res = await routes(api.fetch).forward(
      new Request('https://app.example/halvor/events', {
        method: 'POST',
        body: JSON.stringify({ events: [envelope()] }),
      }),
    );
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
    expect(api.calls).toHaveLength(1);
  });

  it('both routes answer 401 without a signed-in user, which the app retries later', async () => {
    const api = fakeApi(accepted);
    const r = routes(api.fetch, null);
    const post = (path: string) => new Request(`https://app.example${path}`, { method: 'POST', body: '{}' });
    expect((await r.register(post('/halvor/sources'))).status).toBe(401);
    expect((await r.forward(post('/halvor/events'))).status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });

  it('fails at setup, not on the first request, without an API key', () => {
    expect(() => deviceRoutes({ apiKey: '', ownerId: () => 'x' })).toThrow('api key');
  });
});
