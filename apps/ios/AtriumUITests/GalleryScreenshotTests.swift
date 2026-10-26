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
  private let sections = ["colors", "type", "glass", "status", "cats", "atoms", "rail", "markdown", "diff"]

  @MainActor
  func testOpensTheGallery() {
    let app = XCUIApplication()
    app.launchEnvironment["ATRIUM_GALLERY"] = "status"
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["gallery"].waitForExistence(timeout: 10))
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
