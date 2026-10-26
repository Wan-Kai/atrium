import AtriumRemote
import Foundation
import Synchronization

/// ``SecretStore`` in memory, with an optional failure for writes.
///
/// - Remark: The keychain itself is tested in the simulator; everything above it runs on macOS with
///   this (testing.md "Swift（手机端）").
public final class MemorySecretStore: SecretStore {
  /// The store's state.
  ///
  /// - Remark: `failWrites` makes every write and delete throw.
  private struct State {
    var items: [String: Data] = [:]
    var failWrites: StoreError?
    var includingDeletes = true
  }

  private let state = Mutex(State())

  /// Makes an empty store.
  ///
  /// - Remark: One per test.
  /// - SideEffects: none
  public init() {}

  /// Makes writes and deletes fail with `error`, or work again with `nil`.
  ///
  /// - Remark: For "钥匙串不可用".
  /// - SideEffects: Changes the store's behaviour.
  /// - Parameters:
  ///   - error: The failure.
  ///   - includingDeletes: Whether deletion fails too; false models a write-only failure.
  public func failWrites(with error: StoreError?, includingDeletes: Bool = true) {
    state.withLock {
      $0.failWrites = error
      $0.includingDeletes = includingDeletes
    }
  }

  /// The items, for assertions.
  public var items: [String: Data] { state.withLock { $0.items } }

  /// Reads an item.
  ///
  /// - Remark: See ``SecretStore/read(_:)``.
  /// - SideEffects: none
  /// - Parameter account: The item's name.
  /// - Returns: The bytes, or `nil`.
  /// - Throws: Never; declared to match the storage protocol.
  public func read(_ account: String) throws(StoreError) -> Data? {
    state.withLock { $0.items[account] }
  }

  /// Writes an item.
  ///
  /// - Remark: See ``SecretStore/write(_:_:)``.
  /// - SideEffects: Changes the items.
  /// - Parameters:
  ///   - account: The item's name.
  ///   - data: The bytes.
  /// - Throws: The planned failure.
  public func write(_ account: String, _ data: Data) throws(StoreError) {
    let failure: StoreError? = state.withLock { state in
      if let failure = state.failWrites { return failure }
      state.items[account] = data
      return nil
    }
    if let failure { throw failure }
  }

  /// Deletes an item.
  ///
  /// - Remark: See ``SecretStore/delete(_:)``.
  /// - SideEffects: Changes the items.
  /// - Parameter account: The item's name.
  /// - Throws: The planned failure.
  public func delete(_ account: String) throws(StoreError) {
    let failure: StoreError? = state.withLock { state in
      if state.includingDeletes, let failure = state.failWrites { return failure }
      state.items[account] = nil
      return nil
    }
    if let failure { throw failure }
  }

  /// Lists the items.
  ///
  /// - Remark: See ``SecretStore/accounts()``.
  /// - SideEffects: none
  /// - Returns: The names, sorted.
  public func accounts() throws(StoreError) -> [String] {
    state.withLock { $0.items.keys.sorted() }
  }
}
