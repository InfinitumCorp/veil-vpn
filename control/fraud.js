// Fraud protection for rewards. Decides whether a heartbeat or ad event may earn, and caps
// epoch payouts per device and per wallet. Privacy rules:
//  - a device ID is stored only as a keyed hash;
//  - a network is stored only as a keyed hash of its /24 (IPv4) or /48 (IPv6) prefix, with a key
//    that changes every day, and is deleted after 3 days; the client IP itself is never stored.
// Every function takes the database adapter `db` first (see core.js), so the same rules run on
// SQLite (Node server) and Postgres (Cloudflare Worker + Supabase).
import { createHmac } from 'node:crypto';

const FLAG_BLOCKS = new Set(['shared_token', 'untrusted_device', 'banned']);

export function createFraud({ secret, maxMinutes, env }) {
  const n = (k, d) => Number(env(k, d));
  const cfg = {
    netMax: n('FRAUD_NET_MAX', 8),              // earning sessions per network per day
    walletMax: n('FRAUD_WALLET_MAX', 3),        // sessions that may share one payout wallet
    adViews: n('FRAUD_AD_VIEWS', 60),           // counted ad views per session per day
    adClicks: n('FRAUD_AD_CLICKS', 10),         // counted ad clicks per session per day
    blockEmulators: env('FRAUD_BLOCK_EMULATORS', env('NODE_ENV', 'development') === 'production' ? '1' : '0') === '1',
  };

  const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const mac = (k, v) => createHmac('sha256', k).update(v).digest('base64url').slice(0, 22);
  const deviceHash = (id) => mac(secret, `device:${id}`);
  const flagsOf = (s) => (s?.flags || '').split(',').filter(Boolean);

  async function addFlag(db, sid, flag) {
    const s = await db.get('SELECT flags FROM sessions WHERE id = ?', sid);
    if (!s) return;
    const f = new Set(flagsOf(s)); if (f.has(flag)) return;
    f.add(flag);
    await db.run('UPDATE sessions SET flags = ? WHERE id = ?', [...f].join(','), sid);
  }

  // Network tag: keyed hash of the address prefix, key rotated daily. `req.ip` is never stored.
  function netTag(req, d = day()) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    const prefix = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');
    return mac(`${secret}:net:${d}`, prefix);
  }

  // Reads the device headers sent by every client and binds the first device ID seen to the session.
  // A different device later using the same token means the token was copied: flag it.
  async function observe(db, req, s) {
    const id = String(req.header('x-veil-device') || '');
    const platform = String(req.header('x-veil-platform') || '').slice(0, 16) || null;
    const integrity = String(req.header('x-veil-integrity') || '').split(',');
    if (/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
      const h = deviceHash(id);
      if (!s.device_hash) { await db.run('UPDATE sessions SET device_hash = ?, platform = ? WHERE id = ?', h, platform, s.id); s.device_hash = h; }
      else if (s.device_hash !== h) await addFlag(db, s.id, 'shared_token');
    }
    if (cfg.blockEmulators && (integrity.includes('emulator') || integrity.includes('rooted'))) await addFlag(db, s.id, 'untrusted_device');
  }

  // Why this session may not earn right now, or null. Checked before each rewarded minute.
  async function earnBlock(db, req, s, today) {
    const cur = await db.get('SELECT device_hash, wallet, flags FROM sessions WHERE id = ?', s.id);
    if (flagsOf(cur).some((f) => FLAG_BLOCKS.has(f))) return 'under_review';
    if (!cur.device_hash) return 'device_unverified';
    // One earning session per device per day (a new session on the same device is a duplicate account).
    const dup = await db.get(`SELECT 1 AS x FROM usage u JOIN sessions s ON s.id = u.sid
      WHERE s.device_hash = ? AND u.day = ? AND u.sid != ? AND u.minutes > 0 LIMIT 1`, cur.device_hash, today, s.id);
    if (dup) return 'device_limit';
    // Sessions sharing one wallet share one daily limit.
    if (cur.wallet) {
      const w = (await db.get(`SELECT COALESCE(SUM(u.minutes), 0) AS m FROM usage u JOIN sessions s ON s.id = u.sid
        WHERE s.wallet = ? AND u.day = ?`, cur.wallet, today)).m;
      if (Number(w) >= maxMinutes) return 'daily_limit';
    }
    // At most netMax earning sessions per network per day (stops farms of many sessions on one line).
    const net = netTag(req, today);
    const known = await db.get('SELECT 1 AS x FROM net_day WHERE day = ? AND net = ? AND sid = ?', today, net, s.id);
    if (!known) {
      const count = (await db.get('SELECT COUNT(*) AS c FROM net_day WHERE day = ? AND net = ?', today, net)).c;
      if (Number(count) >= cfg.netMax) return 'network_limit';
    }
    return null;
  }
  const credited = (db, req, s, today) =>
    db.run('INSERT INTO net_day (day, net, sid) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', today, netTag(req, today), s.id);

  // Ad events count only from sessions in good standing, capped per day; a click needs a view first.
  async function adBlock(db, s, kind, today) {
    const cur = await db.get('SELECT flags FROM sessions WHERE id = ?', s.id);
    if (flagsOf(cur).some((f) => FLAG_BLOCKS.has(f))) return 'under_review';
    const m = (await db.get('SELECT views, clicks FROM member_ads WHERE sid = ? AND day = ?', s.id, today)) || { views: 0, clicks: 0 };
    if (kind === 'view' && m.views >= cfg.adViews) return 'ad_limit';
    if (kind === 'click' && (m.clicks >= cfg.adClicks || m.clicks >= m.views)) return 'ad_limit';
    return null;
  }

  // Linking a wallet already used by walletMax other sessions is refused.
  async function walletBlock(db, s, wallet) {
    if (!wallet) return null;
    const c = (await db.get('SELECT COUNT(*) AS c FROM sessions WHERE wallet = ? AND id != ?', wallet, s.id)).c;
    return Number(c) >= cfg.walletMax ? 'wallet_in_use' : null;
  }

  // Epoch payout rows: minutes are capped at maxMinutes per device and per wallet across all their
  // sessions (scaled down evenly), and flagged sessions are paid into 'held' for admin review.
  async function epochRows(db, d) {
    const rows = await db.all(`SELECT u.sid, u.minutes, s.device_hash AS device, s.wallet, COALESCE(s.flags, '') AS flags
      FROM usage u LEFT JOIN sessions s ON s.id = u.sid WHERE u.day = ? AND u.minutes > 0`, d);
    const factor = new Map(rows.map((r) => [r.sid, 1]));
    for (const key of ['device', 'wallet']) {
      const groups = new Map();
      for (const r of rows) if (r[key]) groups.set(r[key], [...(groups.get(r[key]) || []), r]);
      for (const g of groups.values()) {
        const sum = g.reduce((a, r) => a + r.minutes, 0);
        if (sum > maxMinutes) for (const r of g) factor.set(r.sid, Math.min(factor.get(r.sid), maxMinutes / sum));
      }
    }
    return rows.map((r) => ({
      sid: r.sid, rawMinutes: r.minutes, minutes: Math.floor(r.minutes * factor.get(r.sid)),
      held: r.flags.split(',').some((f) => FLAG_BLOCKS.has(f)),
    }));
  }

  // Admin review: flagged sessions with what they have earned, and release or ban.
  const review = (db) => db.all(`SELECT s.id, s.flags, s.platform, s.created,
      COALESCE((SELECT SUM(p.base_veil + p.pool_veil) FROM payouts p WHERE p.sid = s.id AND p.status = 'held'), 0) AS "heldVeil"
      FROM sessions s WHERE s.flags != '' ORDER BY s.created DESC LIMIT 200`);
  async function release(db, sid) {
    await db.run(`UPDATE sessions SET flags = '' WHERE id = ?`, sid);
    return (await db.run(`UPDATE payouts SET status = 'accrued' WHERE sid = ? AND status = 'held'`, sid)).changes;
  }
  async function ban(db, sid) {
    await addFlag(db, sid, 'banned');
    return (await db.run(`UPDATE payouts SET status = 'void' WHERE sid = ? AND status IN ('held', 'accrued')`, sid)).changes;
  }
  const purge = (db) => db.run('DELETE FROM net_day WHERE day < ?', day(Date.now() - 3 * 86_400_000));

  return { cfg, observe, earnBlock, credited, adBlock, walletBlock, epochRows, review, release, ban, purge, addFlag, flagsOf };
}
