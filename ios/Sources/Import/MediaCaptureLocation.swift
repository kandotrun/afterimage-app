@preconcurrency import AVFoundation
import Foundation
import ImageIO

// PhotosPicker is configured with `.current`, so embedded file metadata remains
// the privacy-preserving source of capture coordinates.
enum MediaCaptureLocationPolicy {
    static func resolve(embeddedLocation: CaptureLocation?) -> CaptureLocation? {
        embeddedLocation
    }
}

enum MediaEmbeddedCaptureLocation {
    static func read(from url: URL, kind: MediaKind) async -> CaptureLocation? {
        switch kind {
        case .image:
            imageLocation(from: url)
        case .video:
            await videoLocation(from: url)
        }
    }

    static func parseISO6709(_ rawValue: String) -> CaptureLocation? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = #"^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?/?$"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(
                in: value,
                range: NSRange(value.startIndex..., in: value)
              ),
              let latitudeRange = Range(match.range(at: 1), in: value),
              let longitudeRange = Range(match.range(at: 2), in: value),
              let latitude = Double(value[latitudeRange]),
              let longitude = Double(value[longitudeRange]),
              (-90...90).contains(latitude),
              (-180...180).contains(longitude) else {
            return nil
        }
        return CaptureLocation(latitude: latitude, longitude: longitude)
    }

    private static func imageLocation(from url: URL) -> CaptureLocation? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any],
              let latitudeValue = number(gps[kCGImagePropertyGPSLatitude]),
              let longitudeValue = number(gps[kCGImagePropertyGPSLongitude]) else {
            return nil
        }

        return resolveExifCoordinates(
            latitude: latitudeValue,
            longitude: longitudeValue,
            latitudeReference: gps[kCGImagePropertyGPSLatitudeRef] as? String,
            longitudeReference: gps[kCGImagePropertyGPSLongitudeRef] as? String
        )
    }

    static func resolveExifCoordinates(
        latitude: Double,
        longitude: Double,
        latitudeReference: String?,
        longitudeReference: String?
    ) -> CaptureLocation? {
        guard latitude.isFinite,
              longitude.isFinite,
              latitude >= 0,
              longitude >= 0,
              let latitudeReference = latitudeReference?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .uppercased(),
              ["N", "S"].contains(latitudeReference),
              let longitudeReference = longitudeReference?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .uppercased(),
              ["E", "W"].contains(longitudeReference) else {
            return nil
        }
        let resolvedLatitude = latitudeReference == "S" ? -latitude : latitude
        let resolvedLongitude = longitudeReference == "W" ? -longitude : longitude
        guard (-90...90).contains(resolvedLatitude),
              (-180...180).contains(resolvedLongitude) else {
            return nil
        }
        return CaptureLocation(latitude: resolvedLatitude, longitude: resolvedLongitude)
    }

    private static func videoLocation(from url: URL) async -> CaptureLocation? {
        let asset = AVURLAsset(url: url)
        if let commonMetadata = try? await asset.load(.commonMetadata),
           let location = await location(in: commonMetadata) {
            return location
        }

        guard let formats = try? await asset.load(.availableMetadataFormats) else { return nil }
        for format in formats {
            guard let metadata = try? await asset.loadMetadata(for: format),
                  let location = await location(in: metadata) else {
                continue
            }
            return location
        }
        return nil
    }

    private static func location(in items: [AVMetadataItem]) async -> CaptureLocation? {
        for item in items {
            let identifier = item.identifier?.rawValue.lowercased() ?? ""
            guard item.commonKey == .commonKeyLocation || identifier.contains("location.iso6709") else {
                continue
            }
            if let value = try? await item.load(.stringValue),
               let location = parseISO6709(value) {
                return location
            }
        }
        return nil
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }
}
