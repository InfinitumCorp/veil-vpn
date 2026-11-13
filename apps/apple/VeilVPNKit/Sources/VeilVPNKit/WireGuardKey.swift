import Crypto
import Foundation

public enum WireGuardKeyError: Error, Equatable {
    case invalid
}

/// WireGuard keys are 32-byte Curve25519 values, standard Base64 with padding.
/// The private key stays on the device. Only `publicKey` is sent to the control server.
public struct WireGuardKeyPair: Equatable, Sendable {
    public var privateKey: String
    public var publicKey: String

    public init(privateKey: String, publicKey: String) {
        self.privateKey = privateKey
        self.publicKey = publicKey
    }

    public static func generate() throws -> WireGuardKeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return try WireGuardKeyPair(rawPrivate: key.rawRepresentation)
    }

    public init(rawPrivate: Data) throws {
        guard rawPrivate.count == 32 else { throw WireGuardKeyError.invalid }
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: rawPrivate)
        privateKey = rawPrivate.base64EncodedString()
        publicKey = key.publicKey.rawRepresentation.base64EncodedString()
        guard WireGuardKeyPair.isValid(privateKey), WireGuardKeyPair.isValid(publicKey) else {
            throw WireGuardKeyError.invalid
        }
    }

    public init(base64Private: String) throws {
        guard let data = Data(base64Encoded: base64Private), data.count == 32 else {
            throw WireGuardKeyError.invalid
        }
        try self.init(rawPrivate: data)
    }

    /// The control server accepts exactly 43 Base64 characters and a trailing `=`.
    public static func isValid(_ key: String) -> Bool {
        guard key.count == 44, key.hasSuffix("=") else { return false }
        let body = key.dropLast()
        return body.allSatisfy { $0.isASCII && (isBase64($0)) }
    }

    private static func isBase64(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || character == "+" || character == "/"
    }
}

enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var converted = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = (4 - converted.count % 4) % 4
        converted.append(String(repeating: "=", count: pad))
        return Data(base64Encoded: converted)
    }
}
