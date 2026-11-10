// VLESS (XTLS Reality and WebSocket) and Shadowsocks-2022 for VEIL nodes.
//
// The server is Xray-core (MPL-2.0). sing-box is GPL and this repo does not ship or copy it;
// `singbox` below is a client config we generate so people can import it. Share links are
// vless:// and SIP002 ss://. Secrets (UUID, Shadowsocks password, Reality private key) are
// created per node. The private key never leaves the server. The UUID and password are client
// credentials, same class as the OpenVPN tls-crypt key: they belong in the control server's
// NODES list, not in a public repository, and not in GET /v1/servers.
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const XRAY_VERSION = 'v26.11.9';
// SHA2-256 of the official release zips. provision.sh repeats these; a unit test keeps them in sync.
export const XRAY_SHA256 = {
  'Xray-linux-64.zip': 'b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82',
  'Xray-linux-arm64-v8a.zip': '64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be',
};

export const DEFAULTS = {
  realityPort: 2053,
  ssPort: 16080,
  wsPort: 443,
  vlessWsLocal: 10481,
  ssWsLocal: 10482,
  ssMethod: '2022-blake3-aes-128-gcm',
  fingerprint: 'chrome',
  flow: 'xtls-rprx-vision',
  dns: '10.66.0.1',
};

export const SS_METHODS = ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'];
export const PROXY_MODES = ['vless', 'vless-ws', 'shadowsocks', 'shadowsocks-ws'];
// Ports the rest of provision.sh already claims. Reality and Shadowsocks must not take them.
const RESERVED = new Set([22, 80, 443, 500, 4500, 1194, 51820, 9101, 9102]);
// Same ranges node.js refuses, plus the mail ports the firewall drops.
const PRIVATE_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8',
];

const portOk = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const hostOk = (h) => {
  if (typeof h !== 'string' || h.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every((n) => Number(n) <= 255);
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(h);
};
const pathOk = (p) => typeof p === 'string' && /^\/[A-Za-z0-9/_-]{16,200}$/.test(p) && !p.includes('..');
const uuidOk = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const shortOk = (s) => typeof s === 'string' && /^[0-9a-f]+$/i.test(s) && s.length >= 2 && s.length <= 16 && s.length % 2 === 0;

function decodeKey(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/_-]+=*$/.test(s) || s.length > 128) return null;
  const url = s.includes('-') || s.includes('_');
  const buf = Buffer.from(s, url ? 'base64url' : 'base64');
  const back = buf.toString(url ? 'base64url' : 'base64').replace(/=+$/, '');
  if (back !== s.replace(/=+$/, '')) return null;
  return buf;
}
const ssKeyLen = (method) => (method === '2022-blake3-aes-128-gcm' ? 16 : method === '2022-blake3-aes-256-gcm' || method === '2022-blake3-chacha20-poly1305' ? 32 : 0);

function hostPort(s) {
  const m = /^(.*):(\d+)$/.exec(String(s || ''));
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, '');
  const port = Number(m[2]);
  if (!hostOk(host) || !portOk(port)) return null;
  return { host, port };
}

