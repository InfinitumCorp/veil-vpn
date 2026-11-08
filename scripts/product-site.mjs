// Writes the public site (site/) in the shared Infinitum product-site layout: the same header, footer,
// site.css, site.js, motion.js and brand files as mttrn.app, cumuluscloud.app and infinitumaether.app
// (built by work/product-sites.cjs in the Infinitum site workspace). The shell is copied into site/,
// so builds and deploys need nothing outside this repo. Re-run after the shared shell changes:
//   node scripts/product-site.mjs [path/to/a/built/product-site/public]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_DAY, RATE_PER_MIN, TIERS } from '../veil-vpn/economics.js';

const root = path.resolve(import.meta.dirname, '..');
const SHELL = process.argv[2] || 'C:/Users/1/Documents/Codex/2026-11-02/referenced-chatgpt-conversation-this-is-an/outputs/metatron-site/public';
const ORIGIN = 'https://infinitumveilvpn.app';
const MAIN = 'https://infinitumcorporation.ai';
const HUB = 'https://app.infinitumcorporation.ai';
const out = path.join(root, 'site');
if (!existsSync(path.join(SHELL, 'index.html'))) throw new Error(`No product site at ${SHELL}`);

const tm = '<sup class="tm">™</sup>';
const VEIL = `VEIL&lt;/&gt;${tm}`;
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ext = (href, label) => `<a class="text-link" href="${href}" target="_blank" rel="noopener">${label} <span aria-hidden="true">↗︎</span><span class="visually-hidden"> (opens in a new tab)</span></a>`;
const cards = (items) => `<ul class="aether-hardware">${items.map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('')}</ul>`;
const section = (n, eyebrow, h2, body, id = '') => `<section class="section aether-section"${id ? ` id="${id}"` : ''}><span class="eyebrow">${n} / ${eyebrow}</span><h2>${h2}</h2>${body}</section>`;

// ---- shell ----
const tpl = readFileSync(path.join(SHELL, 'index.html'), 'utf8');
const head = tpl.slice(0, tpl.indexOf('<main')).replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, '');
const foot = tpl.slice(tpl.indexOf('</main>'));
const ORG = { '@type': 'Organization', '@id': `${MAIN}/#organization`, name: 'Infinitum Corporation', url: `${MAIN}/`, logo: `${MAIN}/brand/stacked-dark.png` };

