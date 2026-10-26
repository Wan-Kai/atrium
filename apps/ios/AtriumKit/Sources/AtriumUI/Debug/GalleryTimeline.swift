#if DEBUG && os(iOS)
  import AtriumRender
  import SwiftUI
  import UIKit

  /// Compares List and LazyVStack using identical synthetic transcript rows and streaming updates.
  ///
  /// - Remark: Frame intervals are a simulator smoke measurement, not proof of main-thread task
  ///   duration. The benchmark reports its measured maximum and p95 instead of claiming device
  ///   performance. No real conversation data or network is involved.
  struct GalleryTimeline: View {
    /// Whether the comparison uses LazyVStack instead of List.
    let stack: Bool
    /// Rows supplied to both implementations.
    @State private var rows: [TimelineRow] = []
    /// Streaming revision.
    @State private var revision = 0
    /// The final measurement, exposed to XCUITest.
    @State private var result = "running"
    /// The frame callback owner.
    @State private var probe = GalleryFrameProbe()

    /// The timeline under test and a diagnostic text label.
    var body: some View {
      VStack(spacing: 0) {
        Text(result).font(.system(size: 10, design: .monospaced))
          .accessibilityIdentifier("timeline.benchmark")
          .padding(8)
        ConversationTimeline(rows: rows, revision: revision, compareStack: stack)
      }
      .task {
        let clock = ContinuousClock()
        let prepared = await Self.prepareRows()
        rows = prepared
        revision += 1
        do {
          try await clock.sleep(for: .milliseconds(300))
          probe.start()
          defer { probe.stop() }
          for tick in 0..<180 {
            try Task.checkCancellation()
            let text =
              "持续输出 · \(tick)\n" + String(repeating: "中文 reply with **emphasis** and code. ", count: tick / 6 + 1)
            let blocks = await Self.parse(text)
            rows[rows.count - 1] = TimelineRow(id: "999", user: "测试长会话", blocks: blocks)
            revision += 1
            try await clock.sleep(for: .seconds(1.0 / 60))
          }
          result = probe.summary(prefix: stack ? "stack" : "list")
        } catch {
          probe.stop()
        }
      }
      .onDisappear { probe.stop() }
    }

    /// Prepares a thousand rows away from the main actor.
    ///
    /// - Remark: Both containers get exactly the same variable-height Markdown fixture.
    /// - SideEffects: none
    /// - Returns: The rows.
    @concurrent
    private static func prepareRows() async -> [TimelineRow] {
      (0..<1000).map { index in
        TimelineRow(
          id: String(index), user: "第 \(index) 轮问题",
          blocks: StreamingMarkdown.parse(String(repeating: "这是一段回复 with **emphasis**。\n\n", count: index % 4 + 1)))
      }
    }

    /// Converts a streaming prefix on the concurrent executor.
    ///
    /// - Remark: The measurement must not include deliberate synchronous parser work on main.
    /// - SideEffects: none
    /// - Parameter text: The prefix.
    /// - Returns: Renderable blocks.
    @concurrent
    private static func parse(_ text: String) async -> [MarkdownBlock] { StreamingMarkdown.parse(text) }
  }

  /// Samples display-link intervals while the synthetic timeline streams.
  ///
  /// - Remark: Owns and invalidates its link explicitly; samples are ordinary values and do not
  ///   invalidate the SwiftUI tree every frame. CADisplayLink supplies the timestamps.
  private final class GalleryFrameProbe: NSObject {
    /// The active callback, if sampling.
    private var link: CADisplayLink?
    /// Last supplied timestamp.
    private var previous: Double?
    /// Milliseconds between callbacks.
    private var samples: [Double] = []

    /// Starts sampling.
    ///
    /// - Remark: Repeated starts first release the old callback.
    /// - SideEffects: Registers a display-link callback on the main run loop.
    func start() {
      stop()
      previous = nil
      samples = []
      let display = CADisplayLink(target: self, selector: #selector(tick(_:)))
      display.add(to: .main, forMode: .common)
      link = display
    }

    /// Ends sampling and releases the display link.
    ///
    /// - Remark: Called from the task's defer and onDisappear.
    /// - SideEffects: Invalidates and removes the callback.
    func stop() {
      link?.invalidate()
      link = nil
    }

    /// Records one supplied frame timestamp.
    ///
    /// - Remark: The first frame establishes the baseline.
    /// - SideEffects: Appends to the sample buffer.
    /// - Parameter display: The invoking display link.
    @objc private func tick(_ display: CADisplayLink) {
      if let previous { samples.append((display.timestamp - previous) * 1000) }
      previous = display.timestamp
    }

    /// Formats the measurement for XCUITest and screenshots.
    ///
    /// - Remark: A long interval may include simulator scheduling, not just rendering work.
    /// - SideEffects: none
    /// - Parameter prefix: The container name.
    /// - Returns: Count, p95, maximum and intervals exceeding 50ms.
    func summary(prefix: String) -> String {
      let sorted = samples.sorted()
      guard !sorted.isEmpty else { return "\(prefix) no frames" }
      let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
      return String(
        format: "%@ n=%d p95=%.2f max=%.2f over50=%d", prefix, sorted.count, p95, sorted.last ?? 0,
        sorted.filter { $0 > 50 }.count)
    }
  }
#endif
