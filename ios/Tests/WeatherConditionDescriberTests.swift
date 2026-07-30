import XCTest
@testable import afterimage

final class WeatherConditionDescriberTests: XCTestCase {
    func testDescribesCommonConditions() {
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "sun.max"), "weather.condition.clear")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "moon.stars"), "weather.condition.clear")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.rain"), "weather.condition.rain")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.heavyrain.fill"), "weather.condition.rain")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.drizzle"), "weather.condition.rain")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.snow"), "weather.condition.snow")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.bolt.rain"), "weather.condition.storm")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.fog"), "weather.condition.fog")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "wind"), "weather.condition.wind")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud.sun"), "weather.condition.cloudy")
        XCTAssertEqual(WeatherConditionDescriber.key(forSymbol: "cloud"), "weather.condition.cloudy")
    }

    func testUnknownSymbolsHaveNoDescription() {
        XCTAssertNil(WeatherConditionDescriber.key(forSymbol: "sparkles"))
        XCTAssertNil(WeatherConditionDescriber.key(forSymbol: ""))
    }
}
