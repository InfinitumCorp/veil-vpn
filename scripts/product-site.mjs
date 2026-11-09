// Writes the public site (site/) in the VEIL</> look: "Standard Infinitum White", as on infinitumveil.app
// (white, quiet, Helvetica Neue, one coloured dot, top bar with Apps, centred column, pill links, footer).
// No inline scripts or styles in the pages: site/veil.css and site/veil.js. Re-run after editing the text here
// or site/privacy-body.html:  node scripts/product-site.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_DAY, RATE_PER_MIN, TIERS } from '../veil-vpn/economics.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'site');
const ORIGIN = 'https://infinitumveilvpn.app';
const MAIN = 'https://infinitumcorporation.ai';
const HUB = 'https://app.infinitumcorporation.ai';
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The previous corporate-layout shell is no longer used.
for (const d of ['assets', 'brand']) rmSync(path.join(out, d), { recursive: true, force: true });

// ---- shared chrome, matching infinitumveil.app ----
const APPS = [
  ['https://infinitumveil.app/', 'VEIL&lt;/&gt;™ browser', 'Tor-first secure browser'],
  [`${MAIN}/products/architect`, ':\\ARCHITCT\\™', 'Turn an idea into finished work'],
  [`${MAIN}/products/cumulus-exchange`, 'Cumulus://Cloud™', 'AI cloud, storage and data exchange'],
  [`${MAIN}/products/fabric`, 'FABRIC™', 'Secure communications'],
  [`${MAIN}/products/firm#wallet`, 'FIRM Wallet™', 'Token, wallet and exchange'],
  [`${MAIN}/products/metatron`, 'METATRON¹⁰⁰™', 'Consumer command suite'],
  [`${MAIN}/products/scalus`, 'SCALVS.ai™', 'AI workforce platform'],
  [`${HUB}/`, 'All Infinitum apps', 'Every app and download'],
];
const topbar = `<header class="topbar"><a class="brand" href="/">VEIL&lt;/&gt;<sup>™</sup><span class="brand-vpn">VPN</span></a><span class="spacer"></span>
<nav class="top-links" aria-label="Infinitum"><div class="apps-menu"><button type="button" class="nav-link" data-menu="apps-panel" aria-haspopup="true" aria-expanded="false" aria-controls="apps-panel">Apps</button>
<div class="apps-panel" id="apps-panel" role="menu" aria-label="Infinitum apps" hidden>${APPS.map(([h, n, s]) => `<a class="menu-app" role="menuitem" href="${h}" rel="noreferrer"><span class="menu-app-name">${n}</span><span class="menu-app-summary">${s}</span></a>`).join('')}</div></div>
<a class="nav-link" href="/#get">Download</a></nav></header>`;
const appsStrip = `<nav class="apps" aria-label="Infinitum apps"><a class="app-link" href="https://infinitumveil.app/" target="_blank" rel="noopener noreferrer">VEIL&lt;/&gt;™ browser</a><a class="app-link" href="https://rchtch.app/" target="_blank" rel="noopener noreferrer">:\\ARCHITCT\\™</a><a class="app-link" href="https://scalvs.app/" target="_blank" rel="noopener noreferrer">SCALVS.ai™</a><a class="app-link" href="https://infinitumfabric.app/" target="_blank" rel="noopener noreferrer">FABRIC++™</a></nav>`;
const footer = `<footer><span>AI-powered. Blockchain-governed™.</span><span class="footer-right"><a class="footer-link" href="/privacy">Privacy</a><a class="footer-link" href="mailto:info@theinfinitumcorporation.com">Contact</a><span class="quiet">© 2026 Infinitum Corporation</span></span></footer>`;

