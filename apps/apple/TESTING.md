# Testing the Apple apps

VEIL</>™ for macOS 14 and iOS 17 lives in this folder. The screens follow the Android app: Connect, Locations, Earn, Ad revenue, and Settings, in the same white / black / Helvetica Neue layout. Shared rules (WireGuard configs, keys, the connection state machine, the control API, on-demand and DNS policy) are in the `VeilVPNKit` package so they can be tested without Xcode.

## Package tests (Linux or Mac)

Requires Swift 5.9 or newer. On Linux, install `g++` first. `swift-crypto` builds BoringSSL, and the Swift.org toolchain needs the libstdc++ headers on its include path (`CPLUS_INCLUDE_PATH` and `LIBRARY_PATH` pointing at `/usr/include/c++/<version>` and `/usr/lib/gcc/x86_64-linux-gnu/<version>`). The GitHub workflow sets those.

```bash
cd apps/apple/VeilVPNKit
swift test
```

These tests cover config parsing, key handling, the state machine, control-server JSON, on-demand rules, DNS leak policy, and the Cumulus://ID PKCE checks.

## Xcode (macOS 14+, Xcode 16+)

The project is `apps/apple/VeilVPN.xcodeproj`. It builds an iOS and macOS app and a Network Extension packet tunnel. WireGuardKit is fetched from `WireGuard/wireguard-apple` at commit `2fec12a6e1f6e3460b6ee483aa00ad29cddadab1` (MIT). The Go bridge is not in the Swift package, so the tunnel target runs `scripts/build-wireguard-go.sh`. Install Go 1.22 first (`brew install go`). Before opening the project the first time, fetch WireGuardKit into `.build/wireguard-apple` (the project uses it as a local package): `bash scripts/build-wireguard-go.sh --fetch-only`.

No signing identity is required to compile:

```bash
cd apps/apple
xcodebuild -project VeilVPN.xcodeproj -scheme VeilVPN \
  -destination 'generic/platform=iOS' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  build

xcodebuild -project VeilVPN.xcodeproj -scheme VeilVPN \
  -destination 'generic/platform=macOS' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  build
```

UI tests launch the app with `-veil-ui-test` and walk Connect, Locations, Earn, and Settings. They do not start a tunnel. On a Mac they need an ad-hoc signature so the process can launch; that uses no certificate and no secret:

```bash
xcodebuild -project VeilVPN.xcodeproj -scheme VeilVPN \
  -destination 'platform=macOS' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  test
```

For the iOS simulator, pick an installed iPhone and use the same ad-hoc identity.

## A real tunnel

Network Extension will not install a packet tunnel from an unsigned build, and it will not run in the simulator as a system VPN the way it does on a phone. To connect:

1. Open the project in Xcode, set your team on the VeilVPN and VeilTunnel targets, and enable the Network Extension and Personal VPN capabilities. Do not commit the team id or a provisioning profile.
2. Run on a device (iPhone) or a Mac.
3. The first Connect asks the system for VPN permission. Until that is allowed, the app stays on **Not protected.** and says permission was not given.
4. The control server is `https://api.infinitumveilvpn.app`. For a local server, change `VEIL_CONTROL_URL` in `Config/Shared.xcconfig` (the `/$()` keeps the URL from being read as a comment). Do not point a release build at plain HTTP except on your own machine. Local networking is allowed in the app transport settings for that.

WireGuard is the default, matching Android. IKEv2 uses Apple's built-in client. The private key is created on the device and stored in the Keychain. Only the public key is sent to `POST /v1/connect`.

## What is not the same as a signed device

- **Kill switch.** Android opens the system "Always-on VPN / Block connections without VPN" screen. Apple has no public switch like that for a normal app. The toggle turns on on-demand reconnect plus `includeAllNetworks` and `enforceRoutes`, which holds traffic while the tunnel is up. MDM always-on VPN is not shipped.
- **DNS.** WireGuard sets the tunnel DNS (the node's `10.66.0.1` unless a config says otherwise) with match-all domains and no system fallback. IKEv2 uses the DNS the node assigns; there is no separate client DNS list on Apple's IKEv2 API.
- **Wi-Fi security.** Android can see open and WEP without reading the network name. Apple does not give a general VPN app the Wi-Fi security type, so the status line says protected or not protected and does not claim open or WEP. Alerts fire while the app is running, at most once every 15 minutes. They are not delivered when the app has been killed, because iOS will not run the Android-style network callback in the background.
- **Cumulus://ID.** The Android app does not sign the VPN session in with Cumulus://ID. The session is still the anonymous `POST /v1/session` token. The same PKCE flow as the website is implemented and tested in `VeilVPNKit` and is not a button on these screens. The FIRM Wallet block is the early-access state the Android WebView shows.
- **VLESS and Shadowsocks** are set-ups for other apps, as on Android. This app does not tunnel them.
- **Rewards while the phone is locked** depend on the tunnel extension's heartbeat. That runs only after a signed tunnel is up.
