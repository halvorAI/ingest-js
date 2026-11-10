# HalvorAI · x402 paid API demonstration (Base Sepolia)

A small **real x402 v2 payment flow** for Sprint A: an Express API protects `GET /api/research`, an agent-shaped client pays it, and the HalvorAI SDK **observes** the HTTP challenge, payment and settlement headers. The returned research data is synthetic.

**Status:** code example. Not yet a verified end-to-end test: it requires an eligible testnet facilitator, a recipient address, a testnet payer wallet with test USDC, and a successful run. Do not claim that funds settled or that live HalvorAI ingestion works until these are tested.

## Why this is safe to demo

- Base Sepolia only (`eip155:84532`), never mainnet.
- The receiving address belongs to the operator; HalvorAI holds no funds.
- `halvorX402Express` is observe-only. It does not approve or settle payments.
- The payer has a hard-coded **$0.01 max per payment** and refuses to pay a non-local `API_BASE_URL` unless `ALLOW_REMOTE_API=1`.
- The server binds to `127.0.0.1` only, so it is not reachable from other machines.
- Offline signed envelopes include the x402 payment payload (the payer's signed transfer authorization) as evidence. That is not a private key, but treat demo output as private until the payment has settled.
- By default, the SDK writes signed envelopes to stdout using ephemeral keys. It **does not** send events to HalvorAI cloud. To test cloud ingestion, supply your own registered sandbox credentials.
- Use a *disposable* testnet payer key. Do not put production credentials in this repository, commit a `.env`, or paste secrets into chat.

## Requirements

Node.js 22+, a Base Sepolia receiving wallet, a Base Sepolia facilitator that advertises `exact` support, and a separate disposable payer wallet funded with test USDC. Verify facilitator support via its `/supported` endpoint. No keys or addresses are included in the example.

## Run locally

```bash
cd examples/x402-paid-api
cp .env.example .env
# Fill RECEIVER_ADDRESS and FACILITATOR_URL. Keep .env private.
npm ci
npm run check
npm test   # offline: free /health, unpaid 402 + PAYMENT-REQUIRED, HalvorAI event (stub facilitator)
npm start
```

From another terminal:

```bash
curl -i http://localhost:4021/health
curl -i http://localhost:4021/api/research
```

The unpaid request should return `402` plus a `PAYMENT-REQUIRED` header. With a funded **testnet-only** payer, set `DEMO_PAYER_PRIVATE_KEY` in `.env` and run:

```bash
npm run pay
```

Look for the `200` response, `PAYMENT-RESPONSE` settlement proof, a matching onchain test transaction and HalvorAI signed `HALVOR_EVENT` envelopes. If an x402 facilitator does not support the selected scheme/network, payment will not complete. This is expected, not a fake successful demo.

## If the public facilitator fails: run a local one

On 10 Nov 2026 the public `x402.org` facilitator failed three times with `invalid_exact_evm_transaction_failed`: its own signer got `replacement transaction underpriced`. For a dependable demo, run the bundled facilitator on your machine:

1. Create a **separate** disposable Base Sepolia account for the facilitator signer, and fund it with a little Base Sepolia **test ETH** from a faucet. It pays the gas for `transferWithAuthorization`.
2. In `.env`, set `FACILITATOR_SIGNER_PRIVATE_KEY` (never the payer key) and `FACILITATOR_URL=http://127.0.0.1:4022`.
3. Run `npm run facilitator` in one terminal, `npm start` in a second and `npm run pay` in a third.

The local facilitator registers only x402 v2 `exact` on `eip155:84532` and binds to `127.0.0.1`. It never holds funds: USDC moves directly from payer to receiver onchain. The resource server accepts a plain-HTTP facilitator URL only on localhost.

## Connect HalvorAI sandbox (optional)

Create and register a source signing key using the published SDK instructions; set `HALVOR_API_KEY` and `HALVOR_SOURCE_KEY` via your **local environment**. Both must be present. Confirm accepted counts in the SDK stats and events in the HalvorAI dashboard. Offline events are signed but **not** proof of server-side acceptance.

## Suggested 60-second walkthrough

1. Show the one paid endpoint and its price.
2. Curl without payment → 402 challenge.
3. Run the testnet paying client → 200 and settlement evidence.
4. Show signed events in the offline sink or sandbox dashboard (label correctly).
5. Explain the HalvorAI SDK is not in the money path, then link to `halvorai.com/build`.

## Release gates

- [ ] Confirm the facilitator supports `eip155:84532` and `exact`.
- [ ] Verify wallet and test USDC (no mainnet funds).
- [x] Install the pinned package versions (`npm ci`, lockfile committed), run `npm run check` and `npm test`.
- [ ] Exercise challenge, signed retry and successful testnet settlement.
- [ ] Inspect observed `payment.requested`, `payment.authorized`, `payment.settled` events and no sensitive material in logs.
- [ ] Test sandbox ingestion and SDK flush if demonstrating cloud-side evidence.
- [ ] Record and review the video before posting.

## Source references

- [x402 foundation v2 documentation](https://github.com/x402-foundation/x402)
- [Official Express sample](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/express)
- [HalvorAI ingestion SDK](https://github.com/halvorAI/ingest-js)
