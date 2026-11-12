import Foundation
import NetworkExtension
import VeilVPNKit

/// Installs the packet tunnel (WireGuard) or the system's IKEv2 profile and reads status back.
/// Saving a profile needs a signed build on a device. Unsigned runs surface `vpn_permission_denied`.
@MainActor
final class TunnelController {
    static let tunnelBundle = "com.infinitum.veilvpn.tunnel"

    func connectWireGuard(_ config: WireGuardConfig, server: String, region: String, token: String?, controlURL: URL, settings: VeilSettings, device: DeviceIdentity) async throws {
        try await stopIKEv2()
        let manager = try await tunnelManager()
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = Self.tunnelBundle
        proto.serverAddress = config.peers.first?.endpoint ?? "VEIL"
        proto.disconnectOnSleep = false
        let policy = OnDemandPolicy(connectOnLaunch: settings.auto, killSwitch: settings.kill)
        proto.includeAllNetworks = OnDemandPlanner.includeAllNetworks(policy)
        proto.excludeLocalNetworks = false
        proto.enforceRoutes = OnDemandPlanner.enforceRoutes(policy)
        proto.providerConfiguration = [
            TunnelProviderKey.wgQuick: config.render(),
            TunnelProviderKey.server: server,
            TunnelProviderKey.token: token ?? "",
            TunnelProviderKey.controlURL: controlURL.absoluteString,
            TunnelProviderKey.tor: settings.tor,
            TunnelProviderKey.block: settings.block,
            TunnelProviderKey.kill: settings.kill,
            TunnelProviderKey.earn: settings.earn,
            TunnelProviderKey.deviceID: device.id,
            TunnelProviderKey.platform: device.platform,
            TunnelProviderKey.region: region,
            TunnelProviderKey.proto: "wireguard",
        ]
        manager.protocolConfiguration = proto
        manager.localizedDescription = "VEIL</>™"
        manager.isEnabled = true
        apply(policy, to: manager)
        try await save(manager)
        try await reload(manager)
        try manager.connection.startVPNTunnel()
    }

    func connectIKEv2(_ login: IKEv2Login, settings: VeilSettings) async throws {
        try await stopTunnel()
        guard let password = KeychainStore.passwordReference(login.password, account: "ikev2") else {
            throw VeilAPIError("vpn_permission_denied")
        }
        let manager = NEVPNManager.shared()
        try await load(manager)
        let proto = NEVPNProtocolIKEv2()
        proto.serverAddress = login.server
        proto.remoteIdentifier = login.remoteID
        proto.username = login.username
        proto.passwordReference = password
        proto.authenticationMethod = .none
        proto.useExtendedAuthentication = true
        proto.disconnectOnSleep = false
        proto.localIdentifier = nil
        let policy = OnDemandPolicy(connectOnLaunch: settings.auto, killSwitch: settings.kill)
        proto.includeAllNetworks = OnDemandPlanner.includeAllNetworks(policy)
        proto.excludeLocalNetworks = false
        proto.enforceRoutes = OnDemandPlanner.enforceRoutes(policy)
        manager.protocolConfiguration = proto
        manager.localizedDescription = "VEIL</>™"
        manager.isEnabled = true
        apply(policy, to: manager)
        try await save(manager)
        try await load(manager)
        try manager.connection.startVPNTunnel()
    }

    func disconnect() async {
        await stopTunnel()
        try? await stopIKEv2()
    }

