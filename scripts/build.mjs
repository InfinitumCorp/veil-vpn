// Builds dist/extension and syncs shared code into the web app.
//   CONTROL_URL=https://api.vpn.example.com node scripts/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pngIcon } from './icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...x) => path.join(root, ...x);
const CONTROL_URL = (process.env.CONTROL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
// Cumulus ID sign-in. CID_ISSUER may point at a mirror reachable from Russia without a VPN; CID_RETURN
// is the page Cumulus ID sends the extension back to (an origin registered for the veil-vpn client).
const CID_ISSUER = (process.env.CID_ISSUER || 'https://id.cumuluscloud.app').replace(/\/+$/, '');
const CID_RETURN = process.env.CID_RETURN || 'https://infinitumveilvpn.app/app-signin/?to=ext';

// 1. Shared reward rules into the web app (generated copy, edit shared/economics.js).
const econ = readFileSync(p('shared/economics.js'), 'utf8');
writeFileSync(p('veil-vpn/economics.js'), `// GENERATED from shared/economics.js by scripts/build.mjs. Do not edit here.\n${econ}`);

// Interface language (@infinitum/i18n): runtime and build-time catalogs from veil-vpn/i18n (no model calls).
const I18N = ['i18n.js', 'i18n.css', 'start.js', 'catalogs.js'];
const copyI18n = (dest) => { mkdirSync(path.join(dest, 'i18n'), { recursive: true }); for (const f of I18N) cpSync(p('veil-vpn/i18n', f), path.join(dest, 'i18n', f)); };

// 2. Extension bundle.
const out = p('dist/extension');
rmSync(out, { recursive: true, force: true });
mkdirSync(p('dist/extension/icons'), { recursive: true });
for (const f of ['manifest.json', 'background.js']) cpSync(p('extension', f), path.join(out, f));
for (const f of ['app.css', 'app.js', 'economics.js', 'icon.svg', 'firm-suite.js', 'firm-suite.css']) cpSync(p('veil-vpn', f), path.join(out, f));
copyI18n(out);
cpSync(p('extension/_locales'), path.join(out, '_locales'), { recursive: true });
writeFileSync(path.join(out, 'config.js'), `export const CONTROL_URL = ${JSON.stringify(CONTROL_URL)};\n`
  + `export const CID_ISSUER = ${JSON.stringify(CID_ISSUER)};\nexport const CID_RETURN = ${JSON.stringify(CID_RETURN)};\n`);
const html = readFileSync(p('veil-vpn/index.html'), 'utf8')
  .replace(/<link rel="manifest"[^>]*>\n?/, '')
  .replace(/<meta name="apple-[^>]*>\n?/g, '');
writeFileSync(path.join(out, 'index.html'), html);

// 3. PNG icons: the V |™ mark in the brand font (scripts/icon.mjs).
for (const s of [16, 32, 48, 128]) writeFileSync(path.join(out, `icons/${s}.png`), pngIcon(s));

// 3b. Firefox bundle: same files, Firefox manifest (event page, blocking webRequest, gecko id).
const ff = p('dist/firefox');
rmSync(ff, { recursive: true, force: true });
cpSync(out, ff, { recursive: true });
const mf = JSON.parse(readFileSync(p('extension/manifest.json'), 'utf8'));
delete mf.minimum_chrome_version;
mf.background = { scripts: ['background.js'], type: 'module' };
mf.permissions = mf.permissions.filter((x) => x !== 'webRequestAuthProvider').concat('webRequestBlocking');
// Firefox's default MV3 policy adds upgrade-insecure-requests, which would turn the tunnel check
// (plain HTTP to veil-check.invalid, answered by the node itself) into an HTTPS request.
mf.content_security_policy = { extension_pages: "script-src 'self'; object-src 'self'" };
mf.browser_specific_settings ={ gecko: { id: 'veil@infinitum.vpn', strict_min_version: '128.0' } };
writeFileSync(path.join(ff, 'manifest.json'), JSON.stringify(mf, null, 2) + '\n');

// 4. Android app assets: the same interface, loaded by the app's WebView.
const www = p('android/app/src/main/assets/www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['app.css', 'app.js', 'economics.js', 'icon.svg', 'firm-suite.js', 'firm-suite.css']) cpSync(p('veil-vpn', f), path.join(www, f));
writeFileSync(path.join(www, 'index.html'), html);
copyI18n(www);

// 5. Landing page: site/ to dist/site, ready for any static host. index.html is written without
// the document wrapper (so it can also be published as a page preview); add it here.
const siteOut = p('dist/site');
rmSync(siteOut, { recursive: true, force: true });
// site/ is written by scripts/product-site.mjs (shared Infinitum layout); privacy-body.html is its source text.
cpSync(p('site'), siteOut, { recursive: true, filter: (f) => path.basename(f) !== 'privacy-body.html' });
const index = readFileSync(p('site/index.html'), 'utf8');
if (!/^<!doctype/i.test(index)) writeFileSync(path.join(siteOut, 'index.html'), '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n'
  + index + '\n</body>\n</html>\n');

console.log(`Built dist/extension, dist/firefox (control: ${CONTROL_URL}, Cumulus ID: ${CID_ISSUER}), dist/site and android/app/src/main/assets/www`);
