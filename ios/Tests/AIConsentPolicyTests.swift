import XCTest
@testable import afterimage

final class AIConsentPolicyTests: XCTestCase {
    func testMissingServerConsentDefaultsExternalProcessingAndAgentAccessOff() {
        XCTAssertFalse(AIConsentPolicy.canTransferExternally(consent: nil))
        XCTAssertFalse(AIConsentPolicy.canEnableAgentAccess(consent: nil))
    }

    func testCurrentExplicitGrantEnablesExternalProcessing() {
        let consent = AIConsent(
            version: AIConsentPolicy.currentVersion,
            granted: true,
            consentedAt: Date(timeIntervalSince1970: 1_000),
            withdrawnAt: nil
        )

        XCTAssertTrue(AIConsentPolicy.canTransferExternally(consent: consent))
        XCTAssertTrue(AIConsentPolicy.canEnableAgentAccess(consent: consent))
    }

    func testWithdrawalImmediatelyStopsNewExternalProcessing() {
        let consent = AIConsent(
            version: AIConsentPolicy.currentVersion,
            granted: false,
            consentedAt: Date(timeIntervalSince1970: 1_000),
            withdrawnAt: Date(timeIntervalSince1970: 2_000)
        )

        XCTAssertFalse(AIConsentPolicy.canTransferExternally(consent: consent))
        XCTAssertFalse(AIConsentPolicy.canEnableAgentAccess(consent: consent))
    }

    func testOldConsentVersionRequiresNewOptIn() {
        let consent = AIConsent(
            version: "2026-01-01",
            granted: true,
            consentedAt: Date(timeIntervalSince1970: 1_000),
            withdrawnAt: nil
        )

        XCTAssertFalse(AIConsentPolicy.canTransferExternally(consent: consent))
    }
}
