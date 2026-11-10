// VEIL</>™ interface. One UI, two backends:
//  - live: inside the browser extension, talks to the background worker and control server
//  - demo: in a plain web page, where a site cannot route traffic, everything is simulated
import { RATE_PER_MIN, MAX_MIN, MAX_DAY, REF_PRICE, TIERS, tierOf, split, memberShare } from './economics.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const EXT = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const ANDROID = typeof window.VeilAndroid !== 'undefined';
const LIVE = EXT || ANDROID;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------- demo backend
function demoBackend() {
  const SERVERS = [
    ['zrh', '🇨🇭', 'Zürich', 'Switzerland', 34], ['rkv', '🇮🇸', 'Reykjavík', 'Iceland', 22], ['sto', '🇸🇪', 'Stockholm', 'Sweden', 48],
    ['ams', '🇳🇱', 'Amsterdam', 'Netherlands', 71], ['fra', '🇩🇪', 'Frankfurt', 'Germany', 63], ['lon', '🇬🇧', 'London', 'United Kingdom', 77],
    ['nyc', '🇺🇸', 'New York', 'United States', 58], ['lax', '🇺🇸', 'Los Angeles', 'United States', 52], ['tor', '🇨🇦', 'Toronto', 'Canada', 39],
    ['gru', '🇧🇷', 'São Paulo', 'Brazil', 45], ['tyo', '🇯🇵', 'Tokyo', 'Japan', 61], ['sin', '🇸🇬', 'Singapore', 'Singapore', 57],
    ['syd', '🇦🇺', 'Sydney', 'Australia', 33], ['jnb', '🇿🇦', 'Johannesburg', 'South Africa', 28], ['bom', '🇮🇳', 'Mumbai', 'India', 66],
  ].map(([id, flag, city, country, load]) => ({ id, flag, city, country, load, online: true }));
  const ADS = [
    { id: 'cumulus', mark: 'C', title: 'Cumulus://Cloud', body: 'Encrypted storage that grows with you. 10 GB free.' },
    { id: 'firm', mark: 'F', title: 'FIRM Wallet', body: 'One self-custody wallet for every Infinitum token.' },
    { id: 'scalvs', mark: 'S', title: 'SCALVS.ai', body: 'Build AI agents that research, write and code for you.' },
    { id: 'fabric', mark: 'FB', title: 'FABRIC', body: 'Encrypted messaging, voice and video with AI built in.' },
  ];
  const KEY = 'veil-vpn-demo-v2';
  const today = () => new Date().toISOString().slice(0, 10);
  const fresh = () => ({ day: today(), sec: 0, pending: 0, life: 0, wallet: null, server: 'zrh', seed: Date.now(), views: 0, clicks: 0 });
  let S;
  try { S = Object.assign(fresh(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { S = fresh(); }
  if (S.day !== today()) { S.day = today(); S.sec = 0; S.views = 0; S.clicks = 0; }
  const CPM = 2, CPC = 0.10; // same defaults as the control server (CPM_USD, CPC_USD)
  const seen = new Map();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage unavailable */ } };
  let conn = { state: 'off', server: S.server, since: 0 }, timer = null, earn = true, blockedN = 0;
  const oct = (d) => Math.floor(S.seed / d) % 250 + 2;
  const members = () => 84_000 + (Date.now() - Date.UTC(2026, 10, 1)) / 3.6e6 * 140 + Math.sin(Date.now() / 6e4) * 900;
  const tick = () => {
    if (Math.random() < 0.25) blockedN++;
    if (earn && document.visibilityState === 'visible' && S.sec < MAX_MIN * 60) {
      S.sec++; const r = RATE_PER_MIN / 60; S.pending += r; S.life += r;
      if (S.sec % 15 === 0) save();
    }
  };
  return {
    mode: 'demo',
    servers: async () => SERVERS,
    state: async () => conn,
    ip: (on) => `${on ? 185 : 203}.${oct(7)}.${oct(131)}.${oct(4099)}`,
    async connect(id) {
      S.server = id; save();
      conn = { state: 'connecting', server: id, since: 0 };
      await new Promise((r) => setTimeout(r, 1400));
      conn = { state: 'on', server: id, since: Date.now() };
      clearInterval(timer); timer = setInterval(tick, 1000);
      return conn;
    },
    async disconnect() { clearInterval(timer); conn = { state: 'off', server: S.server, since: 0 }; save(); return conn; },
    async me() {
      const minutes = Math.floor(S.sec / 60);
      return { today: { minutes, veil: Math.min(S.sec / 60 * RATE_PER_MIN, MAX_DAY) }, pending: S.pending, claimable: S.pending, lifetime: S.life, wallet: S.wallet };
    },
    async pool() {
      const m = members(); const rev = m * 0.012; const s = split(m, rev);
      return { members: m, minutes: m * 95, revenueUsd: rev, poolUsd: s.usd.community, ...s, refPrice: REF_PRICE, myMinutes: S.sec / 60 };
    },
    async revenue() {
      const p = await this.pool();
      const views = Math.round(p.members * 38), clicks = Math.round(views * 0.006);
      const minutes = S.sec / 60;
      const share = memberShare({ poolUsd: p.poolUsd, myMinutes: minutes, totalMinutes: p.minutes, boost: p.boost, price: REF_PRICE });
      const history = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10);
        const m = p.members - (i + 1) * 3360, rev = m * 0.012 * (0.92 + ((i * 7) % 5) / 25), s = split(m, rev);
        const mins = i < 3 ? 140 + ((i * 53) % 90) : 0;
        const my = memberShare({ poolUsd: s.usd.community, myMinutes: mins, totalMinutes: m * 95, boost: s.boost, price: REF_PRICE });
        return { day: d, revenueUsd: rev, poolUsd: s.usd.community, tier: s.tier, communityPct: s.percent.community, minutes: mins, myUsd: my.usd, myVeil: my.veil, status: mins ? 'accrued' : null };
      });
      return { today: { ...p, views, clicks, revenueSource: 'estimated' }, mine: { views: S.views, clicks: S.clicks, usd: S.views * CPM / 1000 + S.clicks * CPC, minutes, shareUsd: share.usd, shareVeil: share.veil, weight: share.weight }, history, refPrice: REF_PRICE };
    },
    async ad() { return ADS[Math.floor(Math.random() * ADS.length)]; },
    async blocked() { return { blocked: conn.state === 'on' ? blockedN : 0, connected: conn.state === 'on' }; },
    async adEvent(ad, kind) {
      const k = `${ad}:${kind}`; if (Date.now() - (seen.get(k) || 0) < 120_000) return;
      seen.set(k, Date.now()); kind === 'click' ? S.clicks++ : S.views++; save();
    },
    async setWallet(a) { S.wallet = a; save(); return this.me(); },
    async claim() { const n = S.pending; S.pending = 0; save(); return { queued: n > 0 ? 1 : 0 }; },
    setEarn(v) { earn = v; },
    async manual() { throw new Error('demo_manual'); },
  };
}

