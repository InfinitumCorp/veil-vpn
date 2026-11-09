// Geo routing: synthetic v2fly protobuf fixtures, checksum failures, and the default-off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import {
  compileGeo, decodeGeoIPList, decodeGeoSiteList, domainMatches, ipInCidr, mergeGeoSetting,
  openGeo, parseIp, DEFAULT_GEO_CONFIG,
} from '../node/geo.js';
import {
  assertAllowedUrl, assertOfficialSum, assertSha256, fetchGeoFile, loadLock, parseSha256Sum, writeVerified,
} from '../scripts/fetch-geo-dat.mjs';
import { createCounter, isBlocked, nameBlocked, queryName, startDnsFilter } from '../node/blocker.js';

const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  for (;;) {
    const b = Number(v & 127n);
    v >>= 7n;
    if (v === 0n) { out.push(b); break; }
    out.push(b | 128);
  }
  return Buffer.from(out);
};
const key = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
const lenField = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), Buffer.from(buf)]);
const strField = (field, s) => lenField(field, Buffer.from(s));
const varField = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const cidr = (bytes, prefix) => Buffer.concat([lenField(1, Buffer.from(bytes)), varField(2, prefix)]);
const geoip = (code, cidrs, { reverse = false, extra = null } = {}) => Buffer.concat([
  strField(1, code),
  ...cidrs.map((c) => lenField(2, c)),
  ...(reverse ? [varField(3, 1)] : []),
  ...(extra ? [extra] : []),
]);
const geoipList = (entries) => Buffer.concat(entries.map((e) => lenField(1, e)));
const attribute = (name, { bool, int } = {}) => Buffer.concat([
  strField(1, name),
  ...(bool === undefined ? [] : [varField(2, bool ? 1 : 0)]),
  ...(int === undefined ? [] : [varField(3, int)]),
]);
const domain = (type, value, attributes = []) => Buffer.concat([
  ...(type ? [varField(1, type)] : []),
  strField(2, value),
  ...attributes.map((a) => lenField(3, a)),
]);
const geosite = (code, domains) => Buffer.concat([strField(1, code), ...domains.map((d) => lenField(2, d))]);
const geositeList = (entries) => Buffer.concat(entries.map((e) => lenField(1, e)));
const v6 = (parts) => {
  const b = Buffer.alloc(16);
  parts.forEach((n, i) => b.writeUInt16BE(n, i * 2));
  return b;
};

const ads = geosite('category-ads-all', [
  domain(0, 'tracker-pixel'),
  domain(1, String.raw`^ad[0-9]+\.promo\.test$`),
  domain(2, 'example.com'),
  domain(3, 'exact.example.com', [attribute('cn', { bool: true }), attribute('score', { int: 5 }), attribute('zero', { int: 0 })]),
]);
const other = geosite('other', [domain(3, 'other.example')]);
const siteBuf = geositeList([ads, other]);
const ipBuf = geoipList([
  geoip('us', [cidr([1, 2, 3, 0], 24), cidr(v6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]), 32)], { extra: varField(9, 7) }),
  geoip('wide', [cidr([10, 1, 0, 0], 17), cidr(v6([0xfd00, 0x1234, 0, 0, 0, 0, 0, 0]), 36)]),
  geoip('lab', [cidr([10, 0, 0, 0], 8)], { reverse: true }),
]);

const keep = [];
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'veil-geo-')); keep.push(d); return d; };
test.after(() => { for (const d of keep) rmSync(d, { recursive: true, force: true }); });

test('loader reads synthetic GeoIPList and GeoSiteList, including attributes', () => {
  const ips = decodeGeoIPList(ipBuf);
  assert.equal(ips.entry.length, 3);
  assert.equal(ips.entry[0].code, 'us');
  assert.equal(ips.entry[0].reverse, false);
  assert.deepEqual([...ips.entry[0].cidr[0].ip], [1, 2, 3, 0]);
  assert.equal(ips.entry[0].cidr[0].prefix, 24);
  assert.equal(ips.entry[0].cidr[1].prefix, 32);
  assert.equal(ips.entry[2].code, 'lab');
  assert.equal(ips.entry[2].reverse, true);

  const sites = decodeGeoSiteList(siteBuf);
  const rules = sites.entry[0].domain;
  assert.equal(sites.entry[0].code, 'category-ads-all');
  assert.equal(rules[0].type, 0);
  assert.equal(rules[1].type, 1);
  assert.equal(rules[1].value, String.raw`^ad[0-9]+\.promo\.test$`);
  assert.equal(rules[2].type, 2);
  assert.equal(rules[3].type, 3);
  assert.deepEqual(rules[3].attributes, [
    { key: 'cn', boolValue: true, intValue: null },
    { key: 'score', boolValue: null, intValue: 5 },
    { key: 'zero', boolValue: null, intValue: 0 },
  ]);
  assert.throws(() => decodeGeoIPList(Buffer.from([0x0a, 0x05, 0x01])), /truncated protobuf/);
  assert.deepEqual(decodeGeoSiteList(Buffer.alloc(0)).entry, []);
});

