// VLESS / Shadowsocks link, schema and Xray config generation. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createControl } from '../control/core.js';
import {
  DEFAULTS, XRAY_SHA256, XRAY_VERSION, PROXY_MODES, clientBundle, fragment, issues, materialize,
  modesOf, realityKeyPair, responseKey, serverConfig, serviceBlocks, writeProvision, xrayAsset,
} from '../shared/proxyproto.js';

const pub = Buffer.alloc(32, 4).toString('base64url');
const pass = Buffer.alloc(16, 9).toString('base64');
const node = {
  id: 'zrh-1', city: 'Zürich', country: 'Switzerland', flag: '🇨🇭', region: 'eu',
  vless: {
    id: '00000000-0000-4000-8000-0000000000a1', host: 'zrh-1.vpn.example',
    reality: { port: 2053, publicKey: pub, shortId: '0011223344556677', sni: 'zrh-1.vpn.example', fingerprint: 'chrome', flow: 'xtls-rprx-vision' },
    ws: { port: 443, path: '/vless/00112233445566778899aabbccddeeff', host: 'zrh-1.vpn.example', sni: 'cdn.example', tls: true },
  },
  shadowsocks: {
    host: 'zrh-1.vpn.example', method: '2022-blake3-aes-128-gcm', password: pass, port: 16080,
    ws: { port: 443, path: '/ss/00112233445566778899aabbccddeeff', host: 'zrh-1.vpn.example', sni: 'cdn.example', tls: true },
  },
};

test('existing node files stay valid without the new fields', () => {
  for (const file of ['../control/nodes.json', '../deploy/api/nodes.json']) {
    const nodes = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const n of nodes) {
      assert.deepEqual(issues(n), [], `${file} ${n.id}`);
      assert.equal(n.vless, undefined);
      assert.equal(n.shadowsocks, undefined);
      assert.equal(modesOf(n).includes('vless'), false);
      assert.equal(modesOf(n).includes('shadowsocks'), false);
    }
  }
});

test('schema accepts a full placeholder and rejects broken ones', () => {
  assert.deepEqual(issues(node), []);
  assert.deepEqual(modesOf(node), ['proxy', 'vless', 'vless-ws', 'shadowsocks', 'shadowsocks-ws']);
  assert.deepEqual(modesOf({ wg: {}, ikev2: {}, openvpn: {} }), ['proxy', 'wireguard', 'ikev2', 'openvpn']);
  assert.ok(issues({ vless: { id: 'nope', host: 'h.example', reality: { port: 2053, publicKey: pub, shortId: 'abc', sni: 'h.example' } } }).some((e) => e.includes('UUID')));
  assert.ok(issues({ vless: { id: node.vless.id, host: 'h.example', reality: { ...node.vless.reality, port: 443 } } }).some((e) => e.includes('already used')));
  assert.ok(issues({ shadowsocks: { ...node.shadowsocks, password: 'abc', ws: undefined } }).some((e) => e.includes('password')));
  assert.ok(issues({ vless: { id: node.vless.id, host: 'h.example', ws: { ...node.vless.ws, tls: false, path: '/short' } } }).length >= 2);
  const aes256 = Buffer.alloc(32, 3).toString('base64');
  assert.deepEqual(issues({ shadowsocks: { host: 'h.example', method: '2022-blake3-aes-256-gcm', password: aes256, port: 16080 } }), []);
});

