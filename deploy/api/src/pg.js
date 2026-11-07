// Postgres adapter for control/core.js. The core writes portable SQL with `?` placeholders and
// bare table names; this turns them into `$n` and schema-qualified names (veil_vpn.*), so it works
// through Supabase's transaction pooler and Hyperdrive without relying on search_path.
const TABLES = ['sessions', 'usage', 'conns', 'wg_peers', 'ad_stats', 'member_ads', 'revenue', 'epochs', 'payouts', 'net_day'];
const TABLE_RE = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${TABLES.join('|')})\\b`, 'gi');

const cache = new Map();
export function toPg(sql, schema = 'veil_vpn') {
  const key = `${schema}\u0000${sql}`;
  let out = cache.get(key);
  if (out === undefined) {
    let i = 0;
    out = sql.replace(TABLE_RE, (_, kw, t) => `${kw} ${schema}.${t}`).replace(/\?/g, () => `$${++i}`);
    cache.set(key, out);
  }
  return out;
}

// exec(text, params) -> { rows, count }; begin(fn) runs fn(exec) inside one transaction.
export function pgAdapter(exec, begin, schema) {
  const a = {
    get: async (s, ...v) => (await exec(toPg(s, schema), v)).rows[0],
    all: async (s, ...v) => (await exec(toPg(s, schema), v)).rows,
    run: async (s, ...v) => ({ changes: (await exec(toPg(s, schema), v)).count }),
    tx: (fn) => begin((txExec) => fn(pgAdapter(txExec, (f) => f(txExec), schema))),
  };
  return a;
}

// postgres.js (Workers runtime via cloudflare:sockets). Numbers come back as numbers; dates and
// timestamps as plain strings, as they do from SQLite.
export const PG_TYPES = {
  numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => Number(x) },
  int8: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
  date: { to: 1082, from: [1082], serialize: (x) => String(x), parse: (x) => x },
  stamp: { to: 1184, from: [1184, 1114], serialize: (x) => (x instanceof Date ? x.toISOString() : String(x)), parse: (x) => x },
};

export function postgresAdapter(sql, schema) {
  const wrap = (s) => async (text, params) => { const r = await s.unsafe(text, params); return { rows: [...r], count: r.count ?? 0 }; };
  return pgAdapter(wrap(sql), (fn) => sql.begin((t) => fn(wrap(t))), schema);
}
