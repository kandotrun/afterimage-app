import XCTest

@MainActor
final class AgentVideoSharingUITests: XCTestCase {
    func testVideoSharingDefaultsOnCanBeDisabledAndIsHiddenForPhotos() throws {
        guard let token = ProcessInfo.processInfo.environment["AFTERIMAGE_UI_TEST_TOKEN"] else {
            throw XCTSkip("AFTERIMAGE_UI_TEST_TOKEN is required")
        }
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(ja)",
            "-AppleLocale", "ja_JP",
            "-afterimageApiBase", "http://127.0.0.1:8787",
            "-afterimageDevSession", token,
            "-afterimageOpenFirst",
        ]
        app.launch()

        let moreButton = app.descendants(matching: .any)
            .matching(identifier: "その他")
            .firstMatch
        XCTAssertTrue(moreButton.waitForExistence(timeout: 15))
        moreButton.tap()
        addScreenshot(name: "video-agent-sharing-on")

        let shareCoordinate = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.67, dy: 0.16)
        )
        shareCoordinate.tap()
        Thread.sleep(forTimeInterval: 1)
        moreButton.tap()
        addScreenshot(name: "video-agent-sharing-off")

        shareCoordinate.tap()
        Thread.sleep(forTimeInterval: 1)
        app.swipeLeft()
        moreButton.tap()

        addScreenshot(name: "photo-agent-sharing-hidden")
    }

    private func addScreenshot(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
