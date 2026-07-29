import CoreLocation
import Foundation
import MapKit

enum CapturePlaceNameFormatter {
    static func label(
        shortAddress: String?,
        cityWithContext: String?,
        fullAddress: String?,
        pointOfInterestName: String?
    ) -> String? {
        [shortAddress, cityWithContext, fullAddress, pointOfInterestName]
            .compactMap(normalized)
            .first
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let components = value
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !components.isEmpty else { return nil }
        return components.joined(separator: ", ")
    }
}

actor CapturePlaceNameResolver {
    static let shared = CapturePlaceNameResolver()

    private var cachedNames: [CaptureLocation: String] = [:]
    private var inFlight: [CaptureLocation: Task<String?, Never>] = [:]

    func name(for location: CaptureLocation) async -> String? {
        if let cachedName = cachedNames[location] {
            return cachedName
        }
        if let request = inFlight[location] {
            return await request.value
        }

        let request = Task { await Self.resolve(location) }
        inFlight[location] = request
        let name = await request.value
        inFlight[location] = nil
        if let name {
            cachedNames[location] = name
        }
        return name
    }

    private static func resolve(_ location: CaptureLocation) async -> String? {
        let coordinate = CLLocation(latitude: location.latitude, longitude: location.longitude)
        guard let request = MKReverseGeocodingRequest(location: coordinate) else { return nil }
        request.preferredLocale = .autoupdatingCurrent
        guard let mapItems = try? await request.mapItems, let mapItem = mapItems.first else {
            return nil
        }
        return CapturePlaceNameFormatter.label(
            shortAddress: mapItem.address?.shortAddress,
            cityWithContext: mapItem.addressRepresentations?.cityWithContext,
            fullAddress: mapItem.address?.fullAddress,
            pointOfInterestName: mapItem.name
        )
    }
}
