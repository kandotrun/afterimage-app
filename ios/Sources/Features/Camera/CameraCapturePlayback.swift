import AVKit
import SwiftUI

struct RecordingDurationView: View {
    let startedAt: Date

    var body: some View {
        SwiftUI.TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(duration(at: context.date))
                .font(.system(.body, design: .monospaced).weight(.semibold))
                .contentTransition(.numericText())
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .glassEffect(.regular, in: .capsule)
        }
    }

    private func duration(at date: Date) -> String {
        let totalSeconds = max(0, Int(date.timeIntervalSince(startedAt)))
        return String(
            format: "%02d:%02d",
            totalSeconds / 60,
            totalSeconds % 60
        )
    }
}

struct ReviewVideoView: View {
    @State private var player: AVPlayer

    init(url: URL) {
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        VideoPlayer(player: player)
            .onAppear {
                try? PlaybackAudioSession().activate()
                player.play()
            }
            .onDisappear {
                player.pause()
                PlaybackAudioSession().deactivate()
            }
    }
}
