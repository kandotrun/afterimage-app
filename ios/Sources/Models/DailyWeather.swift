import Foundation

struct DailyWeather: Codable, Hashable, Sendable {
    let localDate: String
    let symbolName: String
    let temperatureCelsius: Double
    let highTemperatureCelsius: Double
    let lowTemperatureCelsius: Double
    let recordedAt: Date
    let attributionLegalUrl: URL
    let attributionLightUrl: URL
    let attributionDarkUrl: URL
}

struct DailyWeatherPage: Decodable, Sendable {
    let items: [DailyWeather]
}

struct DailyWeatherResponse: Decodable, Sendable {
    let item: DailyWeather
}

struct DailyWeatherDraft: Encodable, Sendable {
    let localDate: String
    let symbolName: String
    let temperatureCelsius: Double
    let highTemperatureCelsius: Double
    let lowTemperatureCelsius: Double
    let recordedAt: Date
    let attributionLegalUrl: URL
    let attributionLightUrl: URL
    let attributionDarkUrl: URL

    private enum CodingKeys: String, CodingKey {
        case symbolName
        case temperatureCelsius
        case highTemperatureCelsius
        case lowTemperatureCelsius
        case recordedAt
        case attributionLegalUrl
        case attributionLightUrl
        case attributionDarkUrl
    }
}

enum DailyWeatherDate {
    static func localDate(for date: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        var gregorianCalendar = Calendar(identifier: .gregorian)
        gregorianCalendar.timeZone = calendar.timeZone
        let components = gregorianCalendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04lld-%02lld-%02lld",
            Int64(components.year ?? 0),
            Int64(components.month ?? 0),
            Int64(components.day ?? 0)
        )
    }

    static func range(
        for dates: [Date],
        calendar: Calendar = .autoupdatingCurrent
    ) -> ClosedRange<String>? {
        let localDates = dates.map { localDate(for: $0, calendar: calendar) }.sorted()
        guard let first = localDates.first, let last = localDates.last else { return nil }
        return first...last
    }
}

enum TimelineWeatherPresentationPolicy {
    static func standaloneTodayWeather(
        weather: DailyWeather?,
        assetDates: [Date],
        now: Date = .now,
        calendar: Calendar = .autoupdatingCurrent
    ) -> DailyWeather? {
        guard let weather,
              weather.localDate == DailyWeatherDate.localDate(for: now, calendar: calendar),
              !assetDates.contains(where: { calendar.isDate($0, inSameDayAs: now) }) else {
            return nil
        }
        return weather
    }
}
