// Relay (RELAY_TO): a domestic node accepts proxy tokens issued for an exit node and forwards each CONNECT, with the
// same credentials, over TLS to the exit's proxy. A local TLS server stands in for the exit; its self-signed
// certificate is made for this run only (needs openssl) and trusted through RELAY_CA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from '../shared/token.js';

const SECRET = 'test-token-secret-0123456789abcdef';
const dir = mkdtempSync(join(tmpdir(), 'veil-relay-'));
let haveOpenssl = true;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=exit.test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
} catch { haveOpenssl = false; }

// The fake exit: answers CONNECT for the right credentials, then echoes what it gets back with a prefix.
const seen = [];
const exit = haveOpenssl && tls.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (s) => {
  let buf = '';
  const onData = (d) => {
    buf += d.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    s.off('data', onData);
    const head = buf.slice(0, end);
    seen.push(head);
    const auth = /proxy-authorization: (.+)/i.exec(head)?.[1];
    if (!auth || !Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().startsWith('veil:')) return s.end('HTTP/1.1 407 Nope\r\n\r\n');
    s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const rest = buf.slice(end + 4);
    if (rest) s.write(`exit:${rest}`);
    s.on('data', (x) => s.write(`exit:${x}`));
  };
  s.on('data', onData);
  s.on('error', () => {});
});
if (exit) await new Promise((r) => exit.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  NODE_ENV: 'development', TOKEN_SECRET: SECRET, AGENT_SECRET: 'test-agent-secret-0123456789abcdef',
  NODE_ID: 'relay-ru', PROXY_PORT: '19330', AGENT_PORT: '19331', HOOK_PORT: '19332', WG_DRY_RUN: '1',
  RELAY_TO: exit ? `exit-us=127.0.0.1:${exit.address().port}` : '', RELAY_CA: haveOpenssl ? join(dir, 'cert.pem') : '',
});
const { start, parseRelays } = await import('../node/node.js');
let servers = [];
before(async () => { servers = await start(); });
after(() => { for (const s of servers) s.close(); if (exit) exit.close(); rmSync(dir, { recursive: true, force: true }); });

const auth = (node) => `Basic ${Buffer.from(`veil:${sign({ node, exp: Date.now() + 60_000, sid: 's1' }, SECRET)}`).toString('base64')}`;
function connect(dest, pa, send) {
  return new Promise((resolve) => {
    const s = net.connect(19330, '127.0.0.1', () => s.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\nProxy-Authorization: ${pa}\r\n\r\n`));
    let out = '';
    s.on('data', (d) => {
      out += d.toString();
      if (send && out.includes('\r\n\r\n') && !s.sent) { s.sent = true; s.write(send); }
      if (out.includes('exit:') || /^HTTP\/1\.1 (4|5)\d\d/.test(out)) setTimeout(() => { s.destroy(); resolve(out); }, 50);
    });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });
}

test('parseRelays reads id=host:port pairs and drops bad ones', () => {
  const m = parseRelays('us1=exit.example:443, de1=[2001:db8::1]:8443,bad,x=host:0');
  assert.deepEqual([...m.keys()], ['us1', 'de1']);
  assert.deepEqual(m.get('us1'), { host: 'exit.example', port: 443 });
  assert.deepEqual(m.get('de1'), { host: '[2001:db8::1]', port: 8443 });
});

test('a token for a relayed exit is forwarded to that exit with the same credentials', { skip: !haveOpenssl && 'no openssl' }, async () => {
  const pa = auth('exit-us');
  const out = await connect('example.com:443', pa, 'hello');
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /exit:hello/);
  const head = seen.at(-1);
  assert.match(head, /^CONNECT example\.com:443 HTTP\/1\.1/);
  assert.ok(head.includes(`Proxy-Authorization: ${pa}`));
});

test('a token for a node this one does not relay to is refused', async () => {
  const out = await connect('example.com:443', auth('somewhere-else'));
  assert.match(out, /^HTTP\/1\.1 407/);
});
