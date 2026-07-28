import XCTest
@testable import afterimage

final class DailyPlaybackPlanTests: XCTestCase {
    private func asset(id: String, capturedAt: TimeInterval, durationMs: Int) -> Asset {
        Asset(
            id: id,
            mediaType: .video,
            status: .ready,
            filename: "\(id).mov",
            contentType: "video/quicktime",
            byteSize: 100,
            width: 1_920,
            height: 1_080,
            durationMs: durationMs,
            capturedAt: Date(timeIntervalSince1970: capturedAt),
            createdAt: Date(timeIntervalSince1970: capturedAt),
            updatedAt: Date(timeIntervalSince1970: capturedAt),
            thumbnailUrl: nil,
            contentUrl: "/v1/assets/\(id)/content",
            transcriptionStatus: .completed,
            transcriptPreview: nil,
            transcriptUrl: "/v1/assets/\(id)/transcript"
        )
    }

    private var clips: [DailyPlaybackClip] {
        [
            DailyPlaybackClip(
                asset: asset(id: "morning", capturedAt: 100, durationMs: 2_000),
                startMs: 0,
                endMs: 2_000,
                transcript: DailyPlaybackTranscript(
                    status: .completed,
                    language: "ja",
                    text: "朝の字幕",
                    updatedAt: nil
                )
            ),
            DailyPlaybackClip(
                asset: asset(id: "afternoon", capturedAt: 200, durationMs: 3_000),
                startMs: 2_000,
                endMs: 5_000,
                transcript: DailyPlaybackTranscript(
                    status: .completed,
                    language: "ja",
                    text: "午後の字幕",
                    updatedAt: nil
                )
            ),
        ]
    }

    func testMapsWholeDayPositionToClipAndLocalTimeAtBoundaries() {
        let plan = DailyPlaybackPlan(clips: clips)

        XCTAssertEqual(plan.location(at: 0), .init(clipIndex: 0, localSeconds: 0))
        XCTAssertEqual(plan.location(at: 1.999), .init(clipIndex: 0, localSeconds: 1.999))
        XCTAssertEqual(plan.location(at: 2), .init(clipIndex: 1, localSeconds: 0))
        XCTAssertEqual(plan.location(at: 4.5), .init(clipIndex: 1, localSeconds: 2.5))
        XCTAssertEqual(plan.location(at: 5), .init(clipIndex: 1, localSeconds: 3))
    }

    func testClampsOutOfRangePositionsAndBuildsGlobalPosition() {
        let plan = DailyPlaybackPlan(clips: clips)

        XCTAssertEqual(plan.location(at: -10), .init(clipIndex: 0, localSeconds: 0))
        XCTAssertEqual(plan.location(at: 100), .init(clipIndex: 1, localSeconds: 3))
        XCTAssertEqual(plan.globalPosition(localSeconds: 1.25, clipIndex: 1), 3.25)
        XCTAssertEqual(plan.duration, 5)
    }

    func testSubtitleChangesOnlyAtClipBoundary() {
        let plan = DailyPlaybackPlan(clips: clips)

        XCTAssertEqual(plan.transcript(at: 1.999), "朝の字幕")
        XCTAssertEqual(plan.transcript(at: 2), "午後の字幕")
    }
}
