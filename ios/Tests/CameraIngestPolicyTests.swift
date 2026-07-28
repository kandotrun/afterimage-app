import XCTest
@testable import afterimage

final class CameraIngestPolicyTests: XCTestCase {
    func testAcceptsOnlyWhenNoUploadOwnsThePipeline() {
        XCTAssertTrue(
            CameraIngestPolicy.canAccept(
                hasUploadTask: false,
                hasPendingBackgroundUpload: false
            )
        )
        XCTAssertFalse(
            CameraIngestPolicy.canAccept(
                hasUploadTask: true,
                hasPendingBackgroundUpload: false
            )
        )
        XCTAssertFalse(
            CameraIngestPolicy.canAccept(
                hasUploadTask: false,
                hasPendingBackgroundUpload: true
            )
        )
    }
}
