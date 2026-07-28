import SwiftUI

/// One day of the lifelog: date heading, the day's words, the hero memory,
/// and the remaining moments as a small strip.
struct DayStorySection: View {
    let title: String
    let day: Date
    let readyVideos: [Asset]
    let story: DayStory
    let namespace: Namespace.ID

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.title3.weight(.semibold))

            if let quote = story.quote {
                Text("「\(quote)」")
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(.primary.opacity(0.82))
                    .lineSpacing(4)
                    .lineLimit(3)
            }

            if readyVideos.isEmpty {
                NavigationLink(value: story.hero) {
                    DayStoryHero(asset: story.hero, playbackVideos: [])
                }
                .buttonStyle(.plain)
                .matchedTransitionSource(id: story.hero.id, in: namespace)
                .accessibilityLabel(Self.accessibilityLabel(for: story.hero))
            } else {
                NavigationLink(value: DailyPlaybackRoute(day: day)) {
                    DayStoryHero(asset: story.hero, playbackVideos: readyVideos)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    L10n.format("daily.playback.card_accessibility", Int64(readyVideos.count))
                )
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
                            .matchedTransitionSource(id: asset.id, in: namespace)
                            .accessibilityLabel(Self.accessibilityLabel(for: asset))
                        }
                    }
                }
                .frame(height: 64)
            }
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
    let asset: Asset
    let playbackVideos: [Asset]

    private var playbackDuration: TimeInterval {
        playbackVideos.reduce(0) { partial, video in
            partial + TimeInterval(max(0, video.durationMs ?? 0)) / 1_000
        }
    }

    var body: some View {
        Color(.tertiarySystemFill)
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .overlay {
                AuthenticatedThumbnail(asset: asset)
            }
            .overlay {
                LinearGradient(
                    colors: [.clear, .black.opacity(0.5)],
                    startPoint: .center,
                    endPoint: .bottom
                )
            }
            .overlay(alignment: .bottom) {
                Group {
                    if playbackVideos.isEmpty {
                        HStack {
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
    }
}
