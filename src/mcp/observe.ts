import { withAgentContext } from '../context.js';
import type { McpClientLike } from './types.js';

export interface ObserveToolCallsOptions {
  /** Tool names that count as payment-related. Default: `/pay|purchase|checkout/i`. */
  match?: RegExp;
}

const DEFAULT_MATCH = /pay|purchase|checkout/i;

/**
 * Wrap an MCP client so matching `callTool` invocations record `instruction.tool_call_id`
 * in AsyncLocalStorage for rail adapters nested in the call.
 */
export function observeToolCalls(
  mcpClient: McpClientLike,
  options: ObserveToolCallsOptions = {},
): McpClientLike {
  const match = options.match ?? DEFAULT_MATCH;

  return {
    callTool: async (params, ...rest) => {
      const name = params.name;
      if (!match.test(name)) {
        return mcpClient.callTool(params, ...rest);
      }

      const toolCallId =
        typeof params.arguments?.['tool_call_id'] === 'string'
          ? params.arguments['tool_call_id']
          : `mcp:${name}:${Date.now().toString(36)}`;

      return withAgentContext(
        {
          instruction: {
            id: toolCallId,
            tool_call_id: toolCallId,
            channel: 'agent',
          },
        },
        () => mcpClient.callTool(params, ...rest),
      );
    },
  };
}
