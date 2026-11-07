#!/usr/bin/env bash
# Provisions one VEIL</>™ node on a fresh Ubuntu 24.04 server.
# Usage (as root):
#   NODE_ID=zrh-1 DOMAIN=zrh-1.vpn.example.com TOKEN_SECRET=... AGENT_SECRET=... CONTROL_IP=203.0.113.10 bash provision.sh
# Add TOR=1 to also offer Tor over VPN from this node (users switch it on in Settings).
# Tracker blocking is on for every node: VPN clients' DNS goes through the VEIL filter on 10.66.0.1:53,
# which answers "no such domain" for listed trackers and passes the rest to a private unbound resolver.
# Set BLOCKLIST_URL='' to use only the built-in list (node/blocklist.txt).
# Prints the node's WireGuard public key at the end: put it in control/nodes.json.
set -euo pipefail

: "${NODE_ID:?set NODE_ID}" "${DOMAIN:?set DOMAIN}" "${TOKEN_SECRET:?set TOKEN_SECRET}" "${AGENT_SECRET:?set AGENT_SECRET}" "${CONTROL_IP:?set CONTROL_IP}"
TOR="${TOR:-0}"
# Public hosts list (MIT licence, ads + tracking); refreshed weekly.
BLOCKLIST_URL="${BLOCKLIST_URL-https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts}"
WAN_IF="$(ip -o -4 route show to default | awk '{print $5}' | head -1)"
APP_DIR=/opt/veil

echo "==> Packages"
apt-get update -y
apt-get install -y wireguard nftables unbound certbot curl ca-certificates
[ "$TOR" = 1 ] && apt-get install -y tor
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
cat > /etc/nftables.conf <<EOF
flush ruleset
table inet veil {
  # WireGuard peers who chose Tor over VPN (the node agent adds and removes them).
  set tor_peers { type ipv4_addr; }
  chain prerouting {
    type nat hook prerouting priority dstnat;
    # Their DNS goes to Tor's resolver and all their TCP to Tor's transparent port.
    iifname "wg0" ip saddr @tor_peers udp dport 53 redirect to :9053
    iifname "wg0" ip saddr @tor_peers meta l4proto tcp redirect to :9040
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    icmp type echo-request limit rate 5/second accept
    tcp dport 22 accept
    tcp dport { 80, 443 } accept          # certbot + HTTPS proxy
    udp dport 51820 accept                # WireGuard
    iifname "wg0" udp dport 53 accept     # DNS for VPN clients
    iifname "wg0" tcp dport 53 accept
    iifname "wg0" ip saddr @tor_peers tcp dport 9040 accept   # Tor transparent proxy
    iifname "wg0" ip saddr @tor_peers udp dport 9053 accept   # Tor DNS
    ip saddr ${CONTROL_IP} tcp dport 9101 accept   # agent API, control server only
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    # Tor peers never reach the internet directly: anything Tor cannot carry (UDP, ICMP) is dropped.
    iifname "wg0" ip saddr @tor_peers drop
    iifname "wg0" oifname "${WAN_IF}" tcp dport { 25, 465, 587 } drop
    iifname "wg0" oifname "${WAN_IF}" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    iifname "wg0" oifname "${WAN_IF}" accept
  }
}
table ip veil_nat {
  chain postrouting { type nat hook postrouting priority 100; oifname "${WAN_IF}" ip saddr 10.66.0.0/16 masquerade; }
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
EOF
[ "$TOR" = 1 ] && echo "TOR_SOCKS=127.0.0.1:9050" >> /etc/veil-node.env
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
ReadWritePaths=/run
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now veil-node
# Restart the proxy when certbot renews the certificate.
printf '#!/bin/sh\nsystemctl restart veil-node\n' > /etc/letsencrypt/renewal-hooks/deploy/veil-node.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/veil-node.sh

echo
echo "Node ${NODE_ID} is up."
echo "Add this to control/nodes.json:"
cat <<EOF
{ "id": "${NODE_ID}", "city": "CITY", "country": "COUNTRY", "flag": "FLAG", "region": "eu",
  "agentUrl": "https://${DOMAIN}:9101",
  "proxy": { "scheme": "https", "host": "${DOMAIN}", "port": 443 },
  "wg": { "endpoint": "${DOMAIN}:51820", "publicKey": "${WG_PUB}", "dns": "10.66.0.1" }$([ "$TOR" = 1 ] && printf ',\n  "tor": true') }
EOF
