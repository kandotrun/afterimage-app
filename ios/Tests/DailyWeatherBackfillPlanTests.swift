import XCTest
@testable import afterimage

final class DailyWeatherBackfillPlanTests: XCTestCase {
    func testPlansNewestMissingDaysFromLocatedAssets() throws {
        let calendar = makeCalendar()
        let july29 = try makeDate("2026-07-29T01:00:00Z")
        let july28 = try makeDate("2026-07-28T03:33:00Z")
        let july27 = try makeDate("2026-07-27T09:00:00Z")
        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
                makeAsset(id: "today", capturedAt: july29, location: location(34.38, 132.45)),
                makeAsset(id: "newer-without-location", capturedAt: july28.addingTimeInterval(300), location: nil),
                makeAsset(id: "yesterday", capturedAt: july28, location: location(34.42, 132.46)),
                makeAsset(id: "older", capturedAt: july27, location: location(35.68, 139.76)),
            ],
            storedLocalDates: ["2026-07-29"],
            limit: 7,
            now: try makeDate("2026-07-29T05:00:00Z"),
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-28", "2026-07-27"])
        XCTAssertEqual(requests.first?.capturedAt, july28)
        XCTAssertEqual(requests.first?.location, location(34.42, 132.46))
    }

    func testSkipsDaysWithoutLocationAndHonorsLimit() throws {
        let calendar = makeCalendar()
        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
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
            limit: 1,
            now: try makeDate("2026-07-29T05:00:00Z"),
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-28"])
    }

    func testSkipsCurrentAndFutureDaysEvenWhenTheyAreMissing() throws {
        let calendar = makeCalendar()
        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
                makeAsset(
                    id: "future",
                    capturedAt: try makeDate("2026-07-30T01:00:00Z"),
                    location: location(34.38, 132.45)
                ),
                makeAsset(
                    id: "today",
                    capturedAt: try makeDate("2026-07-29T01:00:00Z"),
                    location: location(34.38, 132.45)
                ),
                makeAsset(
                    id: "yesterday",
                    capturedAt: try makeDate("2026-07-28T03:33:00Z"),
                    location: location(34.42, 132.46)
                ),
            ],
            storedLocalDates: [],
            now: try makeDate("2026-07-29T05:00:00Z"),
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-28"])
    }

    func testIncludesSevenDaysAgoAndExcludesEightDaysAgo() throws {
        let calendar = makeCalendar()
        let requests = DailyWeatherBackfillPlan.requests(
            assets: [
                makeAsset(
                    id: "seven-days-ago",
                    capturedAt: try makeDate("2026-07-22T03:00:00Z"),
                    location: location(34.42, 132.46)
                ),
                makeAsset(
                    id: "eight-days-ago",
                    capturedAt: try makeDate("2026-07-21T03:00:00Z"),
                    location: location(35.68, 139.76)
                ),
            ],
            storedLocalDates: [],
            now: try makeDate("2026-07-29T05:00:00Z"),
            calendar: calendar
        )

        XCTAssertEqual(requests.map(\.localDate), ["2026-07-22"])
    }

    func testSelectsTheDailyStartBeforeCaptureInsteadOfTheNearestFutureStart() throws {
        let previousStart = try makeDate("2026-07-27T15:00:00Z")
        let nextStart = try makeDate("2026-07-28T15:00:00Z")
        let capturedAt = try makeDate("2026-07-28T14:50:00Z")

        XCTAssertEqual(
            DailyWeatherBackfillSelection.dayStart(
                for: capturedAt,
                from: [previousStart, nextStart]
            ),
            previousStart
        )
    }

    func testSelectsTheHourNearestToCapture() throws {
        let capturedAt = try makeDate("2026-07-28T03:33:00Z")
        let earlier = try makeDate("2026-07-28T03:00:00Z")
        let later = try makeDate("2026-07-28T04:00:00Z")

        XCTAssertEqual(
            DailyWeatherBackfillSelection.nearestHour(
                to: capturedAt,
                from: [earlier, later]
            ),
            later
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

    private func makeCalendar() -> Calendar {
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
