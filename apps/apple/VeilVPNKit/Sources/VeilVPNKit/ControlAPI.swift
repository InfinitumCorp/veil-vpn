import Foundation

public struct VeilAPIError: Error, Equatable, Sendable {
    public var code: String
    public init(_ code: String) { self.code = code }
}

public struct HTTPRequest: Equatable, Sendable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public init(method: String, url: URL, headers: [String: String], body: Data?) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Equatable, Sendable {
    public var status: Int
    public var body: Data
    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct VeilServer: Equatable, Sendable, Identifiable {
    public var id: String
    public var city: String
    public var country: String
    public var flag: String
    public var region: String
    public var load: Int
    public var online: Bool
    public var modes: [String]
    public var tor: Bool
    public init(id: String, city: String, country: String, flag: String, region: String, load: Int, online: Bool, modes: [String], tor: Bool) {
        self.id = id
        self.city = city
        self.country = country
        self.flag = flag
        self.region = region
        self.load = load
        self.online = online
        self.modes = modes
        self.tor = tor
    }
}

public struct IKEv2Login: Equatable, Sendable {
    public var server: String
    public var remoteID: String
    public var username: String
    public var password: String
    public var dns: String
}

public struct OpenVPNLogin: Equatable, Sendable {
    public var username: String
    public var password: String
    public var profile: String
}

public struct SetupFile: Equatable, Sendable {
    public var filename: String
    public var text: String
}

public struct DeviceSetup: Equatable, Sendable {
    public var summary: String
    public var fields: [(label: String, value: String)]
    public var files: [SetupFile]

    public static func == (lhs: DeviceSetup, rhs: DeviceSetup) -> Bool {
        lhs.summary == rhs.summary && lhs.files == rhs.files && lhs.fields.map(\.label) == rhs.fields.map(\.label) && lhs.fields.map(\.value) == rhs.fields.map(\.value)
    }
}

public struct ConnectResult: Equatable, Sendable {
    public var mode: String
    public var server: VeilServer
    public var exp: Int64
    public var tor: Bool
    public var block: Bool
    public var manual: Bool
    public var wireguard: WireGuardRemote?
    public var ikev2: IKEv2Login?
    public var openvpn: OpenVPNLogin?
    public var setup: DeviceSetup?
}

public struct WireGuardRemote: Equatable, Sendable {
    public var address: String
    public var dns: String
    public var peerPublicKey: String
    public var endpoint: String
    public var allowedIPs: String
    public var keepalive: Int
}

public struct AccountSnapshot: Equatable, Sendable {
    public var todayMinutes: Int
    public var todayVeil: Double
    public var maxMinutes: Int
    public var pending: Double
    public var claimable: Double
    public var lifetime: Double
    public var wallet: String?
    public var hold: String?
}

public struct PoolSnapshot: Equatable, Sendable {
    public var members: Double
    public var minutes: Double
    public var revenueUsd: Double
    public var revenueSource: String
    public var poolUsd: Double
    public var tier: String
    public var boost: Double
    public var refPrice: Double
    public var communityPercent: Double
    public var views: Double
    public var clicks: Double
}

public struct RevenueSnapshot: Equatable, Sendable {
    public var today: PoolSnapshot
    public var mineUSD: Double
    public var mineViews: Double
    public var mineClicks: Double
    public var shareVeil: Double
    public var weight: Double
    public var minutes: Double
    public var history: [EpochPayout]
    public var refPrice: Double
}

public struct EpochPayout: Equatable, Sendable {
    public var day: String
    public var revenueUsd: Double
    public var poolUsd: Double
    public var minutes: Int
    public var myVeil: Double
}

public struct SponsorAd: Equatable, Sendable {
    public var id: String
    public var mark: String
    public var title: String
    public var body: String
    public var url: String?
}

public struct BlockedCount: Equatable, Sendable {
    public var blocked: Int
    public var connected: Bool
}

enum JSONObj {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw VeilAPIError("bad_response")
        }
        return json
    }

    static func string(_ obj: [String: Any], _ key: String) -> String? {
        obj[key] as? String
    }

    static func double(_ obj: [String: Any], _ key: String) -> Double {
        switch obj[key] {
        case let number as NSNumber: return number.doubleValue
        case let number as Int: return Double(number)
        case let number as Double: return number
        case let text as String: return Double(text) ?? 0
        default: return 0
        }
    }

    static func int(_ obj: [String: Any], _ key: String) -> Int { Int(double(obj, key).rounded()) }
    static func int64(_ obj: [String: Any], _ key: String) -> Int64 { Int64(double(obj, key).rounded()) }
    static func bool(_ obj: [String: Any], _ key: String, default def: Bool = false) -> Bool {
        switch obj[key] {
        case let value as Bool: return value
        case let number as NSNumber: return number.boolValue
        default: return def
        }
    }
}

