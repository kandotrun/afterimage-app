import Foundation

struct DailyWeatherBackfillRequest: Equatable, Sendable {
    let localDate: String
    let capturedAt: Date
    let location: CaptureLocation
}

enum DailyWeatherBackfillPlan {
    static func requests(
        assets: [Asset],
        storedLocalDates: Set<String>,
        limit: Int = 7,
        now: Date = .now,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [DailyWeatherBackfillRequest] {
        let startOfToday = calendar.startOfDay(for: now)
        guard limit > 0,
              let startOfLookback = calendar.date(byAdding: .day, value: -7, to: startOfToday) else {
            return []
        }
        var selectedDates = Set<String>()
        var requests: [DailyWeatherBackfillRequest] = []
        for asset in assets.sorted(by: { $0.capturedAt > $1.capturedAt }) {
            guard asset.capturedAt >= startOfLookback,
                  asset.capturedAt < startOfToday,
                  asset.status == .ready,
                  let location = asset.location else { continue }
            let localDate = DailyWeatherDate.localDate(for: asset.capturedAt, calendar: calendar)
            guard !storedLocalDates.contains(localDate), selectedDates.insert(localDate).inserted else {
                continue
            }
            requests.append(
                DailyWeatherBackfillRequest(
                    localDate: localDate,
                    capturedAt: asset.capturedAt,
                    location: location
                )
            )
            if requests.count == limit { break }
        }
        return requests
    }
}

enum DailyWeatherBackfillSelection {
    static func nearestHour(to capturedAt: Date, from dates: [Date]) -> Date? {
        dates.min {
            abs($0.timeIntervalSince(capturedAt)) < abs($1.timeIntervalSince(capturedAt))
        }
    }

    static func dayStart(for capturedAt: Date, from dates: [Date]) -> Date? {
        dates.filter { $0 <= capturedAt }.max()
    }
}
