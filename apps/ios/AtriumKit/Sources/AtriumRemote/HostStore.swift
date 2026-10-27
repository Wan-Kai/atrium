import CryptoKit
import Foundation
import Synchronization

/// The host identity and relay remembered by this phone.
///
/// - Remark: A pending pairing has no deviceId; its persisted format is unchanged by in-memory claims.
public struct HostRecord: Codable, Equatable, Sendable {
  /// The host identity registered with the relay.
  public var hostId: String
  /// The relay base URL obtained from the pairing link.
  public var relay: URL
  /// The host's static public key used to authenticate its Noise responses.
  public var hostKey: Data
  /// The Mac's display name.
  public var hostName: String
  /// This phone's assigned identity, or nil while the pairing is pending.
  public var deviceId: String?

  /// Builds a stored host record.
  ///
  /// - Remark: Memberwise initialization.
  /// - SideEffects: none
  /// - Parameters:
  ///   - hostId: Relay host identity.
  ///   - relay: Relay base URL.
  ///   - hostKey: Authenticated host public key.
  ///   - hostName: Display name.
  ///   - deviceId: The phone identity assigned by this host.
  public init(hostId: String, relay: URL, hostKey: Data, hostName: String, deviceId: String? = nil) {
    self.hostId = hostId
    self.relay = relay
    self.hostKey = hostKey
    self.hostName = hostName
    self.deviceId = deviceId
  }

  /// Builds the pending record before a pairing handshake starts.
  ///
  /// - Remark: Never persists the QR code's PSK.
  /// - SideEffects: none
  /// - Parameter link: Validated pairing link.
  public init(pending link: PairingLink) {
    self.init(hostId: link.hostId, relay: link.relay, hostKey: link.hostKey, hostName: link.hostName)
  }

  /// Whether the host has not yet assigned this phone a confirmed device identity.
  public var isPending: Bool { deviceId == nil }
}

/// Both record lists, read together by the off-main application bootstrap.
///
/// - Remark: Selection policy belongs to the UI; storage does not silently choose another Mac.
public struct StoredHostRecords: Sendable {
  /// Confirmed host records in the loaded snapshot.
  public let hosts: [HostRecord]
  /// Pending pairings retained for confirmation recovery.
  public let pendingHosts: [HostRecord]
  /// Record ownership captured with the snapshot, keyed by host identity.
  public let claims: [String: HostStore.Claim]
}

/// The single process-local authority for phone keys and host/pending record mutations.
///
/// - Remark: App creates one instance and injects the same reference into every flow and connection.
///   Synchronous methods are for non-MainActor callers. UI uses the concurrent loading entry points.
///   The operation mutex covers keychain work; a separate short versions mutex lets initialization
///   capture ownership without waiting on keychain IO. No lock crosses await or calls UI code.
public final class HostStore: Sendable {
  /// Ownership of the two records as observed by one operation.
  ///
  /// - Remark: New writes get new versions even when encoded data is identical. Claims never persist.
  public struct Claim: Sendable, Equatable {
    /// The host whose confirmed and pending record versions this claim covers.
    public let hostId: String
    fileprivate let authority: UUID
    fileprivate let hostVersion: UUID?
    fileprivate let pendingVersion: UUID?
  }

  /// The exact old record versions still requiring authenticated cleanup.
  ///
  /// - Remark: Partial success removes only completed entries; the shared device key is never included.
  public struct Removal: Sendable {
    fileprivate let claim: Claim
    fileprivate let hostKey: Data
    fileprivate let kinds: [Kind]
  }

  /// One keychain record category.
  ///
  /// - Remark: Kept private to this authority, not an arbitrary account deletion API.
  fileprivate enum Kind: Sendable, Equatable { case host, pending }

  /// A guarded confirmation's result, including updated ownership after partial persistence.
  ///
  /// - Remark: A failed pending deletion can follow a successful host write.
  enum Confirmation: Sendable {
    case saved(HostRecord, Claim)
    case failed(StoreError, Claim)
    case superseded
  }

  /// A guarded removal's result.
  ///
  /// - Remark: Only the remaining entries are returned for retry.
  enum RemovalResult: Sendable {
    case superseded
    case complete
    case failed(StoreError, Removal)
  }

  private let secrets: any SecretStore
  private let authority = UUID()
  private let operations = Mutex(())
  private let versions = Mutex<[String: UUID]>([:])

