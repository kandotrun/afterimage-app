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
              "transcriptionStatus": "completed",
              "transcriptPreview": "海沿いを歩いた。風の音が強かった。",
              "transcriptUrl": "/v1/assets/asset-1/transcript",
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
        XCTAssertEqual(page.assets[0].transcriptionStatus, .completed)
        XCTAssertEqual(page.assets[0].transcriptPreview, "海沿いを歩いた。風の音が強かった。")
        XCTAssertEqual(page.assets[0].transcriptUrl, "/v1/assets/asset-1/transcript")
    }

    func testResolverKeepsQuerySeparateFromPath() throws {
        let resolver = APIPathResolver(baseURL: URL(string: "https://api.example.com")!)
        let url = try resolver.resolve("/v1/assets?limit=40&cursor=abc")
        XCTAssertEqual(url.path, "/v1/assets")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.count, 2)
    }

    func testAssetDecodesTranscriptionFields() throws {
        let json = """
        {
          "id": "asset-2",
          "kind": "video",
          "filename": "memory.mov",
          "contentType": "video/quicktime",
          "byteSize": 99,
          "capturedAt": "2026-07-27T01:02:03.000Z",
          "durationMs": 1000,
          "width": 1080,
          "height": 1920,
          "status": "ready",
          "contentUrl": "/v1/assets/asset-2/content",
          "thumbnailUrl": "/v1/assets/asset-2/thumbnail",
          "transcriptionStatus": "completed",
          "transcriptUrl": "/v1/assets/asset-2/transcript",
          "createdAt": "2026-07-27T01:03:00.000Z",
          "updatedAt": "2026-07-27T01:04:00.000Z"
        }
        """.data(using: .utf8)!
        let asset = try JSONDecoder.afterimage.decode(Asset.self, from: json)
        XCTAssertEqual(asset.transcriptionStatus, "completed")
        XCTAssertEqual(asset.transcriptUrl, "/v1/assets/asset-2/transcript")
    }

    func testAssetToleratesMissingTranscriptionFields() throws {
        let json = """
        {
          "id": "asset-3",
          "kind": "photo",
          "filename": "memory.heic",
          "contentType": "image/heic",
          "byteSize": 42,
          "capturedAt": "2026-07-27T01:02:03.000Z",
          "status": "ready",
          "contentUrl": "/v1/assets/asset-3/content",
          "thumbnailUrl": null,
          "createdAt": "2026-07-27T01:03:00.000Z",
          "updatedAt": "2026-07-27T01:04:00.000Z"
        }
        """.data(using: .utf8)!
        let asset = try JSONDecoder.afterimage.decode(Asset.self, from: json)
        XCTAssertNil(asset.transcriptionStatus)
        XCTAssertNil(asset.transcriptUrl)
    }

    func testTranscriptResponseDecodes() throws {
        let json = """
        {
          "assetId": "asset-2",
          "status": "completed",
          "language": "ja",
          "text": "こんにちは",
          "updatedAt": "2026-07-27T01:05:00.000Z"
        }
        """.data(using: .utf8)!
        let transcript = try JSONDecoder.afterimage.decode(TranscriptResponse.self, from: json)
        XCTAssertEqual(transcript.text, "こんにちは")
        XCTAssertEqual(transcript.language, "ja")
        XCTAssertEqual(transcript.status, "completed")
    }
}
