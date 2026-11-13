import Foundation

public enum WireGuardConfigError: Error, Equatable {
    case tooLarge
    case invalid
    case missingPrivateKey
    case missingPeer
    case missingDNS
}

public struct WireGuardPeer: Equatable, Sendable {
    public var publicKey: String
    public var presharedKey: String?
    public var allowedIPs: [String]
    public var endpoint: String?
    public var keepalive: Int?

    public init(publicKey: String, presharedKey: String? = nil, allowedIPs: [String], endpoint: String? = nil, keepalive: Int? = nil) {
        self.publicKey = publicKey
        self.presharedKey = presharedKey
        self.allowedIPs = allowedIPs
        self.endpoint = endpoint
        self.keepalive = keepalive
    }
}

/// A wg-quick configuration. Parsing and rendering live here so they can be tested without Apple frameworks.
public struct WireGuardConfig: Equatable, Sendable {
    public static let maxBytes = 64 * 1024
    public var privateKey: String
    public var addresses: [String]
    public var dns: [String]
    public var mtu: Int?
    public var peers: [WireGuardPeer]

    public init(privateKey: String, addresses: [String], dns: [String], mtu: Int? = nil, peers: [WireGuardPeer]) {
        self.privateKey = privateKey
        self.addresses = addresses
        self.dns = dns
        self.mtu = mtu
        self.peers = peers
    }

    public var isFullTunnel: Bool {
        let ips = Set(peers.flatMap(\.allowedIPs).map { $0.replacingOccurrences(of: " ", with: "") })
        return ips.contains("0.0.0.0/0") && ips.contains("::/0")
    }

    /// DNS leak protection requires at least one tunnel DNS server. The provider then matches every domain.
    public var hasProtectedDNS: Bool { !dns.isEmpty }

    public static func parse(_ text: String) throws -> WireGuardConfig {
        guard text.utf8.count <= maxBytes else { throw WireGuardConfigError.tooLarge }
        var section = ""
        var interfaceFields: [String: [String]] = [:]
        var peerFields: [[String: [String]]] = []
        var current: [String: [String]] = [:]
        func take(_ key: String, _ value: String) {
            current[key, default: []].append(value)
        }
        for raw in text.split(whereSeparator: \.isNewline) {
            let line: String
            if let hash = raw.firstIndex(of: "#") { line = String(raw[..<hash]) } else { line = String(raw) }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix(";") { continue }
            if trimmed.hasPrefix("["), trimmed.hasSuffix("]") {
                if section == "Peer" { peerFields.append(current) }
                if section == "Interface" { interfaceFields = current }
                current = [:]
                section = String(trimmed.dropFirst().dropLast())
                continue
            }
            guard let eq = trimmed.firstIndex(of: "=") else { throw WireGuardConfigError.invalid }
            let key = trimmed[..<eq].trimmingCharacters(in: .whitespaces)
            let value = trimmed[trimmed.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            take(key, value)
        }
        if section == "Peer" { peerFields.append(current) }
        if section == "Interface" { interfaceFields = current }
        guard let privateKey = interfaceFields["PrivateKey"]?.first, WireGuardKeyPair.isValid(privateKey) else {
            throw WireGuardConfigError.missingPrivateKey
        }
        let peers = try peerFields.map { fields -> WireGuardPeer in
            guard let publicKey = fields["PublicKey"]?.first, WireGuardKeyPair.isValid(publicKey) else {
                throw WireGuardConfigError.missingPeer
            }
            return WireGuardPeer(
                publicKey: publicKey,
                presharedKey: fields["PresharedKey"]?.first,
                allowedIPs: splitList(fields["AllowedIPs"] ?? []),
                endpoint: fields["Endpoint"]?.first,
                keepalive: fields["PersistentKeepalive"]?.first.flatMap(Int.init)
            )
        }
        guard !peers.isEmpty else { throw WireGuardConfigError.missingPeer }
        let config = WireGuardConfig(
            privateKey: privateKey,
            addresses: splitList(interfaceFields["Address"] ?? []),
            dns: splitList(interfaceFields["DNS"] ?? []),
            mtu: interfaceFields["MTU"]?.first.flatMap(Int.init),
            peers: peers
        )
        guard config.hasProtectedDNS else { throw WireGuardConfigError.missingDNS }
        return config
    }

    public func render() -> String {
        var lines = ["[Interface]", "PrivateKey = \(privateKey)"]
        if !addresses.isEmpty { lines.append("Address = \(addresses.joined(separator: ", "))") }
        if !dns.isEmpty { lines.append("DNS = \(dns.joined(separator: ", "))") }
        if let mtu { lines.append("MTU = \(mtu)") }
        for peer in peers {
            lines.append("")
            lines.append("[Peer]")
            lines.append("PublicKey = \(peer.publicKey)")
            if let presharedKey = peer.presharedKey { lines.append("PresharedKey = \(presharedKey)") }
            if !peer.allowedIPs.isEmpty { lines.append("AllowedIPs = \(peer.allowedIPs.joined(separator: ", "))") }
            if let endpoint = peer.endpoint { lines.append("Endpoint = \(endpoint)") }
            if let keepalive = peer.keepalive { lines.append("PersistentKeepalive = \(keepalive)") }
        }
        lines.append("")
        return lines.joined(separator: "\n")
    }

    /// The `wireguard` object returned by `POST /v1/connect`, plus the device private key.
    public static func fromControl(privateKey: String, address: String, dns: String, peerPublicKey: String, endpoint: String, allowedIPs: String, keepalive: Int) throws -> WireGuardConfig {
        guard WireGuardKeyPair.isValid(privateKey) else { throw WireGuardConfigError.missingPrivateKey }
        guard WireGuardKeyPair.isValid(peerPublicKey) else { throw WireGuardConfigError.missingPeer }
        let dnsServers = splitList([dns])
        guard !dnsServers.isEmpty else { throw WireGuardConfigError.missingDNS }
        return WireGuardConfig(
            privateKey: privateKey,
            addresses: splitList([address]),
            dns: dnsServers,
            peers: [WireGuardPeer(publicKey: peerPublicKey, allowedIPs: splitList([allowedIPs]), endpoint: endpoint, keepalive: keepalive)]
        )
    }
}

func splitList(_ values: [String]) -> [String] {
    values.flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }.filter { !$0.isEmpty }
}

/// Runtime counters from a WireGuard UAPI dump (`wgGetConfig`).
public struct WireGuardRuntime: Equatable, Sendable {
    public var rx: UInt64
    public var tx: UInt64
    public var handshake: Date?

    public static func parse(_ uapi: String) -> WireGuardRuntime {
        var rx: UInt64 = 0
        var tx: UInt64 = 0
        var latest: TimeInterval = 0
        for line in uapi.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            switch parts[0] {
            case "rx_bytes": rx += UInt64(parts[1]) ?? 0
            case "tx_bytes": tx += UInt64(parts[1]) ?? 0
            case "last_handshake_time_sec":
                latest = max(latest, TimeInterval(parts[1]) ?? 0)
            default: break
            }
        }
        return WireGuardRuntime(rx: rx, tx: tx, handshake: latest > 0 ? Date(timeIntervalSince1970: latest) : nil)
    }
}
