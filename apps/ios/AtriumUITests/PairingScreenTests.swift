import XCTest

/// Checks explicit paste validation and the simulator's camera fallback in the actual app.
///
/// - Remark: Real QR capture and permission prompts still need a physical device. Appearance is set
///   by the simulator harness, not an ineffective AppleInterfaceStyle launch argument.
final class PairingScreenTests: XCTestCase {
  @MainActor
  func testPasteValidationAndCameraFallback() {
    let app = XCUIApplication()
    app.launch()
    let open = app.buttons["pairing.open"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()
    let submit = app.buttons["pairing.submit"]
    XCTAssertTrue(submit.waitForExistence(timeout: 5))
    XCTAssertFalse(submit.isEnabled)
    let entry = XCTAttachment(screenshot: app.screenshot())
    entry.name = "pairing-entry"
    entry.lifetime = .keepAlways
    add(entry)

    app.buttons["pairing.scan"].tap()
    XCTAssertTrue(app.staticTexts["pairing.cameraUnavailable"].waitForExistence(timeout: 10))
    let field = app.descendants(matching: .any)["pairing.link"].firstMatch
    XCTAssertTrue(field.exists)
    field.tap()
    field.typeText("not-a-pairing-link")
    XCTAssertTrue(submit.isEnabled)
    submit.tap()
    let error = app.staticTexts["pairing.invalid"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertTrue(error.isHittable)
    let invalid = XCTAttachment(screenshot: app.screenshot())
    invalid.name = "pairing-invalid"
    invalid.lifetime = .keepAlways
    add(invalid)
  }
}
