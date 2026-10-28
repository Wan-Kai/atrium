import SwiftUI

/// The card under a failed turn, or for pi that gave up after crashing.
///
/// - Remark: The final prototype's `.ecard` (SPEC-0005 "MP5 定的细节 · MP5b"): a red warning, the
///   words, a solid "重试" and, when there is pi's own text to show, "详情". pi's text is never the
///   card's words: the card's words are the app's.
struct ErrorCard: View {
  /// The card's words.
  let text: String
  /// pi's own error text, shown in the details; `nil` or empty for none.
  let detail: String?
  /// Retries the run; `nil` when retrying makes no sense here (an older turn).
  let retry: (() -> Void)?
  /// Whether the details are open.
  @State private var showing = false
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The card.
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: Metrics.xs) {
      Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 16)).foregroundStyle(palette.danger)
      Text(text).font(.system(size: 14.5)).foregroundStyle(palette.text2).frame(
        maxWidth: .infinity, alignment: .leading)
      if let retry {
        Button(action: retry) {
          Text("重试").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white)
            .padding(.horizontal, 14).frame(height: 32).background(palette.danger, in: Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("session.retry")
      }
      if let detail, !detail.isEmpty {
        Button("详情") { showing = true }.font(.system(size: 13.5)).foregroundStyle(palette.secondary)
          .buttonStyle(.plain)
      }
    }
    .padding(.leading, 14)
    .padding(.trailing, Metrics.xs)
    .padding(.vertical, Metrics.xs)
    .background(palette.dangerSoft, in: RoundedRectangle(cornerRadius: 18))
    .padding(.vertical, 6)
    .sheet(isPresented: $showing) {
      ErrorDetail(text: text, detail: detail ?? "", retry: retry)
    }
  }
}

/// The error's details: pi's own text, which can be copied.
///
/// - Remark: The prototype's "出错详情" sheet: a summary line, "原始报错" in a monospaced block, and
///   "关闭" / "重试".
private struct ErrorDetail: View {
  /// The card's words.
  let text: String
  /// pi's text.
  let detail: String
  /// Retries the run, if it can be.
  let retry: (() -> Void)?
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Metrics.sm) {
      HStack {
        Text("出错详情").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
        Spacer()
        Button {
          Pasteboard.copy(detail)
        } label: {
          Image(systemName: "doc.on.doc").font(.system(size: 15)).foregroundStyle(palette.text2)
            .frame(width: 36, height: 36).background(palette.fill, in: Circle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("复制")
      }
      HStack(spacing: Metrics.xs) {
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(palette.danger)
        Text(text).font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
      }
      Text("原始报错").font(.system(size: 13.5)).foregroundStyle(palette.secondary).padding(.top, Metrics.xs)
      ScrollView {
        Text(detail)
          .font(.system(size: 11.5, design: .monospaced))
          .lineSpacing(4)
          .foregroundStyle(palette.text2)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, Metrics.md)
          .padding(.vertical, 14)
      }
      .background(palette.code, in: RoundedRectangle(cornerRadius: 16))
      HStack(spacing: Metrics.sm) {
        Button("关闭") { dismiss() }
          .frame(maxWidth: .infinity, minHeight: 50)
          .background(palette.fill, in: Capsule())
          .foregroundStyle(palette.text)
        if let retry {
          Button("重试") {
            dismiss()
            retry()
          }
          .frame(maxWidth: .infinity, minHeight: 50)
          .background(palette.ink, in: Capsule())
          .foregroundStyle(palette.onInk)
        }
      }
      .font(.system(size: 16, weight: .semibold))
      .buttonStyle(PressStyle())
    }
    .padding(Metrics.md)
    .background(palette.surface)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
