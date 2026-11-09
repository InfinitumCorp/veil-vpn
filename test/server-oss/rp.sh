#!/bin/bash
cd /root/t; pkill -x rosenpass; sleep 1
rosenpass --version
mkdir -p rp && cd rp
[ -f s.pqsk ] || { rosenpass gen-keys --secret-key s.pqsk --public-key s.pqpk; rosenpass gen-keys --secret-key c.pqsk --public-key c.pqpk; }
ls -la | awk 'NR>1{print $5, $9}' | tr '\n' ' '; echo
echo "PSK before: server=$(wg show wg0 preshared-keys | awk '{print $2}' | cut -c1-8) client=$(ip netns exec cli wg show wgc preshared-keys | awk '{print $2}' | cut -c1-8)"
setsid rosenpass exchange public-key s.pqpk secret-key s.pqsk listen 10.99.0.1:9999 verbose peer public-key c.pqpk wireguard wg0 "$(cat ../c.pub)" > rp-s.log 2>&1 < /dev/null &
setsid ip netns exec cli rosenpass exchange public-key c.pqpk secret-key c.pqsk verbose peer public-key s.pqpk endpoint 10.99.0.1:9999 wireguard wgc "$(cat ../s.pub)" > rp-c.log 2>&1 < /dev/null &
sleep 12
PS=$(wg show wg0 preshared-keys | awk '{print $2}'); PC=$(ip netns exec cli wg show wgc preshared-keys | awk '{print $2}')
echo "PSK after:  server=${PS:0:8} client=${PC:0:8}  match=$([ "$PS" = "$PC" ] && [ "$PS" != "(none)" ] && echo yes || echo NO)"
ip netns exec cli ping -c 3 -W 3 10.66.0.1 | tail -2
ip netns exec cli curl -s -o /dev/null -w "WireGuard + rosenpass PSK, 20 MB: %{speed_download} B/s\n" http://10.66.0.1:8081/blob
grep -iE "exchanged|key|error|warn" rp-s.log | tail -3 | cut -c1-160
echo "rosenpass memory (KB): $(ps -C rosenpass -o rss= | tr '\n' ' ')"
