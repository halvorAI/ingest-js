import { generateSourceKeyPair, type JWK } from '@halvorai/schema';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { HalvorClient } from './client.js';

const payment = {
  payment_id: 'pi_1',
  rail: 'stripe' as const,
  amount: { value: '41200', unit: 'minor' as const, currency: 'USD' },
  status: 'settled' as const,
  rail_ref: { payment_intent: 'pi_1' },
};
const base = {
  type: 'payment.settled' as const,
  payment,
  payee: { type: 'merchant' as const, name: 'Shop' },
};

let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: 'src_01TESTSOURCE0000000000000A' };
});

function makeClient() {
  return new HalvorClient({
    sourceKey: privateJwk,
    environment: 'test',
    sink: async () => undefined,
    exitHook: false,
    onError: () => undefined,
  });
}

describe('emit never throws', () => {
  it('survives arbitrary fast-check inputs', async () => {
    const client = makeClient();
    try {
      await fc.assert(
        fc.asyncProperty(fc.anything(), async (input) => {
          expect(() => client.emit(input as never)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    } finally {
      await client.close({ timeoutMs: 10 });
    }
  });

  it('survives cyclic objects, bigint and getters that throw', async () => {
    const client = makeClient();
    try {
      const cyclic: Record<string, unknown> = { ...base };
      cyclic['self'] = cyclic;

      const throwing = {
        ...base,
        get labels() {
          throw new Error('getter boom');
        },
      };

      expect(() => client.emit(cyclic as never)).not.toThrow();
      expect(() =>
        client.emit({ ...base, labels: { n: 10n as unknown as string } } as never),
      ).not.toThrow();
      expect(() => client.emit(throwing as never)).not.toThrow();
      expect(() => client.emit(undefined as never)).not.toThrow();
      expect(() => client.emit(null as never)).not.toThrow();
    } finally {
      await client.close({ timeoutMs: 10 });
    }
  });
});
