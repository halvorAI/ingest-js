import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApeEventSchema, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { HalvorClient } from '../client.js';
import { withHalvor } from './client.js';
import { encodePaymentHeader } from './decode.js';
import {
  mapPaymentPayload,
  mapPaymentRequired,
  mapSettlementResponse,
  settlementContext,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402SettlementResponse,
} from './map.js';
import { halvorX402Express, halvorX402Hono } from './server.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

const SOURCE_ID = 'src_01X402ADAPTERTEST00000000001';
let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
});

describe('x402 v2 fixtures (HTTP transport examples + Base Sepolia)', () => {
  it('maps PaymentRequired → payment.requested', () => {
    const mapped = mapPaymentRequired(load('payment-required.json'), 'x402-client');
    expect(mapped?.type).toBe('payment.requested');
    expect(mapped?.payment).toMatchObject({
      rail: 'x402',
      status: 'requested',
      amount: {
        value: '10000',
        unit: 'atomic',
        asset: {
          network: 'eip155:84532',
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          symbol: 'USDC',
        },
      },
      rail_ref: { scheme: 'exact', network: 'eip155:84532' },
    });
    expect(mapped?.payee).toMatchObject({
      type: 'api_provider',
      resource_url: 'https://api.example.com/premium-data',
      wallet: {
        network: 'eip155:84532',
        address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      },
    });
  });

  it('maps PaymentPayload → payment.authorized with evidence', () => {
    const payload = load<X402PaymentPayload>('payment-payload.json');
    const mapped = mapPaymentPayload(payload, 'x402-client');
    expect(mapped?.type).toBe('payment.authorized');
    expect(mapped?.payment['payment_id']).toBe(
      'x402:eip155:84532:0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
    );
    expect(mapped?.evidence[0]?.kind).toBe('x402.payment_payload');
    expect(mapped?.instrument).toMatchObject({
      type: 'wallet',
      wallet: {
        address: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      },
    });
  });

  it('maps successful SettlementResponse → payment.settled', () => {
    const payload = load<X402PaymentPayload>('payment-payload.json');
    const settlement = load<X402SettlementResponse>('settlement-success.json');
    const mapped = mapSettlementResponse(
      settlement,
      settlementContext({
        ...(payload.accepted === undefined ? {} : { accept: payload.accepted }),
        ...(payload.payload?.authorization?.nonce === undefined
          ? {}
          : { nonce: payload.payload.authorization.nonce }),
        ...(payload.resource === undefined ? {} : { resource: payload.resource }),
      }),
      'x402-client',
    );
    expect(mapped?.type).toBe('payment.settled');
    expect(mapped?.payment['rail_ref']).toMatchObject({
      tx_hash: settlement.transaction,
      nonce: payload.payload?.authorization?.nonce,
    });
  });

  it('maps failed SettlementResponse → payment.failed with failure_reason', () => {
    const payload = load<X402PaymentPayload>('payment-payload.json');
    const settlement = load<X402SettlementResponse>('settlement-failure.json');
    const mapped = mapSettlementResponse(
      settlement,
      settlementContext({
        ...(payload.accepted === undefined ? {} : { accept: payload.accepted }),
        ...(payload.payload?.authorization?.nonce === undefined
          ? {}
          : { nonce: payload.payload.authorization.nonce }),
      }),
      'x402-client',
    );
    expect(mapped?.type).toBe('payment.failed');
    expect(mapped?.payment['failure_reason']).toBe('insufficient_funds');
  });
});