// ---------------------------------------------------------------- live backends
// Browser extension: messages to the background worker.
const extCall = (type, payload = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type, ...payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    r?.error ? reject(new Error(r.error)) : resolve(r);
  });
});
// Android app: native bridge; answers arrive through window.__veilReply.
const androidCall = (() => {
  const pending = new Map(); let n = 0;
  window.__veilReply = (id, result, error) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  };
  return (type, payload = {}) => new Promise((resolve, reject) => {
    const id = String(++n); pending.set(id, { resolve, reject });
    window.VeilAndroid.call(id, type, JSON.stringify(payload));
  });
})();

function liveBackend() {
  const call = ANDROID ? androidCall : extCall;
  let myMinutes = 0;
  return {
    mode: ANDROID ? 'android' : 'extension',
    call,
    servers: () => call('servers'),
    state: () => call('state'),
    ip: () => null,
    connect: (server) => call('connect', { server }),
    disconnect: () => call('disconnect'),
    me: async () => { const m = await call('me'); myMinutes = m.today.minutes; return m; },
    pool: async () => ({ ...(await call('pool')), myMinutes }),
    revenue: () => call('revenue'),
    blocked: () => call('blocked'),
    ad: (region) => call('ad', { region }),
    adEvent: (ad, kind) => call('adEvent', { ad, kind }),
    setWallet: (address) => call('wallet', { address }),
    claim: () => call('claim'),
    setEarn: (v) => call('setting', { key: 'earn', value: v }),
    manual: (server, mode, publicKey) => call('manual', { server, mode, publicKey }),
  };
}

const api = LIVE ? liveBackend() : demoBackend();
if (EXT) document.documentElement.classList.add('ext');

