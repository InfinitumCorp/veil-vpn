// Tracker blocking for VEIL</>™ nodes.
// A DNS filter for WireGuard users (answers "no such domain" for blocked names and forwards the
// rest to the node's private resolver) and a lookup the browser proxy uses for the same list.
// Privacy: only a number is kept per user (blocked today), in memory. Names are never stored or logged.
import dgram from 'node:dgram';
import net from 'node:net';
import { readFileSync, existsSync } from 'node:fs';

// Reads hosts-file or plain-domain lists ("0.0.0.0 ads.example.com" or "ads.example.com").
export function loadBlocklist(paths) {
  const set = new Set();
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    for (let line of readFileSync(p, 'utf8').split('\n')) {
      line = line.replace(/#.*/, '').trim().toLowerCase();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const d = parts.length > 1 ? parts[1] : parts[0];
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && d !== 'localhost') set.add(d);
    }
  }
  return set;
}

// A name is blocked when it or any parent domain is listed (ads.tracker.com matches tracker.com).
export function isBlocked(set, name) {
  let d = String(name).toLowerCase().replace(/\.$/, '');
  while (d.includes('.')) {
    if (set.has(d)) return true;
    d = d.slice(d.indexOf('.') + 1);
  }
  return false;
}

// Per-user counts for the current UTC day, keyed by tunnel IP or token id. Memory only.
export function createCounter() {
  let day = new Date().toISOString().slice(0, 10);
  const counts = new Map();
  const roll = () => { const d = new Date().toISOString().slice(0, 10); if (d !== day) { day = d; counts.clear(); } };
  return {
    add: (key) => { roll(); counts.set(key, (counts.get(key) || 0) + 1); },
    get: (key) => { roll(); return counts.get(key) || 0; },
    total: () => { roll(); let t = 0; for (const v of counts.values()) t += v; return t; },
  };
}

// The question name of a DNS query, or null if the packet is malformed.
export function queryName(msg) {
  if (msg.length < 17) return null;
  const labels = []; let i = 12;
  while (i < msg.length) {
    const len = msg[i];
    if (len === 0) return labels.join('.');
    if (len > 63 || i + 1 + len > msg.length) return null;
    labels.push(msg.subarray(i + 1, i + 1 + len).toString('latin1'));
    i += 1 + len;
  }
  return null;
}

// NXDOMAIN reply to the given query: same id and question, no answers.
export function nxdomain(msg) {
  let end = 12; while (end < msg.length && msg[end] !== 0) end += msg[end] + 1;
  end += 5;                                              // zero byte + QTYPE + QCLASS
  const r = Buffer.from(msg.subarray(0, Math.min(end, msg.length)));
  r[2] = 0x80 | (msg[2] & 0x79) | 0x04;                  // QR, keep opcode and RD, set AA
  r[3] = 0x80 | 0x03;                                    // RA, RCODE 3 (no such name)
  r.writeUInt16BE(1, 4); r.writeUInt16BE(0, 6); r.writeUInt16BE(0, 8); r.writeUInt16BE(0, 10);
  return r;
}

// DNS filter for tunnel clients. `allows(ip)` says whether that client turned blocking off.
export function startDnsFilter({ listen, upstream, list, counter, allows }) {
  const [lh, lp] = [listen.slice(0, listen.lastIndexOf(':')), Number(listen.slice(listen.lastIndexOf(':') + 1))];
  const [uh, up] = [upstream.slice(0, upstream.lastIndexOf(':')), Number(upstream.slice(upstream.lastIndexOf(':') + 1))];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const name = queryName(msg);
    if (name && !allows(rinfo.address) && isBlocked(list(), name)) {
      counter.add(rinfo.address);
      return sock.send(nxdomain(msg), rinfo.port, rinfo.address);
    }
    const fwd = dgram.createSocket('udp4');
    const t = setTimeout(() => fwd.close(), 4000);
    fwd.on('message', (reply) => { clearTimeout(t); sock.send(reply, rinfo.port, rinfo.address); fwd.close(); });
    fwd.on('error', () => { clearTimeout(t); fwd.close(); });
    fwd.send(msg, up, uh);
  });
  // DNS over TCP (used for large answers): same rules, messages carry a 2-byte length prefix.
  const tcp = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.setTimeout(10_000, () => c.destroy());
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0)); buf = buf.subarray(2 + msg.length);
        const name = queryName(msg);
        const ip = c.remoteAddress.replace(/^::ffff:/, '');
        if (name && !allows(ip) && isBlocked(list(), name)) { counter.add(ip); c.write(framed(nxdomain(msg))); continue; }
        const up = net.connect(uport, uh, () => up.write(framed(msg)));
        let ub = Buffer.alloc(0);
        up.setTimeout(4000, () => up.destroy());
        up.on('error', () => {});
        up.on('data', (x) => {
          ub = Buffer.concat([ub, x]);
          if (ub.length >= 2 && ub.length >= 2 + ub.readUInt16BE(0)) { c.write(ub.subarray(0, 2 + ub.readUInt16BE(0))); up.end(); }
        });
      }
    });
  });
  const uport = up;
  const framed = (m) => Buffer.concat([Buffer.from([m.length >> 8, m.length & 255]), m]);
  const udpReady = new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(lp, lh, resolve); });
  const tcpReady = new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(lp, lh, resolve); });
  return Promise.all([udpReady, tcpReady]).then(() => {
    console.log(`dns filter on ${listen} -> ${upstream}`);
    return { close: () => { sock.close(); tcp.close(); } };
  });
}
