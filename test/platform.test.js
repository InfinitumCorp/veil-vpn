// End-to-end tests: control server + VPN node in one process, real sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'veil-test-'));
Object.assign(process.env, {
  NODE_ENV: 'development', TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
  ADMIN_KEY: 'test-admin-key-0123456789abcdef', DB_PATH: path.join(dir, 'veil.db'), PORT: '18787',
  NODE_ID: 'local-dev', PROXY_PORT: '19100', AGENT_PORT: '19101', ALLOW_PRIVATE: '1', WG_DRY_RUN: '1',
  NODES_FILE: path.join(dir, 'nodes.json'), FRAUD_NET_MAX: '4', FRAUD_BLOCK_EMULATORS: '1', TOR_SOCKS: '127.0.0.1:19150', HOOK_PORT: '19102',
});
const { writeFileSync } = await import('node:fs');
// Tracker blocking: the built-in list plus a test list in hosts-file format.
process.env.BLOCKLIST = [path.join(import.meta.dirname, '..', 'node', 'blocklist.txt'), path.join(dir, 'extra.txt')].join(',');
writeFileSync(path.join(dir, 'extra.txt'), '# test list\n0.0.0.0 tracker.veil-test.example\n0.0.0.0 localhost\n');
writeFileSync(process.env.NODES_FILE, JSON.stringify([{ id: 'local-dev', city: 'Test', country: 'Here', flag: '🖥️', region: 'global',
  agentUrl: 'http://127.0.0.1:19101', proxy: { scheme: 'http', host: '127.0.0.1', port: 19100 },
  wg: { endpoint: '127.0.0.1:51820', publicKey: 'A'.repeat(43) + '=' }, tor: true,
  ikev2: { host: 'vpn.veil-test.example' }, openvpn: { host: 'vpn.veil-test.example', ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',tlsCrypt: 'TLSCRYPT' } },
  { id: 'no-tor', city: 'Plain', country: 'Here', flag: '🖥️', region: 'global', agentUrl: 'http://127.0.0.1:19101', proxy: { scheme: 'http', host: '127.0.0.1', port: 19100 } }]));

const B = 'http://127.0.0.1:18787';
let servers = [], target, targetPort, control, db, socks;
const torSeen = [];   // destinations the stand-in Tor client was asked for
const MAIN_DEVICE = 'test-device-main-0001';
const j = async (p, { method = 'GET', body, token, admin, device = MAIN_DEVICE, integrity } = {}) => {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(admin && { authorization: `Bearer ${process.env.ADMIN_KEY}` }),
    ...(device && { 'x-veil-device': device, 'x-veil-platform': 'test' }), ...(integrity && { 'x-veil-integrity': integrity }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// A minimal DNS A query for `name`.
const dnsQuery = (id, name) => Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
  ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
const proxyAuth = (pw) => 'Basic ' + Buffer.from(`veil:${pw}`).toString('base64');

// Raw CONNECT through the proxy; resolves with the status line and an open socket.
const tunnel = (pw, dest) => new Promise((resolve, reject) => {
  const s = net.connect(19100, '127.0.0.1', () => s.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n${pw ? `Proxy-Authorization: ${proxyAuth(pw)}\r\n` : ''}\r\n`));
  s.once('data', (d) => resolve({ status: d.toString().split('\r\n')[0], sock: s }));
  s.on('error', reject);
});

before(async () => {
  target = http.createServer((req, res) => res.end(`hello from target ${req.url}`));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  targetPort = target.address().port;
  // Stand-in for the node's Tor client: a SOCKS5 server that records the requested name and
  // connects every request to the test target.
  socks = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (r) => {
        const host = r.subarray(5, 5 + r[4]).toString(); torSeen.push(host);
        const up = net.connect(targetPort, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          up.pipe(c); c.pipe(up);
        });
        up.on('error', () => c.destroy()); c.on('error', () => up.destroy());
      });
    });
  });
  await new Promise((r) => socks.listen(19150, '127.0.0.1', r));
  const node = await import('../node/node.js');
  servers = await node.start();
  const c = await import('../control/server.js');
  control = await c.start(18787);
  db = c.db;
  await new Promise((r) => setTimeout(r, 300)); // first health poll
});
after(() => { for (const s of [...servers, control, target, socks]) s?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

test('economics: every tier splits exactly 100% of revenue', async () => {
  const { TIERS, split } = await import('../shared/economics.js');
  for (const t of TIERS) {
    const s = split(t[1], 1000);
    assert.equal(Object.values(s.usd).reduce((a, b) => a + b, 0), 1000, t[0]);
  }
  assert.equal(split(99_999, 100).percent.community, 50);
  assert.equal(split(100_000, 100).percent.community, 55);
  assert.equal(split(10_000_000, 100).percent.community, 65);
});

test('node blocks private destinations by default', async () => {
  const { isPrivate } = await import('../node/node.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivate(ip), ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivate(ip), ip);
});

let token, proxyPw;
test('anonymous session and server list', async () => {
  const s = await j('/v1/session', { method: 'POST' });
  assert.equal(s.status, 200); token = s.body.token;
  assert.match(token, /^[\w-]+\.[\w-]+$/);
  const list = await j('/v1/servers');
  assert.equal(list.body.servers[0].id, 'local-dev');
  assert.equal(list.body.servers[0].online, true);
  assert.equal((await j('/v1/me', { token: 'bad.token' })).status, 401);
});

test('heartbeat refuses rewards while disconnected', async () => {
  const r = await j('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_connected');
});

test('connect issues proxy credentials that the node accepts', async () => {
  const r = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.proxy.port, 19100);
  proxyPw = r.body.proxy.password;

  const ok = await tunnel(proxyPw, `127.0.0.1:${targetPort}`);
  assert.match(ok.status, /200/);
  const reply = await new Promise((res) => { ok.sock.once('data', (d) => res(d.toString())); ok.sock.write(`GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); });
  assert.match(reply, /hello from target \/tunnel/);
  ok.sock.destroy();

  const none = await tunnel(null, `127.0.0.1:${targetPort}`); assert.match(none.status, /407/); none.sock.destroy();
  const forged = await tunnel(proxyPw.slice(0, -2) + 'xx', `127.0.0.1:${targetPort}`); assert.match(forged.status, /407/); forged.sock.destroy();
  const smtp = await tunnel(proxyPw, '127.0.0.1:25'); assert.match(smtp.status, /403/); smtp.sock.destroy();
});

test('plain HTTP is forwarded too', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 19100, path: `http://127.0.0.1:${targetPort}/plain`, headers: { 'proxy-authorization': proxyAuth(proxyPw) } }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => resolve(s));
    }).on('error', reject);
  });
  assert.equal(body, 'hello from target /plain');
});

