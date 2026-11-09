#!/bin/bash
set -uo pipefail
cd /root/t
pkill -f "wstunnel|hysteria|node_exporter|http.server" 2>/dev/null; sleep 1
GH=https://github.com
# ---- downloads (official releases), with published checksums where the project provides them
[ -x wstunnel ] || { curl -sSfL $GH/erebe/wstunnel/releases/download/v11.1.0/wstunnel_11.1.0_linux_arm64.tar.gz | tar xz wstunnel; }
if [ ! -x hysteria ]; then curl -sSfL -o hysteria $GH/apernet/hysteria/releases/latest/download/hysteria-linux-arm64; curl -sSfL -o hashes.txt $GH/apernet/hysteria/releases/latest/download/hashes.txt; chmod +x hysteria; fi
echo "hysteria sha256: $(grep -q "$(sha256sum hysteria | cut -d' ' -f1)" hashes.txt && echo matches || echo MISMATCH)"
if [ ! -x node_exporter ]; then curl -sSfLO $GH/prometheus/node_exporter/releases/download/v1.12.1/node_exporter-1.12.1.linux-arm64.tar.gz; curl -sSfLO $GH/prometheus/node_exporter/releases/download/v1.12.1/sha256sums.txt
  echo "node_exporter sha256: $(grep linux-arm64 sha256sums.txt | sha256sum -c --quiet - && echo matches)"; tar xzf node_exporter-1.12.1.linux-arm64.tar.gz --strip-components=1 node_exporter-1.12.1.linux-arm64/node_exporter; fi
./wstunnel --version | head -1; ./hysteria version 2>/dev/null | grep -i "^Version" ; ./node_exporter --version 2>&1 | head -1

# ---- 1. wstunnel: WireGuard UDP carried inside a TLS WebSocket on TCP 8443
./wstunnel server --restrict-to 127.0.0.1:51820 wss://10.99.0.1:8443 > ws-s.log 2>&1 &
sleep 1
ip netns exec cli ./wstunnel client -L 'udp://127.0.0.1:51821:127.0.0.1:51820?timeout_sec=0' wss://10.99.0.1:8443 > ws-c.log 2>&1 &
sleep 2
# client WireGuard now goes to 127.0.0.1:51821 (wstunnel) instead of straight to the server
ip netns exec cli wg set wgc peer "$(cat s.pub)" endpoint 127.0.0.1:51821
# block direct UDP 51820 from the client, so the only way through is the WebSocket
iptables -I INPUT -i vh -p udp --dport 51820 -j DROP
sleep 1; ip netns exec cli ping -c 3 -W 3 10.66.0.1 | tail -2
echo "wstunnel: server handshake with client endpoint = $(wg show wg0 endpoints | awk '{print $2}')  (127.0.0.1 = came through wstunnel)"
iptables -D INPUT -i vh -p udp --dport 51820 -j DROP
ip netns exec cli wg set wgc peer "$(cat s.pub)" endpoint 10.99.0.1:51820

# ---- 2. hysteria: QUIC proxy with password auth on UDP 8444
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=test -keyout hy.key -out hy.crt 2>/dev/null
cat > hy-s.yaml <<Y
listen: 10.99.0.1:8444
tls: { cert: /root/t/hy.crt, key: /root/t/hy.key }
auth: { type: password, password: veil-test-only }
Y
cat > hy-c.yaml <<Y
server: 10.99.0.1:8444
auth: veil-test-only
tls: { insecure: true }
socks5: { listen: 127.0.0.1:1080 }
Y
mkdir -p www && head -c 20000000 /dev/urandom > www/blob && echo veil-ok > www/ok.txt
(cd www && python3 -m http.server 8080 --bind 10.99.0.1 > ../http.log 2>&1 &)
./hysteria server -c hy-s.yaml > hy-s.log 2>&1 &
sleep 1; ip netns exec cli ./hysteria client -c hy-c.yaml > hy-c.log 2>&1 &
sleep 3
echo "hysteria: $(ip netns exec cli curl -s --socks5-hostname 127.0.0.1:1080 http://10.99.0.1:8080/ok.txt)"
ip netns exec cli curl -s -o /dev/null -w "hysteria 20 MB: %{speed_download} B/s\n" --socks5-hostname 127.0.0.1:1080 http://10.99.0.1:8080/blob
grep -i "client connected" hy-s.log | head -1 | cut -c1-160

# ---- 3. node_exporter: load numbers only, bound to localhost
./node_exporter --web.listen-address=127.0.0.1:9100 --collector.disable-defaults --collector.loadavg --collector.cpu --collector.meminfo --collector.netdev > ne.log 2>&1 &
sleep 2; curl -s 127.0.0.1:9100/metrics | grep -E "^node_load1 |^node_memory_MemAvailable_bytes " ; echo "node_exporter metric lines: $(curl -s 127.0.0.1:9100/metrics | grep -vc '^#')"
