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
        let normalizedValue = components.joined(separator: ", ")
        guard !isCoordinatePair(normalizedValue) else { return nil }
        return normalizedValue
    }

    private static func isCoordinatePair(_ value: String) -> Bool {
        let components = value.split(separator: ",", omittingEmptySubsequences: false)
        guard components.count == 2 else { return false }
        let values = components.compactMap {
            Double($0.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        guard values.count == 2 else { return false }
        return (-90 ... 90).contains(values[0]) && (-180 ... 180).contains(values[1])
    }
}

struct ResolvedCapturePlace: Equatable, Sendable {
    let location: CaptureLocation
    let name: String?
}

enum CapturePlaceNamePresentation {
    static func label(
        for location: CaptureLocation,
        resolvedPlace: ResolvedCapturePlace?,
        fallback: String
    ) -> String {
        guard
            let resolvedPlace,
            resolvedPlace.location == location,
            let name = resolvedPlace.name
        else {
            return fallback
        }
        return name
    }
}

actor CapturePlaceNameResolver {
    typealias ReverseGeocode = @Sendable (CaptureLocation) async -> String?

    static let shared = CapturePlaceNameResolver(
        failureRetryInterval: 60,
        reverseGeocode: { location in await CapturePlaceNameResolver.resolve(location) }
    )

    private let failureRetryInterval: TimeInterval
    private let reverseGeocode: ReverseGeocode
    private var cachedNames: [CaptureLocation: String] = [:]
    private var cacheOrder: [CaptureLocation] = []
    private var failedUntil: [CaptureLocation: Date] = [:]
    private var inFlight: [CaptureLocation: Task<String?, Never>] = [:]
    private var requestActive = false
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private let maximumCacheEntries = 256

    var queuedRequestCount: Int {
        requestWaiters.count
    }

    init(
        failureRetryInterval: TimeInterval,
        reverseGeocode: @escaping ReverseGeocode
    ) {
        self.failureRetryInterval = failureRetryInterval
        self.reverseGeocode = reverseGeocode
    }

    func name(for location: CaptureLocation) async -> String? {
        if let cachedName = cachedNames[location] {
            return cachedName
        }
        if let retryDate = failedUntil[location], retryDate > Date() {
            return nil
        }
        failedUntil[location] = nil
        if let request = inFlight[location] {
            return await request.value
        }

        let request = Task { await performReverseGeocode(for: location) }
        inFlight[location] = request
        let name = await request.value
        inFlight[location] = nil
        if let name {
            cache(name, for: location)
        } else {
            failedUntil[location] = Date().addingTimeInterval(failureRetryInterval)
        }
        return name
    }

    private func performReverseGeocode(for location: CaptureLocation) async -> String? {
        await acquireRequestSlot()
        let name = await reverseGeocode(location)
        releaseRequestSlot()
        return name
    }

    private func acquireRequestSlot() async {
        guard requestActive else {
            requestActive = true
            return
        }
        await withCheckedContinuation { continuation in
            requestWaiters.append(continuation)
        }
    }

    private func releaseRequestSlot() {
        guard !requestWaiters.isEmpty else {
            requestActive = false
            return
        }
        requestWaiters.removeFirst().resume()
    }

    private func cache(_ name: String, for location: CaptureLocation) {
        if cachedNames[location] == nil {
            cacheOrder.append(location)
        }
        cachedNames[location] = name
        failedUntil[location] = nil
        while cacheOrder.count > maximumCacheEntries {
            cachedNames[cacheOrder.removeFirst()] = nil
        }
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