function page({ route = '/', title, desc, body, cls = '', robots = 'index, follow' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${attr(desc)}">
<meta name="theme-color" content="#ffffff">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${ORIGIN}${route}">
<meta property="og:type" content="website"><meta property="og:site_name" content="VEIL</>™ VPN"><meta property="og:title" content="${attr(title)}"><meta property="og:description" content="${attr(desc)}"><meta property="og:url" content="${ORIGIN}${route}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/veil.css">
</head>
<body class="${cls}">
${topbar}
${body}
${appsStrip}
${footer}
<script src="/veil.js" defer></script>
</body>
</html>
`;
}

// ---- landing page ----
const first = TIERS[0][2], last = TIERS[TIERS.length - 1][2];
const people = (n) => (n === 0 ? 'Under 100K' : (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}K`) + '+');
const facts = (items) => `<ul class="facts">${items.map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('')}</ul>`;
const PANELS = [
  ['how', 'How it works', facts([
    ['Every app, one tunnel', 'On Android, all of your phone\'s traffic is encrypted. In Chrome and Edge, the extension routes the browser.'],
    ['No account', 'No email and no sign-up. The app gets an anonymous session.'],
    ['Honest status', '"Protected" appears only after the server has answered through the tunnel, and is checked again every minute.'],
    ['Kill switch', 'If the server drops, traffic is held instead of leaking, and VEIL reconnects on its own.'],
    ['Tor over VPN', 'One switch sends your traffic from our server into the Tor network, .onion sites included.'],
    ['Trackers blocked', 'On by default: ad networks, analytics and data collectors are stopped before they connect, in every app.'],
    ['Unsafe Wi-Fi alerts', 'Join Wi-Fi while VEIL is off and your phone tells you, with a stronger warning for open networks.'],
    ['Ads by location only', 'One small ad, chosen by the server location you picked. Never by what you browse.'],
  ])],
  ['protocols', 'Protocols', facts([
    ['WireGuard', 'The default on Android: fast, modern and light on battery. The private key never leaves your device.'],
    ['IKEv2 / IPsec', 'Built into Android, iPhone, Mac and Windows, and it reconnects smoothly between Wi-Fi and mobile data.'],
    ['OpenVPN', 'Works almost anywhere, over UDP or TCP, with the OpenVPN app on any computer, phone or router.'],
    ['HTTPS proxy', 'What the browser extensions use: the browser\'s traffic, encrypted to our server over port 443.'],
  ]) + '<p>To use VEIL on another device, open <em>Other devices</em> in the app and choose a protocol. You get a WireGuard file, an OpenVPN profile or IKEv2 settings, with a login that lasts 7 days.</p>'],
  ['cant-see', 'What VEIL can\'t see', facts([
    ['The sites and apps you use', 'No traffic logs and no DNS logs. Blocked trackers are counted, never named.'],
    ['What you send', 'Encrypted from your device to our server. HTTPS sites stay encrypted all the way.'],
    ['Who you are', 'No account, email or phone number. Your IP address is never written to disk.'],
    ['Where Tor takes you', 'With Tor over VPN on, our server sees only that you use Tor.'],
  ]) + '<p>What we do keep: an anonymous session, minutes connected, ad view counts, a hashed device ID and, if you link one, a wallet address. <a href="/privacy">Privacy policy</a></p>'],
  ['share', 'Revenue share', `<table class="tiers"><thead><tr><th scope="col">Tier</th><th scope="col">Members</th><th scope="col">Community</th><th scope="col">Network</th><th scope="col">Boost</th></tr></thead><tbody>`
    + TIERS.map(([name, from, c, n, , , , boost]) => `<tr><th scope="row">${name}</th><td>${people(from)}</td><td><strong>${c}%</strong></td><td>${n}%</td><td>${boost > 1 ? `${boost}×` : '—'}</td></tr>`).join('')
    + `</tbody></table><p>Each day's ad revenue is split by the tier the network is in; the rest goes to ecosystem, liquidity (10%) and team (5%). The community share is divided among members by the minutes they were connected that day. Larger tiers add a treasury boost in $VEIL, never extra cash.</p>`],
  ['earn', 'Earn $VEIL', `<p class="numbers"><span><strong>${RATE_PER_MIN}</strong> $VEIL per connected minute</span><span><strong>${MAX_DAY}</strong> $VEIL daily limit</span><span><strong>${first}–${last}%</strong> of ad revenue to the community</span></p>`
    + '<p>One earning account per device, one daily limit per wallet, and no rewards on emulators or rooted phones. $VEIL is claimed to FIRM Wallet™ on Solana. It is a utility token: not equity, income or an investment return, and not a share in Infinitum Corporation.</p>'],
];
const home = `<main id="main">
<h1 class="headline">Private. Free. Shared.</h1>
<p class="lead">A free VPN paid for by privacy-safe ads. Half or more of the ad revenue goes back to the people who use it.</p>
<div class="workspace-strip"><span class="workspace" title="No account, no logs, nothing kept">Free forever</span></div>
<p class="status">WireGuard · IKEv2 · OpenVPN · No logs · Tor over VPN</p>
<nav class="bookmarks" id="get" aria-label="Get VEIL VPN">
<a class="bookmark" href="/download/veil-vpn.apk" download>VEIL VPN for Android</a>
<a class="bookmark" href="/download/veil-vpn-chrome.zip" download>VEIL VPN for Chrome and Edge</a>
</nav>
<p class="status"><span>Firefox and iPhone soon</span><a class="text-button" href="/download/SHA256SUMS.txt">Checksums</a></p>
<nav class="panel-tabs" aria-label="About VEIL VPN">${PANELS.map(([id, label]) => `<button type="button" class="text-button" data-panel="${id}" aria-expanded="false" aria-controls="${id}">${label}</button>`).join('')}</nav>
${PANELS.map(([id, label, html]) => `<section class="panel" id="${id}" hidden><h2>${label}</h2>${html}</section>`).join('\n')}
</main>`;
const desc = `VEIL</>™ VPN is Infinitum's free VPN for Android, Chrome and Edge: WireGuard, IKEv2 and OpenVPN, no logs, tracker blocking and Tor over VPN, paid for by privacy-safe ads, with ${first}–${last}% of the ad revenue shared with the people who use it.`;

