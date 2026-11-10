import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { generateKeyPair, exportJWK } from 'jose';
import { HalvorClient } from '@halvorai/ingest';
import { halvorX402Express } from '@halvorai/ingest/x402';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

export const NETWORK = 'eip155:84532'; // Base Sepolia ONLY. Never use a production wallet.
export const PRICE = '$0.001';

export async function makeHalvor({ sink } = {}) {
  if (!sink && process.env.HALVOR_API_KEY && process.env.HALVOR_SOURCE_KEY) {
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
  return new HalvorClient({
    sourceKey, environment: 'test', signals: true,
    sink: sink ?? ((envelopes) => console.log('HALVOR_EVENT', JSON.stringify(envelopes))),
    onError: (e) => console.error('HalvorAI:', e.code, e.message),
  });
}

/**
 * Build the demo app. `allowInsecureFacilitator` exists only so the offline smoke test can
 * point at a stub facilitator on localhost; the CLI entry point never sets it.
 */
export function createApp({ payTo, facilitatorUrl, halvor, allowInsecureFacilitator = false }) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo ?? '')) {
    throw new Error('Set RECEIVER_ADDRESS to a valid Base Sepolia receiving address.');
  }
  const scheme = allowInsecureFacilitator ? /^https?:\/\// : /^https:\/\//;
  if (!facilitatorUrl || !scheme.test(facilitatorUrl)) {
    throw new Error('Set FACILITATOR_URL to an HTTPS x402 facilitator supporting Base Sepolia exact payments.');
  }
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
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const halvor = await makeHalvor();
  if (!process.env.HALVOR_API_KEY) {
    console.log('HalvorAI offline sink active (signed envelopes are printed; not uploaded).');
  }
  const app = createApp({
    payTo: process.env.RECEIVER_ADDRESS,
    facilitatorUrl: process.env.FACILITATOR_URL,
    halvor,
  });
  const port = Number(process.env.PORT || 4021);
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`x402 testnet API on http://localhost:${port}`);
    console.log(`Try: curl -i http://localhost:${port}/api/research`);
  });
  // Flush buffered HalvorAI events before exit so the last settlement is not lost.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      server.close();
      await halvor.flush({ timeoutMs: 5000 }).catch(() => {});
      console.log('HalvorAI stats:', halvor.stats());
      process.exit(0);
    });
  }
}
