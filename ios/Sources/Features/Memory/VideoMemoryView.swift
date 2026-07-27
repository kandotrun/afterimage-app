import AVFoundation
import SwiftUI
import UIKit

struct VideoMemoryView: View {
    @EnvironmentObject private var model: AppModel
    let asset: Asset
    let isActive: Bool
    @Binding var chromeVisible: Bool
    @Binding var showTranscript: Bool

    @StateObject private var controller = VideoPlaybackController()
    @State private var chrome = PlayerChrome()
    @State private var poster: UIImage?

    var body: some View {
        ZStack {
            if let poster, !controller.hasPlayed {
                Image(uiImage: poster)
                    .resizable()
                    .scaledToFit()
            }
            PlayerLayerView(player: controller.player)
                .opacity(controller.hasPlayed ? 1 : 0)
            overlay
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(.rect)
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.2)) {
                chrome.apply(.tapped(at: Date(), isPlaying: controller.phase == .playing))
            }
        }
        .safeAreaInset(edge: .bottom) {
            if chrome.isVisible, controller.phase != .idle {
                controls
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .task { await loadPoster() }
        .task(id: isActive) {
            guard isActive else {
                controller.deactivate()
                return
            }
            chrome = PlayerChrome(isVisible: chromeVisible)
            await controller.activate { try await model.playbackGrant(for: asset) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                withAnimation(.easeInOut(duration: 0.2)) {
                    chrome.apply(.clockTicked(at: Date()))
                }
            }
        }
        .onDisappear { controller.deactivate() }
        .onChange(of: chrome.isVisible) { _, visible in
            chromeVisible = visible
        }
        .onChange(of: controller.phase) { _, phase in
            switch phase {
            case .playing:
                chrome.apply(.playbackStarted(at: Date()))
            case .paused:
                chrome.apply(.paused)
            case .ended:
                withAnimation(.easeInOut(duration: 0.2)) { chrome.apply(.playbackEnded) }
            default:
                break
            }
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch controller.phase {
        case .loading:
            ProgressView().tint(.white)
        case .idle:
            if poster == nil { ProgressView().tint(.white) }
        case let .failed(message):
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.circle")
                    .font(.largeTitle)
                Text(message)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                Button("再試行") {
                    Task { await controller.activate { try await model.playbackGrant(for: asset) } }
                }
                .buttonStyle(.glass)
            }
            .foregroundStyle(.white.opacity(0.82))
            .padding(28)
        default:
            EmptyView()
        }
    }

    private var controls: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 12) {
                Button {
                    controller.togglePlayPause()
                } label: {
                    Image(systemName: playPauseIcon)
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.glass)
                .accessibilityLabel(
                    L10n.string(controller.phase == .playing ? "playback.pause" : "playback.play")
                )

                HStack(spacing: 10) {
                    Text(PlaybackClock.label(controller.position))
                        .font(.caption.weight(.semibold).monospacedDigit())
                    Slider(
                        value: Binding(
                            get: { controller.position },
                            set: { controller.scrub(to: $0) }
                        ),
                        in: 0...max(controller.duration, 0.01)
                    ) { editing in
                        if editing {
                            controller.scrubBegan()
                            chrome.apply(.scrubBegan)
                        } else {
                            controller.scrubEnded()
                            chrome.apply(.scrubEnded)
                        }
                    }
                    Text(PlaybackClock.label(controller.duration))
                        .font(.caption.weight(.semibold).monospacedDigit())
                }
                .padding(.horizontal, 14)
                .frame(height: 52)
                .glassEffect(.regular, in: .capsule)

                if asset.transcriptUrl != nil {
                    Button {
                        showTranscript = true
                    } label: {
                        Image(systemName: "text.bubble")
                            .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("文字起こし")
                }
            }
            .tint(.white)
        }
    }

    private var playPauseIcon: String {
        switch controller.phase {
        case .playing: "pause.fill"
        case .ended: "arrow.counterclockwise"
        default: "play.fill"
        }
    }

    private func loadPoster() async {
        guard poster == nil, asset.thumbnailUrl != nil,
              let data = try? await model.thumbnailData(for: asset) else { return }
        poster = UIImage(data: data)
    }
}

private struct PlayerLayerView: UIViewRepresentable {
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
