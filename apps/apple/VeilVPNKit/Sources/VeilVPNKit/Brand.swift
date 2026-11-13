import Foundation

/// Colors and type from the Android app's interface (`veil-vpn/app.css`).
/// Hex values are `RRGGBB`. The Apple UI reads these instead of inventing a palette.
public enum VeilBrand {
    public static let ink = 0x000000
    public static let muted = 0x555555
    public static let grey = 0x777777
    public static let line = 0xE4E4E4
    public static let paper = 0xFFFFFF
    public static let warn = 0xB42318
    public static let splitNetwork = 0x444444
    public static let splitEcosystem = 0x888888
    public static let splitLiquidity = 0xBBBBBB
    public static let fontName = "Helvetica Neue"
    public static let controlURL = URL(string: "https://api.infinitumveilvpn.app")!
    public static let siteURL = URL(string: "https://infinitumveilvpn.app/")!
    public static let privacyURL = URL(string: "https://infinitumveilvpn.app/privacy.html")!
    public static let firmWalletURL = URL(string: "https://firmwallet.app/?ref=veil")!
    public static let firmamentURL = URL(string: "https://firmnetwork.app/?ref=veil")!
    /// Cumulus://ID issuer. Same host the public site uses (`site/cumulus-id.js`).
    public static let cumulusIssuer = URL(string: "https://mail.cumuluscloud.app")!
    public static let cumulusClientID = "veil-vpn"
}

public enum VeilCopy {
    public static func statusWord(_ state: LinkState) -> String {
        switch state {
        case .off: return "Not protected."
        case .connecting: return "Connecting."
        case .on: return "Protected."
        case .error: return "Reconnecting."
        }
    }

    public static func powerLabel(_ state: LinkState) -> String {
        switch state {
        case .off: return "Connect"
        case .connecting: return "Cancel"
        case .on, .error: return "Disconnect"
        }
    }

    public static func ipLine(state: LinkState, tor: Bool, killSwitch: Bool) -> String {
        switch state {
        case .on: return tor ? "Tunnel active · via Tor" : "Tunnel active"
        case .error: return killSwitch ? "Traffic held" : "Traffic direct"
        case .off, .connecting: return "Unprotected"
        }
    }

    public static func protoLabel(_ proto: String) -> String {
        switch proto {
        case "ikev2": return "IKEv2"
        case "openvpn": return "OpenVPN"
        case "proxy": return "HTTPS"
        default: return "WireGuard"
        }
    }

    public static func protoHint(_ proto: String) -> String {
        switch proto {
        case "ikev2": return "IKEv2/IPsec: the VPN built into the system, steady when switching Wi-Fi and mobile data"
        case "openvpn": return "OpenVPN: works on almost any network"
        default: return "WireGuard: fastest, modern cryptography"
        }
    }

    /// Same sentences as the Android interface (`paintNet` in `veil-vpn/app.js`).
    public static func networkLine(type: String, risk: String, protected: Bool) -> String? {
        if type == "none" { return nil }
        let name: String
        switch type {
        case "wifi": name = "This Wi-Fi"
        case "cellular": name = "Mobile data"
        case "ethernet": name = "This network"
        default: name = "This network"
        }
        if protected { return "\(name): protected" }
        switch risk {
        case "open": return "\(name) is not encrypted. Connect to protect it."
        case "wep": return "\(name) uses weak encryption. Connect to protect it."
        case "captive": return "\(name) needs you to sign in. Connect to protect it."
        default: return "\(name): not protected"
        }
    }

    public static func shield(block: Bool, connected: Bool, blocked: Int) -> (text: String, count: String) {
        if !block { return ("Tracker blocking off", "") }
        if connected { return ("Blocking trackers", "\(VeilFormat.grouped(blocked)) blocked today") }
        return ("Tracker blocking on", "")
    }

    public static func alert(risk: String) -> (title: String, body: String) {
        switch risk {
        case "open", "wep":
            return ("Unsafe Wi-Fi: not protected", "This network is not encrypted. People nearby can see what you send. Tap Protect now.")
        case "captive":
            return ("Wi-Fi sign-in page", "Sign in to this Wi-Fi, then tap Protect now so the network owner cannot see your traffic.")
        default:
            return ("Not protected on this Wi-Fi", "The network owner can see which sites you visit. Tap Protect now.")
        }
    }

    public static func alertFailed(_ code: String?) -> String {
        switch code {
        case "tor_unavailable": return "This location has no Tor exit. Open VEIL to pick another, or turn Tor off."
        case "server_offline": return "That location is offline. Open VEIL to pick another."
        default: return "VEIL could not connect. Open the app to try again."
        }
    }

    public static func hold(_ code: String?) -> String? {
        switch code {
        case "under_review": return "Rewards paused: this account is under review."
        case "device_limit": return "Rewards paused: another account on this device already earned today."
        case "device_unverified": return "Rewards paused: update the app to keep earning."
        case "network_limit": return "Rewards paused: too many accounts are earning on this network today."
        case "daily_limit": return "Rewards paused: this wallet reached the daily limit."
        default: return nil
        }
    }

    public static func error(_ code: String) -> String {
        let known: [String: String] = [
            "not_connected": "Connect first",
            "no_wallet": "Link a FIRM Wallet first",
            "bad_solana_address": "That is not a valid Solana address",
            "server_offline": "That server is offline",
            "tor_unavailable": "This location has no Tor exit yet. Pick another, or turn Tor off",
            "wallet_in_use": "That wallet is linked to too many accounts",
            "rate_limited": "Too many attempts, try again shortly",
            "ikev2_unavailable": "This location has no IKEv2 yet. Pick another, or switch protocol",
            "openvpn_unavailable": "This location has no OpenVPN yet. Pick another",
            "wireguard_unavailable": "This location has no WireGuard yet. Pick another",
            "vless_unavailable": "This location has no VLESS yet. Pick another, or turn VLESS off",
            "vless-ws_unavailable": "This location has no VLESS over WebSocket yet. Turn WebSocket on at the server, or pick another",
            "shadowsocks_unavailable": "This location has no Shadowsocks yet. Pick another, or turn Shadowsocks off",
            "shadowsocks-ws_unavailable": "This location has no Shadowsocks over WebSocket yet. Turn WebSocket on at the server, or pick another",
            "vpn_permission_denied": "VPN permission was not given",
            "bad_public_key": "The WireGuard key was rejected",
            "unknown_server": "That location is not on the list",
            "network_unreachable": "The control server could not be reached",
            "config_too_large": "That configuration is too large",
            "config_invalid": "That is not a WireGuard configuration",
            "config_no_dns": "That configuration has no DNS server, so queries could leak",
            "bad_private_key": "That private key is not a WireGuard key",
        ]
        return known[code] ?? "Something went wrong (\(code))"
    }
}
