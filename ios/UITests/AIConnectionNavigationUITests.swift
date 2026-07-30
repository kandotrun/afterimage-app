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
            "-afterimageDevAccountID", "qa-user",
        ]
        app.launch()

        XCTAssertTrue(app.navigationBars["記録"].waitForExistence(timeout: 10))

        let sessionAlert = app.alerts["うまくいきませんでした"]
        if sessionAlert.waitForExistence(timeout: 3) {
            sessionAlert.buttons["閉じる"].tap()
        }

        let accountMenu = app.buttons["アカウント"]
        XCTAssertTrue(accountMenu.waitForExistence(timeout: 3))
        accountMenu.tap()
        let settings = app.buttons["設定"]
        XCTAssertTrue(settings.waitForExistence(timeout: 3))
        settings.tap()

        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["AI処理への同意"].exists)
        XCTAssertTrue(
            app.buttons["説明に同意してAI処理を有効にする"].exists
        )
        XCTAssertFalse(app.staticTexts["送信先と送信データ"].exists)
        for provider in ["Soniox", "Alibaba Cloud Qwen", "MCP client / AIエージェント"] {
            XCTAssertFalse(
                app.staticTexts
                    .matching(NSPredicate(format: "label CONTAINS[c] %@", provider))
                    .firstMatch
                    .exists
            )
        }
    }
}
