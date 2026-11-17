// Installs the packed tarball into an empty project and checks it works as a real npm user would see it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) =>
  // npm.cmd needs a shell on Windows; node (often under "Program Files") must not go through one.
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' && cmd === npm }).toString().trim();

const work = mkdtempSync(join(tmpdir(), 'halvorai-smoke-'));
try {
  const tgzName = run(npm, ['pack', '--silent', '--pack-destination', work], root).split('\n').pop();
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(npm, ['install', '--silent', '--no-audit', '--no-fund', join(work, tgzName)], work);

  writeFileSync(
    join(work, 'check.mjs'),
    `
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import * as core from '@halvorai/ingest';
for (const p of ['cli', 'stripe', 'x402', 'mpp', 'mcp', 'evidence']) await import('@halvorai/ingest/' + p);
assert.equal(core.name, '@halvorai/ingest');

const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid: 'src_smoke' };
const sent = [];
const errors = [];
const halvor = new core.HalvorClient({ sourceKey: jwk, environment: 'test', sink: (e) => { sent.push(...e); }, onError: (e) => errors.push(e), exitHook: false });
await core.withAgentContext(
  { agent: { id: 'agt_smoke', name: 'Smoke agent' }, owner: { id: 'own_smoke', type: 'person', country: 'US' }, instruction: { id: 'task_1', text: 'Buy one test item' } },
  async () => {
    halvor.emit({
      type: 'payment.settled',
      payment: { payment_id: 'pi_smoke', rail: 'stripe', amount: { value: '1200', unit: 'minor', currency: 'USD' }, status: 'settled', rail_ref: { payment_intent: 'pi_smoke' } },
      payee: { type: 'merchant', name: 'Example Store' },
    });
  },
);
await halvor.flush();
assert.deepEqual(errors, [], JSON.stringify(errors));
assert.equal(sent.length, 1, 'one signed envelope via sink');
assert.ok(sent[0].sig, 'envelope is signed');
console.log('import + offline emit OK');
`,
  );
  console.log(run(process.execPath, ['check.mjs'], work));

  const bin = spawnSync(process.execPath, [join(work, 'node_modules', '@halvorai', 'ingest', 'dist', 'bin.js')], { cwd: work });
  const out = bin.stdout.toString();
  if (bin.status !== 2 || !out.includes('Usage')) throw new Error(`CLI usage check failed (exit ${bin.status}): ${out}${bin.stderr}`);
  console.log('CLI OK');
  console.log('smoke passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
