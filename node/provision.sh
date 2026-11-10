#!/usr/bin/env bash
# Provisions one VEIL</>™ node on a fresh Ubuntu 24.04 server.
# Usage (as root):
#   NODE_ID=zrh-1 DOMAIN=zrh-1.vpn.example.com TOKEN_SECRET=... AGENT_SECRET=... CONTROL_IP=203.0.113.10 bash provision.sh
# With the control API on Cloudflare Workers, set CONTROL_IP to Cloudflare's ranges, comma-separated
# (https://www.cloudflare.com/ips-v4).
# Add TOR=1 to also offer Tor over VPN from this node (users switch it on in Settings).
# Tracker blocking is on for every node: VPN clients' DNS goes through the VEIL filter on 10.66.0.1:53,
# which answers "no such domain" for listed trackers and passes the rest to a private unbound resolver.
# Set BLOCKLIST_URL='' to use only the built-in list (node/blocklist.txt).
# Protocols: HTTPS proxy (browsers, TCP 443), WireGuard (UDP 51820), IKEv2/IPsec with EAP-MSCHAPv2
# (strongSwan, UDP 500/4500, Let's Encrypt server certificate) and OpenVPN (UDP and TCP 1194, own CA).
# Set IKEV2=0 or OPENVPN=0 to leave one out.
# Optional, off unless set to 1 (Xray-core, MPL-2.0; nothing here is a third-party VPN server):
#   ENABLE_VLESS=1         VLESS + XTLS Reality on TCP ${VLESS_PORT:-2053}. Probes fall through to
#                          this node's own HTTPS proxy (VLESS_DEST, default 127.0.0.1:443).
#   ENABLE_SHADOWSOCKS=1   Shadowsocks-2022 on TCP/UDP ${SS_PORT:-16080}.
#   ENABLE_WS=1            VLESS and/or Shadowsocks over WebSocket, TLS on the existing port 443
#                          (a secret path). Needs ENABLE_VLESS=1 or ENABLE_SHADOWSOCKS=1.
#                          WS_HOST / WS_SNI / WS_PORT override the name clients use (a CDN hostname).
# Prints the node's nodes.json entry at the end (WireGuard key, OpenVPN CA and tls-crypt key included).
# VLESS ids and Shadowsocks passwords in that entry are node secrets: paste them into NODES only.
set -euo pipefail

: "${NODE_ID:?set NODE_ID}" "${DOMAIN:?set DOMAIN}" "${TOKEN_SECRET:?set TOKEN_SECRET}" "${AGENT_SECRET:?set AGENT_SECRET}" "${CONTROL_IP:?set CONTROL_IP}"
TOR="${TOR:-0}"
IKEV2="${IKEV2:-1}"
OPENVPN="${OPENVPN:-1}"
ENABLE_VLESS="${ENABLE_VLESS:-0}"
ENABLE_SHADOWSOCKS="${ENABLE_SHADOWSOCKS:-0}"
ENABLE_WS="${ENABLE_WS:-0}"
# Keep the version and the two SHA2-256 pins in sync with shared/proxyproto.js (XRAY_VERSION, XRAY_SHA256).
XRAY_VERSION="${XRAY_VERSION:-v26.11.9}"
VLESS_PORT="${VLESS_PORT:-2053}"
SS_PORT="${SS_PORT:-16080}"
VLESS_SNI="${VLESS_SNI:-$DOMAIN}"
VLESS_DEST="${VLESS_DEST:-127.0.0.1:443}"
VLESS_FINGERPRINT="${VLESS_FINGERPRINT:-chrome}"
SS_METHOD="${SS_METHOD:-2022-blake3-aes-128-gcm}"
WS_PORT="${WS_PORT:-443}"
WS_HOST="${WS_HOST:-$DOMAIN}"
WS_SNI="${WS_SNI:-$WS_HOST}"
VLESS_WS_LOCAL="${VLESS_WS_LOCAL:-10481}"
SS_WS_LOCAL="${SS_WS_LOCAL:-10482}"
XRAY_ON=0
port_ok() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
reserved_port() { case "$1" in 22|80|443|500|4500|1194|51820|9101|9102) return 0 ;; *) return 1 ;; esac; }
for flag in "$ENABLE_VLESS" "$ENABLE_SHADOWSOCKS" "$ENABLE_WS" "$TOR" "$IKEV2" "$OPENVPN"; do
  case "$flag" in 0|1) ;; *) echo "protocol flags must be 0 or 1" >&2; exit 1 ;; esac
