import SwiftUI

/// The block under a failed turn, or for pi that gave up after crashing.
///
/// - Remark: The paper redesign (design-language "手机端 · 对话页"): just a pale red ground (the
///   danger colour at 10% on the paper), the app's words in red with a warning sign, pi's own text
///   under them in mono (three lines at most), then "详情" and "重新运行". pi's text is never the
///   block's own words: those are the app's.
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

  /// The block.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Image(systemName: "exclamationmark.triangle").font(.system(size: 12.5, weight: .semibold))
        Text(text).font(.system(size: 13, weight: .semibold))
      }
      .foregroundStyle(palette.danger)
      if let detail, !detail.isEmpty {
        Text(detail).font(.system(size: 12, design: .monospaced)).lineSpacing(2).lineLimit(3)
          .foregroundStyle(palette.text2)
      }
      HStack(spacing: 16) {
        if let detail, !detail.isEmpty {
          Button("详情") { showing = true }.buttonStyle(.plain)
        }
        if let retry {
          Button("重新运行", action: retry).buttonStyle(.plain).accessibilityIdentifier("session.retry")
        }
      }
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(palette.text)
      .padding(.top, 4)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(EdgeInsets(top: 10, leading: 12, bottom: 12, trailing: 12))
    .background(palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12))
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
