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
              "location": { "latitude": 34.3853, "longitude": 132.4553 },
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
        XCTAssertEqual(page.assets[0].location, CaptureLocation(latitude: 34.3853, longitude: 132.4553))
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
          "agentAccessEnabled": false,
          "transcriptionStatus": "completed",
          "transcriptUrl": "/v1/assets/asset-2/transcript",
          "createdAt": "2026-07-27T01:03:00.000Z",
          "updatedAt": "2026-07-27T01:04:00.000Z"
        }
        """.data(using: .utf8)!
        let asset = try JSONDecoder.afterimage.decode(Asset.self, from: json)
        XCTAssertFalse(asset.agentAccessEnabled)
        XCTAssertTrue(asset.canShareWithAgent)
        XCTAssertEqual(asset.transcriptionStatus, .completed)
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
        XCTAssertNil(asset.location)
        XCTAssertTrue(asset.agentAccessEnabled)
        XCTAssertFalse(asset.canShareWithAgent)
    }

    func testCreateAssetEncodesCaptureLocation() throws {
        let request = CreateAssetRequest(
            mediaType: .image,
            sourceFingerprint: "photos:asset-1",
            filename: "memory.jpg",
            contentType: "image/jpeg",
            byteSize: 42,
            width: 1920,
            height: 1080,
            durationMs: nil,
            capturedAt: Date(timeIntervalSince1970: 1_774_761_600),
            location: CaptureLocation(latitude: 34.3853, longitude: 132.4553)
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder.afterimage.encode(request)) as? [String: Any]
        )
        let location = try XCTUnwrap(object["location"] as? [String: Double])
        XCTAssertEqual(location["latitude"], 34.3853)
        XCTAssertEqual(location["longitude"], 132.4553)
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

    func testDailyPlaybackDecodesCumulativeClipsAndFullTranscripts() throws {
        let json = """
        {
          "startAt": "2026-07-27T00:00:00.000Z",
          "endAt": "2026-07-28T00:00:00.000Z",
          "clipCount": 2,
          "durationMs": 3000,
          "clips": [
            {
              "asset": {
                "id": "asset-1",
                "kind": "video",
                "filename": "morning.mov",
                "contentType": "video/quicktime",
                "byteSize": 100,
                "capturedAt": "2026-07-27T00:10:00.000Z",
                "durationMs": 1000,
                "width": 1920,
                "height": 1080,
                "status": "ready",
                "contentUrl": "/v1/assets/asset-1/content",
                "thumbnailUrl": null,
                "transcriptionStatus": "completed",
                "transcriptPreview": "短いpreview",
                "transcriptUrl": "/v1/assets/asset-1/transcript",
                "createdAt": "2026-07-27T00:11:00.000Z",
                "updatedAt": "2026-07-27T00:12:00.000Z"
              },
              "startMs": 0,
              "endMs": 1000,
              "transcript": {
                "status": "completed",
                "language": "ja",
                "text": "朝の全文字幕です。",
                "updatedAt": "2026-07-27T00:12:00.000Z"
              }
            },
            {
              "asset": {
                "id": "asset-2",
                "kind": "video",
                "filename": "noon.mov",
                "contentType": "video/quicktime",
                "byteSize": 200,
                "capturedAt": "2026-07-27T00:20:00.000Z",
                "durationMs": 2000,
                "width": 1920,
                "height": 1080,
                "status": "ready",
                "contentUrl": "/v1/assets/asset-2/content",
                "thumbnailUrl": null,
                "transcriptionStatus": "pending",
                "transcriptPreview": null,
                "transcriptUrl": null,
                "createdAt": "2026-07-27T00:21:00.000Z",
                "updatedAt": "2026-07-27T00:22:00.000Z"
              },
              "startMs": 1000,
              "endMs": 3000,
              "transcript": {
                "status": "pending",
                "language": null,
                "text": null,
                "updatedAt": null
              }
            }
          ]
        }
        """.data(using: .utf8)!

        let playback = try JSONDecoder.afterimage.decode(DailyPlaybackResponse.self, from: json)
        XCTAssertEqual(playback.clipCount, 2)
        XCTAssertEqual(playback.durationMs, 3_000)
        XCTAssertEqual(playback.clips.map(\.asset.id), ["asset-1", "asset-2"])
        XCTAssertEqual(playback.clips[0].transcript.text, "朝の全文字幕です。")
        XCTAssertEqual(playback.clips[1].transcript.status, .pending)
        XCTAssertNil(playback.clips[1].transcript.text)
    }

    func testDailySummaryDecodesGeneratedAndEmptyResponses() throws {
        let generatedJSON = """
        {
          "startAt": "2026-07-27T00:00:00.000Z",
          "endAt": "2026-07-28T00:00:00.000Z",
          "summary": "検査書類を確認し、昼食後に車の設定を見直した。",
          "model": "qwen3.8-max-preview",
          "sourceTranscriptCount": 10,
          "generatedAt": "2026-07-28T00:05:00.000Z"
        }
        """.data(using: .utf8)!
        let generated = try JSONDecoder.afterimage.decode(DailySummaryResponse.self, from: generatedJSON)
        XCTAssertEqual(generated.summary, "検査書類を確認し、昼食後に車の設定を見直した。")
        XCTAssertEqual(generated.model, "qwen3.8-max-preview")
        XCTAssertEqual(generated.sourceTranscriptCount, 10)
        XCTAssertNotNil(generated.generatedAt)

        let emptyJSON = """
        {
          "startAt": "2026-07-27T00:00:00.000Z",
          "endAt": "2026-07-28T00:00:00.000Z",
          "summary": null,
          "model": null,
          "sourceTranscriptCount": 0,
          "generatedAt": null
        }
        """.data(using: .utf8)!
        let empty = try JSONDecoder.afterimage.decode(DailySummaryResponse.self, from: emptyJSON)
        XCTAssertNil(empty.summary)
        XCTAssertNil(empty.model)
        XCTAssertEqual(empty.sourceTranscriptCount, 0)
        XCTAssertNil(empty.generatedAt)
    }

    func testDailyWeatherPageDecodesStoredSnapshot() throws {
        let json = """
        {
          "items": [
            {
              "localDate": "2026-07-28",
              "symbolName": "cloud.sun.fill",
              "temperatureCelsius": 28.4,
              "highTemperatureCelsius": 31.2,
              "lowTemperatureCelsius": 24.8,
              "recordedAt": "2026-07-28T01:15:00.000Z",
              "attributionLegalUrl": "https://weatherkit.apple.com/legal-attribution.html",
              "attributionLightUrl": "https://example.com/weather-light.svg",
              "attributionDarkUrl": "https://example.com/weather-dark.svg"
            }
          ]
        }
        """.data(using: .utf8)!

        let page = try JSONDecoder.afterimage.decode(DailyWeatherPage.self, from: json)

        XCTAssertEqual(page.items.first?.localDate, "2026-07-28")
        XCTAssertEqual(page.items.first?.symbolName, "cloud.sun.fill")
        XCTAssertEqual(page.items.first?.temperatureCelsius, 28.4)
        XCTAssertEqual(page.items.first?.recordedAt, Date(timeIntervalSince1970: 1_785_201_300))
        XCTAssertEqual(page.items.first?.attributionLegalUrl.host(), "weatherkit.apple.com")
    }
}
