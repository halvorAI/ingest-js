export interface SignedEnvelope {
  event: Record<string, unknown>;
  sig: string;
}

export interface IngestItemResult {
  id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  chain_seq?: number;
  error?: { code: string; message: string };
}

/** The API's error body, `{ error: { code, message, details, request_id } }`, when it sent one. */
export interface ServerError {
  code?: string;
  message: string;
  details?: unknown[];
  requestId?: string;
}

export type DeliveryOutcome =
  | { kind: 'ok'; results: IngestItemResult[] }
  | { kind: 'retry'; status?: number; error: ServerError }
  | { kind: 'fatal'; status: number; error: ServerError }
  | { kind: 'too_large'; error: ServerError };

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Statuses that will fail the same way however often the batch is sent. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 415, 422]);

export async function postEvents(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  envelopes: SignedEnvelope[],
): Promise<DeliveryOutcome> {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/events`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ events: envelopes }),
    });
  } catch (err) {
    return {
      kind: 'retry',
      error: { message: err instanceof Error ? err.message : 'network error' },
    };
  }

  if (response.status === 413) return { kind: 'too_large', error: await readError(response) };
  if (FATAL_STATUSES.has(response.status)) {
    return { kind: 'fatal', status: response.status, error: await readError(response) };
  }
  if (RETRY_STATUSES.has(response.status) || !response.ok) {
    return { kind: 'retry', status: response.status, error: await readError(response) };
  }

  try {
    const body = (await response.json()) as { results?: IngestItemResult[] };
    return { kind: 'ok', results: body.results ?? [] };
  } catch {
    return { kind: 'retry', status: response.status, error: { message: 'invalid response body' } };
  }
}

async function readError(response: Response): Promise<ServerError> {
  const requestIdHeader = response.headers.get('request-id') ?? undefined;
  let text = '';
  try {
    text = await response.text();
  } catch {
    // body unreadable
  }
  const fallback = text.trim().length > 0 ? text.slice(0, 500) : `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown; request_id?: unknown };
    };
    const e = body.error;
    if (e && typeof e === 'object') {
      const out: ServerError = {
        message: typeof e.message === 'string' && e.message.length > 0 ? e.message : fallback,
      };
      if (typeof e.code === 'string') out.code = e.code;
      if (Array.isArray(e.details)) out.details = e.details;
      const requestId = typeof e.request_id === 'string' ? e.request_id : requestIdHeader;
      if (requestId !== undefined) out.requestId = requestId;
      return out;
    }
  } catch {
    // not JSON
  }
  const out: ServerError = { message: fallback };
  if (requestIdHeader !== undefined) out.requestId = requestIdHeader;
  return out;
}
