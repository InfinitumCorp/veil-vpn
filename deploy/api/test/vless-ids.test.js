// VLESS ids come from the VLESS_IDS secret, never from nodes.json in git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withVlessIds } from '../src/worker.js';

const reality = { port: 2053, publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', shortId: 'ab12', sni: 'vpn-x.example.com' };
const nodes = [
  { id: 'a-1', vless: { host: 'vpn-a.example.com', reality } },
  { id: 'b-1', vless: { host: 'vpn-b.example.com', reality } },
  { id: 'c-1' },
];
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('the id is filled in from VLESS_IDS', () => {
  const out = withVlessIds(nodes, JSON.stringify({ 'a-1': UUID }));
  assert.equal(out[0].vless.id, UUID);
  assert.equal(out[0].vless.reality.publicKey, reality.publicKey);
});

test('a node without an id offers no VLESS', () => {
  const out = withVlessIds(nodes, JSON.stringify({ 'a-1': UUID }));
  assert.equal(out[1].vless, undefined);
  assert.equal(out[1].id, 'b-1');
  assert.deepEqual(out[2], { id: 'c-1' });
});

test('no secret, or a broken one, leaves every node without VLESS', () => {
  for (const ids of [undefined, '', 'not json']) {
    assert.ok(withVlessIds(nodes, ids).every((n) => !n.vless));
  }
});

test('the input list is not changed', () => {
  withVlessIds(nodes, JSON.stringify({ 'a-1': UUID }));
  assert.equal(nodes[0].vless.id, undefined);
});
