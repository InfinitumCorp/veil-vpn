// VEIL</>™ control API as a Cloudflare Worker, backed by Supabase Postgres (schema veil_vpn).
// Same routes and rules as control/server.js: both run control/core.js.
//
// Configuration (Worker env):
//   secrets  TOKEN_SECRET, AGENT_SECRET, ADMIN_KEY (24+ chars each)
//            DATABASE_URL (Supabase pooler URI, port 6543), unless the HYPERDRIVE binding is set
//   vars     NODE_ENV=production, optional CPM_USD, CPC_USD, FRAUD_* tuning,
//            CID_ISSUER (Cumulus ID issuer or its mirror, default https://id.cumuluscloud.app),
//            CID_REQUIRED (default 0: anyone may use VEIL VPN without signing in; 1 requires Cumulus ID)
//   servers  deploy/api/nodes.json, bundled into the Worker (a text var is capped at 5.1 kB, and each
//            server's entry is ~1.8 kB). An env NODES (JSON array) overrides it; the tests use that.
// Client IPs (cf-connecting-ip) are used only in memory for rate limits and the daily-keyed
// network hash; nothing here writes an IP address anywhere.
import postgres from 'postgres';
import { createControl, parseBody, CORS } from '../../../control/core.js';
import ads from '../../../control/ads.json' with { type: 'json' };
import bundledNodes from '../nodes.json' with { type: 'json' };
import { postgresAdapter, PG_TYPES } from './pg.js';

const json = (code, body) => new Response(code === 204 ? null : JSON.stringify(body), {
  status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
});

// Opens a database connection for one request. postgres.js connects lazily on the first query,
// so routes that do not touch the database (ads, server list) open no connection.
export function openPostgres(env) {
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL or the HYPERDRIVE binding must be set');
  const sql = postgres(url, { prepare: false, max: 1, fetch_types: false, types: PG_TYPES, idle_timeout: 5 });
  return { db: postgresAdapter(sql, env.DB_SCHEMA || 'veil_vpn'), close: () => sql.end({ timeout: 5 }) };
}

export function makeWorker(openDb = openPostgres, { fetchFn = fetch } = {}) {
  let control = null; // one per isolate: holds node health, rate limits and dedupe maps
  const get = (env) => control ??= createControl({
    env: (k, d) => (env[k] ?? d),
    nodes: typeof env.NODES === 'string' ? JSON.parse(env.NODES) : (env.NODES || bundledNodes),
    ads,
    fetchFn: (...a) => fetchFn(...a),
  });

  return {
    async fetch(request, env, ctx) {
      if (request.method === 'OPTIONS') return json(204);
      let c;
      try { c = get(env); } catch (e) { console.error(e.message); return json(503, { error: 'not_configured' }); }
      const url = new URL(request.url);
      const req = {
        method: request.method, path: url.pathname, query: url.searchParams,
        header: (k) => request.headers.get(k) ?? undefined,
        ip: request.headers.get('cf-connecting-ip') || '',
      };
      let conn;
      const db = new Proxy({}, { get: (_, k) => { conn ??= openDb(env); return conn.db[k]; } });
      try {
        const [code, body] = await c.handle(db, req, async () => parseBody(await request.text()));
        return json(code, body);
      } catch (e) {
        console.error(e.message);
        return json(503, { error: 'not_configured' });
      } finally {
        if (conn) { const p = conn.close(); if (ctx?.waitUntil) ctx.waitUntil(p); else await p; }
      }
    },

    // Hourly: delete network tags older than 3 days (fraud.js privacy rule).
    async scheduled(event, env, ctx) {
      const c = get(env); const { db, close } = openDb(env);
      try { await c.fraud.purge(db); } finally { ctx.waitUntil(close()); }
    },
  };
}

export default makeWorker();