// ---------- node JSON (what provision prints and NODES stores) ----------
export function issues(n) {
  const bad = [];
  if (!n || typeof n !== 'object') return ['node must be an object'];
  if (n.vless != null) {
    const v = n.vless;
    if (!v || typeof v !== 'object') bad.push('vless must be an object');
    else {
      if (!uuidOk(v.id)) bad.push('vless.id must be a UUID');
      if (!hostOk(v.host)) bad.push('vless.host must be a hostname');
      if (!v.reality && !v.ws) bad.push('vless needs reality, ws, or both');
      if (v.reality) {
        const r = v.reality;
        if (!portOk(r.port)) bad.push('vless.reality.port must be a port');
        else if (RESERVED.has(r.port)) bad.push('vless.reality.port is already used by another VEIL service');
        if (decodeKey(r.publicKey)?.length !== 32) bad.push('vless.reality.publicKey must be 32 bytes');
        if (!shortOk(r.shortId)) bad.push('vless.reality.shortId must be 2–16 hex chars');
        if (!hostOk(r.sni)) bad.push('vless.reality.sni must be a hostname');
        if (r.fingerprint != null && !/^[a-z0-9]{2,20}$/.test(r.fingerprint)) bad.push('vless.reality.fingerprint is not a known form');
        if (r.flow != null && r.flow !== DEFAULTS.flow) bad.push('vless.reality.flow must be xtls-rprx-vision');
      }
      if (v.ws) bad.push(...wsIssues('vless.ws', v.ws));
    }
  }
  if (n.shadowsocks != null) {
    const s = n.shadowsocks;
    if (!s || typeof s !== 'object') bad.push('shadowsocks must be an object');
    else {
      if (!hostOk(s.host)) bad.push('shadowsocks.host must be a hostname');
      if (!SS_METHODS.includes(s.method)) bad.push('shadowsocks.method must be a Shadowsocks-2022 cipher');
      if (decodeKey(s.password)?.length !== ssKeyLen(s.method)) bad.push('shadowsocks.password must be the base64 key for its cipher');
      if (!portOk(s.port)) bad.push('shadowsocks.port must be a port');
      else if (RESERVED.has(s.port)) bad.push('shadowsocks.port is already used by another VEIL service');
      if (s.ws) bad.push(...wsIssues('shadowsocks.ws', s.ws));
    }
  }
  if (n.vless?.reality && n.shadowsocks && n.vless.reality.port === n.shadowsocks.port) bad.push('vless and shadowsocks ports must differ');
  return bad;
}
function wsIssues(label, w) {
  const bad = [];
  if (!w || typeof w !== 'object') return [`${label} must be an object`];
  if (!portOk(w.port)) bad.push(`${label}.port must be a port`);
  if (!pathOk(w.path)) bad.push(`${label}.path must be a long absolute path`);
  if (!hostOk(w.host)) bad.push(`${label}.host must be a hostname`);
  if (!hostOk(w.sni)) bad.push(`${label}.sni must be a hostname`);
  if (w.tls !== true) bad.push(`${label}.tls must be true`);
  return bad;
}

export function modesOf(n) {
  return ['proxy',
    ...(n?.wg ? ['wireguard'] : []),
    ...(n?.ikev2 ? ['ikev2'] : []),
    ...(n?.openvpn ? ['openvpn'] : []),
    ...(n?.vless?.reality ? ['vless'] : []),
    ...(n?.vless?.ws ? ['vless-ws'] : []),
    ...(n?.shadowsocks?.password ? ['shadowsocks'] : []),
    ...(n?.shadowsocks?.ws ? ['shadowsocks-ws'] : [])];
}

const SERVICE_KEY = { vless: 'vless', 'vless-ws': 'vlessWs', shadowsocks: 'shadowsocks', 'shadowsocks-ws': 'shadowsocksWs' };
export function responseKey(mode) { return SERVICE_KEY[mode]; }
// True when the agent probed this inbound and it was down. Missing probes do not fail the node:
// older agents, and nodes that do not run Xray, omit `services`.
export function serviceBlocks(services, mode) {
  const key = SERVICE_KEY[mode];
  return !!(key && services && typeof services === 'object' && services[key] === false);
}

// ---------- keys ----------
export function realityKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  // Xray's `x25519` prints this raw key as "Password (PublicKey)". Checked against 26.11.9.
  return {
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)).toString('base64url'),
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('base64url'),
  };
}
export function ssPassword(method = DEFAULTS.ssMethod) {
  const n = ssKeyLen(method);
  if (!n) throw new Error('not a Shadowsocks-2022 cipher');
  return randomBytes(n).toString('base64');
}

