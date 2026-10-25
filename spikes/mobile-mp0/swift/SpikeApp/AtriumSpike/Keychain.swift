import CryptoKit
import Foundation
import Security

/// Generic-password items of this app, readable only on this device after the first unlock.
///
/// - Remarks: SPEC-0005 "iOS App · 存储": `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the
///   items never go into backups or to another phone.
/// - Side effects: Reads and writes the keychain.
struct Keychain: Sendable {
    /// Service name shared by all items.
    let service = "site.ktoon.atrium.spike"

    /// Why a keychain call failed.
    struct Failure: Error, CustomStringConvertible {
        let status: OSStatus
        var description: String { "OSStatus \(status)" }
    }

    /// Reads an item, or `nil` when there is none.
    ///
    /// - Side effects: Reads the keychain.
    func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        return result as? Data
    }

    /// Replaces an item.
    ///
    /// - Side effects: Writes the keychain.
    func write(_ account: String, _ data: Data) throws {
        try delete(account)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    /// Deletes an item if it exists.
    ///
    /// - Side effects: Writes the keychain.
    func delete(_ account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }

    /// This phone's static key: read it, or create and store it on first use.
    ///
    /// - Side effects: May write the keychain.
    func deviceKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = try read("device-key") {
            return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try write("device-key", key.rawRepresentation)
        return key
    }
}

/// What the phone remembers about a Mac (SPEC-0005 "iOS App · 存储").
struct HostRecord: Codable, Equatable, Sendable {
    var hostId: String
    var relay: String
    /// The host's static public key, base64url.
    var hostKey: String
    var hostName: String
    /// `nil` while the pairing waits for the Mac's confirmation ("待确认").
    var deviceId: String?

    /// The keychain account for this record.
    static func account(pending: Bool) -> String { pending ? "host.pending" : "host" }
}
