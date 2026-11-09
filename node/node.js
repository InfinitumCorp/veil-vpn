// VEIL</>™ node: an authenticated forward proxy for browser extensions, plus a small
// agent API the control server uses to add and remove WireGuard peers, IKEv2 / OpenVPN logins, and read load.
// IKEv2 (strongSwan) and OpenVPN call a hook server on 127.0.0.1 to check logins and to report which
// tunnel address a login got, so Tor and tracker blocking follow the user on every protocol.
// Tor over VPN: when the user's token asks for Tor, proxied connections go out through the
// node's local Tor client (SOCKS), and WireGuard peers are put in an nftables set whose traffic
// the firewall redirects into Tor (see provision.sh).
// No destination, URL or client IP is ever logged.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { verify } from '../shared/token.js';
import { loadBlocklist, isBlocked, createCounter, startDnsFilter } from './blocker.js';
import { openGeo } from './geo.js';

const env = (k, d) => process.env[k] ?? d;
const NODE_ID = env('NODE_ID', 'local-dev');
const PROXY_PORT = Number(env('PROXY_PORT', 9100));
const AGENT_PORT = Number(env('AGENT_PORT', 9101));
const AGENT_HOST = env('AGENT_HOST', '127.0.0.1');
const TOKEN_SECRET = env('TOKEN_SECRET', '');
const AGENT_SECRET = env('AGENT_SECRET', '');
const CAPACITY = Number(env('CAPACITY', 2000));            // concurrent tunnels at 100% load
const PER_TOKEN = Number(env('MAX_CONNS_PER_TOKEN', 256));
const ALLOW_PRIVATE = env('ALLOW_PRIVATE', '') === '1';   // tests only
const WG_IFACE = env('WG_IFACE', 'wg0');
const WG_DRY_RUN = env('WG_DRY_RUN', process.platform === 'linux' ? '' : '1') === '1';
const BLOCKED_PORTS = new Set([25, 465, 587]);              // no outbound mail relaying
const PROBE_HOST = 'veil-check.invalid';                    // reserved TLD, never resolves
const TOR_SOCKS = env('TOR_SOCKS', '');                     // e.g. 127.0.0.1:9050; empty = no Tor on this node
const NFT_DRY_RUN = env('NFT_DRY_RUN', WG_DRY_RUN ? '1' : '') === '1';
// Tracker blocking: on by default for every user; a user can switch it off in Settings.
const BLOCKLISTS = env('BLOCKLIST', fileURLToPath(new URL('./blocklist.txt', import.meta.url))).split(',');
const DNS_LISTEN = env('DNS_LISTEN', '');                    // e.g. 10.66.0.1:53 on a real node
const DNS_UPSTREAM = env('DNS_UPSTREAM', '127.0.0.1:5335');  // the node's private resolver (unbound)
let blocklist = loadBlocklist(BLOCKLISTS);
let geo = null;
try { geo = openGeo(); }
catch (e) { console.error(`geo: ${e.message}`); process.exit(1); }
const geoPeers = new Set();   // tunnel IPs whose user turned geo routing on; unused while geo is off
setInterval(() => {
  blocklist = loadBlocklist(BLOCKLISTS);
  if (geo) { try { geo = openGeo(); } catch (e) { console.error(`geo: ${e.message}`); } }
}, 3_600_000).unref();   // picks up list refreshes
const blockedCount = createCounter();
const unblocked = new Set();                                  // tunnel IPs of users who turned blocking off
const ACCOUNTS_FILE = env('ACCOUNTS_FILE', '');              // e.g. /var/lib/veil/accounts.json; empty = memory only
const SWAN_SECRETS = env('SWAN_SECRETS', '');                // e.g. /etc/swanctl/conf.d/veil-secrets.conf; empty = no IKEv2
const SWAN_DRY_RUN = env('SWAN_DRY_RUN', WG_DRY_RUN ? '1' : '') === '1';
const HOOK_PORT = Number(env('HOOK_PORT', 9102));            // 127.0.0.1 only: OpenVPN and strongSwan scripts
for (const [k, v] of Object.entries({ TOKEN_SECRET, AGENT_SECRET })) {
  if (v.length < 24) { console.error(`${k} must be set to at least 24 characters`); process.exit(1); }
}

