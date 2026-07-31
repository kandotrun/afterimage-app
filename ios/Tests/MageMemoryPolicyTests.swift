import XCTest
@testable import afterimage

final class MageMemoryPolicyTests: XCTestCase {
    func testSearchQueryTrimsWhitespaceAndLimitsToTwoHundredCharacters() {
        XCTAssertEqual(MemorySearchPolicy.query(from: "  harbor  "), "harbor")
        XCTAssertEqual(MemorySearchPolicy.query(from: String(repeating: "a", count: 220))?.count, 200)
        XCTAssertNil(MemorySearchPolicy.query(from: "   \n "))
    }

    func testAnalysisPollingRunsOnlyWhileVisibleAndPending() {
        XCTAssertTrue(VideoAnalysisPollingPolicy.shouldPoll(status: .queued, isVisible: true))
        XCTAssertTrue(VideoAnalysisPollingPolicy.shouldPoll(status: .processing, isVisible: true))
        XCTAssertFalse(VideoAnalysisPollingPolicy.shouldPoll(status: .completed, isVisible: true))
        XCTAssertFalse(VideoAnalysisPollingPolicy.shouldPoll(status: .failed, isVisible: true))
        XCTAssertTrue(VideoAnalysisPollingPolicy.shouldPoll(status: .unavailable, isVisible: true))
        XCTAssertFalse(VideoAnalysisPollingPolicy.shouldPoll(status: .queued, isVisible: false))
    }

    func testTimestampSeekTargetsOnlyTheOpenedVideo() {
        XCTAssertEqual(
            MemorySeekPolicy.seconds(startMs: 42_000, assetID: "video", pageAssetID: "video"),
            42
        )
        XCTAssertNil(MemorySeekPolicy.seconds(startMs: 42_000, assetID: "video", pageAssetID: "other"))
        XCTAssertEqual(
            MemorySeekPolicy.seconds(startMs: -1, assetID: "video", pageAssetID: "video"),
            0
        )
    }

    func testStandaloneSearchDetailDoesNotReplaceTimelinePager() {
        let opened = makeAsset(id: "opened")
        let timeline = [makeAsset(id: "first"), makeAsset(id: "second")]

        XCTAssertEqual(
            MemoryPagerPolicy.assets(openedAsset: opened, timelineAssets: timeline, standalone: true),
            [opened]
        )
        XCTAssertEqual(
            MemoryPagerPolicy.assets(openedAsset: timeline[1], timelineAssets: timeline, standalone: false),
            timeline
        )
    }

    private func makeAsset(id: String) -> Asset {
        let date = Date(timeIntervalSince1970: 1_000)
        return Asset(
            id: id,
            mediaType: .video,
            status: .ready,
            filename: "memory.mov",
            contentType: "video/quicktime",
            byteSize: 1,
            width: 1,
            height: 1,
            durationMs: 1_000,
            capturedAt: date,
            createdAt: date,
            updatedAt: date,
            thumbnailUrl: nil,
            contentUrl: nil,
            transcriptionStatus: nil,
            transcriptPreview: nil,
            transcriptUrl: nil
        )
    }
}