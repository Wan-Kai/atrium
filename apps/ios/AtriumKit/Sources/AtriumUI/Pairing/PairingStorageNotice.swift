import AtriumRemote
import SwiftUI

/// Presents a local persistence failure without replacing the authenticated connection state.
///
/// - Remark: Only operation categories become user-facing text; keychain codes and payloads stay private.
struct PairingStorageNotice: View {
  let issue: RemoteStorageIssue
  let retrying: Bool
  let retry: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(Self.message(for: issue.operation))
        .font(.footnote)
        .accessibilityIdentifier("pairing.storage.error")
      Button("重试", action: retry)
        .disabled(retrying)
        .accessibilityIdentifier("pairing.storage.retry")
    }
  }

  /// Maps a storage operation to a generic recovery instruction.
  ///
  /// - Remark: No error description or numeric status can reach this formatter.
  /// - SideEffects: none
  /// - Parameter operation: The failed local operation.
  /// - Returns: A safe save or cleanup message.
  static func message(for operation: RemoteStorageOperation) -> String {
    switch operation {
    case .confirmPairing: "没能保存配对记录，请解锁手机后重试。"
    case .removeHost, .removePending: "没能清理配对记录，请解锁手机后重试。"
    }
  }
}
