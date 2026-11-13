// The Worker build of the control API against real Postgres (PGlite, in process) with the
// Supabase migration applied, and a stand-in VPN node agent. Run: npm test (in deploy/api).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite, types } from '@electric-sql/pglite';
import { pgAdapter, toPg } from '../src/pg.js';
import { makeWorker } from '../src/worker.js';

const AGENT_SECRET = 'test-agent-secret-0123456789abcdef';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
let pg, db, worker, agentSrv, env;
const agentCalls = [];
const DEVICE = 'worker-test-device-0001';

const call = async (path, { method = 'GET', body, token, admin, device = DEVICE, ip = '203.0.113.7' } = {}) => {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip,
    ...(token && { authorization: `Bearer ${token}` }), ...(admin && { authorization: `Bearer ${ADMIN_KEY}` }),
    ...(device && { 'x-veil-device': device, 'x-veil-platform': 'test' }) };
  const waits = [];
  const r = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: body && JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return { status: r.status, body: r.status === 204 ? null : await r.json(), headers: r.headers };
};
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

before(async () => {
  pg = await PGlite.create({ parsers: {
    [types.NUMERIC]: Number, [types.INT8]: Number, [types.DATE]: (x) => x, [types.TIMESTAMPTZ]: (x) => x, [types.TIMESTAMP]: (x) => x,
  } });
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
  const exec = (q) => async (text, params) => { const r = await q.query(text, params); return { rows: r.rows, count: r.affectedRows ?? 0 }; };
  db = pgAdapter(exec(pg), (fn) => pg.transaction((tx) => fn(exec(tx))), 'veil_vpn');

  agentSrv = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${AGENT_SECRET}`) { res.writeHead(401); return res.end('{}'); }
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      agentCalls.push(`${req.method} ${req.url} ${b}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/blocked') ? { blocked: 7 } : { ok: true, load: 12 }));
    });
  });
  await new Promise((r) => agentSrv.listen(0, '127.0.0.1', r));
  const agentUrl = `http://127.0.0.1:${agentSrv.address().port}`;
  env = {
    // These tests cover the API itself; Cumulus ID sign-in (on by default in production) has its own test below.
    NODE_ENV: 'production', CID_REQUIRED: '0', PASS_REQUIRED: '0', TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET, ADMIN_KEY, FRAUD_NET_MAX: '2',
    NODES: JSON.stringify([{ id: 'ams', city: 'Amsterdam', country: 'NL', flag: '🇳🇱', region: 'eu', agentUrl,
      proxy: { scheme: 'https', host: 'ams.example', port: 443 }, wg: { endpoint: 'ams.example:51820', publicKey: 'A'.repeat(43) + '=' }, tor: true }]),
  };
  worker = makeWorker(() => ({ db, close: async () => {} }));
});
after(async () => { agentSrv?.close(); await pg?.close(); });

test('SQL translation: placeholders and schema-qualified tables', () => {
  assert.equal(toPg('SELECT 1 FROM usage u JOIN sessions s ON s.id = u.sid WHERE u.day = ? AND s.id != ?'),
    'SELECT 1 FROM veil_vpn.usage u JOIN veil_vpn.sessions s ON s.id = u.sid WHERE u.day = $1 AND s.id != $2');
  assert.equal(toPg('INSERT INTO usage (sid) VALUES (?) ON CONFLICT (sid, day) DO UPDATE SET minutes = usage.minutes + 1'),
    'INSERT INTO veil_vpn.usage (sid) VALUES ($1) ON CONFLICT (sid, day) DO UPDATE SET minutes = usage.minutes + 1');
});

test('missing secrets: answers not_configured instead of crashing', async () => {
  const w = makeWorker(() => ({ db, close: async () => {} }));
  const r = await w.fetch(new Request('https://api.test/v1/servers'), { NODES: '[]' }, {});
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'not_configured');
});

