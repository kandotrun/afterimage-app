import XCTest
@testable import afterimage

final class APIPathResolverTests: XCTestCase {
    func testResolvesRelativePlaybackAndUploadPathsAgainstAPIOrigin() throws {
        let base = URL(string: "https://afterimage.example.com")!
        XCTAssertEqual(
            try APIPathResolver.resolve("/v1/media/token", against: base).absoluteString,
            "https://afterimage.example.com/v1/media/token"
        )
    }

    func testKeepsAbsoluteURLsUntouched() throws {
        let base = URL(string: "https://afterimage.example.com")!
        XCTAssertEqual(
            try APIPathResolver.resolve("https://uploads.example.com/object", against: base).host,
            "uploads.example.com"
        )
    }
}
