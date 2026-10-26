import XCTest

/// Drives the production keychain check in the App rather than the unentitled XCUITest runner.
///
/// - Remark: Only reads a non-secret result; the fixed check and its namespace do not exist in Release.
final class PairingKeychainTests: XCTestCase {
  @MainActor
  func testProductionKeychainRoundTripAndProtection() {
    let app = XCUIApplication()
    app.launchEnvironment["ATRIUM_PAIRING_KEYCHAIN_CHECK"] = "1"
    app.launch()
    let result = app.staticTexts["pairing.keychain.result"]
    XCTAssertTrue(result.waitForExistence(timeout: 10))
    let finished = NSPredicate(format: "label != %@", "running")
    expectation(for: finished, evaluatedWith: result)
    waitForExpectations(timeout: 10)
    XCTAssertEqual(result.label, "passed")
  }
}