// ---------------------------------------------------------------- settings
const SET_KEY = 'veil-vpn-settings';
const DEFAULT_SET = { block: true, alerts: true, kill: true, tor: false, auto: false, earn: true, proto: 'wireguard', vless: false, shadowsocks: false, ws: false };
// Protocols: the label in the status line and a one-line hint under the Settings row.
const PROTOS = {
  wireguard: ['WireGuard', 'WireGuard: fastest, modern cryptography'],
  ikev2: ['IKEv2', 'IKEv2/IPsec: the VPN built into the system, steady when switching Wi-Fi and mobile data'],
  openvpn: ['OpenVPN', 'OpenVPN: works on almost any network'],
  proxy: ['HTTPS', 'HTTPS proxy: this browser only'],
};
let SET;
try { SET = Object.assign({}, DEFAULT_SET, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch { SET = { ...DEFAULT_SET }; }
const saveSet = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(SET)); } catch { /* storage unavailable */ } };
if (EXT) {
  try { Object.assign(SET, await new Promise((r) => chrome.storage.local.get('settings', (v) => r(v.settings || {})))); } catch { /* defaults */ }
  SET.proto = 'proxy';
}
if (ANDROID) {
  try { Object.assign(SET, await androidCall('settings')); } catch { /* defaults */ }
  if (!['wireguard', 'ikev2'].includes(SET.proto)) SET.proto = 'wireguard';
}
if (!PROTOS[SET.proto]) SET.proto = 'wireguard';   // older saved labels

// ---------------------------------------------------------------- helpers
const fmt = (n, d = 1) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => { n = Number(n || 0); const d = n > 0 && n < 1 ? 3 : n < 100 ? 2 : 0; return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
const hms = (s) => [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
// Two-letter country code from a flag emoji (regional indicator pair), shown instead of the emoji.
const cc = (flag = '') => [...flag].map((c) => c.codePointAt(0) - 0x1f1e6).filter((n) => n >= 0 && n < 26).map((n) => String.fromCharCode(65 + n)).join('');
const plural = (n, w) => `${fmtInt(n)} ${w}${Math.round(n) === 1 ? '' : 's'}`;
const pct = (w) => (!w ? '0%' : w < 1e-4 ? '<0.01%' : `${(w * 100).toPrecision(2)}%`);
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); };
const errText = (e) => ({ not_connected: 'Connect first', no_wallet: 'Link a FIRM Wallet first', bad_solana_address: 'That is not a valid Solana address', server_offline: 'That server is offline', tor_unavailable: 'This location has no Tor exit yet. Pick another, or turn Tor off', wallet_in_use: 'That wallet is linked to too many accounts', rate_limited: 'Too many attempts, try again shortly', ikev2_unavailable: 'This location has no IKEv2 yet. Pick another, or switch protocol', openvpn_unavailable: 'This location has no OpenVPN yet. Pick another', wireguard_unavailable: 'This location has no WireGuard yet. Pick another', vless_unavailable: 'This location has no VLESS yet. Pick another, or turn VLESS off', 'vless-ws_unavailable': 'This location has no VLESS over WebSocket yet. Turn WebSocket on at the server, or pick another', shadowsocks_unavailable: 'This location has no Shadowsocks yet. Pick another, or turn Shadowsocks off', 'shadowsocks-ws_unavailable': 'This location has no Shadowsocks over WebSocket yet. Turn WebSocket on at the server, or pick another', ikev2_needs_android_11: 'IKEv2 needs Android 11 or later', vpn_permission_denied: 'VPN permission was not given', demo_manual: 'Set-ups for other devices come from the app or the browser extension', webcrypto_x25519: 'This browser cannot make WireGuard keys. Update it, or pick OpenVPN' }[e.message] || `Something went wrong (${e.message})`);

// ---------------------------------------------------------------- state
let servers = [], conn = { state: 'off', server: null, since: 0 }, selected = null;
let down = 0, up = 0, statTimer = null;
const srv = (id) => servers.find((s) => s.id === id) || servers[0];

