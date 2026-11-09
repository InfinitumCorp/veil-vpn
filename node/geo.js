// Opt-in reader for v2fly geoip.dat (GeoIPList) and geosite.dat (GeoSiteList).
// No protobuf library: the messages used by those files are decoded here.
// The node calls openGeo() and, unless VEIL_GEO_ENABLED=1 or node/geo.config.json
// says enabled, gets null and does not read the .dat files.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GEO_CONFIG = path.join(here, 'geo.config.json');
export const DEFAULT_GEO_DIR = path.resolve(here, '../data/geo');
export const MAX_DAT_BYTES = 64 * 1024 * 1024;
const MAX_REGEX = 256;

const asBuf = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf));

function readVarint(buf, i) {
  let value = 0n;
  let shift = 0n;
  const start = i;
  while (i < buf.length) {
    if (i - start >= 10) throw new Error('protobuf varint too long');
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, pos: i };
    shift += 7n;
  }
  throw new Error('truncated protobuf varint');
}

function utf8(buf) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

// Calls onField(fieldNumber, wireType, value) for each tag. Fixed32/64 fields are skipped.
function walk(buf, onField) {
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.pos;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (!Number.isSafeInteger(field) || field < 1) throw new Error('bad protobuf tag');
    if (wire === 0) {
      const v = readVarint(buf, i);
      i = v.pos;
      onField(field, wire, v.value);
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      i = len.pos;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0 || i + n > buf.length) throw new Error('truncated protobuf');
      onField(field, wire, buf.subarray(i, i + n));
      i += n;
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > buf.length) throw new Error('truncated protobuf');
      i += n;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function decodeCidr(buf) {
  let ip = Buffer.alloc(0);
  let prefix = 0;
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) ip = Buffer.from(val);
    else if (field === 2 && wire === 0) prefix = Number(val);
  });
  return { ip, prefix };
}

function decodeGeoIp(buf) {
  let code = '';
  const cidr = [];
  let reverse = false;
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) code = utf8(val);
    else if (field === 2 && wire === 2) cidr.push(decodeCidr(val));
    else if (field === 3 && wire === 0) reverse = val !== 0n;
  });
  return { code, cidr, reverse };
}

function decodeAttribute(buf) {
  const attr = { key: '', boolValue: null, intValue: null };
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) attr.key = utf8(val);
    else if (field === 2 && wire === 0) attr.boolValue = val !== 0n;
    else if (field === 3 && wire === 0) {
      const min = BigInt(Number.MIN_SAFE_INTEGER);
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      attr.intValue = val >= min && val <= max ? Number(val) : val.toString();
    }
  });
  return attr;
}

function decodeDomain(buf) {
  const domain = { type: 0, value: '', attributes: [] };
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 0) domain.type = Number(val);
    else if (field === 2 && wire === 2) domain.value = utf8(val);
    else if (field === 3 && wire === 2) domain.attributes.push(decodeAttribute(val));
  });
  return domain;
}

function decodeGeoSite(buf) {
  let code = '';
  const domain = [];
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) code = utf8(val);
    else if (field === 2 && wire === 2) domain.push(decodeDomain(val));
  });
  return { code, domain };
}

export function decodeGeoIPList(buf) {
  const entry = [];
  walk(asBuf(buf), (field, wire, val) => {
    if (field === 1 && wire === 2) entry.push(decodeGeoIp(val));
  });
  return { entry };
}

export function decodeGeoSiteList(buf) {
  const entry = [];
  walk(asBuf(buf), (field, wire, val) => {
    if (field === 1 && wire === 2) entry.push(decodeGeoSite(val));
  });
  return { entry };
}

export function normalizeHost(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

function ipv4Bytes(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(p[i])) return null;
    const n = Number(p[i]);
    if (n > 255) return null;
    b[i] = n;
  }
  return b;
}

function ipv6Bytes(s) {
  const zone = s.split('%')[0];
  if (zone.includes('.')) {
    const last = zone.lastIndexOf(':');
    const v4 = ipv4Bytes(zone.slice(last + 1));
    if (!v4) return null;
    const head = ipv6Bytes(`${zone.slice(0, last)}:0:0`);
    if (!head) return null;
    head.writeUInt16BE((v4[0] << 8) | v4[1], 12);
    head.writeUInt16BE((v4[2] << 8) | v4[3], 14);
    return head;
  }
  const halves = zone.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':').map((h) => {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    return parseInt(h, 16);
  }) : []);
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left.includes(null) || right.includes(null)) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = [...left, ...Array(halves.length === 2 ? missing : 0).fill(0), ...right];
  if (parts.length !== 8) return null;
  const b = Buffer.alloc(16);
  parts.forEach((n, i) => b.writeUInt16BE(n, i * 2));
  return b;
}

export function parseIp(ip) {
  const s = normalizeHost(ip);
  if (net.isIPv4(s)) return { v4: ipv4Bytes(s), v6: null };
  if (!net.isIPv6(s)) return null;
  const v6 = ipv6Bytes(s);
  if (!v6) return null;
  const mapped = s.startsWith('::ffff:') && net.isIPv4(s.slice(7));
  return { v4: mapped ? ipv4Bytes(s.slice(7)) : null, v6 };
}

export function ipInCidr(ipBytes, cidr) {
  const raw = cidr.ip;
  const prefix = cidr.prefix;
  if (!ipBytes || !raw || ipBytes.length !== raw.length) return false;
  const total = raw.length * 8;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > total) return false;
  if (prefix === 0) return true;
  const bytes = prefix >> 3;
  const bits = prefix & 7;
  for (let i = 0; i < bytes; i++) if (ipBytes[i] !== raw[i]) return false;
  if (!bits) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return (ipBytes[bytes] & mask) === (raw[bytes] & mask);
}

