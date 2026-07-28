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

    func testFormatsCoordinatesAndBuildsAppleMapsURL() throws {
        let location = CaptureLocation(latitude: 34.3853, longitude: 132.4553)

        XCTAssertEqual(location.coordinateLabel, "34.38530, 132.45530")
        let url = try XCTUnwrap(location.appleMapsURL)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "maps.apple.com")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "ll" })?.value, "34.385300,132.455300")
    }
}