function page({ route = '/', title, desc, main, robots = 'index, follow, max-image-preview:large, max-snippet:-1', jsonld = [] }) {
  const url = ORIGIN + route;
  const name = title.replace(/\s*\|.*$/, '');
  const seo = [`<meta name="robots" content="${robots}">`,
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="Infinitum Corporation">`, `<meta property="og:locale" content="en_US">`,
    `<meta property="og:title" content="${attr(name)}">`, `<meta property="og:description" content="${attr(desc)}">`, `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${ORIGIN}/brand/og-card.png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:site" content="@infinitumCorpUS">`, `<meta name="twitter:title" content="${attr(name)}">`,
    `<meta name="twitter:description" content="${attr(desc)}">`, `<meta name="twitter:image" content="${ORIGIN}/brand/og-card.png">`,
    `<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">`,
    jsonld.length ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': jsonld }).replace(/</g, '\\u003c')}</script>` : ''].join('');
  return (head.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`)
    .replace(/ aria-current="page"/g, '')
    .replace('</head>', `<!-- seo -->${seo}<!-- /seo --></head>`)) + main + foot;
}
const heading = (label, h1, ...ps) => `<section class="page-heading section"><div class="section-label"><span class="eyebrow">${label}</span><span class="eyebrow">INFINITUM CORPORATION</span></div><h1>${h1}</h1>${ps.join('')}</section>`;

// ---- downloads (files come from scripts/package-downloads.mjs; a row with no URL says "coming soon") ----
const DOWNLOADS = [
  { id: 'android', name: 'Android', text: 'The whole-phone VPN: every app through one encrypted tunnel, with the kill switch, Tor over VPN, tracker blocking and unsafe Wi-Fi alerts.', platforms: ['Android 8.0+', 'WireGuard', 'IKEv2'], url: '/download/veil-vpn.apk', cta: 'Download the APK', status: 'Signed APK · checksum in SHA256SUMS.txt' },
  { id: 'chrome', name: 'Chrome and Edge', text: 'The browser extension routes the browser through VEIL. Unzip it, open Extensions, turn on Developer mode and choose Load unpacked.', platforms: ['Chrome 120+', 'Edge'], url: '/download/veil-vpn-chrome.zip', cta: 'Download the extension', status: 'Store listing coming soon' },
  { id: 'firefox', name: 'Firefox', text: 'The same extension for Firefox.', platforms: ['Firefox 128+'], url: '', status: 'Download · coming soon' },
  { id: 'iphone', name: 'iPhone and iPad', text: `Until the iOS app is ready, set up the built-in IKEv2 VPN or the OpenVPN app with a login from ${VEIL} on another device.`, platforms: ['iOS'], url: '', status: 'In development' },
];
const dl = (d) => `<li class="download-item" id="${d.id}"><div><h3>${d.name}</h3><p>${d.text}</p><ul class="download-platforms" aria-label="Platforms">${d.platforms.map((x) => `<li>${x}</li>`).join('')}</ul><span class="download-status">${d.status}</span></div>`
  + (d.url ? `<div class="hub-links"><a class="text-link" href="${d.url}" download>${d.cta} <span aria-hidden="true">↓</span></a></div>` : '') + '</li>';

// ---- landing page ----
const people = (n) => (n === 0 ? 'Under 100K' : (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}K`) + '+');
const tierTable = `<table class="aether-table"><thead><tr><th scope="col">Tier</th><th scope="col">Members</th><th scope="col">Community</th><th scope="col">Network and servers</th><th scope="col">Ecosystem</th><th scope="col">Liquidity</th><th scope="col">Team</th><th scope="col">Treasury boost</th></tr></thead><tbody>`
  + TIERS.map(([name, from, c, n, e, l, t, boost]) => `<tr><th scope="row">${name}</th><td>${people(from)}</td><td><strong>${c}%</strong></td><td>${n}%</td><td>${e}%</td><td>${l}%</td><td>${t}%</td><td>${boost > 1 ? `${boost}×` : '—'}</td></tr>`).join('') + '</tbody></table>';
const first = TIERS[0][2], last = TIERS[TIERS.length - 1][2];
const desc = `${'VEIL</>™'} VPN is Infinitum's free VPN for Android, Chrome, Edge and Firefox: WireGuard, IKEv2 and OpenVPN, no logs, tracker blocking and Tor over VPN, paid for by privacy-safe ads, with ${first}–${last}% of the ad revenue shared with the people who use it.`;

const main = `<main id="main"><div class="page-transition">`
  + heading(`PRIVACY / Free VPN`, `${VEIL} VPN`,
    `<p>A free VPN paid for by privacy-safe ads. Half or more of the ad revenue goes back to the people who use it, in $VEIL.</p>`,
    `<p class="pillars">Private. Free. Shared.</p>`,
    `<p class="pillars">WireGuard · IKEv2 · OpenVPN · No logs · Free forever</p>`,
    `<p class="product-site-link"><a class="text-link" href="#get">Get the app <span aria-hidden="true">↓</span></a></p>`)
  + `<section class="section editorial"><span class="eyebrow">OVERVIEW</span><div><span class="catalog-status">Free forever · No account</span>`
  + `<p>${VEIL} VPN encrypts your connection from your device to an Infinitum server and sends it on from there, so the network you are on, and the sites you visit, cannot see who you are or what you do.</p>`
  + `<p>There is no account, no email and no sign-up. One small ad, chosen only by the server location you picked, pays for the network, and each day's ad revenue is shared with the community by the minutes they were connected.</p>`
  + `<p>It is part of the Infinitum ecosystem: $VEIL is claimed to $FIRM Wallet${tm} on Solana, and the ${VEIL} browser and every other Infinitum app are on the ${ext(HUB + '/', 'Infinitum app page')}.</p></div></section>`
  + section('01', `GET ${VEIL} VPN`, 'Free on Android, Chrome and Edge.', `<ul class="download-list">${DOWNLOADS.map(dl).join('')}</ul><p>Every download is signed by Infinitum Corporation. Check a file against <a href="/download/SHA256SUMS.txt">SHA256SUMS.txt</a> before you install it.</p>`, 'get')
  + section('02', 'HOW IT WORKS', 'Encrypted. Nothing kept.', cards([
    ['Every app, one tunnel', 'On Android, all of your phone\'s traffic is encrypted. In Chrome, Edge and Firefox, the extension routes the browser.'],
    ['No account', 'No email and no sign-up. The app gets an anonymous session. We never store the sites you visit, your DNS queries or your IP address.'],
    ['Honest status', '"Protected" appears only after the server has answered through the tunnel, and is checked again every minute.'],
    ['Kill switch', 'If the server drops, traffic is held instead of leaking, and VEIL reconnects on its own.'],
    ['Tor over VPN', 'One switch sends your traffic from our server into the Tor network, .onion sites included. Nothing else to install.'],
    ['Trackers blocked', 'On by default: ad networks, analytics and data collectors are stopped before they connect, in every app. The app shows how many, today.'],
    ['Unsafe Wi-Fi alerts', 'Join Wi-Fi while VEIL is off and your phone tells you, with a stronger warning for open networks. One tap protects you.'],
    ['Ads by location only', 'One small ad, chosen by the server location you picked. Never by what you browse.'],
  ]))
  + section('03', 'PROTOCOLS', 'The protocol that fits your device.', cards([
    ['WireGuard', 'The default on Android: fast, modern and light on battery. The private key is made on your device and never leaves it.'],
    ['IKEv2 / IPsec', 'Built into Android, iPhone, Mac and Windows, so no extra app is needed, and it reconnects smoothly when you move between Wi-Fi and mobile data.'],
    ['OpenVPN', 'Works almost anywhere, over UDP or TCP. Use it with the OpenVPN app on any computer, phone or router.'],
    ['HTTPS proxy', 'What the browser extensions use: the browser\'s traffic, encrypted to our server over port 443.'],
  ]) + `<p>To use VEIL on another device, open <em>Other devices</em> in the app and choose a protocol: you get a WireGuard file, an OpenVPN profile or IKEv2 settings, with a login that lasts 7 days.</p>`)
  + section('04', 'PRIVACY BY DEFAULT', 'What Infinitum can\'t see.', cards([
    ['The sites and apps you use', 'Our servers keep no traffic logs and no DNS logs. Blocked trackers are counted, never named.'],
    ['What you send', 'Traffic is encrypted from your device to our server. HTTPS sites stay encrypted all the way, so the contents are unreadable to us.'],
    ['Who you are', 'No account, email or phone number. Your IP address is never written to disk.'],
    ['Your Wi-Fi', 'Network checks and alerts run on your phone. The network\'s name is never read, and nothing about it is sent to us.'],
    ['Where Tor takes you', 'With Tor over VPN on, our server sees only that you use Tor, not the sites beyond it.'],
    ['What we do keep', 'An anonymous session, minutes connected, ad view counts, a hashed device ID and, if you link one, a wallet address. <a href="/privacy">Details</a>'],
  ]))
  + section('05', 'REVENUE SHARE', 'The community\'s share grows with the network.', tierTable
    + `<p>Each day's ad revenue is split by the tier the network is in. The community share is divided among members by the minutes they were connected that day. Larger tiers also add a treasury boost in $VEIL, funded from the community treasury allocation, never from extra cash.</p>`)
  + section('06', 'EARN $VEIL', 'Use it. Earn $VEIL.', cards([
    ['Per connected minute', `${RATE_PER_MIN} $VEIL`],
    ['Daily limit', `${MAX_DAY} $VEIL`],
    ['Community share today', `${first}% of ad revenue`],
    ['At 10M members', `${last}% of ad revenue`],
  ]) + `<p>To keep the pool fair: one earning account per device, one daily limit per wallet, and no rewards on emulators or rooted phones. $VEIL is a utility token. It is not equity, income or an investment return, and it is not a share in Infinitum.</p>`)
  + `</div></main>`;

const jsonld = [{ '@type': 'SoftwareApplication', '@id': `${ORIGIN}/#app`, name: 'VEIL</> VPN', url: `${ORIGIN}/`, description: desc,
  operatingSystem: 'Android, Chrome, Edge, Firefox', applicationCategory: 'SecurityApplication', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, publisher: { '@id': ORG['@id'] } }, ORG];

// ---- privacy policy: site/privacy-body.html holds the policy text as legal-part sections ----
const policy = readFileSync(path.join(root, 'site/privacy-body.html'), 'utf8');
const privacy = `<main id="main"><div class="page-transition">`
  + heading('VEIL&lt;/&gt; VPN / LEGAL', 'Privacy policy',
    `<p>Applies to the ${VEIL} VPN Android app, the Chrome, Edge and Firefox extensions, and VEIL servers. It adds to the ${ext(MAIN + '/privacy-policy', 'Infinitum Corporation privacy policy')}.</p>`,
    `<p class="legal-updated">${policy.match(/<!-- updated: (.*?) -->/)[1]}</p>`)
  + `<section class="section legal-body">${policy.replace(/<!--[\s\S]*?-->\s*/g, '')}</section></div></main>`;

const notFound = `<main id="main"><div class="page-transition">${heading('404', 'Page not found.', `<p>This page does not exist. <a href="/">Back to ${VEIL} VPN</a></p>`)}</div></main>`;

// ---- write ----
for (const d of ['assets', 'brand']) { rmSync(path.join(out, d), { recursive: true, force: true }); cpSync(path.join(SHELL, d), path.join(out, d), { recursive: true }); }
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'index.html'), page({ title: `${'VEIL&lt;/&gt;™'} VPN | Infinitum Corporation`, desc, main, jsonld }));
writeFileSync(path.join(out, 'privacy.html'), page({ route: '/privacy', title: `${'VEIL&lt;/&gt;™'} VPN Privacy Policy | Infinitum Corporation`, desc: 'What VEIL</>™ VPN collects, what it never collects, and why.', main: privacy }));
writeFileSync(path.join(out, '404.html'), page({ route: '/404', title: 'Page not found | Infinitum Corporation', desc: 'This page does not exist.', main: notFound, robots: 'noindex, follow' }));
writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nContent-Signal: search=yes, ai-input=yes\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
const day = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${ORIGIN}/</loc><lastmod>${day}</lastmod></url>\n  <url><loc>${ORIGIN}/privacy</loc><lastmod>${day}</lastmod></url>\n</urlset>\n`);
writeFileSync(path.join(out, 'llms.txt'), `# VEIL</>™ VPN\n\n> ${desc}\n\n- [Privacy policy](${ORIGIN}/privacy)\n- [All Infinitum apps](${HUB}/)\n- [Infinitum Corporation](${MAIN}/)\n`);
console.log(`Wrote site/ in the Infinitum product-site layout (shell: ${SHELL})`);