    func applyOnDemand(_ settings: VeilSettings) async {
        let policy = OnDemandPolicy(connectOnLaunch: settings.auto, killSwitch: settings.kill)
        if let managers = try? await tunnelManagers() {
            for manager in managers {
                if let proto = manager.protocolConfiguration as? NETunnelProviderProtocol {
                    proto.includeAllNetworks = OnDemandPlanner.includeAllNetworks(policy)
                    proto.enforceRoutes = OnDemandPlanner.enforceRoutes(policy)
                    manager.protocolConfiguration = proto
                }
                apply(policy, to: manager)
                try? await save(manager)
            }
        }
        let ike = NEVPNManager.shared()
        if (try? await load(ike)) != nil {
            if let proto = ike.protocolConfiguration {
                proto.includeAllNetworks = OnDemandPlanner.includeAllNetworks(policy)
                proto.enforceRoutes = OnDemandPlanner.enforceRoutes(policy)
                ike.protocolConfiguration = proto
            }
            apply(policy, to: ike)
            try? await save(ike)
        }
    }

    func snapshot(previous: TunnelSnapshot) async -> TunnelSnapshot {
        if let session = await providerSession(), let data = await message(session, TunnelMessage.stats),
           let decoded = try? JSONDecoder().decode(TunnelSnapshot.self, from: data) {
            return decoded
        }
        let status = await currentStatus()
        return Self.map(status, previous: previous)
    }

    func setEarn(_ on: Bool) async {
        guard let session = await providerSession() else { return }
        _ = await message(session, TunnelMessage.setEarn + ":" + (on ? "1" : "0"))
    }

    private func providerSession() async -> NETunnelProviderSession? {
        let managers = (try? await tunnelManagers()) ?? []
        return managers.first?.connection as? NETunnelProviderSession
    }

    private func currentStatus() async -> NEVPNStatus {
        if let session = await providerSession() { return session.status }
        return NEVPNManager.shared().connection.status
    }

    private static func map(_ status: NEVPNStatus, previous: TunnelSnapshot) -> TunnelSnapshot {
        switch status {
        case .connected, .connecting, .reasserting:
            var next = previous
            if next.state == .off { next.state = .connecting }
            return next
        case .disconnecting:
            var next = previous
            next.state = .connecting
            return next
        case .disconnected, .invalid:
            return TunnelSnapshot(server: previous.server, region: previous.region, proto: previous.proto)
        @unknown default:
            return previous
        }
    }

    private func apply(_ policy: OnDemandPolicy, to manager: NEVPNManager) {
        if policy.reconnects {
            let rule = NEOnDemandRuleConnect()
            rule.interfaceTypeMatch = .any
            manager.onDemandRules = [rule]
            manager.isOnDemandEnabled = true
        } else {
            manager.onDemandRules = []
            manager.isOnDemandEnabled = false
        }
    }

    private func tunnelManager() async throws -> NETunnelProviderManager {
        if let existing = try await tunnelManagers().first { return existing }
        return NETunnelProviderManager()
    }

    private func tunnelManagers() async throws -> [NETunnelProviderManager] {
        try await withCheckedThrowingContinuation { continuation in
            NETunnelProviderManager.loadAllFromPreferences { managers, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: managers ?? []) }
            }
        }
    }

    private func stopTunnel() async {
        let managers = (try? await tunnelManagers()) ?? []
        for manager in managers where manager.connection.status != .disconnected && manager.connection.status != .invalid {
            manager.connection.stopVPNTunnel()
        }
    }

    private func stopIKEv2() async throws {
        let manager = NEVPNManager.shared()
        _ = try? await load(manager)
        if manager.connection.status != .disconnected && manager.connection.status != .invalid {
            manager.connection.stopVPNTunnel()
        }
    }

    private func save(_ manager: NEVPNManager) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            manager.saveToPreferences { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func reload(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            manager.loadFromPreferences { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    @discardableResult
    private func load(_ manager: NEVPNManager) async throws -> NEVPNManager {
        try await withCheckedThrowingContinuation { continuation in
            manager.loadFromPreferences { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: manager) }
            }
        }
    }

    private func message(_ session: NETunnelProviderSession, _ text: String) async -> Data? {
        await withCheckedContinuation { continuation in
            do {
                try session.sendProviderMessage(Data(text.utf8)) { data in
                    continuation.resume(returning: data)
                }
            } catch {
                continuation.resume(returning: nil)
            }
        }
    }
}