// ---------- server config (on the node; holds the Reality private key) ----------
export function serverConfig(node, opt = {}) {
  const inbounds = [];
  const listen = opt.listen || '0.0.0.0';
  // routeOnly: use the sniffed name for routing, and still dial the address the client sent.
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true };
  if (node.vless?.reality) {
    if (decodeKey(opt.realityPrivateKey)?.length !== 32) throw new Error('missing reality private key');
    if (!hostPort(opt.realityDest || '')) throw new Error('reality dest must be host:port');
    const r = node.vless.reality;
    inbounds.push({
      listen, port: r.port, protocol: 'vless', tag: 'vless-reality',
      settings: { clients: [{ id: node.vless.id, flow: r.flow || DEFAULTS.flow }], decryption: 'none' },
      streamSettings: {
        network: 'tcp', security: 'reality',
        realitySettings: {
          show: false, dest: opt.realityDest, xver: 0,
          serverNames: [r.sni], privateKey: opt.realityPrivateKey, shortIds: [String(r.shortId).toLowerCase()],
        },
      },
      sniffing,
    });
  }
  if (node.vless?.ws) {
    inbounds.push({
      listen: '127.0.0.1', port: opt.vlessWsLocal, protocol: 'vless', tag: 'vless-ws',
      settings: { clients: [{ id: node.vless.id }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: node.vless.ws.path, host: node.vless.ws.host } },
      sniffing,
    });
  }
  if (node.shadowsocks?.password) {
    const s = node.shadowsocks;
    inbounds.push({
      listen, port: s.port, protocol: 'shadowsocks', tag: 'ss',
      settings: { method: s.method, password: s.password, network: 'tcp,udp' },
      sniffing,
    });
  }
  if (node.shadowsocks?.ws) {
    const s = node.shadowsocks;
    inbounds.push({
      listen: '127.0.0.1', port: opt.ssWsLocal, protocol: 'shadowsocks', tag: 'ss-ws',
      settings: { method: s.method, password: s.password, network: 'tcp' },
      streamSettings: { network: 'ws', wsSettings: { path: s.ws.path, host: s.ws.host } },
      sniffing,
    });
  }
  if (!inbounds.length) throw new Error('no Xray inbounds');
  const rules = [{ type: 'field', port: '25,465,587', outboundTag: 'block' }];
  if (!opt.allowPrivate) rules.unshift({ type: 'field', ip: PRIVATE_CIDRS, outboundTag: 'block' });
  // Xray 26 also blackholes private addresses on VLESS and Shadowsocks. The loopback
  // smoke test opts out with an allow rule; a real node keeps the default.
  const direct = {
    protocol: 'freedom', tag: 'direct',
    streamSettings: { sockopt: { domainStrategy: 'UseIP' } },
    ...(opt.allowPrivate ? { settings: { finalRules: [{ action: 'allow', ip: ['127.0.0.0/8', '::1/128'] }] } } : {}),
  };
  return {
    // No access log and no error log of destinations. journald is already volatile.
    log: { loglevel: 'none' },
    dns: { servers: [opt.dns || DEFAULTS.dns], queryStrategy: 'UseIPv4', disableFallback: true },
    inbounds,
    outbounds: [direct, { protocol: 'blackhole', tag: 'block' }],
    routing: { domainStrategy: 'IPIfNonMatch', rules },
  };
}

// ---------- client links and configs ----------
function vlessLink({ id, host, port, query, name }) {
  const u = new URL(`vless://${id}@${host}:${port}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  u.hash = name;
  return u.toString();
}
function ssLink({ method, password, host, port, query, name }) {
  // SIP002: base64url(method:password) as the userinfo. Query is only for the WebSocket form.
  const user = Buffer.from(`${method}:${password}`).toString('base64url');
  const u = new URL(`ss://${user}@${host}:${port}`);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  u.hash = name;
  return u.toString();
}

function xrayClient({ socksPort, outbound }) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1', port: socksPort, protocol: 'socks', tag: 'socks',
      settings: { udp: true }, sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    }],
    outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
    // AsIs: domain names go to the node unresolved, so DNS stays on the node.
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }] },
  };
}
function singboxDocument(proxy, socksPort) {
  return {
    log: { level: 'warn' },
    inbounds: [{ type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: socksPort, sniff: true }],
    outbounds: [proxy, { type: 'direct', tag: 'direct' }],
    route: { final: 'proxy' },
  };
}
function tlsBlock(sni, opt) {
  const tls = { enabled: true, server_name: sni };
  if (opt.allowInsecure) tls.insecure = true;
  return tls;
}

