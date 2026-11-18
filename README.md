# @halvorai/ingest

<p>
<a href="https://github.com/halvorAI/ingest-js/actions/workflows/ci.yml"><img height="16" alt="CI" src="https://github.com/halvorAI/ingest-js/actions/workflows/ci.yml/badge.svg"></a>
<a href="https://www.npmjs.com/package/@halvorai/ingest"><img height="16" alt="npm" src="https://img.shields.io/npm/v/@halvorai/ingest?style=flat-square&label=npm&color=4A6100"></a>
<a href="https://www.npmjs.com/package/@halvorai/ingest"><img height="16" alt="Downloads" src="https://img.shields.io/npm/dm/@halvorai/ingest?style=flat-square&label=downloads&color=4A6100"></a>
<a href="https://github.com/halvorAI/ingest-js/blob/main/LICENSE"><img height="16" alt="License" src="https://img.shields.io/badge/license-Apache--2.0-4A6100?style=flat-square"></a>
<a href="https://github.com/halvorAI/ape-schema"><img height="16" alt="APE v0.1" src="https://img.shields.io/badge/APE-v0.1-C6F432?style=flat-square&labelColor=1C1C1C"></a>
</p>

Signed, attributed payment events for AI agents. Each event records which agent paid, for which owner, on which instruction, with the network proof that came with the payment.

It's for teams building agent wallets, agent cards and agentic checkout on Node.js, and for the banks behind them, who can check the evidence offline.

<p align="center"><picture><source media="(min-width: 1012px)" srcset="https://raw.githubusercontent.com/halvorAI/ape-schema/main/assets/figures/hero-wide.svg"><img src="https://raw.githubusercontent.com/halvorAI/ape-schema/main/assets/figures/hero-narrow.svg" alt="An AI agent pays a merchant over a payment rail such as Stripe, a card, x402 or MPP. HalvorAI is not on that path. Beside it, the HalvorAI SDK observes the payment read-only and records a signed event, events are assembled into a signed evidence pack, and the bank verifies the pack offline."></picture></p>

HalvorAI records and proves agent payments after the fact. It is never in the payment path and cannot slow or block a payment.