// ---------------------------------------------------------------- navigation
const VIEWS = ['connect', 'servers', 'earn', 'revenue', 'settings'];
const route = () => {
  const h = location.hash.slice(1) === 'community' ? 'revenue' : location.hash.slice(1);
  const v = VIEWS.includes(h) ? h : 'connect';
  VIEWS.forEach((n) => { $(`#view-${n}`).hidden = n !== v; });
  $$('[data-nav]').forEach((a) => (a.dataset.nav === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (v === 'revenue') renderRevenue();
  if (v === 'earn') renderEarn();
  window.scrollTo(0, 0);
};
addEventListener('hashchange', route);

// ---------------------------------------------------------------- connect view
const power = $('#power');
function paintConn() {
  const s = conn.state;
  power.dataset.state = s;
  power.setAttribute('aria-pressed', String(s === 'on'));
  $('#status-word').textContent = { off: 'Not protected.', connecting: 'Connecting.', on: 'Protected.', error: 'Reconnecting.' }[s] || 'Not protected.';
  $('#power-label').textContent = { off: 'Connect', connecting: 'Cancel', on: 'Disconnect', error: 'Disconnect' }[s] || 'Connect';
  const ip = api.ip(s === 'on');
  const tor = s === 'on' && (LIVE ? conn.tor : SET.tor);
  $('#ip-line').textContent = ip ? `IP ${ip}${tor ? ' · via Tor' : ''}` : s === 'on' ? (tor ? 'Tunnel active · via Tor' : 'Tunnel active') : s === 'error' ? (ANDROID || SET.kill ? 'Traffic held' : 'Traffic direct') : 'Unprotected';
  paintShield(); paintNet();
  if (s !== 'on') { $('#st-time').textContent = '00:00:00'; $('#st-down').textContent = $('#st-up').textContent = EXT ? '—' : '0.0 MB'; }
}
function paintStats() {
  if (conn.state !== 'on') return;
  $('#st-time').textContent = hms(Math.floor((Date.now() - conn.since) / 1000));
  if (ANDROID) {
    $('#st-down').textContent = `${fmt((conn.rx || 0) / 1e6)} MB`; $('#st-up').textContent = `${fmt((conn.tx || 0) / 1e6)} MB`;
  } else if (!LIVE) {
    down += Math.random() * 0.9; up += Math.random() * 0.15;
    $('#st-down').textContent = `${fmt(down)} MB`; $('#st-up').textContent = `${fmt(up)} MB`;
  }
}
// Android: this network's protection status, worked out on the phone.
function paintNet() {
  const n = ANDROID && conn.network; const el = $('#net');
  if (!n || n.type === 'none') { el.hidden = true; return; }
  const name = { wifi: 'This Wi-Fi', cellular: 'Mobile data', ethernet: 'This network' }[n.type] || 'This network';
  const safe = conn.state === 'on' || n.protected;
  const risk = { open: ' is not encrypted', wep: ' uses weak encryption', captive: ' needs you to sign in' }[n.risk];
  el.hidden = false; el.classList.toggle('warn', !safe);
  $('#net-text').textContent = safe ? `${name}: protected` : risk ? `${name}${risk}. Connect to protect it.` : `${name}: not protected`;
}
// Tracker blocking: on by default; the node counts what it blocked for this user today (a number only).
let blockedToday = 0;
function paintShield() {
  const on = conn.state === 'on', block = SET.block !== false;
  $('#shield').classList.toggle('on', on && block);
  $('#shield-text').textContent = !block ? 'Tracker blocking off' : on ? 'Blocking trackers' : 'Tracker blocking on';
  $('#shield-count').textContent = on && block ? `${fmtInt(blockedToday)} blocked today` : '';
}
async function renderBlocked() {
  if (conn.state !== 'on' || SET.block === false) return;
  const b = await api.blocked().catch(() => null);
  if (b) { blockedToday = b.blocked; paintShield(); }
}
async function renderToday() {
  const m = await api.me().catch(() => null);
  if (!m) return;
  $('#today-veil').textContent = fmt(m.today.veil, 2);
  $('#day-fill').style.width = `${Math.min(100, m.today.veil / MAX_DAY * 100)}%`;
  $('#day-meter').setAttribute('aria-valuenow', fmt(m.today.veil, 2));
  return m;
}
let attempt = 0;   // a cancelled connect must not repaint when its answer arrives late
power.addEventListener('click', async () => {
  const my = ++attempt;
  try {
    // Connected, reconnecting or still waiting for the first handshake: the button stops the tunnel.
    if (conn.state !== 'off') { conn = { state: 'off' }; paintConn(); conn = await api.disconnect(); down = up = 0; paintConn(); return; }
    conn = { state: 'connecting', server: selected }; paintConn();
    const next = await api.connect(selected);
    if (my !== attempt) return;
    conn = next; paintConn();
    loadAd();
  } catch (e) { if (my !== attempt) return; conn = { state: 'off' }; paintConn(); toast(errText(e)); }
});
$('#location-btn').addEventListener('click', () => { location.hash = 'servers'; });
function renderLoc() {
  const s = srv(selected); if (!s) return;
  $('#loc-cc').textContent = cc(s.flag); $('#loc-name').textContent = `${s.city}, ${s.country}`;
  $('#h-loc').textContent = `${s.city}.`;
}

// ---------------------------------------------------------------- servers view
function renderServers(q = '') {
  q = q.trim().toLowerCase();
  const list = servers.filter((s) => !q || `${s.city} ${s.country}`.toLowerCase().includes(q));
  $('#srv-count').textContent = String(servers.length);
  $('#srv-list').innerHTML = list.length ? list.map((s) => `<li><button type="button" data-id="${s.id}" aria-pressed="${s.id === selected}" ${s.online === false ? 'disabled' : ''}><span class="cc mono">${cc(s.flag)}</span><span>${s.city}<small>${s.country}${s.tor ? ' · Tor' : ''}${s.online === false ? ' · offline' : ''}</small></span><span class="load" title="Load ${s.load}%"><i style="width:${s.load}%"></i></span><span class="ping mono">${s.load}%</span></button></li>`).join('')
    : '<li class="fine" style="padding:16px 0">No match.</li>';
}
$('#srv-search').addEventListener('input', (e) => renderServers(e.target.value));
$('#srv-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  selected = b.dataset.id;
  try { localStorage.setItem('veil-vpn-server', selected); } catch { /* ignore */ }
  renderLoc(); renderServers($('#srv-search').value);
  location.hash = 'connect';
  if (conn.state === 'on') { conn = await api.disconnect(); paintConn(); power.click(); }
});

// ---------------------------------------------------------------- ads
let currentAd = null;
async function loadAd() {
  const a = await api.ad(srv(selected)?.region || 'global').catch(() => null);
  if (!a) return;
  currentAd = a;
  $('#ad-body').innerHTML = `<span class="ad-logo">${a.mark}</span><p><strong>${a.title}</strong>${a.body}</p>`;
  if (conn.state === 'on' && document.visibilityState === 'visible') api.adEvent(a.id, 'view').catch(() => {});
}
$('#ad-body').addEventListener('click', () => {
  if (!currentAd) return;
  if (conn.state === 'on') api.adEvent(currentAd.id, 'click').then(() => { if (!$('#view-revenue').hidden) renderRevenue(); }).catch(() => {});
  if (currentAd.url) window.open(currentAd.url, '_blank', 'noopener');
});
setInterval(loadAd, 30_000);

// ---------------------------------------------------------------- earn view
// Why the server stopped crediting minutes (fraud protection), in plain words.
const HOLD = {
  under_review: 'this account is under review.',
  device_limit: 'another account on this device already earned today.',
  device_unverified: 'update the app to keep earning.',
  network_limit: 'too many accounts are earning on this network today.',
  daily_limit: 'this wallet reached the daily limit.',
};
async function renderEarn() {
  const [m, p] = await Promise.all([api.me().catch(() => null), api.pool().catch(() => null)]);
  if (!m) return;
  $('#k-today').textContent = fmt(m.today.veil, 2);
  $('#k-pending').textContent = fmt(m.pending, 2);
  $('#k-life').textContent = fmt(m.lifetime, 2);
  const hold = HOLD[m.hold]; $('#earn-hold').hidden = !hold; $('#earn-hold').textContent = hold ? `Rewards paused: ${hold}` : '';
  const est = p ? memberShare({ poolUsd: p.poolUsd, myMinutes: m.today.minutes, totalMinutes: Math.max(p.minutes, m.today.minutes), boost: p.boost, price: p.refPrice }) : { veil: 0 };
  $('#k-share').textContent = fmt(est.veil, 2);
  $('#wallet-addr').textContent = m.wallet ? `${m.wallet.slice(0, 6)}…${m.wallet.slice(-6)}` : 'Not linked';
  $('#claim').disabled = !m.wallet || !(m.claimable > 0.0001);
  paintWallet(m.wallet);
}
$('#claim').addEventListener('click', async () => {
  try { const r = await api.claim(); toast(r.queued ? 'Claim queued' : 'Nothing to claim'); renderEarn(); }
  catch (e) { toast(errText(e)); }
});

// ---------------------------------------------------------------- ad revenue view
async function renderRevenue() {
  const r = await api.revenue().catch(() => null);
  if (!r) return;
  const p = r.today, m = r.mine;
  $('#epoch').textContent = Math.floor((Date.now() - Date.UTC(2026, 10, 1)) / 864e5) + 1;
  $('#rev-source').textContent = p.revenueSource === 'reported' ? 'Reported' : 'Estimated';
  $('#r-rev').textContent = usd(p.revenueUsd);
  $('#r-ads').textContent = `${plural(p.views, 'view')} · ${plural(p.clicks, 'click')}`;
  $('#r-pool').textContent = usd(p.poolUsd);
  $('#r-pct').textContent = `${p.percent.community}% · ${p.tier}`;
  $('#r-mine').textContent = usd(m.usd);
  $('#r-mine-sub').textContent = `${plural(m.views, 'view')} · ${plural(m.clicks, 'click')}`;
  $('#r-share').textContent = fmt(m.shareVeil, 2);
  $('#r-share-sub').textContent = `$VEIL · ${pct(m.weight)}`;
  $('#history').innerHTML = r.history.length
    ? r.history.map((h) => `<tr><th scope="row" class="mono">${h.day.slice(5)}</th><td class="mono">${usd(h.revenueUsd)}</td><td class="mono">${usd(h.poolUsd)}</td><td class="mono">${h.minutes}</td><td class="mono">${h.minutes ? fmt(h.myVeil, 2) : '—'}</td></tr>`).join('')
    : '<tr class="empty"><td colspan="5">None yet</td></tr>';
  const t = tierOf(p.members);
  const parts = [t[2], t[3], t[4], t[5], t[6]];
  $$('.split span').forEach((s, i) => s.style.setProperty('--w', parts[i]));
  $$('.legend b').forEach((b, i) => { b.textContent = `${parts[i]}%`; });
  $('.split').setAttribute('aria-label', `Ad revenue split: ${parts[0]}% community pool, ${parts[1]}% network and servers, ${parts[2]}% ecosystem development, ${parts[3]}% liquidity, ${parts[4]}% team`);
  $('#tier-body').innerHTML = TIERS.map((x, i) => {
    const next = TIERS[i + 1];
    const range = next ? `${fmtInt(x[1])} – ${fmtInt(next[1] - 1)}` : `${fmtInt(x[1])}+`;
    return `<tr class="${x === t ? 'current' : ''}"><th scope="row">${x[0]}</th><td class="mono">${range}</td><td>${x[2]}%</td><td>${x[7].toFixed(2)}×</td></tr>`;
  }).join('');
  const next = TIERS[TIERS.indexOf(t) + 1];
  if (next) {
    $('#tier-fill').style.width = `${(p.members - t[1]) / (next[1] - t[1]) * 100}%`;
    $('#tier-next').textContent = `${fmtInt(next[1] - p.members)} to ${next[0]}`;
  } else { $('#tier-fill').style.width = '100%'; $('#tier-next').textContent = ''; }
}
$('#invite').addEventListener('click', async () => {
  const url = 'https://infinitumveilvpn.app/';
  try { await navigator.clipboard.writeText(url); toast('Copied'); } catch { toast(url); }
});

// ---------------------------------------------------------------- settings view
function paintWallet(w) {
  $('#wallet-input').value = w || '';
  $('#wallet-input').disabled = !!w;
  $('#link-wallet').textContent = w ? 'Unlink' : 'Link';
}
$('#wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const cur = $('#wallet-input').disabled;
    const addr = cur ? null : $('#wallet-input').value.trim();
    if (addr !== null && !SOLANA_RE.test(addr)) return toast('Invalid Solana address');
    const m = await api.setWallet(addr);
    paintWallet(m.wallet); toast(m.wallet ? 'Linked' : 'Unlinked');
  } catch (err) { toast(errText(err)); }
});
$$('[data-set]').forEach((el) => {
  const k = el.dataset.set;
  if (el.type === 'checkbox') el.checked = !!SET[k]; else el.value = SET[k];
  el.addEventListener('change', () => {
    // Tor needs a location that offers it; say so instead of breaking the connection.
    if (k === 'tor' && el.checked && LIVE && srv(selected)?.tor === false) { el.checked = false; return toast(errText(new Error('tor_unavailable'))); }
    SET[k] = el.type === 'checkbox' ? el.checked : el.value; saveSet();
    if (LIVE && k !== 'earn') api.call('setting', { key: k, value: SET[k] }).catch(() => {});
    if (k === 'earn') api.setEarn(SET[k]);
    if (k === 'proto') paintProto();
    if (k === 'vless' || k === 'shadowsocks' || k === 'ws') paintDevices();
    // Tor and tracker blocking are set per connection: the app reconnects to apply them.
    if (k === 'block') paintShield();
    if ((k === 'tor' || k === 'block') && conn.state === 'on') {
      toast(k === 'block' ? (SET.block ? 'Tracker blocking on' : 'Tracker blocking off') : SET.tor ? 'Reconnecting through Tor' : 'Leaving Tor');
      if (LIVE) setTimeout(async () => { try { conn = await api.state(); paintConn(); } catch { /* next poll */ } }, 2500);
      else paintConn();
    }
    if (k === 'kill' && ANDROID) toast('Turn on Always-on VPN');
  });
});

