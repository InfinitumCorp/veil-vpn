import NetworkExtension
import os
import VeilVPNKit
import WireGuardKit

/// Packet tunnel for VEIL's WireGuard mode. The private key arrives in the provider
/// configuration from the app and is not logged. DNS uses only the servers in the
/// configuration, and WireGuardKit matches every domain so queries cannot fall back
/// to the system resolver.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let log = Logger(subsystem: "com.infinitum.veilvpn.tunnel", category: "tunnel")
    private let queue = DispatchQueue(label: "com.infinitum.veilvpn.tunnel")
    private var machine = TunnelStateMachine()
    private var config = TunnelProviderConfig()
    private var liveAdapter: WireGuardAdapter?
    private var runtimeTimer: DispatchSourceTimer?
    private var renewTimer: DispatchSourceTimer?
    private var heartbeatTimer: DispatchSourceTimer?

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let adapter = WireGuardAdapter(with: self) { [weak self] level, _ in
            // Adapter messages can contain key material. Record the level only.
            self?.log.debug("wireguard event \(String(describing: level), privacy: .public)")
        }
        liveAdapter = adapter
        config = TunnelProviderConfig(provider.protocolConfiguration as? NETunnelProviderProtocol)
        guard let text = config.wgQuick, let parsed = try? WireGuardConfig.parse(text), parsed.hasProtectedDNS else {
            completionHandler(TunnelError.badConfig)
            return
        }
        guard let tunnel = try? Self.tunnelConfiguration(parsed) else {
            completionHandler(TunnelError.badConfig)
            return
        }
        machine.beginConnect(server: config.server ?? "", region: config.region, proto: "wireguard", tor: config.tor, reconnect: false)
        adapter.start(tunnelConfiguration: tunnel) { [weak self] error in
            if let error {
                self?.machine.fail("start", reconnect: false)
                completionHandler(error)
                return
            }
            self?.schedule()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        runtimeTimer?.cancel()
        renewTimer?.cancel()
        heartbeatTimer?.cancel()
        machine.disconnect()
        guard let adapter = liveAdapter else {
            completionHandler()
            return
        }
        adapter.stop { _ in completionHandler() }
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        let text = String(data: messageData, encoding: .utf8) ?? ""
        if text == TunnelMessage.setEarn {
            config.earn = !config.earn
        } else if text.hasPrefix(TunnelMessage.setEarn + ":") {
            config.earn = text.hasSuffix("1")
        }
        let snapshot = queue.sync { machine.snapshot }
        completionHandler(try? JSONEncoder().encode(snapshot))
    }

    private func schedule() {
        let runtime = DispatchSource.makeTimerSource(queue: queue)
        runtime.schedule(deadline: .now() + 5, repeating: 5)
        runtime.setEventHandler { [weak self] in self?.pollRuntime() }
        runtime.resume()
        runtimeTimer = runtime

        let renew = DispatchSource.makeTimerSource(queue: queue)
        renew.schedule(deadline: .now() + 600, repeating: 600)
        renew.setEventHandler { [weak self] in self?.renewLease() }
        renew.resume()
        renewTimer = renew

        let beat = DispatchSource.makeTimerSource(queue: queue)
        beat.schedule(deadline: .now() + 60, repeating: 60)
        beat.setEventHandler { [weak self] in self?.heartbeat() }
        beat.resume()
        heartbeatTimer = beat
    }

    private func pollRuntime() {
        liveAdapter?.getRuntimeConfiguration { [weak self] text in
            guard let self, let text else { return }
            let runtime = WireGuardRuntime.parse(text)
            self.queue.async {
                _ = self.machine.observeWireGuard(handshake: runtime.handshake, now: Date(), rx: runtime.rx, tx: runtime.tx)
            }
        }
    }

    private func heartbeat() {
        guard config.earn, machine.snapshot.state == .on, let base = config.controlURL, let token = config.token else { return }
        let client = ControlClient(baseURL: base, transport: URLSessionTransport(), device: config.device, token: token)
        Task {
            _ = try? await client.heartbeat(active: true)
        }
    }

    private func renewLease() {
        guard let base = config.controlURL, let token = config.token, let server = config.server, let publicKey = config.publicKey else { return }
        let client = ControlClient(baseURL: base, transport: URLSessionTransport(), device: config.device, token: token)
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await client.connect(server: server, mode: "wireguard", publicKey: publicKey, tor: self.config.tor, block: self.config.block, manual: false)
                guard let remote = result.wireguard, let privateKey = self.config.privateKey else { return }
                let parsed = try WireGuardConfig.fromControl(
                    privateKey: privateKey, address: remote.address, dns: remote.dns,
                    peerPublicKey: remote.peerPublicKey, endpoint: remote.endpoint,
                    allowedIPs: remote.allowedIPs, keepalive: remote.keepalive
                )
                let currentAddress = self.config.address
                if currentAddress != remote.address, let tunnel = try? Self.tunnelConfiguration(parsed) {
                    self.liveAdapter?.stop { _ in
                        self.liveAdapter?.start(tunnelConfiguration: tunnel) { _ in }
                    }
                    self.config.address = remote.address
                    self.config.wgQuick = parsed.render()
                }
                self.queue.async {
                    self.machine.beginConnect(server: server, region: result.server.region, proto: "wireguard", tor: result.tor, reconnect: true)
                }
            } catch {
                self.queue.async { self.machine.fail("network_unreachable", reconnect: true) }
            }
        }
    }

    private static func tunnelConfiguration(_ config: WireGuardConfig) throws -> TunnelConfiguration {
        guard let privateKey = PrivateKey(base64Key: config.privateKey) else { throw TunnelError.badConfig }
        var interface = InterfaceConfiguration(privateKey: privateKey)
        interface.addresses = config.addresses.compactMap { IPAddressRange(from: $0) }
        interface.dns = config.dns.compactMap { DNSServer(from: $0) }
        if interface.dns.isEmpty || interface.addresses.isEmpty { throw TunnelError.badConfig }
        if let mtu = config.mtu, let value = UInt16(exactly: mtu) { interface.mtu = value }
        let peers: [PeerConfiguration] = config.peers.compactMap { peer in
            guard let publicKey = PublicKey(base64Key: peer.publicKey) else { return nil }
            var item = PeerConfiguration(publicKey: publicKey)
            if let preshared = peer.presharedKey { item.preSharedKey = PreSharedKey(base64Key: preshared) }
            item.allowedIPs = peer.allowedIPs.compactMap { IPAddressRange(from: $0) }
            if let endpoint = peer.endpoint { item.endpoint = Endpoint(from: endpoint) }
            if let keepalive = peer.keepalive, let value = UInt16(exactly: keepalive) { item.persistentKeepAlive = value }
            return item
        }
        if peers.isEmpty { throw TunnelError.badConfig }
        return TunnelConfiguration(name: "VEIL", interface: interface, peers: peers)
    }
}

