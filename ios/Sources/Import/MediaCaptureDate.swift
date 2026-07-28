@preconcurrency import AVFoundation
import Foundation
import ImageIO

/// Resolves the source capture time without ever substituting the upload time.
enum MediaCaptureDatePolicy {
    static func resolve(embeddedDate: Date?) throws -> Date {
        guard let capturedAt = embeddedDate else {
            throw AfterimageError.captureDateUnavailable
        }
        return capturedAt
    }
}

enum MediaEmbeddedCaptureDate {
    static func read(from url: URL, kind: MediaKind) async -> Date? {
        switch kind {
        case .image:
            return imageDate(from: url)
        case .video:
            return await videoDate(from: url)
        }
    }

    private static func imageDate(from url: URL) -> Date? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return nil
        }

        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        if let original = exif?[kCGImagePropertyExifDateTimeOriginal] as? String {
            return parseExif(
                original,
                offset: exif?["OffsetTimeOriginal" as CFString] as? String
            )
        }
        if let digitized = exif?[kCGImagePropertyExifDateTimeDigitized] as? String {
            return parseExif(
                digitized,
                offset: exif?["OffsetTimeDigitized" as CFString] as? String
            )
        }
        return nil
    }

    private static func videoDate(from url: URL) async -> Date? {
        let asset = AVURLAsset(url: url)
        if let item = try? await asset.load(.creationDate) {
            if let date = try? await item.load(.dateValue) {
                return date
            }
            if let value = try? await item.load(.stringValue),
               let date = parseISO8601(value) {
                return date
            }
        }

        guard let metadata = try? await asset.load(.commonMetadata) else { return nil }
        for item in metadata where item.commonKey == .commonKeyCreationDate {
            if let date = try? await item.load(.dateValue) {
                return date
            }
            if let value = try? await item.load(.stringValue),
               let date = parseISO8601(value) {
                return date
            }
        }
        return nil
    }

    private static func parseExif(_ value: String, offset: String?) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        if let offset, !offset.isEmpty {
            formatter.dateFormat = "yyyy:MM:dd HH:mm:ssXXXXX"
            return formatter.date(from: value + offset)
        }
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.timeZone = .autoupdatingCurrent
        return formatter.date(from: value)
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}
