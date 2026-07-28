import XCTest
@testable import afterimage

final class DayStoryPolicyTests: XCTestCase {
    func testHeroPrefersTranscribedVideoOverNewerVideo() {
        let newerVideo = makeAsset(id: "v-new", kind: .video)
        let transcribed = makeAsset(id: "v-old", kind: .video, transcriptionStatus: .completed)
        let story = DayStoryPolicy.story(for: [newerVideo, transcribed])
        XCTAssertEqual(story?.hero.id, "v-old")
    }

    func testHeroFallsBackToNewestVideoThenNewestAsset() {
        XCTAssertEqual(
            DayStoryPolicy.story(for: [
                makeAsset(id: "p1"), makeAsset(id: "v1", kind: .video), makeAsset(id: "v2", kind: .video),
            ])?.hero.id,
            "v1"
        )
        XCTAssertEqual(
            DayStoryPolicy.story(for: [makeAsset(id: "p1"), makeAsset(id: "p2")])?.hero.id,
            "p1"
        )
    }

    func testStripIncludesHeroAndKeepsTimelineOrder() {
        let story = DayStoryPolicy.story(for: [
            makeAsset(id: "p1"), makeAsset(id: "v1", kind: .video), makeAsset(id: "p2"),
        ])
        XCTAssertEqual(story?.strip.map(\.id), ["p1", "v1", "p2"])
    }

    func testPhotoOnlyDayKeepsHeroOutOfStrip() {
        let story = DayStoryPolicy.story(for: [makeAsset(id: "p1"), makeAsset(id: "p2")])
        XCTAssertEqual(story?.hero.id, "p1")
        XCTAssertEqual(story?.strip.map(\.id), ["p2"])
    }

    func testEmptyDayHasNoStory() {
        XCTAssertNil(DayStoryPolicy.story(for: []))
    }

    private func makeAsset(
        id: String,
        kind: MediaKind = .image,
        transcriptionStatus: TranscriptionStatus? = nil
    ) -> Asset {
        let date = Date(timeIntervalSince1970: 1_000)
        return Asset(
            id: id,
            mediaType: kind,
            status: .ready,
            filename: "memory",
            contentType: kind == .video ? "video/quicktime" : "image/heic",
            byteSize: 1,
            width: nil,
            height: nil,
            durationMs: nil,
            capturedAt: date,
            createdAt: date,
            updatedAt: date,
            thumbnailUrl: nil,
            contentUrl: nil,
            transcriptionStatus: transcriptionStatus,
            transcriptPreview: nil,
            transcriptUrl: nil
        )
    }
}
