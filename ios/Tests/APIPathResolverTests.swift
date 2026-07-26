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

    func testClassifiesOnlyTheAPIOriginAsAuthenticated() throws {
        let resolver = APIPathResolver(baseURL: URL(string: "https://afterimage.example.com")!)
        XCTAssertTrue(resolver.isAPIOrigin(try resolver.resolve("/v1/assets")))
        XCTAssertTrue(resolver.isAPIOrigin(URL(string: "https://afterimage.example.com:443/v1/assets")!))
        XCTAssertFalse(resolver.isAPIOrigin(URL(string: "https://uploads.example.com/object")!))
        XCTAssertFalse(resolver.isAPIOrigin(URL(string: "http://afterimage.example.com/v1/assets")!))
    }

    func testRejectsInsecureAbsoluteURLFromHTTPSAPI() {
        let base = URL(string: "https://afterimage.example.com")!
        XCTAssertThrowsError(try APIPathResolver.resolve("http://uploads.example.com/object", against: base))
    }
}
