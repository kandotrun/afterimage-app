import XCTest
@testable import afterimage

@MainActor
final class DailyVideoPlaybackControllerTests: XCTestCase {
    private enum DeferredError: Error {
        case expected
    }

    @MainActor
    private final class DeferredGrantLoader {
        private var continuations: [String: CheckedContinuation<ResolvedPlaybackGrant, Error>] = [:]

        func load(_ asset: Asset) async throws -> ResolvedPlaybackGrant {
            try await withCheckedThrowingContinuation { continuation in
                continuations[asset.id] = continuation
            }
        }

        func hasRequest(for assetID: String) -> Bool {
            continuations[assetID] != nil
        }

        func fail(_ assetID: String) {
            continuations.removeValue(forKey: assetID)?.resume(throwing: DeferredError.expected)
        }

        func resolve(_ assetID: String) {
            continuations.removeValue(forKey: assetID)?.resume(
                returning: ResolvedPlaybackGrant(
                    url: URL(fileURLWithPath: "/tmp/\(assetID).mp4"),
                    expiresAt: Date().addingTimeInterval(300)
                )
            )
        }
    }

    func testSupersededGrantFailureCannotOverwriteLatestClipState() async {
        let first = clip(id: "first", startMs: 0, endMs: 1_000)
        let second = clip(id: "second", startMs: 1_000, endMs: 2_000)
        let playback = DailyPlaybackResponse(
            startAt: Date(timeIntervalSince1970: 0),
            endAt: Date(timeIntervalSince1970: 2),
            clipCount: 2,
            durationMs: 2_000,
            clips: [first, second]
        )
        let loader = DeferredGrantLoader()
        let controller = DailyVideoPlaybackController()

        let activation = Task {
            await controller.activate(playback: playback) { asset in
                try await loader.load(asset)
            }
        }
        await waitUntil { loader.hasRequest(for: "first") }

        controller.playClip(at: 1)
        await waitUntil { loader.hasRequest(for: "second") }
        XCTAssertEqual(controller.activeIndex, 1)
        XCTAssertEqual(controller.phase, .loading)

        loader.fail("first")
        await activation.value
        await Task.yield()

        XCTAssertEqual(controller.activeIndex, 1)
        XCTAssertEqual(controller.phase, .loading)

        loader.resolve("second")
        await Task.yield()
        controller.deactivate()
    }

    private func waitUntil(
        _ predicate: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<200 {
            if predicate() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for deferred playback request", file: file, line: line)
    }

    private func clip(id: String, startMs: Int, endMs: Int) -> DailyPlaybackClip {
        let timestamp = Date(timeIntervalSince1970: TimeInterval(startMs) / 1_000)
        return DailyPlaybackClip(
            asset: Asset(
                id: id,
                mediaType: .video,
                status: .ready,
                filename: "\(id).mov",
                contentType: "video/quicktime",
                byteSize: 100,
                width: 1_920,
                height: 1_080,
                durationMs: endMs - startMs,
                capturedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
                thumbnailUrl: nil,
                contentUrl: "/v1/assets/\(id)/content",
                transcriptionStatus: .completed,
                transcriptPreview: nil,
                transcriptUrl: "/v1/assets/\(id)/transcript"
            ),
            startMs: startMs,
            endMs: endMs,
            transcript: DailyPlaybackTranscript(
                status: .completed,
                language: "ja",
                text: id,
                updatedAt: nil
            )
        )
    }
}
