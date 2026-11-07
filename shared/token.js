// Short-lived, stateless access tokens shared by the control server and VPN nodes.
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256). No user data inside.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function sign(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof p.exp === 'number' && p.exp > now ? p : null;
  } catch { return null; }
}
