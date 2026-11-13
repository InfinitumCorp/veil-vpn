# VEIL</>™

Free, private VPN for Chrome, Edge, Firefox and Android, funded by privacy-safe ads.
Ad revenue is pooled with the community and paid out in $VEIL.

## What's here

| Folder | What it is | Status |
|---|---|---|
| `control/` | Control API (`core.js`): anonymous sessions, server list, VPN credentials, reward minutes, ads, revenue, daily pool payouts. `server.js` runs it on Node + SQLite | Working, tested |
| `deploy/api/` | The same control API as a Cloudflare Worker on Supabase Postgres (schema `veil_vpn`) | Live at https://api.infinitumveilvpn.app (no VPN servers listed yet) |
| `supabase/migrations/` | Postgres schema and the `veil_api` database login for the control API | Applied to the Infinitum Corp project |
| `node/` | VPN node: authenticated HTTPS proxy for browsers + agent for WireGuard peers and IKEv2 / OpenVPN logins; `provision.sh` sets up a fresh Ubuntu server with all four protocols, and can optionally add VLESS and Shadowsocks | Working, tested (wg, nft and swanctl calls run in dry-run off Linux) |
| `extension/` | Chrome / Edge / Firefox extension (Manifest V3) that routes browser traffic through a node | Working, tested in Chromium and Firefox |
| `site/` | Public landing page and privacy policy (`npm run build` writes `dist/site`) | Ready to host; store links still empty |
| `store/play/` | Google Play listing text, form answers and images | Ready |
| `android/` | Android app (Kotlin): WireGuard or IKEv2 (Android 11+) for every app, foreground supervisor, same interface in a WebView | Builds (debug and signed release), tested on emulator and phone |
| `veil-vpn/` | The shared interface. In a normal web page it runs as a simulated demo; inside the extension it runs live | Working |
| `shared/` | Reward and revenue-share rules (`economics.js`) and token signing (`token.js`) | Single source of truth |
| `test/` | End-to-end tests (control + node, real sockets), Cumulus ID sign-in, VLESS / Shadowsocks link tests and a local Xray smoke test | 44 tests (2 need Linux and Xray); plus 16 Worker tests in `deploy/api` |

Requires Node.js 22.13 or newer. No third-party packages.

## Run it locally

```bash
cp .env.example .env        # then replace the three secrets
npm test                    # 38 tests, including a local Xray smoke test
npm run node                # terminal 1: VPN node on :9100, agent on :9101
npm run control             # terminal 2: control server on :8787
CONTROL_URL=http://127.0.0.1:8787 npm run build   # dist/extension and dist/firefox against this local control server
                                                  # (plain `npm run build` points at the live API)
```

Load the extension: open `chrome://extensions` (or `edge://extensions`), turn on Developer mode,
click **Load unpacked** and pick `dist/extension`. Click the VEIL icon, then the power button.

Firefox (128 or newer): open `about:debugging#/runtime/this-firefox`, click **Load Temporary
Add-on** and pick `dist/firefox/manifest.json`. Same code; Firefox routes requests with
`proxy.onRequest` instead of a browser-wide proxy setting.

Note: browsers never send `localhost` traffic through a proxy, so test with a real website
or a LAN address. The local node blocks private addresses unless `ALLOW_PRIVATE=1` is set.

## VPN protocols

