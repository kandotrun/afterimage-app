import XCTest
@testable import afterimage

final class UploadPlanTests: XCTestCase {
    func testDecodesSingleUploadPlan() throws {
        let data = Data(#"{"mode":"single","url":"/v1/assets/a/upload"}"#.utf8)
        let plan = try JSONDecoder().decode(UploadPlan.self, from: data)
        XCTAssertEqual(plan.mode, .single)
        XCTAssertEqual(plan.url, "/v1/assets/a/upload")
    }

    func testDecodesMultipartUploadPlanAndBuildsPartPath() throws {
        let data = Data(#"{"mode":"multipart","partSize":5242880,"partCount":2,"partUrlTemplate":"/v1/assets/a/upload/parts/{partNumber}"}"#.utf8)
        let plan = try JSONDecoder().decode(UploadPlan.self, from: data)
        XCTAssertEqual(plan.mode, .multipart)
        XCTAssertEqual(plan.partSize, 5_242_880)
        XCTAssertEqual(try plan.path(forPart: 2), "/v1/assets/a/upload/parts/2")
    }
}
