import { DeviceRequestError, resolveDeviceConfig, type DeviceConfig } from './config.js';
import { forwardEnvelopes } from './forward.js';
import { registerDeviceSource } from './register.js';

export interface DeviceRoutesOptions extends DeviceConfig {
  /**
   * The signed-in user's owner id for this request, from your own session or token, or null when
   * nobody is signed in. Null answers 401, and the app tries again later.
   */
  ownerId(request: Request): string | null | undefined | Promise<string | null | undefined>;
}

export interface DeviceRoutes {
  /** The app's `provisionUrl`: `{"public_jwk", "name"}` in, `{"source_id"}` out. */
  register(request: Request): Promise<Response>;
  /** The app's `forwardUrl`: a signed batch in, HalvorAI's response out. */
  forward(request: Request): Promise<Response>;
}

/**
 * The two routes an app using `halvorai_ingest_flutter` calls, as Fetch API handlers (Next.js
 * route handlers, Hono, Bun, Deno, Cloudflare Workers; Express through a small adapter). Your API
 * key stays on the server; the app holds only its own signing key.
 */
export function deviceRoutes(options: DeviceRoutesOptions): DeviceRoutes {
  // Checked now, so a missing key fails at startup rather than on the first request.
  resolveDeviceConfig(options);

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const unauthorized = (): Response =>
    json(401, { error: { code: 'unauthorized', message: 'sign in first' } });

  return {
    async register(request) {
      if (!(await options.ownerId(request))) return unauthorized();
      let body: { public_jwk?: unknown; name?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: { code: 'invalid_request', message: 'body is not JSON' } });
      }
      try {
        const { sourceId } = await registerDeviceSource({
          ...options,
          publicJwk: body?.public_jwk,
          ...(typeof body?.name === 'string' ? { name: body.name } : {}),
        });
        return json(200, { source_id: sourceId });
      } catch (err) {
        if (err instanceof DeviceRequestError) return json(err.status, err);
        throw err;
      }
    },

    async forward(request) {
      const ownerId = await options.ownerId(request);
      if (!ownerId) return unauthorized();
      const result = await forwardEnvelopes(new Uint8Array(await request.arrayBuffer()), {
        ...options,
        expectedOwnerId: ownerId,
      });
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': result.contentType },
      });
    },
  };
}
