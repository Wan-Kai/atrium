#if DEBUG && os(iOS)
  import AtriumRender
  import CoreFoundation
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
    /// Injects one known main-thread stall to prove the awake-interval probe can detect it.
    var stallControl = false
    /// Rows supplied to both implementations.
    @State private var rows: [TimelineRow] = []
    /// Streaming revision.
    @State private var revision = 0
    /// The final measurement, exposed to XCUITest.
    @State private var result = "running"
    /// The frame callback owner.
    @State private var probe = GalleryFrameProbe(clock: ContinuousClock())

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
            if stallControl && tick == 60 { Self.injectStall(clock: clock) }
            let text =
              "持续输出 · \(tick)\n" + String(repeating: "中文 reply with **emphasis** and code. ", count: tick / 6 + 1)
            let blocks = await Self.parse(text)
            rows[rows.count - 1] = TimelineRow(id: "999", user: "测试长会话", blocks: blocks)
            revision += 1
            try await clock.sleep(for: .seconds(1.0 / 60))
          }
          result = probe.summary(prefix: stallControl ? "control" : stack ? "stack" : "list")
        } catch {
          probe.stop()
        }
      }
      .onDisappear { probe.stop() }
    }

    /// Inserts a known 80ms busy interval into the control run.
    ///
    /// - Remark: Negative control for the measurement, never enabled in the normal fixture or Release.
    /// - SideEffects: Deliberately blocks the main actor for 80ms.
    /// - Parameter clock: Monotonic measurement clock.
    private static func injectStall(clock: ContinuousClock) {
      let end = clock.now.advanced(by: .milliseconds(80))
      while clock.now < end {}
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
  final class GalleryFrameProbe: NSObject {
    /// The injected monotonic clock for main-runloop interval measurements.
    private let clock: ContinuousClock
    /// Observer owned by this probe, registered only on the main runloop.
    private var observer: CFRunLoopObserver?
    /// Start of the current main-runloop awake interval.
    private var activeSince: ContinuousClock.Instant?
    /// Main-runloop awake intervals, not individual task durations.
    private var activeSamples: [Double] = []
    /// First display timestamp, for locating the worst frame within the experiment.
    private var firstFrame: Double?
    /// Time of the longest frame gap, relative to the first frame.
    private var peakAt = 0.0
    /// Longest observed frame gap.
    private var peak = 0.0

    /// Creates a probe with a monotonic clock.
    ///
    /// - Remark: The timeline supplies the real clock; measuring work must not use wall time.
    /// - SideEffects: none
    /// - Parameter clock: Clock used to measure awake intervals.
    init(clock: ContinuousClock) {
      self.clock = clock
      super.init()
    }

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
      firstFrame = nil
      peakAt = 0
      peak = 0
      samples = []
      activeSamples = []
      activeSince = clock.now
      GalleryTimelineStats.reset()
      let activities = CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue
      observer = CFRunLoopObserverCreateWithHandler(nil, activities, true, Int.max) { [weak self] _, activity in
        // This observer is registered exclusively on CFRunLoopGetMain().
        MainActor.assumeIsolated { self?.observe(activity) }
      }
      if let observer { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
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
      if let observer { CFRunLoopObserverInvalidate(observer) }
      observer = nil
      activeSince = nil
    }

    /// Measures awake intervals around the main runloop's wait boundary.
    ///
    /// - Remark: These include multiple callbacks and framework work, and can include scheduler
    ///   preemption; they are not CPU samples or a claim about any individual main-thread task.
    /// - SideEffects: Updates interval samples.
    /// - Parameter activity: Main-runloop observer activity.
    private func observe(_ activity: CFRunLoopActivity) {
      if activity == .afterWaiting {
        activeSince = clock.now
      } else if activity == .beforeWaiting, let activeSince {
        let duration = activeSince.duration(to: clock.now).components
        activeSamples.append(Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15)
        self.activeSince = nil
      }
    }

    /// Records one supplied frame timestamp.
    ///
    /// - Remark: The first frame establishes the baseline.
    /// - SideEffects: Appends to the sample buffer.
    /// - Parameter display: The invoking display link.
    @objc private func tick(_ display: CADisplayLink) {
      if firstFrame == nil { firstFrame = display.timestamp }
      if let previous {
        let gap = (display.timestamp - previous) * 1000
        samples.append(gap)
        if gap > peak {
          peak = gap
          peakAt = display.timestamp - (firstFrame ?? display.timestamp)
        }
      }
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
        format:
          "%@ n=%d p95=%.2f max=%.2f over25=%d over50=%d maxAt=%.3f awakeMax=%.2f awakeOver16=%d awakeOver50=%d "
          + "rows=%d builds=%d turns=%d blocks=%d",
        prefix, sorted.count, p95, sorted.last ?? 0, sorted.filter { $0 > 25 }.count, sorted.filter { $0 > 50 }.count,
        peakAt, activeSamples.max() ?? 0, activeSamples.filter { $0 > 16.7 }.count,
        activeSamples.filter { $0 > 50 }.count, GalleryTimelineStats.rowBodies, GalleryTimelineStats.rowBuilds,
        GalleryTimelineStats.turnBodies, GalleryTimelineStats.blockBodies)
    }
  }
#endif
