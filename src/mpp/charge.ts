import type { HalvorClient } from '../client.js';
import { mapMppChallenge, mapMppReceipt } from './map.js';
import type { MppChallenge, MppChargeHandler, MppChargeResult, MppReceipt } from './types.js';

function parseWwwAuthenticatePayment(header: string): MppChallenge | undefined {
  // Minimal parse: Payment id="…", realm="…", method="…", intent="…", request="base64url"
  if (!header.includes('Payment')) return undefined;
  const get = (name: string): string | undefined => {
    const m = header.match(new RegExp(`${name}="([^"]*)"`));
    return m?.[1];
  };
  const id = get('id');
  const realm = get('realm');
  const method = get('method');
  const intent = get('intent');
  const requestB64 = get('request');
  if (id === undefined || realm === undefined || method === undefined || intent === undefined) {
    return undefined;
  }
  let request: MppChallenge['request'] = {};
  if (requestB64 !== undefined) {
    try {
      const json = Buffer.from(requestB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      );
      request = JSON.parse(json) as MppChallenge['request'];
    } catch {
      request = {};
    }
  }
  const challenge: MppChallenge = { id, realm, method, intent, request };
  const description = get('description');
  if (description !== undefined) challenge.description = description;
  return challenge;
}

function challengeFromResult(result: MppChargeResult): MppChallenge | undefined {
  if (result.challengeBody !== undefined) return result.challengeBody;
  const res = result.challenge;
  if (res === undefined) return undefined;
  const www = res.headers.get('WWW-Authenticate') ?? res.headers.get('www-authenticate');
  if (www !== null) return parseWwwAuthenticatePayment(www);
  return undefined;
}

function receiptFromResponse(response: Response): MppReceipt | undefined {
  const header = response.headers.get('Payment-Receipt') ?? response.headers.get('payment-receipt');
  if (header === null) return undefined;
  try {
    const b64 = header.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8')) as MppReceipt;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `mppx.charge({ amount })` so HalvorAI emits `payment.requested` on 402 and
 * `payment.settled` when a receipt is attached. Same call signature as the charge handler.
 */
export function withHalvorCharge(charge: MppChargeHandler, client: HalvorClient): MppChargeHandler {
  return async (request) => {
    const result = await charge(request);
    let lastChallenge: MppChallenge | undefined;

    if (result.status === 402) {
      lastChallenge = challengeFromResult(result);
      if (lastChallenge !== undefined) {
        client.emit(mapMppChallenge(lastChallenge));
      } else {
        client.notify({
          code: 'invalid_event',
          message: 'MPP 402 response had no parseable challenge',
        });
      }
    }

    const originalWithReceipt = result.withReceipt.bind(result);
    const wrapped: MppChargeResult = {
      ...result,
      withReceipt: async (response, receipt) => {
        const out = await originalWithReceipt(response, receipt);
        const parsed = receipt ?? receiptFromResponse(out instanceof Response ? out : response);
        if (parsed !== undefined) {
          client.emit(mapMppReceipt(parsed, lastChallenge));
        } else {
          client.notify({
            code: 'invalid_event',
            message: 'MPP withReceipt produced no Payment-Receipt',
          });
        }
        return out;
      },
    };
    return wrapped;
  };
}
