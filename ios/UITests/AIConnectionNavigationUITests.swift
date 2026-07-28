import XCTest

@MainActor
final class AIConnectionNavigationUITests: XCTestCase {
    func testAccountMenuOpensAIConnection() {
        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Location Permission") { alert in
            for title in ["許可しない", "Don’t Allow", "Don't Allow"] {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
        app.launchArguments = [
            "-AppleLanguages", "(ja)",
            "-AppleLocale", "ja_JP",
            "-afterimageApiBase", "http://127.0.0.1:9",
            "-afterimageDevSession", "qa-session",
        ]
        app.launch()

        XCTAssertTrue(app.navigationBars["記録"].waitForExistence(timeout: 10))

        let sessionAlert = app.alerts["うまくいきませんでした"]
        if sessionAlert.waitForExistence(timeout: 3) {
            sessionAlert.buttons["閉じる"].tap()
        }

        app.buttons["アカウント"].tap()

        let aiConnection = app.buttons["AI連携"]
        guard aiConnection.waitForExistence(timeout: 3) else {
            XCTFail("AI連携メニューが表示されません")
            return
        }
        aiConnection.tap()

        XCTAssertTrue(app.navigationBars["AI連携"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["MCPサーバー"].exists)
    }
}
