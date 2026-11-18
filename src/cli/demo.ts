import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateSourceKeyPair, verifyEvent, type JWK } from '@halvorai/schema';
import { verifyPack, type PackKeySet } from '@halvorai/packs/verify';
import { unzipSync, zipSync } from 'fflate';
import { HalvorClient } from '../client.js';
import { withAgentContext } from '../context.js';
import type { SignedEnvelope } from '../transport.js';
import { formatPackVerification } from './verify-pack.js';

export interface DemoOptions {
  log?: (line: string) => void;
  /** Directory holding sample-pack.zip and sample-pack-keys.json. Defaults to the package's samples/. */
  samplesDir?: string;
}

export interface DemoResult {
  eventVerified: boolean;
  samplePassed: boolean;
  tamperedFailed: boolean;
}

function defaultSamplesDir(): string {
  // dist/bin.js and src/cli/demo.ts both sit one or two levels below the package root.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return here.includes('/src/cli') || here.includes('\\src\\cli')
    ? fileURLToPath(new URL('../../samples/', import.meta.url))
    : fileURLToPath(new URL('../samples/', import.meta.url));
}

/** Flips one byte of events.jsonl, the way a changed record would. */
export function tamperPack(zip: Uint8Array): Uint8Array {
  const files = unzipSync(zip);
  const events = files['events.jsonl'];
  if (events === undefined) throw new Error('sample pack has no events.jsonl');
  const changed = new Uint8Array(events);
  const at = changed.indexOf(0x31); // the first "1" digit
  changed[at === -1 ? 0 : at] = at === -1 ? 0x5b : 0x32;
  files['events.jsonl'] = changed;
  return zipSync(files, { level: 0 });
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const samples = options.samplesDir ?? defaultSamplesDir();

  log('1. Sign an event on this machine');
  const keys = await generateSourceKeyPair();
  const sourceKey: JWK = { ...keys.privateJwk, kid: 'src_local' };
  const sent: SignedEnvelope[] = [];
  const halvor = new HalvorClient({
    sourceKey,
    environment: 'test',
    sink: (envelopes) => {
      sent.push(...envelopes);
    },
    exitHook: false,
  });
  await withAgentContext(
    {
      agent: { id: 'agt_travel_12', name: 'Travel booking agent' },
      owner: { id: 'own_u_4410', type: 'person', country: 'US' },
      instruction: { id: 'task_8890', text: 'Book a return flight to Austin under $500' },
    },
    async () => {
      halvor.emit({
        type: 'payment.settled',
        payment: {
          payment_id: 'pi_3QxAbCdEfGhIjKlM',
          rail: 'stripe',
          amount: { value: '41200', unit: 'minor', currency: 'USD' },
          status: 'settled',
          rail_ref: { payment_intent: 'pi_3QxAbCdEfGhIjKlM' },
        },
        payee: { type: 'merchant', name: 'Example Airways' },
      });
    },
  );
  await halvor.flush({ timeoutMs: 5000 });
  const envelope = sent[0];
  if (envelope === undefined) throw new Error('no event was signed');
  const event = envelope.event as {
    id: string;
    instruction?: { hash?: string };
  };
  const eventVerified = await verifyEvent(envelope.event, envelope.sig, keys.publicJwk);
  log(`   ${event.id}: Travel booking agent paid Example Airways 412.00 USD on stripe`);
  log(`   Instruction sent as ${(event.instruction?.hash ?? 'a hash').slice(0, 19)}…, never as text`);
  log(`   Ed25519 signature: ${eventVerified ? 'verified' : 'NOT verified'}`);
  log('');

  const zip = new Uint8Array(await readFile(`${samples}sample-pack.zip`));
  const jwks = JSON.parse(await readFile(`${samples}sample-pack-keys.json`, 'utf8')) as PackKeySet;

  log('2. Verify a sample evidence pack offline (synthetic data)');
  const passed = await verifyPack(zip, jwks);
  for (const line of formatPackVerification(passed)) log(`   ${line}`);
  log('');

  log('3. Change one byte of events.jsonl and verify again');
  const failed = await verifyPack(tamperPack(zip), jwks);
  for (const line of formatPackVerification(failed)) log(`   ${line}`);
  log('');
  log('Next: npx @halvorai/ingest verify-pack <pack.zip> --jwks <keys.json> checks a real pack.');

  return { eventVerified, samplePassed: passed.ok, tamperedFailed: !failed.ok };
}
