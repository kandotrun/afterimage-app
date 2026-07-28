import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import afterimage

final class MediaEmbeddedMetadataTests: XCTestCase {
    func testReadsCaptureDateAndGPSFromJPEGMetadata() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("jpg")
        defer { try? FileManager.default.removeItem(at: url) }

        let image = try XCTUnwrap(makePixelImage())
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(
                url as CFURL,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            )
        )
        let properties: [CFString: Any] = [
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2024:04:05 06:07:08",
                "OffsetTimeOriginal" as CFString: "+09:00",
            ] as [CFString: Any],
            kCGImagePropertyGPSDictionary: [
                kCGImagePropertyGPSLatitude: 34.3853,
                kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 132.4553,
                kCGImagePropertyGPSLongitudeRef: "E",
            ] as [CFString: Any],
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))

        async let capturedAt = MediaEmbeddedCaptureDate.read(from: url, kind: .image)
        async let location = MediaEmbeddedCaptureLocation.read(from: url, kind: .image)

        let resolvedDate = await capturedAt
        let resolvedLocation = await location
        XCTAssertEqual(
            resolvedDate,
            ISO8601DateFormatter().date(from: "2024-04-04T21:07:08Z")
        )
        XCTAssertEqual(
            resolvedLocation,
            CaptureLocation(latitude: 34.3853, longitude: 132.4553)
        )
    }

    func testDoesNotUseTIFFModificationDateAsCaptureDate() async throws {
        let url = try writeTIFF(properties: [
            kCGImagePropertyTIFFDictionary: [
                kCGImagePropertyTIFFDateTime: "2024:04:05 06:07:08",
            ] as [CFString: Any],
        ])

        let capturedAt = await MediaEmbeddedCaptureDate.read(from: url, kind: .image)

        XCTAssertNil(capturedAt)
    }

    func testDoesNotPairOriginalCaptureDateWithDigitizedOffset() async throws {
        let url = try writeJPEG(properties: [
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2024:04:05 06:07:08",
                kCGImagePropertyExifDateTimeDigitized: "2024:04:05 07:08:09",
                "OffsetTimeDigitized" as CFString: "+10:00",
            ] as [CFString: Any],
        ])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        let expected = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2024,
            month: 4,
            day: 5,
            hour: 6,
            minute: 7,
            second: 8
        )))

        let capturedAt = await MediaEmbeddedCaptureDate.read(from: url, kind: .image)

        XCTAssertEqual(capturedAt, expected)
    }

    func testResolvesExifHemisphereReferences() {
        XCTAssertEqual(
            MediaEmbeddedCaptureLocation.resolveExifCoordinates(
                latitude: 33.8688,
                longitude: 151.2093,
                latitudeReference: "S",
                longitudeReference: "W"
            ),
            CaptureLocation(latitude: -33.8688, longitude: -151.2093)
        )
    }

    func testRejectsGPSCoordinatesWithoutValidHemisphereReferences() {
        XCTAssertNil(MediaEmbeddedCaptureLocation.resolveExifCoordinates(
            latitude: 34.3853,
            longitude: 132.4553,
            latitudeReference: nil,
            longitudeReference: nil
        ))
        XCTAssertNil(MediaEmbeddedCaptureLocation.resolveExifCoordinates(
            latitude: 34.3853,
            longitude: 132.4553,
            latitudeReference: "Q",
            longitudeReference: "Z"
        ))
    }

    private func writeTIFF(properties: [CFString: Any]) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("tiff")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        let image = try XCTUnwrap(makePixelImage())
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(
                url as CFURL,
                UTType.tiff.identifier as CFString,
                1,
                nil
            )
        )
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    private func writeJPEG(properties: [CFString: Any]) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("jpg")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        let image = try XCTUnwrap(makePixelImage())
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(
                url as CFURL,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            )
        )
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    private func makePixelImage() -> CGImage? {
        let bytes = Data([0x20, 0x80, 0xF0, 0xFF])
        guard let provider = CGDataProvider(data: bytes as CFData) else { return nil }
        return CGImage(
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }
}
