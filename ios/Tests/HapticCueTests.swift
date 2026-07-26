import XCTest
@testable import afterimage

final class HapticCueTests: XCTestCase {
    func testSuccessCueHasAConfirmingDoublePulse() {
        let events = HapticCue.success.events
        XCTAssertEqual(events.count, 2)
        XCTAssertLessThan(events[0].relativeTime, events[1].relativeTime)
        XCTAssertGreaterThan(events[1].intensity, events[0].intensity)
    }

    func testProgressCueStaysSubtle() {
        let event = HapticCue.progress.events.first
        XCTAssertNotNil(event)
        XCTAssertLessThanOrEqual(event?.intensity ?? 1, 0.25)
    }

    func testFailureCueDiffersFromSuccess() {
        XCTAssertNotEqual(HapticCue.failure.events, HapticCue.success.events)
    }
}
