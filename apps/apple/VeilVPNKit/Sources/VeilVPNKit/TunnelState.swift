import Foundation

/// Connection states reported by the Android client: off, connecting, on, error.
public enum LinkState: String, Codable, Equatable, Sendable {
    case off, connecting, on, error
}

/// Snapshot shape matches `Vpn.snapshot()` in the Android app.
public struct TunnelSnapshot: Codable, Equatable, Sendable {
    public var state: LinkState
    public var server: String?
    public var region: String
    public var since: Int64
    public var rx: UInt64
    public var tx: UInt64
    public var error: String?
    public var tor: Bool
    public var proto: String

    public init(state: LinkState = .off, server: String? = nil, region: String = "global", since: Int64 = 0, rx: UInt64 = 0, tx: UInt64 = 0, error: String? = nil, tor: Bool = false, proto: String = "wireguard") {
        self.state = state
        self.server = server
        self.region = region
        self.since = since
        self.rx = rx
        self.tx = tx
        self.error = error
        self.tor = tor
        self.proto = proto
    }

    enum CodingKeys: String, CodingKey {
        case state, server, region, since, rx, tx, error, tor
        case proto = "protocol"
    }

    public var sinceDate: Date? { since > 0 ? Date(timeIntervalSince1970: Double(since) / 1000) : nil }
}

/// The same decisions as `Vpn.check` in the Android app.
/// "on" is reported only after a fresh handshake (WireGuard) or a connected session (IKEv2).
public struct TunnelStateMachine: Equatable, Sendable {
    public static let handshakeFresh: TimeInterval = 180
    public private(set) var snapshot: TunnelSnapshot

    public init(snapshot: TunnelSnapshot = TunnelSnapshot()) {
        self.snapshot = snapshot
    }

    public mutating func beginConnect(server: String, region: String, proto: String, tor: Bool, reconnect: Bool) {
        if !reconnect {
            snapshot.state = .connecting
            snapshot.since = 0
        }
        snapshot.server = server
        snapshot.region = region
        snapshot.proto = proto
        snapshot.tor = tor
        snapshot.error = nil
    }

    /// A failed first connect returns to off. A failed renewal stays on error and leaves the tunnel up.
    public mutating func fail(_ code: String, reconnect: Bool) {
        snapshot.error = code
        snapshot.state = reconnect ? .error : .off
        if !reconnect { snapshot.since = 0 }
    }

    public mutating func disconnect() {
        snapshot.state = .off
        snapshot.since = 0
        snapshot.rx = 0
        snapshot.tx = 0
        snapshot.tor = false
        snapshot.error = nil
    }

    /// WireGuard: fresh when the last handshake is younger than three minutes.
    public mutating func observeWireGuard(handshake: Date?, now: Date, rx: UInt64, tx: UInt64) -> LinkState {
        guard snapshot.state != .off else { return snapshot.state }
        snapshot.rx = rx
        snapshot.tx = tx
        let fresh = handshake.map { now.timeIntervalSince($0) < Self.handshakeFresh && now >= $0 } ?? false
        if fresh {
            if snapshot.since == 0 { snapshot.since = Self.millis(now) }
            snapshot.state = .on
        } else if snapshot.state == .on {
            snapshot.state = .error
        }
        return snapshot.state
    }

    /// IKEv2: the system reports the session as up or down. There is no handshake timestamp.
    public mutating func observeSession(up: Bool, now: Date) -> LinkState {
        guard snapshot.state != .off else { return snapshot.state }
        if up {
            if snapshot.since == 0 { snapshot.since = Self.millis(now) }
            snapshot.state = .on
        } else if snapshot.state == .on {
            snapshot.state = .error
        }
        return snapshot.state
    }

    public static func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
}

public struct VeilSettings: Codable, Equatable, Sendable {
    public var block: Bool
    public var alerts: Bool
    public var kill: Bool
    public var tor: Bool
    public var auto: Bool
    public var earn: Bool
    public var proto: String
    public var vless: Bool
    public var shadowsocks: Bool
    public var ws: Bool

    public init(block: Bool = true, alerts: Bool = true, kill: Bool = true, tor: Bool = false, auto: Bool = false, earn: Bool = true, proto: String = "wireguard", vless: Bool = false, shadowsocks: Bool = false, ws: Bool = false) {
        self.block = block
        self.alerts = alerts
        self.kill = kill
        self.tor = tor
        self.auto = auto
        self.earn = earn
        self.proto = Self.normalize(proto)
        self.vless = vless
        self.shadowsocks = shadowsocks
        self.ws = ws
    }

    public static let `default` = VeilSettings()

    enum CodingKeys: String, CodingKey {
        case block, alerts, kill, tor, auto, earn, proto, vless, shadowsocks, ws
    }

