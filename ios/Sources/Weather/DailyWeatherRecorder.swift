import CoreLocation
import Foundation
import WeatherKit

enum DailyWeatherRecordingError: Error {
    case locationUnavailable
    case authorizationDenied
    case forecastUnavailable
}

struct WeatherKitDailyWeatherRecorder {
    func snapshot() async throws -> DailyWeatherDraft {
        let location = try await currentLocation()
        let service = WeatherService.shared
        let (current, forecast) = try await service.weather(
            for: location,
            including: .current,
            .daily
        )
        let attribution = try await service.attribution
        guard let day = forecast.first else {
            throw DailyWeatherRecordingError.forecastUnavailable
        }

        return DailyWeatherDraft(
            localDate: DailyWeatherDate.localDate(for: current.date),
            symbolName: current.symbolName,
            temperatureCelsius: current.temperature.converted(to: .celsius).value,
            highTemperatureCelsius: day.highTemperature.converted(to: .celsius).value,
            lowTemperatureCelsius: day.lowTemperature.converted(to: .celsius).value,
            recordedAt: current.date,
            attributionLegalUrl: attribution.legalPageURL,
            attributionLightUrl: attribution.combinedMarkLightURL,
            attributionDarkUrl: attribution.combinedMarkDarkURL
        )
    }

    func snapshot(for request: DailyWeatherBackfillRequest) async throws -> DailyWeatherDraft {
        let location = CLLocation(
            latitude: request.location.latitude,
            longitude: request.location.longitude
        )
        let hourlyStart = request.capturedAt.addingTimeInterval(-60 * 60)
        let hourlyEnd = request.capturedAt.addingTimeInterval(60 * 60)
        let dailyInterval = DailyWeatherHistoricalSelection.queryInterval(around: request.capturedAt)
        let service = WeatherService.shared
        let (hourly, daily) = try await service.weather(
            for: location,
            including: .hourly(startDate: hourlyStart, endDate: hourlyEnd),
            .daily(startDate: dailyInterval.start, endDate: dailyInterval.end)
        )
        let attribution = try await service.attribution
        guard let hour = hourly.min(by: {
            abs($0.date.timeIntervalSince(request.capturedAt))
                < abs($1.date.timeIntervalSince(request.capturedAt))
        }),
        let dayStart = DailyWeatherHistoricalSelection.dayStart(
            from: daily.map(\.date),
            containing: request.capturedAt
        ),
        let day = daily.first(where: { $0.date == dayStart }) else {
            throw DailyWeatherRecordingError.forecastUnavailable
        }

        return DailyWeatherDraft(
            localDate: request.localDate,
            symbolName: hour.symbolName,
            temperatureCelsius: hour.temperature.converted(to: .celsius).value,
            highTemperatureCelsius: day.highTemperature.converted(to: .celsius).value,
            lowTemperatureCelsius: day.lowTemperature.converted(to: .celsius).value,
            recordedAt: hour.date,
            attributionLegalUrl: attribution.legalPageURL,
            attributionLightUrl: attribution.combinedMarkLightURL,
            attributionDarkUrl: attribution.combinedMarkDarkURL
        )
    }

    private func currentLocation() async throws -> CLLocation {
        guard CLLocationManager.locationServicesEnabled() else {
            throw DailyWeatherRecordingError.locationUnavailable
        }

        return try await withThrowingTaskGroup(of: CLLocation.self) { group in
            group.addTask {
                for try await update in CLLocationUpdate.liveUpdates() {
                    if update.authorizationDenied || update.authorizationDeniedGlobally
                        || update.authorizationRestricted {
                        throw DailyWeatherRecordingError.authorizationDenied
                    }
                    if let location = update.location, location.horizontalAccuracy >= 0 {
                        return location
                    }
                }
                throw DailyWeatherRecordingError.locationUnavailable
            }
            group.addTask {
                try await Task.sleep(for: .seconds(15))
                throw DailyWeatherRecordingError.locationUnavailable
            }
            guard let location = try await group.next() else {
                throw DailyWeatherRecordingError.locationUnavailable
            }
            group.cancelAll()
            return location
        }
    }
}
