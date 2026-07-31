import Foundation
import XCTest

@MainActor
final class AgentVideoSharingUITests: XCTestCase {
    private struct TimelinePage: Decodable {
        struct Item: Decodable {
            let kind: String
            let agentAccessEnabled: Bool
        }

        let items: [Item]
    }

    func testVideoSharingDefaultsOffBeforeConsentThenCanBeRevokedPerVideo() async throws {
        guard let token = ProcessInfo.processInfo.environment["AFTERIMAGE_UI_TEST_TOKEN"] else {
            throw XCTSkip("AFTERIMAGE_UI_TEST_TOKEN is required")
        }
        try await updateAIConsent(false, token: token)
        let initialItems = try await timeline(token: token).items
        XCTAssertFalse(initialItems.filter { $0.kind == "video" }.isEmpty)
        XCTAssertTrue(
            initialItems
                .filter { $0.kind == "video" }
                .allSatisfy { !$0.agentAccessEnabled }
        )
        try await updateAIConsent(true, token: token)

        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(ja)",
            "-AppleLocale", "ja_JP",
            "-afterimageApiBase", "http://127.0.0.1:8787",
            "-afterimageDevSession", token,
            "-afterimageOpenFirst",
        ]
        app.launch()

        let videoIndex = try XCTUnwrap(initialItems.firstIndex { $0.kind == "video" })
        for _ in 0..<videoIndex {
            app.swipeLeft()
        }
        try await waitForVideoAgentAccess(true, token: token)
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
        try await waitForVideoAgentAccess(false, token: token)
        revealChromeIfNeeded(app: app, moreButton: moreButton)
        moreButton.tap()
        addScreenshot(name: "video-agent-sharing-off")

        shareCoordinate.tap()
        try await waitForVideoAgentAccess(true, token: token)
        app.swipeLeft()
        revealChromeIfNeeded(app: app, moreButton: moreButton)
        moreButton.tap()

        addScreenshot(name: "photo-agent-sharing-hidden")
        let items = try await timeline(token: token).items
        XCTAssertTrue(items.contains { $0.kind == "photo" })
        XCTAssertTrue(
            items
                .filter { $0.kind == "video" }
                .allSatisfy { $0.agentAccessEnabled }
        )
    }

    private func revealChromeIfNeeded(app: XCUIApplication, moreButton: XCUIElement) {
        if !moreButton.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        XCTAssertTrue(moreButton.waitForExistence(timeout: 5))
    }

    private func waitForVideoAgentAccess(_ enabled: Bool, token: String) async throws {
        for _ in 0..<50 {
            let videos = try await timeline(token: token).items.filter { $0.kind == "video" }
            if !videos.isEmpty && videos.allSatisfy({ $0.agentAccessEnabled == enabled }) {
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Video agent access did not become \(enabled)")
    }

    private func timeline(token: String) async throws -> TimelinePage {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8787/v1/assets")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(TimelinePage.self, from: data)
    }

    private func updateAIConsent(_ consented: Bool, token: String) async throws {
        var request = URLRequest(
            url: URL(string: "http://127.0.0.1:8787/v1/privacy/ai")!
        )
        request.httpMethod = "PUT"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "version": "2026-07-30",
            "consented": consented,
        ])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func addScreenshot(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
