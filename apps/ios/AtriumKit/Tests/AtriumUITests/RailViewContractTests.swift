import Foundation
import Testing

/// Source-level guards for SwiftUI wiring not exposed to Swift Testing on macOS.
///
/// - Remark: These guard motion and disclosure wiring only, not rendered geometry or animation frames.
@Suite("Process rail view contracts")
struct RailViewContractTests {
  /// Forbids spatial fold/chevron/transition animation with Reduce Motion.
  ///
  /// - Remark: Opacity can animate; height, rotation and scale cannot.
  /// - SideEffects: Reads the checked-in view sources.
  @Test("Reduce Motion removes spatial animations")
  func reducedMotion() throws {
    let rail = try source("ProcessRailView.swift")
    let node = try source("RailNodeView.swift")
    #expect(rail.contains("reduceMotion ? nil : Motion.fold(reduceMotion: false).animation"))
    #expect(rail.contains("reduceMotion ? nil : MotionToken.snappy.resolved(reduceMotion: false).animation"))
    #expect(node.contains("reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity)"))
  }

  /// Ensures ongoing animation is derived from a timeline instead of a one-time appearance flag.
  ///
  /// - Remark: Turning Reduce Motion off after mounting must resume all three effects.
  /// - SideEffects: Reads the checked-in view sources.
  @Test("continuous effects resume after Reduce Motion changes")
  func continuousEffects() throws {
    let rail = try source("ProcessRailView.swift")
    let node = try source("RailNodeView.swift")
    #expect(!rail.contains("@State private var sweeping"))
    #expect(!node.contains("@State private var turning"))
    #expect(!node.contains("@State private var spreading"))
    #expect(rail.contains("TimelineView(.animation(paused: still))"))
    #expect(node.components(separatedBy: "TimelineView(.animation(paused: still))").count == 3)
  }

  /// Guards the separate non-collapsing steer container and waiting header.
  ///
  /// - Remark: Actual layout and orange appearance still need a simulator check.
  /// - SideEffects: Reads the checked-in view sources.
  @Test("folded steers survive and questions replace the running header")
  func retainedContent() throws {
    let rail = try source("ProcessRailView.swift")
    #expect(rail.contains("if !expanded {"))
    #expect(rail.contains("rows.filter { $0.node == .steer }"))
    #expect(rail.contains("running && rows.contains { $0.node == .asking }"))
    #expect(rail.contains("Image(systemName: \"questionmark.circle\")"))
    #expect(rail.contains("Text(\"等你回答\")"))
    let row = try source("RailRowView.swift")
    #expect(row.contains("if let detail = row.detail"))
    #expect(row.contains("ForEach(Array(row.answers.enumerated())"))
    #expect(row.contains("Text(verbatim: detail)"))
  }

  /// Reads one rail source relative to this test's package.
  ///
  /// - Remark: No absolute workstation path is embedded in the guard.
  /// - SideEffects: Reads a source file.
  private func source(_ name: String) throws -> String {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    return try String(
      contentsOf: package.appendingPathComponent("Sources/AtriumUI/ProcessRail/\(name)"), encoding: .utf8)
  }
}
