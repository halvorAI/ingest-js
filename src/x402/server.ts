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

export interface X402ServerOptions {
  /** Payee identity for server-side events (merchant / API provider). */
  payee: {
    type?: 'merchant' | 'api_provider' | 'wallet' | 'business' | 'person';
    name?: string;
    id?: string;
    wallet?: { network: string; address: string };
    resource_url?: string;
  };
}

type HeaderBag = Record<string, string | string[] | undefined> | Headers;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headerGet(headers, name) ?? undefined;
  }
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return typeof direct === 'string' ? direct : undefined;
}

function observeRequest(
  client: HalvorClient,
  headers: HeaderBag,
  payee: Record<string, unknown>,
): void {
  const signature = readHeader(headers, 'PAYMENT-SIGNATURE');
  if (signature === undefined) return;
  try {
    const payload = decodePaymentHeader<X402PaymentPayload>(signature);
    const mapped = mapPaymentPayload(payload, 'x402-server', payee);
    if (mapped !== undefined) client.emit(mapped);
  } catch (err) {
    client.notify({
      code: 'invalid_event',
      message: err instanceof Error ? err.message : 'PAYMENT-SIGNATURE decode failed',
    });
  }
}

function observeResponse(
  client: HalvorClient,
  status: number,
  headers: HeaderBag,
  payee: Record<string, unknown>,
  lastPayload?: X402PaymentPayload,
): void {
  if (status === 402) {
    const requiredHeader = readHeader(headers, 'PAYMENT-REQUIRED');
    if (requiredHeader !== undefined) {
      try {
        const required = decodePaymentHeader<X402PaymentRequired>(requiredHeader);
        const mapped = mapPaymentRequired(required, 'x402-server', payee);
        if (mapped !== undefined) client.emit(mapped);
      } catch (err) {
        client.notify({
          code: 'invalid_event',
          message: err instanceof Error ? err.message : 'PAYMENT-REQUIRED decode failed',
        });
      }
    }
  }

  const settlementHeader = readHeader(headers, 'PAYMENT-RESPONSE');
  if (settlementHeader !== undefined) {
    try {
      const settlement = decodePaymentHeader<X402SettlementResponse>(settlementHeader);
      const mapped = mapSettlementResponse(
        settlement,
        settlementContext({
          ...(lastPayload?.accepted === undefined ? {} : { accept: lastPayload.accepted }),
          ...(lastPayload?.payload?.authorization?.nonce === undefined
            ? {}
            : { nonce: lastPayload.payload.authorization.nonce }),
          ...(lastPayload?.resource === undefined ? {} : { resource: lastPayload.resource }),
          payeeOverride: payee,
        }),
        'x402-server',
      );
      if (mapped !== undefined) client.emit(mapped);
    } catch (err) {
      client.notify({
        code: 'invalid_event',
        message: err instanceof Error ? err.message : 'PAYMENT-RESPONSE decode failed',
      });
    }
  }
}

function payeeRecord(options: X402ServerOptions): Record<string, unknown> {
  const p = options.payee;
  const out: Record<string, unknown> = { type: p.type ?? 'api_provider' };
  if (p.name !== undefined) out['name'] = p.name;
  if (p.id !== undefined) out['id'] = p.id;
  if (p.wallet !== undefined) out['wallet'] = p.wallet;
  if (p.resource_url !== undefined) out['resource_url'] = p.resource_url;
  if (out['name'] === undefined && out['wallet'] === undefined && out['id'] === undefined) {
    out['name'] = 'x402 resource server';
  }
  return out;
}

/**
 * Hono middleware that observes x402 headers. Use alongside `@x402/hono` `paymentMiddleware`.
 */
export function halvorX402Hono(
  client: HalvorClient,
  options: X402ServerOptions,
): (c: {
  req: { header: (name: string) => string | undefined; raw: { headers: Headers } };
  res: { status: number; headers: Headers };
  next: () => Promise<void>;
}) => Promise<void> {
  const payee = payeeRecord(options);
  return async (c) => {
    const reqHeaders = c.req.raw.headers;
    let lastPayload: X402PaymentPayload | undefined;
    const sig = readHeader(reqHeaders, 'PAYMENT-SIGNATURE');
    if (sig !== undefined) {
      try {
        lastPayload = decodePaymentHeader<X402PaymentPayload>(sig);
      } catch {
        // observeRequest will notify
      }
    }
    observeRequest(client, reqHeaders, payee);
    await c.next();
    observeResponse(client, c.res.status, c.res.headers, payee, lastPayload);
  };
}

/**
 * Express middleware that observes x402 headers. Use alongside `@x402/express` `paymentMiddleware`.
 */
export function halvorX402Express(
  client: HalvorClient,
  options: X402ServerOptions,
): (
  req: { headers: HeaderBag },
  res: {
    statusCode: number;
    getHeader: (name: string) => number | string | string[] | undefined;
    on: (event: string, listener: () => void) => void;
  },
  next: (err?: unknown) => void,
) => void {
  const payee = payeeRecord(options);
  return (req, res, next) => {
    let lastPayload: X402PaymentPayload | undefined;
    const sig = readHeader(req.headers, 'PAYMENT-SIGNATURE');
    if (sig !== undefined) {
      try {
        lastPayload = decodePaymentHeader<X402PaymentPayload>(sig);
      } catch {
        // observeRequest will notify
      }
    }
    observeRequest(client, req.headers, payee);
    res.on('finish', () => {
      const headers: Record<string, string | undefined> = {};
      for (const name of [
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE',
        'payment-required',
        'payment-response',
      ]) {
        const v = res.getHeader(name);
        if (typeof v === 'string') headers[name] = v;
        else if (Array.isArray(v)) headers[name] = v[0];
      }
      observeResponse(client, res.statusCode, headers, payee, lastPayload);
    });
    next();
  };
}

/** @deprecated Prefer `halvorX402Hono` / `halvorX402Express`. */
export function halvorX402Middleware(
  client: HalvorClient,
  options: X402ServerOptions,
): ReturnType<typeof halvorX402Hono> {
  return halvorX402Hono(client, options);
}
