import XCTest
@testable import afterimage

final class PlaybackRecoveryPolicyTests: XCTestCase {
    private let policy = PlaybackRecoveryPolicy()
    private let now = Date(timeIntervalSince1970: 10_000)

    func testReusesFreshGrant() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(120)), .reuse)
    }

    func testRefreshesExpiredGrant() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(-1)), .refresh)
    }

    func testRefreshesGrantInsideSafetyMargin() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(5)), .refresh)
    }

    func testRefreshesWhenNoGrantYet() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: nil), .refresh)
    }

    func testAllowsSingleSilentRetryOnFailure() {
        XCTAssertEqual(policy.failureAction(retriesUsed: 0), .refresh)
        XCTAssertEqual(policy.failureAction(retriesUsed: 1), .surface)
    }
}
