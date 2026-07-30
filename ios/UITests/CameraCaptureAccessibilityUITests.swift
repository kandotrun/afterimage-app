import XCTest

@MainActor
final class CameraCaptureAccessibilityUITests: XCTestCase {
    func testUnavailableCameraRemainsUsableAtAccessibilitySize() {
        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Permissions") { alert in
            for title in ["Allow", "Don’t Allow", "Don't Allow"] {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
        app.launchArguments = [
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
            "-afterimageApiBase", "http://127.0.0.1:9",
            "-afterimageDevSession", "qa-session",
        ]
        app.launch()

        XCTAssertTrue(app.navigationBars["Journal"].waitForExistence(timeout: 10))
        let sessionAlert = app.alerts["Something Went Wrong"]
        if sessionAlert.waitForExistence(timeout: 3) {
            sessionAlert.buttons["Close"].tap()
        }

        let addVideo = app.buttons["Add Videos"]
        XCTAssertTrue(addVideo.waitForExistence(timeout: 3))
        addVideo.tap()

        let recordInApp = app.buttons["Record in App"]
        XCTAssertTrue(recordInApp.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Choose Video from Library"].exists)
        recordInApp.tap()
        app.tap()

        let unavailable = app.staticTexts["No camera is available"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 10))
        let retry = app.buttons["cameraRetryButton"]
        XCTAssertTrue(retry.isHittable)
        let close = app.buttons["Close"]
        XCTAssertTrue(close.isHittable)

        retry.tap()
        XCTAssertTrue(unavailable.waitForExistence(timeout: 10))
        XCTAssertTrue(retry.isHittable)

        close.tap()
        XCTAssertTrue(app.navigationBars["Journal"].waitForExistence(timeout: 3))
    }
}