done
if [ "$ENABLE_WS" = 1 ] && [ "$ENABLE_VLESS" != 1 ] && [ "$ENABLE_SHADOWSOCKS" != 1 ]; then
  echo "ENABLE_WS=1 needs ENABLE_VLESS=1 or ENABLE_SHADOWSOCKS=1" >&2; exit 1
fi
if [ "$ENABLE_VLESS" = 1 ]; then
  port_ok "$VLESS_PORT" || { echo "VLESS_PORT must be a port" >&2; exit 1; }
  if reserved_port "$VLESS_PORT"; then echo "VLESS_PORT ${VLESS_PORT} is already used by another VEIL service" >&2; exit 1; fi
fi
if [ "$ENABLE_SHADOWSOCKS" = 1 ]; then
  port_ok "$SS_PORT" || { echo "SS_PORT must be a port" >&2; exit 1; }
  if reserved_port "$SS_PORT"; then echo "SS_PORT ${SS_PORT} is already used by another VEIL service" >&2; exit 1; fi
fi
if [ "$ENABLE_VLESS" = 1 ] && [ "$ENABLE_SHADOWSOCKS" = 1 ] && [ "$VLESS_PORT" = "$SS_PORT" ]; then
  echo "VLESS_PORT and SS_PORT must differ" >&2; exit 1
fi
port_ok "$WS_PORT" || { echo "WS_PORT must be a port" >&2; exit 1; }
if [ "$ENABLE_WS" = 1 ]; then
  port_ok "$VLESS_WS_LOCAL" && port_ok "$SS_WS_LOCAL" || { echo "WebSocket local ports must be ports" >&2; exit 1; }
  if [ "$ENABLE_VLESS" = 1 ] && [ "$ENABLE_SHADOWSOCKS" = 1 ] && [ "$VLESS_WS_LOCAL" = "$SS_WS_LOCAL" ]; then
    echo "WebSocket local ports must differ" >&2; exit 1
  fi
  for lp in "$VLESS_WS_LOCAL" "$SS_WS_LOCAL"; do
    if reserved_port "$lp"; then echo "WebSocket local port ${lp} collides with a VEIL service" >&2; exit 1; fi
    if [ "$ENABLE_VLESS" = 1 ] && [ "$lp" = "$VLESS_PORT" ]; then echo "WebSocket local port collides with VLESS_PORT" >&2; exit 1; fi
    if [ "$ENABLE_SHADOWSOCKS" = 1 ] && [ "$lp" = "$SS_PORT" ]; then echo "WebSocket local port collides with SS_PORT" >&2; exit 1; fi
  done
fi
XRAY_NFT=""
if [ "$ENABLE_VLESS" = 1 ]; then
  XRAY_NFT="${XRAY_NFT}    tcp dport ${VLESS_PORT} accept                # VLESS Reality
"
fi
if [ "$ENABLE_SHADOWSOCKS" = 1 ]; then
  XRAY_NFT="${XRAY_NFT}    tcp dport ${SS_PORT} accept                   # Shadowsocks-2022
    udp dport ${SS_PORT} accept
"
fi
# Public hosts list (MIT licence, ads + tracking); refreshed weekly.
BLOCKLIST_URL="${BLOCKLIST_URL-https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts}"
WAN_IF="$(ip -o -4 route show to default | awk '{print $5}' | head -1)"
APP_DIR=/opt/veil

