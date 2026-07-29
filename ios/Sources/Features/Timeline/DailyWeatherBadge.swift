import SwiftUI

struct DailyWeatherBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let weather: DailyWeather

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: weather.symbolName)
                    .symbolRenderingMode(.hierarchical)
                    .accessibilityHidden(true)
                Text(temperature(weather.temperatureCelsius))
                    .fontWeight(.semibold)
                HStack(spacing: 2) {
                    Image(systemName: "arrow.up")
                    Text(temperature(weather.highTemperatureCelsius))
                    Image(systemName: "arrow.down")
                    Text(temperature(weather.lowTemperatureCelsius))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                L10n.format(
                    "weather.summary.accessibility",
                    temperature(weather.temperatureCelsius) as NSString,
                    temperature(weather.highTemperatureCelsius) as NSString,
                    temperature(weather.lowTemperatureCelsius) as NSString
                )
            )

            Link(destination: weather.attributionLegalUrl) {
                AsyncImage(url: attributionMarkUrl) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                    case .empty, .failure:
                        Text("Weather")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    @unknown default:
                        EmptyView()
                    }
                }
                .frame(width: 78, height: 14, alignment: .trailing)
            }
            .tint(.secondary)
            .accessibilityLabel(L10n.string("weather.attribution"))
        }
    }

    private var attributionMarkUrl: URL {
        colorScheme == .dark ? weather.attributionDarkUrl : weather.attributionLightUrl
    }

    private func temperature(_ celsius: Double) -> String {
        DailyWeatherTemperatureFormatter.string(celsius: celsius)
    }
}

struct StandaloneDailyWeatherSection: View {
    let title: String
    let weather: DailyWeather

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(title)
                .font(.title3.weight(.semibold))
            Spacer(minLength: 8)
            DailyWeatherBadge(weather: weather)
        }
    }
}