test('tunnel self-check answers only with a valid token', async () => {
  const check = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 19100, path: 'http://veil-check.invalid/', headers }, (r) => { r.resume(); resolve(r); }).on('error', reject);
  });
  const ok = await check({ 'proxy-authorization': proxyAuth(proxyPw) });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['x-veil-node'], 'local-dev');
  assert.equal((await check({})).statusCode, 407);
});

test('heartbeat credits one minute, then rate-limits', async () => {
  const a = await j('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(a.body.credited, true);
  assert.equal(a.body.today.minutes, 1);
  assert.ok(Math.abs(a.body.today.veil - 0.1) < 1e-9);
  const b = await j('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(b.body.credited, false);
  const idle = await j('/v1/heartbeat', { method: 'POST', token, body: { active: false } });
  assert.equal(idle.body.credited, false);
});

test('WireGuard connect registers a peer and returns a config', async () => {
  const pub = 'B'.repeat(43) + '=';
  const r = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'wireguard', publicKey: pub } });
  assert.equal(r.status, 200);
  assert.match(r.body.wireguard.address, /^10\.66\.\d+\.\d+\/32$/);
  assert.equal(r.body.wireguard.allowedIps, '0.0.0.0/0, ::/0');
  assert.equal((await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'wireguard', publicKey: 'nope' } })).status, 400);
});

