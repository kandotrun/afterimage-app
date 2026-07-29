import Foundation

enum DailyWeatherTemperatureFormatter {
    static func string(
        celsius: Double,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let style = Measurement<UnitTemperature>.FormatStyle(
            width: .abbreviated,
            locale: locale,
            usage: .weather,
            numberFormatStyle: .number.precision(.fractionLength(0))
        )
        return Measurement(value: celsius, unit: UnitTemperature.celsius)
            .formatted(style)
    }
}
