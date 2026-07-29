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
        now: Date = .now,
        limit: Int = 7,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [DailyWeatherBackfillRequest] {
        guard limit > 0 else { return [] }

        let startOfToday = calendar.startOfDay(for: now)
        var selectedDates = Set<String>()
        var requests: [DailyWeatherBackfillRequest] = []
        for asset in assets.sorted(by: { $0.capturedAt > $1.capturedAt }) {
            guard asset.status == .ready,
                  asset.capturedAt < startOfToday,
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

enum DailyWeatherBackfillExecutor {
    @MainActor
    static func execute(
        requests: [DailyWeatherBackfillRequest],
        existingWeather: @MainActor (String) async throws -> DailyWeather?,
        snapshot: @MainActor (DailyWeatherBackfillRequest) async throws -> DailyWeatherDraft,
        save: @MainActor (DailyWeatherDraft) async throws -> DailyWeather
    ) async -> [DailyWeather] {
        var weather: [DailyWeather] = []
        for request in requests {
            guard !Task.isCancelled else { break }
            do {
                if let existing = try await existingWeather(request.localDate) {
                    weather.append(existing)
                    continue
                }
                let draft = try await snapshot(request)
                weather.append(try await save(draft))
            } catch {
                continue
            }
        }
        return weather
    }
}

enum DailyWeatherHistoricalSelection {
    static func queryInterval(around capturedAt: Date) -> DateInterval {
        DateInterval(
            start: capturedAt.addingTimeInterval(-36 * 60 * 60),
            end: capturedAt.addingTimeInterval(36 * 60 * 60)
        )
    }

    static func dayStart(from dates: [Date], containing capturedAt: Date) -> Date? {
        dates.filter { $0 <= capturedAt }.max()
    }
}
