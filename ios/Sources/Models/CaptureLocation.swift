import Foundation

struct CaptureLocation: Codable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double

    var coordinateLabel: String {
        String(
            format: "%.5f, %.5f",
            locale: Locale(identifier: "en_US_POSIX"),
            latitude,
            longitude
        )
    }

    var appleMapsURL: URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "maps.apple.com"
        components.path = "/"
        components.queryItems = [
            URLQueryItem(
                name: "ll",
                value: String(
                    format: "%.6f,%.6f",
                    locale: Locale(identifier: "en_US_POSIX"),
                    latitude,
                    longitude
                )
            ),
        ]
        return components.url
    }
}