| Protocol | Where | Server side (from `node/provision.sh`) |
|---|---|---|
| HTTPS proxy | Browser extension (this browser only) | Node proxy on TCP 443, short-lived signed token |
| WireGuard | Android app (default); any device with the WireGuard app via a `.conf` set-up | `wg0`, UDP 51820, `10.66.0.0/16` |
| IKEv2/IPsec | Android app on Android 11+ (Android's own IKEv2 client); iPhone, Mac and Windows built-in VPN | strongSwan, UDP 500/4500, EAP-MSCHAPv2, Let's Encrypt certificate, `10.67.0.0/16` |
| OpenVPN | Any device with OpenVPN Connect via an `.ovpn` set-up | UDP and TCP 1194, own CA + tls-crypt, `10.68.0.0/16` (UDP) and `10.69.0.0/16` (TCP) |
| VLESS + XTLS Reality | Another app (v2rayNG, Streisand, sing-box, Xray), from *Other devices* | Optional. Xray-core, TCP 2053. Off unless `ENABLE_VLESS=1` |
| VLESS over WebSocket | The same apps, including behind a CDN | Optional. Secret path on the existing TLS port 443. `ENABLE_VLESS=1` and `ENABLE_WS=1` |
| Shadowsocks-2022 | A Shadowsocks app (SIP002) or Xray / sing-box | Optional. TCP and UDP 16080, `2022-blake3-aes-128-gcm`. `ENABLE_SHADOWSOCKS=1` |
| Shadowsocks over WebSocket | Xray or sing-box | Optional. Secret path on port 443. `ENABLE_SHADOWSOCKS=1` and `ENABLE_WS=1` |

- The node lists what it offers in `/v1/servers` (`modes`). A node offers IKEv2 or OpenVPN when
  its NODES entry has an `ikev2` or `openvpn` block; `provision.sh` prints the whole entry,
  including the OpenVPN CA and tls-crypt key.
- **Logins (IKEv2 and OpenVPN):** one username and password per session, derived by the control
  server (HMAC), so a saved profile keeps working. The node agent accepts it until the lease ends:
  15 minutes for the app (renewed every 10), 7 days for a set-up for another device. The agent
  writes the strongSwan EAP secrets and checks OpenVPN logins through a hook server on
  `127.0.0.1:9102`; strongSwan's updown script and OpenVPN's client-connect script report which
  tunnel address a login got, so Tor over VPN and tracker blocking follow the user on every protocol.
  An expired login is refused at the next connection; a session that is already up is not cut.
- **Other devices** (Settings): the app and the extension can produce a WireGuard `.conf` (the key
  pair is made on the device with WebCrypto X25519; only the public key is sent), an OpenVPN
  `.ovpn` with a login, or IKEv2 details. Set-ups last 7 days and earn nothing. Disconnecting in
  the app also removes WireGuard set-ups made from the same session.
- **No logs:** OpenVPN runs with `verb 0` and without its status file; charon logs errors only, to
  the in-memory journal.

### VLESS and Shadowsocks

Off unless you opt in, on the server and in the app. These are for networks that block WireGuard,
IKEv2 and OpenVPN. They run on VEIL's own nodes. There is no public server list and no volunteer exit.

The server program is **Xray-core** (MPL-2.0). sing-box is GPL, and this repo does not ship or copy it.
Settings can still save a sing-box client config, which is JSON we generate. Xray 26.11.9 is pinned in
`shared/proxyproto.js` and `node/provision.sh`, with the release checksums.

```bash
ENABLE_VLESS=1 ENABLE_SHADOWSOCKS=1 ENABLE_WS=1 \
  NODE_ID=zrh-1 DOMAIN=zrh-1.vpn.example.com \
  TOKEN_SECRET=... AGENT_SECRET=... CONTROL_IP=... \
  bash node/provision.sh
```

| Flag | Default | What it opens |
|---|---|---|
| `ENABLE_VLESS` | `0` | VLESS + XTLS Reality, TCP `VLESS_PORT` (2053) |
| `ENABLE_SHADOWSOCKS` | `0` | Shadowsocks-2022, TCP and UDP `SS_PORT` (16080), cipher `SS_METHOD` (`2022-blake3-aes-128-gcm`; `2022-blake3-aes-256-gcm` and `2022-blake3-chacha20-poly1305` also validate) |
| `ENABLE_WS` | `0` | WebSocket for whichever of the two is also on. Clients use `WS_PORT` (443). Needs VLESS or Shadowsocks |

`ENABLE_WS=1` alone is refused. Reality is not put on 443: that port stays the HTTPS proxy. WebSocket
is the 443 option. It is path-based (`/vless/…` and `/ss/…`, random per node). The node terminates TLS
with the existing certificate and pipes that path to Xray on `127.0.0.1` only. A CDN such as Cloudflare
can proxy the same hostname and port; set `WS_HOST`, `WS_SNI` and `WS_PORT` to the name clients dial.
WebSockets have to be allowed on that hostname. VEIL does not change DNS for you.

Reality's fallback (`VLESS_DEST`, default `127.0.0.1:443`) is this node's own HTTPS proxy, and the SNI
(`VLESS_SNI`, default the node's domain) matches that certificate. A probe without the key sees the
node's own site. User traffic leaves from this node. You can point `VLESS_SNI` and `VLESS_DEST` at
some other TLS site for a different camouflage; that dial is only the fallback handshake, not an exit.
Xray warns that a few well-known camouflage names, and any port other than 443, are more likely to be
blocked. Port 443 for this deployment is the WebSocket form.

In the app, Settings → **VLESS**, **Shadowsocks** and **WebSocket on 443** are off. Turn one on and
*Other devices* offers the set-up: a `vless://` or `ss://` link, an Xray JSON file and a sing-box JSON
file. The Android and browser apps do not tunnel these protocols themselves. Import the link into
v2rayNG, Streisand, NekoBox, sing-box or Xray. The direct Shadowsocks link is SIP002. Shadowsocks over
WebSocket uses Xray's own WebSocket, not the old v2ray-plugin: that plugin cannot carry a 2022 cipher,
so import the JSON for that form.

The link does not expire with the 7-day IKEv2 / OpenVPN login. It works until you rotate the node
keys (delete `/var/lib/veil/xray-state.json` and run `provision.sh` again). Treat the UUID and the
Shadowsocks password like the OpenVPN tls-crypt key: they go in the control server's `NODES` and
nowhere public. `GET /v1/servers` lists the mode only. The agent probes the listeners and
`/health` gains `services`; a down inbound fails just that mode with `server_offline`.

Same posture as the other protocols: Xray's log level is `none` (no access log), DNS is `10.66.0.1`
with no fallback to a public resolver, private addresses and outbound mail are dropped (Xray 26
also blackholes private destinations on these inbounds by default), and the
journal stays in memory. Names the node resolves still pass the tracker filter. The per-user
"block trackers" switch and Tor over VPN do not apply to these two protocols, because there is one
credential per node rather than one login per session. Re-running provision with the flags at `0`
closes the ports and stops `veil-xray`. The Oracle iptables cleanup is unchanged.

Xray 26 marks Shadowsocks and WebSocket as deprecated in favor of newer transports. They still run
in the pinned build, which is why the checksum is pinned instead of tracking "latest".

## Android app

Native Kotlin, minimum Android 8.0, built on the official WireGuard library
(`com.wireguard.android:tunnel`). The interface is the same `veil-vpn/` UI, bundled into the
app and connected through a native bridge (`window.VeilAndroid`).

- **Connect:** asks Android for VPN permission, sends the device's WireGuard public key to the
  control server (`mode: "wireguard"`), and brings the tunnel up for all apps (`0.0.0.0/0, ::/0`).
  The private key never leaves the phone.
- **Honest status:** shows **Protected** only after a WireGuard handshake with the node, checked
  every 5 seconds; no handshake for 3 minutes means **Connection lost**.
- **Supervisor service:** a foreground service with a status notification (and a Disconnect
  button) reconnects with backoff, renews the server lease every 10 minutes, and sends one reward
  heartbeat a minute while the screen is on.
- **Kill switch:** Android's own. The toggle opens VPN settings, where the user turns on
  *Always-on VPN* and *Block connections without VPN*. While reconnecting, the tunnel stays up
  so traffic is held rather than leaked.
- The app's own control-server calls are excluded from the tunnel so it can always reconnect.

Build (needs internet once to fetch Gradle and the libraries):

```bash
node scripts/build.mjs                              # copies the interface into the app
cd android
gradle wrapper --gradle-version 8.14.3              # once, with any installed Gradle
./gradlew assembleDebug                             # app/build/outputs/apk/debug/app-debug.apk
./gradlew bundleRelease -PveilControlUrl=https://api.your-domain   # app-release.aab for Google Play
```

**Release signing.** Release builds refuse to build without HTTPS and a signing key. The key is read
from `android/keystore.properties` (see `keystore.properties.example`) or from the environment
variables `VEIL_KEYSTORE`, `VEIL_KEYSTORE_PASSWORD`, `VEIL_KEY_ALIAS` and `VEIL_KEY_PASSWORD`.
An upload key has been generated at `android/keystore/veil-upload.jks` with a random password in
`android/keystore.properties`. **Back up both files somewhere safe** (a password manager); with Play
App Signing a lost upload key can be reset, but it takes Google's support. Both are in `.gitignore`.
Release lint needs extra downloads; on a network where those fail, add
`-x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease`.

Debug builds install as a separate app (`com.infinitum.veilvpn.debug`, "VEIL</>™ dev") and are the
only builds allowed to use plain HTTP, to the local development server.

If downloads fail on your network, two switches help:
`-PgoogleMaven=https://redirector.gvt1.com/edgedl/android/maven2/` (Google's CDN, when
dl.google.com is blocked) or `-PmavenRelay=http://127.0.0.1:8899` (a local relay that fetches with
curl, when Java TLS downloads keep getting cut). With the relay, also pass
`-Dorg.gradle.internal.http.socketTimeout=600000`.

Or open the `android/` folder in Android Studio and press Run. Every build talks to the live API,
`https://api.infinitumveilvpn.app`. To use a local control server from the emulator instead, build with
`-PveilControlUrl=http://10.0.2.2:8787` (10.0.2.2 is your PC as seen from the emulator).

Testing a full connection needs a real WireGuard node (a Linux server from `node/provision.sh`).
Without one, the app correctly stays on **Connecting…** because no handshake happens.

## Tracker blocking

On by default for everyone; Settings → "Block trackers" turns it off (the app reconnects to apply it).

- **Android (WireGuard):** the tunnel's DNS server, `10.66.0.1:53`, is the VEIL filter in `node/blocker.js`
  (UDP and TCP). Listed names get "no such domain"; everything else goes to a private unbound resolver on
  `127.0.0.1:5335` that logs nothing. Enabled on a node by `DNS_LISTEN` (provision.sh sets it).
- **Browsers (proxy):** the node refuses connections to listed hosts with `403` and `X-Veil-Blocked: tracker`.
- **List:** `node/blocklist.txt` (VEIL's own ~100 domains, always loaded) plus, on real nodes, the public
  StevenBlack hosts list (MIT), refreshed weekly by a systemd timer and reloaded by the node every hour.
  Set `BLOCKLIST_URL=''` when provisioning to use only the built-in list. VEIL's own in-app ad is first-party
  and is not on any list.
- **Count:** the node keeps one number per user per day in memory (by tunnel address or token id), never the
  names. The app shows it ("12 blocked today") via `GET /v1/blocked`.
- With Tor over VPN on, DNS goes to Tor instead, so WireGuard users are not filtered (browser users still are).

## Network status and unsafe-network alerts (Android)

- The Connect screen shows the current network's status: "This Wi-Fi: protected", "Mobile data: not
  protected", or a warning for open/WEP Wi-Fi and networks with a sign-in page.
- When the phone joins Wi-Fi while VEIL is off, a notification says so (stronger wording for open networks),
  at most once per network every 15 minutes. **Protect now** connects straight from the notification to the
  last location when VPN permission was already given; if that fails, the alert says why.
- Works with the app closed (a `ConnectivityManager` callback registered with a `PendingIntent`, restored after
  reboot and app updates). Settings → "Unsafe network alerts" turns it off.
- Everything is decided on the phone. The network name is never read and nothing about the network is sent.

## Sign in with Cumulus ID

The Android app and the browser extensions sign people in with Cumulus ID (Infinitum's one sign-in,
`id.cumuluscloud.app`). There is no VEIL password or PIN. **Signing in is optional: anyone can use VEIL VPN
without logging in.** With no sign-in, the app and the extension get an anonymous session and every feature
works, including connecting. The **Sign in** link at the top stays, and opens **Sign in with Cumulus ID** and
**Create a Cumulus ID** (the same authorize request with `prompt=create`; Cumulus ID's page offers sign-up and
comes back signed in). Signing in ties the person's devices to one account.

- **Flow.** OAuth 2.0 code + PKCE, client `veil-vpn`. The app opens `/api/id/authorize` in a Custom Tab
  (Android) or a new tab (extension). Cumulus ID returns to `https://infinitumveilvpn.app/app-signin/?to=<app>`
  (`site/app-signin/`). Android: that URL is an App Link (verified by `/.well-known/assetlinks.json` on the site,
  once the release key's fingerprint is added there), and the page also opens `veilvpn://cid?code&state`
  (`veilvpn-debug://` for debug builds). Extension: the background worker sees the tab reach that page and
  closes it. The app trades the code at `/api/id/token`, then sends the access token once to
  `POST /v1/session { cid_token }`.
- **Server.** `core.js` asks the issuer's `/api/id/userinfo` who the token belongs to and stores only
  `sessions.account`, an HMAC of the CID. Each device gets its own session token; all sessions with one account
  share the balance, today's minutes, the wallet, the daily limit and the epoch cap. Sessions without a
  Cumulus ID are accepted. Setting `CID_REQUIRED=1` (default `0`) would refuse them again; leave it off.
- **Russia / mirrors.** The issuer is configurable everywhere: `CID_ISSUER` on the control server and for
  `scripts/build.mjs` (extension) and `scripts/product-site.mjs` (site button, `data-issuer`), and
  `-PveilCidIssuer=https://...` for Android. Point all of them at the same mirror. `GET /v1/cid` reports the
  issuer the server uses. The return page origin must be registered for `veil-vpn` in Cumulus ID's client list.
- **Site.** The landing page header keeps the `site/cumulus-id.js` button, now with **Create a Cumulus ID**
  next to sign-in (`window.CumulusID.create()`).
- **Web demo.** `veil-vpn/` in a plain web page is a simulation with nothing to sign in to, so it is not gated.

## What Infinitum can't see

Shown in app Settings and on the landing page (`#cant-see`), and kept in line with `site/privacy.html`:
sites and apps used (no traffic or DNS logs; blocked trackers only counted), traffic contents, identity
(a keyed hash of the Cumulus ID only, no name or email; IP never written to disk), the user's Wi-Fi, and where Tor traffic goes. If you change what the
servers store, update all three. The app's "Privacy policy" and invite links point to https://infinitumveilvpn.app.

## Tor over VPN

Nodes provisioned with `TOR=1` run a Tor client and are marked `"tor": true` in `nodes.json`;
the app shows them as "Tor" in Locations. With the Settings switch on:

- **Browsers:** the user's proxy token carries `tor: true`, and the node opens every connection through
  Tor's SOCKS port. Names are passed to Tor unresolved (no DNS leaves the node), so `.onion` works.
- **Android:** the node agent adds the device's tunnel address to the nftables set `tor_peers`; the
  firewall redirects its DNS to Tor's resolver and all its TCP to Tor's transparent port, and drops
  anything else (UDP, ICMP) so nothing goes out around Tor.
- Switching while connected reconnects automatically. Locations without Tor refuse it with a clear message.

## Fraud protection

All rules are in `control/fraud.js` and can be tuned with environment variables.

| Check | Rule | Setting |
|---|---|---|
| Device | Every client sends a random install ID (Android: derived from the app's ANDROID_ID). The server stores a keyed hash and binds it to the session. The same token used from another device flags the session. | |
| Duplicate accounts | Only one session per device earns per day. | |
| Network | At most N sessions earn per network per day (same /24 or /48). | `FRAUD_NET_MAX` (8) |
| Wallet | One wallet can be linked to at most N sessions; sessions sharing a wallet share one daily limit. | `FRAUD_WALLET_MAX` (3) |
| Integrity | Emulators and rooted phones do not earn (on in production). For stronger checks, add Google Play Integrity. | `FRAUD_BLOCK_EMULATORS` |
| Ads | A click counts only after a view; per-session daily limits. | `FRAUD_AD_VIEWS` (60), `FRAUD_AD_CLICKS` (10) |
| Payouts | At epoch close, minutes are capped per device and per wallet; flagged sessions are paid into `held`. | |

Review with `GET /admin/fraud`, then `POST /admin/fraud/release` (pay held payouts) or
`POST /admin/fraud/ban` (void them), each with `{ "sid": "..." }`. Behind your own reverse proxy,
set `TRUST_PROXY=1` so the network check uses `X-Forwarded-For`. Privacy: no IP address or raw
device ID is stored; the network tag is a keyed hash of the address block with a key that changes
daily, deleted after 3 days. The app tells members why rewards are paused.

## How it works

1. The extension gets an anonymous session from the control server (no email, no IP stored).
2. **Connect** asks the control server for a 15-minute signed token for one node, sets the
   browser's proxy to that node, and answers the node's login challenge with the token.
3. The extension sends one check request through the tunnel (`veil-check.invalid`) and only
   shows **Protected** when the node itself answers. This repeats every minute.
4. **Kill switch:** if the node fails, the proxy stays in place so pages fail instead of
   leaking; the extension retries with backoff (3 s up to 60 s). With the kill switch off it
   falls back to a direct connection.
5. **Rewards:** once a minute, if the user is active, the extension sends a heartbeat. The
   server credits 1 minute (0.1 $VEIL), at most once per 55 s, only while connected, up to
   240 minutes a day. No browsing data is involved.
6. **Ads:** one contextual ad inside the app, picked by server region only. Views and
   clicks are de-duplicated and add estimated revenue (`CPM_USD`, `CPC_USD`). Replace the
   estimate with your ad network's real numbers via `POST /admin/revenue`. The **Ad revenue** tab
   (`GET /v1/revenue`) shows today's network revenue and pool, the revenue your own ad views and
   clicks generated (counts only, no ad or site detail), your estimated share, and your payout
   for each closed epoch.
7. **Daily epoch:** `POST /admin/epoch/close` splits that day's revenue by tier, pays the
   community share to each member by rewarded minutes, applies the treasury boost, and
   records it on an internal ledger. Users link a Solana address and **claim**, which moves
   their balance to the settlement queue (`GET /admin/settlement-queue`).

### Revenue split (in `shared/economics.js`)

| Tier | Members | Community | Network | Ecosystem | Liquidity | Team | Treasury boost |
|---|---|---|---|---|---|---|---|
| Launch | < 100K | 50% | 20% | 15% | 10% | 5% | 1.0× |
| Growth | 100K–1M | 55% | 17% | 13% | 10% | 5% | 1.25× |
| Network | 1M–10M | 60% | 15% | 10% | 10% | 5% | 1.5× |
| Mass | 10M+ | 65% | 12% | 8% | 10% | 5% | 2.0× |

Every tier adds to exactly 100% of ad revenue. The treasury boost multiplies the **$VEIL**
paid from the pool and is funded from the 15% community-treasury token allocation, so the
pool never pays out more cash than came in.

## Control API on Cloudflare + Supabase

`deploy/api` runs `control/core.js` as the Worker `veil-vpn-api` on `api.infinitumveilvpn.app`, with the
data in the shared Supabase project "Infinitum Corp" (schema `veil_vpn`, migration in `supabase/migrations/`).

- **Same code, two databases.** `core.js` writes portable SQL; `server.js` runs it on SQLite and
  `deploy/api/src/pg.js` turns it into Postgres (`$n` placeholders, `veil_vpn.` table names).
- **Access.** Every `veil_vpn` table has RLS on with no policies and is revoked from `anon` and
  `authenticated`: only the Worker's database connection can read or write it. No Supabase key goes to clients.
- **Database login.** The Worker connects as `veil_api` (`supabase/migrations/20261108_veil_api_role.sql`), which can
  read and write the `veil_vpn` tables and nothing else. Its password exists only in the Hyperdrive config
  `veil-vpn-db` (Supabase session pooler, `aws-1-eu-west-1.pooler.supabase.com:5432`), bound as `HYPERDRIVE`. To
  rotate it, set a new password on the role and update the Hyperdrive config. Without Hyperdrive, a direct
  `DATABASE_URL` hits the Workers subrequest limit, so keep Hyperdrive.
- **Cloudflare Access.** The account's "All Workers" Access app gates every Worker; the "VEIL VPN API (public)" app
  bypasses it for `api.infinitumveilvpn.app` only. The landing page stays gated until it is made public.
- **Secrets** (Worker secrets, never in this repo): `TOKEN_SECRET`, `AGENT_SECRET`, `ADMIN_KEY`.
- **Vars:** `NODES` is the server list (same JSON as `control/nodes.json`), empty until a VPN server exists.
  `CID_ISSUER` (default `https://id.cumuluscloud.app`) and `CID_REQUIRED` (default `0`: no sign-in needed): see
  *Sign in with Cumulus ID*. Apply `supabase/migrations/20261111_veil_cid_account.sql` before deploying.
- **Cron:** hourly purge of network tags older than 3 days.
- **Memory-only state** (node health, rate limits, ad-event dedupe) is per Worker isolate. The fraud caps that
  pay out money are enforced in the database, so this only loosens the short dedupe window.
- **Tests:** `cd deploy/api && npm install && npm test` runs the Worker against real Postgres (PGlite) with the
  migration, including the postgres.js driver over the wire.
- **Deploy:** `cd deploy/api && npx cf deploy` (creates the `api.infinitumveilvpn.app` DNS record), then set
  the secrets. The apps point at `https://api.infinitumveilvpn.app` by default.

## Going to production

1. **Control server:** deploy `deploy/api` (above). To self-host instead, run `control/server.js` behind
   HTTPS (Caddy, nginx or a load balancer) with `NODE_ENV=production`, real secrets, and a backed-up `DB_PATH`. Build the extension with
   `CONTROL_URL=https://api.your-domain node scripts/build.mjs`.
2. **Nodes:** for each location, rent an Ubuntu 24.04 server and run `node/provision.sh` with
   the variables at the top of the script. It installs WireGuard, a firewall with NAT, a DNS
   resolver with no query logging, a TLS certificate, and the VEIL node service with logs kept
   in memory only. Add `ENABLE_VLESS=1`, `ENABLE_SHADOWSOCKS=1` and `ENABLE_WS=1` only for the
   censorship-resistant protocols (see above). Paste the JSON it prints into `control/nodes.json`
   or the Worker's `NODES` variable. Do not commit the VLESS id or the Shadowsocks password.
3. **Extension stores:** zip `dist/extension` and submit to the Chrome Web Store and Edge
   Add-ons; zip the contents of `dist/firefox` and submit to Firefox Add-ons (AMO), which signs it.
   The add-on id is `veil@infinitum.vpn` in `scripts/build.mjs`; change it before the first upload.
   Until AMO signs it, `node scripts/package-firefox.mjs` puts an unsigned `veil-vpn-firefox.zip` in
   `dist/site/download/` (load it from `about:debugging`) and rewrites `SHA256SUMS.txt`.
4. **Ad network:** swap `control/ads.json` for a contextual, non-tracking ad partner.

## Not built yet

- **iOS app.** iPhone, Mac and Windows already work today through their built-in IKEv2 VPN, with a
  set-up from *Other devices* (see the site's "iPhone, Mac, Windows" panel). A native app needs a Mac with Xcode and an Apple developer account (Network Extension + WireGuardKit).
- **A real "Protected" test on Android, and Tor through a real node.** Both need a rented Linux
  server from `node/provision.sh` (with `TOR=1` for Tor).
- **Store links.** Fill in `DOWNLOADS` in `site/index.html` once the Chrome, Firefox and Play
  listings are live, and host `dist/site` (the privacy policy URL is needed for Play).
- **Server roadmap** (licence-checked in InfinitumCorp/RULES `reports/oss-reuse-2.md`; each needs a test on a real
  node first). Nodes already run unbound with no query logs, behind VEIL's tracker filter.
  1. rosenpass (Apache-2.0/MIT): post-quantum preshared key for `wg0`, rotated every ~2 minutes.
  2. VLESS Reality, VLESS over WebSocket and Shadowsocks-2022 are optional via Xray-core (MPL-2.0), off by default. Still open: wstunnel (BSD-3) for WireGuard over WebSocket, then hysteria (MIT) for QUIC.
  3. cloudflared (Apache-2.0): agent and admin ports behind Cloudflare Access, with no open ports.
     node_exporter (Apache-2.0): server load only, no per-user data, to suggest the least busy server.
  4. Later: nebula (MIT) node backbone; wgctrl-go (MIT) instead of shelling out to `wg`; boringtun (BSD-3)
     or wireguard-go (MIT) on hosts without the kernel module; amneziawg-go (MIT) for disguised WireGuard.
  Never copy code from AGPL/GPL or non-commercial projects (wg-easy, algo, Defguard, sing-box, Mullvad, Pritunl and others).
  Client configs for sing-box are generated here; the sing-box program is not vendored.
- **Google Play Integrity** for stronger device checks (needs a Google Cloud project).
- **On-chain $VEIL.** Payouts stop at the settlement queue. The Solana token, its audit, and the
  job that sends queued balances to FIRM Wallet come after the legal review.
- **Safari extension.**
- **Placeholders to replace:** the demo ads in `control/ads.json`.
- **Direct downloads:** `powershell -ExecutionPolicy Bypass -File scripts\release-android.ps1 -VersionCode <n>
  -VersionName <x.y.z> -AdmobAppId <id> -AdmobBannerId <id> -Publish` builds the signed APK and AAB with the key in
  `android/keystore/veil-upload.jks` (it asks for the password), refuses a debug-signed or wrong-version APK, then
  puts `veil-vpn.apk`, the Chrome/Edge zip and the Firefox zip with `SHA256SUMS.txt` in `dist/site/download/` and
  deploys the site. `-AllowTestAds` (without `-Publish`) is a dry run with Google's sample ads. `npm run build`
  empties `dist/site`, so never `cf deploy` the site straight after a build: the downloads would go offline.
  Swap in store URLs in `site/index.html` once the listings are live.

## Before launch

Paying users a share of ad revenue in a token may be treated as a security in some countries.
Get a legal review before $VEIL payouts go live, and keep the "not a share in Infinitum" wording
consistent with how payouts actually work.
