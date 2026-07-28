import XCTest
@testable import afterimage

final class TimelineLocalizationTests: XCTestCase {
    func testTimelineTitleResolvesFromCatalog() {
        let title = L10n.string("timeline.title")

        XCTAssertNotEqual(title, "timeline.title")
    }
}
