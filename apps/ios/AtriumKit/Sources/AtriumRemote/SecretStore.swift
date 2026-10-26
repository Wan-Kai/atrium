import Foundation
import Security

/// Small secrets kept by account name: the keychain in the app, memory in tests.
///
/// - Remark: testing.md "Swift（手机端）": the keychain's `ThisDeviceOnly` only exists on iOS, so the
///   logic above it is tested on macOS against an in-memory store, and ``KeychainStore`` itself in
///   the simulator.
public protocol SecretStore: Sendable {
  /// Reads an item, or `nil` when there is none.
  ///
  /// - Remark: Missing is not an error.
  /// - SideEffects: Reads the store.
  /// - Parameter account: The item's name.
  /// - Returns: The bytes.
  /// - Throws: ``StoreError``.
  func read(_ account: String) throws(StoreError) -> Data?

  /// Creates or replaces an item.
  ///
  /// - Remark: Replacing keeps the protection class.
  /// - SideEffects: Writes the store.
  /// - Parameters:
  ///   - account: The item's name.
  ///   - data: The bytes.
  /// - Throws: ``StoreError``.
  func write(_ account: String, _ data: Data) throws(StoreError)

  /// Deletes an item if it exists.
  ///
  /// - Remark: Deleting a missing item succeeds.
  /// - SideEffects: Writes the store.
  /// - Parameter account: The item's name.
  /// - Throws: ``StoreError``.
  func delete(_ account: String) throws(StoreError)

  /// The names of all items.
  ///
  /// - Remark: How the host records are listed.
  /// - SideEffects: Reads the store.
  /// - Returns: The account names, sorted.
  /// - Throws: ``StoreError``.
  func accounts() throws(StoreError) -> [String]
}

/// Why the secret store failed.
///
/// - Remark: Carries the keychain's status code for the log, never the data.
public enum StoreError: Error, Equatable, Sendable {
  /// The keychain refused, with its `OSStatus`.
  case keychain(OSStatus)
  /// An item's bytes are not what we wrote.
  case corrupt
}

/// Generic-password items of the app, readable only on this device after the first unlock.
///
/// - Remark: SPEC-0005 "iOS App · 存储": `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the
///   items never go into backups or to another phone, and stay through a re-install with the same
///   bundle id and team (MP0 on a real iPhone). The data protection keychain is asked for explicitly
///   so macOS builds behave like iOS instead of using the old file keychain.
public struct KeychainStore: SecretStore {
  /// The service name shared by the app's items.
  public let service: String

  /// Makes a store for one service.
  ///
  /// - Remark: Tests in the simulator pass their own service so they never touch the app's items.
  /// - SideEffects: none
  /// - Parameter service: Defaults to the app's bundle id.
  public init(service: String = "site.ktoon.atrium") {
    self.service = service
  }

  /// The attributes every query shares.
  ///
  /// - Remark: One place for the class, service and keychain choice.
  /// - SideEffects: none
  /// - Parameter account: The item's name, or `nil` for all of them.
  /// - Returns: The query.
  private func query(_ account: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  /// Reads an item.
  ///
  /// - Remark: See ``SecretStore/read(_:)``.
  /// - SideEffects: Reads the keychain.
  /// - Parameter account: The item's name.
  /// - Returns: The bytes, or `nil`.
  /// - Throws: ``StoreError``.
  public func read(_ account: String) throws(StoreError) -> Data? {
    var query = query(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw .keychain(status) }
    guard let data = result as? Data else { throw .corrupt }
    return data
  }

  /// Creates or replaces an item.
  ///
  /// - Remark: Updates in place when it exists, so the item is never missing in between.
  /// - SideEffects: Writes the keychain.
  /// - Parameters:
  ///   - account: The item's name.
  ///   - data: The bytes.
  /// - Throws: ``StoreError``.
  public func write(_ account: String, _ data: Data) throws(StoreError) {
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw .keychain(updated) }
    let added = SecItemAdd(query(account).merging(attributes) { $1 } as CFDictionary, nil)
    guard added == errSecSuccess else { throw .keychain(added) }
  }

  /// Deletes an item.
  ///
  /// - Remark: See ``SecretStore/delete(_:)``.
  /// - SideEffects: Writes the keychain.
  /// - Parameter account: The item's name.
  /// - Throws: ``StoreError``.
  public func delete(_ account: String) throws(StoreError) {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw .keychain(status) }
  }

  /// Lists the items of this service.
  ///
  /// - Remark: Asks for attributes only, never the data.
  /// - SideEffects: Reads the keychain.
  /// - Returns: The account names, sorted.
  /// - Throws: ``StoreError``.
  public func accounts() throws(StoreError) -> [String] {
    var query = query(nil)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw .keychain(status) }
    guard let items = result as? [[String: Any]] else { throw .corrupt }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
  }
}
