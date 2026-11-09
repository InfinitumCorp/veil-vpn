# Third-party notices

VEIL</>™ ships or bundles the following open-source components.

| Component | Used in | License |
|---|---|---|
| WireGuard tunnel library (`com.wireguard.android:tunnel`) | Android app | Apache-2.0 |
| postgres.js (`postgres`) | Control API Worker (`deploy/api`) | Unlicense |
| StevenBlack hosts list | Downloaded onto VPN nodes by `node/provision.sh`, not stored in this repo | MIT |
| v2fly geoip (`geoip.dat`) | Opt-in download via `scripts/fetch-geo-dat.mjs` into `data/geo/` (not stored in this repo). Release `202611080027`. Used unmodified. | CC-BY-SA-4.0 |
| v2fly domain-list-community (`dlc.dat`, saved as `geosite.dat`) | Same opt-in download. Release `20261108011013`. Used unmodified. | MIT |

Geo routing datasets are not loaded unless the node switch is on (`VEIL_GEO_ENABLED=1` or
`node/geo.config.json`). The client Settings switch is off by default and does not change the full tunnel.

**v2fly geoip** — © v2fly contributors. Source: <https://github.com/v2fly/geoip/releases/tag/202611080027>
(`geoip.dat`, SHA-256 `eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2`).
License: Creative Commons Attribution-ShareAlike 4.0 International,
<https://creativecommons.org/licenses/by-sa/4.0/>. Attribution is this notice. Share-alike applies
if the dataset is adapted. VEIL does not copy Loyalsoldier or sing-box lists.

**v2fly domain-list-community** — source: <https://github.com/v2fly/domain-list-community/releases/tag/20261108011013>
(asset `dlc.dat`, SHA-256 `dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2`).

```
MIT License

Copyright (c) 2018-2019 V2Ray

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Development and test tools only, not shipped: PGlite and pglite-socket (Apache-2.0), Wrangler and `cf`
(MIT OR Apache-2.0), Playwright (Apache-2.0).

"WireGuard" is a registered trademark of Jason A. Donenfeld. VEIL is not affiliated with or endorsed by
the WireGuard project; it uses the protocol through the official library.
