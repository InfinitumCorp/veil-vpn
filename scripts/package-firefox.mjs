// Adds the Firefox extension to dist/site/download/ and rewrites SHA256SUMS.txt for every download there.
//   veil-vpn-firefox.zip  from dist/firefox (run a production build first: CONTROL_URL=https://api.infinitumveilvpn.app npm run build)
// The zip uses forward-slash paths with manifest.json at the root, as Firefox and Firefox Add-ons (AMO) require.
// (PowerShell 5.1's Compress-Archive writes backslashes, which Firefox rejects, so Windows uses bsdtar instead.)
// Usage: node scripts/package-firefox.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'dist/firefox');
const out = path.join(root, 'dist/site/download');
if (!existsSync(path.join(src, 'manifest.json'))) throw new Error('Run npm run build first');
if (readFileSync(path.join(src, 'config.js'), 'utf8').includes('127.0.0.1')) throw new Error('dist/firefox points at localhost; rebuild with CONTROL_URL set');

mkdirSync(out, { recursive: true });
const zip = path.join(out, 'veil-vpn-firefox.zip');
rmSync(zip, { force: true });
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, ...readdirSync(src)], { cwd: src, stdio: 'inherit' });
else execFileSync('zip', ['-qr', zip, '.'], { cwd: src, stdio: 'inherit' });

const files = readdirSync(out).filter((f) => /\.(apk|zip)$/.test(f)).sort();
const sums = files.map((f) => `${createHash('sha256').update(readFileSync(path.join(out, f))).digest('hex')}  ${f}`);
writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
