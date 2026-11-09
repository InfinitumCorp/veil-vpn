#!/bin/bash
cd /root/t; pkill -f wstunnel; sleep 1
ls -la wstunnel; chmod +x wstunnel; ./wstunnel --version | head -1
./wstunnel server --restrict-to 127.0.0.1:51820 wss://10.99.0.1:8443 > ws-s.log 2>&1 &
sleep 1
ip netns exec cli ./wstunnel client -L 'udp://127.0.0.1:51821:127.0.0.1:51820?timeout_sec=0' wss://10.99.0.1:8443 > ws-c.log 2>&1 &
sleep 2
ip netns exec cli wg set wgc peer "$(cat s.pub)" endpoint 127.0.0.1:51821
iptables -I INPUT -i vh -p udp --dport 51820 -j DROP
sleep 1; ip netns exec cli ping -c 3 -W 3 10.66.0.1 | tail -2
ip netns exec cli curl -s -o /dev/null -w "wstunnel through WireGuard, 20 MB: %{speed_download} B/s\n" http://10.66.0.1:8080/blob
echo "server sees client WireGuard at $(wg show wg0 endpoints | awk '{print $2}') (127.0.0.1 = through wstunnel)"
echo "direct UDP 51820 drops while blocked: $(iptables -L INPUT -v -n | awk '/dpt:51820/{print $1}') packets"
# a client that skips the allowed target is refused
ip netns exec cli timeout 5 ./wstunnel client -L 'tcp://127.0.0.1:2222:127.0.0.1:22' wss://10.99.0.1:8443 > ws-bad.log 2>&1 &
sleep 2; ip netns exec cli timeout 4 bash -c 'echo | nc -w3 127.0.0.1 2222' | head -c 40; echo " <- reply to a forbidden target (empty = refused)"
grep -ci "rejected\|not allowed\|restrict" ws-s.log
iptables -D INPUT -i vh -p udp --dport 51820 -j DROP
ip netns exec cli wg set wgc peer "$(cat s.pub)" endpoint 10.99.0.1:51820
