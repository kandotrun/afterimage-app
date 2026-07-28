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
