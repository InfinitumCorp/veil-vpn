// The node agent probes Xray listeners, and the HTTPS proxy pipes a secret WebSocket path to one.
// No Xray binary: a local TCP stub stands in for the inbound.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

Object.assign(process.env, {
  NODE_ENV: 'development', TOKEN_SECRET: 'test-token-secret-0123456789abcdef', AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
  NODE_ID: 'ws-bridge', PROXY_PORT: '19320', AGENT_PORT: '19321', HOOK_PORT: '19322', WG_DRY_RUN: '1',
});
const PATH = '/vless/00112233445566778899aabbccddeeff';
let servers = [];
const { start, xrayServices } = await import('../node/node.js');

before(async () => { servers = await start(); });
after(() => { for (const s of servers) s.close(); });

test('health omits Xray until provision sets probe addresses', async () => {
  assert.equal(await xrayServices(), null);
  const up = net.createServer((s) => s.end());
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  process.env.XRAY_REALITY_ADDR = `127.0.0.1:${up.address().port}`;
  process.env.XRAY_SS_ADDR = '127.0.0.1:1';
  const probed = await xrayServices();
  assert.equal(probed.vless, true);
  assert.equal(probed.shadowsocks, false);
  assert.equal(probed.xray, false);
  up.close();
  delete process.env.XRAY_REALITY_ADDR;
  delete process.env.XRAY_SS_ADDR;
});

test('WebSocket upgrade on the secret path is piped, and anything else is dropped', async () => {
  let got = '';
  const stub = net.createServer((s) => {
    s.once('data', (d) => {
      got += d.toString();
      s.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.VLESS_WS_PATH = PATH;
  process.env.VLESS_WS_UPSTREAM = `127.0.0.1:${stub.address().port}`;
  const read = (sock) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 2000);
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => { clearTimeout(t); resolve(buf); });
    sock.on('error', () => { clearTimeout(t); resolve(buf); });
  });
  const ok = net.connect(19320, '127.0.0.1');
  ok.write(`GET ${PATH} HTTP/1.1\r\nHost: vpn.veil-test.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const reply = await read(ok);
  assert.match(reply, /^HTTP\/1\.1 101/);
  assert.match(got, new RegExp(`GET ${PATH} HTTP/1.1`));
  assert.match(got, /upgrade: websocket/i);

  let hit = 0;
  stub.on('connection', () => { hit++; });
  const bad = net.connect(19320, '127.0.0.1');
  bad.write('GET / HTTP/1.1\r\nHost: vpn.veil-test.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await new Promise((resolve) => { bad.on('close', resolve); setTimeout(resolve, 500); });
  assert.equal(hit, 0);
  stub.close();
  delete process.env.VLESS_WS_PATH;
  delete process.env.VLESS_WS_UPSTREAM;

  const proxy = await new Promise((resolve, reject) => {
    const s = net.connect(19320, '127.0.0.1', () => s.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n'));
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
    s.on('error', reject);
  });
  assert.match(proxy, /407/);
});
