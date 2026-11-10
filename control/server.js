// VEIL</>™ control server for Node.js with SQLite: local development, tests and self-hosting.
// The API itself is in core.js; the production deployment runs the same core as a Cloudflare
// Worker on Supabase Postgres (deploy/api).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createControl, parseBody, CORS, HttpError } from './core.js';

const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env('PORT', 8787));
const TRUST_PROXY = env('TRUST_PROXY', '0') === '1';  // read X-Forwarded-For (only behind your own proxy)

// ---------- database ----------
const db = new DatabaseSync(env('DB_PATH', 'veil.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created TEXT NOT NULL, wallet TEXT);
CREATE TABLE IF NOT EXISTS usage (sid TEXT, day TEXT, minutes INTEGER NOT NULL DEFAULT 0, last_beat INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sid, day));
CREATE TABLE IF NOT EXISTS conns (sid TEXT PRIMARY KEY, node TEXT NOT NULL, mode TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wg_peers (pubkey TEXT PRIMARY KEY, sid TEXT NOT NULL, node TEXT NOT NULL, ip TEXT NOT NULL, UNIQUE (node, ip));
CREATE TABLE IF NOT EXISTS ad_stats (day TEXT, ad TEXT, views INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ad));
CREATE TABLE IF NOT EXISTS member_ads (sid TEXT, day TEXT, views INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (sid, day));
CREATE TABLE IF NOT EXISTS revenue (day TEXT PRIMARY KEY, estimated_usd REAL NOT NULL DEFAULT 0, reported_usd REAL);
CREATE TABLE IF NOT EXISTS epochs (day TEXT PRIMARY KEY, members INTEGER, minutes INTEGER, revenue_usd REAL, tier TEXT, community_pct REAL, pool_usd REAL, boost REAL, price REAL, closed_at TEXT);
CREATE TABLE IF NOT EXISTS payouts (sid TEXT, day TEXT, minutes INTEGER, base_veil REAL, pool_usd REAL, pool_veil REAL, status TEXT NOT NULL DEFAULT 'accrued', wallet TEXT, PRIMARY KEY (sid, day));
CREATE TABLE IF NOT EXISTS net_day (day TEXT, net TEXT, sid TEXT, PRIMARY KEY (day, net, sid));
`);
for (const col of ['device_hash TEXT', 'platform TEXT', "flags TEXT NOT NULL DEFAULT ''"]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already there */ }
}
db.exec('CREATE INDEX IF NOT EXISTS sessions_device ON sessions (device_hash); CREATE INDEX IF NOT EXISTS sessions_wallet ON sessions (wallet);');

// Async adapter over node:sqlite (see core.js).
function sqlite(d) {
  const cache = new Map();
  const st = (s) => { let p = cache.get(s); if (!p) { p = d.prepare(s); cache.set(s, p); } return p; };
  const a = {
    get: async (s, ...v) => st(s).get(...v),
    all: async (s, ...v) => st(s).all(...v),
    run: async (s, ...v) => ({ changes: Number(st(s).run(...v).changes) }),
    tx: async (fn) => {
      d.exec('BEGIN');
      try { const r = await fn(a); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
    },
  };
  return a;
}
const adb = sqlite(db);

let control;
try {
  control = createControl({
    env,
    nodes: JSON.parse(readFileSync(env('NODES_FILE', new URL('./nodes.json', import.meta.url)), 'utf8')),
    ads: JSON.parse(readFileSync(new URL('./ads.json', import.meta.url), 'utf8')),
  });
} catch (e) { console.error(e.message); process.exit(1); }
const { fraud } = control;
setInterval(() => fraud.purge(adb), 3_600_000).unref(); fraud.purge(adb);

// ---------- http ----------
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
};
const readText = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 16_384) { reject(new HttpError(413, 'body_too_large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const xff = TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const r = {
    method: req.method, path: url.pathname, query: url.searchParams,
    header: (k) => req.headers[k.toLowerCase()],
    ip: xff || req.socket.remoteAddress || '',
  };
  const [code, body] = await control.handle(adb, r, async () => parseBody(await readText(req)));
  send(res, code, body);
});

export const closeEpoch = (d) => control.closeEpoch(adb, d);
export const pollHealth = () => control.pollHealth();
export function start(port = PORT) {
  control.pollHealth(); setInterval(control.pollHealth, 30_000).unref();
  return new Promise((r) => server.listen(port, () => { console.log(`control listening on :${server.address().port}`); r(server); }));
}
export { db, fraud };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
