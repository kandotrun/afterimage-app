import XCTest
@testable import afterimage

private actor UploadCancellationCleanupProbe {
    private(set) var didRun = false

    func markRun() {
        didRun = true
    }
}

final class UploadPreviewPlaybackPolicyTests: XCTestCase {
    private let stagedURL = URL(fileURLWithPath: "/tmp/afterimage-uploads/asset-1/media.mov")

    private var preview: UploadPreviewDescriptor {
        UploadPreviewDescriptor(
            generationID: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
            assetID: "asset-1",
            mediaURL: stagedURL,
            contentType: "video/quicktime"
        )
    }

    func testReturnsLocalStagedVideoOnlyWhileUploading() {
        let upload = UploadPresentation(
            stage: .uploading,
            progress: 0.72,
            current: 1,
            total: 2,
            preview: preview
        )

        XCTAssertEqual(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: upload,
                isPlaybackAllowed: true,
                reduceMotion: false
            ),
            preview
        )
    }

    func testDoesNotUseMediaBeforeBackgroundUploadHandoff() {
        let upload = UploadPresentation(
            stage: .compressing(.video),
            progress: 0.32,
            current: 1,
            total: 1,
            preview: preview
        )

        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: upload,
                isPlaybackAllowed: true,
                reduceMotion: false
            )
        )
    }

    func testStopsWhileCoveredOrReduceMotionIsEnabled() {
        let upload = UploadPresentation(
            stage: .uploading,
            progress: 0.72,
            current: 1,
            total: 1,
            preview: preview
        )

        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: upload,
                isPlaybackAllowed: false,
                reduceMotion: false
            )
        )
        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: upload,
                isPlaybackAllowed: true,
                reduceMotion: true
            )
        )
    }

    func testRejectsRemoteAndNonVideoDescriptorsAtThePlaybackBoundary() {
        let remote = UploadPresentation(
            stage: .uploading,
            progress: 0.72,
            current: 1,
            total: 1,
            preview: UploadPreviewDescriptor(
                generationID: preview.generationID,
                assetID: preview.assetID,
                mediaURL: URL(string: "https://uploads.example.com/video.mov")!,
                contentType: "video/quicktime"
            )
        )
        let image = UploadPresentation(
            stage: .uploading,
            progress: 0.72,
            current: 1,
            total: 1,
            preview: UploadPreviewDescriptor(
                generationID: preview.generationID,
                assetID: preview.assetID,
                mediaURL: stagedURL,
                contentType: "image/heic"
            )
        )

        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: remote,
                isPlaybackAllowed: true,
                reduceMotion: false
            )
        )
        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: image,
                isPlaybackAllowed: true,
                reduceMotion: false
            )
        )
    }

    func testCancelledTaskCannotCrossBackgroundUploadHandoffGate() async {
        let task = Task { () -> Bool in
            while !Task.isCancelled {
                await Task.yield()
            }
            do {
                try UploadHandoffGate.checkCancellation()
                return false
            } catch is CancellationError {
                return true
            } catch {
                return false
            }
        }

        task.cancel()
        let wasRejected = await task.value

        XCTAssertTrue(wasRejected)
    }

    func testBeginningFinalizationImmediatelyDetachesPreview() {
        var upload = UploadPresentation(
            stage: .uploading,
            progress: 0.94,
            current: 1,
            total: 1,
            preview: preview
        )

        upload.beginFinalizing()

        XCTAssertEqual(upload.stage, .finishing)
        XCTAssertEqual(upload.progress, 1)
        XCTAssertNil(upload.preview)
        XCTAssertNil(
            UploadPreviewPlaybackPolicy.playableDescriptor(
                for: upload,
                isPlaybackAllowed: true,
                reduceMotion: false
            )
        )
    }

    func testCancellationCleanupRunsOutsideCancelledParentTask() async {
        let probe = UploadCancellationCleanupProbe()
        let task = Task { () -> Bool in
            while !Task.isCancelled {
                await Task.yield()
            }
            await UploadCancellationCleanup.run {
                await probe.markRun()
            }
            return await probe.didRun
        }

        task.cancel()
        let didRun = await task.value

        XCTAssertTrue(didRun)
    }
}
