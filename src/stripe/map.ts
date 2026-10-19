import { evidenceSha256 } from '@halvorai/schema';
import { hashInstruction } from '../hash.js';
import type { StripeEventLike, StripeMetadata } from './types.js';
import { STRIPE_HANDLED_TYPES } from './types.js';

export interface MappedStripeEvent {
  type: string;
  occurred_at?: string;
  source: { adapter: 'stripe' | 'stripe-issuing' };
  agent: { id: string; name?: string };
  owner: { id: string; type: 'person' | 'business' };
  instruction?: { id: string; hash: string };
  payment: Record<string, unknown>;
  payee: Record<string, unknown>;
  instrument?: Record<string, unknown>;
  evidence: {
    kind: 'stripe.object';
    format: 'json';
    value: Record<string, unknown>;
    sha256: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function currencyOf(raw: unknown): string {
  const c = asString(raw)?.toUpperCase();
  return c !== undefined && /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

function minorAmount(
  amount: number,
  currency: string,
): { value: string; unit: 'minor'; currency: string } {
  return { value: String(Math.trunc(amount)), unit: 'minor', currency };
}

function occurredAt(event: StripeEventLike): string | undefined {
  if (typeof event.created !== 'number') return undefined;
  return new Date(event.created * 1000).toISOString();
}

function metadataOf(obj: Record<string, unknown>): StripeMetadata {
  const meta = obj['metadata'];
  if (!isRecord(meta)) return {};
  const out: StripeMetadata = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function cardMetadata(obj: Record<string, unknown>): StripeMetadata {
  const card = obj['card'];
  if (!isRecord(card)) return {};
  return metadataOf(card);
}

function attribution(meta: StripeMetadata): {
  agent: { id: string };
  owner: { id: string; type: 'person' | 'business' };
  instruction?: { id: string; hash: string };
} {
  const agentId = meta['halvor_agent_id'] ?? 'unattributed';
  const ownerId = meta['halvor_owner_id'] ?? 'unattributed';
  const ownerType = meta['halvor_owner_type'] === 'person' ? 'person' : 'business';
  const instructionId = meta['halvor_instruction_id'];
  const result: {
    agent: { id: string };
    owner: { id: string; type: 'person' | 'business' };
    instruction?: { id: string; hash: string };
  } = {
    agent: { id: agentId },
    owner: { id: ownerId, type: ownerType },
  };
  if (instructionId !== undefined) {
    // Webhooks only carry the id; hash a stable local stand-in so APE validation passes.
    result.instruction = {
      id: instructionId,
      hash: hashInstruction(`stripe-meta:${instructionId}`),
    };
  }
  return result;
}

function payeeFromConnect(obj: Record<string, unknown>): Record<string, unknown> {
  const transfer = obj['transfer_data'];
  const destination =
    (isRecord(transfer) ? asString(transfer['destination']) : undefined) ??
    asString(obj['on_behalf_of']);
  if (destination !== undefined) {
    return { type: 'merchant', id: destination };
  }
  const description = asString(obj['description']);
  if (description !== undefined) return { type: 'merchant', name: description.slice(0, 256) };
  return { type: 'merchant', name: 'Stripe merchant' };
}

function payeeFromMerchantData(obj: Record<string, unknown>): Record<string, unknown> {
  const md = obj['merchant_data'];
  if (!isRecord(md)) return { type: 'merchant', name: 'Card merchant' };
  const payee: Record<string, unknown> = { type: 'merchant' };
  const name = asString(md['name']);
  const id = asString(md['network_id']);
  const country = asString(md['country']);
  const mcc = asString(md['category_code']);
  const url = asString(md['url']);
  if (name !== undefined) payee['name'] = name;
  if (id !== undefined) payee['id'] = id;
  if (country !== undefined && /^[A-Z]{2}$/i.test(country))
    payee['country'] = country.toUpperCase();
  if (mcc !== undefined && /^\d{4}$/.test(mcc)) payee['mcc'] = mcc;
  if (url !== undefined && /^https?:\/\//i.test(url)) payee['website'] = url;
  if (payee['name'] === undefined && payee['id'] === undefined) payee['name'] = 'Card merchant';
  return payee;
}

function stripeEvidence(obj: Record<string, unknown>): MappedStripeEvent['evidence'] {
  return [
    {
      kind: 'stripe.object',
      format: 'json',
      value: obj,
      sha256: evidenceSha256(obj),
    },
  ];
}

function sharedPaymentToken(obj: Record<string, unknown>): string | undefined {
  const meta = metadataOf(obj);
  return (
    meta['shared_payment_token'] ??
    meta['halvor_shared_payment_token'] ??
    asString(obj['shared_payment_token'])
  );
}

function mapPaymentIntent(
  event: StripeEventLike,
  obj: Record<string, unknown>,
  type: string,
  status: 'authorized' | 'settled' | 'failed',
): MappedStripeEvent {
  const id = asString(obj['id']) ?? 'pi_unknown';
  const amount = asNumber(obj['amount']) ?? 0;
  const currency = currencyOf(obj['currency']);
  const meta = metadataOf(obj);
  const attr = attribution(meta);
  const payment: Record<string, unknown> = {
    payment_id: id,
    rail: 'stripe',
    amount: minorAmount(amount, currency),
    status,
    rail_ref: { payment_intent: id },
  };
  const description = asString(obj['description']);
  if (description !== undefined) payment['description'] = description.slice(0, 256);
  if (status === 'failed') {
    const err = obj['last_payment_error'];
    const code = isRecord(err) ? asString(err['code']) : undefined;
    payment['failure_reason'] = (code ?? 'payment_failed').slice(0, 128);
  }
  const spt = sharedPaymentToken(obj);
  if (spt !== undefined) {
    (payment['rail_ref'] as Record<string, unknown>)['shared_payment_token'] = spt;
  }
  const account = asString(obj['on_behalf_of']);
  if (account !== undefined) {
    (payment['rail_ref'] as Record<string, unknown>)['account'] = account;
  }

  const mapped: MappedStripeEvent = {
    type,
    source: { adapter: 'stripe' },
    agent: attr.agent,
    owner: attr.owner,
    payment,
    payee: payeeFromConnect(obj),
    evidence: stripeEvidence(obj),
  };
  const at = occurredAt(event);
  if (at !== undefined) mapped.occurred_at = at;
  if (attr.instruction !== undefined) mapped.instruction = attr.instruction;
  if (spt !== undefined) mapped.instrument = { type: 'stripe_spt' };
  return mapped;
}

function mapChargeRefunded(
  event: StripeEventLike,
  obj: Record<string, unknown>,
): MappedStripeEvent {
  const chargeId = asString(obj['id']) ?? 'ch_unknown';
  const pi = asString(obj['payment_intent']);
  const amount = asNumber(obj['amount_refunded']) ?? asNumber(obj['amount']) ?? 0;
  const currency = currencyOf(obj['currency']);
  const meta = metadataOf(obj);
  const attr = attribution(meta);
  const payment: Record<string, unknown> = {
    payment_id: pi ?? chargeId,
    rail: 'stripe',
    amount: minorAmount(amount, currency),
    status: 'refunded',
    rail_ref: { charge: chargeId },
  };
  if (pi !== undefined) (payment['rail_ref'] as Record<string, unknown>)['payment_intent'] = pi;
  const description = asString(obj['description']);
  if (description !== undefined) payment['description'] = description.slice(0, 256);

  const mapped: MappedStripeEvent = {
    type: 'payment.refunded',
    source: { adapter: 'stripe' },
    agent: attr.agent,
    owner: attr.owner,
    payment,
    payee: payeeFromConnect(obj),
    evidence: stripeEvidence(obj),
  };
  const at = occurredAt(event);
  if (at !== undefined) mapped.occurred_at = at;
  if (attr.instruction !== undefined) mapped.instruction = attr.instruction;
  return mapped;
}

function mapDispute(event: StripeEventLike, obj: Record<string, unknown>): MappedStripeEvent {
  const disputeId = asString(obj['id']) ?? 'dp_unknown';
  const pi = asString(obj['payment_intent']);
  const charge = asString(obj['charge']);
  const amount = asNumber(obj['amount']) ?? 0;
  const currency = currencyOf(obj['currency']);
  const meta = metadataOf(obj);
  const attr = attribution(meta);
  const payment: Record<string, unknown> = {
    payment_id: pi ?? charge ?? disputeId,
    rail: 'stripe',
    amount: minorAmount(amount, currency),
    status: 'disputed',
    rail_ref: { dispute: disputeId },
  };
  if (pi !== undefined) (payment['rail_ref'] as Record<string, unknown>)['payment_intent'] = pi;
  if (charge !== undefined) (payment['rail_ref'] as Record<string, unknown>)['charge'] = charge;
  const reason = asString(obj['reason']);
  if (reason !== undefined) payment['description'] = reason.slice(0, 256);

  const mapped: MappedStripeEvent = {
    type: 'payment.disputed',
    source: { adapter: 'stripe' },
    agent: attr.agent,
    owner: attr.owner,
    payment,
    payee: { type: 'merchant', name: 'Stripe dispute' },
    evidence: stripeEvidence(obj),
  };
  const at = occurredAt(event);
  if (at !== undefined) mapped.occurred_at = at;
  if (attr.instruction !== undefined) mapped.instruction = attr.instruction;
  return mapped;
}

function mapIssuingAuthorization(
  event: StripeEventLike,
  obj: Record<string, unknown>,
  failed: boolean,
): MappedStripeEvent {
  const id = asString(obj['id']) ?? 'iauth_unknown';
  const amount = asNumber(obj['amount']) ?? 0;
  const currency = currencyOf(obj['currency']);
  const meta = { ...metadataOf(obj), ...cardMetadata(obj) };
  const attr = attribution(meta);
  const merchant = payeeFromMerchantData(obj);
  const payment: Record<string, unknown> = {
    payment_id: id,
    rail: 'card',
    amount: minorAmount(amount, currency),
    status: failed ? 'failed' : 'authorized',
    rail_ref: {
      authorization_id: id,
      processor: 'stripe-issuing',
    },
  };
  if (failed) payment['failure_reason'] = 'issuing_authorization_declined';
  const mcc = asString(merchant['mcc']);
  if (mcc !== undefined) payment['category'] = `mcc:${mcc}`;
  const name = asString(merchant['name']);
  if (name !== undefined) payment['description'] = name.slice(0, 256);

  const mapped: MappedStripeEvent = {
    type: failed ? 'payment.failed' : 'payment.authorized',
    source: { adapter: 'stripe-issuing' },
    agent: attr.agent,
    owner: attr.owner,
    payment,
    payee: merchant,
    evidence: stripeEvidence(obj),
  };
  const at = occurredAt(event);
  if (at !== undefined) mapped.occurred_at = at;
  if (attr.instruction !== undefined) mapped.instruction = attr.instruction;

  const card = obj['card'];
  if (isRecord(card)) {
    const last4 = asString(card['last4']);
    const brand = asString(card['brand']);
    const instrument: Record<string, unknown> = { type: 'card', issuer: 'Stripe Issuing' };
    if (last4 !== undefined && /^\d{4}$/.test(last4)) instrument['last4'] = last4;
    if (brand !== undefined) instrument['network'] = brand.toLowerCase();
    mapped.instrument = instrument;
  }
  return mapped;
}

function mapIssuingTransaction(
  event: StripeEventLike,
  obj: Record<string, unknown>,
): MappedStripeEvent {
  const id = asString(obj['id']) ?? 'ipi_unknown';
  const amount = Math.abs(asNumber(obj['amount']) ?? 0);
  const currency = currencyOf(obj['currency']);
  const txType = asString(obj['type']) ?? 'capture';
  const refunded = txType === 'refund';
  const meta = { ...metadataOf(obj), ...cardMetadata(obj) };
  const attr = attribution(meta);
  const merchant = payeeFromMerchantData(obj);
  const auth = asString(obj['authorization']);
  const payment: Record<string, unknown> = {
    payment_id: id,
    rail: 'card',
    amount: minorAmount(amount, currency),
    status: refunded ? 'refunded' : 'settled',
    rail_ref: {
      transaction_id: id,
      processor: 'stripe-issuing',
    },
  };
  if (auth !== undefined) {
    (payment['rail_ref'] as Record<string, unknown>)['authorization_id'] = auth;
  }
  const mcc = asString(merchant['mcc']);
  if (mcc !== undefined) payment['category'] = `mcc:${mcc}`;
  const name = asString(merchant['name']);
  if (name !== undefined) payment['description'] = name.slice(0, 256);

  const mapped: MappedStripeEvent = {
    type: refunded ? 'payment.refunded' : 'payment.settled',
    source: { adapter: 'stripe-issuing' },
    agent: attr.agent,
    owner: attr.owner,
    payment,
    payee: merchant,
    evidence: stripeEvidence(obj),
  };
  const at = occurredAt(event);
  if (at !== undefined) mapped.occurred_at = at;
  if (attr.instruction !== undefined) mapped.instruction = attr.instruction;
  return mapped;
}

/**
 * Maps a Stripe webhook event to a partial APE event for `HalvorClient.emit`.
 * Returns `undefined` for unrelated types (caller ignores them).
 */
export function mapStripeEvent(event: StripeEventLike): MappedStripeEvent | undefined {
  if (!STRIPE_HANDLED_TYPES.includes(event.type as (typeof STRIPE_HANDLED_TYPES)[number])) {
    return undefined;
  }
  if (!isRecord(event.data?.object)) return undefined;
  const obj = event.data.object;

  switch (event.type) {
    case 'payment_intent.amount_capturable_updated':
      return mapPaymentIntent(event, obj, 'payment.authorized', 'authorized');
    case 'payment_intent.succeeded':
      return mapPaymentIntent(event, obj, 'payment.settled', 'settled');
    case 'payment_intent.payment_failed':
      return mapPaymentIntent(event, obj, 'payment.failed', 'failed');
    case 'charge.refunded':
      return mapChargeRefunded(event, obj);
    case 'charge.dispute.created':
      return mapDispute(event, obj);
    case 'issuing_authorization.created':
      return mapIssuingAuthorization(event, obj, obj['approved'] === false);
    case 'issuing_authorization.updated': {
      const declined =
        obj['approved'] === false ||
        asString(obj['status']) === 'reversed' ||
        asString(obj['status']) === 'expired';
      return mapIssuingAuthorization(event, obj, declined);
    }
    case 'issuing_transaction.created':
      return mapIssuingTransaction(event, obj);
    default:
      return undefined;
  }
}
