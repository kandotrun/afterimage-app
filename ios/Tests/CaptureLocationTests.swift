import Foundation
import XCTest
@testable import afterimage

final class CaptureLocationTests: XCTestCase {
    func testUsesEmbeddedCaptureLocation() {
        let embedded = CaptureLocation(latitude: -33.8688, longitude: 151.2093)

        XCTAssertEqual(
            MediaCaptureLocationPolicy.resolve(embeddedLocation: embedded),
            embedded
        )
    }

    func testReturnsNilWhenEmbeddedLocationIsUnavailable() {
        XCTAssertNil(MediaCaptureLocationPolicy.resolve(embeddedLocation: nil))
    }

    func testParsesQuickTimeISO6709LocationAndIgnoresAltitude() {
        XCTAssertEqual(
            MediaEmbeddedCaptureLocation.parseISO6709("+34.38530+132.45530+001.200/"),
            CaptureLocation(latitude: 34.3853, longitude: 132.4553)
        )
        XCTAssertEqual(
            MediaEmbeddedCaptureLocation.parseISO6709("-33.86880+151.20930/"),
            CaptureLocation(latitude: -33.8688, longitude: 151.2093)
        )
    }

    func testRejectsMalformedOrOutOfRangeISO6709Location() {
        XCTAssertNil(MediaEmbeddedCaptureLocation.parseISO6709("34.3853,132.4553"))
        XCTAssertNil(MediaEmbeddedCaptureLocation.parseISO6709("+91.0000+132.4553/"))
        XCTAssertNil(MediaEmbeddedCaptureLocation.parseISO6709("+34.3853+181.0000/"))
    }

