import Foundation
import NetworkExtension
import Observation
import SwiftUI
import VeilVPNKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum AppTab: String, CaseIterable, Identifiable {
    case connect, servers, earn, revenue, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .connect: return "Connect"
        case .servers: return "Locations"
        case .earn: return "Earn"
        case .revenue: return "Revenue"
        case .settings: return "Settings"
        }
    }
}

@MainActor
@Observable
final class VeilModel {
    var tab: AppTab = .connect
    var servers: [VeilServer] = []
    var selectedID: String?
    var link = TunnelSnapshot()
    var settings = VeilSettings.default
    var account: AccountSnapshot?
    var pool: PoolSnapshot?
    var revenue: RevenueSnapshot?
    var ad: SponsorAd?
    var blocked = 0
    var networkType = "none"
    var now = Date()
    var toast: String?
    var setup: DeviceSetup?
    var setupFiles: [SetupFile] = []
    var search = ""
    var deviceMode = "wireguard"
    var walletDraft = ""
    var busy = false
    private(set) var booted = false

    let tunnels = TunnelController()
    private let client: ControlClient
    private let device: DeviceIdentity
    private let controlURL: URL
    private let defaults = UserDefaults.standard
    private var ticks = 0
    private var lastAlertID: String?
    private var lastAlertAt: Date?
    private var sceneActive = true
    private var uiTest = false

    init() {
        let isUITest = CommandLine.arguments.contains("-veil-ui-test")
        uiTest = isUITest
        let platform: String
        #if os(macOS)
        platform = "macos"
        #else
        platform = "ios"
        #endif
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        #if DEBUG
        let debuggable = true
        #else
        let debuggable = false
        #endif
        device = DeviceIdentity(
            id: KeychainStore.deviceID(),
            platform: platform,
            integrity: isUITest ? "" : DeviceIdentity.integrityList(simulator: simulator, debuggable: debuggable)
        )
        controlURL = Self.controlURL()
        client = ControlClient(
            baseURL: controlURL,
            transport: URLSessionTransport(),
            device: device,
            token: KeychainStore.sessionToken()
        )
        if let data = defaults.data(forKey: "veil-vpn-settings") {
            settings = VeilSettings(json: data)
        }
        selectedID = defaults.string(forKey: "veil-vpn-server")
    }

    func boot() async {
        guard !booted else { return }
        booted = true
        if uiTest { return }
        await reloadAccount()
        await loadServers()
        link = await tunnels.snapshot(previous: link)
        if settings.auto, link.state == .off, selectedID != nil {
            await togglePower()
        }
        Task { await poll() }
    }

    func setScene(active: Bool) { sceneActive = active }

    func togglePower() async {
        if link.state != .off {
            await tunnels.disconnect()
            link = TunnelSnapshot(server: selectedID, region: link.region, proto: settings.tunnelProto)
            return
        }
        guard let server = selected else {
            show(VeilCopy.error("unknown_server"))
            return
        }
        if settings.tor && !server.tor {
            show(VeilCopy.error("tor_unavailable"))
            return
        }
        link.state = .connecting
        link.server = server.id
        busy = true
        defer { busy = false }
        do {
            try await persistToken()
            if settings.tunnelProto == "ikev2" {
                let result = try await client.connect(server: server.id, mode: "ikev2", publicKey: nil, tor: settings.tor, block: settings.block, manual: false)
                guard let login = result.ikev2 else { throw VeilAPIError("ikev2_unavailable") }
                try await tunnels.connectIKEv2(login, settings: settings)
                link.region = result.server.region
                link.tor = result.tor
                link.proto = "ikev2"
            } else {
                let key = try KeychainStore.deviceKey()
                let result = try await client.connect(server: server.id, mode: "wireguard", publicKey: key.publicKey, tor: settings.tor, block: settings.block, manual: false)
                guard let remote = result.wireguard else { throw VeilAPIError("wireguard_unavailable") }
                let config = try WireGuardConfig.fromControl(
                    privateKey: key.privateKey, address: remote.address, dns: remote.dns,
                    peerPublicKey: remote.peerPublicKey, endpoint: remote.endpoint,
                    allowedIPs: remote.allowedIPs, keepalive: remote.keepalive
                )
                guard config.hasProtectedDNS else { throw VeilAPIError("config_no_dns") }
                try await tunnels.connectWireGuard(config, server: server.id, region: result.server.region, token: await client.currentToken(), controlURL: controlURL, settings: settings, device: device)
                link.region = result.server.region
                link.tor = result.tor
                link.proto = "wireguard"
            }
            defaults.set(server.id, forKey: "veil-vpn-server")
            await persistToken()
            await loadAd()
        } catch {
            link.state = .off
            show(Self.message(error))
        }
    }

