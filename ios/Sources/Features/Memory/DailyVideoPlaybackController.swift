import AVFoundation
import Combine
import Foundation

/// Presents separate private assets as one day-long playback timeline. Each clip
/// receives a fresh short-lived grant immediately before it starts, so combined
/// playback does not require a long-lived URL or a public concatenated object.
@MainActor
final class DailyVideoPlaybackController: ObservableObject {
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
    @Published private(set) var activeIndex = 0
    @Published private(set) var hasPlayed = false

    let player = AVPlayer()

    private let audioSession = PlaybackAudioSession()
    private let recoveryPolicy = PlaybackRecoveryPolicy()
    private var plan = DailyPlaybackPlan(clips: [])
    private var grant: ResolvedPlaybackGrant?
    private var loadGrant: (@MainActor (Asset) async throws -> ResolvedPlaybackGrant)?
    private var retriesUsed = 0
    private var isScrubbing = false
    private var resumeAfterScrub = false
    private var intendsToPlay = false
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []
    private var generation = 0
    private var prepareRequestID = 0

    var clips: [DailyPlaybackClip] { plan.clips }
    var activeClip: DailyPlaybackClip? {
        plan.clips.indices.contains(activeIndex) ? plan.clips[activeIndex] : nil
    }

    func activate(
        playback: DailyPlaybackResponse,
        loadGrant: @escaping @MainActor (Asset) async throws -> ResolvedPlaybackGrant
    ) async {
        generation += 1
        let expected = generation
        let requestID = issuePrepareRequest()
        resetPlayerState()
        self.loadGrant = loadGrant
        plan = DailyPlaybackPlan(clips: playback.clips)
        duration = plan.duration
        intendsToPlay = true
        installTimeObserverIfNeeded()
        guard !playback.clips.isEmpty else { return }
        await prepareClip(
            index: 0,
            localSeconds: 0,
            shouldPlay: true,
            generation: expected,
            requestID: requestID
        )
    }

    func deactivate() {
        generation += 1
        resetPlayerState()
        loadGrant = nil
        plan = DailyPlaybackPlan(clips: [])
        duration = 0
        position = 0
        activeIndex = 0
        phase = .idle
    }

    func togglePlayPause() {
        switch phase {
        case .playing, .loading:
            intendsToPlay = false
            player.pause()
            phase = .paused
        case .paused:
            intendsToPlay = true
            resumePlayback()
        case .ended:
            intendsToPlay = true
            startPreparing(index: 0, localSeconds: 0, shouldPlay: true)
        case .idle, .failed:
            break
        }
    }

    func scrubBegan() {
        resumeAfterScrub = phase == .playing || phase == .loading
        intendsToPlay = false
        isScrubbing = true
        player.pause()
    }

    func scrub(to wholeDaySeconds: TimeInterval) {
        position = min(max(wholeDaySeconds.isFinite ? wholeDaySeconds : 0, 0), duration)
    }

    func scrubEnded() {
        guard let location = plan.location(at: position) else {
            isScrubbing = false
            resumeAfterScrub = false
            return
        }
        let shouldPlay = resumeAfterScrub
        resumeAfterScrub = false
        isScrubbing = false
        intendsToPlay = shouldPlay

        if location.clipIndex == activeIndex,
           recoveryPolicy.grantAction(now: Date(), expiresAt: grant?.expiresAt) == .reuse {
            startSeekingCurrentItem(
                localSeconds: location.localSeconds,
                shouldPlay: shouldPlay
            )
            return
        }

        startPreparing(
            index: location.clipIndex,
            localSeconds: location.localSeconds,
            shouldPlay: shouldPlay
        )
    }

    func playClip(at index: Int) {
        guard plan.clips.indices.contains(index) else { return }
        intendsToPlay = true
        startPreparing(index: index, localSeconds: 0, shouldPlay: true)
    }

    func retry() {
        guard plan.clips.indices.contains(activeIndex) else { return }
        retriesUsed = 0
        grant = nil
        intendsToPlay = true
        let location = plan.location(at: position)
        startPreparing(
            index: location?.clipIndex ?? 0,
            localSeconds: location?.localSeconds ?? 0,
            shouldPlay: true
        )
    }

