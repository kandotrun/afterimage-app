import XCTest
@testable import afterimage

final class BackgroundUploadStateTests: XCTestCase {
    private let generationID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!

    private func makePlan(mode: String = "single") -> UploadPlan {
        let json: String
        if mode == "single" {
            json = """
            {"mode":"single","url":"/v1/assets/asset-1/upload","headers":{}}
            """
        } else {
            json = """
            {"mode":"multipart","headers":{},"partSize":5242880,"partCount":3,"partUrlTemplate":"/v1/assets/asset-1/upload/parts/{partNumber}"}
            """
        }
        return try! JSONDecoder().decode(UploadPlan.self, from: Data(json.utf8))
    }

    private func makeItem(
        plan: UploadPlan? = nil,
        completedParts: Set<Int> = [],
        transferComplete: Bool = false,
        mediaURL: URL = URL(fileURLWithPath: "/tmp/test.mov"),
        contentType: String = "video/quicktime"
    ) -> BackgroundUploadState.Item {
        BackgroundUploadState.Item(
            assetID: "asset-1",
            filename: "test.mov",
            mediaURL: mediaURL,
            thumbnailURL: URL(fileURLWithPath: "/tmp/test.jpg"),
            contentType: contentType,
            byteSize: 15_000_000,
            plan: plan ?? makePlan(),
            completedParts: completedParts,
            transferComplete: transferComplete
        )
    }

    func testStateRoundTripPreservesRelaunchContextWithoutBearerToken() throws {
        let state = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: "activity-1",
            items: [makeItem()],
            currentIndex: 0,
            pausedAfterFailure: true,
            cancellationRequested: true,
            retryAttemptsByTransfer: ["transfer-1": 2],
            retryNotBeforeByTransfer: ["transfer-1": Date(timeIntervalSince1970: 1_234)]
        )

        let data = try JSONEncoder().encode(state)
        let encoded = String(decoding: data, as: UTF8.self)
        let decoded = try JSONDecoder().decode(BackgroundUploadState.self, from: data)

        XCTAssertEqual(decoded.baseURL.absoluteString, "https://afterimage.2-38.com")
        XCTAssertEqual(decoded.generationID, generationID)
        XCTAssertEqual(decoded.activityID, "activity-1")
        XCTAssertEqual(decoded.currentItem?.assetID, "asset-1")
        XCTAssertFalse(decoded.allComplete)
        XCTAssertTrue(decoded.pausedAfterFailure)
        XCTAssertTrue(decoded.cancellationRequested)
        XCTAssertEqual(decoded.retryAttemptsByTransfer, ["transfer-1": 2])
        XCTAssertEqual(decoded.retryNotBeforeByTransfer["transfer-1"], Date(timeIntervalSince1970: 1_234))
        XCTAssertFalse(encoded.contains("Bearer"))
        XCTAssertFalse(encoded.contains("bearer-session"))
    }

    func testLegacyStateWithoutGenerationOrTerminalFlagsMigratesSafely() throws {
        let current = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem()],
            currentIndex: 0
        )
        let encoded = try JSONEncoder().encode(current)
        var legacy = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        legacy.removeValue(forKey: "generationID")
        legacy.removeValue(forKey: "pausedAfterFailure")
        legacy.removeValue(forKey: "cancellationRequested")
        legacy.removeValue(forKey: "retryAttemptsByTransfer")
        legacy.removeValue(forKey: "retryNotBeforeByTransfer")

        let decoded = try JSONDecoder().decode(
            BackgroundUploadState.self,
            from: JSONSerialization.data(withJSONObject: legacy)
        )

        let migrated = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any]
        )
        XCTAssertNotNil(migrated["generationID"])
        XCTAssertFalse(decoded.pausedAfterFailure)
        XCTAssertFalse(decoded.cancellationRequested)
        XCTAssertTrue(decoded.retryAttemptsByTransfer.isEmpty)
        XCTAssertTrue(decoded.retryNotBeforeByTransfer.isEmpty)
        XCTAssertEqual(decoded.currentItem?.assetID, "asset-1")
    }

    func testAllComplete() {
        let state = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem(transferComplete: true)],
            currentIndex: 1
        )
        XCTAssertTrue(state.allComplete)
    }

    func testCurrentPreviewDescriptorKeepsUploadGenerationAndStagedVideoIdentity() throws {
        let state = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem()],
            currentIndex: 0
        )

        let preview = try XCTUnwrap(state.currentPreviewDescriptor)

        XCTAssertEqual(preview.generationID, generationID)
        XCTAssertEqual(preview.assetID, "asset-1")
        XCTAssertEqual(preview.mediaURL, URL(fileURLWithPath: "/tmp/test.mov"))
        XCTAssertEqual(preview.contentType, "video/quicktime")
    }

    func testCurrentPreviewDescriptorRejectsCancelledNonVideoAndRemoteMedia() {
        let cancelled = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem()],
            currentIndex: 0,
            cancellationRequested: true
        )
        let image = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem(contentType: "image/heic")],
            currentIndex: 0
        )
        let remote = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem(mediaURL: URL(string: "https://uploads.example.com/video.mov")!)],
            currentIndex: 0
        )

        XCTAssertNil(cancelled.currentPreviewDescriptor)
        XCTAssertNil(image.currentPreviewDescriptor)
        XCTAssertNil(remote.currentPreviewDescriptor)
    }

    func testMultipartProgressTrackingRoundTrip() throws {
        let state = BackgroundUploadState(
            generationID: generationID,
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem(plan: makePlan(mode: "multipart"), completedParts: [1, 2])],
            currentIndex: 0
        )

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(BackgroundUploadState.self, from: data)

        XCTAssertEqual(decoded.currentItem?.completedParts, [1, 2])
        XCTAssertFalse(decoded.allComplete)
    }
}