// ---------------------------------------------------------------- boot
const protoOptions = (ids) => ids.map((id) => `<option value="${id}">${PROTOS[id][0]}${id === 'ikev2' ? '/IPsec' : ''}</option>`).join('');
if (EXT) {
  $('.proto-note').textContent = '';
  $('[data-set="proto"]').innerHTML = protoOptions(['proxy']);
}
if (ANDROID) {
  $$('.android-only').forEach((el) => { el.hidden = false; });
  $('.proto-note').textContent = '';
  $('[data-set="proto"]').innerHTML = protoOptions(SET.ikev2 === false ? ['wireguard'] : ['wireguard', 'ikev2']);
}
$('[data-set="proto"]').value = SET.proto;
function paintProto() {
  const [label, hint] = PROTOS[SET.proto] || PROTOS.wireguard;
  $('#st-proto').textContent = label;
  $('#proto-hint').textContent = hint;
}
paintProto();

// ---------------------------------------------------------------- other devices
// VLESS and Shadowsocks are off until the matching Settings switch is on. WebSocket is its own switch.
const DEVICE_BASE = [
  ['wireguard', 'WireGuard · .conf file (WireGuard app)'],
  ['openvpn', 'OpenVPN · .ovpn file (OpenVPN Connect)'],
  ['ikev2', 'IKEv2 · built into iPhone, Mac and Windows'],
];
function paintDevices() {
  const ids = [...DEVICE_BASE];
  if (SET.vless) ids.push(['vless', 'VLESS Reality · link, Xray and sing-box']);
  if (SET.shadowsocks) ids.push(['shadowsocks', 'Shadowsocks-2022 · ss:// link, Xray and sing-box']);
  if (SET.ws && SET.vless) ids.push(['vless-ws', 'VLESS over WebSocket + TLS · port 443']);
  if (SET.ws && SET.shadowsocks) ids.push(['shadowsocks-ws', 'Shadowsocks over WebSocket + TLS · port 443']);
  const sel = $('#dev-proto');
  const cur = sel.value;
  sel.innerHTML = ids.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  sel.value = ids.some(([v]) => v === cur) ? cur : 'wireguard';
}
paintDevices();
// WireGuard keys are made here (WebCrypto X25519); only the public key goes to the server.
const b64 = (u8) => btoa(String.fromCharCode(...u8));
async function wgKeys() {
  let kp;
  try { kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']); } catch { throw new Error('webcrypto_x25519'); }
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return { publicKey: b64(pub), privateKey: b64(pkcs8.slice(-32)) };
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fileName = (sv, ext) => `veil-${String(sv?.city || 'vpn').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${ext}`;
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
const until = (exp) => new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
$('#dev-get').addEventListener('click', async () => {
  const mode = $('#dev-proto').value; const sv = srv(selected); const out = $('#dev-out');
  const btn = $('#dev-get'); btn.disabled = true;
  try {
    if (!sv) throw new Error('unknown_server');
    if (LIVE && sv.modes && !sv.modes.includes(mode)) throw new Error(`${mode}_unavailable`);
    const keys = mode === 'wireguard' ? await wgKeys() : null;
    const r = await api.manual(sv.id, mode, keys?.publicKey);
    let html = '';
    if (mode === 'wireguard') {
      const w = r.wireguard;
      const conf = ['[Interface]', `PrivateKey = ${keys.privateKey}`, `Address = ${w.address}`, `DNS = ${w.dns}`, '', '[Peer]',
        `PublicKey = ${w.peerPublicKey}`, `AllowedIPs = ${w.allowedIps}`, `Endpoint = ${w.endpoint}`, `PersistentKeepalive = ${w.keepalive}`, ''].join('\n');
      download(fileName(sv, 'conf'), conf);
      html = `<p>Saved <b>${esc(fileName(sv, 'conf'))}</b>. Import it in the WireGuard app. Its private key was made on this device and is in the file only: keep it to yourself. Valid until ${until(r.exp)}.</p>`;
    } else if (mode === 'openvpn') {
      download(fileName(sv, 'ovpn'), r.openvpn.profile);
      html = `<p>Saved <b>${esc(fileName(sv, 'ovpn'))}</b>. Import it in OpenVPN Connect and sign in with:</p>
        <dl><dt>Username</dt><dd class="mono">${esc(r.openvpn.username)}</dd><dt>Password</dt><dd class="mono">${esc(r.openvpn.password)}</dd></dl><p>Valid until ${until(r.exp)}.</p>`;
    } else if (mode === 'vless' || mode === 'vless-ws' || mode === 'shadowsocks' || mode === 'shadowsocks-ws') {
      const key = mode === 'vless-ws' ? 'vlessWs' : mode === 'shadowsocks-ws' ? 'shadowsocksWs' : mode;
      const b = r[key];
      if (!b?.link) throw new Error('bad_setup');
      download(fileName(sv, 'xray.json'), `${JSON.stringify(b.xray, null, 2)}\n`);
      setTimeout(() => download(fileName(sv, 'singbox.json'), `${JSON.stringify(b.singbox, null, 2)}\n`), 400);
      html = `<p>Saved an Xray config and a sing-box config. Import either one, or paste this link. It keeps working until this server's keys are rotated, and it does not use Tor.</p>
        <dl><dt>Link</dt><dd class="mono">${esc(b.link)}</dd></dl>
        <p>The link is a password for this server. Keep it to yourself. Tracker blocking follows the node's DNS filter.</p>`;
    } else {
      const k = r.ikev2;
      html = `<p>Add a VPN of type <b>IKEv2</b> (Settings → VPN on iPhone and Mac; Settings → Network → VPN on Windows):</p>
        <dl><dt>Server</dt><dd class="mono">${esc(k.server)}</dd><dt>Remote ID</dt><dd class="mono">${esc(k.remoteId)}</dd>
        <dt>Sign-in</dt><dd>Username and password (EAP-MSCHAPv2)</dd><dt>Username</dt><dd class="mono">${esc(k.username)}</dd><dt>Password</dt><dd class="mono">${esc(k.password)}</dd></dl>
        <p>Leave Local ID empty. Valid until ${until(r.exp)}.</p>`;
    }
    out.innerHTML = html; out.hidden = false;
  } catch (e) { toast(errText(e)); }
  finally { btn.disabled = false; }
});
api.setEarn(SET.earn);
try {
  servers = await api.servers();
  conn = await api.state();
  let saved = null; try { saved = localStorage.getItem('veil-vpn-server'); } catch { /* ignore */ }
  selected = conn.server || (servers.some((s) => s.id === saved) ? saved : servers[0]?.id);
} catch (e) { toast('Offline'); }
renderLoc(); renderServers(); paintConn(); renderToday(); loadAd(); route();
statTimer = setInterval(async () => {
  if (LIVE) {
    const s = await api.state().catch(() => null);
    if (s) {
      const changed = s.state !== conn.state || JSON.stringify(s.network) !== JSON.stringify(conn.network);
      conn = s; if (changed) paintConn();
    }
  }
  paintStats();
}, 1000);
setInterval(() => {
  renderToday(); renderBlocked();
  if (!$('#view-revenue').hidden) renderRevenue();
  if (!$('#view-earn').hidden) renderEarn();
}, LIVE ? 10_000 : 2000);
if (SET.auto && conn.state === 'off' && !LIVE) power.click();
if ('serviceWorker' in navigator && !LIVE && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