// ---------- destination safety ----------
const v4 = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const inV4 = (ip, base, bits) => (v4(ip) >>> (32 - bits)) === (v4(base) >>> (32 - bits));
const PRIVATE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const isPrivate = (ip) => {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([b, n]) => inV4(ip, b, n));
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
  return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
};
async function resolveSafe(host, port) {
  if (!port || port < 1 || port > 65535 || BLOCKED_PORTS.has(port)) throw new Error('blocked_port');
  const h = host.replace(/^\[|\]$/g, '');
  const ip = net.isIP(h) ? h : (await dns.lookup(h)).address;
  if (!ALLOW_PRIVATE && isPrivate(ip)) throw new Error('blocked_destination');
  return ip;
}

// ---------- auth ----------
const active = new Map(); // token -> open tunnel count
let tunnels = 0;
function authorize(req) {
  const m = /^Basic (.+)$/.exec(req.headers['proxy-authorization'] || '');
  if (!m) return null;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  const token = rest.join(':');
  const p = user === 'veil' && verify(token, TOKEN_SECRET);
  if (!(p && p.node === NODE_ID)) return null;
  const a = { token, tor: p.tor === true, block: p.block !== false, sid: String(p.sid || '') };
  if (geo && p.geo === true) a.geo = true;
  return a;
}

// A blocked tracker gets a 403 and adds one to this user's count; the name itself is not kept.
const geoHit = (a, host) => {
  if (!a.geo || !geo) return false;
  const h = String(host).replace(/^\[|\]$/g, '');
  if (geo.blocksDomain(h)) return true;
  return net.isIP(h) && geo.blocksIp(h);
};
const blockedHost = (a, host) => {
  const h = host.replace(/^\[|\]$/g, '');
  if (!a.block || !(isBlocked(blocklist, h) || geoHit(a, h))) return false;
  blockedCount.add(`t:${a.sid}`); return true;
};
const BLOCKED_RESPONSE = 'HTTP/1.1 403 Forbidden\r\nX-Veil-Blocked: tracker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

// ---------- Tor (SOCKS5 to the local Tor client; Tor resolves names, so no DNS leaves the node) ----------
function torConnect(host, port) {
  return new Promise((resolve, reject) => {
    const at = TOR_SOCKS.lastIndexOf(':');
    const s = net.connect(Number(TOR_SOCKS.slice(at + 1)), TOR_SOCKS.slice(0, at));
    let buf = Buffer.alloc(0), step = 0;
    const done = (e) => { s.removeAllListeners('data'); clearTimeout(t); if (e) { s.destroy(); reject(e); } else resolve(s); };
    const t = setTimeout(() => done(new Error('tor_timeout')), 30_000);
    s.once('error', done);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));               // SOCKS5, no auth
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return done(new Error('tor_refused'));
        buf = buf.subarray(2); step = 1;
        const name = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
      }
      if (step === 1 && buf.length >= 5) {
        const len = buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + len + 2) return;
        if (buf[1] !== 0) return done(new Error('tor_unreachable'));
        const rest = buf.subarray(4 + len + 2);
        done();
        if (rest.length) s.unshift(rest);
      }
    });
  });
}
// Destinations for Tor: names are passed to Tor unresolved; private IP literals are refused.
function torTarget(host, port) {
  if (!TOR_SOCKS) throw new Error('tor_unavailable');
  if (!port || port < 1 || port > 65535 || BLOCKED_PORTS.has(port)) throw new Error('blocked_port');
  const h = host.replace(/^\[|\]$/g, '');
  if (!h || h.length > 255 || (net.isIP(h) && isPrivate(h) && !ALLOW_PRIVATE)) throw new Error('blocked_destination');
  return h;
}
const track = (token, sock) => {
  tunnels++; active.set(token, (active.get(token) || 0) + 1);
  sock.once('close', () => { tunnels--; const n = active.get(token) - 1; n > 0 ? active.set(token, n) : active.delete(token); });
};
const deny407 = (sock) => sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="VEIL"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');

