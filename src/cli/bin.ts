#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runInit } from './init.js';
import { runVerifyPack } from './verify-pack.js';

function usage(code = 2): never {
  console.log(`Usage:
  npx @halvorai/ingest init [--api-key hk_test_…] [--endpoint URL] [--dashboard URL] [--name NAME] [--cwd DIR]
  npx @halvorai/ingest verify-pack <pack.zip> [--jwks FILE_OR_URL]

init registers a source key, writes .env.local (with HALVOR_ENDPOINT when --endpoint is given),
and sends one test event.
verify-pack verifies an evidence pack locally. If --jwks is omitted, it fetches the
JWKS URL named by the signed manifest; pass a pinned JWK or JWKS file for offline use.
`);
  process.exit(code);
}

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('-')) usage();
  return value;
}

async function promptApiKey(): Promise<string> {
  if (!input.isTTY) {
    throw new Error('api key required: pass --api-key or set HALVOR_API_KEY');
  }
  const rl = createInterface({ input, output });
  try {
    const key = (await rl.question('API key (hk_test_… or hk_live_…): ')).trim();
    if (key.length === 0) throw new Error('api key is required');
    return key;
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === undefined) usage();
  if (command === 'help' || command === '--help' || command === '-h') usage(0);
  if (command === 'verify-pack') {
    const rest = argv.slice(1);
    const zipPath = rest[0];
    if (zipPath === undefined || zipPath.startsWith('-')) usage();
    const jwks = argValue(rest, '--jwks');
    const report = await runVerifyPack({
      zipPath,
      ...(jwks === undefined ? {} : { jwks }),
    });
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command !== 'init') {
    console.error(`unknown command: ${command}`);
    usage();
  }

  const rest = argv.slice(1);
  const apiKey =
    argValue(rest, '--api-key') ?? process.env['HALVOR_API_KEY'] ?? (await promptApiKey());

  const endpoint = argValue(rest, '--endpoint') ?? process.env['HALVOR_ENDPOINT'];
  const dashboard = argValue(rest, '--dashboard');
  const name = argValue(rest, '--name');
  const cwd = argValue(rest, '--cwd');
  await runInit({
    apiKey,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(name === undefined ? {} : { name }),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(cwd === undefined ? {} : { cwd }),
  });
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`command failed: ${message}`);
  process.exit(1);
});