// ---- privacy and 404 ----
const policy = readFileSync(path.join(out, 'privacy-body.html'), 'utf8');
const privacy = `<main id="main" class="doc"><h1>Privacy policy</h1>
<p class="quiet">Applies to the VEIL&lt;/&gt;™ VPN Android app, the Chrome, Edge and Firefox extensions, and VEIL servers. It adds to the <a href="${MAIN}/privacy-policy">Infinitum Corporation privacy policy</a>. ${policy.match(/<!-- updated: (.*?) -->/)[1]}.</p>
${policy.replace(/<!--[\s\S]*?-->\s*/g, '')}</main>`;
const notFound = `<main id="main"><h1 class="headline">Page not found.</h1><p class="lead"><a href="/">Back to VEIL&lt;/&gt;™ VPN</a></p></main>`;

// ---- styles and script ----
const css = `/* Standard Infinitum White, as on infinitumveil.app: white, quiet, Helvetica Neue, one coloured dot. */
:root { --bg: #ffffff; --ink: #111820; --ink-quiet: #6b6b74; --slate: #49545e; --rule: #e8e8ec; --hover: #f3f3f5; --focus: #1f5fd6; --accent: #5b3fd1;
  --font: "Helvetica Neue", Helvetica, Arial, sans-serif; color-scheme: light; }
@media (prefers-contrast: more) { :root { --ink-quiet: var(--ink); --rule: #9a9aa3; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
body { color: var(--ink); font: 15px/1.5 var(--font); min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button { font: inherit; color: inherit; cursor: pointer; }
a { color: inherit; }
[hidden] { display: none !important; }
.topbar { display: flex; align-items: center; gap: 0 12px; min-height: 52px; padding: env(safe-area-inset-top, 0px) 14px 0; border-bottom: 1px solid var(--rule); }
.brand { display: inline-flex; align-items: center; height: 52px; font-size: 19px; letter-spacing: -0.04em; text-decoration: none; white-space: nowrap; }
.brand sup { font-size: .5em; letter-spacing: 0; margin-left: 1px; align-self: flex-start; margin-top: 15px; }
.brand-vpn { margin-left: 8px; font-size: 12px; letter-spacing: .08em; color: var(--ink-quiet); }
.spacer { flex: 1; }
.top-links { display: flex; align-items: center; gap: 22px; }
.nav-link { position: relative; padding: 8px 0; font-size: 13px; color: var(--ink); text-decoration: none; white-space: nowrap; background: none; border: 0; }
.nav-link::after, .app-link::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--ink); transform: scaleX(0); transition: transform .15s ease; }
.nav-link:hover::after, .nav-link:focus-visible::after, .nav-link[aria-expanded="true"]::after { transform: scaleX(1); }
.apps-menu { position: relative; }
.apps-panel { position: absolute; top: 40px; right: -12px; z-index: 10; width: 300px; display: flex; flex-direction: column; padding: 8px; background: #fff; border: 1px solid var(--rule); border-radius: 4px; box-shadow: 0 8px 28px rgba(17, 24, 32, .12); }
.menu-app { display: flex; flex-direction: column; gap: 1px; padding: 9px 12px; border-radius: 3px; text-decoration: none; }
.menu-app:hover, .menu-app:focus-visible { background: var(--hover); }
.menu-app-name { font-size: 14px; }
.menu-app-summary { font-size: 12px; color: var(--ink-quiet); }
main { flex: 1; width: min(620px, 100% - 32px); margin: 0 auto; display: flex; flex-direction: column; justify-content: center; padding: 48px 0 80px; }
.headline { margin: 0; font-size: clamp(30px, 6vw, 44px); font-weight: 400; letter-spacing: -0.03em; line-height: 1.1; text-align: center; }
.lead { margin: 14px auto 0; max-width: 34em; text-align: center; color: var(--slate); }
.workspace-strip { display: flex; justify-content: center; margin-top: 20px; }
.workspace { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; }
.workspace::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.status { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 0; font-size: 12px; color: var(--ink-quiet); text-align: center; }
.text-button { border: 0; background: none; padding: 6px 10px; border-radius: 2px; font-size: 12px; color: var(--ink-quiet); white-space: nowrap; text-decoration: none; }
.text-button:hover, .text-button[aria-expanded="true"] { background: var(--hover); color: var(--ink); }
.bookmarks { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 28px; }
.bookmark { font-size: 12px; padding: 6px 12px; border-radius: 2px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; white-space: nowrap; }
.bookmark:hover { background: var(--hover); }
.panel-tabs { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; margin-top: 28px; }
.panel { margin-top: 16px; padding: 16px; border: 1px solid var(--rule); border-radius: 2px; font-size: 13px; }
.panel h2 { font-size: 14px; font-weight: 400; margin: 0 0 10px; }
.panel p { margin: 10px 0 0; color: var(--ink-quiet); }
.facts { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 20px; }
.facts h3 { margin: 0; font-size: 13px; font-weight: 400; }
.facts p { margin: 2px 0 0; }
.tiers { width: 100%; border-collapse: collapse; font-size: 12px; }
.tiers th, .tiers td { padding: 7px 6px; border-bottom: 1px solid var(--rule); text-align: left; font-weight: 400; }
.tiers thead th { color: var(--ink-quiet); }
.tiers strong { font-weight: 600; }
.numbers { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--ink) !important; }
.doc { justify-content: flex-start; font-size: 14px; }
.doc h1 { font-size: 28px; font-weight: 400; letter-spacing: -0.02em; margin: 0 0 8px; }
.doc h2 { font-size: 15px; font-weight: 600; margin: 28px 0 6px; }
.doc h2 span { display: inline-block; min-width: 2em; color: var(--ink-quiet); font-weight: 400; }
.doc p, .doc li { color: var(--slate); }
.doc ul { padding-left: 1.2em; }
.apps { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px 22px; padding: 0 14px 14px; }
.app-link { position: relative; padding: 8px 0; font-size: 13px; color: var(--slate); text-decoration: none; white-space: nowrap; }
.app-link:hover, .app-link:focus-visible { color: var(--ink); }
.app-link:hover::after, .app-link:focus-visible::after { transform: scaleX(1); }
footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; margin: 0 14px; padding: 14px 0 max(14px, env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--rule); font-size: 12px; }
.quiet { color: var(--ink-quiet); }
.footer-right { display: inline-flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.footer-link { color: var(--ink); text-decoration: none; font-size: 12px; }
.footer-link:hover, .footer-link:focus-visible { text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 560px) {
  .topbar { padding-left: 12px; padding-right: 12px; gap: 6px; }
  .top-links { gap: 16px; }
  .apps-panel { position: fixed; top: calc(52px + env(safe-area-inset-top, 0px)); left: 8px; right: 8px; width: auto; }
  .apps { gap: 2px 18px; }
  footer { flex-direction: column; align-items: center; text-align: center; gap: 8px; }
  .footer-right { justify-content: center; gap: 8px 18px; }
}
`;
const js = `// Apps menu and the panels under the downloads (one open at a time; #how etc. open a panel directly).
(() => {
  const menuBtn = document.querySelector('[data-menu]');
  const menu = menuBtn && document.getElementById(menuBtn.dataset.menu);
  const setMenu = (open) => { if (!menu) return; menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn?.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (menu && !menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  const tabs = [...document.querySelectorAll('[data-panel]')];
  const show = (id) => tabs.forEach((b) => { const on = b.dataset.panel === id; b.setAttribute('aria-expanded', String(on)); document.getElementById(b.dataset.panel).hidden = !on; });
  tabs.forEach((b) => b.addEventListener('click', () => show(b.getAttribute('aria-expanded') === 'true' ? null : b.dataset.panel)));
  const open = () => { const id = location.hash.slice(1); if (tabs.some((b) => b.dataset.panel === id)) show(id); };
  addEventListener('hashchange', open); open();
})();
`;

