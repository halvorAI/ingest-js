export const name = '@halvorai/ingest';

export {
  HalvorClient,
  type ClientOptions,
  type ClientStats,
  type SdkError,
  type SdkErrorCode,
} from './client.js';
export {
  withAgentContext,
  currentContext,
  type AgentContext,
  type AgentRef,
  type OwnerRef,
  type InstructionRef,
} from './context.js';
export { hashInstruction } from './hash.js';
export { redactText, redactDeep, type RedactOptions, type ExtraPattern } from './redact.js';
export type { SignedEnvelope } from './transport.js';
export { runInit, upsertEnvFile, type InitOptions, type InitResult } from './cli/init.js';