echo "==> Packages"
apt-get update -y
# unzip is only there to unpack the Xray zip; the VPN itself does not use it.
XRAY_PKG=""
if [ "$ENABLE_VLESS" = 1 ] || [ "$ENABLE_SHADOWSOCKS" = 1 ]; then XRAY_PKG=unzip; fi
apt-get install -y wireguard nftables unbound certbot curl ca-certificates $XRAY_PKG
[ "$TOR" = 1 ] && apt-get install -y tor
[ "$IKEV2" = 1 ] && apt-get install -y strongswan-swanctl charon-systemd libcharon-extra-plugins libstrongswan-extra-plugins
[ "$OPENVPN" = 1 ] && apt-get install -y openvpn openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> No-logs system settings"
# Keep the journal in memory only, so nothing about traffic survives a reboot.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' > /etc/systemd/journald.conf.d/veil.conf
systemctl restart systemd-journald

echo "==> WireGuard"
umask 077
[ -f /etc/wireguard/wg0.key ] || wg genkey > /etc/wireguard/wg0.key
WG_PRIV="$(cat /etc/wireguard/wg0.key)"
WG_PUB="$(echo "$WG_PRIV" | wg pubkey)"
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.66.0.1/16
ListenPort = 51820
PrivateKey = ${WG_PRIV}
SaveConfig = false
EOF
cat > /etc/sysctl.d/99-veil.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
sysctl --system >/dev/null
systemctl enable --now wg-quick@wg0

echo "==> Firewall and NAT"
# Oracle Cloud's Ubuntu images ship iptables rules that reject everything but SSH. They would sit next to
# VEIL's nftables rules and block the VPN ports, so they are removed (kept as rules.v4.oracle).
if [ -f /etc/iptables/rules.v4 ] && grep -q "icmp-host-prohibited" /etc/iptables/rules.v4; then
  systemctl disable --now netfilter-persistent 2>/dev/null || true
  for t in iptables ip6tables; do $t -P INPUT ACCEPT; $t -P FORWARD ACCEPT; $t -F; $t -X; done
  mv /etc/iptables/rules.v4 /etc/iptables/rules.v4.oracle
  [ -f /etc/iptables/rules.v6 ] && mv /etc/iptables/rules.v6 /etc/iptables/rules.v6.oracle
fi
cat > /etc/nftables.conf <<EOF
flush ruleset
table inet veil {
  # VPN clients who chose Tor over VPN, on any protocol (the node agent adds and removes them).
  set tor_peers { type ipv4_addr; }
  chain prerouting {
    type nat hook prerouting priority dstnat;
    # Their DNS goes to Tor's resolver and all their TCP to Tor's transparent port (both on 10.66.0.1).
    ip saddr @tor_peers udp dport 53 dnat ip to 10.66.0.1:9053
    ip saddr @tor_peers meta l4proto tcp dnat ip to 10.66.0.1:9040
  }
  # Marks packets from VPN clients: WireGuard (wg0), OpenVPN (vpu/vpt), IKEv2 (decrypted IPsec, 10.67/16).
  chain vpn_in {
    type filter hook prerouting priority -150;
    iifname { "wg0", "vpu", "vpt" } meta mark set 0x766c
    meta ipsec exists ip saddr 10.67.0.0/16 meta mark set 0x766c
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    icmp type echo-request limit rate 5/second accept
    tcp dport 22 accept
    tcp dport { 80, 443 } accept          # certbot + HTTPS proxy
    udp dport 51820 accept                # WireGuard
    udp dport { 500, 4500 } accept        # IKEv2 / IPsec (NAT traversal)
    meta l4proto esp accept
    udp dport 1194 accept                 # OpenVPN UDP
    tcp dport 1194 accept                 # OpenVPN TCP
${XRAY_NFT}    meta mark 0x766c udp dport 53 accept  # DNS for VPN clients
    meta mark 0x766c tcp dport 53 accept
    meta mark 0x766c ip saddr @tor_peers tcp dport 9040 accept   # Tor transparent proxy
    meta mark 0x766c ip saddr @tor_peers udp dport 9053 accept   # Tor DNS
    ip saddr { ${CONTROL_IP} } tcp dport 9101 accept   # agent API, control server only (one IP or a comma list of ranges)
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    # Smaller MTU inside tunnels: clamp TCP MSS so pages do not stall.
    tcp flags syn tcp option maxseg size set rt mtu
    # Tor peers never reach the internet directly: anything Tor cannot carry (UDP, ICMP) is dropped.
    ip saddr @tor_peers drop
    meta mark 0x766c oifname "${WAN_IF}" tcp dport { 25, 465, 587 } drop
    meta mark 0x766c oifname "${WAN_IF}" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    meta mark 0x766c oifname "${WAN_IF}" accept
  }
}
table ip veil_nat {
  chain postrouting { type nat hook postrouting priority 100; oifname "${WAN_IF}" ip saddr { 10.66.0.0/16, 10.67.0.0/16, 10.68.0.0/16, 10.69.0.0/16 } masquerade; }
}
EOF
systemctl enable --now nftables
nft -f /etc/nftables.conf

