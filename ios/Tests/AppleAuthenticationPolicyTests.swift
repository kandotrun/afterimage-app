import AuthenticationServices
import XCTest
@testable import afterimage

final class AppleAuthenticationPolicyTests: XCTestCase {
    func testSHA256MatchesKnownVector() {
        XCTAssertEqual(
            AppleAuthRequestPolicy.sha256("afterimage-nonce"),
            "2707a9408023afb1c3bf5a9a198802a01d11fccaba85b68396a105ba30b3dd07"
        )
    }

    func testDistinctChallengesProduceDistinctRequestBindings() throws {
        let expiry = Date(timeIntervalSince1970: 2_000)
        let first = try AppleAuthRequestPolicy.binding(
            challenge: AppleAuthChallenge(
                challengeId: "challenge-a",
                nonce: "nonce-a",
                expiresAt: expiry
            ),
            now: Date(timeIntervalSince1970: 1_000)
        )
        let second = try AppleAuthRequestPolicy.binding(
            challenge: AppleAuthChallenge(
                challengeId: "challenge-b",
                nonce: "nonce-b",
                expiresAt: expiry
            ),
            now: Date(timeIntervalSince1970: 1_000)
        )

        XCTAssertNotEqual(first.challengeID, second.challengeID)
        XCTAssertNotEqual(first.hashedNonce, second.hashedNonce)
    }

    func testRequestBindsHashedNonceAndScopesToChallenge() throws {
        let binding = try AppleAuthRequestPolicy.binding(
            challenge: AppleAuthChallenge(
                challengeId: "challenge-a",
                nonce: "raw-nonce",
                expiresAt: Date(timeIntervalSince1970: 2_000)
            ),
            now: Date(timeIntervalSince1970: 1_000)
        )
        let request = ASAuthorizationAppleIDProvider().createRequest()

        AppleAuthRequestPolicy.configure(request, binding: binding)

        XCTAssertEqual(request.nonce, AppleAuthRequestPolicy.sha256("raw-nonce"))
        XCTAssertEqual(Set(request.requestedScopes ?? []), [.fullName, .email])
        XCTAssertEqual(binding.challengeID, "challenge-a")
    }

    func testAttemptIsConsumedOnceAndClearedAfterEveryCompletion() throws {
        let binding = AppleAuthRequestBinding(
            challengeID: "challenge-a",
            hashedNonce: "hash",
            expiresAt: Date(timeIntervalSince1970: 2_000)
        )
        var state = AppleAuthAttemptState()
        state.prepare(binding)

        XCTAssertEqual(
            try state.consume(now: Date(timeIntervalSince1970: 1_000)),
            binding
        )
        XCTAssertNil(state.prepared)
        XCTAssertEqual(state.active, binding)
        XCTAssertThrowsError(
            try state.consume(now: Date(timeIntervalSince1970: 1_000))
        )

        state.finish()

        XCTAssertNil(state.prepared)
        XCTAssertNil(state.active)
    }

    func testExpiredChallengeCannotStartAppleRequest() {
        XCTAssertThrowsError(
            try AppleAuthRequestPolicy.binding(
                challenge: AppleAuthChallenge(
                    challengeId: "challenge-a",
                    nonce: "raw-nonce",
                    expiresAt: Date(timeIntervalSince1970: 999)
                ),
                now: Date(timeIntervalSince1970: 1_000)
            )
        )
    }
}