test('cidr and domain rules match the v2ray types', () => {
  const geoip = decodeGeoIPList(ipBuf);
  const geosite = decodeGeoSiteList(siteBuf);
  const match = compileGeo(geoip, geosite, ['category-ads-all', 'us', 'wide']);
  assert.deepEqual(match.missing, []);
  assert.equal(match.domainRules, 4);
  assert.equal(match.cidrRules, 4);

  assert.equal(match.blocksDomain('cdn.tracker-pixel.net'), true);
  assert.equal(match.blocksDomain('example.org'), false);
  assert.equal(match.blocksDomain('ad7.promo.test'), true);
  assert.equal(match.blocksDomain('ad.promo.test'), false);
  assert.equal(match.blocksDomain('ad.example.com'), true);
  assert.equal(match.blocksDomain('www.example.com'), true);
  assert.equal(match.blocksDomain('example.com.'), true);
  assert.equal(match.blocksDomain('notexample.com'), false);
  assert.equal(match.blocksDomain('example.com.evil'), false);
  assert.equal(match.blocksDomain('exact.example.com'), true);
  assert.equal(match.blocksDomain('EXACT.Example.Com'), true);
  assert.equal(match.blocksDomain('other.example'), false);
  assert.equal(domainMatches({ type: 2, value: 'Example.com' }, 'a.example.com'), true);
  assert.equal(domainMatches({ type: 0, value: 'ads' }, 'loads.example'), true);

  assert.equal(match.blocksIp('1.2.3.4'), true);
  assert.equal(match.blocksIp('1.2.3.255'), true);
  assert.equal(match.blocksIp('1.2.4.0'), false);
  assert.equal(match.blocksIp('::ffff:1.2.3.4'), true);
  assert.equal(match.blocksIp('2001:db8::1'), true);
  assert.equal(match.blocksIp('2001:db9::1'), false);
  assert.equal(match.blocksIp('2001:db8:1000::'), true);
  assert.equal(match.blocksIp('fd00:1234:0fff::'), true);
  assert.equal(match.blocksIp('fd00:1234:1000::'), false);
  assert.equal(match.blocksIp('10.1.127.255'), true);
  assert.equal(match.blocksIp('10.1.128.1'), false);
  assert.equal(match.blocksIp('::1'), false);
  assert.equal(ipInCidr(parseIp('1.2.3.4').v4, { ip: Buffer.from([1, 2, 3, 0]), prefix: 24 }), true);

  const upper = compileGeo(geoip, geosite, ['CATEGORY-ADS-ALL', 'US']);
  assert.equal(upper.missing.length, 0);
  assert.equal(upper.blocksDomain('exact.example.com'), true);
  assert.equal(upper.blocksIp('1.2.3.4'), true);
  const reversed = compileGeo(geoip, geosite, ['lab']);
  assert.equal(reversed.blocksIp('10.1.2.3'), false);
  assert.equal(reversed.blocksIp('11.0.0.1'), true);
  assert.equal(reversed.blocksIp('8.8.8.8'), true);
  assert.equal(reversed.blocksIp('2001:db8::1'), false);
  assert.equal(reversed.blocksDomain('exact.example.com'), false);
});

test('node switch stays off unless the env or the config file opts in', () => {
  assert.equal(openGeo({}), null);
  assert.equal(JSON.parse(readFileSync(DEFAULT_GEO_CONFIG, 'utf8')).enabled, false);
  const dir = tempDir();
  writeFileSync(path.join(dir, 'geoip.dat'), ipBuf);
  writeFileSync(path.join(dir, 'geosite.dat'), siteBuf);
  const cfg = path.join(dir, 'geo.config.json');
  writeFileSync(cfg, JSON.stringify({ enabled: false, dir, categories: ['category-ads-all'] }));
  assert.equal(openGeo({}, { configPath: cfg }), null);
  writeFileSync(cfg, JSON.stringify({ enabled: true, dir, categories: ['category-ads-all', 'us'] }));
  const on = openGeo({}, { configPath: cfg });
  assert.equal(on.blocksDomain('exact.example.com'), true);
  assert.equal(on.blocksIp('1.2.3.9'), true);
  assert.equal(on.blocksIp('8.8.8.8'), false);
  assert.equal(openGeo({ VEIL_GEO_ENABLED: '0' }, { configPath: cfg }), null);
  assert.equal(openGeo({ VEIL_GEO_ENABLED: '' }, { configPath: cfg }), null);
  const fromEnv = openGeo({ VEIL_GEO_ENABLED: '1', VEIL_GEO_DIR: dir, VEIL_GEO_BLOCK_CATEGORIES: 'category-ads-all' }, { configPath: path.join(dir, 'missing.json') });
  assert.equal(fromEnv.blocksDomain('www.example.com'), true);
  assert.equal(fromEnv.blocksIp('1.2.3.4'), false);
  assert.throws(() => openGeo({ VEIL_GEO_ENABLED: '1', VEIL_GEO_DIR: path.join(dir, 'absent') }, { configPath: path.join(dir, 'missing.json') }), /ENOENT|no such file/i);
});

