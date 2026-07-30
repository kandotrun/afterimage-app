import XCTest

@MainActor
final class AIConnectionNavigationUITests: XCTestCase {
    func testAccountMenuOpensExplicitAIConsentSettings() {
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

        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["外部AI処理への同意"].exists)
        XCTAssertTrue(
            app.staticTexts[
                "Soniox：動画ファイル全体（映像・音声）を送信し、音声の文字起こしを生成"
            ].exists
        )
        XCTAssertTrue(
            app.buttons["説明に同意してAI処理を有効にする"].exists
        )
    }
}