export function clientBundle(node, mode, opt = {}) {
  const name = opt.name || `VEIL ${node.city || node.id || 'VPN'}`;
  const socksPort = opt.socksPort || 10808;
  if (mode === 'vless' || mode === 'vless-ws') {
    const v = node.vless;
    if (!v) throw new Error('vless_unavailable');
    if (mode === 'vless') {
      const r = v.reality;
      if (!r) throw new Error('vless_unavailable');
      const host = opt.address || v.host;
      const port = opt.port || r.port;
      const sni = r.sni;
      const fp = r.fingerprint || DEFAULTS.fingerprint;
      const flow = r.flow || DEFAULTS.flow;
      const link = vlessLink({
        id: v.id, host, port, name,
        query: { encryption: 'none', flow, security: 'reality', sni, fp, pbk: r.publicKey, sid: String(r.shortId).toLowerCase(), type: 'tcp', headerType: 'none' },
      });
      const xray = xrayClient({
        socksPort,
        outbound: {
          protocol: 'vless', tag: 'proxy',
          settings: { vnext: [{ address: host, port, users: [{ id: v.id, encryption: 'none', flow }] }] },
          streamSettings: {
            network: 'tcp', security: 'reality',
            realitySettings: { serverName: sni, fingerprint: fp, publicKey: r.publicKey, shortId: String(r.shortId).toLowerCase(), spiderX: '/' },
          },
        },
      });
      const singbox = singboxDocument({
        type: 'vless', tag: 'proxy', server: host, server_port: port, uuid: v.id, flow,
        tls: { ...tlsBlock(sni, opt), utls: { enabled: true, fingerprint: fp }, reality: { enabled: true, public_key: r.publicKey, short_id: String(r.shortId).toLowerCase() } },
      }, socksPort);
      return { link, xray, singbox, persistent: true, host, port, sni };
    }
    const w = v.ws;
    if (!w) throw new Error('vless-ws_unavailable');
    return wsVlessBundle(v, w, name, socksPort, opt);
  }
  if (mode === 'shadowsocks' || mode === 'shadowsocks-ws') {
    const s = node.shadowsocks;
    if (!s?.password) throw new Error('shadowsocks_unavailable');
    if (mode === 'shadowsocks-ws') {
      if (!s.ws) throw new Error('shadowsocks-ws_unavailable');
      return wsSsBundle(s, name, socksPort, opt);
    }
    const host = opt.address || s.host;
    const port = opt.port || s.port;
    const link = ssLink({ method: s.method, password: s.password, host, port, name });
    const xray = xrayClient({
      socksPort,
      outbound: { protocol: 'shadowsocks', tag: 'proxy', settings: { servers: [{ address: host, port, method: s.method, password: s.password }] } },
    });
    const singbox = singboxDocument({ type: 'shadowsocks', tag: 'proxy', server: host, server_port: port, method: s.method, password: s.password }, socksPort);
    return { link, xray, singbox, persistent: true, host, port, method: s.method };
  }
  throw new Error('unknown_mode');
}

