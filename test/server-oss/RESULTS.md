# Open-source server tools: test results (2026-11-09)

Tested on a temporary AWS server, separate from the live Columbus node: t4g.micro (Graviton, arm64),
Ubuntu 24.04, us-east-2, its own security group that allowed only SSH from the owner. The "client" is a
second network namespace on the same server, joined by a virtual cable (`base.sh`), so no VPN port was
open to the internet. The live node and `node/provision.sh` were not changed.

| Tool | Licence | Result | Notes |
|---|---|---|---|
| WireGuard (baseline) | GPL-2.0 kernel module, used as-is | ✅ ~205 MB/s | Reference speed on this server size. |
| rosenpass 0.2.3 | MIT / Apache-2.0 | ✅ | Server and client agreed a post-quantum preshared key, set it on both WireGuard ends, and rotated it after ~2 minutes; traffic kept flowing. ~5 MB RAM each. **No arm64 Linux release**: built from source (`rp-build.sh`, ~25 min on t4g.micro with 3 GB swap; needs ~6 GB disk). Public keys are **512 KB** (Classic McEliece), so the app/API needs a way to carry them. |
| wstunnel 11.1.0 | BSD-3-Clause | ✅ ~34 MB/s | WireGuard carried inside a TLS WebSocket on TCP 8443 with direct UDP 51820 blocked. `--restrict-to 127.0.0.1:51820` refused a client asking for any other target. Slower than plain WireGuard (TCP inside TLS), fine as a fallback for networks that block UDP. |
| hysteria 2.13.0 | MIT | ✅ ~130 MB/s | QUIC on UDP 8444 with password auth, SOCKS5 on the client. Download matched the published `hashes.txt`. |
| node_exporter 1.12.1 | Apache-2.0 | ✅ | Only loadavg, cpu, meminfo and netdev collectors, bound to 127.0.0.1:9100: 200 metric lines, no per-user data. Download matched `sha256sums.txt`. |
| cloudflared 2026.10.7 | Apache-2.0 | ⏸ not tested | Starting a public quick tunnel needs the owner's approval; a named tunnel needs their Cloudflare account. |

## What it means for `node/provision.sh` (not changed yet; needs the owner's go-ahead)

1. **node_exporter**: smallest, lowest-risk addition; feeds a real `load` value to `/v1/servers`.
2. **wstunnel**: add a "WireGuard over HTTPS" option. On a live node it would share 443 with the HTTPS proxy, so it needs a path-based split or its own port.
3. **hysteria**: a new protocol mode; needs app and control-API support before it is useful.
4. **rosenpass**: needs a prebuilt arm64 binary we build once and publish (with checksums), and an API/app change to exchange the 512 KB public keys.

Big disk lesson: an 8 GB disk is too small to build rosenpass; use 20 GB or build elsewhere.
