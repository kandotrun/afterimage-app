import AVFoundation
import Combine
import SwiftUI

@MainActor
final class DayPreviewPlaybackController: ObservableObject {
    let player = AVPlayer()

    private let itemFactory: @MainActor (URL) -> AVPlayerItem
    private let startPlayback: @MainActor (AVPlayer) -> Void
    private var assets: [Asset] = []
    private var loadGrant: (@MainActor (Asset) async throws -> ResolvedPlaybackGrant)?
    private var itemObservers = Set<AnyCancellable>()
    private var advanceTask: Task<Void, Never>?
    private var failuresInCycle = 0
    private var generation = 0

    init(
        itemFactory: @escaping @MainActor (URL) -> AVPlayerItem = { AVPlayerItem(url: $0) },
        startPlayback: @escaping @MainActor (AVPlayer) -> Void = { $0.play() }
    ) {
        self.itemFactory = itemFactory
        self.startPlayback = startPlayback
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
    }

    nonisolated static func nextIndex(after index: Int, count: Int) -> Int? {
        guard count > 0 else { return nil }
        return (index + 1) % count
    }

    func activate(
        assets: [Asset],
        loadGrant: @escaping @MainActor (Asset) async throws -> ResolvedPlaybackGrant
    ) async {
        deactivate()
        let expected = generation
        self.assets = assets
        self.loadGrant = loadGrant
        await prepare(index: 0, generation: expected)
    }

    func deactivate() {
        generation += 1
        advanceTask?.cancel()
        advanceTask = nil
        stopCurrentItem()
        assets = []
        loadGrant = nil
        failuresInCycle = 0
    }

    private func prepare(index: Int, generation expected: Int) async {
        guard expected == generation,
              !Task.isCancelled,
              assets.indices.contains(index),
              let loadGrant else { return }
        do {
            let grant = try await loadGrant(assets[index])
            guard expected == generation, !Task.isCancelled else { return }
            let item = itemFactory(grant.url)
            observe(item: item, index: index, generation: expected)
            player.replaceCurrentItem(with: item)
            startPlayback(player)
        } catch {
            guard expected == generation else { return }
            if Task.isCancelled
                || error is CancellationError
                || (error as? URLError)?.code == .cancelled {
                stopCurrentItem()
                return
            }
            handleFailure(after: index, generation: expected)
        }
    }

    private func observe(item: AVPlayerItem, index: Int, generation expected: Int) {
        itemObservers.removeAll()

        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                MainActor.assumeIsolated {
                    guard status == .failed,
                          let self,
                          self.isCurrent(item: item, generation: expected) else { return }
                    self.handleFailure(after: index, generation: expected)
                }
            }
            .store(in: &itemObservers)

        NotificationCenter.default.publisher(
            for: AVPlayerItem.didPlayToEndTimeNotification,
            object: item
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self,
                      self.isCurrent(item: item, generation: expected) else { return }
                self.failuresInCycle = 0
                self.advance(after: index, generation: expected)
            }
        }
        .store(in: &itemObservers)

        NotificationCenter.default.publisher(
            for: AVPlayerItem.failedToPlayToEndTimeNotification,
            object: item
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self,
                      self.isCurrent(item: item, generation: expected) else { return }
                self.handleFailure(after: index, generation: expected)
            }
        }
        .store(in: &itemObservers)
    }

    private func isCurrent(item: AVPlayerItem, generation expected: Int) -> Bool {
        expected == generation && player.currentItem === item
    }

    private func handleFailure(after index: Int, generation expected: Int) {
        guard expected == generation else { return }
        stopCurrentItem()
        failuresInCycle += 1
        guard failuresInCycle < assets.count else { return }
        advance(after: index, generation: expected)
    }

    private func advance(after index: Int, generation expected: Int) {
        guard expected == generation,
              let next = Self.nextIndex(after: index, count: assets.count) else { return }
        advanceTask?.cancel()
        advanceTask = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.prepare(index: next, generation: expected)
        }
    }

    private func stopCurrentItem() {
        itemObservers.removeAll()
        player.pause()
        player.replaceCurrentItem(with: nil)
    }
}

struct DayPreviewPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> DayPreviewPlayerView {
        DayPreviewPlayerView(player: player)
    }

    func updateUIView(_ uiView: DayPreviewPlayerView, context: Context) {
        uiView.playerLayer.player = player
    }
}

final class DayPreviewPlayerView: UIView {
    override class var layerClass: AnyClass {
        AVPlayerLayer.self
    }

    var playerLayer: AVPlayerLayer {
        layer as! AVPlayerLayer
    }

    init(player: AVPlayer) {
        super.init(frame: .zero)
        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspectFill
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError()
    }
}
