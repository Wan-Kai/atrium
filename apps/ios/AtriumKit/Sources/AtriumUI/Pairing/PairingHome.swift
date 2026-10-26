import AtriumRemote
import Network
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Adds minimal pairing and connection wiring to the ordinary home, without changing debug galleries.
///
/// - Remark: MP4 test wiring only. The future sync owner must call markSynced; this wrapper never
///   calls a merely encrypted connection fully connected.
public struct PairingHome<Content: View>: View {
  private let content: Content
  private let store = HostStore(KeychainStore())
  private let environment: RemoteEnvironment
  @State private var model: PairingModel?
  @State private var connection: RemoteConnection?
  @State private var revision = 0
  @State private var connectionText = "还没配对 Mac"
  @Environment(\.scenePhase) private var scenePhase

  /// Wraps the normal home in pairing controls.
  ///
  /// - Remark: Kept outside App so the application entry remains assembly only.
  /// - SideEffects: none
  /// - Parameter content: The ordinary home content, not debug or performance screens.
  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
    environment = .live(appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
  }

  /// Home content with an explicit pairing sheet and scoped connection tasks.
  public var body: some View {
    content
      .safeAreaInset(edge: .bottom) {
        HStack {
          Text(connectionText).font(.footnote).foregroundStyle(.secondary)
          Spacer()
          Button("连接 Mac", systemImage: "qrcode") {
            model = PairingModel(environment: environment, store: store, device: deviceInfo, onPaired: paired)
          }
          .accessibilityIdentifier("pairing.open")
        }
        .padding()
      }
      .sheet(item: $model) { model in
        PairingView(model: model)
      }
      .task {
        guard connection == nil else { return }
        do {
          if let host = try store.hosts().first ?? store.pendingHosts().first {
            connect(host, handover: nil)
          }
        } catch { connectionText = "钥匙串暂不可用，请解锁后重试" }
      }
      .task(id: revision) {
        guard let connection else { return }
        await connection.start()
        for await status in connection.statuses {
          guard !Task.isCancelled else { break }
          connectionText = Self.message(for: status)
        }
        await connection.stop()
      }
      .task(id: revision) {
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
    connect(host, handover: outcome.channel)
  }

  /// Creates the connection observed by view tasks.
  ///
  /// - Remark: Replacing the revision cancels and stops the previous connection's tasks.
  /// - SideEffects: Reads the device key and prepares a connection, or closes an unused handover.
  /// - Parameters:
  ///   - host: The stored host.
  ///   - handover: A pairing channel, if just confirmed.
  private func connect(_ host: HostRecord, handover: SecureChannel?) {
    do {
      connection = RemoteConnection(
        host: host, deviceKey: try store.deviceKey(), store: store,
        environment: environment, handover: handover)
      revision += 1
    } catch {
      handover?.abort()
      connectionText = "钥匙串暂不可用，请解锁后重试"
    }
  }

  /// Explains connection state without displaying untrusted transport text.
  ///
  /// - Remark: Sending stays outside this test wrapper until the sync layer is assembled.
  /// - SideEffects: none
  /// - Parameter status: The remote connection status.
  /// - Returns: A concise status label.
  private static func message(for status: ConnectionStatus) -> String {
    switch status {
    case .connecting: "正在连接"
    case .syncing: "正在同步"
    case .connected: "已连接"
    case .reconnecting: "正在重新连接"
    case .noNetwork: "连不出去，请检查无线数据权限"
    case .relayUnreachable: "连不上中继服务器"
    case .hostOffline: "Mac 不在线"
    case .versionMismatch: "Mac 与 App 版本不一致"
    case .revoked: "这台手机已被撤销，请重新配对"
    case .pairingIncomplete: "上次配对未完成，请重新扫码"
    }
  }
}