    private func installTimeObserverIfNeeded() {
        guard timeObserver == nil else { return }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, !self.isScrubbing, self.phase != .loading,
                      let global = self.plan.globalPosition(
                        localSeconds: max(0, time.seconds.isFinite ? time.seconds : 0),
                        clipIndex: self.activeIndex
                      ) else { return }
                self.position = global
            }
        }
    }

    private func resumePlayback() {
        guard plan.clips.indices.contains(activeIndex) else { return }
        switch recoveryPolicy.grantAction(now: Date(), expiresAt: grant?.expiresAt) {
        case .reuse:
            player.play()
        case .refresh:
            let location = plan.location(at: position)
            startPreparing(
                index: location?.clipIndex ?? activeIndex,
                localSeconds: location?.localSeconds ?? 0,
                shouldPlay: true
            )
        }
    }

    private func issuePrepareRequest() -> Int {
        prepareRequestID += 1
        return prepareRequestID
    }

    private func isCurrentRequest(generation expected: Int, requestID: Int) -> Bool {
        expected == generation && requestID == prepareRequestID
    }

    private func startPreparing(index: Int, localSeconds: TimeInterval, shouldPlay: Bool) {
        let expected = generation
        let requestID = issuePrepareRequest()
        Task { [weak self] in
            await self?.prepareClip(
                index: index,
                localSeconds: localSeconds,
                shouldPlay: shouldPlay,
                generation: expected,
                requestID: requestID
            )
        }
    }

    private func startSeekingCurrentItem(localSeconds: TimeInterval, shouldPlay: Bool) {
        let expected = generation
        let requestID = issuePrepareRequest()
        phase = .loading
        Task { [weak self] in
            guard let self,
                  self.isCurrentRequest(generation: expected, requestID: requestID),
                  !Task.isCancelled else { return }
            await self.player.seek(
                to: CMTime(seconds: localSeconds, preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero
            )
            guard self.isCurrentRequest(generation: expected, requestID: requestID),
                  !Task.isCancelled else { return }
            if shouldPlay && self.intendsToPlay {
                self.player.play()
            } else {
                self.phase = .paused
            }
        }
    }

    private func prepareClip(
        index: Int,
        localSeconds: TimeInterval,
        shouldPlay: Bool,
        generation expected: Int,
        requestID: Int
    ) async {
        guard isCurrentRequest(generation: expected, requestID: requestID),
              plan.clips.indices.contains(index),
              let loadGrant else { return }
        player.pause()
        cancellables.removeAll()
        phase = .loading
        activeIndex = index
        position = plan.globalPosition(localSeconds: localSeconds, clipIndex: index) ?? 0
        grant = nil

        do {
            let fresh = try await loadGrant(plan.clips[index].asset)
            guard isCurrentRequest(generation: expected, requestID: requestID),
                  activeIndex == index else { return }
            grant = fresh
            try audioSession.activate()
            let item = AVPlayerItem(url: fresh.url)
            observe(item: item, generation: expected, requestID: requestID)
            player.replaceCurrentItem(with: item)
            if localSeconds > 0 {
                await player.seek(
                    to: CMTime(seconds: localSeconds, preferredTimescale: 600),
                    toleranceBefore: .zero,
                    toleranceAfter: .zero
                )
                guard isCurrentRequest(generation: expected, requestID: requestID),
                      activeIndex == index else { return }
            }
            if shouldPlay && intendsToPlay {
                player.play()
            } else {
                phase = .paused
            }
        } catch {
            guard isCurrentRequest(generation: expected, requestID: requestID),
                  !Task.isCancelled else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    private func observe(item: AVPlayerItem, generation expected: Int, requestID: Int) {
        cancellables.removeAll()

        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                MainActor.assumeIsolated {
                    guard let self,
                          self.isCurrentRequest(generation: expected, requestID: requestID),
                          self.player.currentItem === item else { return }
                    self.handle(itemStatus: status, of: item)
                }
            }
            .store(in: &cancellables)

        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] control in
                MainActor.assumeIsolated {
                    guard let self,
                          self.isCurrentRequest(generation: expected, requestID: requestID) else { return }
                    self.handle(controlStatus: control)
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification, object: item)
            .map { _ in }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                MainActor.assumeIsolated {
                    guard let self,
                          self.isCurrentRequest(generation: expected, requestID: requestID),
                          self.player.currentItem === item else { return }
                    self.itemDidFinish()
                }
            }
            .store(in: &cancellables)
    }

    private func handle(itemStatus: AVPlayerItem.Status, of item: AVPlayerItem) {
        switch itemStatus {
        case .readyToPlay:
            retriesUsed = 0
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

    private func itemDidFinish() {
        let next = activeIndex + 1
        guard plan.clips.indices.contains(next) else {
            position = duration
            phase = .ended
            return
        }
        position = TimeInterval(plan.clips[next].startMs) / 1_000
        startPreparing(index: next, localSeconds: 0, shouldPlay: true)
    }

    private func handleFailure(message: String?) {
        switch recoveryPolicy.failureAction(retriesUsed: retriesUsed) {
        case .refresh:
            retriesUsed += 1
            grant = nil
            let location = plan.location(at: position)
            startPreparing(
                index: location?.clipIndex ?? activeIndex,
                localSeconds: location?.localSeconds ?? 0,
                shouldPlay: true
            )
        case .surface:
            phase = .failed(message ?? L10n.string("playback.failed"))
        }
    }

    private func resetPlayerState() {
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
        intendsToPlay = false
        phase = .idle
    }
}
