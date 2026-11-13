// VEIL Premium: the control server asks the Cumulus billing hub, with the person's CID token, whether
// they pay for veil_premium. Premium members get no ad; everyone else does; billing errors show ads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'veil-premium-'));
const HUB_PORT = 18899;
Object.assign(process.env, {
  NODE_ENV: 'development', CID_REQUIRED: '1', CID_ISSUER: `http://127.0.0.1:${HUB_PORT}/`,
  BILLING_ME_URL: `http://127.0.0.1:${HUB_PORT}/api/billing/me`,
  TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
  ADMIN_KEY: 'test-admin-key-0123456789abcdef', DB_PATH: path.join(dir, 'veil.db'), NODES_FILE: path.join(dir, 'nodes.json'),
});
writeFileSync(process.env.NODES_FILE, JSON.stringify([{ id: 'dev', city: 'Test', country: 'Here', flag: '🖥️', region: 'global',
  agentUrl: 'http://127.0.0.1:1', proxy: { scheme: 'http', host: '127.0.0.1', port: 1 } }]));

const B = 'http://127.0.0.1:18798';
const PEOPLE = { 'payer-token-0123456789abcdef': 'cid_payer', 'payer-phone-0123456789abcdef': 'cid_payer', 'free-token-0123456789abcdef0': 'cid_free', 'broke-hub-0123456789abcdef01': 'cid_broke' };
const renews = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
let paying = true;
let hub, control, db;
const j = async (p, { method = 'GET', body, token, device = 'premium-test-device-01' } = {}) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), 'x-veil-device': device, 'x-veil-platform': 'test' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  // Stand-in for both the Cumulus ID issuer and the billing hub.
  hub = http.createServer((req, res) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const cid = PEOPLE[t];
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!cid) return send(401, { error: 'Not signed in' });
    if (req.url === '/api/id/userinfo') return send(200, { cid });
    if (req.url === '/api/billing/me') {
      if (cid === 'cid_broke') return send(503, { error: 'down' });
      const products = cid === 'cid_payer' && paying ? [{ product: 'veil', plan: 'veil_premium', status: 'active', renews }] : [{ product: 'veil', plan: 'veil_premium', status: 'canceled', renews }];
      return send(200, { cid, plans: {}, features: [], creditsCents: 0, products });
    }
    send(404, {});
  });
  await new Promise((r) => hub.listen(HUB_PORT, '127.0.0.1', r));
  const c = await import('../control/server.js');
  control = await c.start(18798);
  db = c.db;
});
after(() => { control?.close(); hub?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

test('Premium members get no ad and cannot log ad views', async () => {
  const s = await j('/v1/session', { method: 'POST', body: { cid_token: 'payer-token-0123456789abcdef' } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.premium, true);
  assert.deepEqual((await j('/v1/ads?region=global', { token: s.body.token })).body, { premium: true });
  assert.equal((await j('/v1/me', { token: s.body.token })).body.premium, true);
  assert.equal((await j('/v1/ads/event', { method: 'POST', token: s.body.token, body: { ad: 'x', kind: 'view' } })).status, 409);
});

test('free members and anonymous requests still get an ad', async () => {
  const s = await j('/v1/session', { method: 'POST', device: 'premium-test-device-02', body: { cid_token: 'free-token-0123456789abcdef0' } });
  assert.equal(s.body.premium, false);
  const ad = (await j('/v1/ads?region=global', { token: s.body.token, device: 'premium-test-device-02' })).body;
  assert.ok(ad.id && !ad.premium, JSON.stringify(ad));
  assert.ok((await j('/v1/ads?region=global')).body.id);
});

test('a billing outage never blocks sign-in; it just shows ads', async () => {
  const s = await j('/v1/session', { method: 'POST', device: 'premium-test-device-03', body: { cid_token: 'broke-hub-0123456789abcdef01' } });
  assert.equal(s.status, 200);
  assert.equal(s.body.premium, false);
});

test('cancelling and signing in again turns Premium off on every device', async () => {
  paying = false;
  const phone = await j('/v1/session', { method: 'POST', device: 'premium-test-device-04', body: { cid_token: 'payer-phone-0123456789abcdef' } });
  assert.equal(phone.body.premium, false);
  const n = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE premium_until > ?").get(Date.now()).n;
  assert.equal(n, 0);
  paying = true;
});
