# Changelog

## 0.3.1 (unreleased)

### Fixed

- x402 `payment.requested` events use `payment_id` `x402:<network>:requested:<event id>`, as ape-schema MAPPINGS §5.1 requires (0.3.0 used a separate random UUID), so the payment id points back at the event.
- `withHalvor` links each `payment.authorized` event to the 402 challenge it answers with `related.previous_event_id`. It also reads `PAYMENT-SIGNATURE` from a `Request` object, not only from `init.headers`.
- Card numbers in `payee.website`, `payee.resource_url` and label keys are redacted before signing and rejected by validation, as the APE card-number rule requires.

### Added

- The ape-schema conformance cases (40 events, JCS number and object vectors) run in the unit tests, the same files the Python SDK runs. 223 tests.

## 0.3.0

### Breaking

- `withAgentContext` with a synchronous callback now throws the callback's error to the caller. It used to return a rejected promise, which could crash Node with an unhandled rejection. Async callbacks are unchanged.
- x402 and MPP events without a network or token address are no longer recorded with guessed values (Base Sepolia, a zero address, `USDC`, 6 decimals). The adapter reports `invalid_event` instead, and leaves out the token symbol and decimals when the payment requirement does not give them.
- A source key that is not an Ed25519 private JWK (`kty: OKP`, `crv: Ed25519`) disables the client with a `config` error when it is created, instead of failing on every event.

### Fixed

- Spool replay: a file the API rejects for good (400, 401, 403, 404, 409, 422) is moved to `<spoolDir>/dead/` and replay continues with the next file. Before, it stayed first in line and blocked every later file, and its events were counted as dropped on every replay.
- A single event that is too large (413) is dropped and reported with `serverCode: 'payload_too_large'` instead of being spooled forever.
- After a partial replay, the spool file keeps only the undelivered events, so delivered events are not sent again.
- 404, 405, 409, 410 and 415 responses are treated as permanent and are no longer retried and spooled.
- Error reports include the API's `serverCode`, `details` and `requestId`.
- x402 and MPP events keep the full agent and owner from `withAgentContext` (name, framework, country, KYC reference). Before, the adapters kept only the ids.
- Each x402 `payment.requested` event gets its own `payment_id` (`x402:<network>:requested:<uuid>`). Before, every challenge on a network shared one id.
- `HalvorClient` reads environment variables safely when `process` is missing.
- The SDK version in `source.sdk` comes from `package.json` at build time.

### Added

- `signals: true` flushes for up to 5 s on SIGTERM and SIGINT, then re-raises the signal.
- Spool limits: `spoolMaxBytes` (default 50 MB) and `spoolMaxAgeMs` (default 7 days). The oldest files are evicted first and reported. The spool now reads one file at a time with non-blocking file I/O.
- Unit tests (145) run in CI on Linux and Windows, including the cross-language signing vector shared with the Python SDK.
- README: how to flush in serverless handlers, containers and Next.js.

### Changed

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