  /// Wraps the one secret store used by the application.
  ///
  /// - Remark: Constructing multiple authorities for one service bypasses ownership and is forbidden.
  /// - SideEffects: none
  /// - Parameter secrets: Production KeychainStore or an isolated test store.
  public init(_ secrets: any SecretStore) { self.secrets = secrets }

  /// Reads or creates the shared phone key under the same serialized writer authority.
  ///
  /// - Remark: Synchronous, for background actors and tests; UI uses loadDeviceKey.
  /// - SideEffects: Reads and possibly writes the secret store.
  /// - Returns: The stable device key.
  /// - Throws: StoreError, without silently replacing corrupt key bytes.
  public func deviceKey() throws(StoreError) -> Curve25519.KeyAgreement.PrivateKey {
    try locked { () throws(StoreError) -> Curve25519.KeyAgreement.PrivateKey in
      if let raw = try secrets.read("device-key") {
        guard let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) else { throw .corrupt }
        return key
      }
      let key = Curve25519.KeyAgreement.PrivateKey()
      try secrets.write("device-key", key.rawRepresentation)
      return key
    }
  }

  /// Loads the device key away from the UI executor.
  ///
  /// - Remark: Concurrent entry point preserves the synchronous key-creation critical section.
  /// - SideEffects: Reads or creates the keychain item.
  /// - Returns: The stable device key.
  /// - Throws: StoreError.
  @concurrent public func loadDeviceKey() async throws(StoreError) -> Curve25519.KeyAgreement.PrivateKey {
    try deviceKey()
  }

  /// Loads both host lists away from the UI executor.
  ///
  /// - Remark: One critical section gives bootstrap a coherent selection view.
  /// - SideEffects: Reads the keychain.
  /// - Returns: Confirmed and pending records.
  /// - Throws: StoreError.
  @concurrent public func loadRecords() async throws(StoreError) -> StoredHostRecords {
    try locked { () throws(StoreError) -> StoredHostRecords in
      let hosts = try records(prefix: "host.")
      let pending = try records(prefix: "pending.")
      let ids = Set((hosts + pending).map(\.hostId))
      return StoredHostRecords(
        hosts: hosts, pendingHosts: pending, claims: Dictionary(uniqueKeysWithValues: ids.map { ($0, claim($0)) }))
    }
  }

  /// Reads confirmed hosts in host-id order.
  ///
  /// - Remark: Malformed individual records are retained but omitted from the list.
  /// - SideEffects: Reads the store.
  /// - Returns: Confirmed records.
  /// - Throws: StoreError.
  public func hosts() throws(StoreError) -> [HostRecord] {
    try locked { () throws(StoreError) in try records(prefix: "host.") }
  }

  /// Reads pending hosts in host-id order.
  ///
  /// - Remark: Uses the same decoding policy as hosts.
  /// - SideEffects: Reads the store.
  /// - Returns: Pending records.
  /// - Throws: StoreError.
  public func pendingHosts() throws(StoreError) -> [HostRecord] {
    try locked { () throws(StoreError) in try records(prefix: "pending.") }
  }

  /// Captures record versions without doing keychain IO.
  ///
  /// - Remark: Reading during an ongoing write yields an old claim, which safely becomes superseded.
  /// - SideEffects: none
  /// - Parameter hostId: The selected host.
  /// - Returns: Its current ownership claim.
  public func claim(_ hostId: String) -> Claim {
    versions.withLock {
      Claim(
        hostId: hostId, authority: authority, hostVersion: $0["host.\(hostId)"], pendingVersion: $0["pending.\(hostId)"]
      )
    }
  }

  /// Saves a pending record and grants this attempt a fresh claim.
  ///
  /// - Remark: Identical bytes still represent a distinct attempt and supersede the old owner.
  /// - SideEffects: Writes the store and advances the pending generation.
  /// - Parameter record: Pending host information.
  /// - Returns: The new claim, including the prior host version.
  /// - Throws: StoreError.
  @discardableResult
  public func savePending(_ record: HostRecord) throws(StoreError) -> Claim {
    try locked { () throws(StoreError) -> Claim in
      try save(record, account: "pending.\(record.hostId)")
      return claim(record.hostId)
    }
  }

  /// Acquires pending ownership only if the calling pairing task is still active.
  ///
  /// - Remark: Rechecks cancellation inside the writer lock so a cancelled task waiting on IO cannot
  ///   overwrite the new attempt that acquired the lock first.
  /// - SideEffects: Writes pending and advances its version when active.
  /// - Parameter record: Pending host information.
  /// - Returns: New ownership, or nil for cancellation.
  /// - Throws: StoreError.
  func beginPairing(_ record: HostRecord) throws(StoreError) -> Claim? {
    try locked { () throws(StoreError) -> Claim? in
      guard !Task.isCancelled else { return nil }
      try save(record, account: "pending.\(record.hostId)")
      return claim(record.hostId)
    }
  }

  /// Confirms an explicitly supplied record without a prior asynchronous owner.
  ///
  /// - Remark: For immediate setup/import operations; asynchronous flows must use guarded confirmation.
  /// - SideEffects: Writes the host then removes pending under the operation lock.
  /// - Parameters:
  ///   - pending: The host to confirm.
  ///   - deviceId: Authenticated device id.
  ///   - hostName: Optional authenticated name.
  /// - Returns: The confirmed record.
  /// - Throws: StoreError; a partially successful write is not rolled back.
  @discardableResult
  public func confirm(_ pending: HostRecord, deviceId: String, hostName: String? = nil) throws(StoreError) -> HostRecord
  {
    try locked { () throws(StoreError) -> HostRecord in
      let record = confirmed(pending, deviceId: deviceId, hostName: hostName)
      try save(record, account: "host.\(record.hostId)")
      try delete("pending.\(record.hostId)")
      return record
    }
  }

  /// Confirms only while both original record versions still belong to the attempt.
  ///
  /// - Remark: Returns ownership after partial writes so a retry cannot overwrite a newer pairing.
  /// - SideEffects: May write host and delete pending.
  /// - Parameters:
  ///   - pending: Pending host information.
  ///   - deviceId: Authenticated device id.
  ///   - hostName: Authenticated host name, if supplied.
  ///   - owner: Original versions.
  /// - Returns: Saved, failed with a retry claim, or superseded.
  func confirm(_ pending: HostRecord, deviceId: String, hostName: String?, owner: Claim) -> Confirmation {
    operations.withLock { _ in
      guard owner == claim(pending.hostId) else { return .superseded }
      let record = confirmed(pending, deviceId: deviceId, hostName: hostName)
      do throws(StoreError) {
        try save(record, account: "host.\(record.hostId)")
        try delete("pending.\(record.hostId)")
        return .saved(record, claim(record.hostId))
      } catch { return .failed(error, claim(record.hostId)) }
    }
  }

  /// Creates an authenticated cleanup limited to original record versions and host key.
  ///
  /// - Remark: A newly scanned host key cannot revoke an older host record authenticated by another key.
  /// - SideEffects: none
  /// - Parameters:
  ///   - owner: Original record versions.
  ///   - hostKey: The key that authenticated this removal.
  ///   - pendingOnly: Whether only pending is in scope.
  /// - Returns: The finite cleanup plan.
  public func removal(owner: Claim, hostKey: Data, pendingOnly: Bool) -> Removal {
    Removal(claim: owner, hostKey: hostKey, kinds: pendingOnly ? [.pending] : [.host, .pending])
  }

  /// Deletes still-owned records, retaining only failed entries for retry.
  ///
  /// - Remark: Stale versions and differently authenticated records are superseded, never deleted.
  /// - SideEffects: Reads and deletes scoped host records, never device-key.
  /// - Parameter plan: The remaining authenticated cleanup.
  /// - Returns: Complete or the first failure with remaining entries.
  func remove(_ plan: Removal) -> RemovalResult {
    operations.withLock { _ in
      // A new pending intent also owns its original host version: deleting that host now would
      // invalidate the new flow's later confirmation even without deleting its pending bytes.
      guard plan.claim == claim(plan.claim.hostId) else { return .superseded }
      var remaining: [Kind] = []
      var failure: StoreError?
      var owned = false
      for kind in plan.kinds {
        let prefix = kind == .host ? "host." : "pending."
        let account = prefix + plan.claim.hostId
        let expected = kind == .host ? plan.claim.hostVersion : plan.claim.pendingVersion
        guard versions.withLock({ $0[account] }) == expected else { continue }
        do throws(StoreError) {
          if let data = try secrets.read(account) {
            guard let record = try? JSONDecoder().decode(HostRecord.self, from: data) else { throw .corrupt }
            guard record.hostKey == plan.hostKey else { continue }
            try delete(account)
          }
          owned = true
        } catch {
          remaining.append(kind)
          if failure == nil { failure = error }
        }
      }
      guard let failure else { return owned ? .complete : .superseded }
      return .failed(failure, Removal(claim: claim(plan.claim.hostId), hostKey: plan.hostKey, kinds: remaining))
    }
  }

  /// Explicitly removes pending for synchronous user/setup operations.
  ///
  /// - Remark: Asynchronous authenticated cleanup must use a version-limited removal plan.
  /// - SideEffects: Deletes the item and advances its generation.
  /// - Parameter hostId: Selected host.
  /// - Throws: StoreError.
  public func removePending(_ hostId: String) throws(StoreError) {
    try locked { () throws(StoreError) in try delete("pending.\(hostId)") }
  }

  /// Explicitly forgets one host and its pending pairing, never the shared key.
  ///
  /// - Remark: Asynchronous revocation uses version-limited cleanup instead.
  /// - SideEffects: Deletes scoped records.
  /// - Parameter hostId: Selected host.
  /// - Throws: StoreError.
  public func removeHost(_ hostId: String) throws(StoreError) {
    try locked { () throws(StoreError) in
      try delete("host.\(hostId)")
      try delete("pending.\(hostId)")
    }
  }

  /// Runs synchronous keychain work under the authority's operation lock.
  ///
  /// - Remark: A Result bridges typed StoreError through Mutex without weakening the public contract.
  /// - SideEffects: Those of work; no callbacks or awaits are allowed.
  /// - Parameter work: The synchronous storage operation.
  /// - Returns: Its result.
  /// - Throws: StoreError.
  private func locked<T: Sendable>(_ work: () throws(StoreError) -> T) throws(StoreError) -> T {
    let result: Result<T, StoreError> = operations.withLock { _ in
      do throws(StoreError) { return .success(try work()) } catch { return .failure(error) }
    }
    return try result.get()
  }

  /// Computes the confirmed record without touching storage.
  ///
  /// - Remark: Shared by immediate and guarded writes.
  /// - SideEffects: none
  /// - Parameters:
  ///   - pending: Original record.
  ///   - deviceId: Assigned id.
  ///   - hostName: Optional new name.
  /// - Returns: Confirmed record.
  private func confirmed(_ pending: HostRecord, deviceId: String, hostName: String?) -> HostRecord {
    var record = pending
    record.deviceId = deviceId
    if let hostName, !hostName.isEmpty { record.hostName = hostName }
    return record
  }

  /// Writes one record and advances its in-memory generation after success.
  ///
  /// - Remark: Caller holds operations; no other writer can observe half a transaction.
  /// - SideEffects: Writes keychain and versions.
  /// - Parameters:
  ///   - record: Encodable host record.
  ///   - account: Exact account.
  /// - Throws: StoreError.
  private func save(_ record: HostRecord, account: String) throws(StoreError) {
    guard let data = try? JSONEncoder().encode(record) else { throw .corrupt }
    try secrets.write(account, data)
    versions.withLock { $0[account] = UUID() }
  }

  /// Deletes one exact account and invalidates previous owners.
  ///
  /// - Remark: Caller holds operations; missing-item deletion is idempotent.
  /// - SideEffects: Deletes keychain item and advances versions.
  /// - Parameter account: Exact account.
  /// - Throws: StoreError.
  private func delete(_ account: String) throws(StoreError) {
    try secrets.delete(account)
    versions.withLock { $0[account] = UUID() }
  }

  /// Decodes all matching records under the operation lock.
  ///
  /// - Remark: Corrupt records are retained, not silently destroyed.
  /// - SideEffects: Reads the store.
  /// - Parameter prefix: Host or pending prefix.
  /// - Returns: Decodable records in stable order.
  /// - Throws: StoreError.
  private func records(prefix: String) throws(StoreError) -> [HostRecord] {
    var records: [HostRecord] = []
    for account in try secrets.accounts() where account.hasPrefix(prefix) {
      guard let data = try secrets.read(account), let record = try? JSONDecoder().decode(HostRecord.self, from: data)
      else { continue }
      records.append(record)
    }
    return records.sorted { $0.hostId < $1.hostId }
  }
}
