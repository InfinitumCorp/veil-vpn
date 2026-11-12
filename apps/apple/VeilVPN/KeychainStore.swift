import Foundation
import Security
import VeilVPNKit

/// Device secrets stay in the Keychain. If the Keychain is unavailable (an unsigned
/// test run), the values live in memory for this process only and are never written to a file.
enum KeychainStore {
    private static let service = "com.infinitum.veilvpn"
    private static let lock = NSLock()
    private static var memory: [String: Data] = [:]

    static func string(account: String) -> String? {
        guard let data = data(account: account) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, account: String) {
        set(Data(value.utf8), account: account)
    }

    static func data(account: String) -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
            return data
        }
        lock.lock()
        defer { lock.unlock() }
        return memory[account]
    }

    @discardableResult
    static func set(_ data: Data, account: String) -> Bool {
        let query = base(account)
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let saved = SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        lock.lock()
        memory[account] = data
        lock.unlock()
        return saved
    }

    /// Persistent reference for an IKEv2 password. The system VPN reads it; the app does not put the password in the profile plist.
    static func passwordReference(_ password: String, account: String) -> Data? {
        set(Data(password.utf8), account: account)
        var query = base(account)
        query[kSecReturnPersistentRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    static func deviceKey() throws -> WireGuardKeyPair {
        if let existing = string(account: "wg-private") {
            if let pair = try? WireGuardKeyPair(base64Private: existing) { return pair }
        }
        let pair = try WireGuardKeyPair.generate()
        set(pair.privateKey, account: "wg-private")
        return pair
    }

    static func deviceID() -> String {
        if let existing = string(account: "device-id"), DeviceIdentity.isAcceptableID(existing) { return existing }
        let created = DeviceIdentity.randomID()
        set(created, account: "device-id")
        return created
    }

    static func sessionToken() -> String? { string(account: "session") }
    static func setSessionToken(_ token: String?) {
        if let token { set(token, account: "session") }
    }

    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