echo "==> Private DNS resolver (no query logging), behind the VEIL tracker filter"
cat > /etc/unbound/unbound.conf.d/veil.conf <<EOF
server:
  interface: 127.0.0.1@5335
  access-control: 127.0.0.0/8 allow
  verbosity: 0
  log-queries: no
  log-replies: no
  hide-identity: yes
  hide-version: yes
  qname-minimisation: yes
EOF
systemctl restart unbound

echo "==> Tracker blocklist (refreshed weekly; the node reloads it every hour)"
mkdir -p /var/lib/veil
cat > /usr/local/sbin/veil-blocklist <<'EOF'
#!/bin/sh
# Downloads the public hosts list to a temp file and swaps it in only if it looks valid.
set -eu
[ -n "${BLOCKLIST_URL:-}" ] || exit 0
t=$(mktemp)
if curl -fsSL --max-time 60 "$BLOCKLIST_URL" -o "$t" && [ "$(grep -c '^0\.0\.0\.0 ' "$t")" -gt 1000 ]; then
  install -m 644 "$t" /var/lib/veil/blocklist-extra.txt
fi
rm -f "$t"
EOF
chmod 755 /usr/local/sbin/veil-blocklist
printf '[Unit]\nDescription=Refresh VEIL tracker blocklist\n[Service]\nType=oneshot\nEnvironment=BLOCKLIST_URL=%s\nExecStart=/usr/local/sbin/veil-blocklist\n' "$BLOCKLIST_URL" > /etc/systemd/system/veil-blocklist.service
printf '[Unit]\nDescription=Weekly VEIL blocklist refresh\n[Timer]\nOnCalendar=weekly\nRandomizedDelaySec=6h\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/veil-blocklist.timer
systemctl daemon-reload
BLOCKLIST_URL="$BLOCKLIST_URL" /usr/local/sbin/veil-blocklist || echo "    (public list download failed; the built-in list is still used)"
systemctl enable --now veil-blocklist.timer

if [ "$TOR" = 1 ]; then
  echo "==> Tor client for Tor over VPN (no relay, no exit: this node only uses the Tor network)"
  cat > /etc/tor/torrc <<EOF
SocksPort 127.0.0.1:9050
TransPort 10.66.0.1:9040
DNSPort 10.66.0.1:9053
VirtualAddrNetworkIPv4 10.192.0.0/10
AutomapHostsOnResolve 1
ExitRelay 0
Log notice syslog
EOF
  # Tor listens on the WireGuard address, so it must start after wg0 is up.
  mkdir -p /etc/systemd/system/tor@default.service.d
  printf '[Unit]\nAfter=wg-quick@wg0.service\nRequires=wg-quick@wg0.service\n' > /etc/systemd/system/tor@default.service.d/veil.conf
  systemctl daemon-reload
  systemctl enable tor
  systemctl restart tor
