import XCTest
@testable import afterimage

final class APIContractTests: XCTestCase {
    func testTimelineDecodesBackendItemsAndNullableThumbnail() throws {
        let json = """
        {
          "items": [
            {
              "id": "asset-1",
              "kind": "video",
              "filename": "memory.mov",
              "contentType": "video/quicktime",
              "byteSize": 1234,
              "capturedAt": "2026-07-27T01:02:03.000Z",
              "durationMs": 4200,
              "width": 1080,
              "height": 1920,
              "status": "ready",
              "contentUrl": "/v1/assets/asset-1/content",
              "thumbnailUrl": null,
              "createdAt": "2026-07-27T01:03:00.000Z",
              "updatedAt": "2026-07-27T01:04:00.000Z"
            }
          ],
          "nextCursor": null
        }
        """.data(using: .utf8)!

        let page = try JSONDecoder.afterimage.decode(TimelinePage.self, from: json)
        XCTAssertEqual(page.assets.count, 1)
        XCTAssertEqual(page.assets[0].mediaType, .video)
        XCTAssertNil(page.assets[0].thumbnailUrl)
        XCTAssertEqual(page.assets[0].durationMs, 4_200)
    }

    func testResolverKeepsQuerySeparateFromPath() throws {
        let resolver = APIPathResolver(baseURL: URL(string: "https://api.example.com")!)
        let url = try resolver.resolve("/v1/assets?limit=40&cursor=abc")
        XCTAssertEqual(url.path, "/v1/assets")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.count, 2)
    }
}
