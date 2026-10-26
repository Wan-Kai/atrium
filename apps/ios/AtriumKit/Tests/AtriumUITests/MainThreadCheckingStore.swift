import AtriumRemote
import AtriumTestSupport
import Foundation

/// Counts secret operations on the main thread while keeping real in-memory record semantics.
///
/// - Remark: The UI's asynchronous entry points must actually leave the main actor before storage.
nonisolated struct MainThreadCheckingStore: SecretStore {
  let backing: MemorySecretStore
  let mainThreadAccesses = Counter()

  /// Reads a record and checks the executor.
  ///
  /// - Remark: Delegates all storage behavior to the shared test store.
  /// - SideEffects: Reads memory and increments a counter.
  /// - Parameter account: The requested account.
  /// - Returns: The stored bytes.
  /// - Throws: A storage failure.
  func read(_ account: String) throws(StoreError) -> Data? {
    if Thread.isMainThread { mainThreadAccesses.increment() }
    return try backing.read(account)
  }

  /// Writes a record and checks the executor.
  ///
  /// - Remark: Includes first-use device key creation.
  /// - SideEffects: Writes memory and increments a counter.
  /// - Parameters:
  ///   - account: The requested account.
  ///   - data: The new bytes.
  /// - Throws: A storage failure.
  func write(_ account: String, _ data: Data) throws(StoreError) {
    if Thread.isMainThread { mainThreadAccesses.increment() }
    try backing.write(account, data)
  }

  /// Deletes a record and checks the executor.
  ///
  /// - Remark: Includes pairing cleanup.
  /// - SideEffects: Deletes memory and increments a counter.
  /// - Parameter account: The requested account.
  /// - Throws: A storage failure.
  func delete(_ account: String) throws(StoreError) {
    if Thread.isMainThread { mainThreadAccesses.increment() }
    try backing.delete(account)
  }

  /// Lists accounts and checks the executor.
  ///
  /// - Remark: Includes cold restoration.
  /// - SideEffects: Reads memory and increments a counter.
  /// - Returns: Sorted accounts.
  /// - Throws: A storage failure.
  func accounts() throws(StoreError) -> [String] {
    if Thread.isMainThread { mainThreadAccesses.increment() }
    return try backing.accounts()
  }
}
