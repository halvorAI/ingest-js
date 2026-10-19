import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyPack, type PackKeySet, type PackVerificationReport } from '@halvorai/packs/verify';
import { unzipSync } from 'fflate';

export interface VerifyPackOptions {
  zipPath: string;
  jwks?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseKeys(value: unknown): PackKeySet {
  if (!isRecord(value)) throw new TypeError('pack keys must be a JWK or JWKS JSON object');
  return value as PackKeySet;
}

function signingKeyUrl(zip: Uint8Array): string {
  const files = unzipSync(zip);
  const path = Object.keys(files).find(
    (candidate) => candidate === 'manifest.json' || candidate.endsWith('/manifest.json'),
  );
  const body = path === undefined ? undefined : files[path];
  if (body === undefined) throw new Error('evidence pack has no manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (!isRecord(manifest) || typeof manifest.signing_key !== 'string') {
    throw new Error('manifest.json has no signing_key');
  }
  const source = manifest.signing_key.split('#')[0] ?? manifest.signing_key;
  const url = new URL(source);
  const trustedHost =
    url.hostname === 'api.halvorai.com' || url.hostname === 'api.sandbox.halvorai.com';
  if (
    url.protocol !== 'https:' ||
    !trustedHost ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/v1/.well-known/pack-keys'
  ) {
    throw new Error('Manifest key URL is not trusted; pass a pinned key file with --jwks.');
  }
  return url.href;
}

async function loadKeys(
  zip: Uint8Array,
  location: string | undefined,
  fetchImpl: typeof fetch,
): Promise<PackKeySet> {
  const source = location ?? signingKeyUrl(zip);
  if (/^https?:\/\//.test(source)) {
    const response = await fetchImpl(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`could not fetch pack keys (${response.status})`);
    return parseKeys((await response.json()) as unknown);
  }
  return parseKeys(JSON.parse(await readFile(resolve(source), 'utf8')) as unknown);
}

export function formatPackVerification(report: PackVerificationReport): string[] {
  const result = report.ok ? 'PASS' : 'FAIL';
  const lines = [
    `${result}: ${report.summary}`,
    `Manifest: ${report.manifest.message}`,
    `Files: ${report.files.message}`,
    `Events: ${report.events.message}`,
    `Chain: ${report.chain.message}`,
    `Anchors: ${report.anchors.message}`,
  ];
  if (!report.ok) lines.push(...report.failures.map((failure) => `- ${failure}`));
  return lines;
}

export async function runVerifyPack(options: VerifyPackOptions): Promise<PackVerificationReport> {
  const zip = new Uint8Array(await readFile(resolve(options.zipPath)));
  const keys = await loadKeys(
    zip,
    options.jwks,
    options.fetch ?? globalThis.fetch.bind(globalThis),
  );
  const report = await verifyPack(zip, keys);
  const log = options.log ?? ((line: string) => console.log(line));
  for (const line of formatPackVerification(report)) log(line);
  return report;
}