function wsStream(w, opt) {
  const host = opt.address || w.host;
  const port = opt.port || w.port;
  const tls = opt.tls === false ? false : w.tls === true;
  const headerHost = w.host;
  const xrayWs = {
    network: 'ws', security: tls ? 'tls' : 'none',
    wsSettings: { path: w.path, host: headerHost },
    ...(tls ? { tlsSettings: { serverName: w.sni, ...(opt.pinnedPeerCertSha256 ? { pinnedPeerCertSha256: opt.pinnedPeerCertSha256 } : {}) } } : {}),
  };
  const singTls = tls ? tlsBlock(w.sni, opt) : { enabled: false };
  const transport = { type: 'ws', path: w.path, headers: { Host: headerHost } };
  return { host, port, tls, xrayWs, singTls, transport, headerHost };
}
function wsVlessBundle(v, w, name, socksPort, opt) {
  const t = wsStream(w, opt);
  const query = { encryption: 'none', security: t.tls ? 'tls' : 'none', sni: w.sni, type: 'ws', host: t.headerHost, path: w.path };
  const link = vlessLink({ id: v.id, host: t.host, port: t.port, name, query });
  const xray = xrayClient({
    socksPort,
    outbound: {
      protocol: 'vless', tag: 'proxy',
      settings: { vnext: [{ address: t.host, port: t.port, users: [{ id: v.id, encryption: 'none' }] }] },
      streamSettings: t.xrayWs,
    },
  });
  const singbox = singboxDocument({
    type: 'vless', tag: 'proxy', server: t.host, server_port: t.port, uuid: v.id,
    tls: t.singTls, transport: t.transport,
  }, socksPort);
  return { link, xray, singbox, persistent: true, host: t.host, port: t.port, sni: w.sni, path: w.path };
}
function wsSsBundle(s, name, socksPort, opt) {
  const t = wsStream(s.ws, opt);
  // Not v2ray-plugin: that plugin cannot carry a 2022 cipher. The query uses the same
  // parameter names as a vless:// link. Xray JSON and sing-box JSON are the supported imports.
  const link = ssLink({
    method: s.method, password: s.password, host: t.host, port: t.port, name,
    query: { type: 'ws', security: t.tls ? 'tls' : 'none', host: t.headerHost, path: s.ws.path, sni: s.ws.sni },
  });
  const xray = xrayClient({
    socksPort,
    outbound: {
      protocol: 'shadowsocks', tag: 'proxy',
      settings: { servers: [{ address: t.host, port: t.port, method: s.method, password: s.password }] },
      streamSettings: t.xrayWs,
    },
  });
  const singbox = singboxDocument({
    type: 'shadowsocks', tag: 'proxy', server: t.host, server_port: t.port, method: s.method, password: s.password,
    tls: t.singTls, transport: t.transport,
  }, socksPort);
  return { link, xray, singbox, persistent: true, host: t.host, port: t.port, sni: s.ws.sni, path: s.ws.path, method: s.method };
}

// ---------- what provision.sh asks for ----------
function num(v, d) { return v == null || v === '' ? d : Number(v); }

export function normalizeProvision(opt) {
  const o = {
    vless: !!opt.vless, shadowsocks: !!opt.shadowsocks, ws: !!opt.ws,
    domain: opt.domain,
    vlessPort: num(opt.vlessPort, DEFAULTS.realityPort),
    ssPort: num(opt.ssPort, DEFAULTS.ssPort),
    sni: opt.sni || opt.domain,
    realityDest: opt.realityDest || '127.0.0.1:443',
    fingerprint: opt.fingerprint || DEFAULTS.fingerprint,
    method: opt.method || DEFAULTS.ssMethod,
    wsPort: num(opt.wsPort, DEFAULTS.wsPort),
    wsHost: opt.wsHost || opt.domain,
    wsSni: opt.wsSni || opt.wsHost || opt.domain,
    vlessWsLocal: num(opt.vlessWsLocal, DEFAULTS.vlessWsLocal),
    ssWsLocal: num(opt.ssWsLocal, DEFAULTS.ssWsLocal),
    dns: opt.dns || DEFAULTS.dns,
    allowPrivate: !!opt.allowPrivate,
    listen: opt.listen || '0.0.0.0',
    state: opt.state || null,
  };
  if (o.ws && !o.vless && !o.shadowsocks) throw new Error('ENABLE_WS=1 needs ENABLE_VLESS=1 or ENABLE_SHADOWSOCKS=1');
  if (!o.vless && !o.shadowsocks) throw new Error('ENABLE_VLESS=1 or ENABLE_SHADOWSOCKS=1 is required');
  if (!hostOk(o.domain)) throw new Error('DOMAIN must be a hostname');
  if (!hostOk(o.sni) || !hostOk(o.wsHost) || !hostOk(o.wsSni)) throw new Error('SNI and WebSocket host must be hostnames');
  if (!/^[a-z0-9]{2,20}$/.test(o.fingerprint)) throw new Error('VLESS_FINGERPRINT is not a known form');
  if (!SS_METHODS.includes(o.method)) throw new Error('SS_METHOD must be a Shadowsocks-2022 cipher');
  if (!hostPort(o.realityDest)) throw new Error('VLESS_DEST must be host:port');
  if (!hostOk(o.dns) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(o.dns)) throw new Error('XRAY_DNS must be a resolver address');
  const publics = [];
  if (o.vless) publics.push(['VLESS_PORT', o.vlessPort]);
  if (o.shadowsocks) publics.push(['SS_PORT', o.ssPort]);
  for (const [name, port] of publics) {
    if (!portOk(port)) throw new Error(`${name} must be a port`);
    if (RESERVED.has(port)) throw new Error(`${name} ${port} is already used by another VEIL service`);
  }
  if (o.vless && o.shadowsocks && o.vlessPort === o.ssPort) throw new Error('VLESS_PORT and SS_PORT must differ');
  if (!portOk(o.wsPort)) throw new Error('WS_PORT must be a port');
  if (o.ws && o.vless && o.shadowsocks && o.vlessWsLocal === o.ssWsLocal) throw new Error('WebSocket local ports must differ');
  for (const [name, port] of [['VLESS_WS_LOCAL', o.vlessWsLocal], ['SS_WS_LOCAL', o.ssWsLocal]]) {
    if (o.ws && !portOk(port)) throw new Error(`${name} must be a port`);
    if (o.ws && (RESERVED.has(port) || publics.some(([, p]) => p === port))) throw new Error(`${name} collides with a public port`);
  }
  return o;
}

