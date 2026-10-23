import { evidenceSha256, newId } from '@halvorai/schema';
import { currentContext } from '../context.js';

export interface X402Accept {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; paymentFlow?: string; decimals?: number };
}

export interface X402PaymentRequired {
  x402Version?: number;
  error?: string;
  resource?: { url?: string; description?: string; mimeType?: string; serviceName?: string };
  accepts?: X402Accept[];
}

export interface X402PaymentPayload {
  x402Version?: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepted?: X402Accept;
  payload?: {
    signature?: string;
    authorization?: {
      from?: string;
      to?: string;
      value?: string;
      validAfter?: string;
      validBefore?: string;
      nonce?: string;
    };
  };
}

export interface X402SettlementResponse {
  success?: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
  amount?: string;
}

export type X402Adapter = 'x402-client' | 'x402-server';

export interface MappedX402Event {
  /** Set on `payment.requested`, so the authorized event can link to it. */
  id?: string;
  type: string;
  source: { adapter: X402Adapter };
  agent?: { id: string };
  owner?: { id: string; type: 'person' | 'business' };
  payment: Record<string, unknown>;
  payee: Record<string, unknown>;
  instrument?: Record<string, unknown>;
  related?: { previous_event_id: string };
  evidence: {
    kind: 'x402.payment_payload' | 'x402.settlement';
    format: 'json';
    value: Record<string, unknown>;
    sha256: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hostName(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Throws when the network or asset is missing: guessing them would record wrong compliance data. */
function assetOf(accept: X402Accept): Record<string, unknown> {
  if (accept.network === undefined) {
    throw new Error('x402 payment requirement has no network; event not recorded');
  }
  if (accept.asset === undefined) {
    throw new Error('x402 payment requirement has no asset; event not recorded');
  }
  const asset: Record<string, unknown> = { network: accept.network, address: accept.asset };
  if (accept.extra?.name !== undefined) asset['symbol'] = accept.extra.name.slice(0, 16);
  if (accept.extra?.decimals !== undefined) asset['decimals'] = accept.extra.decimals;
  return asset;
}

function amountOf(accept: X402Accept, override?: string): Record<string, unknown> {
  return {
    value: override ?? accept.amount ?? '0',
    unit: 'atomic',
    asset: assetOf(accept),
  };
}

/**
 * Agent and owner for a mapped event. When the caller set them with `withAgentContext`, they are
 * left out so the client fills the full context (name, framework, country, …) at emit time.
 */
function attribution(payerWallet?: string): Pick<MappedX402Event, 'agent' | 'owner'> {
  const ctx = currentContext();
  const out: Pick<MappedX402Event, 'agent' | 'owner'> = {};
  if (ctx?.agent === undefined) out.agent = { id: payerWallet ?? 'unattributed' };
  if (ctx?.owner === undefined) out.owner = { id: 'unattributed', type: 'business' };
  return out;
}

function payeeFromAccept(
  accept: X402Accept,
  resource?: { url?: string; description?: string; serviceName?: string },
  override?: Record<string, unknown>,
): Record<string, unknown> {
  if (override !== undefined) return { ...override };
  const name = resource?.serviceName ?? resource?.description ?? hostName(resource?.url);
  const payee: Record<string, unknown> = {
    type: resource?.url !== undefined ? 'api_provider' : 'wallet',
  };
  if (name !== undefined) payee['name'] = name.slice(0, 256);
  if (resource?.url !== undefined) payee['resource_url'] = resource.url;
  if (accept.payTo !== undefined && accept.network !== undefined) {
    payee['wallet'] = { network: accept.network, address: accept.payTo };
  }
  if (payee['name'] === undefined && payee['wallet'] === undefined) {
    payee['name'] = 'x402 payee';
  }
  return payee;
}

function railRef(accept: X402Accept, extra?: Record<string, unknown>): Record<string, unknown> {
  const ref: Record<string, unknown> = {};
  if (accept.scheme !== undefined) ref['scheme'] = accept.scheme;
  if (accept.network !== undefined) ref['network'] = accept.network;
  if (accept.extra?.paymentFlow !== undefined) ref['payment_flow'] = accept.extra.paymentFlow;
  if (extra !== undefined) Object.assign(ref, extra);
  return ref;
}

export function mapPaymentRequired(
  required: X402PaymentRequired,
  adapter: X402Adapter,
  payeeOverride?: Record<string, unknown>,
): MappedX402Event | undefined {
  const accept = required.accepts?.[0];
  if (accept === undefined) return undefined;
  const attr = attribution();
  // Each 402 challenge is its own payment request; the payer's nonce does not exist yet, so the
  // payment id is built from the event id (ape-schema MAPPINGS §5.1).
  const id = newId('evt');
  const payment: Record<string, unknown> = {
    payment_id: `x402:${accept.network ?? 'unknown'}:requested:${id}`,
    rail: 'x402',
    amount: amountOf(accept),
    status: 'requested',
    rail_ref: railRef(accept),
  };
  const description = required.resource?.description;
  if (description !== undefined) payment['description'] = description.slice(0, 256);

  return {
    id,
    type: 'payment.requested',
    source: { adapter },
    ...attr,
    payment,
    payee: payeeFromAccept(accept, required.resource, payeeOverride),
    evidence: [],
  };
}

/**
 * @param previousEventId id of the `payment.requested` event this payment answers. The adapters
 * pass it when they saw the 402 challenge for the same URL; it becomes `related.previous_event_id`.
 */
export function mapPaymentPayload(
  payload: X402PaymentPayload,
  adapter: X402Adapter,
  payeeOverride?: Record<string, unknown>,
  previousEventId?: string,
): MappedX402Event | undefined {
  const accept = payload.accepted;
  if (accept === undefined) return undefined;
  const auth = payload.payload?.authorization;
  const nonce = auth?.nonce ?? 'unknown';
  const network = accept.network ?? 'unknown';
  const payer = auth?.from;
  const attr = attribution(payer);
  const payment: Record<string, unknown> = {
    payment_id: `x402:${network}:${nonce}`,
    rail: 'x402',
    amount: amountOf(accept, auth?.value),
    status: 'authorized',
    rail_ref: railRef(accept, { nonce }),
  };
  const description = payload.resource?.description;
  if (description !== undefined) payment['description'] = description.slice(0, 256);

  const evidenceValue = payload as unknown as Record<string, unknown>;
  const mapped: MappedX402Event = {
    type: 'payment.authorized',
    source: { adapter },
    ...attr,
    payment,
    payee: payeeFromAccept(accept, payload.resource, payeeOverride),
    evidence: [
      {
        kind: 'x402.payment_payload',
        format: 'json',
        value: evidenceValue,
        sha256: evidenceSha256(evidenceValue),
      },
    ],
  };
  if (payer !== undefined && accept.network !== undefined) {
    mapped.instrument = {
      type: 'wallet',
      wallet: { network: accept.network, address: payer },
    };
  }
  if (previousEventId !== undefined) mapped.related = { previous_event_id: previousEventId };
  return mapped;
}

export interface SettlementContext {
  accept?: X402Accept;
  nonce?: string;
  resource?: { url?: string; description?: string; serviceName?: string };
  payeeOverride?: Record<string, unknown>;
}

export function mapSettlementResponse(
  settlement: X402SettlementResponse,
  context: SettlementContext,
  adapter: X402Adapter,
): MappedX402Event | undefined {
  const accept: X402Accept = { scheme: 'exact' };
  if (context.accept !== undefined) Object.assign(accept, context.accept);
  else {
    if (settlement.network !== undefined) accept.network = settlement.network;
    if (settlement.amount !== undefined) accept.amount = settlement.amount;
  }
  const network = settlement.network ?? accept.network ?? 'unknown';
  const nonce = context.nonce ?? 'unknown';
  const attr = attribution(settlement.payer);
  const success = settlement.success === true;
  const payment: Record<string, unknown> = {
    payment_id: `x402:${network}:${nonce}`,
    rail: 'x402',
    amount: amountOf(accept, settlement.amount ?? accept.amount),
    status: success ? 'settled' : 'failed',
    rail_ref: railRef(accept, {
      ...(context.nonce !== undefined ? { nonce: context.nonce } : {}),
      ...(settlement.transaction ? { tx_hash: settlement.transaction } : {}),
    }),
  };
  if (!success) {
    payment['failure_reason'] = (settlement.errorReason ?? 'settlement_failed').slice(0, 128);
  }
  const description = context.resource?.description;
  if (description !== undefined) payment['description'] = description.slice(0, 256);

  const evidenceValue = settlement as unknown as Record<string, unknown>;
  if (!isRecord(evidenceValue)) return undefined;

  const mapped: MappedX402Event = {
    type: success ? 'payment.settled' : 'payment.failed',
    source: { adapter },
    ...attr,
    payment,
    payee: payeeFromAccept(accept, context.resource, context.payeeOverride),
    evidence: [
      {
        kind: 'x402.settlement',
        format: 'json',
        value: evidenceValue,
        sha256: evidenceSha256(evidenceValue),
      },
    ],
  };
  if (settlement.payer !== undefined && network !== 'unknown') {
    mapped.instrument = {
      type: 'wallet',
      wallet: { network, address: settlement.payer },
    };
  }
  return mapped;
}

/** Build a SettlementContext without passing explicit `undefined` optional fields. */
export function settlementContext(parts: {
  accept?: X402Accept;
  nonce?: string;
  resource?: { url?: string; description?: string; serviceName?: string };
  payeeOverride?: Record<string, unknown>;
}): SettlementContext {
  const ctx: SettlementContext = {};
  if (parts.accept !== undefined) ctx.accept = parts.accept;
  if (parts.nonce !== undefined) ctx.nonce = parts.nonce;
  if (parts.resource !== undefined) ctx.resource = parts.resource;
  if (parts.payeeOverride !== undefined) ctx.payeeOverride = parts.payeeOverride;
  return ctx;
}
