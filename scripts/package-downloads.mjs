// Puts the direct downloads into dist/site/download/ for infinitumveilvpn.app:
//   veil-vpn.apk          signed Android release (build it first; see README "Android app")
//   veil-vpn-chrome.zip   Chrome / Edge extension (from dist/extension; run `npm run build` first)
//   SHA256SUMS.txt        checksums, also shown on the page
// Usage: node scripts/package-downloads.mjs [path/to/release.apk]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const p = (...x) => path.join(root, ...x);
const out = p('dist/site/download');
const apk = process.argv[2] || p('android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apk)) throw new Error(`No release APK at ${apk}`);
if (!existsSync(p('dist/extension/manifest.json'))) throw new Error('Run npm run build first');

mkdirSync(out, { recursive: true });
copyFileSync(apk, path.join(out, 'veil-vpn.apk'));
const zip = path.join(out, 'veil-vpn-chrome.zip');
rmSync(zip, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${p('dist/extension')}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: p('dist/extension'), stdio: 'inherit' });
}

const sums = ['veil-vpn.apk', 'veil-vpn-chrome.zip'].map((f) =>
  `${createHash('sha256').update(readFileSync(path.join(out, f))).digest('hex')}  ${f}`);
writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
