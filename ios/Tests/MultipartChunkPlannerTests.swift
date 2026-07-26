import XCTest
@testable import afterimage

final class MultipartChunkPlannerTests: XCTestCase {
    func testPlansEqualNonFinalPartsAndShortFinalPart() throws {
        let chunks = try MultipartChunkPlanner.plan(fileSize: 10_485_763, partSize: 5_242_880)
        XCTAssertEqual(chunks, [
            UploadChunk(partNumber: 1, offset: 0, length: 5_242_880),
            UploadChunk(partNumber: 2, offset: 5_242_880, length: 5_242_880),
            UploadChunk(partNumber: 3, offset: 10_485_760, length: 3),
        ])
    }

    func testRejectsInvalidSizes() {
        XCTAssertThrowsError(try MultipartChunkPlanner.plan(fileSize: 0, partSize: 5_242_880))
        XCTAssertThrowsError(try MultipartChunkPlanner.plan(fileSize: 10, partSize: 0))
    }
}
