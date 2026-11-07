import 'dotenv/config';
import express from 'express';
import { generateKeyPair, exportJWK } from 'jose';
import { HalvorClient } from '@halvorai/ingest';
import { halvorX402Express } from '@halvorai/ingest/x402';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const NETWORK = 'eip155:84532'; // Base Sepolia ONLY. Never use a production wallet.
const PRICE = '$0.001';
const payTo = process.env.RECEIVER_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!/^0x[a-fA-F0-9]{40}$/.test(payTo ?? '')) {
  throw new Error('Set RECEIVER_ADDRESS to a valid Base Sepolia receiving address.');
}
if (!facilitatorUrl || !/^https:\/\//.test(facilitatorUrl)) {
  throw new Error('Set FACILITATOR_URL to an HTTPS x402 facilitator supporting Base Sepolia exact payments.');
}

async function makeHalvor() {
  if (process.env.HALVOR_API_KEY && process.env.HALVOR_SOURCE_KEY) {
    return new HalvorClient({
      apiKey: process.env.HALVOR_API_KEY,
      sourceKey: process.env.HALVOR_SOURCE_KEY,
      environment: 'test',
      onError: (e) => console.error('HalvorAI:', e.code, e.message),
      signals: true,
    });
  }
  // Offline, signed envelopes only. No HalvorAI API account or secret required.
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const sourceKey = { ...(await exportJWK(privateKey)), kid: 'src_x402_demo' };
  console.log('HalvorAI offline sink active (signed envelopes are printed; not uploaded).');
  return new HalvorClient({
    sourceKey, environment: 'test', signals: true,
    sink: (envelopes) => console.log('HALVOR_EVENT', JSON.stringify(envelopes)),
    onError: (e) => console.error('HalvorAI:', e.code, e.message),
  });
}

const halvor = await makeHalvor();
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(NETWORK, new ExactEvmScheme());

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, network: NETWORK }));

// Observe the outer HTTP exchange BEFORE the x402 middleware handles/ends it.
// HalvorAI never authorizes, verifies or settles money.
app.use(halvorX402Express(halvor, {
  payee: { type: 'api_provider', name: 'HalvorAI sample research API' },
}));

app.use(paymentMiddleware({
  'GET /api/research': {
    accepts: [{ scheme: 'exact', price: PRICE, network: NETWORK, payTo }],
    description: 'Synthetic research API example',
    mimeType: 'application/json',
  },
}, resourceServer));

app.get('/api/research', (_req, res) => {
  res.json({
    sample: true,
    report: { category: 'developer tools', trend: 'illustrative', confidence: 'example-only' },
    source: 'synthetic data; not a live market signal',
  });
});

const port = Number(process.env.PORT || 4021);
app.listen(port, () => {
  console.log(`x402 testnet API on http://localhost:${port}`);
  console.log(`Try: curl -i http://localhost:${port}/api/research`);
});
