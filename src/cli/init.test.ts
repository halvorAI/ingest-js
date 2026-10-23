import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateApiKey, generateSourceKeyPair, verifyEvent, type JWK } from '@halvorai/schema';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dashboardFor, runInit, upsertEnvFile } from './init.js';

const apiKey = generateApiKey('test');
let publicJwk: JWK;

beforeAll(async () => {
  publicJwk = (await generateSourceKeyPair()).publicJwk;
});

describe('upsertEnvFile', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates and updates keys without dropping neighbours', () => {
    dir = mkdtempSync(join(tmpdir(), 'halvor-env-'));
    const path = join(dir, 'sub', '.env.local');
    upsertEnvFile(path, { HALVOR_API_KEY: 'hk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    upsertEnvFile(path, {
      HALVOR_API_KEY: 'hk_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      HALVOR_SOURCE_KEY: '{"kty":"OKP"}',
    });
    writeFileSync(path, readFileSync(path, 'utf8') + 'OTHER=1\n', 'utf8');
    upsertEnvFile(path, { HALVOR_SOURCE_KEY: '{"kty":"OKP","d":"x"}' });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('HALVOR_API_KEY=hk_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(text).toContain(`HALVOR_SOURCE_KEY='{"kty":"OKP","d":"x"}'`);
    expect(text).toContain('OTHER=1');
    expect(text.match(/HALVOR_API_KEY=/g)).toHaveLength(1);
  });
});

describe('runInit', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('registers a source, writes .env.local and delivers a signed test event', async () => {
    dir = mkdtempSync(join(tmpdir(), 'halvor-init-'));
    const calls: { url: string; method: string; body: unknown }[] = [];
    let registeredPublic: JWK | undefined;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/v1/sources') && method === 'POST') {
        registeredPublic = body.public_jwk as JWK;
        expect(body).toMatchObject({ name: 'ci-runner', adapter: 'custom' });
        expect(body.public_jwk.d).toBeUndefined();
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${apiKey}`,
        });
        return new Response(JSON.stringify({ id: 'src_01INITTESTSOURCE00000000001' }), {
          status: 201,
        });
      }

      if (url.endsWith('/v1/events') && method === 'POST') {
        const events = body.events as { event: Record<string, unknown>; sig: string }[];
        expect(events).toHaveLength(1);
        const item = events[0];
        expect(item).toBeDefined();
        if (item === undefined) return new Response('missing event', { status: 500 });
        expect(item.event['source']).toMatchObject({
          id: 'src_01INITTESTSOURCE00000000001',
          adapter: 'custom',
        });
        expect(await verifyEvent(item.event, item.sig, registeredPublic ?? publicJwk)).toBe(true);
        return new Response(
          JSON.stringify({
            results: [{ id: item.event['id'], status: 'accepted', chain_seq: 1 }],
          }),
          { status: 202 },
        );
      }

      return new Response('not found', { status: 404 });
    };

    const logs: string[] = [];
    const result = await runInit({
      apiKey,
      cwd: dir,
      name: 'ci-runner',
      fetch: fetchImpl,
      log: (line) => logs.push(line),
    });

    expect(result.sourceId).toBe('src_01INITTESTSOURCE00000000001');
    expect(result.eventId).toMatch(/^evt_/);
    expect(result.endpoint).toBe('https://api.sandbox.halvorai.com');
    expect(result.dashboardUrl).toBe(`https://app.halvorai.com/payments?event=${result.eventId}`);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.sandbox.halvorai.com/v1/sources',
      'https://api.sandbox.halvorai.com/v1/events',
    ]);

    const env = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(env).toContain(`HALVOR_API_KEY=${apiKey}`);
    expect(env).toContain('HALVOR_SOURCE_KEY=');
    expect(env).toContain('src_01INITTESTSOURCE00000000001');
    expect(env).toContain('"d":');
    expect(env).not.toContain('HALVOR_ENDPOINT');
    expect(logs.some((l) => l.includes(result.dashboardUrl))).toBe(true);
  });

  it('saves a chosen endpoint and links to the event on the matching dashboard', async () => {
    dir = mkdtempSync(join(tmpdir(), 'halvor-init-local-'));
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.endsWith('/v1/sources')) {
        return new Response(JSON.stringify({ id: 'src_01INITTESTSOURCE00000000002' }), {
          status: 201,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events: { event: { id: string } }[] };
      return new Response(
        JSON.stringify({
          results: [{ id: body.events[0]?.event.id, status: 'accepted', chain_seq: 1 }],
        }),
        { status: 202 },
      );
    };
    const result = await runInit({
      apiKey,
      cwd: dir,
      endpoint: 'http://127.0.0.1:8787/',
      fetch: fetchImpl,
      log: () => undefined,
    });
    expect(urls).toEqual(['http://127.0.0.1:8787/v1/sources', 'http://127.0.0.1:8787/v1/events']);
    expect(result.dashboardUrl).toBe(`http://localhost:3000/payments?event=${result.eventId}`);
    const env = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(env).toContain('HALVOR_ENDPOINT=http://127.0.0.1:8787');
  });

  it('maps API endpoints to their dashboards', () => {
    expect(dashboardFor('https://api.sandbox.halvorai.com')).toBe('https://app.halvorai.com');
    expect(dashboardFor('https://api.halvorai.com')).toBe('https://app.halvorai.com');
    expect(dashboardFor('http://localhost:8787')).toBe('http://localhost:3000');
    expect(dashboardFor('https://api.staging.example.com')).toBe('https://app.staging.example.com');
  });

  it('rejects a malformed api key before calling the network', async () => {
    dir = mkdtempSync(join(tmpdir(), 'halvor-init-bad-'));
    const fetchImpl = async () => {
      throw new Error('network should not be called');
    };
    await expect(
      runInit({ apiKey: 'nope', cwd: dir, fetch: fetchImpl as typeof fetch, log: () => undefined }),
    ).rejects.toThrow(/hk_test_/);
  });
});
