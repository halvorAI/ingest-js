import { canonicalize } from '@halvorai/schema/canonical';
import {
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JSONWebKeySet,
} from 'jose';
import { unzipSync } from 'fflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const MANIFEST_TYP = 'pack-manifest+jws';
const ANCHOR_TYP = 'chain-anchor+jws';

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface PackManifest {
  pack_id: string;
  kind: 'case' | 'due_diligence';
  org: { id: string; name: string };
  case_id: string | null;
  created_at: string;
  created_by: string | null;
  period: { from: string; to: string };
  ape_version: string;
  verifier_version: string;
  sanctions_list_versions: Record<string, string>;
  files: ManifestFile[];
  signing_key: string;
}

interface ChainAnchorPayload {
  org_id: string;
  env: 'test' | 'live';
  date: string;
  last_chain_seq: string;
  last_chain_hash: string;
}

export type PackFileInput = ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;

export type PackKeySet = JSONWebKeySet | JWK;

export interface PackVerificationSection {
  ok: boolean;
  verified: number;
  message: string;
}

export interface PackVerificationReport {
  ok: boolean;
  summary: string;
  packId: string | null;
  manifest: PackVerificationSection;
  files: PackVerificationSection;
  events: PackVerificationSection;
  chain: PackVerificationSection;
  anchors: PackVerificationSection;
  failures: string[];
}

interface EventLine {
  event: Record<string, unknown>;
  sig: string;
}

interface ChainEvent {
  event_id: string;
  chain_seq: string;
  prev_chain_hash: string | null;
  chain_hash: string;
  canonical_sha256: string;
  source: { id: string; public_jwk: JWK };
}

interface ChainAnchor {
  date: string;
  last_chain_seq: string;
  last_chain_hash: string;
  signature: string;
}

interface ChainDocument {
  events: ChainEvent[];
  anchors: ChainAnchor[];
}

function section(message: string): PackVerificationSection {
  return { ok: false, verified: 0, message };
}

function initialReport(): PackVerificationReport {
  return {
    ok: false,
    summary: 'Evidence pack verification failed.',
    packId: null,
    manifest: section('Manifest not verified'),
    files: section('Files not verified'),
    events: section('Events not verified'),
    chain: section('Chain not verified'),
    anchors: section('Anchors not verified'),
    failures: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFiles(input: Uint8Array | PackFileInput): Map<string, Uint8Array> {
  if (input instanceof Uint8Array) {
    return normalizeZipRoot(new Map(Object.entries(unzipSync(input))));
  }
  return input instanceof Map ? new Map(input) : new Map(Object.entries(input));
}

function normalizeZipRoot(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has('manifest.json')) return files;
  const manifests = [...files.keys()].filter((path) => path.endsWith('/manifest.json'));
  if (manifests.length !== 1) return files;
  const prefix = manifests[0]?.slice(0, -'manifest.json'.length) ?? '';
  const normalized = new Map<string, Uint8Array>();
  for (const [path, body] of files) {
    if (path.startsWith(prefix) && path !== prefix) normalized.set(path.slice(prefix.length), body);
  }
  return normalized;
}

function jwksFrom(input: PackKeySet): JSONWebKeySet {
  if ('keys' in input && Array.isArray(input.keys)) return input as JSONWebKeySet;
  return { keys: [input as JWK] };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const exact = new Uint8Array(bytes).buffer;
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', exact)));
}

function bytesFromHex(value: string, label: string): Uint8Array {
  if (!HEX_DIGEST.test(value)) throw new TypeError(`${label} is not a sha256 digest`);
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function computeChainHash(
  previousHash: string | null,
  canonicalDigest: string,
): Promise<string> {
  const previous =
    previousHash === null ? new Uint8Array() : bytesFromHex(previousHash, 'previous chain hash');
  const canonical = bytesFromHex(canonicalDigest, 'canonical event digest');
  const combined = new Uint8Array(previous.byteLength + canonical.byteLength);
  combined.set(previous);
  combined.set(canonical, previous.byteLength);
  return sha256(combined);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function parseManifest(value: unknown): PackManifest {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new TypeError('invalid manifest.json');
  if (
    typeof value.pack_id !== 'string' ||
    !isRecord(value.org) ||
    typeof value.org.id !== 'string' ||
    typeof value.signing_key !== 'string'
  ) {
    throw new TypeError('invalid manifest.json');
  }
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      typeof file.bytes !== 'number'
    ) {
      throw new TypeError('invalid manifest file entry');
    }
  }
  return value as unknown as PackManifest;
}

function parseEventLines(bytes: Uint8Array): EventLine[] {
  const text = decoder.decode(bytes);
  if (text.trim() === '') return [];
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new TypeError(`events.jsonl line ${index + 1} is not valid JSON`);
      }
      if (!isRecord(value) || !isRecord(value.event) || typeof value.sig !== 'string') {
        throw new TypeError(`events.jsonl line ${index + 1} is invalid`);
      }
      return { event: value.event, sig: value.sig };
    });
}

