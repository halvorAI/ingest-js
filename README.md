# @halvorai/ingest

Signed, attributed payment events for AI agents. HalvorAI records each payment an agent makes, with the agent, the owner it acted for, the instruction it followed and the network proof that came with it. It is never in the payment path: it cannot slow or block a payment.

> **Developer preview.** The SDK works offline today: build, sign and inspect events with your own sink. Sandbox API keys go to early-access teams. [Request access](https://halvorai.com/?utm_source=github&utm_campaign=ingest_js#early-access).

- Docs: [docs.halvorai.com](https://docs.halvorai.com)
- Event format: [Agent Payment Event (APE) v0.1](https://schema.halvorai.com/ape/v0.1.json) ([source](https://github.com/halvorAI/ape-schema)), open and Apache-2.0
- Node.js 22 or later. Node.js runtime only: not Edge or Cloudflare Workers.

## Install

```bash
npm install @halvorai/ingest
```

The offline example below also uses `jose` to make a key: `npm install @halvorai/ingest jose`.

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

`init` creates a source key pair, registers the public half, writes `HALVOR_API_KEY` and `HALVOR_SOURCE_KEY` (and `HALVOR_ENDPOINT` when you pass `--endpoint`) to `.env.local`, sends one test event and prints a dashboard link that opens it. Then `new HalvorClient()` reads them from the environment.

## Make sure events are sent before your code stops

`emit` queues events and sends them in the background about once a second. The client flushes on
`beforeExit`, but that does not run on `process.exit()`, on SIGTERM or SIGINT, or when a serverless
runtime freezes your function after the response. Pick the pattern for where you run:

**Serverless and request handlers** (Vercel, Next.js route handlers, AWS Lambda): flush before the
response ends, with a timeout so an API outage cannot hang the request.

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

On other platforms pass `halvor.flush({ timeoutMs: 5000 })` to `waitUntil`, or `await` it before
returning. Without `timeoutMs`, `flush()` waits for the full retry schedule, about a minute per
batch while the API is down.

**Long-running servers and containers:** pass `signals: true` so the client flushes for up to 5 s
on SIGTERM and SIGINT, then lets the process exit.

```ts
const halvor = new HalvorClient({ signals: true, spoolDir: '.halvor-spool' });
```

**Spool:** with `spoolDir`, events that cannot be delivered during an outage are written to disk
and sent later, oldest first. The spool is capped at 50 MB and 7 days by default
(`spoolMaxBytes`, `spoolMaxAgeMs`); the oldest files are evicted first and reported to `onError`.
Events the API will never accept (for example a revoked source key) are kept in `<spoolDir>/dead/`
and not retried.

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

## Mobile apps (Flutter)

Apps built with [`halvorai_ingest_flutter`](https://github.com/halvorAI/ingest-dart) sign events on the phone, with a key that each install makes for itself. The app never holds your API key: your backend registers each install's public key and forwards its signed batches. `@halvorai/ingest/device` provides both routes:

```ts
import { deviceRoutes } from '@halvorai/ingest/device';

const halvor = deviceRoutes({
  apiKey: process.env.HALVOR_API_KEY,
  // Your own session check: the signed-in user's owner id, or null (answers 401).
  ownerId: async (request) => (await getSession(request))?.userId ?? null,
});
```

The app's `provisionUrl` goes to `halvor.register` and its `forwardUrl` to `halvor.forward`. Both take a Fetch `Request` and return a `Response`:

```ts
// Next.js (app router), app/halvor/sources/route.ts
export const POST = (request: Request) => halvor.register(request);
// Next.js (app router), app/halvor/events/route.ts
export const POST = (request: Request) => halvor.forward(request);

// Hono
app.post('/halvor/sources', (c) => halvor.register(c.req.raw));
app.post('/halvor/events', (c) => halvor.forward(c.req.raw));

// Express: pass the raw body through, never a parsed and re-serialized one.
import { forwardEnvelopes, registerDeviceSource, DeviceRequestError } from '@halvorai/ingest/device';

app.post('/halvor/events', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'sign in first' } });
  const out = await forwardEnvelopes(req.body, { expectedOwnerId: req.user.id });
  res.status(out.status).type(out.contentType).send(out.body);
});
app.post('/halvor/sources', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'sign in first' } });
  try {
    const { sourceId } = await registerDeviceSource({ publicJwk: req.body.public_jwk, name: req.body.name });
    res.json({ source_id: sourceId });
  } catch (err) {
    if (err instanceof DeviceRequestError) return res.status(err.status).json(err);
    throw err;
  }
});
```

What the routes do:

- **`register`** accepts only the public half of an Ed25519 key, refusing a key with `d`. It registers the key with `POST /v1/sources` and answers `{"source_id": "src_…"}`.
- **`forward`**:
  - Checks that every event's `owner.id` is the signed-in user and its `environment` is the key's.
  - Sends the body to `POST /v1/events` **byte for byte**, so the device's signatures stay valid.
  - Answers with HalvorAI's status and body unchanged, which the app reads its per-event results from.
- **Status codes tell the app what to do:**
  - 401 or 403 means "try later": the app keeps the batch on disk and retries.
  - 400, 413 and 422 are permanent: the app drops the batch, or splits it on 413.
  - 502 means HalvorAI couldn't be reached, and the app retries.

Set the signed-in user as `owner` in the app's agent context; events without it are refused.

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
npm test        # unit tests, including the cross-language signing vector
npm run build
npm run smoke   # packs the tarball, installs it in an empty project, emits one event, runs the CLI
```

`vendor/` holds the parts of the HalvorAI schema core the SDK uses (event model, canonical JSON, signing). They are bundled into `dist/` at build time, so the package has no internal dependencies.

## Security

Report vulnerabilities privately to hello@halvorai.com.

## License

Apache-2.0