test('IKEv2 and OpenVPN logins: listed, accepted by the node hook, bound to a tunnel IP', async () => {
  const list = (await j('/v1/servers')).body.servers;
  assert.deepEqual(list.find((x) => x.id === 'local-dev').modes, ['proxy', 'wireguard', 'ikev2', 'openvpn']);
  assert.deepEqual(list.find((x) => x.id === 'no-tor').modes, ['proxy']);
  const hook = (p, body) => fetch(`http://127.0.0.1:19102${p}`, { method: 'POST', body }).then((r) => r.status);

  const ik = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'ikev2', block: false } });
  assert.equal(ik.status, 200, JSON.stringify(ik.body));
  const { username, password, server, auth } = ik.body.ikev2;
  assert.match(username, /^v[0-9a-f]{15}$/); assert.equal(password.length, 24);
  assert.equal(server, 'vpn.veil-test.example'); assert.equal(auth, 'eap-mschapv2');
  assert.equal((await j('/v1/me', { token })).body.connection.mode, 'ikev2');
  const login = (u, p) => `${u}\n${p}\n`;
  assert.equal(await hook('/auth', login(username, password)), 204);
  assert.equal(await hook('/auth', login(username, 'x'.repeat(24))), 403);
  assert.equal(await hook('/bind', JSON.stringify({ user: username, ip: '10.67.0.9/32', up: true })), 204);
  assert.equal(await hook('/bind', JSON.stringify({ user: username, ip: '10.66.0.9', up: true })), 400);   // WireGuard range is the agent's
  assert.equal((await j('/v1/blocked', { token })).body.connected, true);

  // The same login also works for OpenVPN; a set-up for another device lasts 7 days and keeps the app's lease.
  const ov = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'openvpn', manual: true } });
  assert.equal(ov.status, 200, JSON.stringify(ov.body));
  assert.equal(ov.body.openvpn.username, username); assert.equal(ov.body.openvpn.password, password);
  assert.ok(ov.body.exp - Date.now() > 6 * 86_400_000);
  for (const line of ['client', 'remote vpn.veil-test.example 1194 udp', 'remote vpn.veil-test.example 1194 tcp', 'auth-user-pass', '<ca>', '<tls-crypt>', 'TLSCRYPT'])
    assert.ok(ov.body.openvpn.profile.split('\n').includes(line), line);
  assert.equal((await j('/v1/me', { token })).body.connection.mode, 'ikev2');
  assert.equal((await j('/v1/connect', { method: 'POST', token, body: { server: 'no-tor', mode: 'openvpn' } })).body.error, 'openvpn_unavailable');
  assert.equal((await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy', manual: true } })).status, 400);

  // Disconnecting ends the app's lease; the 7-day set-up still logs in.
  await j('/v1/disconnect', { method: 'POST', token });
  assert.equal(await hook('/auth', login(username, password)), 204);
  assert.equal(await hook('/bind', JSON.stringify({ ip: '10.67.0.9', up: false })), 204);
});

test('ad views are deduplicated and add estimated revenue', async () => {
  const ad = await j('/v1/ads?region=global');
  assert.ok(ad.body.id);
  assert.equal((await j('/v1/ads/event', { method: 'POST', token, body: { ad: ad.body.id, kind: 'view' } })).body.counted, true);
  assert.equal((await j('/v1/ads/event', { method: 'POST', token, body: { ad: ad.body.id, kind: 'view' } })).body.counted, false);
  const p = await j('/v1/pool');
  assert.ok(Math.abs(p.body.revenueUsd - 0.002) < 1e-9);
  assert.equal(p.body.members, 1);
  assert.equal(p.body.tier, 'Launch');
});

