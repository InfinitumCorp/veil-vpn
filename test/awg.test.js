// AmneziaWG node settings: what nodes.json may contain, as amneziawg-go accepts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awgIssues, issues, modesOf } from '../shared/proxyproto.js';

const KEY = 'E'.repeat(43) + '=';
const good = { endpoint: 'fra.example:51821', publicKey: KEY, jc: 4, jmin: 40, jmax: 70, s1: 52, s2: 41, h1: 1234567891, h2: 2345678912, h3: 3456789123, h4: 4012345678 };

test('awg: valid settings pass and add the amneziawg mode', () => {
  assert.deepEqual(awgIssues(good), []);
  assert.deepEqual(issues({ awg: good }), []);
  assert.deepEqual(modesOf({ wg: {}, awg: good }), ['proxy', 'wireguard', 'amneziawg']);
});

test('awg: each limit is enforced', () => {
  const bad = (patch) => awgIssues({ ...good, ...patch });
  assert.match(bad({ endpoint: 'fra.example' })[0], /endpoint/);
  assert.match(bad({ endpoint: 'fra.example:51820' })[0], /already used/);
  assert.match(bad({ publicKey: 'C'.repeat(43) + '=' })[0], /publicKey/);
  assert.match(bad({ jc: 0 })[0], /jc/);
  assert.match(bad({ jmin: 70, jmax: 70 })[0], /jmin/);
  assert.match(bad({ jmax: 1281 })[0], /jmin/);
  assert.match(bad({ s1: 1133 })[0], /s1/);
  assert.match(bad({ s1: 10, s2: 66 })[0], /s1 \+ 56/);
  assert.match(bad({ h4: 1234567891 })[0], /h1-h4/);
  assert.match(bad({ h1: 4 })[0], /h1-h4/);
  assert.deepEqual(awgIssues(null), ['awg must be an object']);
});
