/**
 * Isolated fake-timer flush tests. Must run in a fresh vitest worker (see vitest.config.ts):
 * HalvorClient setInterval under real timers poisons later fake-timer suites in-process.
 */
import { generateApiKey, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HalvorClient } from './client.js';

const realSetTimeout = globalThis.setTimeout;
const realTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 1));

const SOURCE_ID = 'src_01TESTSOURCE0000000000000A';
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
    amount: { value: '41200', unit: 'minor' as const, currency: 'USD' },
    status: 'settled' as const,
    rail_ref: { payment_intent: 'pi_1' },
  },
  payee: { type: 'merchant' as const, name: 'Shop' },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('batching and timing (fake timers)', () => {
  it('flushes on its own after the interval, without a flush call', async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const client = new HalvorClient({
      apiKey,
      sourceKey: privateJwk,
      flushIntervalMs: 1000,
      exitHook: false,
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ results: [{ id: 'evt_x', status: 'accepted', chain_seq: 1 }] }),
          {
            status: 202,
          },
        );
      },
    });
    try {
      client.emit(base);
      expect(sent).toHaveLength(0);
      for (let i = 0; i < 20 && sent.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(200);
        // Signing runs on real time (WebCrypto), so let a real tick pass between fake steps.
        await realTick();
      }
      expect(sent).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it('flushes at once when a full batch is waiting', async () => {
    vi.useFakeTimers();
    const sent: { events: unknown[] }[] = [];
    const client = new HalvorClient({
      apiKey,
      sourceKey: privateJwk,
      flushIntervalMs: 60_000,
      exitHook: false,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        sent.push(body);
        return new Response(
          JSON.stringify({
            results: body.events.map((_, i) => ({
              id: `evt_${i}`,
              status: 'accepted',
              chain_seq: i + 1,
            })),
          }),
          { status: 202 },
        );
      },
    });
    try {
      for (let i = 0; i < 100; i++) client.emit(base);
      for (let i = 0; i < 20 && sent.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(5);
        await realTick();
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]?.events).toHaveLength(100);
    } finally {
      client.dispose();
    }
  });
});
