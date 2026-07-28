import AVFoundation
import CoreMedia
import XCTest
@testable import afterimage

@MainActor
final class CameraCaptureCompressionTests: XCTestCase {
    func testSilentCapturedVideoOptimizesToHEVCWithoutAudioTrack() async throws {
        let sourceURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("mov")
        defer {
            try? FileManager.default.removeItem(at: sourceURL)
        }
        try await makeSilentVideo(at: sourceURL)
        let hasAudio = try await CameraCaptureClient.live()
            .recordingHasAudio(sourceURL)
        let media = ImportedMedia(
            kind: .video,
            url: sourceURL,
            originalFilename: sourceURL.lastPathComponent,
            capturedAt: Date()
        )

        let optimized = try await MediaCompressor().optimize(media) { _ in }
        defer {
            optimized.removeTemporaryFiles()
        }
        let asset = AVURLAsset(url: optimized.url)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let videoTrack = try XCTUnwrap(videoTracks.first)
        let descriptions = try await videoTrack.load(.formatDescriptions)
        let description = try XCTUnwrap(descriptions.first)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)

        XCTAssertEqual(
            CMFormatDescriptionGetMediaSubType(description),
            kCMVideoCodecType_HEVC
        )
        XCTAssertFalse(hasAudio)
        XCTAssertTrue(audioTracks.isEmpty)
    }

    private func makeSilentVideo(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 64,
                AVVideoHeightKey: 64,
            ]
        )
        let adapter = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
            ]
        )
        XCTAssertTrue(writer.canAdd(input))
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)

        for frame in 0..<3 {
            var buffer: CVPixelBuffer?
            XCTAssertEqual(
                CVPixelBufferCreate(
                    kCFAllocatorDefault,
                    64,
                    64,
                    kCVPixelFormatType_32BGRA,
                    nil,
                    &buffer
                ),
                kCVReturnSuccess
            )
            XCTAssertTrue(
                adapter.append(
                    try XCTUnwrap(buffer),
                    withPresentationTime: CMTime(
                        value: CMTimeValue(frame),
                        timescale: 30
                    )
                )
            )
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed)
    }
}
