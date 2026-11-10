// Offline smoke test: no wallet, no facilitator account, no network beyond localhost.
// Proves the free route stays free and an unpaid request gets a real x402 v2 challenge
// that HalvorAI observes. It does NOT prove payment or settlement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, makeHalvor, NETWORK } from '../src/server.mjs';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
let facilitator, api, base, halvor;
const envelopes = [];

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  facilitator = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/supported') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} }));
      return;
    }
    res.writeHead(500).end('stub facilitator: verify/settle are not available offline');
  });
  const fPort = await listen(facilitator);
  halvor = await makeHalvor({ sink: (batch) => { envelopes.push(...batch); } });
  const app = createApp({ payTo: PAY_TO, facilitatorUrl: `http://127.0.0.1:${fPort}`, halvor, allowInsecureFacilitator: true });
  api = http.createServer(app);
  base = `http://127.0.0.1:${await listen(api)}`;
});

after(async () => {
  api?.close();
  facilitator?.close();
});

test('health is free', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('payment-required'), null);
  assert.deepEqual(await res.json(), { ok: true, network: NETWORK });
});

test('unpaid research call returns 402 with a valid x402 v2 PAYMENT-REQUIRED header', async () => {
  const res = await fetch(`${base}/api/research`);
  assert.equal(res.status, 402);
  const header = res.headers.get('payment-required');
  assert.ok(header, 'PAYMENT-REQUIRED header present');
  const required = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(required.x402Version, 2);
  const accept = required.accepts.find((a) => a.network === NETWORK);
  assert.ok(accept, 'Base Sepolia option offered');
  assert.equal(accept.scheme, 'exact');
  assert.equal(accept.payTo.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(accept.amount, '1000'); // $0.001 in 6-decimal USDC atomic units
});

test('HalvorAI emits a signed payment.requested event for the challenge (offline sink)', async () => {
  await halvor.flush({ timeoutMs: 5000 });
  assert.ok(envelopes.length >= 1, 'at least one envelope');
  const text = JSON.stringify(envelopes);
  assert.match(text, /payment\.requested/);
  assert.doesNotMatch(text, /PRIVATE_KEY|"d":"/, 'no private key material in envelopes');
});
