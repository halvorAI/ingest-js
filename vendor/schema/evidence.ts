import { createHash } from 'node:crypto';
import type { ApeEvidenceItem } from './ape.js';
import { canonicalize } from './canonical.js';
import { HalvorError } from './errors.js';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Digest of an evidence value as stored in `evidence[].sha256`: UTF-8 bytes for strings, the
 * RFC 8785 canonical form for objects (`specs/02-ape-schema.md` §3.10).
 */
export function evidenceSha256(value: string | object): `sha256:${string}` {
  const bytes = typeof value === 'string' ? value : canonicalize(value);
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * Normalised constraint vocabulary (`specs/02-ape-schema.md` §4). The same evaluation runs
 * whether the source was AP2 or Verifiable Intent. Amounts are decimal integer strings in minor
 * units, as on the wire.
 */
export type NormalisedConstraint =
  | { type: 'amount_range'; min: string; max: string; currency: string }
  | { type: 'budget'; max: string; currency: string }
  | { type: 'recurrence'; frequency: string; max_occurrences: number }
  | { type: 'reference'; checkout_hash: string }
  | { type: 'allowed_payees'; payees: { id?: string; name?: string; website?: string }[] }
  | { type: 'allowed_merchants'; merchants: { id?: string; name?: string; website?: string }[] }
  | { type: 'allowed_instruments'; instruments: { id: string; type?: string }[] }
  | { type: 'allowed_pisps'; pisps: string[] }
  | { type: 'execution_window'; not_before?: string; not_after?: string }
  | { type: 'line_items'; items: unknown[] }
  | { type: 'agent_key'; jwk_thumbprint: string };

export interface NormalisedMandate {
  /** `mandate.payment.1`, `mandate.payment.open.1`, `mandate.checkout.1` or `mandate.checkout.open.1`. */
  vct: string;
  /** Closed mandates carry final values; open ones carry constraints. */
  mode: 'immediate' | 'autonomous';
  constraints: NormalisedConstraint[];
  /** Constraint types seen but not recognised; logged, never rejected (VI is a draft). */
  unknown_constraint_types: string[];
}

/** Implemented in P4 with the AP2 / VI verifier. */
export function normaliseConstraints(evidence: readonly ApeEvidenceItem[]): NormalisedMandate[] {
  void evidence;
  throw new HalvorError('internal_error', 'normaliseConstraints is implemented in P4');
}
