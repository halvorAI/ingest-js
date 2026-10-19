import { HalvorClient } from '../client.js';
import { mapStripeEvent } from './map.js';
import type { StripeEventLike } from './types.js';

export { mapStripeEvent, type MappedStripeEvent } from './map.js';
export { tagPaymentIntent, tagIssuingCard, type TagOverrides } from './tag.js';
export {
  STRIPE_HANDLED_TYPES,
  type StripeEventLike,
  type StripeHandledType,
  type StripePaymentIntent,
  type StripeCharge,
  type StripeDispute,
  type StripeIssuingAuthorization,
  type StripeIssuingTransaction,
} from './types.js';

declare module '../client.js' {
  interface HalvorClient {
    /** Map a Stripe webhook event and enqueue it. Returns the event id, or undefined if ignored. */
    stripe(event: StripeEventLike): string | undefined;
  }
}

function stripeMethod(this: HalvorClient, event: StripeEventLike): string | undefined {
  const mapped = mapStripeEvent(event);
  if (mapped === undefined) return undefined;
  return this.emit(mapped);
}

Object.defineProperty(HalvorClient.prototype, 'stripe', {
  value: stripeMethod,
  writable: true,
  configurable: true,
});

/**
 * Returns a handler that maps Stripe events through the client. Use after your own
 * `constructEvent` signature check.
 */
export function stripeWebhookHandler(
  client: HalvorClient,
): (event: StripeEventLike) => string | undefined {
  return (event) => client.stripe(event);
}
