import XCTest
@testable import VeilVPNKit

final class EconomicsTests: XCTestCase {
    func testTiersAndSplitMatchTheControlServer() {
        XCTAssertEqual(VeilEconomics.maxDay, 24, accuracy: 0.0001)
        XCTAssertEqual(VeilEconomics.tier(members: 0).name, "Launch")
        XCTAssertEqual(VeilEconomics.tier(members: 99_999).community, 50)
        XCTAssertEqual(VeilEconomics.tier(members: 100_000).name, "Growth")
        XCTAssertEqual(VeilEconomics.tier(members: 1_000_000).name, "Network")
        XCTAssertEqual(VeilEconomics.tier(members: 10_000_000).name, "Mass")
        let launch = VeilEconomics.split(members: 84_000, revenueUsd: 100)
        XCTAssertEqual(launch.percent.values.reduce(0, +), 100)
        XCTAssertEqual(launch.usd["community"]!, 50, accuracy: 0.0001)
        let growth = VeilEconomics.split(members: 100_000, revenueUsd: 100)
        XCTAssertEqual(growth.usd["community"]!, 55, accuracy: 0.0001)
        let share = VeilEconomics.memberShare(poolUsd: 50, myMinutes: 10, totalMinutes: 100, boost: 1)
        XCTAssertEqual(share.weight, 0.1, accuracy: 0.0001)
        XCTAssertEqual(share.usd, 5, accuracy: 0.0001)
        XCTAssertEqual(share.veil, 500, accuracy: 0.0001)
        let boosted = VeilEconomics.memberShare(poolUsd: 10, myMinutes: 1, totalMinutes: 1, boost: 1.25)
        XCTAssertEqual(boosted.veil, 1250, accuracy: 0.0001)
        XCTAssertEqual(VeilEconomics.memberShare(poolUsd: 10, myMinutes: 0, totalMinutes: 10, boost: 1).veil, 0)
    }

    func testEpochZeroIsNovember2026() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = calendar.date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: 2026, month: 11, day: 1))!
        XCTAssertEqual(VeilEconomics.epochNumber(at: start), 1)
        XCTAssertEqual(VeilEconomics.epochNumber(at: start.addingTimeInterval(86_400)), 2)
    }

    func testFormattingMatchesTheInterface() {
        XCTAssertEqual(VeilFormat.usd(0), "$0.00")
        XCTAssertEqual(VeilFormat.usd(0.5), "$0.500")
        XCTAssertEqual(VeilFormat.usd(50), "$50.00")
        XCTAssertEqual(VeilFormat.usd(1500), "$1,500")
        XCTAssertEqual(VeilFormat.hms(3661), "01:01:01")
        XCTAssertEqual(VeilFormat.megabytes(bytes: 1_500_000), "1.5 MB")
        XCTAssertEqual(VeilFormat.weightPercent(0), "0%")
        XCTAssertEqual(VeilFormat.weightPercent(0.00001), "<0.01%")
        XCTAssertEqual(VeilFormat.weightPercent(0.1), "10%")
        XCTAssertEqual(VeilFormat.plural(1, "view"), "1 view")
        XCTAssertEqual(VeilFormat.plural(2, "view"), "2 views")
        XCTAssertEqual(countryCode(from: "🇨🇭"), "CH")
        XCTAssertTrue(SolanaAddress.isValid("So11111111111111111111111111111111111111112"))
        XCTAssertFalse(SolanaAddress.isValid("0OIl"))
    }
}

final class WireGuardTests: XCTestCase {
    func testGeneratedKeyMatchesTheServerPattern() throws {
        let pair = try WireGuardKeyPair.generate()
        XCTAssertTrue(WireGuardKeyPair.isValid(pair.privateKey))
        XCTAssertTrue(WireGuardKeyPair.isValid(pair.publicKey))
        XCTAssertNotEqual(pair.privateKey, pair.publicKey)
        let again = try WireGuardKeyPair(base64Private: pair.privateKey)
        XCTAssertEqual(again.publicKey, pair.publicKey)
        XCTAssertThrowsError(try WireGuardKeyPair(base64Private: "not-a-key"))
    }