let token, sid;
test('CORS preflight, health, session and server list', async () => {
  assert.equal((await call('/v1/me', { method: 'OPTIONS' })).status, 204);
  assert.equal((await call('/healthz')).body.ok, true);
  const s = await call('/v1/session', { method: 'POST' });
  assert.equal(s.status, 200); token = s.body.token; sid = token.split('.')[0];
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(s.headers.get('access-control-allow-origin'), '*');
  const l = await call('/v1/servers');
  assert.deepEqual(l.body.servers.map((x) => [x.id, x.online, x.load, x.tor]), [['ams', true, 12, true]]);
  assert.equal((await call('/v1/me')).status, 401);
});

test('heartbeat needs a connection; proxy connect signs a token', async () => {
  assert.equal((await call('/v1/heartbeat', { method: 'POST', token, body: { active: true } })).body.error, 'not_connected');
  const c = await call('/v1/connect', { method: 'POST', token, body: { server: 'ams', tor: true, block: false } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.mode, 'proxy'); assert.equal(c.body.tor, true); assert.equal(c.body.block, false);
  const payload = JSON.parse(Buffer.from(c.body.proxy.password.split('.')[0], 'base64url'));
  assert.equal(payload.node, 'ams'); assert.equal(payload.tor, true); assert.equal(payload.block, false);
  const me = await call('/v1/me', { token });
  assert.equal(me.body.connection.node, 'ams'); assert.equal(typeof me.body.connection.exp, 'number');
});

test('heartbeat credits one minute, then rate-limits', async () => {
  const a = await call('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(a.body.credited, true, JSON.stringify(a.body)); assert.equal(a.body.today.minutes, 1);
  const b = await call('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(b.body.credited, false); assert.equal(b.body.today.minutes, 1);
});

test('WireGuard connect registers a peer, reuses its address, and reports blocked trackers', async () => {
  const pub = 'B'.repeat(43) + '=';
  const a = await call('/v1/connect', { method: 'POST', token, body: { server: 'ams', mode: 'wireguard', publicKey: pub } });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.wireguard.address, '10.66.0.2/32');
  const b = await call('/v1/connect', { method: 'POST', token, body: { server: 'ams', mode: 'wireguard', publicKey: pub } });
  assert.equal(b.body.wireguard.address, '10.66.0.2/32');
  assert.ok(agentCalls.some((x) => x.startsWith('POST /peers') && x.includes('10.66.0.2') && x.includes('"block":true')));
  const bl = await call('/v1/blocked', { token });
  assert.deepEqual(bl.body, { blocked: 7, connected: true });
  assert.ok(agentCalls.some((x) => x.startsWith('GET /blocked?') && x.includes('ip=10.66.0.2')));
});

test('ads: views are deduplicated, clicks need a view, revenue adds up', async () => {
  const ad = (await call('/v1/ads?region=eu')).body.id;
  assert.equal((await call('/v1/ads/event', { method: 'POST', token, body: { ad, kind: 'view' } })).body.counted, true);
  assert.equal((await call('/v1/ads/event', { method: 'POST', token, body: { ad, kind: 'view' } })).body.counted, false);
  assert.equal((await call('/v1/ads/event', { method: 'POST', token, body: { ad, kind: 'click' } })).body.counted, true);
  const r = await call('/v1/revenue', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.today.views, 1); assert.equal(r.body.today.clicks, 1);
  assert.ok(Math.abs(r.body.today.revenueUsd - 0.102) < 1e-9);
  assert.equal(r.body.mine.views, 1); assert.equal(r.body.mine.minutes, 1);
});

test('wallet, epoch close, revenue history and claim', async () => {
  const w = await call('/v1/wallet', { method: 'POST', token, body: { address: '7'.repeat(44) } });
  assert.equal(w.status, 200, JSON.stringify(w.body)); assert.equal(w.body.wallet, '7'.repeat(44));
  const y = yesterday();
  await db.run('INSERT INTO usage (sid, day, minutes) VALUES (?, ?, ?)', sid, y, 30);
  await db.run('INSERT INTO sessions (id, key_hash, created) VALUES (?, ?, ?)', 'other-member-a', 'x', y);
  await db.run('INSERT INTO usage (sid, day, minutes) VALUES (?, ?, ?)', 'other-member-a', y, 90);
  assert.equal((await call('/admin/revenue', { method: 'POST', body: { day: y, usd: 100 } })).status, 401);
  const rv = await call('/admin/revenue', { method: 'POST', admin: true, body: { day: y, usd: 100 } });
  assert.equal(rv.body.revenueSource, 'reported'); assert.equal(rv.body.poolUsd, 50);
  const c = await call('/admin/epoch/close', { method: 'POST', admin: true, body: { day: y } });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.paidMembers, 2); assert.equal(c.body.poolUsd, 50);
  assert.equal((await call('/admin/epoch/close', { method: 'POST', admin: true, body: { day: y } })).body.error, 'epoch_already_closed');
  const mine = await db.get('SELECT pool_usd, base_veil FROM payouts WHERE sid = ? AND day = ?', sid, y);
  assert.equal(mine.pool_usd, 12.5); assert.equal(mine.base_veil, 3);
  const h = await call('/v1/revenue', { token });
  assert.equal(h.body.history[0].day, y); assert.equal(h.body.history[0].myUsd, 12.5); assert.equal(h.body.history[0].status, 'accrued');
  const ep = await call('/v1/epochs');
  assert.equal(ep.body.epochs[0].day, y); assert.equal(ep.body.epochs[0].pool_usd, 50);
  const pool = await call(`/v1/pool?day=${y}`);
  assert.equal(pool.body.closed, true); assert.equal(pool.body.members, 2);
  const cl = await call('/v1/claim', { method: 'POST', token });
  assert.equal(cl.body.queued, 1); assert.equal(cl.body.claimable, 0);
  const q = await call('/admin/settlement-queue', { admin: true });
  assert.deepEqual(q.body.queue, [{ wallet: '7'.repeat(44), veil: 1253, epochs: 1 }]);
});

test('fraud: copied token is flagged, stops earning, and can be banned', async () => {
  const s = (await call('/v1/session', { method: 'POST', device: 'worker-test-device-0002' })).body.token;
  await call('/v1/connect', { method: 'POST', token: s, device: 'worker-test-device-0002', body: { server: 'ams' } });
  await call('/v1/me', { token: s, device: 'worker-test-device-0003' });   // same token, other device
  const hb = await call('/v1/heartbeat', { method: 'POST', token: s, device: 'worker-test-device-0002', body: { active: true } });
  assert.equal(hb.body.credited, false); assert.equal(hb.body.reason, 'under_review');
  const f = await call('/admin/fraud', { admin: true });
  const row = f.body.flagged.find((x) => x.id === s.split('.')[0]);
  assert.equal(row.flags, 'shared_token'); assert.equal(typeof row.heldVeil, 'number');
  assert.equal((await call('/admin/fraud/ban', { method: 'POST', admin: true, body: { sid: row.id } })).status, 200);
  assert.match((await db.get('SELECT flags FROM sessions WHERE id = ?', row.id)).flags, /banned/);
});

test('fraud: a second session on the same device cannot earn the same day', async () => {
  const twin = (await call('/v1/session', { method: 'POST' })).body.token;
  await call('/v1/connect', { method: 'POST', token: twin, body: { server: 'ams' } });
  assert.equal((await call('/v1/heartbeat', { method: 'POST', token: twin, body: { active: true } })).body.reason, 'device_limit');
});

test('fraud: at most FRAUD_NET_MAX sessions earn per network per day', async () => {
  const ip = '198.51.100.20';
  const results = [];
  for (let i = 0; i < 3; i++) {
    const d = `worker-net-device-000${i}`;
    const t = (await call('/v1/session', { method: 'POST', device: d, ip: `198.51.100.${30 + i}` })).body.token;
    await call('/v1/connect', { method: 'POST', token: t, device: d, ip, body: { server: 'ams' } });
    results.push((await call('/v1/heartbeat', { method: 'POST', token: t, device: d, ip, body: { active: true } })).body);
  }
  assert.deepEqual(results.map((r) => r.credited), [true, true, false]);
  assert.equal(results[2].reason, 'network_limit');
});

test('bad input and unknown routes', async () => {
  assert.equal((await call('/v1/connect', { method: 'POST', token, body: { server: 'nope' } })).status, 404);
  assert.equal((await call('/v1/wallet', { method: 'POST', token, body: { address: 'not-a-wallet' } })).body.error, 'bad_solana_address');
  const r = await worker.fetch(new Request('https://api.test/v1/heartbeat', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{oops' }), env, {});
  assert.equal(r.status, 400);
  assert.equal((await call('/nope')).status, 404);
});

test('disconnect removes peers; the database holds no IP addresses or raw device IDs', async () => {
  assert.equal((await call('/v1/disconnect', { method: 'POST', token })).body.ok, true);
  assert.ok(agentCalls.some((x) => x.startsWith('POST /peers/remove')));
  assert.equal((await db.all('SELECT * FROM wg_peers WHERE sid = ?', sid)).length, 0);
  assert.equal((await call('/v1/heartbeat', { method: 'POST', token, body: { active: true } })).body.error, 'not_connected');
  const dump = JSON.stringify([...await db.all('SELECT * FROM sessions'), ...await db.all('SELECT * FROM net_day')]);
  for (const s of ['203.0.113', '198.51.100', DEVICE, 'worker-net-device']) assert.ok(!dump.includes(s), s);
});

test('scheduled purge deletes network tags older than 3 days', async () => {
  await db.run('INSERT INTO net_day (day, net, sid) VALUES (?, ?, ?)', '2020-01-01', 'old', 'x');
  await worker.scheduled({}, env, { waitUntil: () => {} });
  assert.equal((await db.all('SELECT * FROM net_day WHERE day = ?', '2020-01-01')).length, 0);
});

test('lists the bundled servers when NODES is not set', async () => {
  const w = makeWorker(() => ({ db, close: async () => {} }));
  const k = 'test-secret-'.padEnd(32, 'x');
  const r = await w.fetch(new Request('https://api.test/v1/servers'), { TOKEN_SECRET: k, AGENT_SECRET: k, ADMIN_KEY: k }, {});
  const { servers } = await r.json();
  const ids = servers.map((s) => s.id);
  assert.ok(ids.includes('use2-1') && ids.includes('ane1-1') && ids.includes('sae1-1'), ids.join(','));
  assert.ok(servers.every((s) => s.modes.includes('wireguard') && s.modes.includes('openvpn')));
});

test('production: sessions need no sign-in by default; with CID_REQUIRED=1 they need a Cumulus ID, and one CID is one account across devices (Postgres)', async () => {
  const people = { 'carol-laptop-0123456789abcdef': 'cid_carol', 'carol-phone-0123456789abcdef0': 'cid_carol' };
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    if (!String(url).startsWith('https://ru-id.example/api/id/')) return fetch(url, init);   // node agent
    asked.push(String(url));
    const cid = people[/^Bearer (.+)$/.exec(init.headers?.authorization || '')?.[1]];
    return new Response(JSON.stringify(cid ? { cid } : { error: 'Not signed in' }), { status: cid ? 200 : 401 });
  };
  const w = makeWorker(() => ({ db, close: async () => {} }), { fetchFn });
  const e = { ...env, CID_REQUIRED: '1', CID_ISSUER: 'https://ru-id.example' };
  const post = async (path, body, { token, device = 'worker-cid-device-1' } = {}) => {
    const r = await w.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.9', 'x-veil-device': device, ...(token && { authorization: `Bearer ${token}` }) } }), e, { waitUntil: () => {} });
    return { status: r.status, body: await r.json() };
  };
  // Production with no CID_REQUIRED set: anyone gets a session without signing in.
  const wOpen = makeWorker(() => ({ db, close: async () => {} }), { fetchFn });
  const open = await wOpen.fetch(new Request('https://api.test/v1/session', { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10', 'x-veil-device': 'worker-anon-device-1' } }), { ...env, CID_REQUIRED: undefined }, { waitUntil: () => {} });
  const ob = await open.json();
  assert.equal(open.status, 200, JSON.stringify(ob)); assert.equal(ob.signedIn, false); assert.ok(ob.token);
  assert.equal((await post('/v1/cid')).body.issuer, 'https://ru-id.example');
  assert.deepEqual(await post('/v1/session', {}), { status: 401, body: { error: 'sign_in_required' } });
  assert.equal((await post('/v1/me', undefined, { token })).body.error, 'sign_in_required');   // the earlier unsigned session
  const a = await post('/v1/session', { cid_token: 'carol-laptop-0123456789abcdef' });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.signedIn, true);
  assert.deepEqual(asked, ['https://ru-id.example/api/id/userinfo']);
  const wallet = '8'.repeat(44);
  assert.equal((await post('/v1/wallet', { address: wallet }, { token: a.body.token })).body.wallet, wallet);
  const b = await post('/v1/session', { cid_token: 'carol-phone-0123456789abcdef0' }, { device: 'worker-cid-device-2' });
  const me = await post('/v1/me', undefined, { token: b.body.token, device: 'worker-cid-device-2' });
  assert.equal(me.body.wallet, wallet); assert.equal(me.body.signedIn, true);
  const rows = await db.all('SELECT account FROM sessions WHERE account IS NOT NULL');
  assert.equal(new Set(rows.map((r) => r.account)).size, 1);
  assert.ok(!JSON.stringify(rows).includes('cid_carol'));
});

test('start-up ad pass: connect needs a pass, earned only after the ad has run, tied to its session', async () => {
  const e = { ...env, PASS_REQUIRED: undefined, PASS_AD_SECONDS: '2' };   // production default: pass required
  const w = makeWorker(() => ({ db, close: async () => {} }));
  const post = async (path, body, { token, device = 'worker-pass-device-1' } = {}) => {
    const r = await w.fetch(new Request(`https://api.test${path}`, { method: 'POST', body: JSON.stringify(body || {}),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.30', 'x-veil-device': device, ...(token && { authorization: `Bearer ${token}` }) } }), e, { waitUntil: () => {} });
    return { status: r.status, body: await r.json() };
  };
  const tok = (await post('/v1/session')).body.token;
  assert.deepEqual(await post('/v1/connect', { server: 'ams' }, { token: tok }), { status: 402, body: { error: 'pass_required' } });
  const chk = await post('/v1/pass/check', {}, { token: tok });
  assert.deepEqual(chk.body, { required: true, exp: 0 });
  const st = await post('/v1/pass/start', { region: 'eu' }, { token: tok });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.seconds, 2); assert.equal(st.body.hours, 24); assert.ok(st.body.ad.title); assert.equal(st.body.ad.regions, undefined);
  assert.equal((await post('/v1/pass/finish', { ticket: st.body.ticket }, { token: tok })).body.error, 'ad_not_finished');
  assert.equal((await post('/v1/pass/finish', { ticket: 'forged.ticket' }, { token: tok })).body.error, 'bad_ticket');
  await new Promise((r) => setTimeout(r, 1100));
  const fin = await post('/v1/pass/finish', { ticket: st.body.ticket }, { token: tok });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.ok(fin.body.exp > Date.now() + 23 * 3_600_000);
  assert.equal((await post('/v1/pass/check', { pass: fin.body.pass }, { token: tok })).body.exp, fin.body.exp);
  const c = await post('/v1/connect', { server: 'ams', pass: fin.body.pass }, { token: tok });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  // Another session cannot use this pass, nor this ticket.
  const other = (await post('/v1/session', {}, { device: 'worker-pass-device-2' })).body.token;
  assert.equal((await post('/v1/connect', { server: 'ams', pass: fin.body.pass }, { token: other, device: 'worker-pass-device-2' })).status, 402);
  assert.equal((await post('/v1/pass/finish', { ticket: st.body.ticket }, { token: other, device: 'worker-pass-device-2' })).body.error, 'bad_ticket');
});
