import XCTest
@testable import afterimage

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
}