    func testConfigRoundTripAndDNSRequirement() throws {
        let pair = try WireGuardKeyPair.generate()
        let peer = String(repeating: "A", count: 43) + "="
        let text = """
        # VEIL
        [Interface]
        PrivateKey = \(pair.privateKey)
        Address = 10.66.0.2/32
        DNS = 10.66.0.1

        [Peer]
        PublicKey = \(peer)
        AllowedIPs = 0.0.0.0/0, ::/0
        Endpoint = zrh.example:51820
        PersistentKeepalive = 25
        """
        let config = try WireGuardConfig.parse(text)
        XCTAssertEqual(config.dns, ["10.66.0.1"])
        XCTAssertTrue(config.isFullTunnel)
        XCTAssertTrue(config.hasProtectedDNS)
        let again = try WireGuardConfig.parse(config.render())
        XCTAssertEqual(again.privateKey, pair.privateKey)
        XCTAssertEqual(again.peers.first?.endpoint, "zrh.example:51820")
        XCTAssertEqual(again.peers.first?.keepalive, 25)
        XCTAssertThrowsError(try WireGuardConfig.parse("[Interface]\nPrivateKey = \(pair.privateKey)\n[Peer]\nPublicKey = \(peer)\n")) { error in
            XCTAssertEqual(error as? WireGuardConfigError, .missingDNS)
        }
        XCTAssertThrowsError(try WireGuardConfig.parse(String(repeating: "a", count: WireGuardConfig.maxBytes + 1)))
    }

    func testControlObjectBecomesAFullTunnel() throws {
        let pair = try WireGuardKeyPair.generate()
        let peer = String(repeating: "B", count: 43) + "="
        let config = try WireGuardConfig.fromControl(
            privateKey: pair.privateKey, address: "10.66.4.2/32", dns: "10.66.0.1",
            peerPublicKey: peer, endpoint: "203.0.113.10:51820",
            allowedIPs: "0.0.0.0/0, ::/0", keepalive: 25
        )
        XCTAssertTrue(config.isFullTunnel)
        XCTAssertFalse(config.render().contains("PrivateKey = \(pair.publicKey)"))
        let file = try ManualSetup.wireGuardFile(city: "Zürich", privateKey: pair.privateKey, remote: WireGuardRemote(
            address: "10.66.4.2/32", dns: "10.66.0.1", peerPublicKey: peer,
            endpoint: "203.0.113.10:51820", allowedIPs: "0.0.0.0/0, ::/0", keepalive: 25
        ))
        XCTAssertEqual(file.filename, "veil-z-rich.conf")
        XCTAssertTrue(file.text.contains(pair.privateKey))
    }

    func testRuntimeCounters() {
        let dump = """
        public_key=aa
        rx_bytes=100
        tx_bytes=40
        last_handshake_time_sec=1700000000
        rx_bytes=5
        """
        let runtime = WireGuardRuntime.parse(dump)
        XCTAssertEqual(runtime.rx, 105)
        XCTAssertEqual(runtime.tx, 40)
        XCTAssertEqual(runtime.handshake, Date(timeIntervalSince1970: 1_700_000_000))
    }
}

final class StateMachineTests: XCTestCase {
    func testProtectedOnlyAfterAFreshHandshake() {
        var machine = TunnelStateMachine()
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        machine.beginConnect(server: "zrh", region: "eu", proto: "wireguard", tor: false, reconnect: false)
        XCTAssertEqual(machine.snapshot.state, .connecting)
        XCTAssertEqual(machine.observeWireGuard(handshake: nil, now: now, rx: 0, tx: 0), .connecting)
        let fresh = now.addingTimeInterval(-10)
        XCTAssertEqual(machine.observeWireGuard(handshake: fresh, now: now, rx: 10, tx: 4), .on)
        XCTAssertEqual(machine.snapshot.since, TunnelStateMachine.millis(now))
        XCTAssertEqual(machine.snapshot.rx, 10)
        let stale = now.addingTimeInterval(-180)
        XCTAssertEqual(machine.observeWireGuard(handshake: stale, now: now, rx: 10, tx: 4), .error)
        machine.disconnect()
        XCTAssertEqual(machine.snapshot.state, .off)
        XCTAssertEqual(machine.observeWireGuard(handshake: fresh, now: now, rx: 1, tx: 1), .off)
    }