test('epoch close pays the community pool by minutes, then claim queues it', async () => {
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const sid = token.split('.')[0];
  db.prepare('INSERT INTO usage (sid, day, minutes) VALUES (?, ?, ?)').run(sid, y, 30);
  db.prepare('INSERT INTO usage (sid, day, minutes) VALUES (?, ?, ?)').run('other-member-a', y, 90);
  assert.equal((await j('/admin/revenue', { method: 'POST', admin: true, body: { day: y, usd: 100 } })).status, 200);
  assert.equal((await j('/admin/epoch/close', { method: 'POST', body: { day: y } })).status, 401);

  const c = await j('/admin/epoch/close', { method: 'POST', admin: true, body: { day: y } });
  assert.equal(c.status, 200);
  assert.equal(c.body.poolUsd, 50);           // 50% of $100 at the Launch tier
  assert.equal(c.body.paidMembers, 2);
  const rows = db.prepare('SELECT sid, pool_usd, pool_veil, base_veil FROM payouts WHERE day = ? ORDER BY minutes').all(y);
  assert.equal(rows[0].pool_usd, 12.5);       // 30 of 120 minutes
  assert.equal(rows[1].pool_usd, 37.5);       // 90 of 120 minutes
  assert.ok(Math.abs(rows[0].pool_veil - 1250) < 1e-6); // $12.50 at the $0.01 reference price, 1.0x boost
  assert.ok(Math.abs(rows[0].base_veil - 3) < 1e-9);    // 30 min x 0.1
  assert.equal((await j('/admin/epoch/close', { method: 'POST', admin: true, body: { day: y } })).status, 409);

  assert.equal((await j('/v1/claim', { method: 'POST', token })).body.error, 'no_wallet');
  assert.equal((await j('/v1/wallet', { method: 'POST', token, body: { address: '0xnotsolana' } })).status, 400);
  const wallet = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
  assert.equal((await j('/v1/wallet', { method: 'POST', token, body: { address: wallet } })).body.wallet, wallet);
  const cl = await j('/v1/claim', { method: 'POST', token });
  assert.equal(cl.body.queued, 1);
  const q = await j('/admin/settlement-queue', { admin: true });
  assert.equal(q.body.queue[0].wallet, wallet);
  assert.ok(Math.abs(q.body.queue[0].veil - 1253) < 1e-6);
});

test('ad revenue view: network totals, my ads, my share and payout history', async () => {
  assert.equal((await j('/v1/revenue')).status, 401);
  const r = await j('/v1/revenue', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.today.views, 1);
  assert.equal(r.body.mine.views, 1);                         // the one view counted earlier
  assert.ok(Math.abs(r.body.mine.usd - 0.002) < 1e-9);        // $2 CPM
  assert.equal(r.body.mine.weight, 1);                        // only member with minutes today
  assert.ok(Math.abs(r.body.mine.shareUsd - r.body.today.poolUsd) < 1e-9);
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const h = r.body.history.find((x) => x.day === y);
  assert.equal(h.poolUsd, 50);
  assert.equal(h.myUsd, 12.5);
  assert.equal(h.minutes, 30);
  assert.equal(h.status, 'queued');
});

// ---------- fraud protection ----------
const newSession = async (device, integrity) => (await j('/v1/session', { method: 'POST', device, integrity })).body.token;
const beat = async (t, device) => {
  await j('/v1/connect', { method: 'POST', token: t, device, body: { server: 'local-dev', mode: 'proxy' } });
  return (await j('/v1/heartbeat', { method: 'POST', token: t, device, body: { active: true } })).body;
};

test('fraud: a token used from a second device is flagged and stops earning', async () => {
  const t = await newSession('test-device-copy-aaaa');
  await j('/v1/me', { token: t, device: 'test-device-copy-bbbb' });
  const b = await beat(t, 'test-device-copy-aaaa');
  assert.equal(b.credited, false); assert.equal(b.reason, 'under_review');
  assert.equal((await j('/v1/me', { token: t, device: 'test-device-copy-aaaa' })).body.hold, 'under_review');
});

test('fraud: a second session on the same device cannot earn the same day', async () => {
  const t = await newSession(MAIN_DEVICE);           // the main session already earned today
  const b = await beat(t, MAIN_DEVICE);
  assert.equal(b.credited, false); assert.equal(b.reason, 'device_limit');
});

test('fraud: no device ID, or an emulator, does not earn', async () => {
  const none = await newSession(null);
  assert.equal((await beat(none, null)).reason, 'device_unverified');
  const emu = await newSession('test-device-emu-cccc', 'emulator');
  assert.equal((await beat(emu, 'test-device-emu-cccc')).reason, 'under_review');
});

const farm = [];
test('fraud: at most FRAUD_NET_MAX sessions earn per network per day', async () => {
  // The main session already counts for this network; three more fill the limit of 4.
  for (let i = 1; i <= 3; i++) {
    const d = `test-device-farm-000${i}`; const t = await newSession(d); farm.push({ t, d });
    assert.equal((await beat(t, d)).credited, true, d);
  }
  const d = 'test-device-farm-0004'; const t = await newSession(d);
  const b = await beat(t, d);
  assert.equal(b.credited, false); assert.equal(b.reason, 'network_limit');
});