    func choose(_ server: VeilServer) async {
        guard server.online else { return }
        selectedID = server.id
        defaults.set(server.id, forKey: "veil-vpn-server")
        tab = .connect
        if link.state == .on || link.state == .connecting || link.state == .error {
            await togglePower()
            await togglePower()
        }
    }

    func importConfig(_ text: String) async {
        do {
            let config = try WireGuardConfig.parse(text)
            guard config.hasProtectedDNS else { throw VeilAPIError("config_no_dns") }
            if settings.kill && !config.isFullTunnel {
                show("That configuration does not cover every network. The kill switch holds only the routes it lists.")
            }
            link.state = .connecting
            try await tunnels.connectWireGuard(config, server: selectedID ?? "import", region: selected?.region ?? "global", token: await client.currentToken(), controlURL: controlURL, settings: settings, device: device)
            show("Imported")
        } catch {
            show(Self.message(error))
        }
    }

    func toggle(_ key: String) async {
        switch key {
        case "block": settings.block.toggle()
        case "alerts": settings.alerts.toggle()
        case "kill": settings.kill.toggle()
        case "tor":
            if !settings.tor, let selected, !selected.tor {
                show(VeilCopy.error("tor_unavailable"))
                return
            }
            settings.tor.toggle()
        case "auto": settings.auto.toggle()
        case "earn":
            settings.earn.toggle()
            await tunnels.setEarn(settings.earn)
        case "vless": settings.vless.toggle()
        case "shadowsocks": settings.shadowsocks.toggle()
        case "ws": settings.ws.toggle()
        default: break
        }
        let offered = ManualSetup.deviceModes(vless: settings.vless, shadowsocks: settings.shadowsocks, webSocket: settings.ws)
        if !offered.contains(where: { $0.0 == deviceMode }) { deviceMode = "wireguard" }
        saveSettings()
        if key == "kill" || key == "auto" { await tunnels.applyOnDemand(settings) }
        if (key == "tor" || key == "block"), link.state != .off {
            show(key == "block" ? (settings.block ? "Tracker blocking on" : "Tracker blocking off") : (settings.tor ? "Reconnecting through Tor" : "Leaving Tor"))
            await togglePower()
            await togglePower()
        }
    }

    func setProto(_ proto: String) async {
        let next = VeilSettings.normalize(proto)
        guard next != settings.tunnelProto else { return }
        settings.proto = next
        saveSettings()
        if link.state != .off {
            await togglePower()
            await togglePower()
        }
    }

    func submitWallet() async {
        do {
            if account?.wallet != nil {
                account = try await client.wallet(nil)
                walletDraft = ""
                show("Unlinked")
            } else {
                let address = walletDraft.trimmingCharacters(in: .whitespaces)
                guard SolanaAddress.isValid(address) else { show(VeilCopy.error("bad_solana_address")); return }
                account = try await client.wallet(address)
                show("Linked")
            }
            await persistToken()
        } catch {
            show(Self.message(error))
        }
    }

    func claim() async {
        do {
            let queued = try await client.claim()
            show(queued > 0 ? "Claim queued" : "Nothing to claim")
            account = try await client.me()
        } catch {
            show(Self.message(error))
        }
    }

