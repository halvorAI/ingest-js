import type { JWK } from '@halvorai/schema';

/** Thrown when `POST /v1/sources` does not register the key. */
export class SourceRegistrationError extends Error {
  override readonly name = 'SourceRegistrationError';

  constructor(
    message: string,
    /** HTTP status from the API, or undefined when the request never got an answer. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Registers a public Ed25519 key as a source with `POST /v1/sources` and returns its `src_` id.
 * Used by `init` for a server's own key and by `registerDeviceSource` for an app install's key.
 */
export async function postSource(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  name: string,
  publicJwk: JWK,
): Promise<string> {
  const url = `${endpoint.replace(/\/+$/, '').replace(/\/v1\/events$/, '')}/v1/sources`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        name,
        adapter: 'custom',
        public_jwk: publicJwk,
      }),
    });
  } catch (err) {
    throw new SourceRegistrationError(
      `POST /v1/sources failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }
  if (res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new SourceRegistrationError(
      `POST /v1/sources failed (${res.status}): ${text || res.statusText}`,
      res.status,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id.startsWith('src_')) {
    throw new SourceRegistrationError('POST /v1/sources returned no source id', res.status);
  }
  return body.id;
}
