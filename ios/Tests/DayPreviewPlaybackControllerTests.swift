import AVFoundation
import XCTest
@testable import afterimage

@MainActor
final class DayPreviewPlaybackControllerTests: XCTestCase {
    private enum PreviewError: Error {
        case expected
    }

    @MainActor
    private final class GrantLoader {
        var calls: [String] = []
        var failingIDs: Set<String> = []
        var cancellingIDs: Set<String> = []
        var expiresIn: TimeInterval = 300

        func load(_ asset: Asset) async throws -> ResolvedPlaybackGrant {
            calls.append(asset.id)
            if cancellingIDs.contains(asset.id) {
                throw CancellationError()
            }
            if failingIDs.contains(asset.id) {
                throw PreviewError.expected
            }
            return ResolvedPlaybackGrant(
                url: URL(fileURLWithPath: "/tmp/\(asset.id).mp4"),
                expiresAt: Date().addingTimeInterval(expiresIn)
            )
        }
    }

    @MainActor
    private final class DeferredGrantLoader {
        var calls: [String] = []
        private var continuations: [String: CheckedContinuation<ResolvedPlaybackGrant, Error>] = [:]

        func load(_ asset: Asset) async throws -> ResolvedPlaybackGrant {
            calls.append(asset.id)
            return try await withCheckedThrowingContinuation { continuation in
                continuations[asset.id] = continuation
            }
        }

        func hasRequest(for assetID: String) -> Bool {
            continuations[assetID] != nil
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

    func testNextIndexAdvancesOnceAndRestsAtTheEndOfTheDay() {
        XCTAssertEqual(DayPreviewPlaybackController.nextIndex(after: 0, count: 2), 1)
        XCTAssertNil(DayPreviewPlaybackController.nextIndex(after: 1, count: 2))
    }

    func testNextIndexIsNilWithoutVideos() {
        XCTAssertNil(DayPreviewPlaybackController.nextIndex(after: 0, count: 0))
    }

    func testCompletionPlaysEachClipOnceThenRestsOnTheLastFrame() async throws {
        let loader = GrantLoader()
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first"), asset(id: "second")]) {
            try await loader.load($0)
        }
        let firstItem = try XCTUnwrap(controller.player.currentItem)
        NotificationCenter.default.post(
            name: AVPlayerItem.didPlayToEndTimeNotification,
            object: firstItem
        )
        await waitUntil { loader.calls == ["first", "second"] }

        let secondItem = try XCTUnwrap(controller.player.currentItem)
        NotificationCenter.default.post(
            name: AVPlayerItem.didPlayToEndTimeNotification,
            object: secondItem
        )
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(loader.calls, ["first", "second"], "the preview must not loop the day again")
        XCTAssertTrue(
            controller.player.currentItem === secondItem,
            "the preview must rest on the last clip's final frame"
        )
        controller.deactivate()
    }

    func testReactivationReusesAnUnexpiredGrant() async {
        let loader = GrantLoader()
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first")]) {
            try await loader.load($0)
        }
        XCTAssertEqual(loader.calls, ["first"])

        controller.deactivate()
        await controller.activate(assets: [asset(id: "first")]) {
            try await loader.load($0)
        }

        XCTAssertEqual(loader.calls, ["first"], "an unexpired grant must be reused across activations")
        XCTAssertNotNil(controller.player.currentItem)
        controller.deactivate()
    }

    func testReactivationRefreshesAnExpiringGrant() async {
        let loader = GrantLoader()
        loader.expiresIn = 5
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first")]) {
            try await loader.load($0)
        }
        controller.deactivate()
        await controller.activate(assets: [asset(id: "first")]) {
            try await loader.load($0)
        }

        XCTAssertEqual(loader.calls, ["first", "first"], "grants inside the safety margin must be refreshed")
        controller.deactivate()
    }

    func testItemFailureAdvancesAndStopsAfterOneFailedPass() async throws {
        let loader = GrantLoader()
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first"), asset(id: "second")]) {
            try await loader.load($0)
        }
        let firstItem = try XCTUnwrap(controller.player.currentItem)
        NotificationCenter.default.post(
            name: AVPlayerItem.failedToPlayToEndTimeNotification,
            object: firstItem
        )
        await waitUntil { loader.calls == ["first", "second"] }

        let secondItem = try XCTUnwrap(controller.player.currentItem)
        NotificationCenter.default.post(
            name: AVPlayerItem.failedToPlayToEndTimeNotification,
            object: secondItem
        )
        await waitUntil { controller.player.currentItem == nil }
        XCTAssertEqual(loader.calls, ["first", "second"])
    }

    func testGrantFailureSkipsToNextAssetWithinBound() async {
        let loader = GrantLoader()
        loader.failingIDs = ["first"]
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first"), asset(id: "second")]) {
            try await loader.load($0)
        }

        await waitUntil { loader.calls == ["first", "second"] }
        XCTAssertNotNil(controller.player.currentItem)
        controller.deactivate()
    }

    func testCancellationDoesNotRequestAnotherGrant() async {
        let loader = GrantLoader()
        loader.cancellingIDs = ["first"]
        let controller = makeController()

        await controller.activate(assets: [asset(id: "first"), asset(id: "second")]) {
            try await loader.load($0)
        }

        XCTAssertEqual(loader.calls, ["first"])
        XCTAssertNil(controller.player.currentItem)
    }

    func testDeactivationPreventsDeferredGrantFromInstallingItem() async {
        let loader = DeferredGrantLoader()
        let controller = makeController()
        let activation = Task {
            await controller.activate(assets: [asset(id: "first")]) {
                try await loader.load($0)
            }
        }
        await waitUntil { loader.hasRequest(for: "first") }

        controller.deactivate()
        loader.resolve("first")
        await activation.value

        XCTAssertNil(controller.player.currentItem)
    }

    func testSupersedingActivationCannotInstallOlderGrant() async throws {
        let loader = DeferredGrantLoader()
        let controller = makeController()
        let firstActivation = Task {
            await controller.activate(assets: [asset(id: "first")]) {
                try await loader.load($0)
            }
        }
        await waitUntil { loader.hasRequest(for: "first") }

        let secondActivation = Task {
            await controller.activate(assets: [asset(id: "second")]) {
                try await loader.load($0)
            }
        }
        await waitUntil { loader.hasRequest(for: "second") }
        loader.resolve("second")
        await secondActivation.value
        let latestItem = try XCTUnwrap(controller.player.currentItem)

        loader.resolve("first")
        await firstActivation.value

        XCTAssertTrue(controller.player.currentItem === latestItem)
        XCTAssertEqual(loader.calls, ["first", "second"])
        controller.deactivate()
    }

    private func makeController() -> DayPreviewPlaybackController {
        DayPreviewPlaybackController(
            itemFactory: { _ in AVPlayerItem(asset: AVMutableComposition()) },
            startPlayback: { _ in }
        )
    }

    private func asset(id: String) -> Asset {
        let timestamp = Date(timeIntervalSince1970: 0)
        return Asset(
            id: id,
            mediaType: .video,
            status: .ready,
            filename: "\(id).mov",
            contentType: "video/quicktime",
            byteSize: 100,
            width: 1_920,
            height: 1_080,
            durationMs: 1_000,
            capturedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
            thumbnailUrl: nil,
            contentUrl: "/v1/assets/\(id)/content",
            transcriptionStatus: .completed,
            transcriptPreview: nil,
            transcriptUrl: "/v1/assets/\(id)/transcript"
        )
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
        XCTFail("Timed out waiting for preview playback state", file: file, line: line)
    }
}
