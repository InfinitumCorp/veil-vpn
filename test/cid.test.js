// Cumulus ID sign-in: the control server asks the issuer who a token belongs to, refuses sessions
// without one when CID_REQUIRED=1, and treats every device signed in with one CID as one account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(path.join(tmpdir(), 'veil-cid-'));
const ISSUER_PORT = 18898;
Object.assign(process.env, {
  NODE_ENV: 'development', CID_REQUIRED: '1', CID_ISSUER: `http://127.0.0.1:${ISSUER_PORT}/`,
  TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
  ADMIN_KEY: 'test-admin-key-0123456789abcdef', DB_PATH: path.join(dir, 'veil.db'), NODES_FILE: path.join(dir, 'nodes.json'),
});
writeFileSync(process.env.NODES_FILE, JSON.stringify([{ id: 'dev', city: 'Test', country: 'Here', flag: '🖥️', region: 'global',
  agentUrl: 'http://127.0.0.1:1', proxy: { scheme: 'http', host: '127.0.0.1', port: 1 } }]));

const B = 'http://127.0.0.1:18797';
// Stand-in issuer: two people, and every other token is not signed in.
const PEOPLE = { 'alice-token-0123456789abcdef': 'cid_alice', 'alice-phone-0123456789abcdef': 'cid_alice', 'bob-token-0123456789abcdef01': 'cid_bob' };
const asked = [];
let issuer, control, db;
const j = async (p, { method = 'GET', body, token, device = 'cid-test-device-0001' } = {}) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), 'x-veil-device': device, 'x-veil-platform': 'test' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  issuer = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const cid = req.url === '/api/id/userinfo' && PEOPLE[t];
    res.writeHead(cid ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cid ? { cid, username: cid.slice(4), email: `${cid.slice(4)}@cumuluscloud.app` } : { error: 'Not signed in' }));
  });
  await new Promise((r) => issuer.listen(ISSUER_PORT, '127.0.0.1', r));
  const c = await import('../control/server.js');
  control = await c.start(18797);
  db = c.db;
});
after(() => { control?.close(); issuer?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

test('the app learns where to sign in', async () => {
  const r = await j('/v1/cid');
  assert.deepEqual(r.body, { issuer: `http://127.0.0.1:${ISSUER_PORT}`, client: 'veil-vpn', required: true });
});

test('no Cumulus ID, no session', async () => {
  assert.deepEqual((await j('/v1/session', { method: 'POST' })), { status: 401, body: { error: 'sign_in_required' } });
  assert.equal((await j('/v1/session', { method: 'POST', body: { cid_token: 'nobody-0123456789abcdef0123' } })).body.error, 'sign_in_required');
  assert.equal((await j('/v1/session', { method: 'POST', body: { cid_token: 'bad token!' } })).status, 401);
  // A session made before sign-in was required (no account) is asked to sign in.
  const key = 'k'.repeat(32);
  db.prepare('INSERT INTO sessions (id, key_hash, created) VALUES (?, ?, ?)').run('old-anon-session-01', createHash('sha256').update(key).digest('hex'), '2026-11-01');
  assert.deepEqual(await j('/v1/me', { token: `old-anon-session-01.${key}` }), { status: 401, body: { error: 'sign_in_required' } });
});

test('every device signed in with one Cumulus ID shares one account', async () => {
  const laptop = await j('/v1/session', { method: 'POST', body: { cid_token: 'alice-token-0123456789abcdef' } });
  assert.equal(laptop.status, 200, JSON.stringify(laptop.body)); assert.equal(laptop.body.signedIn, true);
  assert.ok(asked.includes('GET /api/id/userinfo'));
  const wallet = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
  assert.equal((await j('/v1/wallet', { method: 'POST', token: laptop.body.token, body: { address: wallet } })).body.wallet, wallet);

  // Alice signs in on her phone: same account, so the wallet is already there.
  const phone = await j('/v1/session', { method: 'POST', device: 'cid-test-device-0002', body: { cid_token: 'alice-phone-0123456789abcdef' } });
  const me = await j('/v1/me', { token: phone.body.token, device: 'cid-test-device-0002' });
  assert.equal(me.body.wallet, wallet); assert.equal(me.body.signedIn, true);

  // Minutes earned on the laptop show on the phone; the account shares one daily limit.
  await j('/v1/connect', { method: 'POST', token: laptop.body.token, body: { server: 'dev', mode: 'proxy' } });
  assert.equal((await j('/v1/heartbeat', { method: 'POST', token: laptop.body.token, body: { active: true } })).body.credited, true);
  assert.equal((await j('/v1/me', { token: phone.body.token, device: 'cid-test-device-0002' })).body.today.minutes, 1);

  // Bob is someone else.
  const bob = await j('/v1/session', { method: 'POST', device: 'cid-test-device-0003', body: { cid_token: 'bob-token-0123456789abcdef01' } });
  const bm = await j('/v1/me', { token: bob.body.token, device: 'cid-test-device-0003' });
  assert.equal(bm.body.wallet, null); assert.equal(bm.body.today.minutes, 0);
});

test('only a keyed hash of the CID is stored', async () => {
  const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  for (const s of ['cid_alice', 'cid_bob', 'alice@', 'alice-token']) assert.ok(!dump.includes(s), s);
  assert.equal(new Set(db.prepare('SELECT account FROM sessions WHERE account IS NOT NULL').all().map((r) => r.account)).size, 2);
});

test('an unreachable issuer is reported, not treated as signed out', async () => {
  issuer.close(); await new Promise((r) => setTimeout(r, 50));
  const r = await j('/v1/session', { method: 'POST', body: { cid_token: 'alice-token-0123456789abcdef' } });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'cid_unreachable');
});
