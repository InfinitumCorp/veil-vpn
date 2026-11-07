// The production database path end to end: the Worker's own openPostgres() (postgres.js, a new
// connection per request, prepare off as on Supabase's pooler) talking the Postgres wire protocol
// to PGlite with the Supabase migration applied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import worker from '../src/worker.js';

const PORT = 15433;
let pg, srv, env;
const call = async (path, { method = 'GET', body, token, admin } = {}) => {
  const waits = [];
  const r = await worker.fetch(new Request(`https://api.test${path}`, { method, body: body && JSON.stringify(body), headers: {
    'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', 'x-veil-device': 'driver-test-device-01',
    ...(token && { authorization: `Bearer ${token}` }), ...(admin && { authorization: `Bearer ${env.ADMIN_KEY}` }) } }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return { status: r.status, body: await r.json() };
};

before(async () => {
  pg = await PGlite.create();
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
  srv = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1', maxConnections: 8 });
  await srv.start();
  env = {
    NODE_ENV: 'development', TOKEN_SECRET: 'driver-token-secret-0123456789abcdef', AGENT_SECRET: 'driver-agent-secret-0123456789abcdef',
    ADMIN_KEY: 'driver-admin-key-0123456789abcdef', DATABASE_URL: `postgres://postgres@127.0.0.1:${PORT}/postgres`,
    NODES: JSON.stringify([{ id: 'x', city: 'X', country: 'X', flag: 'X', region: 'global', agentUrl: 'http://127.0.0.1:9', proxy: { scheme: 'https', host: 'x.example', port: 443 } }]),
  };
});
after(async () => { await srv?.stop(); await pg?.close(); });

test('postgres.js: sessions, connect, heartbeat, wallet, epoch and claim with real types', async () => {
  const s = await call('/v1/session', { method: 'POST' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const token = s.body.token; const sid = token.split('.')[0];
  const c = await call('/v1/connect', { method: 'POST', token, body: { server: 'x' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const hb = await call('/v1/heartbeat', { method: 'POST', token, body: { active: true } });
  assert.equal(hb.body.credited, true, JSON.stringify(hb.body));
  assert.equal(hb.body.today.minutes, 1);
  assert.equal(typeof hb.body.connection.exp, 'number');                 // bigint -> number
  assert.equal((await call('/v1/wallet', { method: 'POST', token, body: { address: '9'.repeat(44) } })).status, 200);

  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await pg.query('INSERT INTO veil_vpn.usage (sid, day, minutes) VALUES ($1, $2, 60)', [sid, y]);
  await call('/admin/revenue', { method: 'POST', admin: true, body: { day: y, usd: 10 } });
  const e = await call('/admin/epoch/close', { method: 'POST', admin: true, body: { day: y } });   // transaction
  assert.equal(e.status, 200, JSON.stringify(e.body)); assert.equal(e.body.poolUsd, 5);
  const ep = (await call('/v1/epochs')).body.epochs[0];
  assert.equal(ep.day, y);                                                // date stays a string
  assert.equal(ep.pool_usd, 5);                                           // numeric -> number
  assert.equal(typeof ep.closed_at, 'string');
  const cl = await call('/v1/claim', { method: 'POST', token });
  assert.equal(cl.body.queued, 1);                                        // UPDATE row count
  const q = (await call('/admin/settlement-queue', { admin: true })).body.queue;
  assert.deepEqual(q, [{ wallet: '9'.repeat(44), veil: 506, epochs: 1 }]);
});