test('with the switch off, blocking matches the hosts list alone', () => {
  const list = new Set(['tracked.example']);
  for (const name of ['tracked.example', 'a.tracked.example', 'exact.example.com', '1.2.3.4']) {
    assert.equal(nameBlocked(list, name), isBlocked(list, name));
    assert.equal(nameBlocked(list, name, undefined), isBlocked(list, name));
  }
  const geoip = decodeGeoIPList(ipBuf);
  const geosite = decodeGeoSiteList(siteBuf);
  const match = compileGeo(geoip, geosite, ['category-ads-all', 'us']);
  const decide = (optIn, name) => nameBlocked(list, name, optIn ? (n) => match.blocksDomain(n) || (parseIp(n) && match.blocksIp(n)) : undefined);
  assert.equal(decide(false, 'exact.example.com'), false);
  assert.equal(decide(false, 'tracked.example'), true);
  assert.equal(decide(true, 'exact.example.com'), true);
  assert.equal(decide(true, '1.2.3.4'), true);
  assert.equal(decide(true, 'example.org'), false);
  assert.deepEqual(mergeGeoSetting({ block: true }), { block: true, geo: false });
  assert.equal(mergeGeoSetting({ geo: true }).geo, true);
  assert.equal(mergeGeoSetting({ geo: 'yes' }).geo, false);
  assert.equal(mergeGeoSetting(null).geo, false);
});

test('dns filter is unchanged unless a geo matcher is supplied', async () => {
  const dnsQuery = (id, name) => Buffer.concat([
    Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
  const boot = async (port, geoMatch) => {
    const upstream = dgram.createSocket('udp4');
    const asked = [];
    upstream.on('message', (m, ri) => {
      asked.push(queryName(m));
      const a = Buffer.from(m); a[2] |= 0x80;
      upstream.send(a, ri.port, ri.address);
    });
    await new Promise((r) => upstream.bind(port + 1, '127.0.0.1', r));
    const filter = await startDnsFilter({
      listen: `127.0.0.1:${port}`, upstream: `127.0.0.1:${port + 1}`, list: () => new Set(['tracked.example']),
      counter: createCounter(), allows: () => false, ...(geoMatch ? { geoMatch } : {}),
    });
    const ask = (name) => new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.once('message', (m) => { s.close(); resolve(m); });
      s.send(dnsQuery(7, name), port, '127.0.0.1');
    });
    return { upstream, filter, asked, ask };
  };
  const off = await boot(19271);
  try {
    const listed = await off.ask('tracked.example');
    assert.equal(listed[3] & 0x0f, 3);
    assert.equal(off.asked.length, 0);
    const geoName = await off.ask('exact.example.com');
    assert.equal(geoName[3] & 0x0f, 0);
    assert.deepEqual(off.asked, ['exact.example.com']);
  } finally { off.filter.close(); off.upstream.close(); }
  const on = await boot(19273, (name) => name === 'exact.example.com');
  try {
    const hit = await on.ask('exact.example.com');
    assert.equal(hit[3] & 0x0f, 3);
    assert.equal(on.asked.length, 0);
    const otherName = await on.ask('example.org');
    assert.equal(otherName[3] & 0x0f, 0);
    assert.deepEqual(on.asked, ['example.org']);
  } finally { on.filter.close(); on.upstream.close(); }
});

