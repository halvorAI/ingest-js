# @halvorai/ingest

Signed, attributed payment events for AI agents. HalvorAI records each payment an agent makes, with the agent, the owner it acted for, the instruction it followed and the network proof that came with it. It is never in the payment path: it cannot slow or block a payment.

> **Developer preview.** The SDK works offline today: build, sign and inspect events with your own sink. Sandbox API keys go to early-access teams. [Request access](https://halvorai.com/?utm_source=github&utm_campaign=ingest_js#early-access).

- Docs: [docs.halvorai.com](https://docs.halvorai.com)
- Event format: [Agent Payment Event (APE) v0.1](https://github.com/halvorai/ape-schema), open and Apache-2.0
- Node.js 22 or later

## Install

```bash
npm install @halvorai/ingest
```

## Try it offline

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

`emit` returns at once and never throws. Instruction text is hashed on your machine and never sent.

## Send to HalvorAI (early access)

With a sandbox key (`hk_test_…`):

```bash
npx @halvorai/ingest init --api-key hk_test_…
```

`init` creates a source key pair, registers the public half, writes `HALVOR_API_KEY` and `HALVOR_SOURCE_KEY` to `.env.local`, and sends one test event. Then `new HalvorClient()` reads both from the environment.

## Rails

| Import | What it does |
| --- | --- |
| `@halvorai/ingest/stripe` | Tag PaymentIntents and Issuing cards; map webhooks to events |
| `@halvorai/ingest/x402` | Wrap the paying client or the resource server |
| `@halvorai/ingest/mpp` | Observe MPP charges and receipts |
| `@halvorai/ingest/mcp` | Attribute payments made through MCP tool calls |
| `@halvorai/ingest/evidence` | Attach AP2, Verifiable Intent and Visa TAP proofs verbatim |

Guides for each: [docs.halvorai.com](https://docs.halvorai.com).

## Verify an evidence pack

Banks can check a HalvorAI evidence pack without trusting us:

```bash
npx @halvorai/ingest verify-pack pack.zip --jwks halvorai-pack-keys.json
```

It checks the signatures, file hashes and hash chain offline.

## Develop

```bash
npm install
npm run typecheck
npm run build
npm run smoke   # packs the tarball, installs it in an empty project, emits one event, runs the CLI
```

`vendor/` holds the parts of the HalvorAI schema core the SDK uses (event model, canonical JSON, signing). They are bundled into `dist/` at build time, so the package has no internal dependencies.

## Security

Report vulnerabilities privately to hello@halvorai.com.

## License

Apache-2.0
