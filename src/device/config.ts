import { parseApiKey, type KeyEnv } from '@halvorai/schema';

/** Where the helpers send what an app install hands your backend. */
export interface DeviceConfig {
  /** Your HalvorAI API key. Default: `HALVOR_API_KEY`. Never send it to the app. */
  apiKey?: string;
  /** API base URL. Default: `HALVOR_ENDPOINT`, else sandbox for test keys, production for live. */
  endpoint?: string;
  /** Injected fetch, for tests. */
  fetch?: typeof fetch;
}

export interface ResolvedDeviceConfig {
  apiKey: string;
  environment: KeyEnv;
  endpoint: string;
  fetch: typeof fetch;
}

/**
 * A request the app sent that your backend must answer with [status]. The body follows HalvorAI's
 * error format, so the Flutter SDK reports [code] as `serverCode`.
 *
 * The status tells the app what to do: 400, 413 and 422 are permanent (the app drops the batch,
 * or splits it on 413), 502 means try again later.
 */
export class DeviceRequestError extends Error {
  override readonly name = 'DeviceRequestError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** `{"error":{"code","message"}}`, as HalvorAI answers errors. */
  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

/** A misconfigured backend is a programming error, so this throws a plain Error. */
export function resolveDeviceConfig(config: DeviceConfig): ResolvedDeviceConfig {
  const apiKey = config.apiKey ?? env('HALVOR_API_KEY');
  const parsed = typeof apiKey === 'string' ? parseApiKey(apiKey) : null;
  if (!apiKey || !parsed) {
    throw new Error('HalvorAI api key is missing or malformed (expected hk_test_… or hk_live_…)');
  }
  const endpoint =
    config.endpoint ??
    env('HALVOR_ENDPOINT') ??
    (parsed.env === 'live' ? 'https://api.halvorai.com' : 'https://api.sandbox.halvorai.com');
  return {
    apiKey,
    environment: parsed.env,
    endpoint: endpoint.replace(/\/+$/, '').replace(/\/v1\/events$/, ''),
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
  };
}
