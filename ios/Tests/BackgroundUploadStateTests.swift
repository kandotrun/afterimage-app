import XCTest
@testable import afterimage

final class BackgroundUploadStateTests: XCTestCase {
    private func makePlan(mode: String = "single") -> UploadPlan {
        let json: String
        if mode == "single" {
            json = """
            {"mode":"single","url":"https://r2.example.com/upload","headers":{}}
            """
        } else {
            json = """
            {"mode":"multipart","headers":{},"partSize":5242880,"partCount":3,"partUrlTemplate":"https://r2.example.com/part/{partNumber}"}
            """
        }
        return try! JSONDecoder().decode(UploadPlan.self, from: Data(json.utf8))
    }

    func testStateRoundTrip() throws {
        let item = BackgroundUploadState.Item(
            assetID: "asset-1",
            filename: "test.mov",
            mediaURL: URL(fileURLWithPath: "/tmp/test.mov"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/test.jpg"),
            contentType: "video/quicktime",
            byteSize: 1024,
            plan: makePlan(),
            completedParts: [],
            isComplete: false
        )
        let state = BackgroundUploadState(items: [item], currentIndex: 0)

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(BackgroundUploadState.self, from: data)

        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertEqual(decoded.currentIndex, 0)
        XCTAssertEqual(decoded.currentItem?.assetID, "asset-1")
        XCTAssertFalse(decoded.allComplete)
    }

    func testAllComplete() {
        let item = BackgroundUploadState.Item(
            assetID: "asset-1",
            filename: "test.mov",
            mediaURL: URL(fileURLWithPath: "/tmp/test.mov"),
            thumbnailURL: nil,
            contentType: "video/quicktime",
            byteSize: 1024,
            plan: makePlan(),
            completedParts: [],
            isComplete: true
        )
        let state = BackgroundUploadState(items: [item], currentIndex: 0)
        XCTAssertTrue(state.allComplete)
    }

    func testMultipartProgressTracking() throws {
        let item = BackgroundUploadState.Item(
            assetID: "asset-2",
            filename: "big.mov",
            mediaURL: URL(fileURLWithPath: "/tmp/big.mov"),
            thumbnailURL: nil,
            contentType: "video/quicktime",
            byteSize: 15_000_000,
            plan: makePlan(mode: "multipart"),
            completedParts: [1, 2],
            isComplete: false
        )
        let state = BackgroundUploadState(items: [item], currentIndex: 0)

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(BackgroundUploadState.self, from: data)

        XCTAssertEqual(decoded.currentItem?.completedParts, [1, 2])
        XCTAssertFalse(decoded.allComplete)
    }
}