function take(prev, key, gen, ok) {
  if (prev && prev[key] != null) {
    if (!ok(prev[key])) throw new Error(`xray state field ${key} is invalid; refusing to rotate keys`);
    return prev[key];
  }
  return gen();
}

function loadKeys(prev) {
  const priv = prev?.realityPrivateKey;
  const pub = prev?.realityPublicKey;
  if (priv == null && pub == null) return realityKeyPair();
  if (decodeKey(priv)?.length !== 32 || decodeKey(pub)?.length !== 32) {
    throw new Error('xray state keys are invalid; refusing to rotate keys');
  }
  return { privateKey: priv, publicKey: pub };
}

export function materialize(opt) {
  const o = normalizeProvision(opt);
  const prev = o.state;
  const keys = loadKeys(prev);
  const state = {
    uuid: take(prev, 'uuid', () => randomUUID(), uuidOk),
    realityPrivateKey: keys.privateKey,
    realityPublicKey: keys.publicKey,
    shortId: take(prev, 'shortId', () => randomBytes(8).toString('hex'), shortOk),
    ssPassword: take(prev, 'ssPassword', () => ssPassword(o.method), (s) => decodeKey(s)?.length === ssKeyLen(o.method)),
    vlessWsPath: take(prev, 'vlessWsPath', () => `/vless/${randomBytes(16).toString('hex')}`, pathOk),
    ssWsPath: take(prev, 'ssWsPath', () => `/ss/${randomBytes(16).toString('hex')}`, pathOk),
  };
  const ws = (path) => ({ port: o.wsPort, path, host: o.wsHost, sni: o.wsSni, tls: true });
  const publicNode = {};
  if (o.vless) {
    publicNode.vless = {
      id: state.uuid, host: o.domain,
      reality: { port: o.vlessPort, publicKey: state.realityPublicKey, shortId: state.shortId, sni: o.sni, fingerprint: o.fingerprint, flow: DEFAULTS.flow },
      ...(o.ws ? { ws: ws(state.vlessWsPath) } : {}),
    };
  }
  if (o.shadowsocks) {
    publicNode.shadowsocks = {
      host: o.domain, method: o.method, password: state.ssPassword, port: o.ssPort,
      ...(o.ws ? { ws: ws(state.ssWsPath) } : {}),
    };
  }
  const bad = issues({ id: 'provision', ...publicNode });
  if (bad.length) throw new Error(bad.join('; '));
  const server = serverConfig({ id: 'provision', ...publicNode }, {
    realityPrivateKey: state.realityPrivateKey, realityDest: o.realityDest,
    vlessWsLocal: o.vlessWsLocal, ssWsLocal: o.ssWsLocal, dns: o.dns, allowPrivate: o.allowPrivate, listen: o.listen,
  });
  return { state, publicNode, server, envText: envText(state, o) };
}

