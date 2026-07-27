import XCTest
@testable import afterimage

final class PlaybackClockTests: XCTestCase {
    func testFormatsMinutesAndSeconds() {
        XCTAssertEqual(PlaybackClock.label(0), "0:00")
        XCTAssertEqual(PlaybackClock.label(65), "1:05")
        XCTAssertEqual(PlaybackClock.label(3_599), "59:59")
    }

    func testRejectsNonFiniteValues() {
        XCTAssertEqual(PlaybackClock.label(.nan), "0:00")
        XCTAssertEqual(PlaybackClock.label(.infinity), "0:00")
        XCTAssertEqual(PlaybackClock.label(-4), "0:00")
    }
}
