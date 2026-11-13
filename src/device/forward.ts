import { DeviceRequestError, resolveDeviceConfig, type DeviceConfig } from './config.js';

export interface ForwardEnvelopesOptions extends DeviceConfig {
  /**
   * The signed-in user's owner id. Every event must name it as `owner.id`, so one user cannot
   * send events that claim to be another. Set it in the app's agent context.
   */
  expectedOwnerId: string;
  /** Most envelopes per request (default 100, as every SDK batches). More gets 413. */
  maxEnvelopes?: number;
  /** Most bytes per request (default 1 MB, HalvorAI's own limit). More gets 413. */
  maxBytes?: number;
}

/** What to answer the app: HalvorAI's response unchanged, or the reason it was not sent. */
export interface ForwardResult {
  status: number;
  body: string;
  contentType: string;
}

const DEFAULT_MAX_ENVELOPES = 100;
const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Checks a batch an app install sent and passes it to HalvorAI's `POST /v1/events` **byte for
 * byte**, then returns HalvorAI's status and body unchanged. The app reads its per-event results
 * from them. The body is parsed only to check it; re-serializing it could change the bytes the
 * device signed.
 *
 * Refused without calling HalvorAI, in HalvorAI's error format:
 * - 400 `invalid_request`: not `{"events":[{"event":{…},"sig":"…"}, …]}`.
 * - 413 `payload_too_large`: more than [maxEnvelopes] or [maxBytes]; the app splits the batch.
 * - 422 `owner_mismatch`: an event's `owner.id` is not [expectedOwnerId].
 * - 422 `environment_mismatch`: an event's `environment` is not the API key's.
 *
 * These are permanent, so the app drops the batch. If HalvorAI cannot be reached the answer is
 * 502, which the app retries. Answer 401 or 403 yourself when the user's session is not valid:
 * the app keeps the batch and tries again later.
 */
export async function forwardEnvelopes(
  body: string | Uint8Array | ArrayBuffer,
  options: ForwardEnvelopesOptions,
): Promise<ForwardResult> {
  const config = resolveDeviceConfig(options);
  const bytes =
    typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);
  try {
    checkBatch(bytes, options, config.environment);
  } catch (err) {
    if (err instanceof DeviceRequestError) return errorResult(err);
    throw err;
  }

  let res: Response;
  try {
    res = await config.fetch(`${config.endpoint}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: bytes,
    });
  } catch (err) {
    return errorResult(
      new DeviceRequestError(
        502,
        'upstream_error',
        `HalvorAI could not be reached: ${err instanceof Error ? err.message : 'network error'}`,
      ),
    );
  }
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? 'application/json',
  };
}

function checkBatch(bytes: Uint8Array, options: ForwardEnvelopesOptions, environment: string): void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new DeviceRequestError(413, 'payload_too_large', `body is over ${maxBytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DeviceRequestError(400, 'invalid_request', 'body is not UTF-8 JSON');
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new DeviceRequestError(400, 'invalid_request', 'body must be {"events":[…]} with at least one envelope');
  }
  const maxEnvelopes = options.maxEnvelopes ?? DEFAULT_MAX_ENVELOPES;
  if (events.length > maxEnvelopes) {
    throw new DeviceRequestError(413, 'payload_too_large', `more than ${maxEnvelopes} envelopes`);
  }

  events.forEach((envelope: unknown, i) => {
    const e = envelope as { event?: unknown; sig?: unknown } | null;
    const event = e?.event as { owner?: { id?: unknown }; environment?: unknown } | undefined;
    if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof e?.sig !== 'string') {
      throw new DeviceRequestError(400, 'invalid_request', `events[${i}] must be {"event":{…},"sig":"…"}`);
    }
    if (event.owner?.id !== options.expectedOwnerId) {
      throw new DeviceRequestError(
        422,
        'owner_mismatch',
        `events[${i}].event.owner.id is not the signed-in user`,
      );
    }
    if (event.environment !== environment) {
      throw new DeviceRequestError(
        422,
        'environment_mismatch',
        `events[${i}].event.environment must be ${environment}, the API key's environment`,
      );
    }
  });
}

function errorResult(err: DeviceRequestError): ForwardResult {
  return { status: err.status, body: JSON.stringify(err), contentType: 'application/json' };
}
