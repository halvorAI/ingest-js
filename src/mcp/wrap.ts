import type { HalvorClient } from '../client.js';
import { withAgentContext } from '../context.js';
import type { McpCallToolResult, PaymentTool, PaymentToolHandler } from './types.js';

export interface WrapPaymentToolOptions {
  client: HalvorClient;
  /** Rail label stored on the mapped event (e.g. `x402`, `stripe`, `mpp`). */
  rail: string;
  /**
   * Map tool args + result to a partial APE event for `emit`.
   * Return `undefined` to skip emit (e.g. non-payment outcomes).
   */
  mapResult: (
    args: Record<string, unknown>,
    result: McpCallToolResult,
  ) => Record<string, unknown> | undefined;
}

/**
 * Wrap an MCP payment tool handler so each call emits an attributed APE event.
 * Same tool shape is returned; HalvorAI is never in the payment path.
 */
export function wrapPaymentTool(tool: PaymentTool, options: WrapPaymentToolOptions): PaymentTool {
  const { client, rail, mapResult } = options;
  const inner = tool.handler;

  const handler: PaymentToolHandler = async (args) => {
    const result = await inner(args);
    try {
      const mapped = mapResult(args, result);
      if (mapped !== undefined) {
        const event: Record<string, unknown> = {
          ...mapped,
          source: {
            ...((mapped['source'] as Record<string, unknown> | undefined) ?? {}),
            adapter: 'mcp',
          },
          labels: {
            ...((mapped['labels'] as Record<string, string> | undefined) ?? {}),
            mcp_tool: tool.name,
            mcp_rail: rail,
          },
        };
        const toolCallId =
          typeof args['tool_call_id'] === 'string'
            ? args['tool_call_id']
            : typeof args['_meta'] === 'object' &&
                args['_meta'] !== null &&
                typeof (args['_meta'] as Record<string, unknown>)['progressToken'] === 'string'
              ? ((args['_meta'] as Record<string, unknown>)['progressToken'] as string)
              : undefined;

        if (toolCallId !== undefined) {
          withAgentContext({ instruction: { id: toolCallId, tool_call_id: toolCallId } }, () => {
            client.emit(event);
          });
        } else {
          client.emit(event);
        }
      }
    } catch (err) {
      client.notify({
        code: 'invalid_event',
        message: err instanceof Error ? err.message : 'MCP wrapPaymentTool mapResult failed',
      });
    }
    return result;
  };

  const wrapped: PaymentTool = {
    name: tool.name,
    inputSchema: tool.inputSchema,
    handler,
  };
  if (tool.description !== undefined) wrapped.description = tool.description;
  return wrapped;
}