test('fraud: one wallet can be linked to at most FRAUD_WALLET_MAX sessions', async () => {
  const wallet = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';   // already linked to the main session
  for (const f of farm.slice(0, 2)) assert.equal((await j('/v1/wallet', { method: 'POST', token: f.t, device: f.d, body: { address: wallet } })).status, 200);
  const r = await j('/v1/wallet', { method: 'POST', token: farm[2].t, device: farm[2].d, body: { address: wallet } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'wallet_in_use');
});

test('fraud: ad clicks need a view and count only up to the daily limit', async () => {
  const f = farm[2];
  const ad = (await j('/v1/ads?region=global')).body.id;
  const click = await j('/v1/ads/event', { method: 'POST', token: f.t, device: f.d, body: { ad, kind: 'click' } });
  assert.equal(click.body.counted, false); assert.equal(click.body.reason, 'ad_limit');
  assert.equal((await j('/v1/ads/event', { method: 'POST', token: f.t, device: f.d, body: { ad, kind: 'view' } })).body.counted, true);
  assert.equal((await j('/v1/ads/event', { method: 'POST', token: f.t, device: f.d, body: { ad, kind: 'click' } })).body.counted, true);
});

test('fraud: epoch caps minutes per device and holds flagged sessions for review', async () => {
  const d2 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const sid = (t) => t.split('.')[0];
  const main = sid(token);
  const twin = sid(await newSession(MAIN_DEVICE));       // same device as main: shares one daily cap
  const copied = db.prepare(`SELECT id FROM sessions WHERE flags LIKE '%shared_token%'`).get().id;
  for (const [s, m] of [[main, 200], [twin, 200], [copied, 60]]) db.prepare('INSERT INTO usage (sid, day, minutes) VALUES (?, ?, ?)').run(s, d2, m);
  await j('/admin/revenue', { method: 'POST', admin: true, body: { day: d2, usd: 100 } });
  const c = await j('/admin/epoch/close', { method: 'POST', admin: true, body: { day: d2 } });
  assert.equal(c.status, 200);
  assert.equal(c.body.heldMembers, 1);
  assert.equal(c.body.cappedMinutes, 160);              // 400 device minutes capped to 240
  const row = (s) => db.prepare('SELECT minutes, status FROM payouts WHERE sid = ? AND day = ?').get(s, d2);
  assert.equal(row(main).minutes, 120); assert.equal(row(twin).minutes, 120);
  assert.equal(row(copied).status, 'held');

  assert.equal((await j('/admin/fraud')).status, 401);
  const list = await j('/admin/fraud', { admin: true });
  const item = list.body.flagged.find((x) => x.id === copied);
  assert.match(item.flags, /shared_token/); assert.ok(item.heldVeil > 0);
  assert.equal((await j('/admin/fraud/release', { method: 'POST', admin: true, body: { sid: copied } })).body.released, 1);
  assert.equal(row(copied).status, 'accrued');
  assert.equal((await j('/admin/fraud/ban', { method: 'POST', admin: true, body: { sid: twin } })).body.voided, 1);
  assert.equal(row(twin).status, 'void');
});

test('fraud: the database holds no IP addresses or raw device IDs', () => {
  const dump = JSON.stringify([...db.prepare('SELECT * FROM sessions').all(), ...db.prepare('SELECT * FROM net_day').all()]);
  assert.ok(!dump.includes('127.0.0.1') && !dump.includes(MAIN_DEVICE));
});

// ---------- Tor over VPN ----------
test('Tor over VPN: proxy traffic goes through Tor, names are not resolved by the node', async () => {
  const before = torSeen.length;
  const r = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy', tor: true } });
  assert.equal(r.status, 200); assert.equal(r.body.tor, true);
  const pw = r.body.proxy.password;
  const t = await tunnel(pw, 'veilexampleonionaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion:80');
  assert.match(t.status, /200/);
  const reply = await new Promise((res) => { t.sock.once('data', (d) => res(d.toString())); t.sock.write('GET /via-tor HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'); });
  assert.match(reply, /hello from target \/via-tor/);
  t.sock.destroy();
  assert.equal(torSeen.at(-1), 'veilexampleonionaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion');
  const plain = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 19100, path: 'http://example.com/plain-tor', headers: { 'proxy-authorization': proxyAuth(pw) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.equal(plain, 'hello from target /plain-tor');
  assert.equal(torSeen.at(-1), 'example.com');
  const probe = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: 19100, path: 'http://veil-check.invalid/', headers: { 'proxy-authorization': proxyAuth(pw) } }, (res) => { res.resume(); resolve(res); }));
  assert.equal(probe.headers['x-veil-tor'], '1');
  assert.equal(torSeen.length, before + 2);
  // A normal (non-Tor) token still goes direct.
  const direct = await tunnel(proxyPw, `127.0.0.1:${targetPort}`); assert.match(direct.status, /200/); direct.sock.destroy();
  assert.equal(torSeen.length, before + 2);
});