> **Developer preview.** The SDK works offline today: build, sign and inspect events with your own sink. Sandbox API keys go to early-access teams. [Request access](https://halvorai.com/?utm_source=github&utm_campaign=ingest_js#early-access).

## Try it

Sign an event and verify an evidence pack, offline. You need Node.js 22 or later; there is nothing to clone and no account:

```bash
npx @halvorai/ingest@0.4.0 demo
```

<p align="center"><img src="https://raw.githubusercontent.com/halvorAI/ingest-js/main/assets/demo.svg" width="860" alt="Output of the demo: an event is signed and its signature verified, a sample evidence pack passes every check, and the same pack fails after one byte of events.jsonl changes."></p>

It ends with the tampered pack failing:

```text
3. Change one byte of events.jsonl and verify again
   FAIL: Evidence pack verification failed with 2 issues.
   - events.jsonl sha256 does not match manifest
   - Event evt_01JA8Q4K3T9V2C7M5N6P8R0S1W canonical sha256 does not match chain.json
```

The sample pack in [`samples/`](samples/) is synthetic. Run the same check on it yourself with `npx @halvorai/ingest@0.4.0 verify-pack samples/sample-pack.zip --jwks samples/sample-pack-keys.json`.

## Install

```bash
npm install @halvorai/ingest
```

Node.js 22 or later. Node.js runtime only: not Edge or Cloudflare Workers. The offline example below also uses `jose` to make a key: `npm install @halvorai/ingest jose`.

## Record events offline

No account needed. Events are signed with your own Ed25519 key and handed to your `sink` instead of the API.

```ts
import { generateKeyPair, exportJWK } from 'jose';
import { HalvorClient, withAgentContext } from '@halvorai/ingest';

const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const sourceKey = { ...(await exportJWK(privateKey)), kid: 'src_local' };

const halvor = new HalvorClient({
  sourceKey,
  environment: 'test',
  sink: (envelopes) => console.log(JSON.stringify(envelopes, null, 2)),
});

await withAgentContext(
  {
    agent: { id: 'agt_travel_12', name: 'Travel booking agent' },
    owner: { id: 'own_u_4410', type: 'person', country: 'US' },
    instruction: { id: 'task_8890', text: 'Book a return flight to Austin under $500' },
  },
  async () => {
    halvor.emit({
      type: 'payment.settled',
      payment: {
        payment_id: 'pi_3QxAbCdEfGhIjKlM',
        rail: 'stripe',
        amount: { value: '41200', unit: 'minor', currency: 'USD' },
        status: 'settled',
        rail_ref: { payment_intent: 'pi_3QxAbCdEfGhIjKlM' },
      },
      payee: { type: 'merchant', name: 'Example Airways' },
    });
  },
);

await halvor.flush();
```

It prints one signed envelope, which opens:

```text
[
  {
    "event": {
      "ape_version": "0.1",
      "id": "evt_…",
      "type": "payment.settled",
```

`emit` returns at once and never throws. Instruction text is hashed on your machine and never sent.

## Send to HalvorAI (early access)

With a sandbox key (`hk_test_…`):

```bash
npx @halvorai/ingest init --api-key hk_test_…
```

`init` creates a source key pair, registers the public half, writes `HALVOR_API_KEY` and `HALVOR_SOURCE_KEY` (and `HALVOR_ENDPOINT` when you pass `--endpoint`) to `.env.local`, sends one test event and prints a dashboard link that opens it. Then `new HalvorClient()` reads them from the environment.

## Make sure events are sent before your code stops

`emit` queues events and sends them in the background about once a second. The client flushes on `beforeExit`, but that does not run on `process.exit()`, on SIGTERM or SIGINT, or when a serverless runtime freezes your function after the response. Open the one for where you run:

<details>
<summary><b>Serverless and request handlers</b> (Vercel, Next.js route handlers, AWS Lambda)</summary>

Flush before the response ends, with a timeout so an API outage cannot hang the request.

```ts
// Next.js 15+ route handler (Node.js runtime)
import { after } from 'next/server';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  // … your agent pays, and you call halvor.emit(…)
  after(() => halvor.flush({ timeoutMs: 5000 }));
  return Response.json({ ok: true });
}
```

On other platforms pass `halvor.flush({ timeoutMs: 5000 })` to `waitUntil`, or `await` it before returning. Without `timeoutMs`, `flush()` waits for the full retry schedule, about a minute per batch while the API is down.

</details>

<details>
<summary><b>Long-running servers and containers</b></summary>

Pass `signals: true` so the client flushes for up to 5 s on SIGTERM and SIGINT, then lets the process exit.

```ts
const halvor = new HalvorClient({ signals: true, spoolDir: '.halvor-spool' });
```

</details>

<details>
<summary><b>Outages: the disk spool</b></summary>

With `spoolDir`, events that cannot be delivered during an outage are written to disk and sent later, oldest first. The spool is capped at 50 MB and 7 days by default (`spoolMaxBytes`, `spoolMaxAgeMs`); the oldest files are evicted first and reported to `onError`. Events the API will never accept (for example a revoked source key) are kept in `<spoolDir>/dead/` and not retried.

</details>

## Rails

| Import | What it does |
| --- | --- |
| `@halvorai/ingest/stripe` | Tag PaymentIntents and Issuing cards; map webhooks to events |
| `@halvorai/ingest/x402` | Wrap the paying client or the resource server |
| `@halvorai/ingest/mpp` | Observe MPP charges and receipts |
| `@halvorai/ingest/mcp` | Attribute payments made through MCP tool calls |
| `@halvorai/ingest/evidence` | Attach AP2, Verifiable Intent and Visa TAP proofs verbatim |

For Stripe Issuing, tag one card per agent. Card events carry no agent name of their own, so pass it here:

```ts
import { tagIssuingCard } from '@halvorai/ingest/stripe';

await stripe.issuing.cards.create(
  tagIssuingCard(
    { cardholder, currency: 'usd', type: 'virtual' },
    { agentId: 'agt_travel_12', agentName: 'Travel booking agent', framework: 'langgraph' },
  ),
);
```

Guides for each: [docs.halvorai.com](https://docs.halvorai.com).

## Verify an evidence pack

Banks can check a HalvorAI evidence pack without trusting us. Pin the pack key file you were given:

```bash
npx @halvorai/ingest verify-pack pack.zip --jwks halvorai-pack-keys.json
```

```text
PASS: Evidence pack pck_… passed verification.
Manifest: Manifest signature verified
Files: 7 file hashes verified
Events: 3 of 3 event signatures verified
Chain: 3 of 3 included chain positions verified
Anchors: 1 of 1 daily anchors verified
```

It checks the manifest signature, every file hash, every event signature and the hash chain, offline, and exits 1 on any failure.

## Choose your next step

| I want to | Read |
| --- | --- |
| Send my first event to the sandbox | [Quickstart](https://docs.halvorai.com/get-started/quickstart/) |
| Record Stripe or Stripe Issuing payments | [`@halvorai/ingest/stripe`](https://docs.halvorai.com) |
| Record x402 payments | [`@halvorai/ingest/x402`](https://docs.halvorai.com) and the [paid API example](examples/x402-paid-api/) |
| Attach AP2, Verifiable Intent or Visa TAP proofs | [`@halvorai/ingest/evidence`](https://docs.halvorai.com) |
| Look up an event field | [APE v0.1 fields](https://github.com/halvorAI/ape-schema/blob/main/docs/FIELDS.md) |
| Use Python instead | [`ingest-python`](https://github.com/halvorAI/ingest-python) |

## Develop

```bash
npm install
npm run typecheck
npm test        # unit tests, including the cross-language signing vector
npm run build
npm run smoke   # packs the tarball, installs it in an empty project, emits one event, runs the CLI
```

`vendor/` holds the parts of the HalvorAI schema core the SDK uses (event model, canonical JSON, signing). They are bundled into `dist/` at build time, so the package has no internal dependencies.

## Contributing

Bug fixes, tests, offline examples and doc fixes are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the checks CI runs and how quickly we respond. Starter tasks are labeled [`good first issue`](https://github.com/halvorAI/ingest-js/labels/good%20first%20issue).

## Security

Report vulnerabilities privately to hello@halvorai.com, not in public issues. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0