    func testFirstFailureDropsAndRenewalStaysUp() {
        var machine = TunnelStateMachine()
        machine.beginConnect(server: "zrh", region: "eu", proto: "wireguard", tor: true, reconnect: false)
        machine.fail("server_offline", reconnect: false)
        XCTAssertEqual(machine.snapshot.state, .off)
        XCTAssertEqual(machine.snapshot.error, "server_offline")
        machine.beginConnect(server: "zrh", region: "eu", proto: "wireguard", tor: false, reconnect: false)
        _ = machine.observeWireGuard(handshake: Date(), now: Date(), rx: 1, tx: 1)
        machine.beginConnect(server: "ams", region: "eu", proto: "wireguard", tor: false, reconnect: true)
        XCTAssertEqual(machine.snapshot.state, .on)
        machine.fail("network_unreachable", reconnect: true)
        XCTAssertEqual(machine.snapshot.state, .error)
    }

    func testIKEv2UsesTheSystemSession() {
        var machine = TunnelStateMachine()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        machine.beginConnect(server: "fra", region: "eu", proto: "ikev2", tor: false, reconnect: false)
        XCTAssertEqual(machine.observeSession(up: false, now: now), .connecting)
        XCTAssertEqual(machine.observeSession(up: true, now: now), .on)
        XCTAssertEqual(machine.observeSession(up: false, now: now.addingTimeInterval(5)), .error)
    }

    func testSettingsFallbackAndOnDemand() {
        let settings = VeilSettings(json: Data("{\"proto\":\"openvpn\",\"kill\":false}".utf8))
        XCTAssertEqual(settings.tunnelProto, "wireguard")
        XCTAssertFalse(settings.kill)
        XCTAssertTrue(settings.block)
        let kill = OnDemandPolicy(connectOnLaunch: false, killSwitch: true)
        XCTAssertEqual(OnDemandPlanner.rules(kill), [OnDemandRule(action: "connect", interfaceMatch: "any")])
        XCTAssertTrue(OnDemandPlanner.includeAllNetworks(kill))
        XCTAssertTrue(OnDemandPlanner.enforceRoutes(kill))
        let idle = OnDemandPolicy(connectOnLaunch: false, killSwitch: false)
        XCTAssertTrue(OnDemandPlanner.rules(idle).isEmpty)
        XCTAssertFalse(OnDemandPlanner.includeAllNetworks(idle))
        let launch = OnDemandPolicy(connectOnLaunch: true, killSwitch: false)
        XCTAssertEqual(OnDemandPlanner.rules(launch).count, 1)
        XCTAssertFalse(OnDemandPlanner.includeAllNetworks(launch))
    }

    func testDNSNeverFallsBackToTheSystem() {
        let policy = DNSPolicy.protected(servers: ["10.66.0.1"])
        XCTAssertTrue(policy.isSafe)
        XCTAssertFalse(policy.systemFallback)
        XCTAssertTrue(policy.matchAllDomains)
        XCTAssertEqual(policy.servers, ["10.66.0.1"])
        XCTAssertFalse(DNSPolicy.protected(servers: []).isSafe)
        XCTAssertEqual(VeilBrand.ink, 0x000000)
        XCTAssertEqual(VeilBrand.paper, 0xFFFFFF)
        XCTAssertEqual(VeilBrand.warn, 0xB42318)
        XCTAssertEqual(VeilBrand.fontName, "Helvetica Neue")
    }