test('Tor over VPN: WireGuard peers are added to the Tor set; nodes without Tor refuse', async () => {
  const pub = 'C'.repeat(43) + '=';
  const r = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'wireguard', publicKey: pub, tor: true } });
  assert.equal(r.status, 200); assert.equal(r.body.tor, true);
  const list = (await j('/v1/servers')).body.servers;
  assert.equal(list.find((x) => x.id === 'local-dev').tor, true);
  assert.equal(list.find((x) => x.id === 'no-tor').tor, false);
  const no = await j('/v1/connect', { method: 'POST', token, body: { server: 'no-tor', mode: 'proxy', tor: true } });
  assert.equal(no.status, 400); assert.equal(no.body.error, 'tor_unavailable');
});

test('tracker blocking: list matching, DNS packet helpers and per-user counts', async () => {
  const { loadBlocklist, isBlocked, queryName, nxdomain, createCounter } = await import('../node/blocker.js');
  const set = loadBlocklist(process.env.BLOCKLIST.split(','));
  assert.ok(set.size > 80); assert.ok(!set.has('localhost'));
  assert.ok(isBlocked(set, 'stats.g.doubleclick.net')); assert.ok(isBlocked(set, 'TRACKER.veil-test.example.'));
  assert.ok(!isBlocked(set, 'example.com')); assert.ok(!isBlocked(set, 'notdoubleclick.net'));
  const q = dnsQuery(0xbeef, 'ads.doubleclick.net');
  assert.equal(queryName(q), 'ads.doubleclick.net');
  assert.equal(queryName(Buffer.from([1, 2, 3])), null);
  const r = nxdomain(q);
  assert.equal(r.readUInt16BE(0), 0xbeef); assert.equal(r[3] & 0x0f, 3); assert.ok(r[2] & 0x80);
  assert.equal(r.readUInt16BE(6), 0); assert.equal(queryName(r), 'ads.doubleclick.net');
  const c = createCounter(); c.add('a'); c.add('a'); c.add('b');
  assert.equal(c.get('a'), 2); assert.equal(c.get('zz'), 0); assert.equal(c.total(), 3);
});

