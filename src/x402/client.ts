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

function toHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

/**
 * Wrap a fetch implementation (typically `wrapFetchWithPayment(...)`) so HalvorAI
 * observes x402 headers without sitting in the payment path.
 */
export function withHalvor(fetchImpl: typeof fetch, client: HalvorClient): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const reqHeaders = toHeaders(init);
    const signature = headerGet(reqHeaders, 'PAYMENT-SIGNATURE');
    let payload: X402PaymentPayload | undefined;
    if (signature !== null) {
      try {
        payload = decodePaymentHeader<X402PaymentPayload>(signature);
        const mapped = mapPaymentPayload(payload, 'x402-client');
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
          if (mapped !== undefined) client.emit(mapped);
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