// ---- write ----
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'veil.css'), css);
writeFileSync(path.join(out, 'veil.js'), js);
writeFileSync(path.join(out, 'index.html'), page({ title: 'VEIL&lt;/&gt;™ VPN: free, private, shared', desc, body: home }));
writeFileSync(path.join(out, 'privacy.html'), page({ route: '/privacy', title: 'VEIL&lt;/&gt;™ VPN privacy policy', desc: 'What VEIL</>™ VPN collects, what it never collects, and why.', body: privacy }));
writeFileSync(path.join(out, '404.html'), page({ route: '/404', title: 'Page not found · VEIL&lt;/&gt;™ VPN', desc: 'This page does not exist.', body: notFound, robots: 'noindex, follow' }));
writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nContent-Signal: search=yes, ai-input=yes\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
const day = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${ORIGIN}/</loc><lastmod>${day}</lastmod></url>\n  <url><loc>${ORIGIN}/privacy</loc><lastmod>${day}</lastmod></url>\n</urlset>\n`);
writeFileSync(path.join(out, 'llms.txt'), `# VEIL</>™ VPN\n\n> ${desc}\n\n- [Privacy policy](${ORIGIN}/privacy)\n- [VEIL</>™ browser](https://infinitumveil.app/)\n- [All Infinitum apps](${HUB}/)\n`);
console.log('Wrote site/ in the VEIL</> look (infinitumveil.app)');
