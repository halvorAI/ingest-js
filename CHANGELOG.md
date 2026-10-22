# Changelog

## 0.2.0 (unreleased)

- `init` prints a dashboard link that opens the test event (`<dashboard>/payments?event=…`), derived from the endpoint or set with `--dashboard`. It printed a fixed `https://app.halvorai.com` before.
- `init --endpoint URL` saves `HALVOR_ENDPOINT` to `.env.local`, and `HalvorClient` reads `HALVOR_ENDPOINT` when no `endpoint` is passed.
- `npx @halvorai/ingest --help` exits 0.
- `verify-pack` reports a missing chain anchor once, as "No chain anchor covers the included events".

## 0.1.0 (developer preview)

- `HalvorClient`: batched, signed (EdDSA) event delivery with retries and an optional disk spool; `emit` never throws.
- `withAgentContext`: attributes payments to an agent, owner and instruction; instruction text is hashed locally.
- Offline mode: pass `sink` to receive signed envelopes without an account.
- Adapters: Stripe and Stripe Issuing, x402, MPP, MCP payment tools; evidence helpers for AP2, Verifiable Intent and Visa TAP.
- CLI: `init` (register a source key and send a test event) and `verify-pack` (verify an evidence pack offline).
- Events follow [APE v0.1](https://github.com/halvorai/ape-schema).
