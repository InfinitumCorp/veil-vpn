import Crypto
import Foundation

/// OAuth 2.0 authorization code + PKCE (S256) for Cumulus://ID.
/// This is the same flow as `site/cumulus-id.js`. The Android VPN does not sign the
/// tunnel in with it (the session is anonymous), so the app does not show a button.
/// The helpers are here so a later sign-in uses the site's protocol instead of a new one.
public enum CumulusID {
    public struct Pending: Equatable, Sendable {
        public var verifier: String
        public var state: String
        public var redirect: String
    }

    public struct Profile: Equatable, Sendable {
        public var cid: String?
        public var username: String?
        public var email: String?
        public var name: String?
        public var display: String { email ?? username ?? name ?? "Signed in" }
    }

    public struct Session: Equatable, Sendable {
        public var token: String
        public var profile: Profile
        public var expiresAt: Date
    }

    public enum Callback: Equatable, Sendable {
        case none
        case code(code: String, state: String)
        case token(token: String, profile: String, state: String, expiresIn: Int)
        case failure(String)
    }

    public enum Failure: Error, Equatable {
        case stateMismatch
        case badProfile
        case remote(String)
    }

    public static func verifier() -> String { Base64URL.encode(random(48)) }
    public static func state() -> String { Base64URL.encode(random(16)) }

    public static func challenge(verifier: String) -> String {
        let digest = Data(SHA256.hash(data: Data(verifier.utf8)))
        return Base64URL.encode(digest)
    }

    public static func begin(redirect: String, issuer: URL = VeilBrand.cumulusIssuer, clientID: String = VeilBrand.cumulusClientID) -> (pending: Pending, authorize: URL) {
        let pending = Pending(verifier: verifier(), state: state(), redirect: redirect)
        var parts = URLComponents(url: issuer.appendingPathComponent("api").appendingPathComponent("id").appendingPathComponent("authorize"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "code_challenge", value: challenge(verifier: pending.verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: pending.state),
        ]
        return (pending, parts.url!)
    }

    public static func redeemURL(pending: Pending, code: String, issuer: URL = VeilBrand.cumulusIssuer, clientID: String = VeilBrand.cumulusClientID) -> URL {
        var parts = URLComponents(url: issuer.appendingPathComponent("api").appendingPathComponent("id").appendingPathComponent("redeem"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: pending.redirect),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: pending.verifier),
            URLQueryItem(name: "state", value: pending.state),
        ]
        return parts.url!
    }

    public static func parse(url: URL) -> Callback {
        let fragment = URLComponents(string: "https://veil.invalid/?" + (url.fragment ?? ""))
        let frag = Dictionary(uniqueKeysWithValues: (fragment?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if frag["cid_error"] != nil { return .failure(frag["cid_error"] ?? "cid_error") }
        if let token = frag["cid_token"] {
            return .token(token: token, profile: frag["profile"] ?? "", state: frag["state"] ?? "", expiresIn: Int(frag["expires_in"] ?? "") ?? 3600)
        }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        if let code = query["code"], let state = query["state"], !code.isEmpty, !state.isEmpty {
            return .code(code: code, state: state)
        }
        return .none
    }

    public static func accept(callback: Callback, pending: Pending, now: Date = Date()) throws -> Session? {
        switch callback {
        case .none, .code:
            return nil
        case .failure(let code):
            throw Failure.remote(code)
        case .token(let token, let profile, let state, let expiresIn):
            guard state == pending.state else { throw Failure.stateMismatch }
            guard let data = Base64URL.decode(profile),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw Failure.badProfile
            }
            return Session(
                token: token,
                profile: Profile(
                    cid: json["cid"] as? String,
                    username: json["username"] as? String,
                    email: json["email"] as? String,
                    name: json["name"] as? String
                ),
                expiresAt: now.addingTimeInterval(TimeInterval(expiresIn))
            )
        }
    }

    private static func random(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        return Data(bytes)
    }
}