public enum VeilDecoder {
    public static func servers(from data: Data) throws -> [VeilServer] {
        let root = try JSONObj.object(data)
        let list = root["servers"] as? [[String: Any]] ?? []
        return list.compactMap(server)
    }

    public static func server(_ obj: [String: Any]) -> VeilServer? {
        guard let id = JSONObj.string(obj, "id") else { return nil }
        let modes = (obj["modes"] as? [String]) ?? []
        return VeilServer(
            id: id,
            city: JSONObj.string(obj, "city") ?? id,
            country: JSONObj.string(obj, "country") ?? "",
            flag: JSONObj.string(obj, "flag") ?? "",
            region: JSONObj.string(obj, "region") ?? "global",
            load: min(100, max(0, JSONObj.int(obj, "load"))),
            online: JSONObj.bool(obj, "online", default: true),
            modes: modes,
            tor: JSONObj.bool(obj, "tor")
        )
    }

    public static func connect(from data: Data) throws -> ConnectResult {
        let obj = try JSONObj.object(data)
        guard let serverObj = obj["server"] as? [String: Any], let server = server(serverObj) else {
            throw VeilAPIError("bad_response")
        }
        let mode = JSONObj.string(obj, "mode") ?? ""
        var remote: WireGuardRemote?
        if let wg = obj["wireguard"] as? [String: Any] {
            remote = WireGuardRemote(
                address: JSONObj.string(wg, "address") ?? "",
                dns: JSONObj.string(wg, "dns") ?? "10.66.0.1",
                peerPublicKey: JSONObj.string(wg, "peerPublicKey") ?? "",
                endpoint: JSONObj.string(wg, "endpoint") ?? "",
                allowedIPs: JSONObj.string(wg, "allowedIps") ?? "0.0.0.0/0, ::/0",
                keepalive: JSONObj.int(wg, "keepalive") == 0 ? 25 : JSONObj.int(wg, "keepalive")
            )
        }
        var ike: IKEv2Login?
        if let k = obj["ikev2"] as? [String: Any] {
            ike = IKEv2Login(
                server: JSONObj.string(k, "server") ?? "",
                remoteID: JSONObj.string(k, "remoteId") ?? "",
                username: JSONObj.string(k, "username") ?? "",
                password: JSONObj.string(k, "password") ?? "",
                dns: JSONObj.string(k, "dns") ?? "10.66.0.1"
            )
        }
        var ovpn: OpenVPNLogin?
        if let o = obj["openvpn"] as? [String: Any] {
            ovpn = OpenVPNLogin(
                username: JSONObj.string(o, "username") ?? "",
                password: JSONObj.string(o, "password") ?? "",
                profile: JSONObj.string(o, "profile") ?? ""
            )
        }
        return ConnectResult(
            mode: mode, server: server, exp: JSONObj.int64(obj, "exp"),
            tor: JSONObj.bool(obj, "tor"), block: JSONObj.bool(obj, "block", default: true),
            manual: JSONObj.bool(obj, "manual"), wireguard: remote, ikev2: ike, openvpn: ovpn,
            setup: JSONObj.bool(obj, "manual") ? deviceSetup(mode: mode, obj: obj, server: server, remote: remote, ike: ike, ovpn: ovpn) : nil
        )
    }

    public static func account(from data: Data) throws -> AccountSnapshot {
        let obj = try JSONObj.object(data)
        let today = obj["today"] as? [String: Any] ?? [:]
        return AccountSnapshot(
            todayMinutes: JSONObj.int(today, "minutes"),
            todayVeil: JSONObj.double(today, "veil"),
            maxMinutes: JSONObj.int(today, "maxMinutes") == 0 ? VeilEconomics.maxMinutes : JSONObj.int(today, "maxMinutes"),
            pending: JSONObj.double(obj, "pending"),
            claimable: JSONObj.double(obj, "claimable"),
            lifetime: JSONObj.double(obj, "lifetime"),
            wallet: JSONObj.string(obj, "wallet"),
            hold: JSONObj.string(obj, "hold")
        )
    }

