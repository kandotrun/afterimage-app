import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import afterimage

final class MediaCaptureDateTests: XCTestCase {
    func testReadsVideoCreationDateFromTransferredFile() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("mov")
        let expected = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-27T02:08:00Z")
        )
        defer { try? FileManager.default.removeItem(at: url) }
        try await makeVideo(at: url, capturedAt: expected)

        let capturedAt = await MediaImporter.captureDate(for: .video, at: url)

        XCTAssertEqual(capturedAt?.timeIntervalSince1970, expected.timeIntervalSince1970)
    }

    func testReadsPhotoCreationDateFromTransferredFile() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("jpg")
        let expected = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-27T02:08:00Z")
        )
        defer { try? FileManager.default.removeItem(at: url) }
        try makeImage(at: url)

        let capturedAt = await MediaImporter.captureDate(for: .image, at: url)

        XCTAssertEqual(capturedAt?.timeIntervalSince1970, expected.timeIntervalSince1970)
    }

    private func makeVideo(at url: URL, capturedAt: Date) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let creationDate = AVMutableMetadataItem()
        creationDate.identifier = .quickTimeMetadataCreationDate
        creationDate.value = ISO8601DateFormatter().string(from: capturedAt) as NSString
        writer.metadata = [creationDate]

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 2,
            AVVideoHeightKey: 2,
        ])
        let adapter = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 2,
                kCVPixelBufferHeightKey as String: 2,
            ]
        )
        XCTAssertTrue(writer.canAdd(input))
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)

        var buffer: CVPixelBuffer?
        XCTAssertEqual(
            CVPixelBufferCreate(
                kCFAllocatorDefault,
                2,
                2,
                kCVPixelFormatType_32BGRA,
                nil,
                &buffer
            ),
            kCVReturnSuccess
        )
        XCTAssertTrue(adapter.append(try XCTUnwrap(buffer), withPresentationTime: .zero))
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertNil(writer.error)
    }

    private func makeImage(at url: URL) throws {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ))
        let exif: NSDictionary = [
            kCGImagePropertyExifDateTimeOriginal: "2026:07:27 11:08:00",
            kCGImagePropertyExifOffsetTimeOriginal: "+09:00",
        ]
        let properties: NSDictionary = [kCGImagePropertyExifDictionary: exif]
        CGImageDestinationAddImage(destination, image, properties)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
    }
}
