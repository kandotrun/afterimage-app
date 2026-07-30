import AVFoundation
import SwiftUI
import UIKit

enum UploadPreviewPlaybackPolicy {
    static func playableDescriptor(
        for upload: UploadPresentation,
        isPlaybackAllowed: Bool,
        reduceMotion: Bool
    ) -> UploadPreviewDescriptor? {
        guard upload.stage == .uploading,
              isPlaybackAllowed,
              !reduceMotion,
              let preview = upload.preview,
              preview.contentType.hasPrefix("video/"),
              preview.mediaURL.isFileURL else { return nil }
        return preview
    }
}

@MainActor
final class UploadPreviewPlayerController: ObservableObject {
    let player: AVQueuePlayer
    @Published private(set) var isPrepared = false

    private var looper: AVPlayerLooper?
    private var preview: UploadPreviewDescriptor?

    init() {
        player = AVQueuePlayer()
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
    }

    func setPreview(_ preview: UploadPreviewDescriptor?) {
        guard self.preview != preview else {
            if preview != nil { player.play() }
            return
        }
        stop()
        guard let preview,
              FileManager.default.fileExists(atPath: preview.mediaURL.path) else { return }
        self.preview = preview
        let item = AVPlayerItem(url: preview.mediaURL)
        looper = AVPlayerLooper(player: player, templateItem: item)
        isPrepared = true
        player.play()
    }

    func stop() {
        preview = nil
        isPrepared = false
        player.pause()
        looper?.disableLooping()
        looper = nil
        player.removeAllItems()
    }
}

struct UploadPreviewPlayer: View {
    let upload: UploadPresentation
    let isPlaybackAllowed: Bool

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var controller = UploadPreviewPlayerController()

    private var playableDescriptor: UploadPreviewDescriptor? {
        UploadPreviewPlaybackPolicy.playableDescriptor(
            for: upload,
            isPlaybackAllowed: isPlaybackAllowed && scenePhase == .active,
            reduceMotion: reduceMotion
        )
    }

    var body: some View {
        ZStack {
            Color(.tertiarySystemFill)
            if playableDescriptor != nil && controller.isPrepared {
                UploadPreviewPlayerLayer(player: controller.player)
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "video.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.accentColor)
                }
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(.rect(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.string("accessibility.upload_preview"))
        .onAppear { controller.setPreview(playableDescriptor) }
        .onChange(of: playableDescriptor) { _, preview in controller.setPreview(preview) }
        .onDisappear { controller.stop() }
    }
}

private struct UploadPreviewPlayerLayer: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> HostView {
        let view = HostView()
        view.playerLayer.videoGravity = .resizeAspectFill
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: HostView, context: Context) {
        view.playerLayer.player = player
    }

    static func dismantleUIView(_ view: HostView, coordinator: ()) {
        view.playerLayer.player = nil
    }

    final class HostView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
