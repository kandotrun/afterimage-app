import XCTest
@testable import afterimage

final class DailyPostReminderPolicyTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    func testSchedulesTodayAtTwentyTwoWhenThereIsNoPostYet() throws {
        let now = try date(year: 2026, month: 7, day: 28, hour: 21, minute: 30)

        let dates = DailyPostReminderPolicy.reminderDates(
            now: now,
            lastPostedAt: nil,
            calendar: calendar,
            horizon: 3
        )

        XCTAssertEqual(dates, [
            try date(year: 2026, month: 7, day: 28, hour: 22),
            try date(year: 2026, month: 7, day: 29, hour: 22),
            try date(year: 2026, month: 7, day: 30, hour: 22),
        ])
    }

    func testSkipsTodayWhenAReadyPostWasCreatedToday() throws {
        let now = try date(year: 2026, month: 7, day: 28, hour: 21, minute: 30)
        let lastPostedAt = try date(year: 2026, month: 7, day: 28, hour: 20)

        let dates = DailyPostReminderPolicy.reminderDates(
            now: now,
            lastPostedAt: lastPostedAt,
            calendar: calendar,
            horizon: 3
        )

        XCTAssertEqual(dates, [
            try date(year: 2026, month: 7, day: 29, hour: 22),
            try date(year: 2026, month: 7, day: 30, hour: 22),
        ])
    }

    func testStartsTomorrowWhenTodaysReminderTimeHasPassed() throws {
        let now = try date(year: 2026, month: 7, day: 28, hour: 22, minute: 1)

        let dates = DailyPostReminderPolicy.reminderDates(
            now: now,
            lastPostedAt: nil,
            calendar: calendar,
            horizon: 3
        )

        XCTAssertEqual(dates.first, try date(year: 2026, month: 7, day: 29, hour: 22))
    }

    func testPreviousDaysPostDoesNotSuppressToday() throws {
        let now = try date(year: 2026, month: 7, day: 28, hour: 21)
        let lastPostedAt = try date(year: 2026, month: 7, day: 27, hour: 23, minute: 59)

        let dates = DailyPostReminderPolicy.reminderDates(
            now: now,
            lastPostedAt: lastPostedAt,
            calendar: calendar,
            horizon: 1
        )

        XCTAssertEqual(dates, [try date(year: 2026, month: 7, day: 28, hour: 22)])
    }

    func testTriggerComponentsRetainTheUsersCalendar() throws {
        var japaneseCalendar = Calendar(identifier: .japanese)
        japaneseCalendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let reminder = try date(year: 2026, month: 7, day: 29, hour: 22)

        let components = DailyPostReminderPolicy.triggerDateComponents(
            for: reminder,
            calendar: japaneseCalendar
        )

        XCTAssertEqual(components.calendar?.identifier, .japanese)
        XCTAssertEqual(components.calendar?.date(from: components), reminder)
    }

    private func date(
        year: Int,
        month: Int,
        day: Int,
        hour: Int,
        minute: Int = 0
    ) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(
            year: year,
            month: month,
            day: day,
            hour: hour,
            minute: minute
        )))
    }
}
