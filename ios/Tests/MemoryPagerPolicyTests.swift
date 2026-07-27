import XCTest
@testable import afterimage

final class MemoryPagerPolicyTests: XCTestCase {
    func testDeletionInMiddleKeepsIndex() {
        XCTAssertEqual(MemoryPagerPolicy.selectionAfterDeletion(of: 1, count: 4), 1)
    }

    func testDeletionAtTailStepsBack() {
        XCTAssertEqual(MemoryPagerPolicy.selectionAfterDeletion(of: 3, count: 4), 2)
    }

    func testDeletionOfLastRemainingDismisses() {
        XCTAssertNil(MemoryPagerPolicy.selectionAfterDeletion(of: 0, count: 1))
    }
}
