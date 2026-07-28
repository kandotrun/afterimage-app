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
}
