// VEIL</>™ extension background worker (Chrome / Edge / Firefox, Manifest V3).
// Routes this browser's traffic through a VEIL node's HTTPS proxy, answers its auth
// challenge with a short-lived token, sends reward heartbeats and enforces the kill switch.
import { CONTROL_URL } from './config.js';

const S = { local: chrome.storage.local, session: chrome.storage.session };
const get = async (area, k) => (await S[area].get(k))[k];
const set = (area, k, v) => S[area].set({ [k]: v });
const DEFAULTS = { block: true, kill: true, tor: false, auto: false, earn: true, proto: 'HTTPS' };
const settings = async () => ({ ...DEFAULTS, ...(await get('local', 'settings')) });

// ---------- control API ----------
// A random install ID, sent with every call so the server can tell one device from many
// (fraud protection: one earning session per device). The server stores only a keyed hash.
async function device() {
  let d = await get('local', 'device');
  if (!d) { d = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join(''); await set('local', 'device', d); }
  return d;
}
const idHeaders = async () => ({ 'x-veil-device': await device(), 'x-veil-platform': typeof chrome.proxy.onRequest !== 'undefined' ? 'firefox' : 'chrome' });
async function session() {
  let t = await get('local', 'session');
  if (!t) {
    const r = await fetch(`${CONTROL_URL}/v1/session`, { method: 'POST', headers: await idHeaders() });
    if (!r.ok) throw new Error(`session_${r.status}`);
    t = (await r.json()).token;
    await set('local', 'session', t);
  }
  return t;
}
async function api(path, { method = 'GET', body, retry = true } = {}) {
  const token = await session();
  const r = await fetch(`${CONTROL_URL}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(await idHeaders()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { await S.local.remove('session'); return api(path, { method, body, retry: false }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `http_${r.status}`);
  return j;
}

// ---------- proxy control ----------
// Chrome / Edge: one browser-wide proxy setting. Firefox: proxy.onRequest decides per request
// (its proxy.settings needs private-browsing access and is meant for whole-browser settings).
const CONTROL_HOST = new URL(CONTROL_URL).hostname;
const FIREFOX = typeof chrome.proxy.onRequest !== 'undefined';
let route;   // Firefox: the current proxy, or null for direct. undefined = not loaded yet.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
async function applyProxy(p) {
  if (FIREFOX) { route = { scheme: p.scheme, host: p.host, port: p.port }; return set('session', 'route', route); }
  await chrome.proxy.settings.set({
    scope: 'regular',
    value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: p.scheme, host: p.host, port: p.port }, bypassList: ['<local>', CONTROL_HOST] } },
  });
}
const clearProxy = () => FIREFOX
  ? (route = null, S.session.remove('route'))
  : chrome.proxy.settings.clear({ scope: 'regular' });
if (FIREFOX) {
  chrome.proxy.onRequest.addListener(async (d) => {
    if (route === undefined) route = (await get('session', 'route')) || null;   // event page woke up
    const host = new URL(d.url).hostname;
    if (!route || host === CONTROL_HOST || LOCAL.test(host)) return { type: 'direct' };
    return { type: route.scheme === 'https' ? 'https' : 'http', host: route.host, port: route.port, failoverTimeout: 5 };
  }, { urls: ['<all_urls>'] });
}

// Sends one request through the tunnel; the node answers it itself. Only a 204 from
// the node counts as protected.
async function probe() {
  try {
    const r = await fetch(`http://veil-check.invalid/?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    return r.status === 204 && r.headers.has('x-veil-node');
  } catch { return false; }
}

async function connect(server, { reconnect = false } = {}) {
  const prev = await get('session', 'conn');
  if (!reconnect) await set('session', 'conn', { state: 'connecting', server, since: 0 });
  try {
    const st = await settings();
    const r = await api('/v1/connect', { method: 'POST', body: { server, mode: 'proxy', tor: st.tor === true, block: st.block !== false } });
    await set('session', 'creds', { username: r.proxy.username, password: r.proxy.password });
    await applyProxy(r.proxy);
    if (!(await probe())) throw new Error('node_unreachable');
    const since = reconnect && prev?.since ? prev.since : Date.now();
    const conn = { state: 'on', server, since, exp: r.exp, region: r.server.region, tor: !!r.tor };
    await set('session', 'conn', conn);
    await set('local', 'lastServer', server);
    chrome.alarms.create('refresh', { when: r.exp - 120_000 });
    chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
    badge(true);
    return conn;
  } catch (e) {
    if (reconnect) throw e;              // caller keeps the error state and kill switch
    await clearProxy(); await S.session.remove('creds');
    await set('session', 'conn', { state: 'off', server, since: 0 });
    throw e;
  }
}
async function disconnect() {
  chrome.alarms.clear('refresh'); chrome.alarms.clear('heartbeat');
  await clearProxy();
  await S.session.remove('creds');
  const c = (await get('session', 'conn')) || {};
  await set('session', 'conn', { state: 'off', server: c.server, since: 0 });
  api('/v1/disconnect', { method: 'POST' }).catch(() => {});
  badge(false);
  return get('session', 'conn');
}
function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#14866d' });
}

