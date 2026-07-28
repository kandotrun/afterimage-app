import XCTest

@MainActor
final class AgentVideoSharingUITests: XCTestCase {
    func testVideoSharingDefaultsOnCanBeDisabledAndIsHiddenForPhotos() throws {
        guard let tokenPath = ProcessInfo.processInfo.environment["AFTERIMAGE_UI_TEST_TOKEN_FILE"] else {
            throw XCTSkip("AFTERIMAGE_UI_TEST_TOKEN_FILE is required")
        }
        let token = try String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(ja)",
            "-AppleLocale", "ja_JP",
            "-afterimageApiBase", "http://127.0.0.1:8787",
            "-afterimageDevSession", token,
            "-afterimageOpenFirst",
        ]
        app.launch()

        let moreButton = app.buttons["その他"]
        XCTAssertTrue(moreButton.waitForExistence(timeout: 15))
        moreButton.tap()

        let shareButton = app.buttons["AIエージェントに共有"]
        XCTAssertTrue(shareButton.waitForExistence(timeout: 5))
        XCTAssertEqual(shareButton.value as? String, "オン")
        addScreenshot(app, name: "video-agent-sharing-on")

        shareButton.tap()
        XCTAssertFalse(shareButton.waitForExistence(timeout: 2))
        moreButton.tap()

        let unsharedButton = app.buttons["AIエージェントに共有"]
        XCTAssertTrue(unsharedButton.waitForExistence(timeout: 5))
        XCTAssertEqual(unsharedButton.value as? String, "オフ")
        addScreenshot(app, name: "video-agent-sharing-off")

        unsharedButton.tap()
        XCTAssertFalse(unsharedButton.waitForExistence(timeout: 2))
        app.swipeLeft()
        moreButton.tap()

        XCTAssertFalse(app.buttons["AIエージェントに共有"].exists)
        addScreenshot(app, name: "photo-agent-sharing-hidden")
    }

    private func addScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