test('tracker blocking: the DNS filter answers NXDOMAIN for trackers and forwards the rest', async () => {
  const dgram = await import('node:dgram');
  const { startDnsFilter, loadBlocklist, createCounter } = await import('../node/blocker.js');
  const upstream = dgram.createSocket('udp4'); const asked = [];
  upstream.on('message', (m, ri) => { asked.push(m); const a = Buffer.from(m); a[2] |= 0x80; upstream.send(a, ri.port, ri.address); });
  await new Promise((r) => upstream.bind(19154, '127.0.0.1', r));
  const counter = createCounter(); let optOut = false;
  const filter = await startDnsFilter({ listen: '127.0.0.1:19153', upstream: '127.0.0.1:19154', list: () => loadBlocklist(process.env.BLOCKLIST.split(',')), counter, allows: () => optOut });
  const ask = (name) => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('message', (m) => { s.close(); resolve(m); }); s.send(dnsQuery(7, name), 19153, '127.0.0.1');
  });
  try {
    const blocked = await ask('pixel.facebook.com');
    assert.equal(blocked[3] & 0x0f, 3); assert.equal(asked.length, 0);
    assert.equal(counter.get('127.0.0.1'), 1);
    const ok = await ask('example.com');
    assert.equal(ok[3] & 0x0f, 0); assert.equal(asked.length, 1);
    optOut = true;                                   // user switched blocking off
    const passed = await ask('pixel.facebook.com');
    assert.equal(passed[3] & 0x0f, 0); assert.equal(asked.length, 2); assert.equal(counter.get('127.0.0.1'), 1);
    // DNS over TCP: blocked names are answered by the filter itself.
    optOut = false;
    const tcpReply = await new Promise((resolve, reject) => {
      const q = dnsQuery(9, 'ads.criteo.com');
      const s = net.connect(19153, '127.0.0.1', () => s.write(Buffer.concat([Buffer.from([0, q.length]), q])));
      s.once('data', (d) => { s.destroy(); resolve(d); }); s.on('error', reject);
    });
    assert.equal(tcpReply.readUInt16BE(0), tcpReply.length - 2); assert.equal(tcpReply[2 + 3] & 0x0f, 3);
    assert.equal(counter.get('127.0.0.1'), 2);
  } finally { filter.close(); upstream.close(); }
});

test('tracker blocking: the proxy refuses trackers, counts them, and respects the off switch', async () => {
  const on = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy' } });
  assert.equal(on.status, 200); assert.equal(on.body.block, true);
  const pw = on.body.proxy.password;
  assert.equal((await j('/v1/blocked', { token })).body.blocked, 0);
  const t = await tunnel(pw, 'tracker.veil-test.example:443'); assert.match(t.status, /403/); t.sock.destroy();
  const get = (p, pass) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: 19100, path: p, headers: { 'proxy-authorization': proxyAuth(pass) } }, (res) => { res.resume(); resolve(res); }).on('error', reject));
  const plain = await get('http://www.google-analytics.com/collect', pw);
  assert.equal(plain.statusCode, 403); assert.equal(plain.headers['x-veil-blocked'], 'tracker');
  const fine = await tunnel(pw, `127.0.0.1:${targetPort}`); assert.match(fine.status, /200/); fine.sock.destroy();
  const b = await j('/v1/blocked', { token });
  assert.equal(b.status, 200); assert.equal(b.body.blocked, 2); assert.equal(b.body.connected, true);

  const off = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy', block: false } });
  assert.equal(off.body.block, false);
  const through = await get('http://tracker.veil-test.example/', off.body.proxy.password);
  assert.notEqual(through.headers['x-veil-blocked'], 'tracker');
  const h = await fetch('http://127.0.0.1:19101/health', { headers: { authorization: `Bearer ${process.env.AGENT_SECRET}` } }).then((r) => r.json());
  assert.ok(h.blocklist > 80); assert.ok(h.blockedToday >= 2);
  assert.equal(h.geo, undefined);
});

test('geo routing opt-in does not change the full tunnel while the node switch is off', async () => {
  const on = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy', geo: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.geo, true);
  const payload = JSON.parse(Buffer.from(on.body.proxy.password.split('.')[0], 'base64url'));
  assert.equal(payload.geo, true);
  const pub = 'G'.repeat(43) + '=';
  const wg = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'wireguard', publicKey: pub, geo: true } });
  assert.equal(wg.body.wireguard.allowedIps, '0.0.0.0/0, ::/0');
  const plain = await j('/v1/connect', { method: 'POST', token, body: { server: 'local-dev', mode: 'proxy' } });
  const plainPayload = JSON.parse(Buffer.from(plain.body.proxy.password.split('.')[0], 'base64url'));
  assert.equal(plainPayload.geo, undefined);
  assert.equal(plain.body.geo, undefined);
  const through = await tunnel(plain.body.proxy.password, `127.0.0.1:${targetPort}`);
  assert.match(through.status, /200/);
  through.sock.destroy();
});

test('disconnect ends rewards', async () => {
  assert.equal((await j('/v1/disconnect', { method: 'POST', token })).status, 200);
  assert.equal((await j('/v1/heartbeat', { method: 'POST', token, body: { active: true } })).status, 409);
});