final class BackgroundUploadTaskIdentityTests: XCTestCase {
    private let generationID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!

    func testSingleAndMultipartIdentitiesRoundTripWithUploadGeneration() {
        let single = BackgroundUploadTaskIdentity(
            generationID: generationID,
            assetID: "asset-1",
            partNumber: nil
        )
        let part = BackgroundUploadTaskIdentity(
            generationID: generationID,
            assetID: "asset-1",
            partNumber: 3
        )

        XCTAssertEqual(BackgroundUploadTaskIdentity(description: single.description), single)
        XCTAssertEqual(BackgroundUploadTaskIdentity(description: part.description), part)
    }

    func testLegacyDescriptionWithoutGenerationIsRejected() {
        XCTAssertNil(BackgroundUploadTaskIdentity(description: "single:asset-1"))
        XCTAssertNil(BackgroundUploadTaskIdentity(description: "part:asset-1:2"))
        XCTAssertNil(
            BackgroundUploadTaskIdentity(
                description: "v2:part:\(generationID.uuidString):asset-1:0"
            )
        )
        XCTAssertNil(
            BackgroundUploadTaskIdentity(
                description: "v2:single:\(generationID.uuidString):"
            )
        )
    }
}

final class BackgroundUploadRequestFactoryTests: XCTestCase {
    func testResolvesRelativeAPIPathAndAddsBearerAuthentication() throws {
        let request = try BackgroundUploadRequestFactory.make(
            path: "/v1/assets/a/upload",
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            bearerToken: "session-token",
            contentType: "video/quicktime",
            contentLength: 123,
            additionalHeaders: ["X-Upload-Test": "yes"]
        )

        XCTAssertEqual(request.url?.absoluteString, "https://afterimage.2-38.com/v1/assets/a/upload")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "video/quicktime")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Length"), "123")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Upload-Test"), "yes")
    }

    func testDoesNotLeakBearerTokenToExternalSignedURL() throws {
        let request = try BackgroundUploadRequestFactory.make(
            path: "https://uploads.example.com/signed",
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            bearerToken: "session-token",
            contentType: "application/octet-stream",
            contentLength: 42,
            additionalHeaders: [:]
        )

        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(request.url?.host, "uploads.example.com")
    }
}

final class BackgroundUploadRetryPolicyTests: XCTestCase {
    func testRetriesDroppedConnectionsWithBackoff() {
        let error = URLError(.networkConnectionLost)

        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: error, httpStatus: nil, attempt: 1),
            .retry(after: 2)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: error, httpStatus: nil, attempt: 2),
            .retry(after: 10)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: error, httpStatus: nil, attempt: 3),
            .retry(after: 30)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: error, httpStatus: nil, attempt: 4),
            .retry(after: 60)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: error, httpStatus: nil, attempt: 5),
            .fail
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(
                error: NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorNetworkConnectionLost
                ),
                httpStatus: nil,
                attempt: 1
            ),
            .retry(after: 2)
        )
    }

    func testRetriesTemporaryHTTPFailures() {
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: nil, httpStatus: 503, attempt: 1),
            .retry(after: 2)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: nil, httpStatus: 429, attempt: 2),
            .retry(after: 10)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: nil, httpStatus: 409, attempt: 1),
            .retry(after: 2)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(
                error: URLError(.cancelled),
                httpStatus: nil,
                attempt: 1
            ),
            .retry(after: 2)
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(
                error: AfterimageError.invalidResponse,
                httpStatus: nil,
                attempt: 1
            ),
            .retry(after: 2)
        )
    }

    func testReconcilesWhenUploadEndpointNoLongerFindsTheAsset() {
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: nil, httpStatus: 404, attempt: 1),
            .reconcile
        )
    }

    func testFailsPermanentLocalAndAuthenticationErrors() {
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(
                error: URLError(.fileDoesNotExist),
                httpStatus: nil,
                attempt: 1
            ),
            .fail
        )
        XCTAssertEqual(
            BackgroundUploadRetryPolicy.disposition(error: nil, httpStatus: 401, attempt: 1),
            .expireSession
        )
    }
}

final class BackgroundUploadAuthorizationPolicyTests: XCTestCase {
    func testSameAccountCanResumeWithFreshGeneration() {
        let owner = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )
        let current = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )

        XCTAssertTrue(
            BackgroundUploadAuthorizationPolicy.canUse(
                owner: owner,
                current: current
            )
        )
    }

    func testDifferentAccountCannotResumePendingUpload() {
        let owner = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-a"
        )
        let current = AuthSessionContext(
            generationID: UUID(),
            accountID: "account-b"
        )

        XCTAssertFalse(
            BackgroundUploadAuthorizationPolicy.canUse(
                owner: owner,
                current: current
            )
        )
    }

    func testLegacyUnknownAccountRequiresExactGeneration() {
        let owner = AuthSessionContext(
            generationID: UUID(),
            accountID: nil
        )
        let current = AuthSessionContext(
            generationID: UUID(),
            accountID: nil
        )

        XCTAssertFalse(
            BackgroundUploadAuthorizationPolicy.canUse(
                owner: owner,
                current: current
            )
        )
        XCTAssertTrue(
            BackgroundUploadAuthorizationPolicy.canUse(
                owner: owner,
                current: owner
            )
        )
    }
}
