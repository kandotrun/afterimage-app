import XCTest
@testable import afterimage

final class BackgroundUploadStateTests: XCTestCase {
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
        transferComplete: Bool = false
    ) -> BackgroundUploadState.Item {
        BackgroundUploadState.Item(
            assetID: "asset-1",
            filename: "test.mov",
            mediaURL: URL(fileURLWithPath: "/tmp/test.mov"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/test.jpg"),
            contentType: "video/quicktime",
            byteSize: 15_000_000,
            plan: plan ?? makePlan(),
            completedParts: completedParts,
            transferComplete: transferComplete
        )
    }

    func testStateRoundTripPreservesRelaunchContextWithoutBearerToken() throws {
        let state = BackgroundUploadState(
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: "activity-1",
            items: [makeItem()],
            currentIndex: 0
        )

        let data = try JSONEncoder().encode(state)
        let encoded = String(decoding: data, as: UTF8.self)
        let decoded = try JSONDecoder().decode(BackgroundUploadState.self, from: data)

        XCTAssertEqual(decoded.baseURL.absoluteString, "https://afterimage.2-38.com")
        XCTAssertEqual(decoded.activityID, "activity-1")
        XCTAssertEqual(decoded.currentItem?.assetID, "asset-1")
        XCTAssertFalse(decoded.allComplete)
        XCTAssertFalse(encoded.contains("Bearer"))
        XCTAssertFalse(encoded.contains("bearer-session"))
    }

    func testAllComplete() {
        let state = BackgroundUploadState(
            baseURL: URL(string: "https://afterimage.2-38.com")!,
            activityID: nil,
            items: [makeItem(transferComplete: true)],
            currentIndex: 1
        )
        XCTAssertTrue(state.allComplete)
    }

    func testMultipartProgressTrackingRoundTrip() throws {
        let state = BackgroundUploadState(
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
