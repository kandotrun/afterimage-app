import XCTest
@testable import afterimage

final class TimelineGridLayoutTests: XCTestCase {
    func testThreeColumnGridProducesSquareCellsWithTwoPointGaps() {
        let layout = TimelineGridLayout(containerWidth: 390)

        XCTAssertEqual(layout.columns.count, 3)
        XCTAssertEqual(layout.spacing, 2)
        XCTAssertEqual(layout.cellLength, (390 - 4) / 3, accuracy: 0.001)
        XCTAssertEqual(layout.cellSize.width, layout.cellSize.height)
    }

    func testGridNeverProducesNegativeCells() {
        let layout = TimelineGridLayout(containerWidth: 2)
        XCTAssertEqual(layout.cellLength, 0)
    }
}