    func testBuildsAppleMapsURL() throws {
        let location = CaptureLocation(latitude: 34.3853, longitude: 132.4553)

        let url = try XCTUnwrap(location.appleMapsURL)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "maps.apple.com")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "ll" })?.value, "34.385300,132.455300")
    }

    func testReadablePlaceNamePrefersShortAddress() {
        XCTAssertEqual(
            CapturePlaceNameFormatter.label(
                shortAddress: "広島市西区楠木町4丁目",
                cityWithContext: "広島市, 日本",
                fullAddress: "日本、〒733-0002 広島県広島市西区楠木町4丁目",
                pointOfInterestName: "楠木町"
            ),
            "広島市西区楠木町4丁目"
        )
    }

    func testReadablePlaceNameFallsBackToContextualCity() {
        XCTAssertEqual(
            CapturePlaceNameFormatter.label(
                shortAddress: "   ",
                cityWithContext: "広島市, 日本",
                fullAddress: nil,
                pointOfInterestName: nil
            ),
            "広島市, 日本"
        )
    }

    func testReadablePlaceNameNormalizesMultilineFullAddress() {
        XCTAssertEqual(
            CapturePlaceNameFormatter.label(
                shortAddress: nil,
                cityWithContext: nil,
                fullAddress: "1 Infinite Loop\nCupertino, CA",
                pointOfInterestName: nil
            ),
            "1 Infinite Loop, Cupertino, CA"
        )
    }

    func testReadablePlaceNameFallsBackToPointOfInterest() {
        XCTAssertEqual(
            CapturePlaceNameFormatter.label(
                shortAddress: nil,
                cityWithContext: nil,
                fullAddress: nil,
                pointOfInterestName: "横川駅"
            ),
            "横川駅"
        )
    }

    func testReadablePlaceNameRejectsBlankValues() {
        XCTAssertNil(
            CapturePlaceNameFormatter.label(
                shortAddress: " ",
                cityWithContext: "\n",
                fullAddress: nil,
                pointOfInterestName: ""
            )
        )
    }

    func testReadablePlaceNameRejectsCoordinatePairs() {
        XCTAssertNil(
            CapturePlaceNameFormatter.label(
                shortAddress: nil,
                cityWithContext: nil,
                fullAddress: nil,
                pointOfInterestName: "34.42120, 132.45510"
            )
        )
    }

    func testReadablePlaceLabelUsesMatchingResolution() {
        let location = CaptureLocation(latitude: 34.4212, longitude: 132.4551)
        let resolvedPlace = ResolvedCapturePlace(location: location, name: "広島市西区")

        XCTAssertEqual(
            CapturePlaceNamePresentation.label(
                for: location,
                resolvedPlace: resolvedPlace,
                fallback: "マップで見る"
            ),
            "広島市西区"
        )
    }

    func testReadablePlaceLabelDoesNotReuseStaleResolution() {
        let previousLocation = CaptureLocation(latitude: 34.4212, longitude: 132.4551)
        let currentLocation = CaptureLocation(latitude: 35.6812, longitude: 139.7671)
        let resolvedPlace = ResolvedCapturePlace(location: previousLocation, name: "広島市西区")

        XCTAssertEqual(
            CapturePlaceNamePresentation.label(
                for: currentLocation,
                resolvedPlace: resolvedPlace,
                fallback: "マップで見る"
            ),
            "マップで見る"
        )
    }

    func testResolverCachesSuccessfulResult() async {
        let spy = CapturePlaceNameResolverSpy(result: "広島市西区")
        let resolver = CapturePlaceNameResolver(
            failureRetryInterval: 60,
            reverseGeocode: { location in await spy.resolve(location) }
        )
        let location = CaptureLocation(latitude: 34.4212, longitude: 132.4551)

        let firstName = await resolver.name(for: location)
        let secondName = await resolver.name(for: location)
        let metrics = await spy.metrics()

        XCTAssertEqual(firstName, "広島市西区")
        XCTAssertEqual(secondName, "広島市西区")
        XCTAssertEqual(metrics.calls, 1)
    }

    func testResolverSerializesDistinctRequests() async {
        let spy = CapturePlaceNameResolverSpy(result: "場所", blocksFirstRequest: true)
        let resolver = CapturePlaceNameResolver(
            failureRetryInterval: 60,
            reverseGeocode: { location in await spy.resolve(location) }
        )
        let firstLocation = CaptureLocation(latitude: 34.4212, longitude: 132.4551)
        let secondLocation = CaptureLocation(latitude: 35.6812, longitude: 139.7671)

        let firstRequest = Task { await resolver.name(for: firstLocation) }
        await spy.waitUntilFirstCallStarts()
        let secondRequest = Task { await resolver.name(for: secondLocation) }
        while await resolver.queuedRequestCount < 1 {
            await Task.yield()
        }
        let queuedMetrics = await spy.metrics()

        XCTAssertEqual(queuedMetrics.calls, 1)
        XCTAssertEqual(queuedMetrics.maximumConcurrent, 1)

        await spy.releaseFirstCall()
        let firstName = await firstRequest.value
        let secondName = await secondRequest.value
        let completedMetrics = await spy.metrics()

        XCTAssertEqual(firstName, "場所")
        XCTAssertEqual(secondName, "場所")
        XCTAssertEqual(completedMetrics.calls, 2)
        XCTAssertEqual(completedMetrics.maximumConcurrent, 1)
    }

    func testResolverBacksOffAfterFailure() async {
        let spy = CapturePlaceNameResolverSpy(result: nil)
        let resolver = CapturePlaceNameResolver(
            failureRetryInterval: 60,
            reverseGeocode: { location in await spy.resolve(location) }
        )
        let location = CaptureLocation(latitude: 34.4212, longitude: 132.4551)

        let firstName = await resolver.name(for: location)
        let secondName = await resolver.name(for: location)
        let metrics = await spy.metrics()

        XCTAssertNil(firstName)
        XCTAssertNil(secondName)
        XCTAssertEqual(metrics.calls, 1)
    }
}

private actor CapturePlaceNameResolverSpy {
    private let result: String?
    private let blocksFirstRequest: Bool
    private var calls = 0
    private var active = 0
    private var maximumConcurrent = 0
    private var firstCallContinuation: CheckedContinuation<Void, Never>?

    init(result: String?, blocksFirstRequest: Bool = false) {
        self.result = result
        self.blocksFirstRequest = blocksFirstRequest
    }

    func resolve(_ location: CaptureLocation) async -> String? {
        calls += 1
        let callNumber = calls
        active += 1
        maximumConcurrent = max(maximumConcurrent, active)
        if blocksFirstRequest && callNumber == 1 {
            await withCheckedContinuation { continuation in
                firstCallContinuation = continuation
            }
        }
        active -= 1
        return result
    }

    func waitUntilFirstCallStarts() async {
        while calls == 0 {
            await Task.yield()
        }
    }

    func releaseFirstCall() {
        firstCallContinuation?.resume()
        firstCallContinuation = nil
    }

    func metrics() -> (calls: Int, maximumConcurrent: Int) {
        (calls, maximumConcurrent)
    }
}
