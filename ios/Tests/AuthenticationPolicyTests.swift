import XCTest
@testable import afterimage

final class AuthenticationPolicyTests: XCTestCase {
    func testOnlyUnauthorizedAPIResponsesInvalidateTheSession() {
        XCTAssertTrue(
            AfterimageError.api(
                status: 401,
                code: .unauthorized,
                message: "expired"
            ).invalidatesSession
        )
        XCTAssertFalse(
            AfterimageError.api(
                status: 500,
                code: .internalError,
                message: "retry"
            ).invalidatesSession
        )
        XCTAssertFalse(AfterimageError.invalidResponse.invalidatesSession)
    }

    func testChallengeExpiryAndReplayAreRetryableAuthenticationErrors() {
        for code in [
            APIErrorCode.authChallengeExpired,
            .authChallengeReplayed,
            .authChallengeInvalid,
        ] {
            XCTAssertTrue(
                AfterimageError.api(
                    status: 401,
                    code: code,
                    message: "retry"
                ).isRetryableAuthentication
            )
        }
        XCTAssertFalse(
            AfterimageError.api(
                status: 401,
                code: .unauthorized,
                message: "signed out"
            ).isRetryableAuthentication
        )
    }

    func testAssetQuotaErrorDescribesTheRollingLimitAndResetTime() {
        let resetsAt = Date(timeIntervalSince1970: 1_785_456_000)
        let error = AfterimageError.assetCreationQuotaExceeded(
            limit: 200,
            remaining: 0,
            resetsAt: resetsAt
        )

        let description = error.errorDescription ?? ""
        let formattedResetTime = resetsAt.formatted(date: .numeric, time: .standard)
        XCTAssertTrue(description.contains("200"))
        XCTAssertTrue(description.contains("0"))
        XCTAssertTrue(description.contains(formattedResetTime))
        XCTAssertFalse(error.invalidatesSession)
    }

    func testAssetQuotaDetailsDecodeFromTheAPIEnvelope() throws {
        let payload = Data(
            """
            {
              "error": {
                "code": "asset_creation_quota_exceeded",
                "message": "quota reached",
                "details": {
                  "limit": 200,
                  "remaining": 0,
                  "resetsAt": "2026-07-31T01:00:00.000Z"
                }
              }
            }
            """.utf8
        )

        let envelope = try JSONDecoder.afterimage.decode(APIErrorEnvelope.self, from: payload)
        XCTAssertEqual(envelope.error.details?.limit, 200)
        XCTAssertEqual(envelope.error.details?.remaining, 0)
        XCTAssertNotNil(envelope.error.details?.resetsAt)
    }

    func testP0BackendErrorCodesUseTypedWireValues() {
        XCTAssertEqual(
            APIErrorCode.appleChallengeRateLimited.rawValue,
            "apple_challenge_rate_limited"
        )
        XCTAssertEqual(
            APIErrorCode.trustedClientIPRequired.rawValue,
            "trusted_client_ip_required"
        )
        XCTAssertEqual(
            APIErrorCode.assetCreationQuotaExceeded.rawValue,
            "asset_creation_quota_exceeded"
        )
        XCTAssertEqual(
            APIErrorCode.storageQuotaExceeded.rawValue,
            "storage_quota_exceeded"
        )
        XCTAssertEqual(
            APIErrorCode.analysisQueueLimit.rawValue,
            "analysis_queue_limit"
        )
    }
}

final class AuthGenerationGateTests: XCTestCase {
    func testQueuedInvalidationRejectsRestorationBeforeAccountBinding() async {
        let gate = AuthGenerationGate()
        let context = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )

        await gate.invalidate(context)

        let didBind = await gate.bind(context)
        let current = await gate.currentContext()
        XCTAssertFalse(didBind)
        XCTAssertNil(current)
    }

    func testReentrantInvalidationTerminatesOneGenerationOnlyOnce() async {
        let gate = AuthGenerationGate()
        let context = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )
        let counter = TerminationCounter()
        await gate.setTerminationHandler { terminated in
            await counter.record(terminated)
        }
        let didBind = await gate.bind(context)
        XCTAssertTrue(didBind)

        async let first: Void = gate.invalidate(context)
        async let second: Void = gate.invalidate(context)
        _ = await (first, second)

        let terminatedContexts = await counter.contexts
        XCTAssertEqual(terminatedContexts, [context])
    }

    func testCompletedInvalidationDoesNotTerminateGenerationAgain() async {
        let gate = AuthGenerationGate()
        let context = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )
        let counter = TerminationCounter()
        await gate.setTerminationHandler { terminated in
            await counter.record(terminated)
        }
        let didBind = await gate.bind(context)
        XCTAssertTrue(didBind)

        await gate.invalidate(context)
        await gate.invalidate(context)

        let terminatedContexts = await counter.contexts
        XCTAssertEqual(terminatedContexts, [context])
    }

    func testStaleGenerationCannotUnbindNewAccountSession() async {
        let gate = AuthGenerationGate()
        let old = AuthSessionContext(generationID: UUID(), accountID: "account-a")
        let current = AuthSessionContext(generationID: UUID(), accountID: "account-b")
        let didBindOld = await gate.bind(old)
        let didBindCurrent = await gate.bind(current)
        XCTAssertTrue(didBindOld)
        XCTAssertTrue(didBindCurrent)

        await gate.invalidate(old)

        let remaining = await gate.currentContext()
        XCTAssertEqual(remaining, current)
    }
}

private actor TerminationCounter {
    private(set) var contexts: [AuthSessionContext] = []

    func record(_ context: AuthSessionContext) {
        contexts.append(context)
    }
}

final class SessionCASPolicyTests: XCTestCase {
    func testOldGenerationCannotClearNewCredential() {
        let old = StoredSession(
            token: "old",
            context: AuthSessionContext(generationID: UUID(), accountID: "account-a")
        )
        let current = StoredSession(
            token: "new",
            context: AuthSessionContext(generationID: UUID(), accountID: "account-a")
        )

        XCTAssertFalse(
            SessionCASPolicy.canClear(stored: current, expected: old.context)
        )
        XCTAssertTrue(
            SessionCASPolicy.canClear(stored: current, expected: current.context)
        )
    }
}
