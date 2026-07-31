import Combine
import SwiftUI

struct DayStorySection: View {
    @EnvironmentObject private var model: AppModel
    @State private var dailySummary: DailySummaryResponse?

    let title: String
    let weather: DailyWeather?
    let day: Date
    let readyVideos: [Asset]
    let story: DayStory
    let namespace: Namespace.ID

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Text(title)
                    .font(.title3.weight(.semibold))
                Spacer(minLength: 8)
                if let weather {
                    DailyWeatherBadge(weather: weather)
                }
            }

            if let summary = dailySummary?.summary, !summary.isEmpty {
                Text(verbatim: summary)
                    .font(.system(.body, design: .serif))
                    .foregroundStyle(.primary.opacity(0.82))
                    .lineSpacing(3)
                    .lineLimit(3)
            }

            if readyVideos.isEmpty {
                NavigationLink(value: story.hero) {
                    DayStoryHero(asset: story.hero, playbackVideos: [])
                }
                .buttonStyle(.plain)
                .simultaneousGesture(
                    TapGesture().onEnded { model.playHaptic(.selection) }
                )
                .matchedTransitionSource(id: story.hero.id, in: namespace)
                .accessibilityLabel(Self.accessibilityLabel(for: story.hero))
            } else {
                NavigationLink(value: DailyPlaybackRoute(day: day)) {
                    DayStoryHero(asset: story.hero, playbackVideos: readyVideos)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(
                    TapGesture().onEnded { model.playHaptic(.selection) }
                )
                .accessibilityLabel(
                    L10n.format("daily.playback.card_accessibility", Int64(readyVideos.count))
                )
            }

            if let location = story.hero.location {
                CaptureLocationChip(location: location)
            }

            if !story.strip.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 8) {
                        ForEach(story.strip) { asset in
                            NavigationLink(value: asset) {
                                Color(.tertiarySystemFill)
                                    .frame(width: 64, height: 64)
                                    .overlay {
                                        AuthenticatedThumbnail(asset: asset)
                                    }
                                    .clipShape(.rect(cornerRadius: 14, style: .continuous))
                                    .contentShape(.rect(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .simultaneousGesture(
                                TapGesture().onEnded { model.playHaptic(.selection) }
                            )
                            .matchedTransitionSource(id: asset.id, in: namespace)
                            .accessibilityLabel(Self.accessibilityLabel(for: asset))
                        }
                    }
                }
                .frame(height: 64)
            }
        }
        .task(id: summaryRequestID) {
            await loadDailySummary()
        }
    }

    private var summaryRequestID: String {
        let sources = readyVideos.map {
            "\($0.id):\($0.updatedAt.timeIntervalSinceReferenceDate):\($0.transcriptionStatus?.rawValue ?? "none")"
        }.joined(separator: "|")
        return "\(day.timeIntervalSinceReferenceDate)|\(sources)"
    }

    private func loadDailySummary() async {
        guard let interval = Calendar.autoupdatingCurrent.dateInterval(of: .day, for: day) else {
            dailySummary = nil
            return
        }
        do {
            let response = try await model.dailySummary(in: interval)
            guard !Task.isCancelled else { return }
            dailySummary = response
        } catch {
            guard !Task.isCancelled else { return }
            dailySummary = nil
        }
    }

    private static func accessibilityLabel(for asset: Asset) -> String {
        L10n.format(
            asset.mediaType == .video ? "accessibility.video_at" : "accessibility.photo_at",
            asset.capturedAt.formatted() as NSString
        )
    }
}

private struct DayStoryHero: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var model: AppModel
    @StateObject private var preview = DayPreviewPlaybackController()
    @State private var isLowPowerModeEnabled = ProcessInfo.processInfo.isLowPowerModeEnabled

    let asset: Asset
    let playbackVideos: [Asset]

    private var playbackDuration: TimeInterval {
        playbackVideos.reduce(0) { partial, video in
            partial + TimeInterval(max(0, video.durationMs ?? 0)) / 1_000
        }
    }

    private var previewRequestID: String {
        "\(reduceMotion)|\(isLowPowerModeEnabled)|\(playbackVideos.map(\.id).joined(separator: ","))"
    }

    var body: some View {
        Color(.tertiarySystemFill)
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .overlay {
                AuthenticatedThumbnail(asset: asset)
            }
            .overlay {
                if !playbackVideos.isEmpty && !reduceMotion && !isLowPowerModeEnabled {
                    DayPreviewPlayerLayerView(player: preview.player)
                        .allowsHitTesting(false)
                }
            }
            .overlay {
                LinearGradient(
                    colors: [.clear, .black.opacity(0.78)],
                    startPoint: .center,
                    endPoint: .bottom
                )
            }
            .overlay(alignment: .bottom) {
                Group {
                    if playbackVideos.isEmpty {
                        HStack(alignment: .bottom) {
                            Text(asset.capturedAt.formatted(.dateTime.hour().minute()))
                                .font(.caption.weight(.semibold))
                            Spacer()
                            if asset.mediaType == .video, let duration = asset.durationMs {
                                Label(
                                    PlaybackClock.label(Double(duration) / 1_000),
                                    systemImage: "play.fill"
                                )
                                .font(.caption.weight(.semibold))
                            }
                        }
                    } else {
                        HStack(alignment: .bottom) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(verbatim: L10n.string("daily.playback.combine"))
                                    .font(.headline.weight(.semibold))
                                Text(
                                    verbatim: L10n.format(
                                        "daily.playback.summary",
                                        Int64(playbackVideos.count),
                                        PlaybackClock.label(playbackDuration) as NSString
                                    )
                                )
                                .font(.caption.monospacedDigit())
                            }
                            Spacer()
                            Image(systemName: "play.fill")
                                .font(.body.weight(.bold))
                                .foregroundStyle(.black)
                                .frame(width: 44, height: 44)
                                .background(.white, in: .circle)
                        }
                    }
                }
                .foregroundStyle(.white)
                .padding(14)
            }
            .clipShape(.rect(cornerRadius: 24, style: .continuous))
            .contentShape(.rect(cornerRadius: 24, style: .continuous))
            .task(id: previewRequestID) {
                guard !playbackVideos.isEmpty,
                      !reduceMotion,
                      !isLowPowerModeEnabled else {
                    preview.deactivate()
                    return
                }
                await preview.activate(assets: playbackVideos) { video in
                    try await model.playbackGrant(for: video)
                }
            }
            .onDisappear {
                preview.deactivate()
            }
            .onReceive(
                NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
            ) { _ in
                isLowPowerModeEnabled = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
    }
}
