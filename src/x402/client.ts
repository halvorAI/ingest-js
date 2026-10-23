import type { HalvorClient } from '../client.js';
import { decodePaymentHeader, headerGet } from './decode.js';
import {
  mapPaymentPayload,
  mapPaymentRequired,
  mapSettlementResponse,
  settlementContext,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402SettlementResponse,
} from './map.js';

type FetchInput = Parameters<typeof fetch>[0];

function toHeaders(input: FetchInput, init?: RequestInit): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (typeof Request !== 'undefined' && input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

function urlKey(input: FetchInput): string {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const hash = raw.indexOf('#');
  return hash === -1 ? raw : raw.slice(0, hash);
}

/** Challenges we have not yet seen a payment for, per URL. Bounded so it cannot grow forever. */
const MAX_PENDING_CHALLENGES = 1000;

/**
 * Wrap a fetch implementation (typically `wrapFetchWithPayment(...)`) so HalvorAI
 * observes x402 headers without sitting in the payment path.
 */
export function withHalvor(fetchImpl: typeof fetch, client: HalvorClient): typeof fetch {
  const requested = new Map<string, string>();
  const wrapped: typeof fetch = async (input, init) => {
    const key = urlKey(input);
    const reqHeaders = toHeaders(input, init);
    const signature = headerGet(reqHeaders, 'PAYMENT-SIGNATURE');
    let payload: X402PaymentPayload | undefined;
    if (signature !== null) {
      try {
        payload = decodePaymentHeader<X402PaymentPayload>(signature);
        const previous = requested.get(key);
        requested.delete(key);
        const mapped = mapPaymentPayload(payload, 'x402-client', undefined, previous);
        if (mapped !== undefined) client.emit(mapped);
      } catch (err) {
        client.notify({
          code: 'invalid_event',
          message: err instanceof Error ? err.message : 'PAYMENT-SIGNATURE decode failed',
        });
      }
    }

    const response = await fetchImpl(input, init);
    const resHeaders = response.headers;

    if (response.status === 402) {
      const requiredHeader = headerGet(resHeaders, 'PAYMENT-REQUIRED');
      if (requiredHeader !== null) {
        try {
          const required = decodePaymentHeader<X402PaymentRequired>(requiredHeader);
          const mapped = mapPaymentRequired(required, 'x402-client');
          if (mapped !== undefined) {
            const eventId = client.emit(mapped);
            requested.delete(key);
            requested.set(key, eventId);
            if (requested.size > MAX_PENDING_CHALLENGES) {
              const oldest = requested.keys().next().value;
              if (oldest !== undefined) requested.delete(oldest);
            }
          }
        } catch (err) {
          client.notify({
            code: 'invalid_event',
            message: err instanceof Error ? err.message : 'PAYMENT-REQUIRED decode failed',
          });
        }
      }
    }

    const settlementHeader = headerGet(resHeaders, 'PAYMENT-RESPONSE');
    if (settlementHeader !== null) {
      try {
        const settlement = decodePaymentHeader<X402SettlementResponse>(settlementHeader);
        const mapped = mapSettlementResponse(
          settlement,
          settlementContext({
            ...(payload?.accepted === undefined ? {} : { accept: payload.accepted }),
            ...(payload?.payload?.authorization?.nonce === undefined
              ? {}
              : { nonce: payload.payload.authorization.nonce }),
            ...(payload?.resource === undefined ? {} : { resource: payload.resource }),
          }),
          'x402-client',
        );
        if (mapped !== undefined) client.emit(mapped);
      } catch (err) {
        client.notify({
          code: 'invalid_event',
          message: err instanceof Error ? err.message : 'PAYMENT-RESPONSE decode failed',
        });
      }
    }

    return response;
  };
  return wrapped;
}
