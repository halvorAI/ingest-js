import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApeEventSchema, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { HalvorClient } from '../client.js';
import { withHalvorCharge } from './charge.js';
import { mapMppChallenge, mapMppReceipt } from './map.js';
import type { MppChallenge, MppChargeResult, MppReceipt } from './types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

const SOURCE_ID = 'src_01MPPADAPTERTEST000000000001';
let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
});

describe('MPP field mapping (mppx Challenge / Receipt)', () => {
  it('maps tempo challenge → payment.requested', () => {
    const mapped = mapMppChallenge(load('challenge-tempo.json'));
    expect(mapped.type).toBe('payment.requested');
    expect(mapped.payment).toMatchObject({
      rail: 'mpp',
      status: 'requested',
      rail_ref: { method: 'tempo', challenge_id: 'ch_tempo_01abc' },
      amount: {
        value: '1000000',
        unit: 'atomic',
        asset: { network: 'tempo:mainnet' },
      },
    });
  });

  it('maps tempo receipt → payment.settled with mpp.receipt evidence', () => {
    const challenge = load<MppChallenge>('challenge-tempo.json');
    const receipt = load<MppReceipt>('receipt-tempo.json');
    const mapped = mapMppReceipt(receipt, challenge);
    expect(mapped.type).toBe('payment.settled');
    expect(mapped.payment['rail_ref']).toMatchObject({
      method: 'tempo',
      tx_hash: receipt.reference,
      challenge_id: challenge.id,
    });
    expect(mapped.evidence[0]?.kind).toBe('mpp.receipt');
  });

  it('maps stripe method to rail_ref.method spt and payment_intent', () => {
    const challenge = load<MppChallenge>('challenge-stripe.json');
    const receipt = load<MppReceipt>('receipt-stripe.json');
    expect(mapMppChallenge(challenge).payment['rail_ref']).toMatchObject({ method: 'spt' });
    expect(mapMppReceipt(receipt, challenge).payment['rail_ref']).toMatchObject({
      method: 'spt',
      payment_intent: 'pi_3QxMppExample0001',
    });
  });
});

describe('mapped MPP events validate against ApeEventSchema', () => {
  async function roundTrip(input: object) {
    const envelopes: { event: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (b) => {
        envelopes.push(...b);
      },
      onError: (e) => errors.push(e),
      exitHook: false,
    });
    client.emit(input);
    await client.flush();
    await client.close({ timeoutMs: 100 });
    expect(errors, JSON.stringify(errors)).toEqual([]);
    const parsed = ApeEventSchema.safeParse(envelopes[0]?.event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  }

  it('tempo requested + settled', async () => {
    const challenge = load<MppChallenge>('challenge-tempo.json');
    await roundTrip(mapMppChallenge(challenge));
    await roundTrip(mapMppReceipt(load('receipt-tempo.json'), challenge));
  });

  it('stripe/spt requested + settled', async () => {
    const challenge = load<MppChallenge>('challenge-stripe.json');
    await roundTrip(mapMppChallenge(challenge));
    await roundTrip(mapMppReceipt(load('receipt-stripe.json'), challenge));
  });
});

describe('withHalvorCharge', () => {
  it('emits payment.requested then payment.settled across a charge round trip', async () => {
    const types: string[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (b) => {
        for (const e of b) types.push(String(e.event['type']));
      },
      exitHook: false,
    });

    const challenge = load<MppChallenge>('challenge-tempo.json');
    const receipt = load<MppReceipt>('receipt-tempo.json');
    const requestB64 = Buffer.from(JSON.stringify(challenge.request)).toString('base64url');
    const www = `Payment id="${challenge.id}", realm="${challenge.realm}", method="${challenge.method}", intent="${challenge.intent}", request="${requestB64}", description="${challenge.description}"`;

    let phase: 'challenge' | 'paid' = 'challenge';
    const charge = withHalvorCharge(async () => {
      if (phase === 'challenge') {
        const result: MppChargeResult = {
          status: 402,
          challenge: new Response('Payment Required', {
            status: 402,
            headers: { 'WWW-Authenticate': www },
          }),
          withReceipt: (r) => r,
        };
        return result;
      }
      const result: MppChargeResult = {
        status: 200,
        withReceipt: (response) => {
          const headers = new Headers(response.headers);
          headers.set(
            'Payment-Receipt',
            Buffer.from(JSON.stringify(receipt)).toString('base64url'),
          );
          return new Response(response.body, { status: 200, headers });
        },
      };
      return result;
    }, client);

    const first = await charge(new Request('https://api.example.com/photo'));
    expect(first.status).toBe(402);
    phase = 'paid';
    const second = await charge(new Request('https://api.example.com/photo'));
    const settled = await second.withReceipt(Response.json({ ok: true }));
    expect(settled.headers.get('Payment-Receipt')).toBeTruthy();

    await client.flush();
    expect(types).toEqual(['payment.requested', 'payment.settled']);
    await client.close({ timeoutMs: 100 });
  });
});