private enum TunnelError: Error { case badConfig }

private struct TunnelProviderConfig {
    var wgQuick: String?
    var server: String?
    var token: String?
    var controlURL: URL?
    var tor = false
    var block = true
    var kill = true
    var earn = true
    var deviceID = ""
    var platform = "ios"
    var region = "global"
    var address: String?
    var publicKey: String?
    var privateKey: String?

    var device: DeviceIdentity { DeviceIdentity(id: deviceID, platform: platform, integrity: "") }

    init() {}

    init(_ proto: NETunnelProviderProtocol?) {
        let values = proto?.providerConfiguration ?? [:]
        wgQuick = values[TunnelProviderKey.wgQuick] as? String
        server = values[TunnelProviderKey.server] as? String
        token = values[TunnelProviderKey.token] as? String
        if let raw = values[TunnelProviderKey.controlURL] as? String { controlURL = URL(string: raw) }
        tor = values[TunnelProviderKey.tor] as? Bool ?? false
        block = values[TunnelProviderKey.block] as? Bool ?? true
        kill = values[TunnelProviderKey.kill] as? Bool ?? true
        earn = values[TunnelProviderKey.earn] as? Bool ?? true
        deviceID = values[TunnelProviderKey.deviceID] as? String ?? ""
        platform = values[TunnelProviderKey.platform] as? String ?? "ios"
        region = values[TunnelProviderKey.region] as? String ?? "global"
        if let text = wgQuick, let parsed = try? WireGuardConfig.parse(text) {
            address = parsed.addresses.first
            privateKey = parsed.privateKey
            publicKey = (try? WireGuardKeyPair(base64Private: parsed.privateKey))?.publicKey
        }
    }
}
