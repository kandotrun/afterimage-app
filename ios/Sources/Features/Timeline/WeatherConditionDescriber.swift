enum WeatherConditionDescriber {
    static func key(forSymbol symbolName: String) -> String? {
        if symbolName.contains("bolt") { return "weather.condition.storm" }
        if symbolName.contains("snow") || symbolName.contains("sleet") || symbolName.contains("hail") {
            return "weather.condition.snow"
        }
        if symbolName.contains("rain") || symbolName.contains("drizzle") {
            return "weather.condition.rain"
        }
        if symbolName.contains("fog") || symbolName.contains("haze") || symbolName.contains("smoke") {
            return "weather.condition.fog"
        }
        if symbolName.hasPrefix("wind") { return "weather.condition.wind" }
        if symbolName.hasPrefix("cloud") { return "weather.condition.cloudy" }
        if symbolName.hasPrefix("sun") || symbolName.hasPrefix("moon") {
            return "weather.condition.clear"
        }
        return nil
    }
}