    func copyInvite() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(VeilBrand.siteURL.absoluteString, forType: .string)
        #else
        UIPasteboard.general.string = VeilBrand.siteURL.absoluteString
        #endif
        show("Copied")
    }

    func openAd() {
        guard let ad else { return }
        if link.state == .on { Task { try? await client.adEvent(id: ad.id, kind: "click") } }
    }

    func prepareDeviceSetup() async {
        guard let server = selected else { show(VeilCopy.error("unknown_server")); return }
        if !server.modes.isEmpty, !server.modes.contains(deviceMode) {
            show(VeilCopy.error("\(deviceMode)_unavailable"))
            return
        }
        busy = true
        defer { busy = false }
        do {
            var publicKey: String?
            var privateKey: String?
            if deviceMode == "wireguard" {
                let keys = try WireGuardKeyPair.generate()
                publicKey = keys.publicKey
                privateKey = keys.privateKey
            }
            let proxy = deviceMode == "vless" || deviceMode == "vless-ws" || deviceMode == "shadowsocks" || deviceMode == "shadowsocks-ws"
            let result = try await client.connect(server: server.id, mode: deviceMode, publicKey: publicKey, tor: proxy ? false : settings.tor, block: settings.block, manual: true)
            var files = result.setup?.files ?? []
            if deviceMode == "wireguard", let privateKey, let remote = result.wireguard {
                files = [try ManualSetup.wireGuardFile(city: server.city, privateKey: privateKey, remote: remote)]
            }
            setup = result.setup
            setupFiles = files
            await persistToken()
        } catch {
            show(Self.message(error))
        }
    }

    /// Returns true when an unsafe-Wi-Fi alert should be shown. At most once per 15 minutes.
    func noteNetwork(_ type: String) -> Bool {
        let previous = networkType
        networkType = type
        guard settings.alerts, type == "wifi", previous != "wifi", link.state != .on else { return false }
        let now = Date()
        guard AlertThrottle.shouldFire(lastID: lastAlertID, lastAt: lastAlertAt, id: "wifi", now: now) else { return false }
        lastAlertID = "wifi"
        lastAlertAt = now
        return true
    }

    var selected: VeilServer? { servers.first { $0.id == selectedID } ?? servers.first }
    var filteredServers: [VeilServer] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return servers }
        return servers.filter { "\($0.city) \($0.country)".lowercased().contains(query) }
    }

    var sessionClock: String {
        guard link.state == .on, let since = link.sinceDate else { return "00:00:00" }
        return VeilFormat.hms(Int(now.timeIntervalSince(since)))
    }

    var networkLine: String? {
        VeilCopy.networkLine(type: networkType, risk: "none", protected: link.state == .on)
    }

    var networkWarn: Bool { link.state != .on && networkType != "none" }

    func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: "veil-vpn-settings")
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            now = Date()
            ticks += 1
            let next = await tunnels.snapshot(previous: link)
            if next.state != link.state || next.rx != link.rx || next.tx != link.tx || next.tor != link.tor {
                link = next
            } else {
                link.rx = next.rx
                link.tx = next.tx
            }
            if ticks % 10 == 0 {
                await reloadAccount()
                if tab == .earn { await loadPool() }
                if tab == .revenue { await loadRevenue() }
            }
            if ticks % 30 == 0 { await loadAd() }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func loadServers() async {
        do {
            servers = try await client.servers()
            await persistToken()
            if selectedID == nil || !servers.contains(where: { $0.id == selectedID }) {
                selectedID = servers.first(where: \.online)?.id ?? servers.first?.id
            }
        } catch {
            show("Offline")
        }
    }

    private func reloadAccount() async {
        account = try? await client.me()
        if link.state == .on, settings.block {
            blocked = (try? await client.blocked())?.blocked ?? blocked
        }
        await persistToken()
    }

    func loadPool() async { pool = try? await client.pool() }
    func loadRevenue() async { revenue = try? await client.revenue() }

    func loadAd() async {
        let next = try? await client.ad(region: selected?.region ?? "global")
        if let next { ad = next }
        if link.state == .on, sceneActive, let ad {
            try? await client.adEvent(id: ad.id, kind: "view")
        }
    }

    private func persistToken() async {
        KeychainStore.setSessionToken(await client.currentToken())
    }

    private func show(_ text: String) {
        toast = text
        Task {
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            if toast == text { toast = nil }
        }
    }

    private static func controlURL() -> URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "VEILControlURL") as? String, let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        return VeilBrand.controlURL
    }

    private static func message(_ error: Error) -> String {
        if let api = error as? VeilAPIError { return VeilCopy.error(api.code) }
        if let config = error as? WireGuardConfigError {
            switch config {
            case .missingDNS: return VeilCopy.error("config_no_dns")
            case .tooLarge: return VeilCopy.error("config_too_large")
            case .missingPrivateKey: return VeilCopy.error("bad_private_key")
            default: return VeilCopy.error("config_invalid")
            }
        }
        let ns = error as NSError
        if ns.domain == NEVPNErrorDomain { return VeilCopy.error("vpn_permission_denied") }
        return VeilCopy.error("network_unreachable")
    }
}