function parseChainDocument(bytes: Uint8Array): ChainDocument {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new TypeError('chain.json is not valid JSON');
  }
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.anchors)) {
    throw new TypeError('chain.json is invalid');
  }
  const events = value.events.map((item, index): ChainEvent => {
    if (
      !isRecord(item) ||
      typeof item.event_id !== 'string' ||
      typeof item.chain_seq !== 'string' ||
      (item.prev_chain_hash !== null && typeof item.prev_chain_hash !== 'string') ||
      typeof item.chain_hash !== 'string' ||
      typeof item.canonical_sha256 !== 'string' ||
      !isRecord(item.source) ||
      typeof item.source.id !== 'string' ||
      !isRecord(item.source.public_jwk)
    ) {
      throw new TypeError(`chain.json event ${index + 1} is invalid`);
    }
    return item as unknown as ChainEvent;
  });
  const anchors = value.anchors.map((item, index): ChainAnchor => {
    if (
      !isRecord(item) ||
      typeof item.date !== 'string' ||
      typeof item.last_chain_seq !== 'string' ||
      typeof item.last_chain_hash !== 'string' ||
      typeof item.signature !== 'string'
    ) {
      throw new TypeError(`chain.json anchor ${index + 1} is invalid`);
    }
    return item as unknown as ChainAnchor;
  });
  return { events, anchors };
}

async function verifyManifest(
  manifest: PackManifest,
  signature: string,
  keys: JSONWebKeySet,
): Promise<boolean> {
  const header = decodeProtectedHeader(signature);
  if (header.alg !== 'EdDSA' || header.typ !== MANIFEST_TYP || typeof header.kid !== 'string') {
    return false;
  }
  const expectedKid = manifest.signing_key.split('#')[1];
  if (expectedKid !== header.kid) return false;
  const jwk = keys.keys.find((key) => key.kid === header.kid);
  if (jwk === undefined) return false;
  const key = await importJWK(jwk, 'EdDSA');
  const verified = await compactVerify(signature, key, { algorithms: ['EdDSA'] });
  return decoder.decode(verified.payload) === canonicalize(manifest);
}

async function verifyAnchor(
  payload: ChainAnchorPayload,
  signature: string,
  keys: JSONWebKeySet,
): Promise<boolean> {
  try {
    const header = decodeProtectedHeader(signature);
    if (header.alg !== 'EdDSA' || header.typ !== ANCHOR_TYP || typeof header.kid !== 'string') {
      return false;
    }
    const jwk = keys.keys.find((key) => key.kid === header.kid);
    if (jwk === undefined) return false;
    const key = await importJWK(jwk, 'EdDSA');
    const verified = await compactVerify(signature, key, { algorithms: ['EdDSA'] });
    return decoder.decode(verified.payload) === canonicalize(payload);
  } catch {
    return false;
  }
}

async function verifyEventSignature(line: EventLine, chainEvent: ChainEvent): Promise<boolean> {
  const source = line.event.source;
  if (
    !isRecord(source) ||
    source.id !== chainEvent.source.id ||
    decodeProtectedHeader(line.sig).kid !== chainEvent.source.id
  ) {
    return false;
  }
  const [header, payload, signature] = line.sig.split('.');
  if (header === undefined || payload !== '' || signature === undefined) return false;
  const key = await importJWK(chainEvent.source.public_jwk, 'EdDSA');
  const attached = `${header}.${base64Url(encoder.encode(canonicalize(line.event)))}.${signature}`;
  const verified = await compactVerify(attached, key, { algorithms: ['EdDSA'] });
  return verified.protectedHeader.typ === 'ape+jws' && verified.protectedHeader.ape === '0.1';
}

function eventEnvironment(event: Record<string, unknown>): 'test' | 'live' | null {
  return event.environment === 'test' || event.environment === 'live' ? event.environment : null;
}

