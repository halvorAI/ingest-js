/** Minimal Stripe webhook shapes used by the adapter (no Stripe SDK dependency). */

export interface StripeMetadata {
  [key: string]: string | undefined;
}

export interface StripePaymentIntent {
  id: string;
  object?: string;
  amount: number;
  currency: string;
  description?: string | null;
  metadata?: StripeMetadata;
  status?: string;
  last_payment_error?: { code?: string | null; message?: string | null } | null;
  transfer_data?: { destination?: string | null } | null;
  on_behalf_of?: string | null;
  latest_charge?: string | null;
  payment_method_types?: string[];
  payment_method?: string | null;
}

export interface StripeCharge {
  id: string;
  object?: string;
  amount: number;
  amount_refunded?: number;
  currency: string;
  description?: string | null;
  metadata?: StripeMetadata;
  payment_intent?: string | null;
  refunded?: boolean;
  disputed?: boolean;
  on_behalf_of?: string | null;
  transfer_data?: { destination?: string | null } | null;
  billing_details?: { name?: string | null } | null;
  payment_method_details?: {
    type?: string;
    card?: { last4?: string; network?: string; brand?: string };
  } | null;
}

export interface StripeDispute {
  id: string;
  object?: string;
  amount: number;
  currency: string;
  reason?: string | null;
  charge?: string | null;
  payment_intent?: string | null;
  metadata?: StripeMetadata;
}

export interface StripeIssuingMerchantData {
  name?: string | null;
  category_code?: string | null;
  country?: string | null;
  network_id?: string | null;
  url?: string | null;
}

export interface StripeIssuingCard {
  id?: string;
  metadata?: StripeMetadata;
  last4?: string | null;
  brand?: string | null;
}

export interface StripeIssuingAuthorization {
  id: string;
  object?: string;
  amount: number;
  currency: string;
  approved?: boolean;
  status?: string;
  merchant_data?: StripeIssuingMerchantData | null;
  metadata?: StripeMetadata;
  card?: StripeIssuingCard | null;
  authorization_method?: string | null;
}

export interface StripeIssuingTransaction {
  id: string;
  object?: string;
  amount: number;
  currency: string;
  type?: string;
  merchant_data?: StripeIssuingMerchantData | null;
  metadata?: StripeMetadata;
  card?: StripeIssuingCard | null;
  authorization?: string | null;
}

export type StripeEventObject =
  | StripePaymentIntent
  | StripeCharge
  | StripeDispute
  | StripeIssuingAuthorization
  | StripeIssuingTransaction
  | Record<string, unknown>;

export interface StripeEventLike {
  id?: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data: { object: StripeEventObject };
}

export const STRIPE_HANDLED_TYPES = [
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'issuing_authorization.created',
  'issuing_authorization.updated',
  'issuing_transaction.created',
] as const;

export type StripeHandledType = (typeof STRIPE_HANDLED_TYPES)[number];
