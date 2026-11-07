# Third-party notices

VEIL</>™ ships or bundles the following open-source components.

| Component | Used in | License |
|---|---|---|
| WireGuard tunnel library (`com.wireguard.android:tunnel`) | Android app | Apache-2.0 |
| postgres.js (`postgres`) | Control API Worker (`deploy/api`) | Unlicense |
| StevenBlack hosts list | Downloaded onto VPN nodes by `node/provision.sh`, not stored in this repo | MIT |

Development and test tools only, not shipped: PGlite and pglite-socket (Apache-2.0), Wrangler and `cf`
(MIT OR Apache-2.0), Playwright (Apache-2.0).

"WireGuard" is a registered trademark of Jason A. Donenfeld. VEIL is not affiliated with or endorsed by
the WireGuard project; it uses the protocol through the official library.