    public static func pool(from data: Data) throws -> PoolSnapshot { try pool(try JSONObj.object(data), views: true) }

    public static func revenue(from data: Data) throws -> RevenueSnapshot {
        let obj = try JSONObj.object(data)
        let today = obj["today"] as? [String: Any] ?? [:]
        let mine = obj["mine"] as? [String: Any] ?? [:]
        let history = (obj["history"] as? [[String: Any]] ?? []).map { row in
            EpochPayout(
                day: JSONObj.string(row, "day") ?? "",
                revenueUsd: JSONObj.double(row, "revenueUsd"),
                poolUsd: JSONObj.double(row, "poolUsd"),
                minutes: JSONObj.int(row, "minutes"),
                myVeil: JSONObj.double(row, "myVeil")
            )
        }
        return RevenueSnapshot(
            today: try pool(today, views: true),
            mineUSD: JSONObj.double(mine, "usd"),
            mineViews: JSONObj.double(mine, "views"),
            mineClicks: JSONObj.double(mine, "clicks"),
            shareVeil: JSONObj.double(mine, "shareVeil"),
            weight: JSONObj.double(mine, "weight"),
            minutes: JSONObj.double(mine, "minutes"),
            history: history,
            refPrice: JSONObj.double(obj, "refPrice") == 0 ? VeilEconomics.refPrice : JSONObj.double(obj, "refPrice")
        )
    }

    public static func ad(from data: Data) throws -> SponsorAd {
        let obj = try JSONObj.object(data)
        guard let id = JSONObj.string(obj, "id") else { throw VeilAPIError("bad_response") }
        return SponsorAd(id: id, mark: JSONObj.string(obj, "mark") ?? "", title: JSONObj.string(obj, "title") ?? "", body: JSONObj.string(obj, "body") ?? "", url: JSONObj.string(obj, "url"))
    }

    public static func blocked(from data: Data) throws -> BlockedCount {
        let obj = try JSONObj.object(data)
        return BlockedCount(blocked: JSONObj.int(obj, "blocked"), connected: JSONObj.bool(obj, "connected"))
    }

    private static func pool(_ obj: [String: Any], views: Bool) throws -> PoolSnapshot {
        let percent = obj["percent"] as? [String: Any] ?? [:]
        return PoolSnapshot(
            members: JSONObj.double(obj, "members"),
            minutes: JSONObj.double(obj, "minutes"),
            revenueUsd: JSONObj.double(obj, "revenueUsd"),
            revenueSource: JSONObj.string(obj, "revenueSource") ?? "estimated",
            poolUsd: JSONObj.double(obj, "poolUsd"),
            tier: JSONObj.string(obj, "tier") ?? VeilEconomics.tier(members: JSONObj.double(obj, "members")).name,
            boost: JSONObj.double(obj, "boost") == 0 ? 1 : JSONObj.double(obj, "boost"),
            refPrice: JSONObj.double(obj, "refPrice") == 0 ? VeilEconomics.refPrice : JSONObj.double(obj, "refPrice"),
            communityPercent: JSONObj.double(percent, "community"),
            views: views ? JSONObj.double(obj, "views") : 0,
            clicks: views ? JSONObj.double(obj, "clicks") : 0
        )
    }

    private static func deviceSetup(mode: String, obj: [String: Any], server: VeilServer, remote: WireGuardRemote?, ike: IKEv2Login?, ovpn: OpenVPNLogin?) -> DeviceSetup? {
        let until = Date(timeIntervalSince1970: Double(JSONObj.int64(obj, "exp")) / 1000)
        let day = Self.shortDay(until)
        if let ike {
            return DeviceSetup(
                summary: "Add a VPN of type IKEv2. Leave Local ID empty. Valid until \(day).",
                fields: [("Server", ike.server), ("Remote ID", ike.remoteID), ("Username", ike.username), ("Password", ike.password)],
                files: []
            )
        }
        if let ovpn {
            return DeviceSetup(
                summary: "Import the profile in OpenVPN Connect and sign in with the username and password. Valid until \(day).",
                fields: [("Username", ovpn.username), ("Password", ovpn.password)],
                files: [SetupFile(filename: fileName(server.city, "ovpn"), text: ovpn.profile)]
            )
        }
        if remote != nil {
            return DeviceSetup(
                summary: "Import the file in the WireGuard app. Its private key was made on this device and is in the file only. Valid until \(day).",
                fields: [],
                files: []
            )
        }
        let key = responseKey(mode)
        if let bundle = obj[key] as? [String: Any], let link = JSONObj.string(bundle, "link") {
            var files: [SetupFile] = []
            if let xray = bundle["xray"], let data = try? JSONSerialization.data(withJSONObject: xray, options: [.prettyPrinted]), let text = String(data: data, encoding: .utf8) {
                files.append(SetupFile(filename: fileName(server.city, "xray.json"), text: text + "\n"))
            }
            if let sing = bundle["singbox"], let data = try? JSONSerialization.data(withJSONObject: sing, options: [.prettyPrinted]), let text = String(data: data, encoding: .utf8) {
                files.append(SetupFile(filename: fileName(server.city, "singbox.json"), text: text + "\n"))
            }
            return DeviceSetup(
                summary: "Saved an Xray config and a sing-box config. Import either one, or paste this link. It does not use Tor.",
                fields: [("Link", link)],
                files: files
            )
        }
        return nil
    }

