import 'dotenv/config';
import { generateKeyPair, exportJWK } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { HalvorClient, withAgentContext } from '@halvorai/ingest';
import { withHalvor } from '@halvorai/ingest/x402';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

const privateKey = process.env.DEMO_PAYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
  throw new Error('Set DEMO_PAYER_PRIVATE_KEY to a disposable Base Sepolia testnet wallet key.');
}
const base = process.env.API_BASE_URL || 'http://localhost:4021';
const target = new URL('/api/research', base).href;
// Testnet demo guard: only pay a server on this machine unless explicitly overridden.
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) && process.env.ALLOW_REMOTE_API !== '1') {
  throw new Error(`Refusing to pay non-local API_BASE_URL (${new URL(base).host}). Set ALLOW_REMOTE_API=1 to override.`);
}
const payer = privateKeyToAccount(privateKey);
const x402 = new x402Client();
x402.setSpendControls({ maxAmountPerPayment: '$0.01' });
x402.register('eip155:84532', new ExactEvmScheme(payer));

const { privateKey: signingKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const sourceKey = { ...(await exportJWK(signingKey)), kid: 'src_x402_demo_payer' };
const halvor = process.env.HALVOR_API_KEY && process.env.HALVOR_SOURCE_KEY
  ? new HalvorClient({
      apiKey: process.env.HALVOR_API_KEY,
      sourceKey: process.env.HALVOR_SOURCE_KEY,
      environment: 'test',
      onError: (e) => console.error('HalvorAI:', e.code, e.message),
    })
  : new HalvorClient({
      sourceKey, environment: 'test',
      sink: (envelopes) => console.log('HALVOR_EVENT', JSON.stringify(envelopes)),
      onError: (e) => console.error('HalvorAI:', e.code, e.message),
    });

// Print only the fields needed to diagnose a run (status, reason, tx hash); never signatures.
function decodeHeader(value) {
  if (!value) return undefined;
  try {
    const h = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const pick = { success: h.success, transaction: h.transaction, network: h.network, payer: h.payer,
      errorReason: h.errorReason, error: h.error };
    return Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined && v !== ''));
  } catch {
    return { undecodable: true };
  }
}

// Place HalvorAI *under* the x402 fetch wrapper so we observe both the original
// 402 challenge and the signed retry, including PAYMENT-RESPONSE after settlement.
const payFetch = wrapFetchWithPayment(withHalvor(fetch, halvor), x402);

try {
  await withAgentContext({
    agent: { id: 'agt_demo_research', name: 'Research demo agent' },
    owner: { id: 'own_demo_company', type: 'business', country: 'US' },
    instruction: { id: 'task_demo_001', text: 'Purchase one synthetic research API response for at most one cent' },
  }, async () => {
    const response = await payFetch(target, { method: 'GET' });
    console.log('HTTP status:', response.status);
    for (const name of ['PAYMENT-RESPONSE', 'PAYMENT-REQUIRED']) {
      const summary = decodeHeader(response.headers.get(name));
      if (summary) console.log(`${name}:`, JSON.stringify(summary));
    }
    console.log('API result:', await response.text());
    if (!response.ok) process.exitCode = 1;
  });
} finally {
  await halvor.flush({ timeoutMs: 5000 });
  console.log('HalvorAI stats:', halvor.stats());
}