/**
 * Verifies an evidence pack without network access. The input may be zip bytes or already
 * extracted files; keys may be a JWKS document or one pinned public JWK.
 */
export async function verifyPack(
  input: Uint8Array | PackFileInput,
  keys: PackKeySet,
): Promise<PackVerificationReport> {
  const report = initialReport();
  let files: Map<string, Uint8Array>;
  try {
    files = asFiles(input);
  } catch {
    report.failures.push('Evidence pack is not a readable zip file');
    return report;
  }

  const manifestBytes = files.get('manifest.json');
  const signatureBytes = files.get('manifest.jws');
  if (manifestBytes === undefined || signatureBytes === undefined) {
    report.failures.push('Evidence pack must contain manifest.json and manifest.jws');
    return report;
  }

  let manifest: PackManifest;
  try {
    manifest = parseManifest(JSON.parse(decoder.decode(manifestBytes)) as unknown);
    report.packId = manifest.pack_id;
    const canonicalBytes = encoder.encode(canonicalize(manifest));
    if ((await sha256(manifestBytes)) !== (await sha256(canonicalBytes))) {
      throw new TypeError('manifest.json is not in canonical form');
    }
    const valid = await verifyManifest(
      manifest,
      decoder.decode(signatureBytes).trim(),
      jwksFrom(keys),
    );
    if (!valid) throw new TypeError('manifest signature is invalid');
    report.manifest = { ok: true, verified: 1, message: 'Manifest signature verified' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'manifest signature is invalid';
    report.manifest.message = message;
    report.failures.push(message);
    return report;
  }

  let failedFiles = 0;
  for (const entry of manifest.files) {
    const body = files.get(entry.path);
    if (body === undefined) {
      report.failures.push(`${entry.path} is missing`);
      failedFiles += 1;
      continue;
    }
    const wrongSize = body.byteLength !== entry.bytes;
    const wrongHash = (await sha256(body)) !== entry.sha256;
    if (wrongSize) report.failures.push(`${entry.path} size does not match manifest`);
    if (wrongHash) {
      report.failures.push(`${entry.path} sha256 does not match manifest`);
    }
    if (wrongSize || wrongHash) failedFiles += 1;
  }
  report.files = {
    ok: failedFiles === 0,
    verified: manifest.files.length - failedFiles,
    message:
      failedFiles === 0
        ? `${manifest.files.length} file hashes verified`
        : `${failedFiles} file integrity check${failedFiles === 1 ? '' : 's'} failed`,
  };

  const eventsBytes = files.get('events.jsonl');
  const chainBytes = files.get('chain.json');
  if (eventsBytes === undefined || chainBytes === undefined) {
    if (eventsBytes === undefined) report.failures.push('events.jsonl is missing');
    if (chainBytes === undefined) report.failures.push('chain.json is missing');
    return finalize(report);
  }

  let eventLines: EventLine[];
  let chain: ChainDocument;
  try {
    eventLines = parseEventLines(eventsBytes);
    chain = parseChainDocument(chainBytes);
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : 'Pack event data is invalid');
    return finalize(report);
  }

  const chainByEvent = new Map(chain.events.map((event) => [event.event_id, event]));
  if (chainByEvent.size !== chain.events.length)
    report.failures.push('chain.json has duplicate event ids');
  if (eventLines.length !== chain.events.length) {
    report.failures.push('events.jsonl and chain.json event counts do not match');
  }

  let verifiedEvents = 0;
  const environments = new Set<'test' | 'live'>();
  for (const [index, line] of eventLines.entries()) {
    const eventId = line.event.id;
    if (typeof eventId !== 'string') {
      report.failures.push(`events.jsonl line ${index + 1} has no event id`);
      continue;
    }
    const chainEvent = chainByEvent.get(eventId);
    if (chainEvent === undefined) {
      report.failures.push(`Event ${eventId} is missing from chain.json`);
      continue;
    }
    const environment = eventEnvironment(line.event);
    if (environment === null) report.failures.push(`Event ${eventId} has no valid environment`);
    else environments.add(environment);
    const digest = await sha256(encoder.encode(canonicalize(line.event)));
    if (digest !== chainEvent.canonical_sha256) {
      report.failures.push(`Event ${eventId} canonical sha256 does not match chain.json`);
      continue;
    }
    try {
      if (!(await verifyEventSignature(line, chainEvent))) {
        report.failures.push(`Event ${eventId} producer signature is invalid`);
        continue;
      }
    } catch {
      report.failures.push(`Event ${eventId} producer signature is invalid`);
      continue;
    }
    verifiedEvents += 1;
  }
  report.events = {
    ok: verifiedEvents === eventLines.length && eventLines.length === chain.events.length,
    verified: verifiedEvents,
    message: `${verifiedEvents} of ${eventLines.length} event signatures verified`,
  };

  let verifiedLinks = 0;
  if (chain.events.some((event) => !/^(0|[1-9][0-9]*)$/.test(event.chain_seq))) {
    report.failures.push('chain.json contains an invalid chain sequence');
    return finalize(report);
  }
  const sortedChain = [...chain.events].sort((a, b) => {
    const left = BigInt(a.chain_seq);
    const right = BigInt(b.chain_seq);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const [index, link] of sortedChain.entries()) {
    try {
      if (
        (await computeChainHash(link.prev_chain_hash, link.canonical_sha256)) !== link.chain_hash
      ) {
        report.failures.push(`Chain hash is invalid at sequence ${link.chain_seq}`);
        continue;
      }
      const previous = sortedChain[index - 1];
      if (
        previous !== undefined &&
        BigInt(link.chain_seq) === BigInt(previous.chain_seq) + 1n &&
        link.prev_chain_hash !== previous.chain_hash
      ) {
        report.failures.push(`Chain link is broken at sequence ${link.chain_seq}`);
        continue;
      }
      verifiedLinks += 1;
    } catch {
      report.failures.push(`Chain data is invalid at sequence ${link.chain_seq}`);
    }
  }
  report.chain = {
    ok: verifiedLinks === sortedChain.length,
    verified: verifiedLinks,
    message: `${verifiedLinks} of ${sortedChain.length} included chain positions verified`,
  };

  let verifiedAnchors = 0;
  if (environments.size > 1) report.failures.push('Included events span multiple environments');
  const environment = [...environments][0];
  const jwks = jwksFrom(keys);
  if (sortedChain.length > 0 && chain.anchors.length === 0) {
    report.failures.push('No daily anchor covers the included events');
  }
  const lastIncluded = sortedChain.at(-1);
  const hasCoveringAnchor =
    lastIncluded === undefined ||
    chain.anchors.some(
      (anchor) =>
        /^(0|[1-9][0-9]*)$/.test(anchor.last_chain_seq) &&
        BigInt(anchor.last_chain_seq) >= BigInt(lastIncluded.chain_seq),
    );
  if (!hasCoveringAnchor) report.failures.push('No daily anchor covers the included events');
  for (const anchor of chain.anchors) {
    if (environment === undefined) {
      report.failures.push(`Anchor ${anchor.date} cannot be tied to an event environment`);
      continue;
    }
    const payload: ChainAnchorPayload = {
      org_id: manifest.org.id,
      env: environment,
      date: anchor.date,
      last_chain_seq: anchor.last_chain_seq,
      last_chain_hash: anchor.last_chain_hash,
    };
    if (!(await verifyAnchor(payload, anchor.signature, jwks))) {
      report.failures.push(`Daily anchor ${anchor.date} signature is invalid`);
      continue;
    }
    const anchoredEvent = chainBySequence(sortedChain, anchor.last_chain_seq);
    if (anchoredEvent !== undefined && anchoredEvent.chain_hash !== anchor.last_chain_hash) {
      report.failures.push(`Daily anchor ${anchor.date} chain hash does not match`);
      continue;
    }
    verifiedAnchors += 1;
  }
  report.anchors = {
    ok: verifiedAnchors === chain.anchors.length,
    verified: verifiedAnchors,
    message: `${verifiedAnchors} of ${chain.anchors.length} daily anchors verified`,
  };

  return finalize(report);
}

function chainBySequence(events: readonly ChainEvent[], sequence: string): ChainEvent | undefined {
  return events.find((event) => event.chain_seq === sequence);
}

function finalize(report: PackVerificationReport): PackVerificationReport {
  report.ok =
    report.failures.length === 0 &&
    report.manifest.ok &&
    report.files.ok &&
    report.events.ok &&
    report.chain.ok &&
    report.anchors.ok;
  report.summary = report.ok
    ? `Evidence pack ${report.packId ?? ''} passed verification.`.replace('  ', ' ')
    : `Evidence pack verification failed with ${report.failures.length} issue${
        report.failures.length === 1 ? '' : 's'
      }.`;
  return report;
}