test('checksum mismatch fails and does not keep a dat file', async () => {
  const lock = loadLock();
  assert.deepEqual(lock.files.map((f) => f.sha256), [
    'eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2',
    'dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2',
  ]);
  assert.equal(parseSha256Sum(`${lock.files[0].sha256}  geoip.dat\n`, 'geoip.dat'), lock.files[0].sha256);
  assert.equal(parseSha256Sum(`${lock.files[1].sha256} *dlc.dat\n`, 'dlc.dat'), lock.files[1].sha256);
  assertOfficialSum(`${lock.files[0].sha256}  geoip.dat\n`, 'geoip.dat', lock.files[0].sha256);
  assert.throws(() => assertOfficialSum(`${'ab'.repeat(32)}  geoip.dat\n`, 'geoip.dat', lock.files[0].sha256), (e) => e.code === 'SHA256_MISMATCH');
  assert.throws(() => assertSha256(Buffer.from('nope'), lock.files[0].sha256), (e) => e.code === 'SHA256_MISMATCH');
  assert.throws(() => assertAllowedUrl('https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat', 'geoip.dat'));
  assert.throws(() => assertAllowedUrl('https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat', 'geoip.dat'));
  assert.throws(() => assertAllowedUrl('http://github.com/v2fly/geoip/releases/download/x/geoip.dat', 'geoip.dat'));

  const dir = tempDir();
  const entry = lock.files[0];
  let datFetches = 0;
  await assert.rejects(() => fetchGeoFile(entry, {
    dir,
    fetchImpl: async (url) => {
      if (String(url).endsWith('.sha256sum')) return { ok: true, status: 200, text: async () => `${'ab'.repeat(32)}  ${entry.asset}\n` };
      datFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer };
    },
  }), (e) => e.code === 'SHA256_MISMATCH');
  assert.equal(datFetches, 0);
  assert.equal(existsSync(path.join(dir, 'geoip.dat')), false);

  await assert.rejects(() => fetchGeoFile(entry, {
    dir,
    fetchImpl: async (url) => {
      if (String(url).endsWith('.sha256sum')) return { ok: true, status: 200, text: async () => `${entry.sha256}  ${entry.asset}\n` };
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([9, 9, 9]).buffer };
    },
  }), (e) => e.code === 'SHA256_MISMATCH');
  assert.equal(existsSync(path.join(dir, 'geoip.dat')), false);

  const bytes = Buffer.from('synthetic-geo');
  const hex = createHash('sha256').update(bytes).digest('hex');
  writeVerified(dir, 'geosite.dat', bytes, hex);
  assert.equal(readFileSync(path.join(dir, 'geosite.dat')).equals(bytes), true);
  assert.throws(() => writeVerified(dir, 'geoip.dat', Buffer.from('bad'), 'aa'.repeat(32)), (e) => e.code === 'SHA256_MISMATCH');
  assert.equal(existsSync(path.join(dir, 'geoip.dat')), false);
});

test('settings switches default off and persist an explicit opt-in', () => {
  const pages = [
    'veil-vpn/index.html',
    'android/app/src/main/assets/www/index.html',
  ];
  for (const file of pages) {
    const html = readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
    const input = html.match(/<input type="checkbox" data-set="geo"[^>]*>/);
    assert.ok(input, file);
    assert.equal(input[0].includes('checked'), false, file);
  }
  for (const file of ['veil-vpn/app.js', 'android/app/src/main/assets/www/app.js']) {
    const src = readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
    const defaults = /const DEFAULT_SET = \{([^}]+)\}/.exec(src);
    assert.match(defaults[1], /geo:\s*false/);
  }
  const background = readFileSync(path.join(import.meta.dirname, '..', 'extension/background.js'), 'utf8');
  assert.match(background, /geo:\s*false/);
  assert.match(background, /st\.geo === true && \{ geo: true \}/);
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.options_ui.page, 'index.html#settings');
  const bridge = readFileSync(path.join(import.meta.dirname, '..', 'android/app/src/main/java/com/infinitum/veilvpn/Bridge.kt'), 'utf8');
  const vpn = readFileSync(path.join(import.meta.dirname, '..', 'android/app/src/main/java/com/infinitum/veilvpn/Vpn.kt'), 'utf8');
  assert.match(bridge, /getBoolean\("geo", false\)/);
  assert.match(bridge, /putBoolean\(k, p\.getBoolean\("value"\)\)/);
  assert.match(vpn, /getBoolean\("geo", false\)/);
  assert.match(vpn, /BuildConfig\.GEO_ROUTING/);
  assert.match(readFileSync(path.join(import.meta.dirname, '..', 'android/app/build.gradle.kts'), 'utf8'), /GEO_ROUTING/);
  const savedOff = mergeGeoSetting({ block: true, alerts: true });
  assert.equal(savedOff.geo, false);
  const savedOn = mergeGeoSetting({ ...savedOff, geo: true });
  assert.equal(savedOn.geo, true);
  assert.equal(savedOn.block, true);
});
