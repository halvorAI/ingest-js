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
    console.log('API result:', await response.text());
    if (!response.ok) process.exitCode = 1;
  });
} finally {
  await halvor.flush({ timeoutMs: 5000 });
  console.log('HalvorAI stats:', halvor.stats());
}
