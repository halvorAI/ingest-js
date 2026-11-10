// Optional local x402 facilitator for the demo (Base Sepolia only).
// Use it when the public facilitator is unavailable. It verifies the payer's signed
// EIP-3009 authorization and submits transferWithAuthorization from its OWN disposable
// signer, which pays the gas in test ETH. It never holds the payer's or receiver's funds:
// the USDC moves directly from payer to receiver onchain.
import 'dotenv/config';
import express from 'express';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';

const NETWORK = 'eip155:84532';
const key = process.env.FACILITATOR_SIGNER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) {
  throw new Error('Set FACILITATOR_SIGNER_PRIVATE_KEY to a disposable Base Sepolia key funded with a little test ETH.');
}
if (key === process.env.DEMO_PAYER_PRIVATE_KEY) {
  throw new Error('Use a separate signer for the facilitator, not the payer key.');
}

const account = privateKeyToAccount(key);
const client = createWalletClient({
  account, chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || undefined),
}).extend(publicActions);
const signer = toFacilitatorEvmSigner({ ...client, address: account.address });
// Register x402 v2 exact on Base Sepolia only (no v1 or mainnet networks).
const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmScheme(signer));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));
for (const op of ['verify', 'settle']) {
  app.post(`/${op}`, async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      const result = await facilitator[op](paymentPayload, paymentRequirements);
      console.log(`facilitator ${op}:`, JSON.stringify({
        success: result.success ?? result.isValid, reason: result.errorReason ?? result.invalidReason,
        transaction: result.transaction, network: result.network,
      }));
      res.json(result);
    } catch (err) {
      console.error(`facilitator ${op} error:`, err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: `${op} failed` });
    }
  });
}

const port = Number(process.env.FACILITATOR_PORT || 4022);
app.listen(port, '127.0.0.1', () => {
  console.log(`Local x402 facilitator on http://127.0.0.1:${port} (signer ${account.address}, ${NETWORK})`);
});
