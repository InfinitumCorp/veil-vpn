#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq wireguard-tools iproute2 curl jq >/dev/null
# client namespace "cli" joined to the host by a veth pair: host 10.99.0.1, client 10.99.0.2
ip netns add cli 2>/dev/null || true
ip link add vh type veth peer name vc 2>/dev/null || true
ip link set vc netns cli 2>/dev/null || true
ip addr add 10.99.0.1/24 dev vh 2>/dev/null || true; ip link set vh up
ip -n cli addr add 10.99.0.2/24 dev vc 2>/dev/null || true; ip -n cli link set vc up; ip -n cli link set lo up
mkdir -p /root/t && cd /root/t
[ -f s.key ] || { wg genkey | tee s.key | wg pubkey > s.pub; wg genkey | tee c.key | wg pubkey > c.pub; }
# server wg0 10.66.0.1, client wgc 10.66.0.2 inside cli
ip link add wg0 type wireguard 2>/dev/null || true
wg set wg0 listen-port 51820 private-key s.key peer "$(cat c.pub)" allowed-ips 10.66.0.2/32
ip addr add 10.66.0.1/24 dev wg0 2>/dev/null || true; ip link set wg0 up
ip -n cli link add wgc type wireguard 2>/dev/null || true
ip netns exec cli wg set wgc private-key c.key peer "$(cat s.pub)" endpoint 10.99.0.1:51820 allowed-ips 10.66.0.0/24 persistent-keepalive 15
ip -n cli addr add 10.66.0.2/24 dev wgc 2>/dev/null || true; ip -n cli link set wgc up
ip netns exec cli ping -c 2 -W 2 10.66.0.1 | tail -1
uname -m; lsb_release -ds