    static func responseKey(_ mode: String) -> String {
        switch mode {
        case "vless-ws": return "vlessWs"
        case "shadowsocks-ws": return "shadowsocksWs"
        default: return mode
        }
    }

    public static func fileName(_ city: String, _ ext: String) -> String {
        let slug = city.lowercased().map { character -> Character in
            character.isASCII && (character.isLetter || character.isNumber) ? character : "-"
        }
        let collapsed = String(slug).split(separator: "-").joined(separator: "-")
        let name = collapsed.isEmpty ? "vpn" : collapsed
        return "veil-\(name).\(ext)"
    }

    static func shortDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: date)
    }
}

public enum ManualSetup {
    public static func wireGuardFile(city: String, privateKey: String, remote: WireGuardRemote) throws -> SetupFile {
        let config = try WireGuardConfig.fromControl(
            privateKey: privateKey, address: remote.address, dns: remote.dns,
            peerPublicKey: remote.peerPublicKey, endpoint: remote.endpoint,
            allowedIPs: remote.allowedIPs, keepalive: remote.keepalive
        )
        return SetupFile(filename: VeilDecoder.fileName(city, "conf"), text: config.render())
    }

    /// Other-device protocols offered in Settings. VLESS and Shadowsocks stay hidden until their switches are on.
    public static func deviceModes(vless: Bool, shadowsocks: Bool, webSocket: Bool) -> [(id: String, label: String)] {
        var modes: [(String, String)] = [
            ("wireguard", "WireGuard · .conf file (WireGuard app)"),
            ("openvpn", "OpenVPN · .ovpn file (OpenVPN Connect)"),
            ("ikev2", "IKEv2 · built into iPhone, Mac and Windows"),
        ]
        if vless { modes.append(("vless", "VLESS Reality · link, Xray and sing-box")) }
        if shadowsocks { modes.append(("shadowsocks", "Shadowsocks-2022 · ss:// link, Xray and sing-box")) }
        if webSocket && vless { modes.append(("vless-ws", "VLESS over WebSocket + TLS · port 443")) }
        if webSocket && shadowsocks { modes.append(("shadowsocks-ws", "Shadowsocks over WebSocket + TLS · port 443")) }
        return modes
    }
}

/// Keys shared by the app and the packet tunnel provider. Values are property-list types.
public enum TunnelProviderKey {
    public static let wgQuick = "wgQuick"
    public static let server = "server"
    public static let token = "token"
    public static let controlURL = "controlURL"
    public static let tor = "tor"
    public static let block = "block"
    public static let kill = "kill"
    public static let earn = "earn"
    public static let deviceID = "deviceID"
    public static let platform = "platform"
    public static let region = "region"
    public static let proto = "proto"
}

public enum TunnelMessage {
    public static let stats = "stats"
    public static let setEarn = "setEarn"
}

