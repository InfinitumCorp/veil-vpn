import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bottomConnectLabel, connectTarget } from '../veil-vpn/connect-target.js';

const servers = [
  { id: 'cmh', city: 'Columbus', online: true },
  { id: 'fra', city: 'Frankfurt', online: true },
  { id: 'old', city: 'Retired', online: false },
];

test('Connect with no location selected reuses the last connection', () => {
  assert.equal(connectTarget({ picked: false, selected: null, last: 'fra', servers }), 'fra');
  // The row can show the first server while nothing was chosen. That is not a selection.
  assert.equal(connectTarget({ picked: false, selected: 'cmh', last: 'fra', servers }), 'fra');
});

test('an explicit location pick wins over the last connection', () => {
  assert.equal(connectTarget({ picked: true, selected: 'cmh', last: 'fra', servers }), 'cmh');
});

test('a last connection still works before the location list has loaded', () => {
  assert.equal(connectTarget({ picked: false, selected: null, last: 'fra', servers: [] }), 'fra');
});

test('with no history, Connect uses a location that is offered instead of doing nothing', () => {
  assert.equal(connectTarget({ picked: false, selected: null, last: null, servers }), 'cmh');
  assert.equal(connectTarget({ picked: false, selected: null, last: 'gone', servers }), 'cmh');
});

test('an empty list and no history has nothing to connect to', () => {
  assert.equal(connectTarget({ picked: false, selected: null, last: null, servers: [] }), null);
  assert.equal(connectTarget({ picked: false, selected: null, last: '', servers: [] }), null);
});

test('the bottom Connect tab shows the connected state only while the tunnel is up', () => {
  assert.equal(bottomConnectLabel('off'), 'Connect');
  assert.equal(bottomConnectLabel('connecting'), 'Connecting');
  assert.equal(bottomConnectLabel('error'), 'Connecting');
  assert.equal(bottomConnectLabel('on'), 'Connected');
  assert.equal(bottomConnectLabel(undefined), 'Connect');
});
