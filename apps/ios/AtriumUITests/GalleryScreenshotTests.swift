import XCTest

/// Opens the design gallery in the simulator and, on request, keeps a screenshot of every section.
///
/// - Remark: The gallery opens when the app is launched with `ATRIUM_GALLERY` (Debug builds only,
///   see `DesignGallery`). Passing it per launch here, rather than through `SIMCTL_CHILD_` on
///   `pnpm ios:shot`, matters: when that command boots the simulator, the variable stays in the
///   simulator's launchd and every later launch of the app would open the gallery. Screenshots are
///   taken only with `TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios`, so the normal run stays
///   short; they land in the result bundle under `apps/ios/.build/xcode/Logs/Test/` and come out
///   with `xcrun xcresulttool export attachments`.
final class GalleryScreenshotTests: XCTestCase {
  /// The gallery's sections, as `DesignGallery.sections` names them.
  private let sections = [
    "colors", "type", "glass", "status", "cats", "atoms", "rail", "markdown", "diff",
    "glass-solid", "status-reduced", "cats-reduced", "rail-reduced",
  ]

  @MainActor
  func testOpensTheGallery() {
    let app = XCUIApplication()
    app.launchEnvironment["ATRIUM_GALLERY"] = "status"
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["gallery"].waitForExistence(timeout: 10))
  }

  @MainActor
  func testTimelineUpdatesAndPreservesHistory() throws {
    let app = XCUIApplication()
    app.launchEnvironment["ATRIUM_GALLERY"] = "timeline-check"
    app.launch()
    XCTAssertTrue(app.staticTexts["回复 39"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["回复 39"].isHittable)
    app.buttons["timeline.update"].tap()
    XCTAssertTrue(app.staticTexts["尾行已更新"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["尾行已更新"].isHittable, "same-row height growth must keep the response end visible")
    app.buttons["timeline.append"].tap()
    XCTAssertTrue(app.staticTexts["新回复 40"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["新回复 40"].isHittable)
    app.swipeDown()
    let back = app.buttons["回到底部"]
    XCTAssertTrue(back.waitForExistence(timeout: 10))
    let history = try XCTUnwrap(
      app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "新增内容 "))
        .allElementsBoundByIndex.first { $0.isHittable })
    let historyY = history.frame.minY
    app.buttons["timeline.append"].tap()
    let unseen = app.buttons["有新内容，回到底部"]
    XCTAssertTrue(unseen.waitForExistence(timeout: 10))
    XCTAssertTrue(history.isHittable, "appending must not pull the reader away from history")
    XCTAssertEqual(history.frame.minY, historyY, accuracy: 2)
    XCTAssertFalse(app.staticTexts["新回复 41"].isHittable)
    unseen.tap()
    XCTAssertTrue(app.staticTexts["新回复 41"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["新回复 41"].isHittable)
  }

  @MainActor
  func testTimelineComparison() async throws {
    guard
      ProcessInfo.processInfo.environment["ATRIUM_GALLERY_SHOTS"] == "1"
        || ProcessInfo.processInfo.environment["ATRIUM_TIMELINE_BENCH"] == "1"
    else {
      throw XCTSkip("set TEST_RUNNER_ATRIUM_TIMELINE_BENCH=1 for the focused simulator measurement")
    }
    for mode in ["list", "stack", "control"] {
      for trial in 1...(mode == "control" ? 1 : 3) {
        let app = XCUIApplication()
        app.launchEnvironment["ATRIUM_GALLERY"] = "timeline-\(mode)"
        app.launch()
        let result = app.staticTexts["timeline.benchmark"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        // A label predicate repeatedly snapshots the accessibility tree while the timeline runs.
        // Leave the app unobserved during the measured interval; query only after it has finished.
        let measurementClock = ContinuousClock()
        try await measurementClock.sleep(for: .seconds(15))
        XCTAssertTrue(result.label.hasPrefix(mode), "the bounded measurement must have finished")
        XCTAssertTrue(result.label.contains("p95="))
        if mode == "control" {
          let field = result.label.split(separator: " ").first { $0.hasPrefix("awakeMax=") }
          let maximum = field.flatMap { Double($0.dropFirst("awakeMax=".count)) } ?? 0
          XCTAssertGreaterThanOrEqual(
            maximum, 75, "the probe must detect the intentionally injected 80ms main-thread stall")
        }
        XCTAssertTrue(app.staticTexts["测试长会话"].exists, "initial placement and following must reach the tail")
        let measurement = XCTAttachment(string: result.label)
        measurement.name = "timeline-\(mode)-\(trial)"
        measurement.lifetime = .keepAlways
        add(measurement)
        print("TIMELINE \(trial): \(result.label)")
        app.terminate()
      }
    }
  }

  @MainActor
  func testKeepsAScreenshotOfEverySection() throws {
    guard ProcessInfo.processInfo.environment["ATRIUM_GALLERY_SHOTS"] == "1" else {
      throw XCTSkip("set TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 to take the gallery's screenshots")
    }
    for appearance in [XCUIDevice.Appearance.light, .dark] {
      XCUIDevice.shared.appearance = appearance
      for section in sections {
        let app = XCUIApplication()
        app.launchEnvironment["ATRIUM_GALLERY"] = section
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["gallery"].waitForExistence(timeout: 10))
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(section)-\(appearance == .dark ? "dark" : "light")"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
      }
    }
    XCUIDevice.shared.appearance = .light
  }
}
