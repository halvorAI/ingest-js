import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApeEventSchema, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { HalvorClient } from '../client.js';
import { withAgentContext } from '../context.js';
import {
  mapStripeEvent,
  stripeWebhookHandler,
  tagIssuingCard,
  tagPaymentIntent,
  type StripeEventLike,
} from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): StripeEventLike {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as StripeEventLike;
}

const SOURCE_ID = 'src_01STRIPEADAPTERTEST000000001';
let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
});

describe('mapStripeEvent (fixtures from Stripe test-mode shapes)', () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

  it('loads every recorded fixture', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    ['payment_intent.amount_capturable_updated.json', 'payment.authorized', 'authorized', 'stripe'],
    ['payment_intent.succeeded.json', 'payment.settled', 'settled', 'stripe'],
    ['payment_intent.payment_failed.json', 'payment.failed', 'failed', 'stripe'],
    ['charge.refunded.json', 'payment.refunded', 'refunded', 'stripe'],
    ['charge.dispute.created.json', 'payment.disputed', 'disputed', 'stripe'],
    ['issuing_authorization.created.json', 'payment.authorized', 'authorized', 'stripe-issuing'],
    ['issuing_authorization.updated.json', 'payment.failed', 'failed', 'stripe-issuing'],
    ['issuing_transaction.created.json', 'payment.settled', 'settled', 'stripe-issuing'],
    ['issuing_transaction.refund.json', 'payment.refunded', 'refunded', 'stripe-issuing'],
  ] as const)('%s → %s', (file, apeType, status, adapter) => {
    const mapped = mapStripeEvent(loadFixture(file));
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;
    expect(mapped.type).toBe(apeType);
    expect(mapped.payment['status']).toBe(status);
    expect(mapped.source.adapter).toBe(adapter);
  });

  it('ignores unrelated Stripe types', () => {
    expect(
      mapStripeEvent({
        type: 'customer.created',
        data: { object: { id: 'cus_x' } },
      }),
    ).toBeUndefined();
  });

  it('uses unattributed when metadata is missing', () => {
    const mapped = mapStripeEvent(loadFixture('unattributed.json'));
    expect(mapped?.agent.id).toBe('unattributed');
    expect(mapped?.owner.id).toBe('unattributed');
  });

  it('maps payment_failed failure_reason from last_payment_error.code', () => {
    const mapped = mapStripeEvent(loadFixture('payment_intent.payment_failed.json'));
    expect(mapped?.payment['failure_reason']).toBe('card_declined');
  });

  it('maps Issuing merchant_data into payee and card rail_ref', () => {
    const mapped = mapStripeEvent(loadFixture('issuing_authorization.created.json'));
    expect(mapped?.payment['rail']).toBe('card');
    expect(mapped?.payment['rail_ref']).toMatchObject({
      authorization_id: 'iauth_1QxYz2AbCdEfGh',
      processor: 'stripe-issuing',
    });
    expect(mapped?.payee).toMatchObject({
      name: 'Example Airways',
      mcc: '4511',
      country: 'US',
      id: 'acq_000123456789',
    });
    expect(mapped?.agent.id).toBe('agt_travel_12');
  });
  it('P9.25 takes the agent name and framework from the card metadata', () => {
    const event = loadFixture('issuing_authorization.created.json');
    const auth = event.data.object as Record<string, unknown>;
    const card = auth['card'] as Record<string, unknown>;
    card['metadata'] = {
      ...(card['metadata'] as Record<string, string>),
      halvor_agent_name: 'Travel booking agent',
      halvor_agent_framework: 'errandly-agents',
    };
    const mapped = mapStripeEvent(event);
    expect(mapped?.agent).toEqual({
      id: 'agt_travel_12',
      name: 'Travel booking agent',
      framework: 'errandly-agents',
    });
    expect(mapStripeEvent(loadFixture('issuing_authorization.created.json'))?.agent).toEqual({
      id: 'agt_travel_12',
    });
  });
});

