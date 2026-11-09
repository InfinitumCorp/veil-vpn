// Downloads the pinned v2fly geoip.dat and geosite.dat (dlc.dat) files.
// Checks each official .sha256sum asset against scripts/geo-dat.lock.json, then hashes the
// bytes. A mismatch stops the run and does not leave a .dat file behind.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = path.join(root, 'scripts', 'geo-dat.lock.json');
export const DEST_DIR = path.join(root, 'data', 'geo');
const DEST_OK = new Set(['geoip.dat', 'geosite.dat']);

export function loadLock(file = LOCK_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function assertAllowedUrl(url, label) {
  const u = new URL(url);
  const geoip = u.pathname.startsWith('/v2fly/geoip/');
  const geosite = u.pathname.startsWith('/v2fly/domain-list-community/');
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || (!geoip && !geosite)) {
    throw Object.assign(new Error(`refusing url outside v2fly geoip and domain-list-community: ${url}`), { code: 'GEO_URL' });
  }
  return label;
}

// Official sums look like "<64 hex>  name" or "<64 hex> *name".
export function parseSha256Sum(text, assetName) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const m = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line);
    if (m && m[2] === assetName) return m[1].toLowerCase();
  }
  throw Object.assign(new Error(`sha256sum has no line for ${assetName}`), { code: 'SHA256_MISMATCH' });
}

export function assertSha256(buf, expected) {
  const got = createHash('sha256').update(buf).digest('hex');
  const want = String(expected).toLowerCase();
  if (got !== want) {
    throw Object.assign(new Error(`sha256 mismatch: expected ${want} got ${got}`), { code: 'SHA256_MISMATCH' });
  }
  return got;
}

export function assertOfficialSum(officialText, assetName, lockSha) {
  const official = parseSha256Sum(officialText, assetName);
  if (official !== String(lockSha).toLowerCase()) {
    throw Object.assign(
      new Error(`official sha256sum for ${assetName} is ${official}, lock has ${lockSha}`),
      { code: 'SHA256_MISMATCH' },
    );
  }
  return official;
}

export function writeVerified(dir, destName, bytes, expected) {
  if (!DEST_OK.has(destName)) throw new Error(`refusing dest ${destName}`);
  assertSha256(bytes, expected);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${destName}.${process.pid}.tmp`);
  const finalPath = path.join(dir, destName);
  try {
    writeFileSync(tmp, bytes, { mode: 0o644 });
    assertSha256(readFileSync(tmp), expected);
    renameSync(tmp, finalPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return finalPath;
}

export async function fetchGeoFile(entry, { fetchImpl = globalThis.fetch, dir = DEST_DIR } = {}) {
  assertAllowedUrl(entry.url, entry.asset);
  assertAllowedUrl(entry.sha256Url, entry.asset);
  const sumRes = await fetchImpl(entry.sha256Url);
  if (!sumRes.ok) throw new Error(`sha256sum download failed for ${entry.asset}: ${sumRes.status}`);
  const sumText = await sumRes.text();
  assertOfficialSum(sumText, entry.asset, entry.sha256);
  const res = await fetchImpl(entry.url);
  if (!res.ok) throw new Error(`download failed for ${entry.asset}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeVerified(dir, entry.dest, bytes, entry.sha256);
  return { dest: entry.dest, sha256: entry.sha256, bytes: bytes.length };
}

export async function fetchAll(lock = loadLock(), opts) {
  const out = [];
  for (const entry of lock.files) out.push(await fetchGeoFile(entry, opts));
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  fetchAll().then((rows) => {
    for (const r of rows) console.log(`${r.dest} ${r.sha256} (${r.bytes} bytes)`);
  }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
