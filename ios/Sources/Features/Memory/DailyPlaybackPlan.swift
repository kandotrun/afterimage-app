import Foundation

struct DailyPlaybackLocation: Equatable, Sendable {
    let clipIndex: Int
    let localSeconds: TimeInterval
}

struct DailyPlaybackPlan: Sendable {
    let clips: [DailyPlaybackClip]

    var duration: TimeInterval {
        guard let endMs = clips.map(\.endMs).max() else { return 0 }
        return TimeInterval(max(0, endMs)) / 1_000
    }

    func location(at wholeDaySeconds: TimeInterval) -> DailyPlaybackLocation? {
        guard !clips.isEmpty else { return nil }
        let clamped = min(max(wholeDaySeconds.isFinite ? wholeDaySeconds : 0, 0), duration)
        let index = clips.lastIndex { clamped >= TimeInterval($0.startMs) / 1_000 } ?? 0
        let clip = clips[index]
        let clipStart = TimeInterval(clip.startMs) / 1_000
        let clipDuration = TimeInterval(max(0, clip.endMs - clip.startMs)) / 1_000
        let local = min(max(clamped - clipStart, 0), clipDuration)
        return DailyPlaybackLocation(clipIndex: index, localSeconds: local)
    }

    func globalPosition(localSeconds: TimeInterval, clipIndex: Int) -> TimeInterval? {
        guard clips.indices.contains(clipIndex) else { return nil }
        let clip = clips[clipIndex]
        let clipStart = TimeInterval(clip.startMs) / 1_000
        let clipDuration = TimeInterval(max(0, clip.endMs - clip.startMs)) / 1_000
        let clampedLocal = min(max(localSeconds.isFinite ? localSeconds : 0, 0), clipDuration)
        return min(clipStart + clampedLocal, duration)
    }

    func transcript(at wholeDaySeconds: TimeInterval) -> String? {
        guard let location = location(at: wholeDaySeconds) else { return nil }
        let value = clips[location.clipIndex].transcript.text?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }
}