public actor ControlClient {
    public let baseURL: URL
    private let transport: HTTPTransport
    private let device: DeviceIdentity
    private var token: String?
    private var refreshed = false

    public init(baseURL: URL, transport: HTTPTransport, device: DeviceIdentity, token: String? = nil) {
        self.baseURL = baseURL
        self.transport = transport
        self.device = device
        self.token = token
    }

    public func currentToken() -> String? { token }

    public func replaceToken(_ token: String?) { self.token = token }

    public func servers() async throws -> [VeilServer] {
        try VeilDecoder.servers(from: try await call(method: "GET", path: "/v1/servers", body: nil, auth: true))
    }

    public func connect(server: String, mode: String, publicKey: String?, tor: Bool, block: Bool, manual: Bool) async throws -> ConnectResult {
        var body: [String: Any] = ["server": server, "mode": mode, "tor": tor, "block": block]
        if manual { body["manual"] = true }
        if let publicKey { body["publicKey"] = publicKey }
        return try VeilDecoder.connect(from: try await call(method: "POST", path: "/v1/connect", body: body, auth: true))
    }

    public func disconnect() async throws {
        _ = try await call(method: "POST", path: "/v1/disconnect", body: [:], auth: true)
    }

    public func heartbeat(active: Bool) async throws -> (credited: Bool, account: AccountSnapshot) {
        let data = try await call(method: "POST", path: "/v1/heartbeat", body: ["active": active], auth: true)
        let obj = try JSONObj.object(data)
        return (JSONObj.bool(obj, "credited"), try VeilDecoder.account(from: data))
    }

    public func me() async throws -> AccountSnapshot { try VeilDecoder.account(from: try await call(method: "GET", path: "/v1/me", body: nil, auth: true)) }
    public func pool() async throws -> PoolSnapshot { try VeilDecoder.pool(from: try await call(method: "GET", path: "/v1/pool", body: nil, auth: true)) }
    public func revenue() async throws -> RevenueSnapshot { try VeilDecoder.revenue(from: try await call(method: "GET", path: "/v1/revenue", body: nil, auth: true)) }
    public func blocked() async throws -> BlockedCount { try VeilDecoder.blocked(from: try await call(method: "GET", path: "/v1/blocked", body: nil, auth: true)) }
    public func ad(region: String) async throws -> SponsorAd {
        let escaped = region.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? region
        let path = "/v1/ads?region=" + escaped
        return try VeilDecoder.ad(from: try await call(method: "GET", path: path, body: nil, auth: true))
    }

    public func adEvent(id: String, kind: String) async throws {
        _ = try await call(method: "POST", path: "/v1/ads/event", body: ["ad": id, "kind": kind], auth: true)
    }

    public func wallet(_ address: String?) async throws -> AccountSnapshot {
        let body: [String: Any] = ["address": address.map { $0 as Any } ?? NSNull()]
        return try VeilDecoder.account(from: try await call(method: "POST", path: "/v1/wallet", body: body, auth: true))
    }

    public func claim() async throws -> Int {
        let data = try await call(method: "POST", path: "/v1/claim", body: [:], auth: true)
        return JSONObj.int(try JSONObj.object(data), "queued")
    }

    private func call(method: String, path: String, body: [String: Any]?, auth: Bool) async throws -> Data {
        if auth, token == nil { try await openSession() }
        let response = try await send(method: method, path: path, body: body, auth: auth)
        if response.status == 401, auth, !refreshed {
            refreshed = true
            defer { refreshed = false }
            token = nil
            try await openSession()
            let retry = try await send(method: method, path: path, body: body, auth: true)
            return try decode(retry)
        }
        return try decode(response)
    }

    private func openSession() async throws {
        let response = try await send(method: "POST", path: "/v1/session", body: nil, auth: false)
        let data = try decode(response)
        let obj = try JSONObj.object(data)
        guard let token = JSONObj.string(obj, "token"), !token.isEmpty else { throw VeilAPIError("session") }
        self.token = token
    }

    private func send(method: String, path: String, body: [String: Any]?, auth: Bool) async throws -> HTTPResponse {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw VeilAPIError("bad_url") }
        var headers = [
            "content-type": "application/json",
            "x-veil-device": device.id,
            "x-veil-platform": device.platform,
        ]
        if !device.integrity.isEmpty { headers["x-veil-integrity"] = device.integrity }
        if auth, let token { headers["authorization"] = "Bearer \(token)" }
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        do {
            return try await transport.send(HTTPRequest(method: method, url: url, headers: headers, body: data))
        } catch let error as VeilAPIError {
            throw error
        } catch {
            throw VeilAPIError("network_unreachable")
        }
    }

    private func decode(_ response: HTTPResponse) throws -> Data {
        if (200...299).contains(response.status) { return response.body }
        if let obj = try? JSONObj.object(response.body), let code = JSONObj.string(obj, "error") {
            throw VeilAPIError(code)
        }
        throw VeilAPIError("http_\(response.status)")
    }
}

#if canImport(Darwin)
public struct URLSessionTransport: HTTPTransport {
    public init() {}
    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url, timeoutInterval: 10)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (key, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return HTTPResponse(status: status, body: data)
    }
}
#endif
