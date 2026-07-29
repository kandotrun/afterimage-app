import XCTest
@testable import afterimage

final class DailyWeatherBackfillPlanTests: XCTestCase {
    func testPlansNewestMissingPastDaysFromLocatedReadyAssets() throws {
        let calendar = tokyoCalendar()
        let now = try makeDate("2026-07-29T03:00:00Z")
        let july30 = try makeDate("2026-07-30T03:00:00Z")
        let july29 = try makeDate("2026-07-29T01:00:00Z")
        let july28Newer = try makeDate("2026-07-28T04:00:00Z")
        let july28Older = try makeDate("2026-07-28T03:33:00Z")
        let july27 = try makeDate("2026-07-27T09:00:00Z")
        let july26 = try makeDate("2026-07-26T09:00:00Z")

        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
                makeAsset(id: "future", capturedAt: july30, location: location(34.38, 132.45)),
                makeAsset(id: "today", capturedAt: july29, location: location(34.38, 132.45)),
                makeAsset(id: "newer-yesterday", capturedAt: july28Newer, location: location(34.42, 132.46)),
                makeAsset(id: "older-yesterday", capturedAt: july28Older, location: location(35.68, 139.76)),
                makeAsset(id: "locationless", capturedAt: july27, location: nil),
                makeAsset(id: "stored", capturedAt: july26, location: location(34.39, 132.44)),
            ],
            storedLocalDates: ["2026-07-26"],
            now: now,
            limit: 7,
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-28"])
        XCTAssertEqual(requests.first?.capturedAt, july28Newer)
        XCTAssertEqual(requests.first?.location, location(34.42, 132.46))
    }

    func testHonorsLimitAfterSkippingIneligibleDays() throws {
        let calendar = tokyoCalendar()
        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
                makeAsset(
                    id: "future",
                    capturedAt: try makeDate("2026-07-30T03:00:00Z"),
                    location: location(34.38, 132.45)
                ),
                makeAsset(
                    id: "newest-located",
                    capturedAt: try makeDate("2026-07-28T03:33:00Z"),
                    location: location(34.42, 132.46)
                ),
                makeAsset(
                    id: "locationless",
                    capturedAt: try makeDate("2026-07-27T09:00:00Z"),
                    location: nil
                ),
                makeAsset(
                    id: "oldest-located",
                    capturedAt: try makeDate("2026-07-26T09:00:00Z"),
                    location: location(34.39, 132.44)
                ),
            ],
            storedLocalDates: [],
            now: try makeDate("2026-07-29T03:00:00Z"),
            limit: 1,
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-28"])
    }

    func testHistoricalQueryWindowAndDaySelectionUseAbsoluteDates() throws {
        let capturedAt = try makeDate("2026-07-28T03:33:00Z")
        let previousTokyoMidnight = try makeDate("2026-07-27T15:00:00Z")
        let nextTokyoMidnight = try makeDate("2026-07-28T15:00:00Z")

        let interval = DailyWeatherHistoricalSelection.queryInterval(around: capturedAt)
        let selected = DailyWeatherHistoricalSelection.dayStart(
            from: [nextTokyoMidnight, previousTokyoMidnight],
            containing: capturedAt
        )

        XCTAssertEqual(interval.start, capturedAt.addingTimeInterval(-36 * 60 * 60))
        XCTAssertEqual(interval.end, capturedAt.addingTimeInterval(36 * 60 * 60))
        XCTAssertEqual(selected, previousTokyoMidnight)
    }

    func testHistoricalDaySelectionFailsInsteadOfUsingAFutureDay() throws {
        let capturedAt = try makeDate("2026-07-28T03:33:00Z")
        let futureStart = try makeDate("2026-07-28T15:00:00Z")

        XCTAssertNil(
            DailyWeatherHistoricalSelection.dayStart(
                from: [futureStart],
                containing: capturedAt
            )
        )
    }

    @MainActor
    func testExecutorPreservesExistingWeatherWithoutGeneratingAReplacement() async throws {
        let request = try makeRequest()
        let existing = makeWeather(localDate: request.localDate, symbolName: "cloud.sun")
        var snapshotCalls = 0
        var saveCalls = 0

        let weather = await DailyWeatherBackfillExecutor.execute(
            requests: [request],
            existingWeather: { _ in existing },
            snapshot: { _ in
                snapshotCalls += 1
                throw TestError.unexpectedCall
            },
            save: { _ in
                saveCalls += 1
                throw TestError.unexpectedCall
            }
        )

        XCTAssertEqual(weather, [existing])
        XCTAssertEqual(snapshotCalls, 0)
        XCTAssertEqual(saveCalls, 0)
    }

    @MainActor
    func testExecutorFailsClosedWhenExistingWeatherProbeFails() async throws {
        let request = try makeRequest()
        var snapshotCalls = 0
        var saveCalls = 0

        let weather = await DailyWeatherBackfillExecutor.execute(
            requests: [request],
            existingWeather: { _ in throw TestError.probeFailed },
            snapshot: { _ in
                snapshotCalls += 1
                throw TestError.unexpectedCall
            },
            save: { _ in
                saveCalls += 1
                throw TestError.unexpectedCall
            }
        )

        XCTAssertTrue(weather.isEmpty)
        XCTAssertEqual(snapshotCalls, 0)
        XCTAssertEqual(saveCalls, 0)
    }

    @MainActor
    func testExecutorCreatesWeatherAfterConfirmingTheDateIsMissing() async throws {
        let request = try makeRequest()
        let draft = makeDraft(localDate: request.localDate)
        let saved = makeWeather(localDate: request.localDate, symbolName: draft.symbolName)
        var probeCalls = 0
        var snapshotCalls = 0
        var saveCalls = 0

        let weather = await DailyWeatherBackfillExecutor.execute(
            requests: [request],
            existingWeather: { _ in
                probeCalls += 1
                return nil
            },
            snapshot: { received in
                snapshotCalls += 1
                XCTAssertEqual(received, request)
                return draft
            },
            save: { received in
                saveCalls += 1
                XCTAssertEqual(received.localDate, draft.localDate)
                return saved
            }
        )

        XCTAssertEqual(weather, [saved])
        XCTAssertEqual(probeCalls, 1)
        XCTAssertEqual(snapshotCalls, 1)
        XCTAssertEqual(saveCalls, 1)
    }

    private enum TestError: Error {
        case probeFailed
        case unexpectedCall
    }

    private func makeRequest() throws -> DailyWeatherBackfillRequest {
        DailyWeatherBackfillRequest(
            localDate: "2026-07-28",
            capturedAt: try makeDate("2026-07-28T03:33:00Z"),
            location: location(34.42, 132.46)
        )
    }

    private func makeWeather(localDate: String, symbolName: String) -> DailyWeather {
        DailyWeather(
            localDate: localDate,
            symbolName: symbolName,
            temperatureCelsius: 30,
            highTemperatureCelsius: 34,
            lowTemperatureCelsius: 26,
            recordedAt: Date(timeIntervalSince1970: 1_785_210_780),
            attributionLegalUrl: URL(string: "https://example.com/legal")!,
            attributionLightUrl: URL(string: "https://example.com/light")!,
            attributionDarkUrl: URL(string: "https://example.com/dark")!
        )
    }

    private func makeDraft(localDate: String) -> DailyWeatherDraft {
        DailyWeatherDraft(
            localDate: localDate,
            symbolName: "sun.max",
            temperatureCelsius: 30,
            highTemperatureCelsius: 34,
            lowTemperatureCelsius: 26,
            recordedAt: Date(timeIntervalSince1970: 1_785_210_780),
            attributionLegalUrl: URL(string: "https://example.com/legal")!,
            attributionLightUrl: URL(string: "https://example.com/light")!,
            attributionDarkUrl: URL(string: "https://example.com/dark")!
        )
    }

    private func makeAsset(
        id: String,
        capturedAt: Date,
        location: CaptureLocation?
    ) -> Asset {
        Asset(
            id: id,
            mediaType: .video,
            status: .ready,
            filename: "memory.mov",
            contentType: "video/quicktime",
            byteSize: 1,
            width: nil,
            height: nil,
            durationMs: 1_000,
            capturedAt: capturedAt,
            location: location,
            createdAt: capturedAt,
            updatedAt: capturedAt,
            thumbnailUrl: nil,
            contentUrl: nil,
            transcriptionStatus: .completed,
            transcriptPreview: nil,
            transcriptUrl: nil
        )
    }

    private func tokyoCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 9 * 60 * 60)!
        return calendar
    }

    private func makeDate(_ value: String) throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: value))
    }

    private func location(_ latitude: Double, _ longitude: Double) -> CaptureLocation {
        CaptureLocation(latitude: latitude, longitude: longitude)
    }
}
