import { ApeEventSchema, evidenceSha256, generateSourceKeyPair, type JWK } from '@halvorai/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { HalvorClient } from '../client.js';
import { currentContext, withAgentContext } from '../context.js';
import { ap2 } from '../evidence/helpers.js';
import { observeToolCalls } from './observe.js';
import type { McpCallToolResult, McpClientLike, PaymentTool } from './types.js';
import { wrapPaymentTool } from './wrap.js';

const SOURCE_ID = 'src_01MCPADAPTERTEST000000000001';
let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateSourceKeyPair();
  privateJwk = { ...pair.privateJwk, kid: SOURCE_ID };
});

function sinkClient(envelopes: { event: Record<string, unknown> }[], errors: unknown[] = []) {
  return new HalvorClient({
    sourceKey: privateJwk,
    environment: 'test',
    sink: (batch) => {
      envelopes.push(...batch);
    },
    onError: (e) => errors.push(e),
    exitHook: false,
  });
}

function mapPayResult(
  args: Record<string, unknown>,
  result: McpCallToolResult,
): Record<string, unknown> | undefined {
  if (result.isError === true) return undefined;
  const amount = typeof args['amount'] === 'number' ? args['amount'] : 0;
  const currency = typeof args['currency'] === 'string' ? args['currency'].toUpperCase() : 'USD';
  const textBlock = result.content.find(
    (c): c is { type: 'text'; text: string } =>
      c.type === 'text' && typeof (c as { text?: unknown }).text === 'string',
  );
  const text = textBlock?.text ?? 'settled';
  const mandate = typeof args['mandate'] === 'string' ? args['mandate'] : undefined;
  const evidence = mandate !== undefined ? [ap2.paymentMandate(mandate)] : [];
  return {
    type: 'payment.settled',
    agent: { id: 'agt_mcp_pay' },
    owner: { id: 'own_demo', type: 'business' },
    payment: {
      payment_id: `mcp:pay:${text}`,
      rail: 'card',
      amount: { value: String(Math.round(amount * 100)), unit: 'minor', currency },
      status: 'settled',
      rail_ref: {},
    },
    payee: { type: 'api_provider', name: 'MCP pay demo' },
    evidence,
  };
}

/** Example MCP server `pay` tool used for the P3.6 acceptance check. */
function examplePayTool(): PaymentTool {
  return {
    name: 'pay',
    description: 'Settle a small payment on behalf of the agent',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string' },
        mandate: { type: 'string' },
      },
      required: ['amount'],
    },
    handler: async (args) => ({
      content: [{ type: 'text', text: `ok:${String(args['amount'])}` }],
    }),
  };
}

describe('wrapPaymentTool', () => {
  it('example pay tool emits an attributed event that validates', async () => {
    const envelopes: { event: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    const client = sinkClient(envelopes, errors);
    const tool = wrapPaymentTool(examplePayTool(), {
      client,
      rail: 'card',
      mapResult: mapPayResult,
    });

    const mandate =
      'eyJhbGciOiJFUzI1NiIsInR5cCI6InZjK3NkLWp3dCJ9.eyJ2Y3QiOiJtYW5kYXRlLnBheW1lbnQuMSJ9.sig~d1~';

    await withAgentContext(
      {
        agent: { id: 'agt_mcp_pay', name: 'Pay agent' },
        owner: { id: 'own_demo', type: 'business' },
        instruction: { id: 'instr_1', text: 'Pay the invoice', tool_call_id: 'tc_abc' },
      },
      async () => {
        const result = await tool.handler({
          amount: 1.5,
          currency: 'usd',
          mandate,
          tool_call_id: 'tc_abc',
        });
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok:1.5' });
      },
    );

    await client.flush();
    await client.close({ timeoutMs: 100 });
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(envelopes.length).toBe(1);
    const event = envelopes[0]?.event;
    expect(event).toBeDefined();
    if (event === undefined) return;
    const parsed = ApeEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(event['type']).toBe('payment.settled');
    expect((event['source'] as { adapter: string }).adapter).toBe('mcp');
    expect((event['labels'] as Record<string, string>)['mcp_tool']).toBe('pay');
    const evidence = event['evidence'] as { sha256: string; value: string }[];
    expect(evidence[0]?.sha256).toBe(evidenceSha256(mandate));
  });

  it('skips emit when mapResult returns undefined', async () => {
    const envelopes: { event: Record<string, unknown> }[] = [];
    const client = sinkClient(envelopes);
    const tool = wrapPaymentTool(examplePayTool(), {
      client,
      rail: 'card',
      mapResult: () => undefined,
    });
    await tool.handler({ amount: 1 });
    await client.flush();
    await client.close({ timeoutMs: 100 });
    expect(envelopes.length).toBe(0);
  });
});

describe('observeToolCalls', () => {
  it('sets instruction.tool_call_id for matching tools', async () => {
    let seen: string | undefined;
    const inner: McpClientLike = {
      callTool: async () => {
        seen = currentContext()?.instruction?.tool_call_id;
        return { content: [] };
      },
    };
    const observed = observeToolCalls(inner, { match: /pay|purchase/i });
    await observed.callTool({
      name: 'pay',
      arguments: { tool_call_id: 'tc_from_host', amount: 1 },
    });
    expect(seen).toBe('tc_from_host');
  });

  it('does not wrap non-matching tools', async () => {
    let seen: string | undefined;
    const inner: McpClientLike = {
      callTool: async () => {
        seen = currentContext()?.instruction?.tool_call_id;
        return { content: [] };
      },
    };
    const observed = observeToolCalls(inner, { match: /pay/ });
    await withAgentContext({ instruction: { id: 'outer', tool_call_id: 'keep' } }, async () => {
      await observed.callTool({ name: 'search', arguments: {} });
    });
    expect(seen).toBe('keep');
  });
});
