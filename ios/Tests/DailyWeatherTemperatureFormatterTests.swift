import XCTest
@testable import afterimage

final class DailyWeatherTemperatureFormatterTests: XCTestCase {
    func testRoundsWeatherTemperaturesToWholeDegrees() {
        let locale = Locale(identifier: "ja_JP")

        XCTAssertEqual(
            DailyWeatherTemperatureFormatter.string(celsius: 30.199041, locale: locale),
            "30°C"
        )
        XCTAssertEqual(
            DailyWeatherTemperatureFormatter.string(celsius: 32.509979, locale: locale),
            "33°C"
        )
        XCTAssertEqual(
            DailyWeatherTemperatureFormatter.string(celsius: 26.349558, locale: locale),
            "26°C"
        )
    }
}