    /// The Apple and Android apps tunnel WireGuard or IKEv2. Anything else falls back to WireGuard.
    public static func normalize(_ proto: String) -> String {
        proto == "ikev2" ? "ikev2" : "wireguard"
    }

    public var tunnelProto: String { Self.normalize(proto) }

    public init(json: Data) {
        self = (try? JSONDecoder().decode(VeilSettings.self, from: json)) ?? .default
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            block: try container.decodeIfPresent(Bool.self, forKey: .block) ?? true,
            alerts: try container.decodeIfPresent(Bool.self, forKey: .alerts) ?? true,
            kill: try container.decodeIfPresent(Bool.self, forKey: .kill) ?? true,
            tor: try container.decodeIfPresent(Bool.self, forKey: .tor) ?? false,
            auto: try container.decodeIfPresent(Bool.self, forKey: .auto) ?? false,
            earn: try container.decodeIfPresent(Bool.self, forKey: .earn) ?? true,
            proto: try container.decodeIfPresent(String.self, forKey: .proto) ?? "wireguard",
            vless: try container.decodeIfPresent(Bool.self, forKey: .vless) ?? false,
            shadowsocks: try container.decodeIfPresent(Bool.self, forKey: .shadowsocks) ?? false,
            ws: try container.decodeIfPresent(Bool.self, forKey: .ws) ?? false
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(block, forKey: .block)
        try container.encode(alerts, forKey: .alerts)
        try container.encode(kill, forKey: .kill)
        try container.encode(tor, forKey: .tor)
        try container.encode(auto, forKey: .auto)
        try container.encode(earn, forKey: .earn)
        try container.encode(proto, forKey: .proto)
        try container.encode(vless, forKey: .vless)
        try container.encode(shadowsocks, forKey: .shadowsocks)
        try container.encode(ws, forKey: .ws)
    }
}

public struct OnDemandPolicy: Equatable, Sendable {
    public var connectOnLaunch: Bool
    public var killSwitch: Bool
    public var reconnects: Bool { connectOnLaunch || killSwitch }
    public init(connectOnLaunch: Bool, killSwitch: Bool) {
        self.connectOnLaunch = connectOnLaunch
        self.killSwitch = killSwitch
    }
}

public struct OnDemandRule: Equatable, Sendable {
    public var action: String
    public var interfaceMatch: String
    public init(action: String, interfaceMatch: String) {
        self.action = action
        self.interfaceMatch = interfaceMatch
    }
}

public enum OnDemandPlanner {
    /// Kill switch and "Connect on launch" both ask the system to bring the tunnel back.
    /// The kill switch also forces every route into the tunnel (`includeAllNetworks`).
    public static func rules(_ policy: OnDemandPolicy) -> [OnDemandRule] {
        guard policy.reconnects else { return [] }
        return [OnDemandRule(action: "connect", interfaceMatch: "any")]
    }

    public static func includeAllNetworks(_ policy: OnDemandPolicy) -> Bool { policy.killSwitch }
    public static func enforceRoutes(_ policy: OnDemandPolicy) -> Bool { policy.killSwitch }
}

/// DNS settings applied to the packet tunnel. System resolvers are never added.
public struct DNSPolicy: Equatable, Sendable {
    public var servers: [String]
    public var matchAllDomains: Bool
    public var systemFallback: Bool

    public var isSafe: Bool { !servers.isEmpty && matchAllDomains && !systemFallback }

    public static func protected(servers: [String]) -> DNSPolicy {
        DNSPolicy(servers: servers.filter { !$0.isEmpty }, matchAllDomains: true, systemFallback: false)
    }
}

public struct AlertThrottle {
    public static let quiet: TimeInterval = 15 * 60
    public static func shouldFire(lastID: String?, lastAt: Date?, id: String, now: Date) -> Bool {
        guard let lastID, let lastAt, lastID == id else { return true }
        return now.timeIntervalSince(lastAt) >= quiet
    }
}

public struct DeviceIdentity: Equatable, Sendable {
    public var id: String
    public var platform: String
    public var integrity: String

    public init(id: String, platform: String, integrity: String) {
        self.id = id
        self.platform = platform
        self.integrity = integrity
    }

    /// 32 random bytes, base64url, which matches the server's device-id pattern.
    public static func randomID() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        return Base64URL.encode(Data(bytes))
    }

    public static func isAcceptableID(_ id: String) -> Bool {
        guard (16...128).contains(id.count) else { return false }
        return id.allSatisfy { character in
            character.isLetter || character.isNumber || character == "_" || character == "-"
        }
    }

    public static func integrityList(simulator: Bool, debuggable: Bool) -> String {
        [simulator ? "emulator" : nil, debuggable ? "debuggable" : nil].compactMap { $0 }.joined(separator: ",")
    }
}
