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

    func testSelectedLocationlessAssetDoesNotReuseOpenedAssetLocation() {
        let opened = makeAsset(
            id: "opened",
            location: CaptureLocation(latitude: 34.3853, longitude: 132.4553)
        )
        let selected = makeAsset(id: "selected", location: nil)

        XCTAssertNil(MemoryPagerPolicy.visibleLocation(currentAsset: selected, openedAsset: opened))
        XCTAssertEqual(
            MemoryPagerPolicy.visibleLocation(currentAsset: nil, openedAsset: opened),
            opened.location
        )
    }

    private func makeAsset(id: String, location: CaptureLocation?) -> Asset {
        let date = Date(timeIntervalSince1970: 1_000)
        return Asset(
            id: id,
            mediaType: .image,
            status: .ready,
            filename: "memory.heic",
            contentType: "image/heic",
            byteSize: 1,
            width: nil,
            height: nil,
            durationMs: nil,
            capturedAt: date,
            location: location,
            createdAt: date,
            updatedAt: date,
            thumbnailUrl: nil,
            contentUrl: nil,
            transcriptionStatus: nil,
            transcriptPreview: nil,
            transcriptUrl: nil
        )
    }
}
