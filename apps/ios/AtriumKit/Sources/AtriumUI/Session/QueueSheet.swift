import AtriumProtocol
import AtriumSync
import SwiftUI

/// The queue sheet: the steers pi holds, then the messages waiting for the run to end.
///
/// - Remark: The final prototype's queue sheet (SPEC-0005 "MP5 定的细节 · MP5b"): "插话 · 下一步前
///   送达" lists `control.steers` as "已交给 pi"; "排队" lists `control.queue` with its number, text,
///   time and images, "改成插话" and a delete key. Tapping a queued message's text edits it in place
///   ("取消 / 保存", `update_queued`), which the prototype left out. "清空" empties the queue; after
///   a stop a note says the queue is held, with "继续发送".
struct QueueSheet: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// The queued message being edited, and its text so far.
  @State private var editing: (id: String, text: String)?
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let control = sync.core.sessions[sessionId]?.control
    let queue = control?.queue ?? []
    let steers = control?.steers ?? []
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header(palette, empty: queue.isEmpty)
        if control?.paused != nil, !queue.isEmpty {
          HStack(spacing: Metrics.xs) {
            Text("停止后排队暂停了，不会自动发出").font(.system(size: 14)).foregroundStyle(palette.attnText)
            Spacer(minLength: 0)
            Button("继续发送") { sync.perform(.resumeQueue, in: sessionId) }
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundStyle(palette.onInk)
              .padding(.horizontal, 14)
              .frame(height: 34)
              .background(palette.ink, in: Capsule())
              .buttonStyle(PressStyle())
          }
          .padding(.leading, Metrics.md)
          .padding(.trailing, Metrics.xs)
          .padding(.vertical, Metrics.xs)
          .background(palette.attnSoft, in: RoundedRectangle(cornerRadius: 20))
          .padding(.horizontal, Metrics.md)
          .padding(.bottom, Metrics.xxs)
        }
        if !steers.isEmpty {
          sectionTitle("插话 · 下一步前送达", palette)
          ForEach(steers, id: \.id) { steer in
            HStack(alignment: .top, spacing: Metrics.sm) {
              Image(systemName: "arrow.turn.down.right").font(.system(size: 14)).foregroundStyle(palette.tint)
                .padding(.top, 3)
              VStack(alignment: .leading, spacing: 2) {
                Text(steer.text).font(.system(size: 16)).foregroundStyle(palette.text)
                Text("已交给 pi").font(.system(size: 13)).foregroundStyle(palette.secondary)
              }
            }
            .padding(.horizontal, Metrics.lg)
            .padding(.vertical, 10)
          }
        }
        if !queue.isEmpty {
          HStack {
            sectionTitle("排队", palette)
            Spacer()
            Text("\(queue.count) 条").font(.system(size: 13.5)).foregroundStyle(palette.secondary)
              .padding(.trailing, Metrics.lg).padding(.top, 22)
          }
          ForEach(Array(queue.enumerated()), id: \.element.id) { number, item in
            row(item, number: number + 1, palette: palette)
          }
        } else if steers.isEmpty {
          Text("没有排队的消息").font(.system(size: 14)).foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity).padding(.top, Metrics.xl)
        }
        Text("插话在当前这批工具调用做完、下一次请求模型前送到，不是立刻打断；要立刻停下用停止。")
          .font(.system(size: 13))
          .foregroundStyle(palette.secondary)
          .padding(.horizontal, Metrics.lg)
          .padding(.vertical, Metrics.md)
      }
    }
    .background(palette.surface)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .animation(MotionToken.smooth.resolved(reduceMotion: false).animation, value: queue.map(\.id))
  }

  /// The sheet's header: close, the title, and "清空".
  ///
  /// - Remark: As the prototype's sheets.
  /// - SideEffects: none
  /// - Parameters:
  ///   - palette: The colours.
  ///   - empty: Whether the queue is empty, so "清空" has nothing to do.
  /// - Returns: The header.
  private func header(_ palette: Palette, empty: Bool) -> some View {
    HStack(alignment: .top) {
      Button {
        dismiss()
      } label: {
        Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text2)
          .frame(width: 36, height: 36).background(palette.fill, in: Circle())
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel("关闭")
      Spacer()
      VStack(spacing: 2) {
        Text("排队").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
        Text("运行结束后依次发送").font(.system(size: 12.5)).foregroundStyle(palette.secondary)
      }
      Spacer()
      Button("清空") { sync.perform(.clearQueue, in: sessionId) }
        .font(.system(size: 15))
        .foregroundStyle(empty ? palette.tertiary : palette.danger)
        .disabled(empty)
        .frame(width: 44, height: 36)
        .buttonStyle(.plain)
    }
    .padding(.horizontal, Metrics.md)
    .padding(.top, Metrics.md)
  }

  /// A section's small title.
  ///
  /// - Remark: 13.5pt, secondary.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The title.
  ///   - palette: The colours.
  /// - Returns: The title.
  private func sectionTitle(_ text: String, _ palette: Palette) -> some View {
    Text(text).font(.system(size: 13.5)).foregroundStyle(palette.secondary)
      .padding(.horizontal, Metrics.lg).padding(.top, 22).padding(.bottom, 6)
  }

  /// One queued message: its number, text, time and images, and what can be done with it.
  ///
  /// - Remark: Tapping the text edits it in place.
  /// - SideEffects: none
  /// - Parameters:
  ///   - item: The message.
  ///   - number: Its place in the queue, from 1.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func row(_ item: QueuedPrompt, number: Int, palette: Palette) -> some View {
    HStack(alignment: .top, spacing: Metrics.sm) {
      Text("\(number)").font(.system(size: 14, weight: .semibold)).foregroundStyle(palette.secondary)
        .monospacedDigit().padding(.top, 2)
      VStack(alignment: .leading, spacing: 4) {
        if let editing, editing.id == item.id {
          TextField(
            "", text: Binding(get: { editing.text }, set: { self.editing = (item.id, $0) }), axis: .vertical
          )
          .font(.system(size: 16))
          .lineLimit(1...6)
          .padding(Metrics.xs)
          .background(palette.page, in: RoundedRectangle(cornerRadius: 12))
          HStack(spacing: Metrics.md) {
            Button("取消") { self.editing = nil }.foregroundStyle(palette.secondary)
            Button("保存") {
              sync.perform(.updateQueued(item.id, editing.text), in: sessionId)
              self.editing = nil
            }
            .fontWeight(.semibold)
            .foregroundStyle(palette.tint)
            .disabled(editing.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && item.images == 0)
          }
          .font(.system(size: 14))
          .buttonStyle(.plain)
        } else {
          Text(item.text.isEmpty ? "（只有图片）" : item.text).font(.system(size: 16)).foregroundStyle(palette.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { editing = (item.id, item.text) }
          Text(item.images > 0 ? "带 \(item.images) 张图" : "排队中").font(.system(size: 13))
            .foregroundStyle(palette.secondary)
        }
      }
      if editing?.id != item.id {
        Button("改成插话") { sync.perform(.steerQueued(item.id), in: sessionId) }
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(palette.text2)
          .padding(.horizontal, Metrics.sm)
          .frame(height: 32)
          .background(palette.fill, in: Capsule())
          .buttonStyle(PressStyle())
        Button {
          sync.perform(.removeQueued(item.id), in: sessionId)
        } label: {
          Image(systemName: "trash").font(.system(size: 16)).foregroundStyle(palette.danger).frame(
            width: 32, height: 32)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("删除")
      }
    }
    .padding(.horizontal, Metrics.sm)
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .padding(.horizontal, Metrics.sm)
    .transition(.opacity)
  }
}
