// VEIL</>™ control API, independent of the runtime and the database.
// Issues sessions tied to a Cumulus ID, hands out short-lived VPN credentials, counts rewarded minutes,
// records ad events and revenue, and closes daily community-pool epochs on an internal ledger.
// It never receives or stores the sites users visit, DNS queries, or client IP addresses.
//
// Sign-in: people sign in with Cumulus ID (id.cumuluscloud.app, or the mirror in CID_ISSUER). The app
// sends the CID access token once, to POST /v1/session; the server checks it at the issuer's
// /api/id/userinfo and stores only a keyed hash of the CID (sessions.account). Every device the
// person signs in on gets its own session token, and all of them share one earning account.
//
// Runs in two places with the same rules:
//   control/server.js            Node.js + SQLite (local development, tests, self-hosting)
//   deploy/api/src/worker.js     Cloudflare Worker + Supabase Postgres (schema veil_vpn)
//
// Database adapter `db` (async, `?` placeholders, SQL written to run on SQLite and Postgres):
//   get(sql, ...args) -> row | undefined     all(sql, ...args) -> rows
//   run(sql, ...args) -> { changes }         tx(async (db) => ...) -> result
//
// Request `req`: { method, path, query: URLSearchParams, header(name), ip }. `ip` is used only as an
// in-memory rate-limit key and for the daily-keyed network hash in fraud.js; it is never stored.
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { sign, verify } from '../shared/token.js';
import { modesOf, clientBundle, serviceBlocks, PROXY_MODES, responseKey, issues } from '../shared/proxyproto.js';
import { createFraud } from './fraud.js';
import { RATE_PER_MIN, MAX_MIN, REF_PRICE, split, memberShare } from '../shared/economics.js';