test('share links and client configs carry the public parameters only', () => {
  const keys = realityKeyPair();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 32);
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  const withPriv = serverConfig(node, { realityPrivateKey: keys.privateKey, realityDest: '127.0.0.1:443', vlessWsLocal: 10481, ssWsLocal: 10482 });
  assert.equal(withPriv.log.loglevel, 'none');
  assert.equal(withPriv.log.access, undefined);
  assert.equal(withPriv.dns.servers[0], '10.66.0.1');
  assert.equal(withPriv.dns.disableFallback, true);
  assert.ok(withPriv.routing.rules.some((r) => r.ip?.includes('10.0.0.0/8')));
  assert.ok(withPriv.routing.rules.some((r) => r.port === '25,465,587'));
  assert.equal(withPriv.outbounds[0].streamSettings.sockopt.domainStrategy, 'UseIP');
  assert.equal(withPriv.outbounds[0].settings, undefined);
  const loop = serverConfig(node, { realityPrivateKey: keys.privateKey, realityDest: '127.0.0.1:443', vlessWsLocal: 10481, ssWsLocal: 10482, allowPrivate: true });
  assert.equal(loop.outbounds[0].settings.finalRules[0].action, 'allow');
  const reality = withPriv.inbounds.find((i) => i.tag === 'vless-reality');
  assert.equal(reality.listen, '0.0.0.0');
  assert.equal(reality.port, 2053);
  assert.equal(reality.streamSettings.realitySettings.dest, '127.0.0.1:443');
  assert.equal(reality.streamSettings.realitySettings.privateKey, keys.privateKey);
  assert.equal(reality.streamSettings.realitySettings.show, false);
  assert.equal(reality.settings.clients[0].flow, 'xtls-rprx-vision');
  const vws = withPriv.inbounds.find((i) => i.tag === 'vless-ws');
  assert.equal(vws.listen, '127.0.0.1');
  assert.equal(vws.streamSettings.security, undefined);
  assert.equal(vws.settings.clients[0].flow, undefined);
  const ss = withPriv.inbounds.find((i) => i.tag === 'ss');
  assert.equal(ss.settings.network, 'tcp,udp');
  assert.equal(ss.settings.method, '2022-blake3-aes-128-gcm');
  assert.equal(withPriv.inbounds.find((i) => i.tag === 'ss-ws').settings.network, 'tcp');

  for (const mode of PROXY_MODES) {
    const bundle = clientBundle(node, mode);
    assert.equal(bundle.persistent, true);
    assert.equal(JSON.stringify(bundle).includes(keys.privateKey), false);
    assert.equal(bundle.xray.routing.domainStrategy, 'AsIs');
    assert.equal(bundle.xray.log.access, undefined);
    assert.equal(bundle.singbox.route.final, 'proxy');
    assert.equal(responseKey(mode) != null, true);
    const u = new URL(bundle.link);
    if (mode.startsWith('vless')) {
      assert.equal(u.protocol, 'vless:');
      assert.equal(u.username, node.vless.id);
      assert.equal(u.searchParams.get('encryption'), 'none');
    } else {
      assert.equal(u.protocol, 'ss:');
      assert.equal(Buffer.from(u.username, 'base64url').toString(), `${node.shadowsocks.method}:${pass}`);
    }
  }
  const realityLink = new URL(clientBundle(node, 'vless').link);
  assert.equal(realityLink.port, '2053');
  assert.equal(realityLink.searchParams.get('security'), 'reality');
  assert.equal(realityLink.searchParams.get('pbk'), pub);
  assert.equal(realityLink.searchParams.get('sid'), '0011223344556677');
  assert.equal(realityLink.searchParams.get('flow'), 'xtls-rprx-vision');
  assert.equal(realityLink.searchParams.get('type'), 'tcp');
  assert.equal(realityLink.searchParams.get('fp'), 'chrome');
  const wsLink = new URL(clientBundle(node, 'vless-ws').link);
  assert.equal(wsLink.port, '443');
  assert.equal(wsLink.searchParams.get('type'), 'ws');
  assert.equal(wsLink.searchParams.get('security'), 'tls');
  assert.equal(wsLink.searchParams.get('path'), node.vless.ws.path);
  assert.equal(wsLink.searchParams.get('sni'), 'cdn.example');
  assert.equal(clientBundle(node, 'vless-ws').xray.outbounds[0].settings.vnext[0].users[0].flow, undefined);
  assert.equal(clientBundle(node, 'vless').xray.outbounds[0].streamSettings.tlsSettings, undefined);
  const ssLink = new URL(clientBundle(node, 'shadowsocks').link);
  assert.equal(ssLink.port, '16080');
  assert.equal(ssLink.search, '');
  const ssWs = clientBundle(node, 'shadowsocks-ws');
  assert.equal(new URL(ssWs.link).searchParams.get('type'), 'ws');
  assert.equal(ssWs.xray.outbounds[0].streamSettings.network, 'ws');
  assert.equal(ssWs.xray.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertSha256, undefined);
  assert.equal(ssWs.xray.outbounds[0].streamSettings.tlsSettings.allowInsecure, undefined);
  assert.equal(ssWs.singbox.outbounds[0].transport.type, 'ws');
  assert.equal(ssWs.singbox.outbounds[0].tls.insecure, undefined);
  const pin = 'ab'.repeat(32);
  const pinned = clientBundle(node, 'vless-ws', { pinnedPeerCertSha256: pin, address: '127.0.0.1', port: 9 });
  assert.equal(pinned.xray.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertSha256, pin);
  assert.equal(pinned.xray.outbounds[0].streamSettings.tlsSettings.allowInsecure, undefined);
  assert.equal(pinned.host, '127.0.0.1');
  assert.equal(pinned.port, 9);
});