fi

echo "==> TLS certificate for the HTTPS proxy"
certbot certonly --standalone -n --agree-tos --register-unsafely-without-email -d "${DOMAIN}"

# Hook scripts the VPN daemons run. They only tell the node agent (127.0.0.1:9102) that a login
# connected and which tunnel address it got; nothing is written to disk or logged.
cat > /usr/local/sbin/veil-bind <<'EOF'
#!/bin/sh
# veil-bind <user> <tunnel-ip> <up|down>
case "$3" in up) UP=true ;; *) UP=false ;; esac
curl -fsS -m 5 -o /dev/null -X POST http://127.0.0.1:9102/bind \
  --data-binary "{\"user\":\"$1\",\"ip\":\"$2\",\"up\":$UP}" || true
exit 0
EOF
chmod 755 /usr/local/sbin/veil-bind

if [ "$IKEV2" = 1 ]; then
  echo "==> IKEv2 / IPsec (strongSwan, EAP-MSCHAPv2 logins from the node agent)"
  # The server certificate is the Let's Encrypt one, so Android, iOS, macOS and Windows trust it as is.
  cat > /usr/local/sbin/veil-swan-certs <<EOF
#!/bin/sh
set -e
L=/etc/letsencrypt/live/${DOMAIN}
install -m 644 \$L/cert.pem /etc/swanctl/x509/veil.pem
# strongSwan reads one certificate per file: split the chain (intermediate + cross-signs up to
# ISRG Root X1) so clients that only trust X1 (older Android) can still build the path.
rm -f /etc/swanctl/x509ca/veil-chain*.pem
awk '/BEGIN CERTIFICATE/{n++} n{print > "/etc/swanctl/x509ca/veil-chain" n ".pem"}' \$L/chain.pem
chmod 644 /etc/swanctl/x509ca/veil-chain*.pem
install -m 600 \$L/privkey.pem /etc/swanctl/private/veil.key
swanctl --load-creds --noprompt >/dev/null 2>&1 || true
EOF
  chmod 755 /usr/local/sbin/veil-swan-certs
  /usr/local/sbin/veil-swan-certs
  cat > /usr/local/sbin/veil-ikev2-updown <<'EOF'
#!/bin/sh
# strongSwan updown: the EAP identity is the VEIL login, PLUTO_PEER_SOURCEIP its virtual IP.
case "$PLUTO_VERB" in
  up-client) /usr/local/sbin/veil-bind "$PLUTO_XAUTH_ID" "$PLUTO_PEER_SOURCEIP" up ;;
  down-client) /usr/local/sbin/veil-bind "$PLUTO_XAUTH_ID" "$PLUTO_PEER_SOURCEIP" down ;;
esac
exit 0
EOF
  chmod 755 /usr/local/sbin/veil-ikev2-updown
  mkdir -p /etc/swanctl/conf.d
  [ -f /etc/swanctl/conf.d/veil-secrets.conf ] || printf 'secrets {\n}\n' > /etc/swanctl/conf.d/veil-secrets.conf
  chmod 600 /etc/swanctl/conf.d/veil-secrets.conf
  cat > /etc/swanctl/swanctl.conf <<EOF
