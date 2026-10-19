import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSourceKeyPair, parseApiKey, type JWK } from '@halvorai/schema';
import { HalvorClient } from '../client.js';

const DASHBOARD_URL = 'https://app.halvorai.com';

export interface InitOptions {
  /** API key (`hk_test_…` or `hk_live_…`). */
  apiKey: string;
  /** Working directory for `.env.local` (default: process.cwd()). */
  cwd?: string;
  /** Override API base URL (default from key prefix). */
  endpoint?: string;
  /** Source display name (default: hostname). */
  name?: string;
  /** Injected fetch for tests. */
  fetch?: typeof fetch;
  /** Optional log sink (default: console.log). */
  log?: (line: string) => void;
}

export interface InitResult {
  sourceId: string;
  eventId: string;
  envPath: string;
  dashboardUrl: string;
  endpoint: string;
  environment: 'test' | 'live';
}

function defaultEndpoint(env: 'test' | 'live'): string {
  return env === 'live' ? 'https://api.halvorai.com' : 'https://api.sandbox.halvorai.com';
}

/** Upsert KEY=value lines in a dotenv file without clobbering unrelated keys. */
export function upsertEnvFile(filePath: string, vars: Record<string, string>): void {
  const dir = resolve(filePath, '..');
  mkdirSync(dir, { recursive: true });
  let content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';

  for (const [key, value] of Object.entries(vars)) {
    const escaped =
      value.includes('\n') || value.includes('#') || /[\s"'`]/.test(value)
        ? `'${value.replace(/'/g, `'\\''`)}'`
        : value;
    const line = `${key}=${escaped}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) content = content.replace(re, line);
    else content += `${line}\n`;
  }

  writeFileSync(filePath, content, 'utf8');
}

async function registerSource(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  name: string,
  publicJwk: JWK,
): Promise<string> {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/sources`;
  const res = await fetchImpl(url, {
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
  if (res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /v1/sources failed (${res.status}): ${text || res.statusText}`);
  }
  const body = (await res.json()) as { id?: string };
  if (typeof body.id !== 'string' || !body.id.startsWith('src_')) {
    throw new Error('POST /v1/sources returned no source id');
  }
  return body.id;
}

/**
 * Non-interactive init used by the CLI and CI. Generates a source key, registers it,
 * writes `.env.local`, and sends one test event.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const parsed = parseApiKey(options.apiKey);
  if (!parsed) {
    throw new Error('api key must look like hk_test_… or hk_live_…');
  }

  const environment = parsed.env;
  const endpoint = options.endpoint?.replace(/\/+$/, '') ?? defaultEndpoint(environment);
  const cwd = resolve(options.cwd ?? process.cwd());
  const name = (options.name?.trim() || hostname() || 'local').slice(0, 100);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  log('Generating Ed25519 source key…');
  const pair = await generateSourceKeyPair();

  log(`Registering source at ${endpoint}…`);
  const sourceId = await registerSource(fetchImpl, endpoint, options.apiKey, name, pair.publicJwk);
  const privateJwk: JWK = { ...pair.privateJwk, kid: sourceId };

  const envPath = join(cwd, '.env.local');
  upsertEnvFile(envPath, {
    HALVOR_API_KEY: options.apiKey,
    HALVOR_SOURCE_KEY: JSON.stringify(privateJwk),
  });
  log(`Wrote ${envPath}`);

  log('Sending a test event…');
  const errors: string[] = [];
  const client = new HalvorClient({
    apiKey: options.apiKey,
    sourceKey: privateJwk,
    endpoint,
    fetch: fetchImpl,
    exitHook: false,
    onError: (e) => errors.push(`${e.code}: ${e.message}`),
  });
  const eventId = client.emit({
    type: 'payment.settled',
    agent: { id: 'agt_halvor_init', name: 'HalvorAI init' },
    owner: { id: 'own_halvor_init', type: 'business', display_name: 'HalvorAI init' },
    payment: {
      payment_id: `init:${sourceId}`,
      rail: 'x402',
      amount: {
        value: '1',
        unit: 'atomic',
        asset: {
          network: 'eip155:84532',
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          symbol: 'USDC',
          decimals: 6,
        },
      },
      status: 'settled',
      description: 'HalvorAI init test event',
      rail_ref: { scheme: 'exact', network: 'eip155:84532' },
    },
    payee: { type: 'api_provider', name: 'HalvorAI init' },
  });
  const flushed = await client.flush({ timeoutMs: 30_000 });
  await client.close({ timeoutMs: 1_000 });
  if (!flushed.drained || errors.length > 0) {
    throw new Error(`test event was not accepted: ${errors.join('; ') || 'flush timed out'}`);
  }

  const dashboardUrl = DASHBOARD_URL;
  log('');
  log(`Source ${sourceId} is ready.`);
  log(`Open the dashboard: ${dashboardUrl}`);
  log(`First event id: ${eventId}`);

  return { sourceId, eventId, envPath, dashboardUrl, endpoint, environment };
}