test('provision material keeps keys and omits what is switched off', () => {
  const base = { vless: true, shadowsocks: true, ws: false, domain: 'vpn.example', sni: 'vpn.example' };
  const first = materialize(base);
  assert.equal(first.publicNode.vless.ws, undefined);
  assert.equal(first.publicNode.shadowsocks.ws, undefined);
  assert.equal(JSON.stringify(first.publicNode).includes(first.state.realityPrivateKey), false);
  assert.equal(first.server.inbounds.some((i) => i.tag === 'vless-ws'), false);
  assert.match(first.envText, /^XRAY_REALITY_ADDR=127\.0\.0\.1:2053\nXRAY_SS_ADDR=127\.0\.0\.1:16080\n$/);
  const second = materialize({ ...base, ws: true, state: first.state });
  assert.equal(second.state.uuid, first.state.uuid);
  assert.equal(second.state.realityPrivateKey, first.state.realityPrivateKey);
  assert.equal(second.state.ssPassword, first.state.ssPassword);
  assert.equal(second.publicNode.vless.ws.path, first.state.vlessWsPath);
  assert.equal(second.publicNode.vless.reality.sni, 'vpn.example');
  assert.equal(second.server.inbounds.find((i) => i.tag === 'vless-reality').streamSettings.realitySettings.dest, '127.0.0.1:443');
  assert.match(second.envText, new RegExp(`VLESS_WS_PATH=${first.state.vlessWsPath}`));
  assert.match(second.envText, /SS_WS_UPSTREAM=127\.0\.0\.1:10482/);
  const doc = JSON.parse(`{ "id": "n"${fragment(second.publicNode)} }`);
  assert.equal(doc.vless.id, second.state.uuid);
  assert.equal(doc.shadowsocks.method, DEFAULTS.ssMethod);
  assert.equal(JSON.stringify(doc).includes('realityPrivateKey'), false);
  assert.throws(() => materialize({ ws: true, domain: 'vpn.example' }), /ENABLE_WS/);
  assert.throws(() => materialize({ vless: true, domain: 'vpn.example', vlessPort: 443 }), /already used/);
  assert.throws(() => materialize({ vless: true, shadowsocks: true, domain: 'vpn.example', vlessPort: 2053, ssPort: 2053 }), /must differ/);
  assert.equal(serviceBlocks(null, 'vless'), false);
  assert.equal(serviceBlocks({ vless: false }, 'vless'), true);
  assert.equal(serviceBlocks({ vless: false }, 'shadowsocks'), false);
  assert.equal(serviceBlocks({ vlessWs: true }, 'vless-ws'), false);
});

test('provision files are mode 600 and the pinned Xray checksums match the shell script', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'veil-xray-'));
  try {
    const files = {
      state: path.join(dir, 'state.json'), config: path.join(dir, 'xray.json'),
      envFile: path.join(dir, 'node.env'), publicFile: path.join(dir, 'public.json'), fragmentFile: path.join(dir, 'fragment.txt'),
    };
    const result = await writeProvision({ vless: true, shadowsocks: true, ws: true, domain: 'vpn.example' }, files);
    for (const [file, mode] of [[files.state, 0o600], [files.config, 0o640], [files.envFile, 0o600], [files.publicFile, 0o600], [files.fragmentFile, 0o600]]) {
      assert.equal(statSync(file).mode & 0o777, mode, file);
    }
    const pubJson = JSON.parse(readFileSync(files.publicFile, 'utf8'));
    assert.equal(pubJson.vless.id, result.state.uuid);
    assert.equal(JSON.parse(readFileSync(files.config, 'utf8')).inbounds[0].streamSettings.realitySettings.privateKey, result.state.realityPrivateKey);
    assert.equal(readFileSync(files.publicFile, 'utf8').includes(result.state.realityPrivateKey), false);
    const again = await writeProvision({ vless: true, domain: 'vpn.example' }, files);
    assert.equal(again.state.uuid, result.state.uuid);
    assert.equal(again.publicNode.shadowsocks, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const sh = readFileSync(new URL('../node/provision.sh', import.meta.url), 'utf8');
  assert.ok(sh.includes(XRAY_VERSION));
  for (const sum of Object.values(XRAY_SHA256)) assert.ok(sh.includes(sum), sum);
  assert.equal(xrayAsset('x64').sha256, XRAY_SHA256['Xray-linux-64.zip']);
  assert.equal(xrayAsset('arm64').name, 'Xray-linux-arm64-v8a.zip');
});

test('control server accepts today\'s nodes and a bad vless block fails closed', () => {
  const env = (k, d) => ({ TOKEN_SECRET: 't'.repeat(24), AGENT_SECRET: 'a'.repeat(24), ADMIN_KEY: 'k'.repeat(24) }[k] ?? d);
  const nodes = JSON.parse(readFileSync(new URL('../deploy/api/nodes.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => createControl({ env, nodes, ads: [] }));
  assert.throws(() => createControl({ env, nodes: [{ id: 'bad', vless: { id: 'nope' } }], ads: [] }), /bad:.*UUID/);
});