    func testAlertThrottleAndCopy() {
        let now = Date()
        XCTAssertTrue(AlertThrottle.shouldFire(lastID: nil, lastAt: nil, id: "wifi", now: now))
        XCTAssertFalse(AlertThrottle.shouldFire(lastID: "wifi", lastAt: now, id: "wifi", now: now.addingTimeInterval(10)))
        XCTAssertTrue(AlertThrottle.shouldFire(lastID: "wifi", lastAt: now, id: "wifi", now: now.addingTimeInterval(15 * 60)))
        XCTAssertEqual(VeilCopy.networkLine(type: "wifi", risk: "none", protected: true), "This Wi-Fi: protected")
        XCTAssertEqual(VeilCopy.networkLine(type: "cellular", risk: "none", protected: false), "Mobile data: not protected")
        XCTAssertEqual(VeilCopy.alert(risk: "open").title, "Unsafe Wi-Fi: not protected")
        XCTAssertEqual(VeilCopy.statusWord(.on), "Protected.")
        XCTAssertEqual(VeilCopy.ipLine(state: .error, tor: false, killSwitch: true), "Traffic held")
        XCTAssertEqual(ManualSetup.deviceModes(vless: true, shadowsocks: false, webSocket: true).map(\.id), ["wireguard", "openvpn", "ikev2", "vless", "vless-ws"])
    }
}

final class ControlAndCumulusTests: XCTestCase {
    func testConnectParsesWireGuardAndDoesNotSendThePrivateKey() async throws {
        let pair = try WireGuardKeyPair.generate()
        let peer = String(repeating: "C", count: 43) + "="
        let payload = """
        {"mode":"wireguard","exp":1700000000000,"tor":false,"block":true,"manual":false,"server":{"id":"zrh","city":"Zürich","country":"Switzerland","flag":"🇨🇭","region":"eu","load":12,"online":true,"modes":["wireguard","ikev2"],"tor":true},"wireguard":{"address":"10.66.0.2/32","dns":"10.66.0.1","peerPublicKey":"\(peer)","endpoint":"203.0.113.8:51820","allowedIps":"0.0.0.0/0, ::/0","keepalive":25}}
        """.data(using: .utf8)!
        let transport = ScriptedTransport { request in
            let body = request.body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if request.url.path.hasSuffix("/v1/session") {
                return HTTPResponse(status: 200, body: Data("{\"token\":\"sid.secret\"}".utf8))
            }
            XCTAssertFalse(body.contains(pair.privateKey))
            XCTAssertTrue(body.contains(pair.publicKey))
            XCTAssertEqual(request.headers["x-veil-platform"], "ios")
            XCTAssertEqual(request.headers["authorization"], "Bearer sid.secret")
            return HTTPResponse(status: 200, body: payload)
        }
        let device = DeviceIdentity(id: DeviceIdentity.randomID(), platform: "ios", integrity: "")
        XCTAssertTrue(DeviceIdentity.isAcceptableID(device.id))
        let client = ControlClient(baseURL: URL(string: "https://api.infinitumveilvpn.app")!, transport: transport, device: device)
        let result = try await client.connect(server: "zrh", mode: "wireguard", publicKey: pair.publicKey, tor: false, block: true, manual: false)
        XCTAssertEqual(result.server.city, "Zürich")
        XCTAssertEqual(result.wireguard?.dns, "10.66.0.1")
        XCTAssertEqual(result.wireguard?.allowedIPs, "0.0.0.0/0, ::/0")
        XCTAssertNil(result.setup)
    }

    func testUnauthorizedRefreshesTheSessionOnce() async throws {
        let transport = ScriptedTransport { request in
            if request.url.path.hasSuffix("/v1/session") {
                return HTTPResponse(status: 200, body: Data("{\"token\":\"new.token\"}".utf8))
            }
            if request.headers["authorization"] == "Bearer old.token" {
                return HTTPResponse(status: 401, body: Data("{\"error\":\"unauthorized\"}".utf8))
            }
            return HTTPResponse(status: 200, body: Data("{\"servers\":[{\"id\":\"ams\",\"city\":\"Amsterdam\",\"country\":\"Netherlands\",\"flag\":\"🇳🇱\",\"region\":\"eu\",\"load\":1,\"online\":false,\"modes\":[\"wireguard\"],\"tor\":false}]}".utf8))
        }
        let client = ControlClient(
            baseURL: URL(string: "https://api.infinitumveilvpn.app")!,
            transport: transport,
            device: DeviceIdentity(id: "device-id-1234567890", platform: "macos", integrity: "debuggable"),
            token: "old.token"
        )
        let servers = try await client.servers()
        XCTAssertEqual(servers.first?.id, "ams")
        XCTAssertFalse(servers[0].online)
        let token = await client.currentToken()
        XCTAssertEqual(token, "new.token")
    }

