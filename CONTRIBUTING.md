# Contributing to @halvorai/ingest

`@halvorai/ingest` is the TypeScript SDK for the open APE schema. It signs and sends events, works fully offline with your own `sink`, and has adapters for Stripe, x402, MPP and MCP.

## What we welcome

- **Bug fixes** with a test that fails before the fix.
- **Tests** for adapter edge cases (retries, duplicates, partial or malformed payloads).
- **Runnable examples** that work offline, with no account or API key.
- **Documentation** in the README or examples where something is unclear or wrong.

## Out of scope for now

- Anything that puts the SDK in the payment path. Adapters only observe: they must never change, delay or block a payment.
- Changes to the event format itself. Those start in [`ape-schema`](https://github.com/halvorAI/ape-schema).
- Files in `vendor/`. They are copied from the main HalvorAI codebase; if one is wrong, open an issue and a maintainer will fix it at the source.
- New runtime dependencies without an issue first.

## Set up and run the checks

Requirements: Node.js 22 or later and npm. CI runs on Ubuntu and Windows. No account or API key is needed.

```bash
git clone https://github.com/halvorAI/ingest-js.git
cd ingest-js
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

These are the commands CI runs, in the same order, on every pull request. Tests use Vitest; `npm test` runs them once.

## Your first contribution

Look for issues labeled [`good first issue`](https://github.com/halvorAI/ingest-js/labels/good%20first%20issue) or [`help wanted`](https://github.com/halvorAI/ingest-js/labels/help%20wanted).

1. **Comment on the issue** to say you're taking it, so two people don't do the same work. For anything not covered by an issue, open one first and say what you plan to change.
2. **Fork the repository** and create a branch.
3. **Keep the pull request small**: one change, with its tests or examples.
4. **Run the checks above** before you push.
5. **Open the pull request** and fill in the template. Leave the "Brain update" section empty; a maintainer fills it in.

## Tests, fixtures and docs

- Use synthetic data only: no real API keys, card numbers, customer data or wallet keys. Generate keys in the test.
- Add or update a test with every behavior change.
- Update the README when you change public behavior, and add a line to `CHANGELOG.md` under `Unreleased`.

## How we respond

The maintainers are [@hedge-waleed](https://github.com/hedge-waleed) (reviewer) and [@hedge-usama](https://github.com/hedge-usama) (backup reviewer). In business days, we aim to:

| What you open | First response |
| --- | --- |
| An issue | Acknowledged within 1 business day |
| An issue | Triaged within 2 business days: accepted, needs more information, needs design discussion, or out of scope |
| A pull request | A substantive first review within 3 business days |

We won't promise a merge date before a review and a green CI run. If we miss these times, a polite ping on the issue or pull request is welcome.

Questions are welcome as issues too. You don't need to email us or know anyone at HalvorAI to contribute.

## Security

Please don't report vulnerabilities in public issues. Email **hello@halvorai.com** with the details instead, and we'll reply privately. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the same license as this repository.
