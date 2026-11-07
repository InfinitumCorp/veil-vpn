# VEIL</>™: Google Play listing

Paste these into Play Console → Grow → Store presence → Main store listing.
Images are in `images/` (sizes match Play's requirements).

## App name (30 characters max)

VEIL</>™ VPN

## Short description (80 characters max)

Free, private VPN. Ad revenue shared with the people who use it.

## Full description (4,000 characters max)

VEIL</>™ is a free VPN from Infinitum. It protects every app on your phone with WireGuard, and it is paid for by a few privacy-safe ads instead of a subscription. Half or more of that ad revenue goes back to the community, in $VEIL.

PRIVATE BY DEFAULT
• WireGuard encryption for all apps on your phone.
• No account, no email, no sign-up. The app gets an anonymous session.
• No logs of the sites you visit, your DNS queries or your IP address.
• Our own DNS resolvers, with query logging switched off.
• Kill switch through Android's Always-on VPN: if the tunnel drops, traffic is blocked, not leaked.
• "Protected" only appears after a real handshake with the server.

TOR OVER VPN
Switch it on in Settings and your traffic leaves our server through the Tor network, including .onion sites, without installing anything else. Available on servers marked with Tor.

FREE, FUNDED BY ADS
One small ad in the app, chosen only by the server location you picked. Never by what you browse. No tracking ad networks.

AD REVENUE, SHARED
Every day, the ad revenue is split: 50% goes to the community at launch, rising to 65% as the network grows. Your share depends on the minutes you are connected. The Revenue tab shows today's revenue, the community pool and your estimated share, and each day's payout.

EARN $VEIL
Earn 0.1 $VEIL for every minute you are connected, up to 24 $VEIL a day, plus your share of the ad revenue pool. Link a FIRM Wallet (Solana) to claim.

FAIR FOR EVERYONE
To keep the pool fair, rewards are limited to one account per device and a daily limit per wallet. Rewards are paused on emulators and rooted devices.

$VEIL is a utility token. It is not equity, income or an investment return, and it is not a share in Infinitum. Token rewards may not be available in every country.

## Category and tags

- Category: Tools
- Tags: VPN, Privacy, Security

## Contact

- Email: info@theinfinitumcorporation.com
- Website: (the landing page URL, once it is hosted)
- Privacy policy URL: required for VPN apps. Host `site/privacy.html` (with the landing page) and paste its URL.

## Play Console forms (answers that match how the app works)

**VpnService declaration** (Policy → App content → VPN service)
- Core functionality: yes, the app is a VPN.
- Purpose: encrypts device traffic and routes it to VEIL servers; optional Tor over VPN.
- No data collection through the VPN; no ad injection or traffic redirection for monetization.

**Data safety**
- Data collected: Device or other IDs (a hashed install ID, used for fraud prevention only, not shared). App activity: connected minutes, ad views and clicks counted per anonymous session (app functionality and fraud prevention, not shared).
- Optional: Solana wallet address, only if the user links one to claim rewards.
- Not collected: name, email, phone, location, web browsing, contacts, files.
- Data is encrypted in transit. Users can unlink their wallet in the app.

**Ads**: Contains ads: yes.

**Content rating**: complete the questionnaire; no user-generated content, no gambling. The token reward may require "simulated gambling: no" and a financial-features declaration: rewards are earned by use, not bought.

**Financial features declaration**: the app offers crypto-token rewards. Check Play's policy on blockchain-based content before submitting; you may need to declare it and limit it in some countries.

## Before you submit

1. Build with your real server: `./gradlew bundleRelease -PveilControlUrl=https://api.YOUR-DOMAIN`.
2. Upload `android/app/build/outputs/bundle/release/app-release.aab`.
3. Turn on Play App Signing (Play keeps the app signing key; your file `android/keystore/veil-upload.jks` is only the upload key).
4. Get the legal review of $VEIL payouts first (see the README).
