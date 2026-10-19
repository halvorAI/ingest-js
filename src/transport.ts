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

export type DeliveryOutcome =
  | { kind: 'ok'; results: IngestItemResult[] }
  | { kind: 'retry'; status?: number; message: string }
  | { kind: 'fatal'; status: number; message: string }
  | { kind: 'too_large' };

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FATAL_STATUSES = new Set([400, 401, 403, 422]);

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
    return { kind: 'retry', message: err instanceof Error ? err.message : 'network error' };
  }

  if (response.status === 413) return { kind: 'too_large' };
  if (RETRY_STATUSES.has(response.status)) {
    return { kind: 'retry', status: response.status, message: await safeText(response) };
  }
  if (FATAL_STATUSES.has(response.status)) {
    return { kind: 'fatal', status: response.status, message: await safeText(response) };
  }
  if (!response.ok) {
    return { kind: 'retry', status: response.status, message: await safeText(response) };
  }

  try {
    const body = (await response.json()) as { results?: IngestItemResult[] };
    return { kind: 'ok', results: body.results ?? [] };
  } catch {
    return { kind: 'retry', message: 'invalid response body' };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