describe('mapped fixtures validate against ApeEventSchema', () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

  it.each(files)('%s produces a valid APE event via HalvorClient', async (file) => {
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

    const mapped = mapStripeEvent(loadFixture(file));
    expect(mapped).toBeDefined();
    if (mapped === undefined) return;

    client.stripe(loadFixture(file));
    await client.flush();
    await client.close({ timeoutMs: 100 });

    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = ApeEventSchema.safeParse(envelopes[0]?.event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(envelopes[0]?.event['source']).toMatchObject({
      id: SOURCE_ID,
      adapter: mapped.source.adapter,
    });
  });
});

describe('tag helpers', () => {
  it('tagPaymentIntent writes metadata from agent context', async () => {
    const tagged = await withAgentContext(
      {
        agent: { id: 'agt_ctx_1', name: 'Ctx' },
        owner: { id: 'own_ctx_1', type: 'business' },
        instruction: { id: 'ins_ctx_1', text: 'buy coffee' },
      },
      () => tagPaymentIntent({ amount: 500, currency: 'usd', metadata: { order: '1' } }),
    );
    expect(tagged.metadata).toMatchObject({
      order: '1',
      halvor_agent_id: 'agt_ctx_1',
      halvor_owner_id: 'own_ctx_1',
      halvor_owner_type: 'business',
      halvor_instruction_id: 'ins_ctx_1',
    });
  });

  it('tagIssuingCard accepts explicit overrides over context', async () => {
    const tagged = await withAgentContext(
      { agent: { id: 'agt_outer' }, owner: { id: 'own_outer', type: 'person' } },
      () => tagIssuingCard({ currency: 'usd', type: 'virtual' }, { agentId: 'agt_override' }),
    );
    expect(tagged.metadata).toMatchObject({
      halvor_agent_id: 'agt_override',
      halvor_owner_id: 'own_outer',
    });
  });

  it('P9.25 tagIssuingCard stores the agent name and framework, within the APE limits', async () => {
    const fromContext = await withAgentContext(
      {
        agent: { id: 'agt_ctx', name: 'Shopping agent', framework: 'errandly-agents' },
        owner: { id: 'own_ctx', type: 'business' },
      },
      () => tagIssuingCard({ currency: 'usd', type: 'virtual' }),
    );
    expect(fromContext.metadata).toMatchObject({
      halvor_agent_id: 'agt_ctx',
      halvor_agent_name: 'Shopping agent',
      halvor_agent_framework: 'errandly-agents',
    });

    const long = tagIssuingCard(
      { currency: 'usd', type: 'virtual' },
      { agentId: 'agt_x', agentName: 'n'.repeat(300), framework: 'f'.repeat(100) },
    );
    expect(long.metadata['halvor_agent_name']).toHaveLength(128);
    expect(long.metadata['halvor_agent_framework']).toHaveLength(64);
    expect(Object.keys(long.metadata).every((k) => k.length <= 40)).toBe(true);
  });
});

describe('halvor.stripe and stripeWebhookHandler', () => {
  it('enqueues through the client method and handler', async () => {
    const envelopes: { event: Record<string, unknown> }[] = [];
    const client = new HalvorClient({
      sourceKey: privateJwk,
      environment: 'test',
      sink: (batch) => {
        envelopes.push(...batch);
      },
      exitHook: false,
    });
    const handler = stripeWebhookHandler(client);
    expect(handler({ type: 'invoice.paid', data: { object: {} } })).toBeUndefined();
    const id = handler(loadFixture('payment_intent.succeeded.json'));
    expect(id).toMatch(/^evt_/);
    await client.flush();
    expect(envelopes[0]?.event['type']).toBe('payment.settled');
    expect(envelopes[0]?.event['payment']).toMatchObject({
      payment_id: 'pi_3QxAbCdEfGhIjKlM',
      rail: 'stripe',
      amount: { value: '41200', unit: 'minor', currency: 'USD' },
    });
    await client.close({ timeoutMs: 100 });
  });
});
