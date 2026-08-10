
extension KoyomiUITests {
    func testPhysicalWidgetShowsMigratedPin() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(
            app.descendants(matching: .any)["pinned-section"].waitForExistence(timeout: 10),
            "The installed app should load its pinned events"
        )

        let unpinSuffix = "のピン留めを解除"
        let expectedTitles = app.buttons
            .matching(NSPredicate(format: "label ENDSWITH %@", unpinSuffix))
            .allElementsBoundByIndex
            .map(\.label)
            .filter { $0.hasSuffix(unpinSuffix) }
            .map { String($0.dropLast(unpinSuffix.count)) }
        XCTAssertFalse(expectedTitles.isEmpty, "At least one migrated pin is required for Widget verification")

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(
            moveToHome(app: app, springboard: springboard),
            "Koyomi should leave the foreground before Widget verification"
        )

        let deadline = Date().addingTimeInterval(20)
        var displayedTitle: String?
        repeat {
            if app.state == .runningForeground,
               !moveToHome(app: app, springboard: springboard) {
                break
            }
            displayedTitle = expectedTitles.first { title in
                springboard.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS %@", title))
                    .firstMatch
                    .exists
            }
            if displayedTitle == nil {
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            }
        } while displayedTitle == nil && Date() < deadline

        let attachment = XCTAttachment(screenshot: springboard.screenshot())
        attachment.name = "Physical Koyomi Widget"
        attachment.lifetime = .keepAlways
        add(attachment)

        XCTAssertNotNil(displayedTitle, "The Home Screen Widget should display a pin loaded from shared Keychain")
        XCTAssertFalse(
            springboard.staticTexts["予定をピン留め"].exists,
            "The Widget should not remain in its empty state"
        )
    }

    private func moveToHome(app: XCUIApplication, springboard: XCUIApplication) -> Bool {
        for _ in 0..<4 {
            XCUIDevice.shared.press(.home)
            RunLoop.current.run(until: Date().addingTimeInterval(1))
            if app.state != .runningForeground { return true }

            springboard.activate()
            RunLoop.current.run(until: Date().addingTimeInterval(1))
            if app.state != .runningForeground { return true }
        }
        return false
    }
}