connections {
  veil-ikev2 {
    version = 2
    proposals = aes256gcm16-prfsha384-ecp384, aes256gcm16-prfsha256-ecp256, aes256-sha256-modp2048, aes128-sha256-modp2048
    pools = veil-ikev2
    send_cert = always
    unique = never
    fragmentation = yes
    encap = yes
    dpd_delay = 30s
    local {
      auth = pubkey
      certs = veil.pem
      id = ${DOMAIN}
    }
    remote {
      auth = eap-mschapv2
      eap_id = %any
    }
    children {
      veil {
        local_ts = 0.0.0.0/0
        esp_proposals = aes256gcm16, aes128gcm16, aes256-sha256, aes128-sha256
        updown = /usr/local/sbin/veil-ikev2-updown
        dpd_action = clear
      }
    }
  }
}
pools {
  veil-ikev2 {
    addrs = 10.67.0.0/16
    dns = 10.66.0.1
  }
}
include conf.d/*.conf
EOF
  # No connection logs: charon logs errors only, to the volatile journal.
  mkdir -p /etc/strongswan.d
  printf 'charon-systemd {\n  journal {\n    default = -1\n  }\n}\n' > /etc/strongswan.d/veil-logging.conf
  systemctl enable strongswan
  systemctl restart strongswan
  swanctl --load-all --noprompt
fi

if [ "$OPENVPN" = 1 ]; then
  echo "==> OpenVPN (UDP and TCP 1194, own CA, logins checked by the node agent)"
  O=/etc/openvpn/server
  mkdir -p "$O"
  if [ ! -f "$O/veil-ca.key" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$O/veil-ca.key"
    openssl req -new -x509 -key "$O/veil-ca.key" -sha256 -days 3650 -subj "/CN=VEIL ${NODE_ID} CA" -out "$O/veil-ca.crt"
    openssl ecparam -name prime256v1 -genkey -noout -out "$O/veil.key"
    openssl req -new -key "$O/veil.key" -subj "/CN=${DOMAIN}" -out "$O/veil.csr"
    printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyAgreement\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$DOMAIN" > "$O/veil.ext"
    openssl x509 -req -in "$O/veil.csr" -CA "$O/veil-ca.crt" -CAkey "$O/veil-ca.key" -CAcreateserial -days 3650 -sha256 -extfile "$O/veil.ext" -out "$O/veil.crt"
    openvpn --genkey tls-crypt "$O/veil-tc.key"
    chmod 600 "$O"/*.key
  fi
  cat > /usr/local/sbin/veil-ovpn-auth <<'EOF'
#!/bin/sh
# auth-user-pass-verify via-file: $1 holds "username\npassword". Exit 0 lets the client in.
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9102/auth --data-binary @"$1")
[ "$code" = 204 ]
EOF
  cat > /usr/local/sbin/veil-ovpn-connect <<'EOF'
#!/bin/sh
case "$script_type" in
  client-connect) /usr/local/sbin/veil-bind "$username" "$ifconfig_pool_remote_ip" up ;;
  client-disconnect) /usr/local/sbin/veil-bind "$username" "$ifconfig_pool_remote_ip" down ;;
esac
exit 0
EOF
  chmod 755 /usr/local/sbin/veil-ovpn-auth /usr/local/sbin/veil-ovpn-connect
  for P in udp tcp; do
    if [ "$P" = udp ]; then DEV=vpu; NET=10.68.0.0; PROTO=udp; else DEV=vpt; NET=10.69.0.0; PROTO=tcp-server; fi
    cat > "$O/veil-$P.conf" <<EOF
port 1194
proto ${PROTO}
dev ${DEV}
dev-type tun
topology subnet
server ${NET} 255.255.0.0
ca ${O}/veil-ca.crt
cert ${O}/veil.crt
key ${O}/veil.key
dh none
tls-crypt ${O}/veil-tc.key
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305
auth SHA256
verify-client-cert none
username-as-common-name
duplicate-cn
script-security 2
auth-user-pass-verify /usr/local/sbin/veil-ovpn-auth via-file
client-connect /usr/local/sbin/veil-ovpn-connect
client-disconnect /usr/local/sbin/veil-ovpn-connect
push "redirect-gateway def1 bypass-dhcp"
push "block-ipv6"
push "dhcp-option DNS 10.66.0.1"
keepalive 15 60
persist-key
persist-tun
user nobody
group nogroup
status /dev/null
verb 0
mute 10
EOF
    # The stock unit writes a status file listing connected clients' addresses: start without it.
    mkdir -p "/etc/systemd/system/openvpn-server@veil-$P.service.d"
    printf '[Service]\nExecStart=\nExecStart=/usr/sbin/openvpn --suppress-timestamps --config %%i.conf\n' > "/etc/systemd/system/openvpn-server@veil-$P.service.d/veil.conf"
  done
  systemctl daemon-reload
  systemctl enable --now openvpn-server@veil-udp openvpn-server@veil-tcp
fi

echo "==> VEIL node service"
id veil >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin veil
mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/../node" "$(dirname "$0")/../shared" "$APP_DIR/"
printf '{"type":"module"}\n' > "$APP_DIR/package.json"
cat > /etc/veil-node.env <<EOF
NODE_ENV=production
NODE_ID=${NODE_ID}
PROXY_PORT=443
AGENT_PORT=9101
AGENT_HOST=0.0.0.0
TOKEN_SECRET=${TOKEN_SECRET}
AGENT_SECRET=${AGENT_SECRET}
TLS_CERT=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/${DOMAIN}/privkey.pem
WG_IFACE=wg0
DNS_LISTEN=10.66.0.1:53
DNS_UPSTREAM=127.0.0.1:5335
BLOCKLIST=${APP_DIR}/node/blocklist.txt,/var/lib/veil/blocklist-extra.txt
ACCOUNTS_FILE=/var/lib/veil/accounts.json
HOOK_PORT=9102
EOF
[ "$TOR" = 1 ] && echo "TOR_SOCKS=127.0.0.1:9050" >> /etc/veil-node.env
[ "$IKEV2" = 1 ] && echo "SWAN_SECRETS=/etc/swanctl/conf.d/veil-secrets.conf" >> /etc/veil-node.env
if [ "$ENABLE_VLESS" = 1 ] || [ "$ENABLE_SHADOWSOCKS" = 1 ]; then
  echo "==> Xray-core ${XRAY_VERSION} (VLESS Reality / Shadowsocks-2022, off unless opted in)"
  install_xray() {
    local zip pin tmp actual published have
    case "$(uname -m)" in
      x86_64|amd64) zip=Xray-linux-64.zip; pin=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82 ;;
      aarch64|arm64) zip=Xray-linux-arm64-v8a.zip; pin=64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be ;;
      *) echo "Xray-core: unsupported architecture $(uname -m)" >&2; exit 1 ;;
    esac
    have=$(/usr/local/bin/xray version 2>/dev/null | awk 'NR==1{print; exit}' || true)
    case "$have" in *"${XRAY_VERSION#v}"*) return 0 ;; esac
    tmp=$(mktemp -d)
    curl -fsSL --max-time 180 -o "$tmp/xray.zip" "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${zip}"
    curl -fsSL --max-time 60 -o "$tmp/xray.zip.dgst" "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${zip}.dgst"
    published=$(awk -F= '/^SHA2-256=/ { gsub(/[[:space:]]/, "", $2); print $2 }' "$tmp/xray.zip.dgst")
    actual=$(sha256sum "$tmp/xray.zip" | awk '{print $1}')
    if [ "$published" != "$pin" ] || [ "$actual" != "$pin" ]; then
      echo "Xray-core checksum mismatch for ${XRAY_VERSION} ${zip}" >&2
      rm -rf "$tmp"
      exit 1
    fi
    unzip -o -j "$tmp/xray.zip" xray -d /usr/local/bin >/dev/null
    chmod 755 /usr/local/bin/xray
    rm -rf "$tmp"
  }
  install_xray
  mkdir -p /etc/veil /var/lib/veil
  chmod 750 /etc/veil
  chown root:veil /etc/veil
  export ENABLE_VLESS ENABLE_SHADOWSOCKS ENABLE_WS DOMAIN VLESS_PORT SS_PORT VLESS_SNI VLESS_DEST \
    VLESS_FINGERPRINT SS_METHOD WS_PORT WS_HOST WS_SNI VLESS_WS_LOCAL SS_WS_LOCAL
  export XRAY_DNS=10.66.0.1
  export XRAY_STATE=/var/lib/veil/xray-state.json XRAY_CONFIG=/etc/veil/xray.json \
    XRAY_ENV=/var/lib/veil/xray-node.env XRAY_PUBLIC=/var/lib/veil/xray-public.json \
    XRAY_FRAGMENT=/var/lib/veil/xray-fragment.txt
  node "$(cd "$(dirname "$0")/.." && pwd)/shared/proxyproto.js" provision >/dev/null
  chown root:veil /etc/veil/xray.json
  chmod 640 /etc/veil/xray.json
  cat /var/lib/veil/xray-node.env >> /etc/veil-node.env
  cat > /etc/systemd/system/veil-xray.service <<'EOF'
[Unit]
Description=VEIL Xray (VLESS and Shadowsocks)
After=network-online.target wg-quick@wg0.service
Wants=network-online.target
[Service]
User=veil
Group=veil
ExecStart=/usr/local/bin/xray run -config /etc/veil/xray.json
Restart=on-failure
RestartSec=2s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UMask=0077
LimitNOFILE=65535
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now veil-xray
  XRAY_ON=1
else
  systemctl disable --now veil-xray 2>/dev/null || true
fi
chmod 600 /etc/veil-node.env
cat > /etc/systemd/system/veil-node.service <<EOF
[Unit]
Description=VEIL</>™ node
After=network-online.target wg-quick@wg0.service
[Service]
EnvironmentFile=/etc/veil-node.env
ExecStart=/usr/bin/node ${APP_DIR}/node/node.js
Restart=always
# Root is needed for port 443 and for 'wg set'; everything else is locked down.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/run /var/lib/veil$([ "$IKEV2" = 1 ] && printf ' /etc/swanctl/conf.d')
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now veil-node
# Restart the proxy when certbot renews the certificate.
printf '#!/bin/sh\nsystemctl restart veil-node\n[ -x /usr/local/sbin/veil-swan-certs ] && /usr/local/sbin/veil-swan-certs\nexit 0\n' > /etc/letsencrypt/renewal-hooks/deploy/veil-node.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/veil-node.sh

# Text as a JSON string (for the CA certificate and tls-crypt key in nodes.json).
jstr() { node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8").trim()))' "$1"; }
EXTRA=""
[ "$IKEV2" = 1 ] && EXTRA="${EXTRA},
  \"ikev2\": { \"host\": \"${DOMAIN}\", \"dns\": \"10.66.0.1\" }"
[ "$OPENVPN" = 1 ] && EXTRA="${EXTRA},
  \"openvpn\": { \"host\": \"${DOMAIN}\", \"udp\": 1194, \"tcp\": 1194, \"ca\": $(jstr /etc/openvpn/server/veil-ca.crt), \"tlsCrypt\": $(jstr /etc/openvpn/server/veil-tc.key) }"
[ "$TOR" = 1 ] && EXTRA="${EXTRA},
  \"tor\": true"
PROTO_JSON=""
if [ "$XRAY_ON" = 1 ]; then
  PROTO_JSON="$(cat /var/lib/veil/xray-fragment.txt)"
fi

echo
echo "Node ${NODE_ID} is up."
if [ "$XRAY_ON" = 1 ]; then
  echo "VLESS ids and Shadowsocks passwords below are node secrets. Put them only in NODES, never in git."
fi
echo "Add this to the NODES list (control/nodes.json, or the Worker's NODES variable):"
cat <<EOF
{ "id": "${NODE_ID}", "city": "CITY", "country": "COUNTRY", "flag": "FLAG", "region": "eu",
  "agentUrl": "https://${DOMAIN}:9101",
  "proxy": { "scheme": "https", "host": "${DOMAIN}", "port": 443 },
  "wg": { "endpoint": "${DOMAIN}:51820", "publicKey": "${WG_PUB}", "dns": "10.66.0.1" }${EXTRA}${PROTO_JSON} }
EOF
