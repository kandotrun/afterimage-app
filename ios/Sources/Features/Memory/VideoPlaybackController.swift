import AVFoundation
import Combine
import Foundation

/// Owns the AVPlayer lifecycle for one video memory: grant loading, autoplay,
/// scrubbing, end-of-playback, and silent grant refresh on expiry or failure
/// (decided by PlaybackRecoveryPolicy).
@MainActor
final class VideoPlaybackController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case playing
        case paused
        case ended
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var position: TimeInterval = 0
    @Published private(set) var hasPlayed = false

    let player = AVPlayer()

    private let audioSession = PlaybackAudioSession()
    private let recoveryPolicy = PlaybackRecoveryPolicy()
    private var grant: ResolvedPlaybackGrant?
    private var loadGrant: (@MainActor () async throws -> ResolvedPlaybackGrant)?
    private var retriesUsed = 0
    private var isScrubbing = false
    private var resumeAfterScrub = false
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []

    func activate(loadGrant: @escaping @MainActor () async throws -> ResolvedPlaybackGrant) async {
        self.loadGrant = loadGrant
        if timeObserver == nil {
            timeObserver = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
                queue: .main
            ) { [weak self] time in
                MainActor.assumeIsolated {
                    guard let self, !self.isScrubbing else { return }
                    self.position = max(0, time.seconds)
                }
            }
        }
        await prepareAndPlay(resumingAt: 0)
    }

    func deactivate() {
        cancellables.removeAll()
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
        audioSession.deactivate()
        grant = nil
        retriesUsed = 0
        hasPlayed = false
        isScrubbing = false
        resumeAfterScrub = false
        phase = .idle
        position = 0
        duration = 0
    }

    func togglePlayPause() {
        switch phase {
        case .playing: player.pause()
        case .paused: play()
        case .ended: replay()
        case .idle, .loading, .failed: break
        }
    }

    func scrubBegan() {
        resumeAfterScrub = phase == .playing
        isScrubbing = true
        player.pause()
    }

    func scrub(to seconds: TimeInterval) {
        position = min(max(0, seconds), duration)
    }

    func scrubEnded() {
        player.seek(
            to: CMTime(seconds: position, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
        if phase == .ended { phase = .paused }
        isScrubbing = false
        if resumeAfterScrub { play() }
        resumeAfterScrub = false
    }

    private func play() {
        switch recoveryPolicy.grantAction(now: Date(), expiresAt: grant?.expiresAt) {
        case .reuse:
            player.play()
        case .refresh:
            let resumeAt = position
            Task { await prepareAndPlay(resumingAt: resumeAt) }
        }
    }

    private func replay() {
        position = 0
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        phase = .paused
        play()
    }

    private func prepareAndPlay(resumingAt: TimeInterval) async {
        phase = .loading
        do {
            if recoveryPolicy.grantAction(now: Date(), expiresAt: grant?.expiresAt) == .refresh {
                guard let loadGrant else { return }
                grant = try await loadGrant()
            }
            guard let grant else { return }
            try audioSession.activate()
            let item = AVPlayerItem(url: grant.url)
            observe(item: item)
            player.replaceCurrentItem(with: item)
            if resumingAt > 0 {
                player.seek(
                    to: CMTime(seconds: resumingAt, preferredTimescale: 600),
                    toleranceBefore: .zero,
                    toleranceAfter: .zero,
                    completionHandler: { _ in }
                )
            }
            player.play()
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    private func observe(item: AVPlayerItem) {
        cancellables.removeAll()

        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                MainActor.assumeIsolated { self?.handle(itemStatus: status, of: item) }
            }
            .store(in: &cancellables)

        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] control in
                MainActor.assumeIsolated { self?.handle(controlStatus: control) }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification, object: item)
            .map { _ in }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                MainActor.assumeIsolated { self?.phase = .ended }
            }
            .store(in: &cancellables)
    }

    private func handle(itemStatus: AVPlayerItem.Status, of item: AVPlayerItem) {
        switch itemStatus {
        case .readyToPlay:
            retriesUsed = 0
            let seconds = item.duration.seconds
            duration = seconds.isFinite ? seconds : 0
        case .failed:
            handleFailure(message: item.error?.localizedDescription)
        default:
            break
        }
    }

    private func handle(controlStatus: AVPlayer.TimeControlStatus) {
        switch controlStatus {
        case .playing:
            hasPlayed = true
            phase = .playing
        case .paused:
            if phase == .playing { phase = .paused }
        case .waitingToPlayAtSpecifiedRate:
            if phase == .playing { phase = .loading }
        @unknown default:
            break
        }
    }

    private func handleFailure(message: String?) {
        switch recoveryPolicy.failureAction(retriesUsed: retriesUsed) {
        case .refresh:
            retriesUsed += 1
            grant = nil
            let resumeAt = position
            Task { await prepareAndPlay(resumingAt: resumeAt) }
        case .surface:
            phase = .failed(message ?? "再生できませんでした。")
        }
    }
}