    func testAPIErrorsAndAccount() async throws {
        let transport = ScriptedTransport { request in
            if request.url.path.hasSuffix("/v1/session") {
                return HTTPResponse(status: 200, body: Data("{\"token\":\"a.b\"}".utf8))
            }
            if request.url.path.hasSuffix("/wallet") {
                return HTTPResponse(status: 400, body: Data("{\"error\":\"bad_solana_address\"}".utf8))
            }
            return HTTPResponse(status: 200, body: Data("{\"today\":{\"minutes\":3,\"veil\":0.3,\"maxMinutes\":240},\"pending\":1.2,\"claimable\":0.9,\"lifetime\":4,\"wallet\":null,\"hold\":\"device_limit\"}".utf8))
        }
        let client = ControlClient(baseURL: VeilBrand.controlURL, transport: transport, device: DeviceIdentity(id: "device-id-1234567890", platform: "ios", integrity: ""))
        let account = try await client.me()
        XCTAssertEqual(account.todayVeil, 0.3, accuracy: 0.0001)
        XCTAssertEqual(VeilCopy.hold(account.hold), "Rewards paused: another account on this device already earned today.")
        do {
            _ = try await client.wallet("nope")
            XCTFail("expected a wallet error")
        } catch let error as VeilAPIError {
            XCTAssertEqual(error.code, "bad_solana_address")
            XCTAssertEqual(VeilCopy.error(error.code), "That is not a valid Solana address")
        }
    }

    func testCumulusPKCERejectsAMismatchedState() throws {
        let began = CumulusID.begin(redirect: "veilvpn://cumulus-id")
        XCTAssertEqual(began.authorize.host, "mail.cumuluscloud.app")
        XCTAssertTrue(began.authorize.path.contains("/api/id/authorize"))
        let items = URLComponents(url: began.authorize, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertEqual(items.first { $0.name == "client_id" }?.value, "veil-vpn")
        XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, CumulusID.challenge(verifier: began.pending.verifier))
        let codeURL = URL(string: "veilvpn://cumulus-id?code=abc&state=\(began.pending.state)")!
        guard case .code(let code, let state) = CumulusID.parse(url: codeURL) else { return XCTFail("code") }
        XCTAssertEqual(code, "abc")
        XCTAssertEqual(state, began.pending.state)
        let redeem = CumulusID.redeemURL(pending: began.pending, code: code)
        XCTAssertTrue(redeem.path.contains("/api/id/redeem"))
        let profile = Base64URL.encode(Data("{\"email\":\"a@example.com\",\"cid\":\"c1\"}".utf8))
        let good = URL(string: "veilvpn://cumulus-id#cid_token=tok&profile=\(profile)&state=\(began.pending.state)&expires_in=60")!
        let session = try XCTUnwrap(try CumulusID.accept(callback: CumulusID.parse(url: good), pending: began.pending))
        XCTAssertEqual(session.profile.email, "a@example.com")
        XCTAssertEqual(session.token, "tok")
        let bad = URL(string: "veilvpn://cumulus-id#cid_token=tok&profile=\(profile)&state=other&expires_in=60")!
        XCTAssertThrowsError(try CumulusID.accept(callback: CumulusID.parse(url: bad), pending: began.pending)) { error in
            XCTAssertEqual(error as? CumulusID.Failure, .stateMismatch)
        }
    }

    func testDeviceModesStayHiddenUntilSwitchesAreOn() {
        XCTAssertEqual(ManualSetup.deviceModes(vless: false, shadowsocks: false, webSocket: true).count, 3)
        XCTAssertEqual(DeviceIdentity.integrityList(simulator: true, debuggable: true), "emulator,debuggable")
        XCTAssertEqual(DeviceIdentity.integrityList(simulator: false, debuggable: false), "")
    }
}

private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
    var handler: (HTTPRequest) -> HTTPResponse
    init(_ handler: @escaping (HTTPRequest) -> HTTPResponse) { self.handler = handler }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { handler(request) }
}
