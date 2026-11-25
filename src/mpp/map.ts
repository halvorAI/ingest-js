import { evidenceSha256 } from '@halvorai/schema';
import { currentContext } from '../context.js';
import type { MppChallenge, MppReceipt } from './types.js';

export interface MappedMppEvent {
  type: string;
  occurred_at?: string;
  source: { adapter: 'mpp-server'; perspective: 'payee' };
  agent?: { id: string };
  owner?: MppOwner;
  attribution_gaps?: { field: MppGapField; reason: 'not_visible_to_observer' }[];
  payment: Record<string, unknown>;
  payee: Record<string, unknown>;
  evidence: {
    kind: 'mpp.receipt';
    format: 'json';
    value: Record<string, unknown>;
    sha256: string;
  }[];
  labels?: Record<string, string>;
}

function methodOf(raw: string): string {
  if (raw === 'stripe' || raw.startsWith('stripe/')) return 'spt';
  if (raw.includes('/')) return raw.split('/')[0] ?? raw;
  return raw;
}

/**
 * Agent and owner for a mapped event. When the caller set them with `withAgentContext`, they are
 * left out so the client fills the full context (name, framework, country, …) at emit time.
 */
type MppGapField = 'agent' | 'owner' | 'instruction' | 'mandate';
type MppOwner = {
  id: string;
  type: 'person' | 'business' | 'unknown';
  unknown_reason?: 'not_visible_to_observer';
};

/**
 * The MPP server adapter sees the payment from the seller's side (APE v0.2 §6.1.1): without an agent
 * context the agent, owner and instruction are not visible to it, and a mandate never is.
 */
function attribution(): Pick<MappedMppEvent, 'agent' | 'owner' | 'attribution_gaps'> {
  const ctx = currentContext();
  const reason = 'not_visible_to_observer' as const;
  const out: Pick<MappedMppEvent, 'agent' | 'owner' | 'attribution_gaps'> = {};
  const gaps: { field: MppGapField; reason: typeof reason }[] = [];
  if (ctx?.agent === undefined) {
    out.agent = { id: 'unattributed' };
    gaps.push({ field: 'agent', reason });
  }
  if (ctx?.owner === undefined) {
    out.owner = { id: 'unattributed', type: 'unknown', unknown_reason: reason };
    gaps.push({ field: 'owner', reason });
  }
  if (ctx?.instruction === undefined) gaps.push({ field: 'instruction', reason });
  gaps.push({ field: 'mandate', reason });
  out.attribution_gaps = gaps;
  return out;
}

function requireCurrency(challenge: MppChallenge): string {
  const currency = challenge.request.currency;
  if (currency === undefined) {
    throw new Error('MPP challenge has no currency token address; event not recorded');
  }
  return currency;
}

function amountFromChallenge(challenge: MppChallenge): Record<string, unknown> {
  const amount = challenge.request.amount ?? '0';
  const method = methodOf(challenge.method);
  if (method === 'tempo') {
    return {
      value: amount,
      unit: 'atomic',
      asset: {
        network: 'tempo:mainnet',
        address: requireCurrency(challenge),
        symbol: 'USD',
        decimals: 6,
      },
    };
  }
  // Stripe SPT and similar: treat amount as USD minor if integer-looking dollars*100, else minor from dollars.
  const dollars = Number(amount);
  const minor = Number.isFinite(dollars) ? String(Math.round(dollars * 100)) : amount;
  return { value: minor, unit: 'minor', currency: 'USD' };
}

function payeeFromChallenge(challenge: MppChallenge): Record<string, unknown> {
  const recipient = challenge.request.recipient;
  if (typeof recipient === 'string' && recipient.length > 0) {
    return {
      type: 'wallet',
      name: challenge.realm,
      wallet: {
        network: methodOf(challenge.method) === 'tempo' ? 'tempo:mainnet' : 'eip155:1',
        address: recipient,
      },
    };
  }
  return { type: 'api_provider', name: challenge.realm || 'MPP payee' };
}

export function mapMppChallenge(challenge: MppChallenge): MappedMppEvent {
  const attr = attribution();
  const method = methodOf(challenge.method);
  const payment: Record<string, unknown> = {
    payment_id: `mpp:${method}:${challenge.id}`,
    rail: 'mpp',
    amount: amountFromChallenge(challenge),
    status: 'requested',
    rail_ref: {
      method,
      challenge_id: challenge.id,
    },
  };
  if (challenge.description !== undefined) {
    payment['description'] = challenge.description.slice(0, 256);
  }
  const mapped: MappedMppEvent = {
    type: 'payment.requested',
    source: { adapter: 'mpp-server', perspective: 'payee' },
    ...attr,
    payment,
    payee: payeeFromChallenge(challenge),
    evidence: [],
    labels: { mpp_intent: challenge.intent },
  };
  return mapped;
}

export function mapMppReceipt(receipt: MppReceipt, challenge?: MppChallenge): MappedMppEvent {
  const attr = attribution();
  const method = methodOf(receipt.method);
  const challengeId = challenge?.id;
  const paymentId = `mpp:${method}:${challengeId ?? receipt.reference}`;
  const railRef: Record<string, unknown> = { method };
  if (challengeId !== undefined) railRef['challenge_id'] = challengeId;
  if (method === 'spt') railRef['payment_intent'] = receipt.reference;
  else railRef['tx_hash'] = receipt.reference;

  const amount =
    challenge !== undefined
      ? amountFromChallenge(challenge)
      : method === 'tempo'
        ? {
            value: '0',
            unit: 'atomic',
            asset: {
              network: 'tempo:mainnet',
              address: '0x0000000000000000000000000000000000000000',
              symbol: 'USD',
              decimals: 6,
            },
          }
        : { value: '0', unit: 'minor', currency: 'USD' };

  const evidenceValue = receipt as unknown as Record<string, unknown>;
  const mapped: MappedMppEvent = {
    type: 'payment.settled',
    source: { adapter: 'mpp-server', perspective: 'payee' },
    ...attr,
    payment: {
      payment_id: paymentId,
      rail: 'mpp',
      amount,
      status: 'settled',
      rail_ref: railRef,
    },
    payee:
      challenge !== undefined
        ? payeeFromChallenge(challenge)
        : { type: 'api_provider', name: 'MPP payee' },
    evidence: [
      {
        kind: 'mpp.receipt',
        format: 'json',
        value: evidenceValue,
        sha256: evidenceSha256(evidenceValue),
      },
    ],
  };
  if (/^\d{4}-\d{2}-\d{2}T/.test(receipt.timestamp)) {
    const d = new Date(receipt.timestamp);
    if (!Number.isNaN(d.getTime())) mapped.occurred_at = d.toISOString();
  }
  return mapped;
}
