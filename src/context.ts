import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentRef {
  id: string;
  name?: string;
  framework?: string;
  version?: string;
  key_thumbprint?: string;
}

export interface OwnerRef {
  id: string;
  type: 'person' | 'business';
  display_name?: string;
  country?: string;
  kyc_ref?: string;
}

export interface InstructionRef {
  id: string;
  text?: string;
  summary?: string;
  channel?: 'chat' | 'api' | 'schedule' | 'email' | 'agent' | 'other';
  issued_at?: string;
  tool_call_id?: string;
}

export interface AgentContext {
  agent?: AgentRef;
  owner?: OwnerRef;
  instruction?: InstructionRef;
}

const storage = new AsyncLocalStorage<AgentContext>();

/** Current agent context, or undefined outside `withAgentContext`. */
export function currentContext(): AgentContext | undefined {
  return storage.getStore();
}

function mergeContext(outer: AgentContext | undefined, ctx: AgentContext): AgentContext {
  const agent = ctx.agent ?? outer?.agent;
  const owner = ctx.owner ?? outer?.owner;
  const instruction = ctx.instruction ?? outer?.instruction;
  const merged: AgentContext = {};
  if (agent !== undefined) merged.agent = agent;
  if (owner !== undefined) merged.owner = owner;
  if (instruction !== undefined) merged.instruction = instruction;
  return merged;
}

/**
 * Run `fn` with an agent context. A nested call merges a partial context over the outer one
 * and restores the outer context when it returns. Synchronous throws become rejected promises
 * so `await expect(withAgentContext(...)).rejects` works for both sync and async callbacks.
 */
export function withAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  const merged = mergeContext(storage.getStore(), ctx);
  return storage.run(merged, () => {
    try {
      return fn();
    } catch (err) {
      return Promise.reject(err) as T;
    }
  });
}