function entryMatchesIp(entry, ipBytes) {
  const cidrs = entry.cidr.filter((c) => c.ip.length === ipBytes.length);
  if (!cidrs.length) return false;
  const hit = cidrs.some((c) => ipInCidr(ipBytes, c));
  return entry.reverse ? !hit : hit;
}

function compileRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_REGEX) return null;
  try { return new RegExp(pattern, 'u'); } catch { return null; }
}

// v2ray domain types: 0 plain (substring), 1 regex, 2 domain (suffix), 3 full (exact).
export function domainMatches(rule, host) {
  const h = normalizeHost(host);
  const value = normalizeHost(rule.value);
  if (!h) return false;
  const type = rule.type || 0;
  if (type === 1) {
    const re = rule.re || compileRegex(rule.value);
    if (!re) return false;
    re.lastIndex = 0;
    return re.test(h);
  }
  if (!value) return false;
  if (type === 3) return h === value;
  if (type === 2) {
    const suffix = value.replace(/^\./, '');
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h.includes(value);
}

function indexSite(entry) {
  const full = new Set();
  const domain = new Set();
  const plain = [];
  const regex = [];
  for (const rule of entry.domain) {
    const value = normalizeHost(rule.value).replace(/^\./, '');
    if (rule.type === 3) { if (value) full.add(value); }
    else if (rule.type === 2) { if (value) domain.add(value); }
    else if (rule.type === 1) { const re = compileRegex(rule.value); if (re) regex.push(re); }
    else if (value) plain.push(value);
  }
  return { code: entry.code, full, domain, plain, regex, rules: entry.domain.length };
}

function siteMatches(site, host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (site.full.has(h) || site.domain.has(h)) return true;
  let parent = h;
  while (parent.includes('.')) {
    parent = parent.slice(parent.indexOf('.') + 1);
    if (site.domain.has(parent)) return true;
  }
  for (const p of site.plain) if (h.includes(p)) return true;
  for (const re of site.regex) { re.lastIndex = 0; if (re.test(h)) return true; }
  return false;
}

export function compileGeo(geoip, geosite, categories) {
  const want = [...new Set(categories.map((c) => String(c).trim()).filter(Boolean))];
  const wanted = new Set(want.map((c) => c.toLowerCase()));
  const ipEntries = geoip.entry.filter((e) => wanted.has(e.code.toLowerCase()));
  const sites = geosite.entry.filter((e) => wanted.has(e.code.toLowerCase())).map(indexSite);
  const known = new Set([...geoip.entry.map((e) => e.code.toLowerCase()), ...geosite.entry.map((e) => e.code.toLowerCase())]);
  return {
    categories: want,
    missing: want.filter((c) => !known.has(c.toLowerCase())),
    domainRules: sites.reduce((n, s) => n + s.rules, 0),
    cidrRules: ipEntries.reduce((n, e) => n + e.cidr.length, 0),
    blocksDomain(host) { return sites.some((s) => siteMatches(s, host)); },
    blocksIp(ip) {
      const parsed = parseIp(ip);
      if (!parsed) return false;
      return ipEntries.some((e) => (parsed.v4 && entryMatchesIp(e, parsed.v4)) || (parsed.v6 && entryMatchesIp(e, parsed.v6)));
    },
  };
}

export function readDat(file) {
  const buf = readFileSync(file);
  if (buf.length > MAX_DAT_BYTES) throw new Error(`geo dat too large: ${file}`);
  return buf;
}

export function loadGeoDir(dir, categories) {
  const geoip = decodeGeoIPList(readDat(path.join(dir, 'geoip.dat')));
  const geosite = decodeGeoSiteList(readDat(path.join(dir, 'geosite.dat')));
  return compileGeo(geoip, geosite, categories);
}

export function readGeoConfig(file = DEFAULT_GEO_CONFIG) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return {
    enabled: j.enabled === true,
    dir: typeof j.dir === 'string' ? j.dir : '',
    categories: Array.isArray(j.categories) ? j.categories.map((c) => String(c).trim()).filter(Boolean) : [],
  };
}

// Env VEIL_GEO_ENABLED, when set, wins over the config file. Only "1" turns the env switch on.
// An unset env uses node/geo.config.json, which ships with enabled false.
export function openGeo(env = process.env, opts = {}) {
  const configPath = opts.configPath || DEFAULT_GEO_CONFIG;
  let cfg = { enabled: false, dir: '', categories: [] };
  if (typeof env.VEIL_GEO_ENABLED === 'string') {
    if (env.VEIL_GEO_ENABLED !== '1') return null;
    try { cfg = readGeoConfig(configPath); } catch { /* categories and dir may still come from the env */ }
  } else {
    try { cfg = readGeoConfig(configPath); } catch { return null; }
    if (cfg.enabled !== true) return null;
  }
  const dir = opts.dir || env.VEIL_GEO_DIR || cfg.dir || DEFAULT_GEO_DIR;
  const raw = env.VEIL_GEO_BLOCK_CATEGORIES ?? cfg.categories.join(',');
  const categories = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return loadGeoDir(dir, categories);
}

// Client settings use the same opt-in: missing or anything other than true stays off.
export function mergeGeoSetting(saved) {
  return { ...(saved && typeof saved === 'object' ? saved : {}), geo: saved?.geo === true };
}
