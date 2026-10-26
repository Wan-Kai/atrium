import CryptoKit
import Foundation

/// What the phone remembers about a Mac (SPEC-0005 "iOS App · 存储").
///
/// - Remark: The same shape for a confirmed host and a pairing still waiting for the Mac ("待确认"),
///   which has no `deviceId` yet. The relay address comes from the QR code; a new relay means
///   pairing again (SPEC-0005 "换 relay").
public struct HostRecord: Codable, Equatable, Sendable {
  /// The host id.
  public var hostId: String
  /// The relay's base URL.
  public var relay: URL
  /// The host's static public key.
  public var hostKey: Data
  /// The Mac's name.
  public var hostName: String
  /// The id the host gave this phone; `nil` while the pairing waits for the Mac.
  public var deviceId: String?

  /// Builds a record.
  ///
  /// - Remark: Memberwise.
  /// - SideEffects: none
  /// - Parameters:
  ///   - hostId: The host id.
  ///   - relay: The relay's base URL.
  ///   - hostKey: The host's static key.
  ///   - hostName: The Mac's name.
  ///   - deviceId: This phone's id on the host, once known.
  public init(hostId: String, relay: URL, hostKey: Data, hostName: String, deviceId: String? = nil) {
    self.hostId = hostId
    self.relay = relay
    self.hostKey = hostKey
    self.hostName = hostName
    self.deviceId = deviceId
  }

  /// The pending record a scanned link makes.
  ///
  /// - Remark: Written before connecting, so a `paired` that never arrives can be completed by the
  ///   next daily connection (SPEC-0005 "配对流程" step 6).
  /// - SideEffects: none
  /// - Parameter link: The pairing link.
  public init(pending link: PairingLink) {
    self.init(hostId: link.hostId, relay: link.relay, hostKey: link.hostKey, hostName: link.hostName)
  }

  /// Whether this is a pairing still waiting for the Mac.
  public var isPending: Bool { deviceId == nil }
}

/// The phone's keychain contents: its device key, a record per Mac, and pending pairings.
///
/// - Remark: Accounts are `device-key`, `host.<hostId>` and `pending.<hostId>`. Pending records are
///   separate so pairing again with a known Mac (a new relay) does not touch the working record until
///   the Mac confirms. Forgetting or revoking a Mac removes both; the device key stays, since it is
///   this phone's identity and the host recognises a re-paired phone by it (SPEC-0005 "换 relay").
public struct HostStore: Sendable {
  private let secrets: any SecretStore

  /// Wraps a secret store.
  ///
  /// - Remark: ``KeychainStore`` in the app.
  /// - SideEffects: none
  /// - Parameter secrets: Where to keep the items.
  public init(_ secrets: any SecretStore) {
    self.secrets = secrets
  }

  /// This phone's static key: read it, or create and store it on first use.
  ///
  /// - Remark: One key for every Mac (SPEC-0005 "配对流程" step 2).
  /// - SideEffects: May write the store.
  /// - Returns: The key.
  /// - Throws: ``StoreError``.
  public func deviceKey() throws(StoreError) -> Curve25519.KeyAgreement.PrivateKey {
    if let raw = try secrets.read("device-key") {
      guard let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) else { throw .corrupt }
      return key
    }
    let key = Curve25519.KeyAgreement.PrivateKey()
    try secrets.write("device-key", key.rawRepresentation)
    return key
  }

  /// The confirmed Macs, by host id.
  ///
  /// - Remark: Records that no longer decode are skipped rather than failing the whole list.
  /// - SideEffects: Reads the store.
  /// - Returns: The records.
  /// - Throws: ``StoreError``.
  public func hosts() throws(StoreError) -> [HostRecord] {
    try records(prefix: "host.")
  }

  /// The pairings still waiting for the Mac, by host id.
  ///
  /// - Remark: See ``hosts()``.
  /// - SideEffects: Reads the store.
  /// - Returns: The records.
  /// - Throws: ``StoreError``.
  public func pendingHosts() throws(StoreError) -> [HostRecord] {
    try records(prefix: "pending.")
  }

  /// Remembers a pairing before connecting.
  ///
  /// - Remark: Replaces an earlier pending record of the same Mac.
  /// - SideEffects: Writes the store.
  /// - Parameter record: A record without `deviceId`.
  /// - Throws: ``StoreError``.
  public func savePending(_ record: HostRecord) throws(StoreError) {
    try save(record, account: "pending.\(record.hostId)")
  }

  /// Turns a pending pairing into a confirmed record.
  ///
  /// - Remark: Writes the record before deleting the pending one, so a failure in between leaves
  ///   both, never neither.
  /// - SideEffects: Writes the store.
  /// - Parameters:
  ///   - pending: The pending record.
  ///   - deviceId: The id the host gave this phone.
  ///   - hostName: The Mac's name from `paired`, if it sent one.
  /// - Returns: The confirmed record.
  /// - Throws: ``StoreError``.
  @discardableResult
  public func confirm(_ pending: HostRecord, deviceId: String, hostName: String? = nil) throws(StoreError)
    -> HostRecord
  {
    var record = pending
    record.deviceId = deviceId
    if let hostName, !hostName.isEmpty { record.hostName = hostName }
    try save(record, account: "host.\(record.hostId)")
    try secrets.delete("pending.\(record.hostId)")
    return record
  }

  /// Drops a pending pairing.
  ///
  /// - Remark: After the Mac refused, or `device_unknown` for it.
  /// - SideEffects: Writes the store.
  /// - Parameter hostId: The host id.
  /// - Throws: ``StoreError``.
  public func removePending(_ hostId: String) throws(StoreError) {
    try secrets.delete("pending.\(hostId)")
  }

  /// Forgets a Mac: its record and any pending pairing.
  ///
  /// - Remark: After a `revoked` or `device_unknown` from inside Noise, or the user's "忘掉".
  /// - SideEffects: Writes the store.
  /// - Parameter hostId: The host id.
  /// - Throws: ``StoreError``.
  public func removeHost(_ hostId: String) throws(StoreError) {
    try secrets.delete("host.\(hostId)")
    try secrets.delete("pending.\(hostId)")
  }

  /// Writes one record as JSON.
  ///
  /// - Remark: JSON keeps the item readable when debugging on a device.
  /// - SideEffects: Writes the store.
  /// - Parameters:
  ///   - record: The record.
  ///   - account: The item's name.
  /// - Throws: ``StoreError``.
  private func save(_ record: HostRecord, account: String) throws(StoreError) {
    guard let data = try? JSONEncoder().encode(record) else { throw .corrupt }
    try secrets.write(account, data)
  }

  /// Reads every record whose account starts with `prefix`.
  ///
  /// - Remark: See ``hosts()``.
  /// - SideEffects: Reads the store.
  /// - Parameter prefix: `host.` or `pending.`.
  /// - Returns: The records, by host id.
  /// - Throws: ``StoreError``.
  private func records(prefix: String) throws(StoreError) -> [HostRecord] {
    var records: [HostRecord] = []
    for account in try secrets.accounts() where account.hasPrefix(prefix) {
      guard let data = try secrets.read(account),
        let record = try? JSONDecoder().decode(HostRecord.self, from: data)
      else { continue }
      records.append(record)
    }
    return records.sorted { $0.hostId < $1.hostId }
  }
}
