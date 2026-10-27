import AtriumRemote
import Network
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Adds minimal pairing and connection wiring to the ordinary home, without changing debug galleries.
///
/// - Remark: Each connection gets its own ``SyncModel``, put in the content's environment; the model
///   alone calls `markSynced`, so a merely encrypted connection is never shown as connected
///   (SPEC-0005 "MP4a 定的细节"). The pairing controls stay test wiring until MP6.
public struct PairingHome<Content: View>: View {
  private let content: Content
  private let store: HostStore
  private let environment: RemoteEnvironment
  @State private var model: PairingModel?
  @State private var connection: RemoteConnection?
  @State private var sync: SyncModel?
  @State private var target: (host: HostRecord, handover: SecureChannel?, ownership: HostStore.Claim?)?
  @State private var revision = 0
  @State private var connectionRevision = 0
  @State private var connectionText = "还没配对 Mac"
  @State private var storageIssue: RemoteStorageIssue?
  @State private var storageRetryRequested = false
  @Environment(\.scenePhase) private var scenePhase

  /// Wraps the normal home in pairing controls.
  ///
  /// - Remark: Kept outside App so the application entry remains assembly only.
  /// - SideEffects: none
  /// - Parameters:
  ///   - store: The application's single shared record owner.
  ///   - content: The ordinary home content, not debug or performance screens.
  public init(store: HostStore, @ViewBuilder content: () -> Content) {
    self.store = store
    self.content = content()
    environment = .live(appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
  }

  /// Home content with an explicit pairing sheet and scoped connection tasks.
  public var body: some View {
    content
      .environment(sync)
      .safeAreaInset(edge: .bottom) {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(connectionText).font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("连接 Mac", systemImage: "qrcode") {
              model = PairingModel(environment: environment, store: store, device: deviceInfo, onPaired: paired)
            }
            .accessibilityIdentifier("pairing.open")
          }
          if let issue = storageIssue {
            PairingStorageNotice(issue: issue, retrying: storageRetryRequested) { storageRetryRequested = true }
          }
        }
        .padding()
      }
      .sheet(item: $model) { model in
        PairingView(model: model)
      }
      .task {
        guard connection == nil else { return }
        do {
          if let host = try await Self.loadRestorationHost(from: store), !Task.isCancelled,
            revision == 0, model == nil
          {
            connect(host.record, handover: nil, ownership: host.ownership)
          }
        } catch { connectionText = "钥匙串暂不可用，请解锁后重试" }
      }
      .task(id: revision) {
        guard !Task.isCancelled, let target else { return }
        self.target = nil
        let connection: RemoteConnection
        do {
          connection = try await Self.makeConnection(
            host: target.host, store: store, environment: environment, handover: target.handover,
            ownership: target.ownership)
        } catch {
          target.handover?.abort()
          if !Task.isCancelled { connectionText = "钥匙串暂不可用，请解锁后重试" }
          return
        }
        guard !Task.isCancelled else {
          await connection.stop()
          return
        }
        let sync = SyncModel(
          connection: connection, hostName: target.host.hostName, traceparent: environment.traceparent,
          now: { [stopwatch = environment.stopwatch] in stopwatch.now.offset },
          requestId: { UUID().uuidString.lowercased() })
        self.connection = connection
        self.sync = sync
        storageRetryRequested = false
        connectionRevision += 1
        let syncing = Task { await sync.run() }
        await connection.start()
        for await status in connection.statuses {
          guard !Task.isCancelled else { break }
          connectionText = Self.message(for: status)
          await sync.statusChanged(status)
        }
        syncing.cancel()
        await syncing.value
        await connection.stop()
      }
      .task(id: connectionRevision) {
        guard !Task.isCancelled else { return }
        storageIssue = nil
        guard let connection else { return }
        await Self.observeStorageIssues(of: connection) { storageIssue = $0 }
      }
      .task(id: storageRetryRequested) {
        guard !Task.isCancelled, storageRetryRequested, let connection else { return }
        let owner = connectionRevision
        await connection.retryStorage()
        if owner == connectionRevision { storageRetryRequested = false }
      }
      .task(id: connectionRevision) {
        guard let connection else { return }
        let monitor = NWPathMonitor()
        let (paths, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .bufferingNewest(1))
        monitor.pathUpdateHandler = { path in continuation.yield(path.status == .satisfied) }
        monitor.start(queue: DispatchQueue(label: "site.ktoon.atrium.pairing.network"))
        defer {
          monitor.cancel()
          continuation.finish()
        }
        for await available in paths {
          guard !Task.isCancelled else { break }
          await connection.networkChanged(available: available)
        }
      }
      .task(id: scenePhase) {
        guard let connection else { return }
        switch scenePhase {
        case .active: await connection.setAppPhase(.active)
        case .inactive: await connection.setAppPhase(.inactive)
        case .background:
          #if os(iOS)
            let background = UIApplication.shared.beginBackgroundTask(withName: "Close remote connection")
          #endif
          await connection.setAppPhase(.background)
          await connection.closeForBackground()
          #if os(iOS)
            if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
          #endif
        @unknown default: break
        }
      }
  }

  /// Observes persistence separately from network status, including unchanged terminal statuses.
  ///
  /// - Remark: Cleanup retries can change only the issue, so a status subscription cannot project it.
  /// - SideEffects: Delivers storage state until the view task is cancelled.
  /// - Parameters:
  ///   - connection: The current connection owner.
  ///   - receive: Updates the screen's independent storage notice.
  static func observeStorageIssues(of connection: RemoteConnection, receive: (RemoteStorageIssue?) -> Void) async {
    for await issue in connection.storageIssues {
      guard !Task.isCancelled else { return }
      receive(issue)
    }
  }

  /// Reads the records used by cold restoration.
  ///
  /// - Remark: The application passes the same store to restoration and pairing.
  /// - SideEffects: Reads the secret store.
  /// - Parameter store: The application's record owner.
  /// - Returns: The selected record, if any.
  /// - Throws: A storage failure.
  static func loadRestorationHost(from store: HostStore) async throws
    -> (record: HostRecord, ownership: HostStore.Claim)?
  {
    let records = try await store.loadRecords()
    guard let record = restorationHost(hosts: records.hosts, pendingHosts: records.pendingHosts),
      let ownership = records.claims[record.hostId]
    else { return nil }
    return (record, ownership)
  }

  /// Creates a connection after loading the device identity.
  ///
  /// - Remark: A pairing handover is not reopened; ownership transfers to the connection.
  /// - SideEffects: Reads or creates the device key.
  /// - Parameters:
  ///   - host: The selected record.
  ///   - store: The application's record owner.
  ///   - environment: The connection's injected transport and clock.
  ///   - handover: An already authenticated pairing channel.
  ///   - ownership: The record versions captured with the selected host.
  /// - Returns: A connection ready to start.
  /// - Throws: A storage failure.
  static func makeConnection(
    host: HostRecord, store: HostStore, environment: RemoteEnvironment, handover: SecureChannel? = nil,
    ownership: HostStore.Claim? = nil
  ) async throws -> RemoteConnection {
    RemoteConnection(
      host: host, deviceKey: try await store.loadDeviceKey(), store: store, environment: environment,
      handover: handover, ownership: ownership)
  }

  /// Selects the existing host, using its pending replacement when one was interrupted.
  ///
  /// - Remark: A pending pairing for another Mac must not change the selected host.
  /// - SideEffects: none
  /// - Parameters:
  ///   - hosts: Confirmed hosts in store order.
  ///   - pendingHosts: Pending pairings in store order.
  /// - Returns: The next connection's stored record, if any.
  static func restorationHost(hosts: [HostRecord], pendingHosts: [HostRecord]) -> HostRecord? {
    guard let selected = hosts.first else { return pendingHosts.first }
    return pendingHosts.first(where: { $0.hostId == selected.hostId }) ?? selected
  }

  /// Metadata announced by the phone when pairing.
  private var deviceInfo: DeviceInfo {
    #if os(iOS)
      DeviceInfo(deviceName: UIDevice.current.name, model: UIDevice.current.model, appVersion: environment.appVersion)
    #else
      DeviceInfo(deviceName: "Mac", model: "Mac", appVersion: environment.appVersion)
    #endif
  }

  /// Adopts a confirmed channel without opening another pairing connection.
  ///
  /// - Remark: The store has already been updated by PairingFlow.
  /// - SideEffects: Changes the connection observed by scoped view tasks.
  /// - Parameter outcome: The screen's transferred outcome.
  private func paired(_ outcome: PairingOutcome) {
    guard case .paired(let host) = outcome.state else {
      outcome.channel?.abort()
      return
    }
    connect(host, handover: outcome.channel, ownership: outcome.ownership)
  }

  /// Creates the connection observed by view tasks.
  ///
  /// - Remark: Replacing the revision cancels and stops the previous connection's tasks.
  /// - SideEffects: Schedules the view-owned connection task, closing an unused handover.
  /// - Parameters:
  ///   - host: The stored host.
  ///   - handover: A pairing channel, if just confirmed.
  ///   - ownership: The selected record's original versions.
  private func connect(_ host: HostRecord, handover: SecureChannel?, ownership: HostStore.Claim?) {
    target?.handover?.abort()
    target = (host, handover, ownership)
    connection = nil
    sync = nil
    storageRetryRequested = false
    connectionRevision += 1
    revision += 1
  }

  /// Explains connection state without displaying untrusted transport text.
  ///
  /// - Remark: The bottom line under the home; the home's pill says the same in fewer words.
  /// - SideEffects: none
  /// - Parameters:
  ///   - status: The remote connection status.
  ///   - locale: The timestamp's display locale.
  ///   - timeZone: The timestamp's display time zone.
  /// - Returns: A concise status label.
  static func message(
    for status: ConnectionStatus, locale: Locale = .current, timeZone: TimeZone = .current
  ) -> String {
    switch status {
    case .connecting: "正在连接"
    case .syncing: "正在同步"
    case .connected: "已连接"
    case .reconnecting: "正在重新连接"
    case .noNetwork: "连不出去，请检查无线数据权限"
    case .relayUnreachable: "连不上中继服务器"
    case .hostOffline(let lastSeen):
      "Mac 不在线，\(PairingLastSeen.message(lastSeen, locale: locale, timeZone: timeZone))"
    case .versionMismatch: "Mac 与 App 版本不一致"
    case .revoked: "这台手机已被撤销，请重新配对"
    case .superseded: "连接已被新的配对替代"
    case .pairingIncomplete: "上次配对未完成，请重新扫码"
    }
  }
}
