import UserNotifications
import XCTest
@testable import afterimage

final class PR39AccessibilityPolicyTests: XCTestCase {
    func testReminderInviteIsOfferedOnlyOnceBeforeAuthorization() {
        XCTAssertTrue(
            ReminderInvitePolicy.shouldOffer(
                wasOffered: false,
                authorizationStatus: .notDetermined
            )
        )
        XCTAssertFalse(
            ReminderInvitePolicy.shouldOffer(
                wasOffered: true,
                authorizationStatus: .notDetermined
            )
        )
        XCTAssertFalse(
            ReminderInvitePolicy.shouldOffer(
                wasOffered: false,
                authorizationStatus: .authorized
            )
        )
        XCTAssertFalse(
            ReminderInvitePolicy.shouldOffer(
                wasOffered: false,
                authorizationStatus: .denied
            )
        )
    }

    func testPlayerChromeDoesNotAutoHideForAssistiveAccess() {
        XCTAssertTrue(
            PlayerChromeAccessibilityPolicy.shouldAutoHide(
                isVoiceOverRunning: false,
                isSwitchControlRunning: false
            )
        )
        XCTAssertFalse(
            PlayerChromeAccessibilityPolicy.shouldAutoHide(
                isVoiceOverRunning: true,
                isSwitchControlRunning: false
            )
        )
        XCTAssertFalse(
            PlayerChromeAccessibilityPolicy.shouldAutoHide(
                isVoiceOverRunning: false,
                isSwitchControlRunning: true
            )
        )
    }
}
