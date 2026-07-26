import XCTest
@testable import afterimage

final class AuthenticationPolicyTests: XCTestCase {
    func testOnlyUnauthorizedAPIResponsesInvalidateTheSession() {
        XCTAssertTrue(AfterimageError.api(status: 401, code: "unauthorized", message: "expired").invalidatesSession)
        XCTAssertFalse(AfterimageError.api(status: 500, code: "internal_error", message: "retry").invalidatesSession)
        XCTAssertFalse(AfterimageError.invalidResponse.invalidatesSession)
    }
}
