// Prints the RELAY_TO value for a relay node: every exit in deploy/api/nodes.json whose "relayVia" names it.
// Usage: node scripts/relay-to.mjs ru1-1   ->   RELAY_TO=use2-1=vpn-use2.example:443,...
// Provision the relay with that RELAY_TO (node/provision.sh) so it carries exactly the exits that point at it.
import { readFileSync } from 'node:fs';

const relay = process.argv[2];
if (!relay) { console.error('usage: node scripts/relay-to.mjs <relay node id>'); process.exit(1); }
const nodes = JSON.parse(readFileSync(new URL('../deploy/api/nodes.json', import.meta.url), 'utf8'));
if (!nodes.some((n) => n.id === relay)) { console.error(`no node ${relay} in deploy/api/nodes.json`); process.exit(1); }
const exits = nodes.filter((n) => n.relayVia === relay && n.proxy);
if (!exits.length) { console.error(`no node has "relayVia": "${relay}"`); process.exit(1); }
console.log(`RELAY_TO=${exits.map((n) => `${n.id}=${n.proxy.host}:${n.proxy.port}`).join(',')}`);
