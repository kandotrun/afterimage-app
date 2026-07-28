import XCTest
@testable import afterimage

final class MediaCaptureDatePolicyTests: XCTestCase {
    func testUsesEmbeddedCaptureMetadata() throws {
        let embeddedDate = Date(timeIntervalSince1970: 200)

        let resolved = try MediaCaptureDatePolicy.resolve(embeddedDate: embeddedDate)

        XCTAssertEqual(resolved, embeddedDate)
    }

    func testDoesNotFallBackToUploadTimeWhenCaptureDateIsUnavailable() {
        XCTAssertThrowsError(
            try MediaCaptureDatePolicy.resolve(embeddedDate: nil)
        ) { error in
            guard case AfterimageError.captureDateUnavailable = error else {
                return XCTFail("Expected captureDateUnavailable, got \(error)")
            }
        }
    }
}
