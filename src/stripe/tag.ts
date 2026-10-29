import { currentContext } from '../context.js';
import type { StripeMetadata } from './types.js';

export interface TagOverrides {
  agentId?: string;
  /** Shown in the dashboard; card events carry no other agent name. */
  agentName?: string;
  framework?: string;
  ownerId?: string;
  ownerType?: 'person' | 'business';
  instructionId?: string;
}

function mergeHalvorMetadata(
  existing: StripeMetadata | null | undefined,
  overrides: TagOverrides = {},
): StripeMetadata {
  const ctx = currentContext();
  const meta: StripeMetadata = { ...(existing ?? {}) };

  const agentId = overrides.agentId ?? ctx?.agent?.id;
  const agentName = overrides.agentName ?? ctx?.agent?.name;
  const framework = overrides.framework ?? ctx?.agent?.framework;
  const ownerId = overrides.ownerId ?? ctx?.owner?.id;
  const ownerType = overrides.ownerType ?? ctx?.owner?.type;
  const instructionId = overrides.instructionId ?? ctx?.instruction?.id;

  if (agentId !== undefined) meta['halvor_agent_id'] = agentId;
  // Cut to the APE limits, which also keeps them inside Stripe's 500-character metadata values.
  if (agentName !== undefined) meta['halvor_agent_name'] = agentName.slice(0, 128);
  if (framework !== undefined) meta['halvor_agent_framework'] = framework.slice(0, 64);
  if (ownerId !== undefined) meta['halvor_owner_id'] = ownerId;
  if (ownerType !== undefined) meta['halvor_owner_type'] = ownerType;
  if (instructionId !== undefined) meta['halvor_instruction_id'] = instructionId;

  return meta;
}

/** Writes `metadata.halvor_*` from the current agent context (or explicit overrides). */
export function tagPaymentIntent<T extends object>(
  params: T & { metadata?: StripeMetadata | null },
  overrides?: TagOverrides,
): T & { metadata: StripeMetadata } {
  return {
    ...params,
    metadata: mergeHalvorMetadata(params.metadata, overrides),
  };
}

/** Same metadata tagging for Issuing card creates (one card per agent is recommended). */
export function tagIssuingCard<T extends object>(
  params: T & { metadata?: StripeMetadata | null },
  overrides?: TagOverrides,
): T & { metadata: StripeMetadata } {
  return {
    ...params,
    metadata: mergeHalvorMetadata(params.metadata, overrides),
  };
}
