#if DEBUG
  import SwiftUI

  /// The gallery's process rail samples: a finished turn, open; the same folded; one still running,
  /// with a button that adds a step so the entrance can be watched.
  ///
  /// - Remark: See `DesignGallery`.
  struct GalleryRail: View {
    /// Whether the finished turn is open.
    @State private var open = true
    /// Whether the second copy is open.
    @State private var folded = false
    /// Whether the running turn is open.
    @State private var runningOpen = true
    /// How many steps were added to the running turn.
    @State private var added = 0
    /// Light or dark.
    @Environment(\.colorScheme) private var scheme

    /// The samples.
    var body: some View {
      let finished = RailRows.layout(SampleTurns.finished)
      let summary = RailRows.summary(SampleTurns.finished)
      VStack(alignment: .leading, spacing: Metrics.lg) {
        ProcessRailView(
          rows: finished.rows, running: false, duration: "48 秒", summary: summary, expanded: $open)
        ProcessRailView(
          rows: finished.rows, running: false, duration: "48 秒", summary: summary, expanded: $folded)
        ProcessRailView(
          rows: runningRows, running: true, duration: "1:12", summary: [], expanded: $runningOpen)
        Button("加一步") { added += 1 }
          .buttonStyle(PressStyle())
          .font(Typography.meta)
          .foregroundStyle(Palette(scheme: scheme).tint)
      }
    }

    /// The running turn's rows, with any added steps.
    private var runningRows: [RailRow] {
      var rows = RailRows.layout(SampleTurns.running).rows
      if added > 0, let last = rows.indices.last {
        rows[last] = RailRow(
          id: rows[last].id, node: .dot, verb: "运行了", object: "pnpm test cache", objectIsCode: true, end: "通过")
        for index in 0..<added {
          let isLast = index == added - 1
          rows.append(
            RailRow(
              id: "added-\(index)", node: isLast ? .live : .dot, verb: isLast ? "正在编辑" : "编辑了",
              object: "src/cache/\(index).ts"))
        }
      }
      return rows
    }
  }
#endif
