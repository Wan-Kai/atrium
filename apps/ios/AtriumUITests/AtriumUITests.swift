import XCTest

/// Launches the app in the simulator and checks what a person would see first.
///
/// - Remark: Swift Testing cannot drive the interface yet, so UI tests use XCUITest
///   (testing.md "Swift（手机端）").
final class AtriumUITests: XCTestCase {
  @MainActor
  func testShowsTheHomeScreenTitle() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["home.title"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["home.title"].label, "Atrium")
  }
}
