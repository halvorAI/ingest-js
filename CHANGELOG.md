# Changelog

## 0.1.0 (developer preview)

- `HalvorClient`: batched, signed (EdDSA) event delivery with retries and an optional disk spool; `emit` never throws.
- `withAgentContext`: attributes payments to an agent, owner and instruction; instruction text is hashed locally.
- Offline mode: pass `sink` to receive signed envelopes without an account.
- Adapters: Stripe and Stripe Issuing, x402, MPP, MCP payment tools; evidence helpers for AP2, Verifiable Intent and Visa TAP.
- CLI: `init` (register a source key and send a test event) and `verify-pack` (verify an evidence pack offline).
- Events follow [APE v0.1](https://github.com/halvorai/ape-schema).
