import XCTest
@testable import afterimage

final class DailyWeatherDateTests: XCTestCase {
    func testBuildsTheLocalDateInTheUsersTimeZone() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 9 * 60 * 60)!
        let date = Date(timeIntervalSince1970: 1_785_166_200)

        let localDate = DailyWeatherDate.localDate(for: date, calendar: calendar)

        XCTAssertEqual(localDate, "2026-07-28")
    }

    func testBuildsAGregorianDateWhenTheUserUsesTheJapaneseCalendar() {
        var calendar = Calendar(identifier: .japanese)
        calendar.timeZone = TimeZone(secondsFromGMT: 9 * 60 * 60)!
        let date = Date(timeIntervalSince1970: 1_785_166_200)

        let localDate = DailyWeatherDate.localDate(for: date, calendar: calendar)

        XCTAssertEqual(localDate, "2026-07-28")
    }

    func testBuildsAnInclusiveRangeFromLoadedCaptureDates() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 9 * 60 * 60)!
        let dates = [
            Date(timeIntervalSince1970: 1_785_333_600),
            Date(timeIntervalSince1970: 1_785_166_200),
        ]

        let range = DailyWeatherDate.range(for: dates, calendar: calendar)

        XCTAssertEqual(range, "2026-07-28"..."2026-07-29")
    }

    func testPresentsTodaysStoredWeatherWithoutTodaysAssets() {
        let calendar = tokyoCalendar()
        let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))!
        let yesterday = calendar.date(from: DateComponents(year: 2026, month: 7, day: 28, hour: 18))!
        let weather = weather(localDate: "2026-07-29")

        let result = TimelineWeatherPresentationPolicy.standaloneTodayWeather(
            weather: weather,
            assetDates: [yesterday],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(result, weather)
    }

    func testDoesNotDuplicateTodaysWeatherWhenTodayHasAnAsset() {
        let calendar = tokyoCalendar()
        let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))!
        let todayAsset = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 8))!

        let result = TimelineWeatherPresentationPolicy.standaloneTodayWeather(
            weather: weather(localDate: "2026-07-29"),
            assetDates: [todayAsset],
            now: now,
            calendar: calendar
        )

        XCTAssertNil(result)
    }

    func testDoesNotPresentAStoredWeatherSnapshotFromAnotherDayAsToday() {
        let calendar = tokyoCalendar()
        let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))!

        let result = TimelineWeatherPresentationPolicy.standaloneTodayWeather(
            weather: weather(localDate: "2026-07-28"),
            assetDates: [],
            now: now,
            calendar: calendar
        )

        XCTAssertNil(result)
    }

    private func tokyoCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 9 * 60 * 60)!
        return calendar
    }

    private func weather(localDate: String) -> DailyWeather {
        DailyWeather(
            localDate: localDate,
            symbolName: "sun.max.fill",
            temperatureCelsius: 31,
            highTemperatureCelsius: 34,
            lowTemperatureCelsius: 27,
            recordedAt: Date(timeIntervalSince1970: 0),
            attributionLegalUrl: URL(string: "https://weatherkit.apple.com/legal-attribution.html")!,
            attributionLightUrl: URL(string: "https://example.com/light.svg")!,
            attributionDarkUrl: URL(string: "https://example.com/dark.svg")!
        )
    }
}
