import AVFoundation
import SwiftUI
import UIKit

struct DailyPlaybackRoute: Hashable, Identifiable {
    let day: Date
    var id: Date { day }
}

struct DailyPlaybackView: View {
    @EnvironmentObject private var model: AppModel
    let day: Date

    @StateObject private var controller = DailyVideoPlaybackController()
    @State private var playback: DailyPlaybackResponse?
    @State private var poster: UIImage?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var confirmDelete = false
    @State private var dailySummaryText: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            GeometryReader { proxy in
                let isWide = proxy.size.width > proxy.size.height * 1.15
                Group {
                    if isLoading && playback == nil {
                        ProgressView()
                            .tint(.white)
                    } else if let loadError, playback == nil {
                        errorState(loadError) {
                            Task { await loadDay() }
                        }
                    } else if let playback, !playback.clips.isEmpty {
                        if isWide {
                            HStack(spacing: 0) {
                                playerSurface
                                sidebar(isWide: true)
                                    .frame(width: min(390, proxy.size.width * 0.38))
                            }
                        } else {
                            VStack(spacing: 0) {
                                playerSurface
                                    .frame(
                                        height: min(
                                            max(220, proxy.size.width * 9 / 16),
                                            proxy.size.height * 0.48
                                        )
                                    )
                                sidebar(isWide: false)
                            }
                        }
                    } else {
                        ContentUnavailableView(
                            L10n.string("daily.playback.empty"),
                            systemImage: "video.slash"
                        )
                        .foregroundStyle(.white)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(day.formatted(.dateTime.year().month(.wide).day()))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if controller.activeClip != nil {
                    Menu {
                        Button(
                            L10n.string("daily.playback.delete_current"),
                            systemImage: "trash",
                            role: .destructive
                        ) {
                            confirmDelete = true
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel(L10n.string("accessibility.more"))
                }
            }
        }
        .confirmationDialog(
            L10n.string("daily.playback.delete_confirmation"),
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(L10n.string("action.delete"), role: .destructive) { deleteActiveClip() }
            Button(L10n.string("action.cancel"), role: .cancel) {}
        }
        .task(id: day) { await loadDay() }
        .onDisappear { controller.deactivate() }
    }

    private var playerSurface: some View {
        ZStack {
            Color.black
            if let poster, !controller.hasPlayed {
                Image(uiImage: poster)
                    .resizable()
                    .scaledToFit()
            }
            DailyPlayerLayerView(player: controller.player)
                .opacity(controller.hasPlayed ? 1 : 0)

            if controller.phase == .loading {
                ProgressView()
                    .tint(.white)
                    .controlSize(.large)
            }

            if case let .failed(message) = controller.phase {
                errorState(message, action: controller.retry)
            }

            if controller.phase == .ended {
                endCard
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: controller.phase == .ended)
        .overlay(alignment: .topLeading) {
            if let clip = controller.activeClip, let playback {
                Text(
                    L10n.format(
                        "daily.playback.current_clip",
                        Int64(controller.activeIndex + 1),
                        Int64(playback.clipCount),
                        clip.asset.capturedAt.formatted(.dateTime.hour().minute()) as NSString
                    )
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(.black.opacity(0.58), in: .capsule)
                .padding(14)
            }
        }
        .clipped()
    }

    /// The closing moment of a day: date, weather, its words, and a way back in.
    private var endCard: some View {
        ZStack {
            Color.black.opacity(0.62)
            VStack(spacing: 14) {
                Text(verbatim: L10n.string("daily.playback.ended_title"))
                    .font(.system(.title3, design: .serif).weight(.semibold))
                Text(day.formatted(.dateTime.month(.wide).day().weekday(.wide)))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.72))
                if let weather = model.weather(for: day) {
                    DailyWeatherBadge(weather: weather)
                        .environment(\.colorScheme, .dark)
                }
                if let dailySummaryText {
                    Text(verbatim: dailySummaryText)
                        .font(.system(.callout, design: .serif))
                        .lineSpacing(4)
                        .lineLimit(3)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white.opacity(0.88))
                }
                if let playback {
                    Text(
                        verbatim: L10n.format(
                            "daily.playback.summary",
                            Int64(playback.clipCount),
                            PlaybackClock.label(controller.duration) as NSString
                        )
                    )
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.6))
                }
                Button {
                    controller.togglePlayPause()
                } label: {
                    Label(L10n.string("action.retry"), systemImage: "arrow.counterclockwise")
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 8)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.glass)
                .padding(.top, 2)
            }
            .foregroundStyle(.white)
            .padding(24)
        }
    }

    private func sidebar(isWide: Bool) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: L10n.string("daily.playback.title"))
                    .font(.headline.weight(.semibold))
                Spacer()
                if let playback {
                    Text(
                        verbatim: L10n.format(
                            "daily.playback.summary",
                            Int64(playback.clipCount),
                            PlaybackClock.label(controller.duration) as NSString
                        )
                    )
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
            }

            transcriptPanel(isWide: isWide)

            if isWide {
                chapterListVertical
            } else {
                chapterListHorizontal
            }

            controls
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(.secondarySystemBackground))
    }

    private func transcriptPanel(isWide: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(L10n.string("daily.playback.subtitle"), systemImage: "captions.bubble")
                    .font(.caption.weight(.bold))
                Spacer()
                if let capturedAt = controller.activeClip?.asset.capturedAt {
                    Text(capturedAt.formatted(.dateTime.hour().minute()))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            // Combining only the header keeps the location Link reachable and
            // the transcript scrollable for VoiceOver.
            .accessibilityElement(children: .combine)
            if let location = controller.activeClip?.asset.location {
                CaptureLocationChip(location: location)
            }
            ScrollView {
                Text(verbatim: activeTranscript)
                    .font(.callout)
                    .foregroundStyle(activeTranscriptIsReady ? .primary : .secondary)
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 6)
                    .id(controller.activeClip?.id)
            }
            .frame(minHeight: 72, maxHeight: isWide ? .infinity : 184)
        }
        .padding(13)
        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 16))
    }

    private var chapterListVertical: some View {
        ScrollView {
            LazyVStack(spacing: 7) {
                chapterButtons(vertical: true)
            }
        }
        .frame(maxHeight: 230)
        .accessibilityLabel(L10n.string("daily.playback.chapters"))
    }

    private var chapterListHorizontal: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 8) {
                chapterButtons(vertical: false)
            }
        }
        .frame(height: 60)
        .accessibilityLabel(L10n.string("daily.playback.chapters"))
    }

    @ViewBuilder
    private func chapterButtons(vertical: Bool) -> some View {
        ForEach(Array(controller.clips.enumerated()), id: \.element.id) { index, clip in
            Button {
                controller.playClip(at: index)
            } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(clip.asset.capturedAt.formatted(.dateTime.hour().minute()))
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                        Text(PlaybackClock.label(clip.duration))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if vertical { Spacer(minLength: 8) }
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: vertical ? .infinity : nil, minHeight: 52, alignment: .leading)
                .background(
                    index == controller.activeIndex
                        ? Color.accentColor.opacity(0.18)
                        : Color(.tertiarySystemFill),
                    in: .rect(cornerRadius: 13)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 13)
                        .stroke(index == controller.activeIndex ? Color.accentColor.opacity(0.8) : .clear, lineWidth: 1)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                L10n.format(
                    "daily.playback.chapter_accessibility",
                    Int64(index + 1),
                    clip.asset.capturedAt.formatted(.dateTime.hour().minute()) as NSString
                )
            )
            .accessibilityAddTraits(index == controller.activeIndex ? .isSelected : [])
        }
    }

    private var controls: some View {
        HStack(spacing: 11) {
            Button {
                controller.togglePlayPause()
            } label: {
                Image(systemName: playPauseIcon)
                    .font(.body.weight(.semibold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.glassProminent)
            .accessibilityLabel(
                L10n.string(controller.phase == .playing ? "playback.pause" : "playback.play")
            )

            Text(PlaybackClock.label(controller.position))
                .font(.caption2.monospacedDigit())
                .accessibilityHidden(true)
            Slider(
                value: Binding(
                    get: { controller.position },
                    set: { controller.scrub(to: $0) }
                ),
                in: 0...max(controller.duration, 0.01)
            ) { editing in
                if editing { controller.scrubBegan() }
                else { controller.scrubEnded() }
            }
            .tint(.accentColor)
            .accessibilityLabel(L10n.string("playback.scrub"))
            .accessibilityValue(
                L10n.format(
                    "playback.position_accessibility",
                    PlaybackClock.label(controller.position) as NSString,
                    PlaybackClock.label(controller.duration) as NSString
                )
            )
            Text(PlaybackClock.label(controller.duration))
                .font(.caption2.monospacedDigit())
                .accessibilityHidden(true)
        }
    }

    private var activeTranscript: String {
        guard let transcript = controller.activeClip?.transcript else {
            return L10n.string("daily.playback.subtitle_unavailable")
        }
        if transcript.status == .completed,
           let text = transcript.text?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty {
            return text
        }
        return switch transcript.status {
        case .pending, .processing:
            L10n.string("daily.playback.subtitle_pending")
        case .failed:
            L10n.string("daily.playback.subtitle_failed")
        case .completed, .skipped, .none:
            L10n.string("daily.playback.subtitle_unavailable")
        }
    }

    private var activeTranscriptIsReady: Bool {
        controller.activeClip?.transcript.status == .completed
            && controller.activeClip?.transcript.text?.isEmpty == false
    }

    private var playPauseIcon: String {
        switch controller.phase {
        case .playing: "pause.fill"
        case .ended: "arrow.counterclockwise"
        default: "play.fill"
        }
    }

    @ViewBuilder
    private func errorState(_ message: String, action: (() -> Void)? = nil) -> some View {
        VStack(spacing: 13) {
            Image(systemName: "exclamationmark.circle")
                .font(.largeTitle)
            Text(verbatim: message)
                .font(.callout)
                .multilineTextAlignment(.center)
            if let action {
                Button(L10n.string("action.retry"), action: action)
                    .buttonStyle(.glass)
            }
        }
        .foregroundStyle(.white.opacity(0.86))
        .padding(28)
    }

    @MainActor
    private func loadDay() async {
        controller.deactivate()
        playback = nil
        poster = nil
        loadError = nil
        isLoading = true
        guard let interval = Calendar.autoupdatingCurrent.dateInterval(of: .day, for: day) else {
            loadError = L10n.string("daily.playback.invalid_day")
            isLoading = false
            return
        }
        do {
            let response = try await model.dailyPlayback(in: interval)
            let summary = (try? await model.dailySummary(in: interval))?.summary?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            dailySummaryText = summary?.isEmpty == false ? summary : nil
            guard !Task.isCancelled else { return }
            playback = response
            if let first = response.clips.first?.asset,
               first.thumbnailUrl != nil,
               let data = try? await model.thumbnailData(for: first) {
                poster = UIImage(data: data)
            }
            isLoading = false
            if !response.clips.isEmpty {
                await controller.activate(playback: response) { asset in
                    try await model.playbackGrant(for: asset)
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            isLoading = false
        }
    }

    private func deleteActiveClip() {
        guard let asset = controller.activeClip?.asset else { return }
        controller.deactivate()
        Task {
            _ = await model.delete(asset)
            await loadDay()
        }
    }
}

struct DailyPlaybackCard: View {
    let assets: [Asset]

    private var videos: [Asset] {
        assets.filter { $0.mediaType == .video }.sorted { $0.capturedAt < $1.capturedAt }
    }

    private var duration: TimeInterval {
        TimeInterval(videos.reduce(0) { $0 + max(0, $1.durationMs ?? 0) }) / 1_000
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color(.tertiarySystemFill)
            if let first = videos.first {
                AuthenticatedThumbnail(asset: first)
            }
            LinearGradient(
                colors: [.clear, .black.opacity(0.78)],
                startPoint: .center,
                endPoint: .bottom
            )
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: L10n.string("daily.playback.combine"))
                        .font(.headline.weight(.semibold))
                    Text(
                        verbatim: L10n.format(
                            "daily.playback.summary",
                            Int64(videos.count),
                            PlaybackClock.label(duration) as NSString
                        )
                    )
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.78))
                }
                Spacer()
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 42, weight: .medium))
            }
            .foregroundStyle(.white)
            .padding(18)
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(.rect(cornerRadius: 22))
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            L10n.format("daily.playback.card_accessibility", Int64(videos.count))
        )
    }
}

private struct DailyPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class HostView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> HostView {
        let view = HostView()
        view.backgroundColor = .clear
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: HostView, context: Context) {
        view.playerLayer.player = player
    }
}