export class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const hash = (s) => createHash('sha256').update(s).digest('hex');
const num = (v) => Number(v ?? 0);

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-veil-device, x-veil-platform, x-veil-integrity',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export function createControl({ env, nodes, ads, fetchFn = fetch, log = console }) {
  const TOKEN_SECRET = env('TOKEN_SECRET', '');
  const AGENT_SECRET = env('AGENT_SECRET', '');
  const ADMIN_KEY = env('ADMIN_KEY', '');
  const CPM_USD = Number(env('CPM_USD', 2.0));   // estimated revenue per 1,000 views
  const CPC_USD = Number(env('CPC_USD', 0.10));  // estimated revenue per click
  const TOKEN_TTL = Number(env('TOKEN_TTL_MS', 15 * 60_000));
  const MANUAL_TTL = Number(env('MANUAL_TTL_MS', 7 * 86_400_000));
  const MODES = ['proxy', 'wireguard', 'ikev2', 'openvpn', ...PROXY_MODES];
  const DEV = env('NODE_ENV', 'development') !== 'production';
  // Cumulus ID. CID_ISSUER may point at a mirror (e.g. one reachable from Russia without a VPN).
  const CID_ISSUER = String(env('CID_ISSUER', 'https://id.cumuluscloud.app')).replace(/\/+$/, '');
  // Anyone may use VEIL VPN without signing in: sessions without a Cumulus ID are allowed unless
  // CID_REQUIRED=1 is set. Signing in with Cumulus ID stays optional (it ties devices to one person).
  const CID_REQUIRED = env('CID_REQUIRED', '0') === '1';
  // VEIL Premium (no ads) is sold on the Cumulus billing hub, which reports what a CID pays for.
  // Set BILLING_ME_URL to '' to turn Premium checks off.
  const BILLING_ME_URL = String(env('BILLING_ME_URL', 'https://mail.cumuluscloud.app/api/billing/me'));
  for (const [k, v] of Object.entries({ TOKEN_SECRET, AGENT_SECRET, ADMIN_KEY })) {
    if (v.length < 24) throw new Error(`${k} must be set to at least 24 characters`);
  }

  const NODES = nodes;
  for (const n of NODES) {
    const bad = issues(n);
    if (bad.length) throw new Error(`node ${n.id || '?'}: ${bad.join('; ')}`);
  }
  const ADS = ads;
  // Free access, paid for by ads: watching one curated ad at start-up unlocks 24 hours. The server times
  // the ad itself (a signed ticket at the start, a signed pass only once PASS_AD_SECONDS have gone by),
  // and /v1/connect refuses a session without a current pass. Off by default in local development.
  const PASS_REQUIRED = env('PASS_REQUIRED', DEV ? '0' : '1') === '1';
  const PASS_AD_MS = Math.max(1, Number(env('PASS_AD_SECONDS', '15'))) * 1000;
  const PASS_MS = Math.max(1, Number(env('PASS_HOURS', '24'))) * 3_600_000;
  const fraud =createFraud({ secret: TOKEN_SECRET, maxMinutes: MAX_MIN, env });

  // ---------- memory-only state (per process / per Worker isolate) ----------
  const health = new Map(NODES.map((n) => [n.id, { up: false, load: 0, checked: 0 }]));
  const buckets = new Map();  // rate limits; client IPs are only transient keys
  const hold = new Map();     // sid -> reason the last minute was not credited
  const adSeen = new Map();   // `${sid}:${ad}:${kind}` -> ms, dedupes repeated events
  let swept = Date.now();
  function sweep(now = Date.now()) {
    swept = now;
    for (const [k, b] of buckets) if (now - b.t > 3_600_000) buckets.delete(k);
    for (const [k, t] of adSeen) if (now - t > 120_000) adSeen.delete(k);
    if (hold.size > 50_000) hold.clear();
  }
  const limit = (key, max, windowMs) => {
    const now = Date.now(); const b = buckets.get(key);
    if (!b || now - b.t > windowMs) { buckets.set(key, { t: now, n: 1 }); return; }
    if (++b.n > max) fail(429, 'rate_limited');
  };

  // ---------- nodes ----------
  async function agent(node, method, path, body) {
    const r = await fetchFn(new URL(path, node.agentUrl), {
      method, headers: { authorization: `Bearer ${AGENT_SECRET}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`agent ${node.id} ${path} ${r.status}`);
    return r.json();
  }
  async function pollHealth() {
    await Promise.all(NODES.map(async (n) => {
      try {
        const h = await agent(n, 'GET', '/health');
        health.set(n.id, { up: true, load: Math.min(100, Math.round(h.load ?? 0)), checked: Date.now(), services: h.services && typeof h.services === 'object' ? h.services : null });
      } catch { health.set(n.id, { up: false, load: 0, checked: Date.now(), services: null }); }
    }));
  }
  // Workers have no background timers: refresh node health when it is older than 30 s.
  let polling = null;
  const freshHealth = () => {
    const stale = NODES.some((n) => Date.now() - health.get(n.id).checked > 30_000);
    if (stale && !polling) polling = pollHealth().finally(() => { polling = null; });
    return polling || Promise.resolve();
  };

  const publicNode = (n) => ({ id: n.id, city: n.city, country: n.country, flag: n.flag, region: n.region,
    load: health.get(n.id).load, online: health.get(n.id).up, modes: modesOf(n), tor: !!n.tor });
  const nodeById = (id) => NODES.find((n) => n.id === id) || fail(404, 'unknown_server');

  // ---------- auth ----------
  async function auth(db, req) {
    const m = /^Bearer ([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,64})$/.exec(req.header('authorization') || '');
    if (!m) fail(401, 'unauthorized');
    const s = await db.get('SELECT id, key_hash, wallet, device_hash, account, premium_until FROM sessions WHERE id = ?', m[1]);
    if (!s || s.key_hash !== hash(m[2])) fail(401, 'unauthorized');
    if (CID_REQUIRED && !s.account) fail(401, 'sign_in_required');
    await fraud.observe(db, req, s);
    return s;
  }
  // Until when this CID has VEIL Premium (ms since epoch), asked of the billing hub with the same
  // CID token. Any failure means no Premium: ads show, sign-in never fails because of billing.
  async function premiumUntil(token) {
    if (!BILLING_ME_URL) return 0;
    try {
      const r = await fetchFn(BILLING_ME_URL, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return 0;
      const b = await r.json();
      const p = (Array.isArray(b?.products) ? b.products : [])
        .find((x) => x?.product === 'veil' && x.plan === 'veil_premium' && ['active', 'trialing'].includes(x.status));
      if (!p) return 0;
      const end = Date.parse(p.renews);
      // Three days of grace past the period end, so a renewal that is a little late never shows ads.
      return (Number.isFinite(end) ? end : Date.now() + 31 * 86_400_000) + 3 * 86_400_000;
    } catch (e) {
      log.warn?.('premium check failed', e?.message);
      return 0;
    }
  }
  const isPremium = (s) => num(s?.premium_until) > Date.now();

  // The person behind a Cumulus ID token, asked of the issuer itself. Returns a keyed hash of the CID:
  // the raw CID, name and email are not stored here.
  async function cidAccount(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{20,8000}$/.test(token)) fail(401, 'sign_in_required');
    let r;
    try {
      r = await fetchFn(`${CID_ISSUER}/api/id/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch { fail(503, 'cid_unreachable'); }
    if (r.status === 401 || r.status === 403) fail(401, 'sign_in_required');
    if (!r.ok) fail(503, 'cid_unreachable');
    const p = await r.json().catch(() => ({}));
    const cid = typeof p.cid === 'string' ? p.cid : typeof p.sub === 'string' ? p.sub : '';
    if (!cid || cid.length > 200) fail(401, 'sign_in_required');
    return createHmac('sha256', TOKEN_SECRET).update(`cid|${cid}`).digest('base64url').slice(0, 32);
  }
  // SQL that selects every session of this person (all their signed-in devices), or just this one.
  const mine = (s) => (s.account ? ['sid IN (SELECT id FROM sessions WHERE account = ?)', s.account] : ['sid = ?', s.id]);

  const admin = (req) => { if ((req.header('authorization') || '') !== `Bearer ${ADMIN_KEY}`) fail(401, 'unauthorized'); };

  // ---------- domain ----------
  async function nextWgIp(db, nodeId) {
    const used = new Set((await db.all('SELECT ip FROM wg_peers WHERE node = ?', nodeId)).map((r) => String(r.ip)));
    for (let i = 2; i < 65_000; i++) { const ip = `10.66.${i >> 8}.${i & 255}`; if (!used.has(ip)) return ip; }
    fail(503, 'server_full');
  }

  // IKEv2 (EAP-MSCHAPv2) and OpenVPN logins. Derived from the session, so they stay the same across
  // reconnects and a saved profile keeps working; the node accepts them only until `exp`.
  const account = (s, n) => ({
    user: `v${hash(`acct:${s.id}`).slice(0, 15)}`,
    pass: createHmac('sha256', TOKEN_SECRET).update(`acct|${s.id}|${n.id}`).digest('base64url').slice(0, 24),
  });
  // OpenVPN client profile (OpenVPN Connect, Tunnelblick, openvpn 2.5+). UDP first, TCP as fallback.
  const ovpnProfile = (n) => {
    const o = n.openvpn;
    return ['# VEIL</>™ ' + n.city + ' · OpenVPN', 'client', 'dev tun', 'nobind', 'persist-key', 'persist-tun',
      ...(o.udp !== false ? [`remote ${o.host} ${o.udp || 1194} udp`] : []), ...(o.tcp !== false ? [`remote ${o.host} ${o.tcp || 1194} tcp`] : []),
      'resolv-retry infinite', 'remote-cert-tls server', `verify-x509-name ${o.name || o.host} name`, 'auth-user-pass', 'auth-nocache',
      'data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305', 'auth SHA256', 'tls-version-min 1.2', 'ignore-unknown-option block-outside-dns', 'block-outside-dns', 'verb 3',
      '<ca>', String(o.ca).trim(), '</ca>', ...(o.tlsCrypt ? ['<tls-crypt>', String(o.tlsCrypt).trim(), '</tls-crypt>'] : []), ''].join('\n');
  };

  const today = async (db, sid) => {
    const t = await db.get('SELECT minutes, last_beat FROM usage WHERE sid = ? AND day = ?', sid, day());
    return t ? { minutes: num(t.minutes), last_beat: num(t.last_beat) } : { minutes: 0, last_beat: 0 };
  };

  async function me(db, s) {
    const [scope, key] = mine(s);
    // Today's minutes and the payouts of every device signed in with this Cumulus ID.
    const minutes = num((await db.get(`SELECT COALESCE(SUM(minutes), 0) AS m FROM usage WHERE ${scope} AND day = ?`, key, day())).m);
    const t = { minutes: Math.min(minutes, MAX_MIN) };
    const acc = num((await db.get(`SELECT COALESCE(SUM(base_veil + pool_veil), 0) AS v FROM payouts WHERE ${scope} AND status = 'accrued'`, key)).v);
    const life = num((await db.get(`SELECT COALESCE(SUM(base_veil + pool_veil), 0) AS v FROM payouts WHERE ${scope}`, key)).v);
    const base = t.minutes * RATE_PER_MIN;
    const c = await db.get('SELECT node, mode, exp FROM conns WHERE sid = ?', s.id);
    return {
      today: { minutes: t.minutes, maxMinutes: MAX_MIN, veil: base },
      pending: base + acc, claimable: acc, lifetime: life + base, wallet: s.wallet ?? null,
      connection: c && num(c.exp) > Date.now() ? { node: c.node, mode: c.mode, exp: num(c.exp) } : null,
      hold: hold.get(s.id) || null,
      signedIn: !!s.account,
      premium: isPremium(s),
    };
  }

  async function poolStats(db, d = day()) {
    const u = await db.get('SELECT COUNT(*) AS members, COALESCE(SUM(minutes), 0) AS minutes FROM usage WHERE day = ? AND minutes > 0', d);
    const r = (await db.get('SELECT estimated_usd, reported_usd FROM revenue WHERE day = ?', d)) || { estimated_usd: 0, reported_usd: null };
    const revenue = r.reported_usd == null ? num(r.estimated_usd) : num(r.reported_usd);
    const members = num(u.members);
    const s = split(members, revenue);
    return { day: d, members, minutes: num(u.minutes), revenueUsd: revenue, revenueSource: r.reported_usd == null ? 'estimated' : 'reported', poolUsd: s.usd.community, ...s };
  }

  async function closeEpoch(db, d) {
    if (d >= day()) fail(400, 'epoch_not_finished');
    if (await db.get('SELECT 1 AS x FROM epochs WHERE day = ?', d)) fail(409, 'epoch_already_closed');
    const p = await poolStats(db, d);
    // Minutes after the per-device and per-wallet caps; flagged sessions are paid into 'held'.
    const rows = (await fraud.epochRows(db, d)).filter((r) => r.minutes > 0);
    const total = rows.reduce((a, r) => a + r.minutes, 0);
    await db.tx(async (t) => {
      for (const r of rows) {
        const m = memberShare({ poolUsd: p.poolUsd, myMinutes: r.minutes, totalMinutes: total, boost: p.boost, price: REF_PRICE });
        await t.run('INSERT INTO payouts (sid, day, minutes, base_veil, pool_usd, pool_veil, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          r.sid, d, r.minutes, r.minutes * RATE_PER_MIN, m.usd, m.veil, r.held ? 'held' : 'accrued');
      }
      await t.run(`INSERT INTO epochs (day, members, minutes, revenue_usd, tier, community_pct, pool_usd, boost, price, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, d, p.members, p.minutes, p.revenueUsd, p.tier, p.percent.community, p.poolUsd, p.boost, REF_PRICE, new Date().toISOString());
    });
    return { ...p, paidMembers: rows.length, heldMembers: rows.filter((r) => r.held).length, cappedMinutes: p.minutes - total };
  }

  // ---------- ads and the 24-hour pass ----------
  // Contextual ads: chosen by the server's region only, never by user profile.
  const pickAd = (region) => {
    const pool = ADS.filter((a) => a.regions.includes(region) || a.regions.includes('global'));
    return (pool.length ? pool : ADS)[Math.floor(Math.random() * (pool.length || ADS.length))];
  };
  const publicAd = (a) => ({ id: a.id, mark: a.mark, title: a.title, body: a.body, url: a.url, sponsor: a.sponsor });
  async function countAd(db, s, a, kind) {
    const k = `${s.id}:${a.id}:${kind}`;
    if (adSeen.has(k)) return { counted: false };
    const d = day();
    const blocked = await fraud.adBlock(db, s, kind, d);
    if (blocked) return { counted: false, reason: blocked };
    adSeen.set(k, Date.now());
    const v = kind === 'view' ? 1 : 0, c = kind === 'click' ? 1 : 0;
    const usd = kind === 'view' ? CPM_USD / 1000 : CPC_USD;
    await db.run(`INSERT INTO ad_stats (day, ad, views, clicks) VALUES (?, ?, ?, ?)
      ON CONFLICT (day, ad) DO UPDATE SET views = ad_stats.views + excluded.views, clicks = ad_stats.clicks + excluded.clicks`, d, a.id, v, c);
    await db.run(`INSERT INTO revenue (day, estimated_usd) VALUES (?, ?)
      ON CONFLICT (day) DO UPDATE SET estimated_usd = revenue.estimated_usd + excluded.estimated_usd`, d, usd);
    // Per-member count only (no ad or site detail), so members can see the revenue they helped generate.
    await db.run(`INSERT INTO member_ads (sid, day, views, clicks, usd) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sid, day) DO UPDATE SET views = member_ads.views + excluded.views, clicks = member_ads.clicks + excluded.clicks, usd = member_ads.usd + excluded.usd`,
      s.id, d, v, c, usd);
    return { counted: true };
  }
  // A pass is good only for the session it was earned on, and only until it expires.
  const validPass = (s, pass) => {
    const p = verify(typeof pass === 'string' ? pass : '', TOKEN_SECRET);
    return p && p.typ === 'pass' && p.sid === hash(s.id).slice(0, 16) ? p : null;
  };

  // ---------- routes ----------
  const routes = {
    'GET /healthz': () => ({ ok: true }),

    // { cid_token } is an optional Cumulus ID access token. Without one the session is anonymous
    // (refused only when CID_REQUIRED=1).
    'POST /v1/session': async (db, req, body) => {
      limit(`s:${req.ip}`, 10, 3_600_000);
      const cidToken = body.cid_token ?? null;
      if (cidToken == null && CID_REQUIRED) fail(401, 'sign_in_required');
      const account = cidToken == null ? null : await cidAccount(cidToken);
      const premium = account ? await premiumUntil(cidToken) : 0;
      const id = randomBytes(12).toString('base64url'); const key = randomBytes(24).toString('base64url');
      await db.run('INSERT INTO sessions (id, key_hash, created, account, premium_until) VALUES (?, ?, ?, ?, ?)', id, hash(key), day(), account, premium);
      // Signing in again after buying (or cancelling) Premium updates every device of this person.
      if (account) await db.run('UPDATE sessions SET premium_until = ? WHERE account = ?', premium, account);
      // A wallet already linked on another of this person's devices applies here too.
      const w = account && await db.get('SELECT wallet FROM sessions WHERE account = ? AND wallet IS NOT NULL LIMIT 1', account);
      if (w) await db.run('UPDATE sessions SET wallet = ? WHERE id = ?', w.wallet, id);
      await fraud.observe(db, req, { id, device_hash: null });
      return { token: `${id}.${key}`, signedIn: !!account, premium: premium > Date.now() };
    },

    // Where clients send people to sign in (the issuer, or its mirror).
    'GET /v1/cid': () => ({ issuer: CID_ISSUER, client: 'veil-vpn', required: CID_REQUIRED }),

    'GET /v1/servers': async () => { await freshHealth(); return { servers: NODES.map(publicNode) }; },

    // The start-up ad: a curated ad and a ticket that is worth a pass once the ad has run its full time.
    'POST /v1/pass/start': async (db, req, body) => {
      const s = await auth(db, req); limit(`ps:${s.id}`, 60, 3_600_000);
      const a = pickAd(String(body.region || 'global'));
      const now = Date.now();
      const ticket = sign({ typ: 'adticket', sid: hash(s.id).slice(0, 16), ad: a.id, t: now, exp: now + 30 * 60_000 }, TOKEN_SECRET);
      return { ad: publicAd(a), seconds: PASS_AD_MS / 1000, ticket, hours: PASS_MS / 3_600_000 };
    },
    'POST /v1/pass/finish': async (db, req, body) => {
      const s = await auth(db, req); limit(`pf:${s.id}`, 60, 3_600_000);
      const now = Date.now();
      const t = verify(String(body.ticket || ''), TOKEN_SECRET, now);
      if (!t || t.typ !== 'adticket' || t.sid !== hash(s.id).slice(0, 16)) fail(400, 'bad_ticket');
      if (now - t.t < PASS_AD_MS - 1000) fail(425, 'ad_not_finished');
      const a = ADS.find((x) => x.id === t.ad);
      if (a) await countAd(db, s, a, 'view').catch(() => {});
      const exp = now + PASS_MS;
      return { pass: sign({ typ: 'pass', sid: hash(s.id).slice(0, 16), exp }, TOKEN_SECRET), exp };
    },
    // Whether this session's pass (sent back by the app) is still good, and until when.
    'POST /v1/pass/check': async (db, req, body) => {
      const s = await auth(db, req);
      const p = validPass(s, body.pass);
      return { required: PASS_REQUIRED && !isPremium(s), exp: p ? p.exp : 0 };
    },

    'POST /v1/connect': async (db, req, body) => {
      const s = await auth(db, req); limit(`c:${s.id}`, 30, 600_000);
      if (PASS_REQUIRED && !isPremium(s) && !validPass(s, body.pass)) fail(402, 'pass_required');
      const n = nodeById(String(body.server || ''));
      await freshHealth();
      if (!health.get(n.id).up && !DEV) fail(503, 'server_offline');
      const mode = MODES.includes(body.mode) ? body.mode : 'proxy';
      // VLESS and Shadowsocks have one credential per node, so they cannot follow a single user into Tor.
      const tor = body.tor === true && !PROXY_MODES.includes(mode);
      if (tor && !n.tor) fail(400, 'tor_unavailable');
      // Tracker blocking is on unless the user switched it off. Xray's resolver is node-wide, so it stays on.
      const block = PROXY_MODES.includes(mode) ? true : body.block !== false;
      // "manual": a set-up for another device (a .conf / .ovpn file or IKEv2 details) that lasts 7 days
      // and earns nothing; it does not replace this device's own connection lease.
      const manual = body.manual === true;
      const exp = Date.now() + (manual ? MANUAL_TTL : TOKEN_TTL);
      if (mode !== 'proxy' && !modesOf(n).includes(mode)) fail(400, `${mode}_unavailable`);
      if (serviceBlocks(health.get(n.id).services, mode)) fail(503, 'server_offline');
      if (manual && mode === 'proxy') fail(400, 'manual_needs_vpn_protocol');
      if (!manual) await db.run(`INSERT INTO conns (sid, node, mode, exp) VALUES (?, ?, ?, ?)
        ON CONFLICT (sid) DO UPDATE SET node = excluded.node, mode = excluded.mode, exp = excluded.exp`, s.id, n.id, mode, exp);

      if (PROXY_MODES.includes(mode)) {
        return { mode, server: publicNode(n), exp, tor: false, block: true, manual, [responseKey(mode)]: clientBundle(n, mode) };
      }
      if (mode === 'ikev2' || mode === 'openvpn') {
        const acct = account(s, n);
        await agent(n, 'POST', '/accounts', { ...acct, exp, tor, block, manual, protocol: mode });
        const common = { mode, server: publicNode(n), exp, tor, block, manual };
        if (mode === 'ikev2') return { ...common, ikev2: { server: n.ikev2.host, remoteId: n.ikev2.remoteId || n.ikev2.host, username: acct.user, password: acct.pass, auth: 'eap-mschapv2', dns: n.ikev2.dns || '10.66.0.1' } };
        return { ...common, openvpn: { username: acct.user, password: acct.pass, profile: ovpnProfile(n) } };
      }
      if (mode === 'wireguard') {
        const pub = String(body.publicKey || '');
        if (!/^[A-Za-z0-9+/]{43}=$/.test(pub)) fail(400, 'bad_public_key');
        const old = await db.get('SELECT node, ip FROM wg_peers WHERE pubkey = ?', pub);
        const ip = old && old.node === n.id ? String(old.ip) : await nextWgIp(db, n.id);
        await agent(n, 'POST', '/peers', { publicKey: pub, ip, tor, block });
        await db.run(`INSERT INTO wg_peers (pubkey, sid, node, ip) VALUES (?, ?, ?, ?)
          ON CONFLICT (pubkey) DO UPDATE SET node = excluded.node, ip = excluded.ip, sid = excluded.sid`, pub, s.id, n.id, ip);
        return { mode: 'wireguard', server: publicNode(n), exp, tor, block, wireguard: {
          address: `${ip}/32`, dns: n.wg.dns || '10.66.0.1', peerPublicKey: n.wg.publicKey, endpoint: n.wg.endpoint, allowedIps: '0.0.0.0/0, ::/0', keepalive: 25 } };
      }
      const token = sign({ sid: hash(s.id).slice(0, 16), node: n.id, exp, ...(tor && { tor: true }), ...(!block && { block: false }) }, TOKEN_SECRET);
      return { mode: 'proxy', server: publicNode(n), exp, tor, block, proxy: { scheme: n.proxy.scheme, host: n.proxy.host, port: n.proxy.port, username: 'veil', password: token } };
    },

    'POST /v1/disconnect': async (db, req) => {
      const s = await auth(db, req);
      const c = await db.get('SELECT node, mode FROM conns WHERE sid = ?', s.id);
      await db.run('DELETE FROM conns WHERE sid = ?', s.id);
      // IKEv2 / OpenVPN: this device's login lease ends on that node (set-ups for other devices keep their 7 days).
      const cn = c && (c.mode === 'ikev2' || c.mode === 'openvpn') && NODES.find((x) => x.id === c.node);
      if (cn) await agent(cn, 'POST', '/accounts/remove', { user: account(s, cn).user }).catch(() => {});
      for (const p of await db.all('SELECT pubkey, node, ip FROM wg_peers WHERE sid = ?', s.id)) {
        const n = NODES.find((x) => x.id === p.node);
        if (n) await agent(n, 'POST', '/peers/remove', { publicKey: p.pubkey, ip: String(p.ip) }).catch(() => {});
        await db.run('DELETE FROM wg_peers WHERE pubkey = ?', p.pubkey);
      }
      return { ok: true };
    },

    // One rewarded minute per call, at most once every 55 s, only while a connection is live.
    'POST /v1/heartbeat': async (db, req, body) => {
      const s = await auth(db, req);
      const c = await db.get('SELECT exp FROM conns WHERE sid = ?', s.id);
      if (!c || num(c.exp) < Date.now()) fail(409, 'not_connected');
      const t = await today(db, s.id); const now = Date.now();
      let credited = false, reason = null;
      if (body.active === true && now - t.last_beat >= 55_000 && t.minutes < MAX_MIN) {
        reason = await fraud.earnBlock(db, req, s, day());
        if (!reason) {
          await db.run(`INSERT INTO usage (sid, day, minutes, last_beat) VALUES (?, ?, 1, ?)
            ON CONFLICT (sid, day) DO UPDATE SET minutes = usage.minutes + 1, last_beat = excluded.last_beat`, s.id, day(), now);
          await fraud.credited(db, req, s, day());
          credited = true;
        }
        if (reason) hold.set(s.id, reason); else hold.delete(s.id);
      }
      return { credited, reason, ...(await me(db, s)) };
    },

    'GET /v1/me': async (db, req) => me(db, await auth(db, req)),

    // Trackers blocked today on the current connection. The node keeps only a count, never the names.
    'GET /v1/blocked': async (db, req) => {
      const s = await auth(db, req);
      const c = await db.get('SELECT node, mode, exp FROM conns WHERE sid = ?', s.id);
      if (!c || num(c.exp) < Date.now()) return { blocked: 0, connected: false };
      const n = NODES.find((x) => x.id === c.node);
      if (!n) return { blocked: 0, connected: false };
      const p = new URLSearchParams({ sid: hash(s.id).slice(0, 16) });
      const wg = await db.get('SELECT ip FROM wg_peers WHERE sid = ? AND node = ?', s.id, n.id);
      if (wg) p.set('ip', String(wg.ip));
      if (c.mode === 'ikev2' || c.mode === 'openvpn') p.set('acct', account(s, n).user);
      try { const r = await agent(n, 'GET', `/blocked?${p}`); return { blocked: Number(r.blocked) || 0, connected: true }; }
      catch { return { blocked: 0, connected: true }; }
    },

    'POST /v1/wallet': async (db, req, body) => {
      const s = await auth(db, req);
      const w = body.address == null ? null : String(body.address);
      if (w !== null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) fail(400, 'bad_solana_address');
      const wb = await fraud.walletBlock(db, s, w); if (wb) fail(409, wb);
      // One wallet per person: it applies to every device signed in with the same Cumulus ID.
      if (s.account) await db.run('UPDATE sessions SET wallet = ? WHERE account = ?', w, s.account);
      else await db.run('UPDATE sessions SET wallet = ? WHERE id = ?', w, s.id);
      return me(db, { ...s, wallet: w });
    },

    // Moves accrued payouts to the settlement queue. On-chain settlement is a separate job.
    'POST /v1/claim': async (db, req) => {
      const s = await auth(db, req);
      if (!s.wallet) fail(400, 'no_wallet');
      const [scope, key] = mine(s);
      const r = await db.run(`UPDATE payouts SET status = 'queued', wallet = ? WHERE ${scope} AND status = 'accrued'`, s.wallet, key);
      return { queued: r.changes, ...(await me(db, s)) };
    },

    // Contextual ads: chosen by the server's region only, never by user profile.
    // VEIL Premium members get no ad.
    'GET /v1/ads': async (db, req) => {
      if (req.header('authorization')) {
        const s = await auth(db, req).catch(() => null);
        if (isPremium(s)) return { premium: true };
      }
      return publicAd(pickAd(req.query.get('region') || 'global'));
    },

    'POST /v1/ads/event': async (db, req, body) => {
      const s = await auth(db, req);
      if (isPremium(s)) fail(409, 'premium_no_ads');
      const a = ADS.find((x) => x.id === body.ad) || fail(404, 'unknown_ad');
      return countAd(db, s, a, body.kind === 'click' ? 'click' : 'view');
    },

    'GET /v1/pool': async (db, req) => {
      const d = req.query.get('day') || day();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(400, 'bad_day');
      const closed = await db.get('SELECT 1 AS x FROM epochs WHERE day = ?', d);
      return { ...(await poolStats(db, d)), closed: !!closed, refPrice: REF_PRICE };
    },

    // Ad revenue: today's network revenue and pool, what this member's ad views generated,
    // their estimated share, and recent closed epochs with their own payout.
    'GET /v1/revenue': async (db, req) => {
      const s = await auth(db, req); const d = day();
      const p = await poolStats(db, d);
      const ads = await db.get('SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(clicks), 0) AS clicks FROM ad_stats WHERE day = ?', d);
      const m = (await db.get('SELECT views, clicks, usd FROM member_ads WHERE sid = ? AND day = ?', s.id, d)) || { views: 0, clicks: 0, usd: 0 };
      const mine = { views: num(m.views), clicks: num(m.clicks), usd: num(m.usd) };
      const minutes = (await today(db, s.id)).minutes;
      const share = memberShare({ poolUsd: p.poolUsd, myMinutes: minutes, totalMinutes: p.minutes, boost: p.boost, price: REF_PRICE });
      const history = (await db.all(`SELECT e.day, e.revenue_usd AS "revenueUsd", e.pool_usd AS "poolUsd", e.tier, e.community_pct AS "communityPct", e.members,
        COALESCE(p.minutes, 0) AS minutes, COALESCE(p.pool_usd, 0) AS "myUsd", COALESCE(p.pool_veil, 0) AS "myVeil", p.status
        FROM epochs e LEFT JOIN payouts p ON p.day = e.day AND p.sid = ? ORDER BY e.day DESC LIMIT 14`, s.id))
        .map((h) => ({ ...h, revenueUsd: num(h.revenueUsd), poolUsd: num(h.poolUsd), communityPct: num(h.communityPct), members: num(h.members),
          minutes: num(h.minutes), myUsd: num(h.myUsd), myVeil: num(h.myVeil) }));
      return { today: { ...p, views: num(ads.views), clicks: num(ads.clicks) }, mine: { ...mine, minutes, shareUsd: share.usd, shareVeil: share.veil, weight: share.weight }, history, refPrice: REF_PRICE };
    },

    'GET /v1/epochs': async (db) => ({ epochs: await db.all('SELECT * FROM epochs ORDER BY day DESC LIMIT 60') }),

    // Replace the impression estimate with the ad network's reported revenue for a day.
    'POST /admin/revenue': async (db, req, body) => {
      admin(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.day || '') || !(Number(body.usd) >= 0)) fail(400, 'bad_input');
      await db.run(`INSERT INTO revenue (day, estimated_usd, reported_usd) VALUES (?, 0, ?)
        ON CONFLICT (day) DO UPDATE SET reported_usd = excluded.reported_usd`, body.day, Number(body.usd));
      return poolStats(db, body.day);
    },

    'POST /admin/epoch/close': (db, req, body) => {
      admin(req);
      const d = body.day || day(Date.now() - 86_400_000);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(400, 'bad_day');
      return closeEpoch(db, d);
    },

    // Fraud review: flagged sessions and their held payouts; release (pay) or ban (void).
    'GET /admin/fraud': async (db, req) => {
      admin(req);
      const flagged = (await fraud.review(db)).map((r) => ({ ...r, created: String(r.created), heldVeil: num(r.heldVeil) }));
      return { flagged, rules: fraud.cfg };
    },
    'POST /admin/fraud/release': async (db, req, body) => { admin(req); return { released: await fraud.release(db, String(body.sid || '')) }; },
    'POST /admin/fraud/ban': async (db, req, body) => { admin(req); return { voided: await fraud.ban(db, String(body.sid || '')) }; },

    'GET /admin/settlement-queue': async (db, req) => {
      admin(req);
      const queue = await db.all(`SELECT wallet, ROUND(SUM(base_veil + pool_veil), 6) AS veil, COUNT(*) AS epochs
        FROM payouts WHERE status = 'queued' GROUP BY wallet`);
      return { queue: queue.map((r) => ({ wallet: r.wallet, veil: num(r.veil), epochs: num(r.epochs) })) };
    },
  };

  // Returns [status, body]. `readBody` is called only for POST and must resolve to parsed JSON.
  async function handle(db, req, readBody) {
    if (Date.now() - swept > 60_000) sweep();
    const h = routes[`${req.method} ${req.path}`];
    if (!h) return [404, { error: 'not_found' }];
    try {
      const body = req.method === 'POST' ? await readBody() : {};
      return [200, await h(db, req, body)];
    } catch (e) {
      if (e instanceof HttpError) return [e.code, { error: e.message }];
      log.error(e.message);
      return [502, { error: 'upstream_error' }];
    }
  }

  return { handle, closeEpoch, pollHealth, sweep, fraud, health };
}

// Parses a JSON body of at most 16 KB.
export function parseBody(text) {
  if (text.length > 16_384) throw new HttpError(413, 'body_too_large');
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'bad_json'); }
}