describe('mapped x402 events validate against ApeEventSchema', () => {
  async function emitAndParse(input: object) {
    const envelopes: { event: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        envelopes.push(...batch);
      },
      onError: (e) => errors.push(e),
      exitHook: false,
    });
    client.emit(input);
    await client.flush();
    await client.close({ timeoutMs: 100 });
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const event = envelopes[0]?.event;
    expect(event).toBeDefined();
    const parsed = ApeEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    return event ?? {};
  }

  it('payment.requested', async () => {
    const mapped = mapPaymentRequired(load('payment-required.json'), 'x402-client');
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;
    await emitAndParse(mapped);
  });

  it('payment.authorized', async () => {
    const mapped = mapPaymentPayload(load('payment-payload.json'), 'x402-client');
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;
    await emitAndParse(mapped);
  });

  it('payment.settled', async () => {
    const payload = load<X402PaymentPayload>('payment-payload.json');
    const mapped = mapSettlementResponse(
      load('settlement-success.json'),
      settlementContext({
        ...(payload.accepted === undefined ? {} : { accept: payload.accepted }),
        ...(payload.payload?.authorization?.nonce === undefined
          ? {}
          : { nonce: payload.payload.authorization.nonce }),
        ...(payload.resource === undefined ? {} : { resource: payload.resource }),
      }),
      'x402-client',
    );
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;
    await emitAndParse(mapped);
  });

  it('payment.failed', async () => {
    const payload = load<X402PaymentPayload>('payment-payload.json');
    const mapped = mapSettlementResponse(
      load('settlement-failure.json'),
      settlementContext({
        ...(payload.accepted === undefined ? {} : { accept: payload.accepted }),
        ...(payload.payload?.authorization?.nonce === undefined
          ? {}
          : { nonce: payload.payload.authorization.nonce }),
      }),
      'x402-client',
    );
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;
    await emitAndParse(mapped);
  });
});

describe('withHalvor', () => {
  it('emits requested then authorized then settled across a paid fetch', async () => {
    const types: string[] = [];
    const events: Record<string, unknown>[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        for (const e of batch) {
          types.push(String(e.event['type']));
          events.push(e.event as Record<string, unknown>);
        }
      },
      exitHook: false,
    });

    const required = encodePaymentHeader(load('payment-required.json'));
    const payload = encodePaymentHeader(load('payment-payload.json'));
    const settlement = encodePaymentHeader(load('settlement-success.json'));

    let calls = 0;
    const baseFetch: typeof fetch = async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      if (!headers.has('PAYMENT-SIGNATURE')) {
        return new Response('{}', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': required },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': settlement },
      });
    };

    // Composition matches the spec: wrapFetchWithPayment(withHalvor(fetch), client).
    const observed = withHalvor(baseFetch, client);
    const paid: typeof fetch = async (input, init) => {
      const first = await observed(input, init);
      if (first.status !== 402) return first;
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set('PAYMENT-SIGNATURE', payload);
      return observed(input, { ...init, headers: retryHeaders });
    };

    const res = await paid('https://api.example.com/premium-data');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    await client.flush();
    expect(types).toEqual(['payment.requested', 'payment.authorized', 'payment.settled']);
    const [requested, authorized, settled] = events as [
      Record<string, any>,
      Record<string, any>,
      Record<string, any>,
    ];
    // ape-schema MAPPINGS §5.1: requested id comes from the event id, later stages share the nonce id.
    expect(requested['payment']['payment_id']).toBe(
      `x402:${requested['payment']['rail_ref']['network']}:requested:${requested['id']}`,
    );
    expect(authorized['related']).toEqual({ previous_event_id: requested['id'] });
    expect(authorized['payment']['payment_id']).toBe(settled['payment']['payment_id']);
    await client.close({ timeoutMs: 100 });
  });

  it('maps settle failure to payment.failed with failure_reason', async () => {
    const envelopes: Record<string, unknown>[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        envelopes.push(...batch.map((e) => e.event));
      },
      exitHook: false,
    });
    const payload = encodePaymentHeader(load('payment-payload.json'));
    const failure = encodePaymentHeader(load('settlement-failure.json'));
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('PAYMENT-SIGNATURE')).toBeTruthy();
      return new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-RESPONSE': failure },
      });
    };
    const observed = withHalvor(fetchImpl, client);
    await observed('https://api.example.com/premium-data', {
      headers: { 'PAYMENT-SIGNATURE': payload },
    });
    await client.flush();
    const failed = envelopes.find((e) => e['type'] === 'payment.failed');
    expect(failed?.['payment']).toMatchObject({ failure_reason: 'insufficient_funds' });
    await client.close({ timeoutMs: 100 });
  });

  it('decode errors notify and never throw', async () => {
    const errors: { message: string }[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: () => undefined,
      onError: (e) => errors.push(e),
      exitHook: false,
    });
    const observed = withHalvor(async () => new Response('ok'), client);
    await expect(
      observed('https://example.com', { headers: { 'PAYMENT-SIGNATURE': '%%%' } }),
    ).resolves.toBeInstanceOf(Response);
    expect(errors.some((e) => e.message.includes('base64') || e.message.includes('JSON'))).toBe(
      true,
    );
    await client.close({ timeoutMs: 100 });
  });
});

