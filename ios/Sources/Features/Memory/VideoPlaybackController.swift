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
    /// Invalidates in-flight prepareAndPlay work: bumped by activate() and
    /// deactivate(), checked after every suspension point so an orphaned grant
    /// refresh can never restart playback on a page that was deactivated.
    private var generation = 0

    func activate(loadGrant: @escaping @MainActor () async throws -> ResolvedPlaybackGrant) async {
        self.loadGrant = loadGrant
        generation += 1
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
        await prepareAndPlay(resumingAt: 0, generation: generation)
    }

    func deactivate() {
        generation += 1
        loadGrant = nil
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
        case .playing:
            player.pause()
        case .loading:
            // A stalled/buffering video must still respond to pause.
            player.pause()
            phase = .paused
        case .paused:
            play()
        case .ended:
            replay()
        case .idle, .failed:
            break
        }
    }

    func scrubBegan() {
        resumeAfterScrub = phase == .playing || phase == .loading
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
        if phase == .ended || phase == .loading { phase = .paused }
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
            let expected = generation
            Task { await prepareAndPlay(resumingAt: resumeAt, generation: expected) }
        }
    }

    private func replay() {
        position = 0
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        phase = .paused
        play()
    }

    private func prepareAndPlay(resumingAt: TimeInterval, generation expected: Int) async {
        guard expected == generation else { return }
        phase = .loading
        do {
            if recoveryPolicy.grantAction(now: Date(), expiresAt: grant?.expiresAt) == .refresh {
                guard let loadGrant else { return }
                let fresh = try await loadGrant()
                guard expected == generation else { return }
                grant = fresh
            }
            guard expected == generation, let grant else { return }
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
            // A cancelled or superseded activation must not surface as failure UI.
            guard expected == generation, !Task.isCancelled else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
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
            let expected = generation
            Task { await prepareAndPlay(resumingAt: resumeAt, generation: expected) }
        case .surface:
            phase = .failed(message ?? "再生できませんでした。")
        }
    }
}
