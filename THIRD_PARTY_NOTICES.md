# Third-party notices

VEIL</>™ ships or bundles the following open-source components.

| Component | Used in | License |
|---|---|---|
| WireGuard tunnel library (`com.wireguard.android:tunnel`) | Android app | Apache-2.0 |
| WireGuardKit (`WireGuard/wireguard-apple`, commit `2fec12a6e1f6e3460b6ee483aa00ad29cddadab1`) | Apple packet tunnel. Fetched at build time, not copied into this repo | MIT |
| swift-crypto | `VeilVPNKit` key generation and Cumulus://ID PKCE. Fetched by Swift Package Manager | Apache-2.0 |
| postgres.js (`postgres`) | Control API Worker (`deploy/api`) | Unlicense |
| StevenBlack hosts list | Downloaded onto VPN nodes by `node/provision.sh`, not stored in this repo | MIT |
| Xray-core | Installed on a node by `node/provision.sh` only when `ENABLE_VLESS` or `ENABLE_SHADOWSOCKS` is set. Not vendored in this repo. Pinned release, checksum verified | MPL-2.0 |

Development and test tools only, not shipped: PGlite and pglite-socket (Apache-2.0), Wrangler and `cf`
(MIT OR Apache-2.0), Playwright (Apache-2.0).

"WireGuard" is a registered trademark of Jason A. Donenfeld. VEIL is not affiliated with or endorsed by
the WireGuard project; it uses the protocol through the official library.
