import AtriumRemote
import SwiftUI

/// A system-style test connection surface for scanning, pasting and confirming a pairing.
///
/// - Remark: MP4 wiring, not final visual acceptance; inherits native accessibility and Dynamic Type.
public struct PairingView: View {
  @State private var model: PairingModel
  @State private var pastedLink = ""
  @FocusState private var linkFocused: Bool
  @State private var scanning = false
  @State private var cameraUnavailable = false
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  /// Presents the injected remote flow projection.
  ///
  /// - Remark: The app owns connection assembly after the outcome is transferred.
  /// - SideEffects: none
  /// - Parameter model: The pairing projection, already wired to its connection owner.
  public init(model: PairingModel) {
    _model = State(initialValue: model)
  }

  /// A native form with only the controls relevant to the current pairing state.
  public var body: some View {
    NavigationStack {
      Form {
        switch model.state {
        case nil:
          entry
        case .connecting:
          ProgressView("正在连接 Mac…")
        case .confirming(let code, let left):
          Section {
            Text("请核对两边的校验码，在 Mac 上确认")
            CodeCards(code: code)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 6)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("校验码 \(code.map(String.init).joined(separator: " "))")
              .accessibilityIdentifier("pairing.code")
            Text("还剩 \(left) 秒")
              .foregroundStyle(.secondary)
          } header: {
            Text("在 Mac 上确认")
          }
        case .paired(let host):
          Section {
            Label("已配对 \(host.hostName)", systemImage: "checkmark.circle")
            Button("完成") { dismiss() }
              .accessibilityIdentifier("pairing.done")
          }
        case .failed(let failure):
          Section {
            Text(Self.message(for: failure))
              .accessibilityIdentifier("pairing.error")
            Button("重新扫码或粘贴") { model.cancel() }
          } header: {
            Text("没有完成配对")
          }
        }
        if let issue = model.storageIssue {
          Section {
            PairingStorageNotice(issue: issue, retrying: model.isRunning, retry: model.retryStorage)
          }
        }
      }
      .navigationTitle("连接 Mac")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") {
            model.cancel()
            dismiss()
          }
        }
      }
      .onChange(of: scenePhase, initial: true) { _, phase in
        switch phase {
        case .active: model.setAppPhase(.active)
        case .inactive: model.setAppPhase(.inactive)
        case .background: model.setAppPhase(.background)
        @unknown default: break
        }
      }
      .onDisappear { model.cancel() }
      #if os(iOS)
        .sheet(isPresented: $scanning) {
          PairingScannerView(
            onCode: { code in
              scanning = false
              model.submit(code)
            },
            onUnavailable: {
              scanning = false
              cameraUnavailable = true
            })
        }
      #endif
    }
  }

  /// QR capture and an explicit paste fallback, with no automatic clipboard reads.
  private var entry: some View {
    Section {
      Text("在 Mac 的 Atrium 设置中打开「手机」，点击「配对新设备」。")
      #if os(iOS)
        Button("扫描二维码", systemImage: "qrcode.viewfinder") { scanning = true }
          .accessibilityIdentifier("pairing.scan")
      #endif
      if cameraUnavailable {
        Text("相机暂不可用。请在系统设置中允许相机访问，或粘贴配对链接。")
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("pairing.cameraUnavailable")
      }
      TextField("atrium://pair?…", text: $pastedLink, axis: .vertical)
        .textContentType(.URL)
        .autocorrectionDisabled()
        .focused($linkFocused)
        .accessibilityLabel("配对链接")
        .accessibilityIdentifier("pairing.link")
      Button("用链接配对") {
        let text = pastedLink
        pastedLink = ""
        linkFocused = false
        model.submit(text)
      }
      .disabled(pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .accessibilityIdentifier("pairing.submit")
      if model.invalidLink {
        Text("这不是有效的配对链接，请在 Mac 上重新复制。")
          .foregroundStyle(.red)
          .accessibilityIdentifier("pairing.invalid")
      }
    } header: {
      Text("配对新设备")
    }
  }

  /// Explains each remote failure without exposing credentials or raw untrusted error strings.
  ///
  /// - Remark: The remote module emits states, never user-facing text.
  /// - SideEffects: none
  /// - Parameters:
  ///   - failure: The remote flow's failure.
  ///   - locale: The timestamp's display locale.
  ///   - timeZone: The timestamp's display time zone.
  /// - Returns: A recovery-oriented message.
  public static func message(
    for failure: PairingFailure, locale: Locale = .current, timeZone: TimeZone = .current
  ) -> String {
    switch failure {
    case .superseded: "本次配对已被新的配对替代，请使用最新的配对。"
    case .revoked: "这台手机已被撤销，请重新配对。"
    case .declined: "Mac 拒绝了配对，请在 Mac 上重新出码。"
    case .busy: "另一台手机正在配对，请稍后在 Mac 上重新出码。"
    case .expired: "二维码已失效，请在 Mac 上重新出码。"
    case .timedOut: "等待确认超时。如果 Mac 已确认，下次连接会尝试恢复。"
    case .cancelled: "Mac 已取消配对，请重新出码。"
    case .interrupted: "连接中断，已保留待确认记录，下次连接会尝试恢复。"
    case .noNetwork: "连不出去，请检查网络和系统设置中的「无线数据」权限。"
    case .hostOffline(let lastSeen):
      "Mac 不在线，\(PairingLastSeen.message(lastSeen, locale: locale, timeZone: timeZone))。请打开 Mac 上的 Atrium 并检查远程连接。"
    case .relayUnreachable: "连不上中继服务器，请检查网络和 Mac 上的连接设置。"
    case .versionMismatch: "Mac 上的 Atrium 和 App 版本不一致，请更新后重试。"
    case .hostError: "Mac 没能保存配对，请在 Mac 上检查后重试。"
    case .keychainUnavailable: "钥匙串暂不可用，请解锁手机后重试。"
    case .other: "没有完成配对，请检查连接后重新出码。"
    }
  }
}

/// The six-digit check code, one paper card a digit, in Fraunces italic.
///
/// - Remark: design-language "手机端 · 配对": 46×62pt `--note` cards, 6pt apart with a wider gap after
///   the third, the digits 36pt. The bundled Fraunces cut has the digits.
struct CodeCards: View {
  /// The code.
  let code: String
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The cards.
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 6) {
      ForEach(Array(code.enumerated()), id: \.offset) { place, digit in
        Text(String(digit))
          .font(Typography.brand(size: 36))
          .foregroundStyle(palette.text)
          .frame(width: 46, height: 62)
          .background(palette.note, in: RoundedRectangle(cornerRadius: 12))
          .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.line, lineWidth: 0.5))
          .padding(.leading, place == 3 ? 10 : 0)
      }
    }
  }
}
