import AtriumRender
import SwiftUI

/// Paces a growing reply and asks its worker to parse only the visible prefix.
///
/// - Remark: SwiftUI owns cancellation of the frame loop through `.task(id:)`; switching a reply
///   or receiving a newer snapshot stops the old loop, which cannot publish stale results. Initial
///   history paints whole. Time is an injected clock; no per-view wall-clock epoch is needed.
struct StreamingReplyView<C: Clock>: View where C.Duration == Duration {
  /// Full source received so far.
  let source: String
  /// Whether the model is still producing it.
  let streaming: Bool
  /// The frame clock, injected by the screen.
  let clock: C
  /// Last published frame on the same injected clock, retained when a snapshot replaces the task.
  @State private var lastFrame: C.Instant?
  /// Visible source progress, retained across incremental tasks.
  @State private var reveal: TextReveal?
  /// Converted visible blocks.
  @State private var blocks: [MarkdownBlock] = []
  /// The finished text `blocks` show whole, so showing it again does not parse and redraw it.
  @State private var whole: String?
  /// This view's cache-owning worker.
  @State private var worker = MarkdownWorker()
  /// Whether animations should be reduced.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// Shows a reply, whole at once when it was parsed ahead.
  ///
  /// - Remark: A finished reply in `MarkdownCache` starts with its blocks, so it has its full
  ///   height from the first frame, and is not parsed again; any other starts empty and fills in
  ///   from its worker. A reply scrolled off and back is a new view, so without this every return
  ///   drew it twice and, on a miss, grew it from nothing (2026-10-30, felt as jank on the phone).
  /// - SideEffects: none
  /// - Parameters:
  ///   - source: The text so far.
  ///   - streaming: Whether it is still coming.
  ///   - clock: The frame clock.
  init(source: String, streaming: Bool, clock: C) {
    self.source = source
    self.streaming = streaming
    self.clock = clock
    let cached = streaming ? nil : MarkdownCache.shared.blocks(for: source)
    _blocks = State(initialValue: cached ?? [])
    _whole = State(initialValue: cached == nil ? nil : source)
  }

  /// The rendered prefix.
  var body: some View {
    MarkdownView(blocks: blocks)
      .task(id: Request(source: source, streaming: streaming, reduced: reduceMotion)) {
        if !streaming {
          if whole == source { return }
          if let cached = MarkdownCache.shared.blocks(for: source) {
            blocks = cached
            whole = source
            return
          }
        }
        var progress = reveal ?? TextReveal(source)
        progress.retarget(source)
        if !streaming || reduceMotion { progress = TextReveal(source) }
        do {
          repeat {
            if !progress.isSettled, let lastFrame {
              let next = lastFrame.advanced(by: .seconds(1.0 / 60))
              try await clock.sleep(until: next, tolerance: .zero)
              let elapsed = lastFrame.duration(to: clock.now).components
              progress.advance(by: Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18)
            }
            let parsed = try await worker.parse(progress.visible(streaming: streaming), complete: !streaming)
            try Task.checkCancellation()
            blocks = parsed
            reveal = progress
            lastFrame = clock.now
            if progress.isSettled {
              if !streaming {
                MarkdownCache.shared.store(parsed, for: source)
                whole = source
              }
              break
            }
          } while true
        } catch is CancellationError {
          // The next task owns the newer target; the last published prefix stays visible.
        } catch {
          // The worker currently throws only cancellation; preserve source if that contract grows.
          blocks = [.paragraph(AttributedString(source))]
        }
      }
  }

  /// Values that restart one structured reveal task.
  ///
  /// - Remark: The mode may change with identical text when a run finishes or accessibility changes.
  private struct Request: Equatable {
    let source: String
    let streaming: Bool
    let reduced: Bool
  }
}
