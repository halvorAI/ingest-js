/** Minimal MCP CallToolResult shape (no dependency on the MCP SDK). */
export interface McpCallToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: string; [key: string]: unknown }
  >;
  isError?: boolean;
  [key: string]: unknown;
}

export type PaymentToolHandler = (
  args: Record<string, unknown>,
) => Promise<McpCallToolResult> | McpCallToolResult;

/** Duck-typed MCP tool with a callable handler. */
export interface PaymentTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  handler: PaymentToolHandler;
}

/** Duck-typed MCP client that exposes `callTool`. */
export interface McpClientLike {
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    ...rest: unknown[]
  ) => Promise<unknown>;
}