// The node answers 407; supply the current token. Give up after two tries per request.
const tries = new Map();
async function proxyAuth(details) {
  if (!details.isProxy) return {};
  const n = (tries.get(details.requestId) || 0) + 1;
  tries.set(details.requestId, n);
  if (n > 2) { tries.delete(details.requestId); return { cancel: true }; }
  const c = await get('session', 'creds');
  return c ? { authCredentials: c } : { cancel: true };
}
if (FIREFOX) chrome.webRequest.onAuthRequired.addListener(proxyAuth, { urls: ['<all_urls>'] }, ['blocking']);
else chrome.webRequest.onAuthRequired.addListener((d, done) => { proxyAuth(d).then(done); }, { urls: ['<all_urls>'] }, ['asyncBlocking']);
const forget = (d) => tries.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });

// Kill switch: on proxy failure, keep the proxy in place (traffic is blocked, not leaked)
// and try to reconnect; with the kill switch off, fall back to a direct connection.
let healing = false;
async function heal(server) {
  if (healing) return;
  healing = true;
  const c = await get('session', 'conn');
  await set('session', 'conn', { ...c, state: 'error' });
  const kill = (await settings()).kill;
  if (!kill) await clearProxy();
  for (let wait = 3000; ; wait = Math.min(wait * 2, 60_000)) {
    await new Promise((r) => setTimeout(r, wait));
    const now = await get('session', 'conn');
    if (!now || now.state !== 'error') break;            // user disconnected meanwhile
    try { await connect(server, { reconnect: true }); break; }
    catch { if (!kill) await clearProxy(); }               // stay in error; kill switch keeps blocking
  }
  healing = false;
}
const onProxyDown = async () => {
  const c = await get('session', 'conn');
  if (c?.state === 'on') heal(c.server);
};
if (FIREFOX) {
  // Firefox has no "proxy unreachable" event; a request failing at the proxy is the signal.
  chrome.webRequest.onErrorOccurred.addListener((d) => { if (/PROXY/i.test(d.error || '')) onProxyDown(); }, { urls: ['<all_urls>'] });
} else chrome.proxy.onProxyError.addListener(onProxyDown);

chrome.alarms.onAlarm.addListener(async (a) => {
  const c = await get('session', 'conn');
  if (!c || c.state !== 'on') return;
  if (a.name === 'refresh') connect(c.server, { reconnect: true }).catch(() => heal(c.server));
  if (a.name === 'heartbeat') {
    if (!(await probe())) return heal(c.server);   // also catches a silently dead node
    if (!(await settings()).earn) return;
    const idle = await chrome.idle.queryState(60);
    api('/v1/heartbeat', { method: 'POST', body: { active: idle === 'active' } })
      .catch((e) => { if (e.message === 'not_connected') connect(c.server, { reconnect: true }).catch(() => heal(c.server)); });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearProxy();
  const s = await settings();
  const last = await get('local', 'lastServer');
  if (s.auto && last) connect(last).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => { clearProxy(); badge(false); });

// ---------- messages from the popup ----------
export const handlers = {   // exported for tests; the popup reaches these by message
  state: async () => (await get('session', 'conn')) || { state: 'off', server: await get('local', 'lastServer'), since: 0 },
  servers: async () => (await api('/v1/servers')).servers,
  connect: (m) => connect(String(m.server)),
  disconnect: () => disconnect(),
  me: () => api('/v1/me'),
  pool: () => api('/v1/pool'),
  revenue: () => api('/v1/revenue'),
  blocked: () => api('/v1/blocked'),
  ad: (m) => api(`/v1/ads?region=${encodeURIComponent(m.region || 'global')}`),
  adEvent: (m) => api('/v1/ads/event', { method: 'POST', body: { ad: m.ad, kind: m.kind } }),
  wallet: (m) => api('/v1/wallet', { method: 'POST', body: { address: m.address } }),
  claim: () => api('/v1/claim', { method: 'POST' }),
  setting: async (m) => {
    const s = await settings(); s[m.key] = m.value; await set('local', 'settings', s);
    // Tor and tracker blocking are part of the proxy token, so switching them while connected reconnects.
    const c = await get('session', 'conn');
    if ((m.key === 'tor' || m.key === 'block') && c?.state === 'on') connect(c.server, { reconnect: true }).catch(() => heal(c.server));
    return s;
  },
};
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !handlers[m?.type]) return false;
  handlers[m.type](m).then(reply, (e) => reply({ error: e.message }));
  return true;
});