// ---------- proxy ----------
const onConnect = async (req, client, head) => {
  client.on('error', () => {});
  const a = authorize(req);
  if (!a) return deny407(client);
  const { token } = a;
  if ((active.get(token) || 0) >= PER_TOKEN) return client.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
  const i = req.url.lastIndexOf(':');
  const host = req.url.slice(0, i), port = Number(req.url.slice(i + 1));
  if (blockedHost(a, host)) return client.end(BLOCKED_RESPONSE);
  if (a.tor) {
    let up;
    try { up = await torConnect(torTarget(host, port), port); }
    catch (e) { return client.end(`HTTP/1.1 ${/^blocked_/.test(e.message) ? '403 Forbidden' : '502 Bad Gateway'}\r\nContent-Length: 0\r\n\r\n`); }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(client); client.pipe(up);
    track(token, client);
    up.setTimeout(300_000, () => up.destroy());
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    return;
  }
  let ip;
  try { ip = await resolveSafe(host, port); } catch { return client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
  if (a.geo && geo && geo.blocksIp(ip)) { blockedCount.add(`t:${a.sid}`); return client.end(BLOCKED_RESPONSE); }
  const upstream = net.connect(port, ip, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  track(token, client);
  upstream.setTimeout(300_000, () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
};

const onRequest = async (req, res) => {
  const a = authorize(req);
  if (!a) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="VEIL"', 'content-length': 0 }); return res.end(); }
  const { token } = a;
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  if (target.protocol !== 'http:') { res.writeHead(400); return res.end(); }
  // Tunnel self-check used by clients: proves the proxy is reachable and the token works.
  if (target.hostname === PROBE_HOST) { res.writeHead(204, { 'x-veil-node': NODE_ID, 'x-veil-tor': a.tor && TOR_SOCKS ? '1' : '0', 'cache-control': 'no-store' }); return res.end(); }
  const port = Number(target.port || 80);
  if (blockedHost(a, target.hostname)) { res.writeHead(403, { 'x-veil-blocked': 'tracker', 'content-length': 0 }); return res.end(); }
  let ip, torHost;
  try { if (a.tor) torHost = torTarget(target.hostname, port); else ip = await resolveSafe(target.hostname, port); } catch { res.writeHead(403); return res.end(); }
  if (ip && a.geo && geo && geo.blocksIp(ip)) { blockedCount.add(`t:${a.sid}`); res.writeHead(403, { 'x-veil-blocked': 'tracker', 'content-length': 0 }); return res.end(); }
  const headers = { ...req.headers };
  delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const via = a.tor ? { createConnection: (o, cb) => { torConnect(torHost, port).then((sk) => cb(null, sk), cb); } } : {};
  const up = http.request({ host: ip || torHost, port, method: req.method, path: target.pathname + target.search, headers, ...via }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  track(token, req.socket);
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
};

// ---------- IKEv2 / OpenVPN logins ----------
// One login per session (made by the control server). `live` is the app's 15-minute lease, `manual`
// the 7-day set-up for another device; the login works while either is in the future.
const USER_RE = /^v[0-9a-f]{15}$/;
const PASS_RE = /^[A-Za-z0-9_-]{24}$/;
const TUN_RE = /^10\.(66|67|68|69)\.\d{1,3}\.\d{1,3}$/;
const accounts = new Map();   // user -> { pass, live, manual, tor, block }
const bound = new Map();      // tunnel IP -> user (IKEv2 / OpenVPN clients that are up now)
const validAcct = (a, now = Date.now()) => !!a && Math.max(a.live, a.manual) > now;
if (ACCOUNTS_FILE) {
  try { for (const [u, a] of Object.entries(JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')))) if (USER_RE.test(u) && validAcct(a)) accounts.set(u, a); }
  catch { /* first start */ }
}
const swanctl = (args) => new Promise((resolve) => {
  if (SWAN_DRY_RUN) { console.log('[dry-run] swanctl', args.join(' ')); return resolve(); }
  execFile('swanctl', args, { timeout: 10_000 }, () => resolve());
});
let saving = null, again = false;
// Writes the login list (so a node restart keeps it) and the strongSwan EAP secrets, then reloads them.
function persist() {
  if (saving) { again = true; return saving; }
  saving = (async () => {
    do {
      again = false;
      const atomic = (file, text) => { writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
      if (ACCOUNTS_FILE) atomic(ACCOUNTS_FILE, JSON.stringify(Object.fromEntries(accounts)));
      if (SWAN_SECRETS) {
        const lines = [...accounts].filter(([, a]) => validAcct(a)).map(([u, a]) => `  eap-${u} {\n    id = ${u}\n    secret = "${a.pass}"\n  }`);
        atomic(SWAN_SECRETS, `# Written by the VEIL node agent. Do not edit.\nsecrets {\n${lines.join('\n')}\n}\n`);
        await swanctl(['--load-creds', '--clear', '--noprompt']);
      }
    } while (again);
  })().catch((e) => console.error(`accounts: ${e.message}`)).finally(() => { saving = null; });
  return saving;
}
// On start, rewrite both files so logins that ran out (or were removed) while the agent was down stop working.
if (ACCOUNTS_FILE || SWAN_SECRETS) persist();
setInterval(() => {
  let changed = false;
  for (const [u, a] of accounts) if (!validAcct(a)) { accounts.delete(u); changed = true; }
  if (changed) persist();
}, 60_000).unref();
// Tor and blocking for a tunnel address, from its login's settings.
const applyTunnel = (ip, a) => {
  nft(a?.tor ? 'add' : 'delete', ip);
  if (a && a.block === false) unblocked.add(ip); else unblocked.delete(ip);
  if (geo) { if (a?.geo === true) geoPeers.add(ip); else geoPeers.delete(ip); }
};
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// Local hook API for the VPN daemons. Listens on 127.0.0.1 only and never sees traffic.
const hookHandler = async (req, res) => {
  const text = await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1024) req.destroy(); }); req.on('end', () => r(s)); });
  // OpenVPN auth-user-pass-verify (via-file): "username\npassword\n".
  if (req.method === 'POST' && req.url === '/auth') {
    const [user = '', pass = ''] = text.split(/\r?\n/);
    const a = accounts.get(user);
    const ok = USER_RE.test(user) && PASS_RE.test(pass) && validAcct(a) && sameText(a.pass, pass);
    res.writeHead(ok ? 204 : 403); return res.end();
  }
  // strongSwan updown / OpenVPN client-connect and client-disconnect: { user, ip, up }.
  if (req.method === 'POST' && req.url === '/bind') {
    let b = {}; try { b = JSON.parse(text); } catch { /* bad input */ }
    const ip = String(b.ip || '').replace(/\/\d+$/, '');
    if (!TUN_RE.test(ip) || ip.startsWith('10.66.')) { res.writeHead(400); return res.end(); }
    const user = String(b.user || '');
    if (b.up === true && USER_RE.test(user) && validAcct(accounts.get(user))) { bound.set(ip, user); applyTunnel(ip, accounts.get(user)); }
    else { bound.delete(ip); applyTunnel(ip, null); }
    res.writeHead(204); return res.end();
  }
  res.writeHead(404); res.end();
};

// ---------- WireGuard agent ----------
const run = (args) => new Promise((resolve, reject) => {
  if (WG_DRY_RUN) { console.log('[dry-run] wg', args.join(' ')); return resolve(''); }
  execFile('wg', args, { timeout: 5000 }, (e, out) => (e ? reject(e) : resolve(out)));
});
// Tor over VPN for WireGuard: peers in the nftables set tor_peers have their traffic redirected
// into Tor by the firewall rules from provision.sh.
const nft = (op, ip) => new Promise((resolve) => {
  const args = [op, 'element', 'inet', 'veil', 'tor_peers', `{ ${ip} }`];
  if (NFT_DRY_RUN) { console.log('[dry-run] nft', args.join(' ')); return resolve(); }
  execFile('nft', args, { timeout: 5000 }, () => resolve());     // deleting a missing element is fine
});
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const IP_RE = /^10\.66\.\d{1,3}\.\d{1,3}$/;
let peers = 0;
const agentJson = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const agentHandler = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${AGENT_SECRET}`) return agentJson(res, 401, { error: 'unauthorized' });
  const body = await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 4096) req.destroy(); }); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); });
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const health = { node: NODE_ID, tunnels, peers, logins: bound.size, tor: !!TOR_SOCKS, blocklist: blocklist.size, blockedToday: blockedCount.total(), load: ((tunnels + (peers + bound.size) * 8) / CAPACITY) * 100 };
      if (geo) health.geo = { categories: geo.categories, domains: geo.domainRules, cidrs: geo.cidrRules };
      return agentJson(res, 200, health);
    }
    if (req.method === 'POST' && req.url === '/peers') {
      if (!KEY_RE.test(body.publicKey || '') || !IP_RE.test(body.ip || '')) return agentJson(res, 400, { error: 'bad_input' });
      if (body.tor === true && !TOR_SOCKS) return agentJson(res, 400, { error: 'tor_unavailable' });
      await run(['set', WG_IFACE, 'peer', body.publicKey, 'allowed-ips', `${body.ip}/32`]);
      await nft(body.tor === true ? 'add' : 'delete', body.ip);
      if (body.block === false) unblocked.add(body.ip); else unblocked.delete(body.ip);
      if (geo) { if (body.geo === true) geoPeers.add(body.ip); else geoPeers.delete(body.ip); }
      peers++; return agentJson(res, 200, { ok: true, tor: body.tor === true });
    }
    if (req.method === 'POST' && req.url === '/peers/remove') {
      if (!KEY_RE.test(body.publicKey || '')) return agentJson(res, 400, { error: 'bad_input' });
      await run(['set', WG_IFACE, 'peer', body.publicKey, 'remove']);
      if (IP_RE.test(body.ip || '')) { await nft('delete', body.ip); unblocked.delete(body.ip); if (geo) geoPeers.delete(body.ip); }
      peers = Math.max(0, peers - 1); return agentJson(res, 200, { ok: true });
    }
    // IKEv2 / OpenVPN login for one session. Settings changes apply at once to tunnels already up.
    if (req.method === 'POST' && req.url === '/accounts') {
      if (!USER_RE.test(body.user || '') || !PASS_RE.test(body.pass || '') || typeof body.exp !== 'number') return agentJson(res, 400, { error: 'bad_input' });
      if (body.tor === true && !TOR_SOCKS) return agentJson(res, 400, { error: 'tor_unavailable' });
      const old = accounts.get(body.user) || { live: 0, manual: 0 };
      const a = { pass: body.pass, tor: body.tor === true, block: body.block !== false,
        live: body.manual === true ? old.live : body.exp, manual: body.manual === true ? Math.max(old.manual, body.exp) : old.manual };
      if (geo && body.geo === true) a.geo = true;
      accounts.set(body.user, a);
      for (const [ip, u] of bound) if (u === body.user) applyTunnel(ip, a);
      await persist();
      return agentJson(res, 200, { ok: true, tor: a.tor });
    }
    if (req.method === 'POST' && req.url === '/accounts/remove') {
      const a = accounts.get(body.user || '');
      if (a) { a.live = 0; if (!validAcct(a)) accounts.delete(body.user); await persist(); }
      return agentJson(res, 200, { ok: true });
    }
    // How many trackers this user had blocked today (tunnel IP for WireGuard, token id for browsers).
    if (req.method === 'GET' && req.url.startsWith('/blocked')) {
      const u = new URL(req.url, 'http://x');
      const ip = u.searchParams.get('ip'), sid = u.searchParams.get('sid'), acct = u.searchParams.get('acct');
      let n = (ip && IP_RE.test(ip) ? blockedCount.get(ip) : 0) + (sid ? blockedCount.get(`t:${sid}`) : 0);
      if (acct) for (const [tip, user] of bound) if (user === acct) n += blockedCount.get(tip);
      return agentJson(res, 200, { blocked: n });
    }
    agentJson(res, 404, { error: 'not_found' });
  } catch { agentJson(res, 500, { error: 'wg_failed' }); }
};

export function start() {
  const tls = env('TLS_CERT', '') && { cert: readFileSync(env('TLS_CERT')), key: readFileSync(env('TLS_KEY')) };
  const proxy = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);
  proxy.on('connect', onConnect);
  proxy.on('clientError', (e, s) => s.destroy());
  proxy.headersTimeout = 20_000; proxy.requestTimeout = 0;
  const agentServer = tls ? https.createServer(tls, agentHandler) : http.createServer(agentHandler);
  if (DNS_LISTEN) startDnsFilter({
    listen: DNS_LISTEN, upstream: DNS_UPSTREAM, list: () => blocklist, counter: blockedCount, allows: (ip) => unblocked.has(ip),
    ...(geo ? { geoMatch: (name, ip) => !!(geo && geoPeers.has(ip) && geo.blocksDomain(name)) } : {}),
  })
    .catch((e) => console.error(`dns filter: ${e.message}`));
  const hook = http.createServer(hookHandler);
  return Promise.all([
    new Promise((r) => hook.listen(HOOK_PORT, '127.0.0.1', () => r(hook))),
    new Promise((r) => proxy.listen(PROXY_PORT, () => { console.log(`node ${NODE_ID} proxy on :${PROXY_PORT} (${tls ? 'https' : 'http'})`); r(proxy); })),
    new Promise((r) => agentServer.listen(AGENT_PORT, AGENT_HOST, () => { console.log(`agent on ${AGENT_HOST}:${AGENT_PORT}${WG_DRY_RUN ? ' (wg dry-run)' : ''}`); r(agentServer); })),
  ]);
}
export { isPrivate };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
