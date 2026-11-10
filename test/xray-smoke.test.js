// Listeners are 127.0.0.1 only. The request is a public HTTPS page: Xray 26 blackholes
// private destinations on these inbounds, so the byte we check is example.com, reached
// through the local tunnel. Reality's camouflage dial is example.com:443 as well.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clientBundle, materialize, xrayAsset } from '../shared/proxyproto.js';

const dir = mkdtempSync(path.join(tmpdir(), 'veil-xray-smoke-'));
const procs = [];
const closers = [];
let bin = '';

function waitPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tick = () => {
      const s = net.connect(port, host);
      const done = (ok) => { s.destroy(); ok ? resolve() : Date.now() > deadline ? reject(new Error(`port ${port} closed`)) : setTimeout(tick, 80); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    };
    tick();
  });
}
async function xrayBin() {
  if (process.env.XRAY_BIN && existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
  const asset = xrayAsset();
  const cache = path.join('/tmp', `veil-xray-${asset.version}`);
  const file = path.join(cache, 'xray');
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`Xray download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== asset.sha256) throw new Error(`Xray checksum ${got}`);
    const zip = path.join(cache, asset.name);
    writeFileSync(zip, buf);
    execFileSync('python3', ['-c', `import zipfile; zipfile.ZipFile(${JSON.stringify(zip)}).extract('xray', ${JSON.stringify(cache)})`]);
    chmodSync(file, 0o755);
  }
  return file;
}
function runXray(cfg, label) {
  const file = path.join(dir, `${label}.json`);
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  const log = { text: '' };
  const p = spawn(bin, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (d) => { log.text = (log.text + d.toString()).slice(-4000); };
  p.stdout.on('data', take); p.stderr.on('data', take);
  procs.push(p);
  return log;
}
async function curlVia(cfg, label, socks, targetUrl) {
  const log = runXray(cfg, label);
  await waitPort(socks);
  let last = '';
  for (let i = 0; i < 6; i++) {
    try {
      return execFileSync('curl', ['-fsS', '--max-time', '4', '-x', `socks5h://127.0.0.1:${socks}`, targetUrl], { encoding: 'utf8' });
    } catch (e) {
      last = `${e.stderr || e.message}\n${log.text}\n${globalThis.__veilSmoke?.serverLog?.text || ''}`;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${label} failed\n${last}`);
}

before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=vpn.veil-test.example']);
  bin = await xrayBin();
  const prod = materialize({ vless: true, shadowsocks: true, ws: true, domain: 'vpn.example', sni: 'vpn.example' });
  writeFileSync(path.join(dir, 'prod.json'), JSON.stringify(prod.server));
  execFileSync(bin, ['run', '-test', '-c', path.join(dir, 'prod.json')], { stdio: 'pipe' });

  const built = materialize({
    vless: true, shadowsocks: true, ws: true, domain: 'vpn.veil-test.example', sni: 'example.com',
    realityDest: 'example.com:443', vlessPort: 19453, ssPort: 19480, wsPort: 19443,
    wsHost: 'vpn.veil-test.example', wsSni: 'vpn.veil-test.example', vlessWsLocal: 19481, ssWsLocal: 19482,
    dns: '1.1.1.1', allowPrivate: true, listen: '127.0.0.1',
  });
  writeFileSync(path.join(dir, 'server.json'), JSON.stringify(built.server));
  const serverLog = runXray(built.server, 'server');
  await waitPort(19453);
  await waitPort(19480);
  await waitPort(19481);
  await waitPort(19482);
  Object.assign(process.env, {
    NODE_ENV: 'development', TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
    NODE_ID: 'xray-smoke', PROXY_PORT: '19443', AGENT_PORT: '19444', HOOK_PORT: '19445', WG_DRY_RUN: '1',
    TLS_CERT: path.join(dir, 'cert.pem'), TLS_KEY: path.join(dir, 'key.pem'),
    VLESS_WS_PATH: built.publicNode.vless.ws.path, VLESS_WS_UPSTREAM: '127.0.0.1:19481',
    SS_WS_PATH: built.publicNode.shadowsocks.ws.path, SS_WS_UPSTREAM: '127.0.0.1:19482',
  });
  const { start } = await import('../node/node.js');
  const nodeServers = await start();
  closers.push(...nodeServers);
  await waitPort(19443);
  globalThis.__veilSmoke = { built, serverLog, node: { id: 'smoke', city: 'Loop', ...built.publicNode } };
});

after(() => {
  for (const p of procs) p.kill('SIGTERM');
  for (const s of closers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('traffic passes over VLESS Reality, Shadowsocks-2022 and WebSocket', { timeout: 120_000 }, async () => {
  const { node } = globalThis.__veilSmoke;
  const url = 'https://example.com/';
  const ok = (body) => { assert.match(body, /html/i); };
  const reality = clientBundle(node, 'vless', { address: '127.0.0.1', port: 19453, socksPort: 19511 });
  ok(await curlVia(reality.xray, 'reality', 19511, url));
  const ss = clientBundle(node, 'shadowsocks', { address: '127.0.0.1', port: 19480, socksPort: 19512 });
  ok(await curlVia(ss.xray, 'ss', 19512, url));
  // WebSocket inbounds speak cleartext on 127.0.0.1. The node's TLS front, which production
  // clients use, is checked by the upgrade test in node-xray.test.js. Xray 26 removed allowInsecure.
  const vws = clientBundle(node, 'vless-ws', { address: '127.0.0.1', port: 19481, socksPort: 19513, tls: false });
  ok(await curlVia(vws.xray, 'vless-ws', 19513, url));
  const sws = clientBundle(node, 'shadowsocks-ws', { address: '127.0.0.1', port: 19482, socksPort: 19514, tls: false });
  ok(await curlVia(sws.xray, 'ss-ws', 19514, url));
  // The node is the TLS front. A plain TLS client still reaches it (the proxy), not Xray.
  const tlsReply = await new Promise((resolve, reject) => {
    const s = tls.connect({ port: 19443, host: '127.0.0.1', rejectUnauthorized: false, servername: 'vpn.veil-test.example' }, () => {
      s.write('GET / HTTP/1.1\r\nHost: vpn.veil-test.example\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
  assert.match(tlsReply, /^HTTP\/1\.1 407/);
});
