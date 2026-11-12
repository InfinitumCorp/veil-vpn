// The extension's Cumulus ID sign-in, with a stand-in `chrome` API and network: opens the authorize tab,
// catches the return page, trades the code, gets a VEIL session, and signs out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('extension: Sign in / Create a Cumulus ID, then sign out', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'veil-ext-'));
  copyFileSync(new URL('../extension/background.js', import.meta.url), path.join(dir, 'background.js'));
  writeFileSync(path.join(dir, 'config.js'), 'export const CONTROL_URL = "https://api.test";\n'
    + 'export const CID_ISSUER = "https://ru-mirror.test";\nexport const CID_RETURN = "https://infinitumveilvpn.app/app-signin/?to=ext";\n');

  const areas = { local: new Map(), session: new Map() };
  const area = (m) => ({
    get: async (k) => (typeof k === 'string' ? (m.has(k) ? { [k]: m.get(k) } : {}) : Object.fromEntries(m)),
    set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
    remove: async (k) => { for (const x of [].concat(k)) m.delete(x); },
  });
  const listeners = {}; const on = (name) => ({ addListener: (f) => { listeners[name] = f; } });
  const tabs = []; const closed = [];
  globalThis.chrome = {
    storage: { local: area(areas.local), session: area(areas.session) },
    runtime: { id: 'veil', onMessage: on('message'), onStartup: on('startup'), onInstalled: on('installed') },
    tabs: { create: async ({ url }) => { tabs.push(url); return { id: tabs.length }; }, remove: async (id) => { closed.push(id); }, onUpdated: on('tabUpdated') },
    proxy: { settings: { set: async () => {}, clear: async () => {} }, onProxyError: on('proxyError') },
    webRequest: { onAuthRequired: on('auth'), onCompleted: on('completed'), onErrorOccurred: on('error') },
    alarms: { create() {}, clear() {}, onAlarm: on('alarm') }, idle: { queryState: async () => 'active' },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const u = String(url);
    if (u === 'https://ru-mirror.test/api/id/token') {
      const b = JSON.parse(init.body);
      assert.equal(b.client_id, 'veil-vpn'); assert.equal(b.redirect_uri, 'https://infinitumveilvpn.app/app-signin/?to=ext');
      assert.equal(b.code, 'one-time-code'); assert.ok(b.code_verifier.length >= 43);
      return Response.json({ access_token: 'cid-access-token-0123456789', profile: { username: 'alice', email: 'alice@cumuluscloud.app', cid: 'cid_x' } });
    }
    if (u === 'https://api.test/v1/session') {
      const b = JSON.parse(init.body);
      if (!b.cid_token) return Response.json({ token: 'anon.key', signedIn: false });   // no sign-in needed
      assert.deepEqual(b, { cid_token: 'cid-access-token-0123456789' });
      return Response.json({ token: 'sid.key', signedIn: true });
    }
    if (u === 'https://api.test/v1/me') {
      const a = init.headers.authorization;
      return a === 'Bearer sid.key' ? Response.json({ ok: 1 }) : a === 'Bearer anon.key' ? Response.json({ ok: 'anon' }) : Response.json({ error: 'sign_in_required' }, { status: 401 });
    }
    if (u === 'https://ru-mirror.test/api/id/signout') return Response.json({ ok: true });
    throw new Error(`unexpected ${u}`);
  };

  const { handlers } = await import(pathToFileURL(path.join(dir, 'background.js')).href);
  // Anyone can use VEIL VPN without signing in: the extension gets an anonymous session.
  assert.equal((await handlers.account()).signedIn, false);
  assert.deepEqual(await handlers.me(), { ok: 'anon' });
  assert.equal((await handlers.account()).signedIn, false);

  // "Create a Cumulus ID": the authorize URL on the configured mirror, with prompt=create.
  await handlers.signIn({ create: true });
  const auth = new URL(tabs[0]);
  assert.equal(auth.origin + auth.pathname, 'https://ru-mirror.test/api/id/authorize');
  assert.equal(auth.searchParams.get('prompt'), 'create');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const state = auth.searchParams.get('state');

  // A return with the wrong state is refused.
  await listeners.tabUpdated(1, { url: `https://infinitumveilvpn.app/app-signin/?to=ext&code=x&state=wrong` });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await handlers.account()).error, 'cid_mismatch');

  // "Sign in with Cumulus ID", and the return page with the right state.
  await handlers.signIn({});
  const s2 = new URL(tabs[1]).searchParams.get('state');
  assert.notEqual(s2, state); assert.equal(new URL(tabs[1]).searchParams.has('prompt'), false);
  await listeners.tabUpdated(2, { url: `https://infinitumveilvpn.app/app-signin/?to=ext&code=one-time-code&state=${s2}` });
  await new Promise((r) => setTimeout(r, 10));
  const acct = await handlers.account();
  assert.equal(acct.signedIn, true); assert.equal(acct.profile.email, 'alice@cumuluscloud.app');
  assert.ok(closed.includes(2));
  assert.deepEqual(await handlers.me(), { ok: 1 });

  await handlers.signOut();
  assert.equal((await handlers.account()).signedIn, false);
  assert.ok(calls.includes('POST https://ru-mirror.test/api/id/signout'));
  assert.deepEqual(await handlers.me(), { ok: 'anon' });   // still usable after signing out
  rmSync(dir, { recursive: true, force: true });
});