function envText(state, o) {
  const lines = [];
  if (o.vless) lines.push(`XRAY_REALITY_ADDR=127.0.0.1:${o.vlessPort}`);
  if (o.shadowsocks) lines.push(`XRAY_SS_ADDR=127.0.0.1:${o.ssPort}`);
  if (o.vless && o.ws) {
    lines.push(`XRAY_VLESS_WS_ADDR=127.0.0.1:${o.vlessWsLocal}`);
    lines.push(`VLESS_WS_PATH=${state.vlessWsPath}`);
    lines.push(`VLESS_WS_UPSTREAM=127.0.0.1:${o.vlessWsLocal}`);
  }
  if (o.shadowsocks && o.ws) {
    lines.push(`XRAY_SS_WS_ADDR=127.0.0.1:${o.ssWsLocal}`);
    lines.push(`SS_WS_PATH=${state.ssWsPath}`);
    lines.push(`SS_WS_UPSTREAM=127.0.0.1:${o.ssWsLocal}`);
  }
  return `${lines.join('\n')}\n`;
}

function prettyField(key, value) {
  const body = JSON.stringify(value, null, 2).split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n');
  return `  "${key}": ${body}`;
}
// Leading comma, so provision.sh can drop this inside the node object it already prints.
export function fragment(publicNode) {
  const parts = [];
  if (publicNode.vless) parts.push(prettyField('vless', publicNode.vless));
  if (publicNode.shadowsocks) parts.push(prettyField('shadowsocks', publicNode.shadowsocks));
  return parts.length ? `,\n${parts.join(',\n')}` : '';
}

export async function writeProvision(opt, paths) {
  const { readFileSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  let prev = null;
  if (paths.state) {
    try {
      prev = JSON.parse(readFileSync(paths.state, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('xray state is unreadable; refusing to rotate keys');
    }
  }
  const result = materialize({ ...opt, state: prev });
  const write = (file, text, mode) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
  };
  write(paths.state, `${JSON.stringify(result.state, null, 2)}\n`, 0o600);
  write(paths.config, `${JSON.stringify(result.server, null, 2)}\n`, 0o640);
  write(paths.envFile, result.envText, 0o600);
  write(paths.publicFile, `${JSON.stringify(result.publicNode, null, 2)}\n`, 0o600);
  write(paths.fragmentFile, fragment(result.publicNode), 0o600);
  return result;
}

export function xrayAsset(arch = process.arch) {
  const name = { x64: 'Xray-linux-64.zip', arm64: 'Xray-linux-arm64-v8a.zip' }[arch];
  if (!name) throw new Error(`unsupported architecture ${arch}`);
  return {
    version: XRAY_VERSION, name, sha256: XRAY_SHA256[name],
    url: `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${name}`,
  };
}

function optFromEnv(env) {
  return {
    vless: env.ENABLE_VLESS === '1',
    shadowsocks: env.ENABLE_SHADOWSOCKS === '1',
    ws: env.ENABLE_WS === '1',
    domain: env.DOMAIN,
    vlessPort: env.VLESS_PORT,
    ssPort: env.SS_PORT,
    sni: env.VLESS_SNI,
    realityDest: env.VLESS_DEST,
    fingerprint: env.VLESS_FINGERPRINT,
    method: env.SS_METHOD,
    wsPort: env.WS_PORT,
    wsHost: env.WS_HOST,
    wsSni: env.WS_SNI,
    vlessWsLocal: env.VLESS_WS_LOCAL,
    ssWsLocal: env.SS_WS_LOCAL,
    dns: env.XRAY_DNS,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = (msg) => { console.error(msg); process.exit(1); };
  if (process.argv[2] !== 'provision') fail('usage: node shared/proxyproto.js provision');
  const env = process.env;
  for (const k of ['XRAY_STATE', 'XRAY_CONFIG', 'XRAY_ENV', 'XRAY_PUBLIC', 'XRAY_FRAGMENT']) {
    if (!env[k]) fail(`missing ${k}`);
  }
  writeProvision(optFromEnv(env), {
    state: env.XRAY_STATE, config: env.XRAY_CONFIG, envFile: env.XRAY_ENV,
    publicFile: env.XRAY_PUBLIC, fragmentFile: env.XRAY_FRAGMENT,
  }).then((result) => process.stdout.write(JSON.stringify(result.publicNode)), (e) => fail(e.message));
}
