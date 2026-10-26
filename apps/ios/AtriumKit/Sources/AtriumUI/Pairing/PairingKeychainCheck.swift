#if DEBUG
  import AtriumRemote
  import Foundation
  import Security
  import SwiftUI

  /// Runs the fixed, isolated keychain acceptance check inside the actual application process.
  ///
  /// - Remark: Debug-only; no service or payload can be supplied externally and no secret is displayed.
  public struct PairingKeychainCheck: View {
    /// Whether the UI test requested this fixed check.
    public static var isRequested: Bool {
      ProcessInfo.processInfo.environment["ATRIUM_PAIRING_KEYCHAIN_CHECK"] == "1"
    }
    @State private var result = "running"

    /// Creates the acceptance screen without touching the keychain yet.
    ///
    /// - Remark: The check starts in the view task.
    /// - SideEffects: none
    public init() {}

    /// The non-secret result read by XCUITest.
    public var body: some View {
      Text(result)
        .accessibilityIdentifier("pairing.keychain.result")
        .task { result = Self.check() }
    }

    /// Executes equivalent CRUD and protection checks through the production KeychainStore.
    ///
    /// - Remark: Every query and cleanup is confined to a unique account in a fixed test service.
    /// - SideEffects: Creates, updates and deletes one test item; never reads the business service.
    /// - Returns: Passed or a non-secret failure category.
    private static func check() -> String {
      let service = "site.ktoon.atrium.debug.pairing-keychain-check"
      let account = "check.\(UUID().uuidString)"
      let store = KeychainStore(service: service)
      var result = "passed"
      do {
        guard try store.read(account) == nil else { throw CheckFailure.unexpected }
        try store.write(account, Data([1, 2, 3]))
        guard try store.read(account) == Data([1, 2, 3]) else { throw CheckFailure.unexpected }
        try store.write(account, Data([4, 5]))
        guard try store.read(account) == Data([4, 5]), try store.accounts().contains(account) else {
          throw CheckFailure.unexpected
        }
        let query: [String: Any] = [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service,
          kSecAttrAccount as String: account,
          kSecUseDataProtectionKeychain as String: true,
          kSecReturnAttributes as String: true,
          kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
        guard let attributes = item as? [String: Any],
          attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            as String,
          attributes[kSecAttrService as String] as? String == service,
          attributes[kSecAttrAccount as String] as? String == account
        else { throw CheckFailure.unexpected }
        try store.delete(account)
        guard try store.read(account) == nil, try !store.accounts().contains(account) else {
          throw CheckFailure.unexpected
        }
        try store.delete(account)
      } catch StoreError.keychain(let code) {
        result = "failed:keychain:\(code)"
      } catch {
        result = "failed:assertion"
      }
      // Cleanup is attempted even when any assertion or write failed, and its failure is visible.
      do { try store.delete(account) } catch { if result == "passed" { result = "failed:cleanup" } }
      return result
    }

    /// An assertion mismatch without any secret details.
    ///
    /// - Remark: Only used inside this fixed debug check.
    private enum CheckFailure: Error { case unexpected }
  }
#endif
