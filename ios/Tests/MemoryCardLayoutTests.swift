import XCTest
@testable import afterimage

final class MemoryCardLayoutTests: XCTestCase {
    func testPhoneCardLeavesTheNextMemoryPeekingIn() {
        let layout = MemoryCardLayout(containerWidth: 390)

        XCTAssertEqual(layout.cardWidth, 342, accuracy: 0.001)
        XCTAssertEqual(layout.mediaHeight, layout.cardWidth * 0.72, accuracy: 0.001)
        XCTAssertLessThan(layout.cardWidth, 390)
    }

    func testWideScreensCapCardWidthInsteadOfStretching() {
        let layout = MemoryCardLayout(containerWidth: 1_024)
        XCTAssertEqual(layout.cardWidth, 420)
    }
}