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
        guard CLLocationManager.locationServicesEnabled() else {
            throw DailyWeatherRecordingError.locationUnavailable
        }
        let hourlyInterval = DateInterval(
            start: request.capturedAt.addingTimeInterval(-60 * 60),
            end: request.capturedAt.addingTimeInterval(2 * 60 * 60)
        )
        let dailyInterval = DateInterval(
            start: request.capturedAt.addingTimeInterval(-36 * 60 * 60),
            end: request.capturedAt.addingTimeInterval(36 * 60 * 60)
        )
        let location = CLLocation(
            latitude: request.location.latitude,
            longitude: request.location.longitude
        )
        let service = WeatherService.shared
        let (hourly, daily) = try await service.weather(
            for: location,
            including: .hourly(
                startDate: hourlyInterval.start,
                endDate: hourlyInterval.end
            ),
            .daily(startDate: dailyInterval.start, endDate: dailyInterval.end)
        )
        let attribution = try await service.attribution
        guard let hourDate = DailyWeatherBackfillSelection.nearestHour(
            to: request.capturedAt,
            from: hourly.map(\.date)
        ),
        let dayDate = DailyWeatherBackfillSelection.dayStart(
            for: request.capturedAt,
            from: daily.map(\.date)
        ),
        let hour = hourly.first(where: { $0.date == hourDate }),
        let day = daily.first(where: { $0.date == dayDate }) else {
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