describe('server middleware', () => {
  it('halvorX402Hono observes PAYMENT-SIGNATURE and PAYMENT-RESPONSE', async () => {
    const types: string[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        for (const e of batch) types.push(String(e.event['type']));
      },
      exitHook: false,
    });
    const mw = halvorX402Hono(client, {
      payee: { type: 'api_provider', name: 'Example Market Data' },
    });
    const payload = encodePaymentHeader(load('payment-payload.json'));
    const settlement = encodePaymentHeader(load('settlement-success.json'));
    const resHeaders = new Headers({ 'PAYMENT-RESPONSE': settlement });
    await mw({
      req: {
        header: (n) => (n.toLowerCase() === 'payment-signature' ? payload : undefined),
        raw: { headers: new Headers({ 'PAYMENT-SIGNATURE': payload }) },
      },
      res: { status: 200, headers: resHeaders },
      next: async () => undefined,
    });
    await client.flush();
    expect(types).toContain('payment.authorized');
    expect(types).toContain('payment.settled');
    await client.close({ timeoutMs: 100 });
  });

  it('halvorX402Express observes on response finish', async () => {
    const types: string[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        for (const e of batch) types.push(String(e.event['type']));
      },
      exitHook: false,
    });
    const mw = halvorX402Express(client, {
      payee: { name: 'Express payee', type: 'api_provider' },
    });
    const required = encodePaymentHeader(load<X402PaymentRequired>('payment-required.json'));
    const listeners: Record<string, () => void> = {};
    mw(
      { headers: {} },
      {
        statusCode: 402,
        getHeader: (name) => (name.toLowerCase() === 'payment-required' ? required : undefined),
        on: (event, listener) => {
          listeners[event] = listener;
        },
      },
      () => undefined,
    );
    listeners['finish']?.();
    await client.flush();
    expect(types).toContain('payment.requested');
    await client.close({ timeoutMs: 100 });
  });
});

describe('x402 data quality (JS-6, JS-7, payment ids)', () => {
  const accept = { scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: '0xabc', payTo: '0xdef' };
  const required = { x402Version: 2, resource: { url: 'https://api.example.com/data' }, accepts: [accept] };

  it('leaves agent and owner out when withAgentContext set them, so the client fills the full context', async () => {
    const { withAgentContext } = await import('../context.js');
    const mapped = withAgentContext(
      { agent: { id: 'agt_1', name: 'Research agent' }, owner: { id: 'own_1', type: 'person', country: 'US' } },
      () => mapPaymentRequired(required, 'x402-client'),
    );
    expect(mapped?.agent).toBeUndefined();
    expect(mapped?.owner).toBeUndefined();
  });

  it('falls back to the payer wallet as the agent when there is no context', () => {
    const mapped = mapPaymentPayload(
      {
        accepted: accept,
        payload: { authorization: { from: '0xpayer', nonce: '0x01', value: '1000' } },
      },
      'x402-client',
    );
    expect(mapped?.agent).toEqual({ id: '0xpayer' });
    expect(mapped?.owner).toEqual({ id: 'unattributed', type: 'business' });
  });

  it('refuses to guess a missing network or asset', () => {
    expect(() => mapPaymentRequired({ accepts: [{ amount: '1', asset: '0xabc' }] }, 'x402-client')).toThrow(/no network/);
    expect(() => mapPaymentRequired({ accepts: [{ amount: '1', network: 'eip155:8453' }] }, 'x402-client')).toThrow(/no asset/);
  });

  it('does not invent a token symbol or decimals', () => {
    const mapped = mapPaymentRequired(required, 'x402-client');
    const asset = (mapped?.payment['amount'] as { asset: Record<string, unknown> }).asset;
    expect(asset).toEqual({ network: 'eip155:8453', address: '0xabc' });
  });

  it('gives every 402 challenge its own payment id', () => {
    const a = mapPaymentRequired(required, 'x402-client')?.payment['payment_id'];
    const b = mapPaymentRequired(required, 'x402-client')?.payment['payment_id'];
    expect(a).toMatch(/^x402:eip155:8453:requested:evt_/);
    expect(a).not.toBe(b);
    const mapped = mapPaymentRequired(required, 'x402-client');
    expect(mapped?.payment['payment_id']).toBe(`x402:eip155:8453:requested:${mapped?.id}`);
  });
});
