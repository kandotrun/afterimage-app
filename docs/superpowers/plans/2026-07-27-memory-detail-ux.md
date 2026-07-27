# Memory Detail UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `MemoryDetailView` into a photo-app-grade experience: zoom transition + swipe-down dismiss, horizontal paging, autoplay custom Liquid Glass video player with grant-expiry recovery, pinch-zoom photos, and transcript display.

**Architecture:** Pure policy objects (`PlayerChrome`, `PlaybackRecoveryPolicy`, `MemoryPagerPolicy`, `PlaybackClock`) hold every testable decision; `VideoPlaybackController` (`@MainActor ObservableObject`) owns the AVPlayer lifecycle; SwiftUI views stay thin. Spec: `docs/superpowers/specs/2026-07-27-memory-detail-ux-design.md`.

**Tech Stack:** SwiftUI (iOS 26 only), AVFoundation + AVPlayerLayer, Combine KVO publishers, UIScrollView representable, XCTest, XcodeGen.

**Conventions:** English conventional commits. 4-space Swift indent. Every commit keeps the whole suite green. Run all iOS commands from `ios/` after `xcodegen generate` (the `.xcodeproj` is gitignored). Test destination: `-destination 'platform=iOS Simulator,name=iPhone 17 Pro'` (if missing, pick any iPhone from `xcrun simctl list devices available`).

---

### Task 0: Generate the Xcode project

- [ ] **Step 0.1:** Run: `cd ios && xcodegen generate`
Expected: `Created project at .../afterimage.xcodeproj`. New source files added later are picked up by re-running `xcodegen generate` (sources are declared by directory).

---

### Task 1: PlayerChrome visibility policy

**Files:**
- Create: `ios/Sources/Playback/PlayerChrome.swift`
- Test: `ios/Tests/PlayerChromeTests.swift`

- [ ] **Step 1.1: Write the failing test**

```swift
import XCTest
@testable import afterimage

final class PlayerChromeTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testTapToggles() {
        var chrome = PlayerChrome()
        chrome.apply(.tapped(at: t0, isPlaying: false))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0, isPlaying: false))
        XCTAssertTrue(chrome.isVisible)
        XCTAssertNil(chrome.hideDeadline)
    }

    func testAutoHidesAfterDelayWhilePlaying() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(1)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(PlayerChrome.autoHideDelay)))
        XCTAssertFalse(chrome.isVisible)
    }

    func testPauseShowsAndDisarms() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(5)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0.addingTimeInterval(6), isPlaying: true))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.paused)
        XCTAssertNil(chrome.hideDeadline)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(60)))
        XCTAssertTrue(chrome.isVisible)
    }

    func testScrubKeepsChromeUntilPlaybackResumes() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.scrubBegan)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(60)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.scrubEnded)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(120)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.playbackStarted(at: t0.addingTimeInterval(120)))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(123)))
        XCTAssertFalse(chrome.isVisible)
    }

    func testPlaybackEndedShowsChrome() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(10)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.playbackEnded)
        XCTAssertTrue(chrome.isVisible)
        XCTAssertNil(chrome.hideDeadline)
    }

    func testTappedWhileHiddenDuringPlaybackRearmsAutoHide() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(3)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0.addingTimeInterval(4), isPlaying: true))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(7)))
        XCTAssertFalse(chrome.isVisible)
    }
}
```

- [ ] **Step 1.2: Run test to verify it fails**

Run (from `ios/`): `xcodegen generate && xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/PlayerChromeTests CODE_SIGNING_ALLOWED=NO`
Expected: BUILD FAILED — `cannot find 'PlayerChrome' in scope`.

- [ ] **Step 1.3: Write minimal implementation**

```swift
import Foundation

/// Pure visibility state machine for the playback chrome (nav bar + controls).
/// The view layer forwards events and ticks a clock; auto-hide is deadline based.
struct PlayerChrome: Equatable, Sendable {
    static let autoHideDelay: TimeInterval = 3

    private(set) var isVisible: Bool
    private(set) var hideDeadline: Date?

    init(isVisible: Bool = true) {
        self.isVisible = isVisible
    }

    enum Event: Equatable, Sendable {
        case tapped(at: Date, isPlaying: Bool)
        case playbackStarted(at: Date)
        case paused
        case scrubBegan
        case scrubEnded
        case playbackEnded
        case clockTicked(at: Date)
    }

    mutating func apply(_ event: Event) {
        switch event {
        case let .tapped(at, isPlaying):
            isVisible.toggle()
            hideDeadline = isVisible && isPlaying ? at.addingTimeInterval(Self.autoHideDelay) : nil
        case let .playbackStarted(at):
            hideDeadline = isVisible ? at.addingTimeInterval(Self.autoHideDelay) : nil
        case .paused, .scrubBegan, .playbackEnded:
            isVisible = true
            hideDeadline = nil
        case .scrubEnded:
            hideDeadline = nil
        case let .clockTicked(at):
            if let deadline = hideDeadline, at >= deadline {
                isVisible = false
                hideDeadline = nil
            }
        }
    }
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Same command as 1.2. Expected: `Test Suite 'PlayerChromeTests' passed`.

- [ ] **Step 1.5: Commit**

```bash
git add ios/Sources/Playback/PlayerChrome.swift ios/Tests/PlayerChromeTests.swift
git commit -m "feat(ios): add player chrome visibility policy"
```

---

### Task 2: PlaybackRecoveryPolicy

**Files:**
- Create: `ios/Sources/Playback/PlaybackRecoveryPolicy.swift`
- Test: `ios/Tests/PlaybackRecoveryPolicyTests.swift`

- [ ] **Step 2.1: Write the failing test**

```swift
import XCTest
@testable import afterimage

final class PlaybackRecoveryPolicyTests: XCTestCase {
    private let policy = PlaybackRecoveryPolicy()
    private let now = Date(timeIntervalSince1970: 10_000)

    func testReusesFreshGrant() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(120)), .reuse)
    }

    func testRefreshesExpiredGrant() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(-1)), .refresh)
    }

    func testRefreshesGrantInsideSafetyMargin() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: now.addingTimeInterval(5)), .refresh)
    }

    func testRefreshesWhenNoGrantYet() {
        XCTAssertEqual(policy.grantAction(now: now, expiresAt: nil), .refresh)
    }

    func testAllowsSingleSilentRetryOnFailure() {
        XCTAssertEqual(policy.failureAction(retriesUsed: 0), .refresh)
        XCTAssertEqual(policy.failureAction(retriesUsed: 1), .surface)
    }
}
```

- [ ] **Step 2.2: Run test to verify it fails**

Run (from `ios/`): `xcodegen generate && xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/PlaybackRecoveryPolicyTests CODE_SIGNING_ALLOWED=NO`
Expected: BUILD FAILED — `cannot find 'PlaybackRecoveryPolicy' in scope`.

- [ ] **Step 2.3: Write minimal implementation**

```swift
import Foundation

/// Pure decisions for the playback-grant lifecycle: reuse vs refresh before
/// playing, and whether an item failure deserves one silent re-grant.
struct PlaybackRecoveryPolicy: Equatable, Sendable {
    var safetyMargin: TimeInterval = 10
    var maxFailureRetries = 1

    enum GrantAction: Equatable, Sendable { case reuse, refresh }
    enum FailureAction: Equatable, Sendable { case refresh, surface }

    func grantAction(now: Date, expiresAt: Date?) -> GrantAction {
        guard let expiresAt else { return .refresh }
        return now.addingTimeInterval(safetyMargin) < expiresAt ? .reuse : .refresh
    }

    func failureAction(retriesUsed: Int) -> FailureAction {
        retriesUsed < maxFailureRetries ? .refresh : .surface
    }
}
```

- [ ] **Step 2.4: Run test to verify it passes** (same command)

- [ ] **Step 2.5: Commit**

```bash
git add ios/Sources/Playback/PlaybackRecoveryPolicy.swift ios/Tests/PlaybackRecoveryPolicyTests.swift
git commit -m "feat(ios): add playback grant recovery policy"
```

---

### Task 3: MemoryPagerPolicy

**Files:**
- Create: `ios/Sources/Features/Memory/MemoryPagerPolicy.swift`
- Test: `ios/Tests/MemoryPagerPolicyTests.swift`

- [ ] **Step 3.1: Write the failing test**

```swift
import XCTest
@testable import afterimage

final class MemoryPagerPolicyTests: XCTestCase {
    func testDeletionInMiddleKeepsIndex() {
        XCTAssertEqual(MemoryPagerPolicy.selectionAfterDeletion(of: 1, count: 4), 1)
    }

    func testDeletionAtTailStepsBack() {
        XCTAssertEqual(MemoryPagerPolicy.selectionAfterDeletion(of: 3, count: 4), 2)
    }

    func testDeletionOfLastRemainingDismisses() {
        XCTAssertNil(MemoryPagerPolicy.selectionAfterDeletion(of: 0, count: 1))
    }
}
```

- [ ] **Step 3.2: Run to verify FAIL** (`-only-testing:afterimageTests/MemoryPagerPolicyTests`, after `xcodegen generate`)

- [ ] **Step 3.3: Write minimal implementation**

```swift
import Foundation

/// Pure paging decisions for the memory detail pager.
enum MemoryPagerPolicy {
    /// Selection after deleting the item at `index` from a list that had
    /// `count` items. Returns the index into the remaining list, or nil when
    /// nothing remains and the pager should dismiss.
    static func selectionAfterDeletion(of index: Int, count: Int) -> Int? {
        let remaining = count - 1
        guard remaining > 0 else { return nil }
        return min(max(0, index), remaining - 1)
    }
}
```

- [ ] **Step 3.4: Run to verify PASS**

- [ ] **Step 3.5: Commit**

```bash
git add ios/Sources/Features/Memory/MemoryPagerPolicy.swift ios/Tests/MemoryPagerPolicyTests.swift
git commit -m "feat(ios): add memory pager deletion policy"
```

---

### Task 4: PlaybackClock time formatting

**Files:**
- Create: `ios/Sources/Playback/PlaybackClock.swift`
- Test: `ios/Tests/PlaybackClockTests.swift`

- [ ] **Step 4.1: Write the failing test**

```swift
import XCTest
@testable import afterimage

final class PlaybackClockTests: XCTestCase {
    func testFormatsMinutesAndSeconds() {
        XCTAssertEqual(PlaybackClock.label(0), "0:00")
        XCTAssertEqual(PlaybackClock.label(65), "1:05")
        XCTAssertEqual(PlaybackClock.label(3_599), "59:59")
    }

    func testRejectsNonFiniteValues() {
        XCTAssertEqual(PlaybackClock.label(.nan), "0:00")
        XCTAssertEqual(PlaybackClock.label(.infinity), "0:00")
        XCTAssertEqual(PlaybackClock.label(-4), "0:00")
    }
}
```

- [ ] **Step 4.2: Run to verify FAIL** (`-only-testing:afterimageTests/PlaybackClockTests`, after `xcodegen generate`)

- [ ] **Step 4.3: Write minimal implementation**

```swift
import Foundation

enum PlaybackClock {
    static func label(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
```

- [ ] **Step 4.4: Run to verify PASS**

- [ ] **Step 4.5: Commit**

```bash
git add ios/Sources/Playback/PlaybackClock.swift ios/Tests/PlaybackClockTests.swift
git commit -m "feat(ios): add playback time formatter"
```

---

### Task 5: API models — transcription fields, TranscriptResponse, ResolvedPlaybackGrant

**Files:**
- Modify: `ios/Sources/Models/APIModels.swift`
- Test: `ios/Tests/APIContractTests.swift` (append tests)

- [ ] **Step 5.1: Write the failing tests** — append inside `final class APIContractTests`:

```swift
    func testAssetDecodesTranscriptionFields() throws {
        let json = """
        {
          "id": "asset-2",
          "kind": "video",
          "filename": "memory.mov",
          "contentType": "video/quicktime",
          "byteSize": 99,
          "capturedAt": "2026-07-27T01:02:03.000Z",
          "durationMs": 1000,
          "width": 1080,
          "height": 1920,
          "status": "ready",
          "contentUrl": "/v1/assets/asset-2/content",
          "thumbnailUrl": "/v1/assets/asset-2/thumbnail",
          "transcriptionStatus": "completed",
          "transcriptUrl": "/v1/assets/asset-2/transcript",
          "createdAt": "2026-07-27T01:03:00.000Z",
          "updatedAt": "2026-07-27T01:04:00.000Z"
        }
        """.data(using: .utf8)!
        let asset = try JSONDecoder.afterimage.decode(Asset.self, from: json)
        XCTAssertEqual(asset.transcriptionStatus, "completed")
        XCTAssertEqual(asset.transcriptUrl, "/v1/assets/asset-2/transcript")
    }

    func testAssetToleratesMissingTranscriptionFields() throws {
        let json = """
        {
          "id": "asset-3",
          "kind": "photo",
          "filename": "memory.heic",
          "contentType": "image/heic",
          "byteSize": 42,
          "capturedAt": "2026-07-27T01:02:03.000Z",
          "status": "ready",
          "contentUrl": "/v1/assets/asset-3/content",
          "thumbnailUrl": null,
          "createdAt": "2026-07-27T01:03:00.000Z",
          "updatedAt": "2026-07-27T01:04:00.000Z"
        }
        """.data(using: .utf8)!
        let asset = try JSONDecoder.afterimage.decode(Asset.self, from: json)
        XCTAssertNil(asset.transcriptionStatus)
        XCTAssertNil(asset.transcriptUrl)
    }

    func testTranscriptResponseDecodes() throws {
        let json = """
        {
          "assetId": "asset-2",
          "status": "completed",
          "language": "ja",
          "text": "こんにちは",
          "updatedAt": "2026-07-27T01:05:00.000Z"
        }
        """.data(using: .utf8)!
        let transcript = try JSONDecoder.afterimage.decode(TranscriptResponse.self, from: json)
        XCTAssertEqual(transcript.text, "こんにちは")
        XCTAssertEqual(transcript.language, "ja")
        XCTAssertEqual(transcript.status, "completed")
    }
```

- [ ] **Step 5.2: Run to verify FAIL** (`-only-testing:afterimageTests/APIContractTests`) — build error: `Asset` has no `transcriptionStatus`; `TranscriptResponse` not found.

- [ ] **Step 5.3: Implement.** In `APIModels.swift`, inside `struct Asset`, add after `let contentUrl: String?`:

```swift
    let transcriptionStatus: String?
    let transcriptUrl: String?
```

and replace its `CodingKeys` with:

```swift
    private enum CodingKeys: String, CodingKey {
        case id, status, filename, contentType, byteSize, width, height, durationMs
        case capturedAt, createdAt, updatedAt, thumbnailUrl, contentUrl
        case transcriptionStatus, transcriptUrl
        case mediaType = "kind"
    }
```

After `struct PlaybackGrant` add:

```swift
struct ResolvedPlaybackGrant: Equatable, Sendable {
    let url: URL
    let expiresAt: Date
}

struct TranscriptResponse: Decodable, Equatable, Sendable {
    let assetId: String
    let status: String
    let language: String?
    let text: String
    let updatedAt: Date?
}
```

- [ ] **Step 5.4: Run to verify PASS** (whole `afterimageTests` this time — the timeline decode test must stay green)

- [ ] **Step 5.5: Commit**

```bash
git add ios/Sources/Models/APIModels.swift ios/Tests/APIContractTests.swift
git commit -m "feat(ios): decode transcription fields and transcript payloads"
```

---

### Task 6: APIClient + AppModel accessors (additive — old `playbackURL` stays until Task 9)

**Files:**
- Modify: `ios/Sources/Networking/APIClient.swift` (add below `playbackURL`)
- Modify: `ios/Sources/App/AppModel.swift` (add below `playbackURL(for:)`)

- [ ] **Step 6.1: Implement.** In `APIClient`, add after the existing `playbackURL(assetID:)`:

```swift
    func playbackGrant(assetID: String) async throws -> ResolvedPlaybackGrant {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/playback", method: "POST")
        let grant: PlaybackGrant = try await decode(request)
        return ResolvedPlaybackGrant(url: try resolver.resolve(grant.url), expiresAt: grant.expiresAt)
    }

    func transcript(assetID: String) async throws -> TranscriptResponse {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/transcript", method: "GET")
        return try await decode(request)
    }
```

In `AppModel`, add after the existing `playbackURL(for:)`:

```swift
    func playbackGrant(for asset: Asset) async throws -> ResolvedPlaybackGrant {
        try await api.playbackGrant(assetID: asset.id)
    }

    func transcript(for asset: Asset) async throws -> TranscriptResponse {
        try await api.transcript(assetID: asset.id)
    }
```

- [ ] **Step 6.2: Build + full test run to stay green** (no `-only-testing` filter). Expected: all suites pass.

- [ ] **Step 6.3: Commit**

```bash
git add ios/Sources/Networking/APIClient.swift ios/Sources/App/AppModel.swift
git commit -m "feat(ios): add playback grant and transcript API accessors"
```

---

### Task 7: VideoPlaybackController + VideoMemoryView

**Files:**
- Create: `ios/Sources/Features/Memory/VideoPlaybackController.swift`
- Create: `ios/Sources/Features/Memory/VideoMemoryView.swift`

These are integration-layer files (AVPlayer, views); the policy behavior was already TDD'd in Tasks 1–4. Gate: project-wide build + existing suite green.

- [ ] **Step 7.1: Create `VideoPlaybackController.swift`**

```swift
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
                    toleranceAfter: .zero
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
```

- [ ] **Step 7.2: Create `VideoMemoryView.swift`**

```swift
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
                .accessibilityLabel(controller.phase == .playing ? "一時停止" : "再生")

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
```

- [ ] **Step 7.3: Build + full test run** (after `xcodegen generate`). Expected: green.

- [ ] **Step 7.4: Commit**

```bash
git add ios/Sources/Features/Memory/VideoPlaybackController.swift ios/Sources/Features/Memory/VideoMemoryView.swift
git commit -m "feat(ios): custom Liquid Glass video player with autoplay and grant recovery"
```

---

### Task 8: PhotoMemoryView + ZoomableImageView + TranscriptSheet

**Files:**
- Create: `ios/Sources/Features/Memory/ZoomableImageView.swift`
- Create: `ios/Sources/Features/Memory/PhotoMemoryView.swift`
- Create: `ios/Sources/Features/Memory/TranscriptSheet.swift`

- [ ] **Step 8.1: Create `ZoomableImageView.swift`**

```swift
import SwiftUI
import UIKit

/// UIScrollView-backed pinch-zoomable image with double-tap zoom and a single
/// tap callback (used to toggle the chrome). At minimum zoom, pans fall
/// through to the surrounding pager.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let onSingleTap: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSingleTap: onSingleTap)
    }

    func makeUIView(context: Context) -> ZoomScrollView {
        let scrollView = ZoomScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 4
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        let singleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleSingleTap)
        )
        singleTap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(singleTap)

        scrollView.onLayout = { [weak scrollView, coordinator = context.coordinator] in
            guard let scrollView else { return }
            coordinator.relayout(scrollView)
        }
        return scrollView
    }

    func updateUIView(_ scrollView: ZoomScrollView, context: Context) {
        context.coordinator.onSingleTap = onSingleTap
        if context.coordinator.imageView?.image !== image {
            context.coordinator.imageView?.image = image
            scrollView.setZoomScale(1, animated: false)
            context.coordinator.relayout(scrollView)
        }
    }

    final class ZoomScrollView: UIScrollView {
        var onLayout: (() -> Void)?

        override func layoutSubviews() {
            super.layoutSubviews()
            onLayout?()
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var onSingleTap: () -> Void
        weak var imageView: UIImageView?

        init(onSingleTap: @escaping () -> Void) {
            self.onSingleTap = onSingleTap
        }

        func relayout(_ scrollView: UIScrollView) {
            guard let imageView, let image = imageView.image,
                  scrollView.bounds.width > 0, scrollView.bounds.height > 0 else { return }
            if scrollView.zoomScale == scrollView.minimumZoomScale {
                let bounds = scrollView.bounds.size
                let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
                let fitted = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                imageView.frame = CGRect(origin: .zero, size: fitted)
                scrollView.contentSize = fitted
            }
            center(scrollView)
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            center(scrollView)
        }

        private func center(_ scrollView: UIScrollView) {
            let insetX = max((scrollView.bounds.width - scrollView.contentSize.width) / 2, 0)
            let insetY = max((scrollView.bounds.height - scrollView.contentSize.height) / 2, 0)
            scrollView.contentInset = UIEdgeInsets(top: insetY, left: insetX, bottom: insetY, right: insetX)
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView = gesture.view as? UIScrollView else { return }
            if scrollView.zoomScale > scrollView.minimumZoomScale {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let width = scrollView.bounds.width / 2.5
                let height = scrollView.bounds.height / 2.5
                let target = CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height)
                scrollView.zoom(to: target, animated: true)
            }
        }

        @objc func handleSingleTap() {
            onSingleTap()
        }
    }
}
```

- [ ] **Step 8.2: Create `PhotoMemoryView.swift`**

```swift
import SwiftUI
import UIKit

struct PhotoMemoryView: View {
    @EnvironmentObject private var model: AppModel
    let asset: Asset
    let onSingleTap: () -> Void

    @State private var thumbnail: UIImage?
    @State private var fullImage: UIImage?
    @State private var loadError: String?

    var body: some View {
        ZStack {
            if let image = fullImage ?? thumbnail {
                ZoomableImageView(image: image, onSingleTap: onSingleTap)
            } else if loadError == nil {
                ProgressView().tint(.white)
            }
            if let loadError {
                VStack(spacing: 14) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.largeTitle)
                    Text(loadError)
                        .font(.callout)
                        .multilineTextAlignment(.center)
                    Button("再試行") {
                        Task { await load() }
                    }
                    .buttonStyle(.glass)
                }
                .foregroundStyle(.white.opacity(0.82))
                .padding(28)
            }
        }
        .task(id: asset.id) { await load() }
    }

    private func load() async {
        loadError = nil
        guard fullImage == nil else { return }
        if thumbnail == nil, asset.thumbnailUrl != nil,
           let data = try? await model.thumbnailData(for: asset) {
            thumbnail = UIImage(data: data)
        }
        do {
            let data = try await model.photoData(for: asset)
            guard let image = UIImage(data: data) else { throw AfterimageError.invalidResponse }
            fullImage = image
        } catch {
            if fullImage == nil, thumbnail == nil {
                loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
```

- [ ] **Step 8.3: Create `TranscriptSheet.swift`**

```swift
import SwiftUI
import UIKit

struct TranscriptSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset

    @State private var transcript: TranscriptResponse?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let transcript {
                    ScrollView {
                        Text(transcript.text)
                            .font(.body)
                            .lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20)
                            .textSelection(.enabled)
                    }
                } else if let loadError {
                    ContentUnavailableView(
                        "読み込めませんでした",
                        systemImage: "exclamationmark.circle",
                        description: Text(loadError)
                    )
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("文字起こし")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("コピー", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = transcript?.text
                    }
                    .disabled(transcript == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func load() async {
        do {
            transcript = try await model.transcript(for: asset)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
```

- [ ] **Step 8.4: Build + full test run** (after `xcodegen generate`). Expected: green.

- [ ] **Step 8.5: Commit**

```bash
git add ios/Sources/Features/Memory/ZoomableImageView.swift ios/Sources/Features/Memory/PhotoMemoryView.swift ios/Sources/Features/Memory/TranscriptSheet.swift
git commit -m "feat(ios): pinch-zoom photo page and transcript sheet"
```

---

### Task 9: Rewrite MemoryDetailView as pager host; drop old playbackURL

**Files:**
- Rewrite: `ios/Sources/Features/Memory/MemoryDetailView.swift`
- Modify: `ios/Sources/Networking/APIClient.swift` (delete `playbackURL(assetID:)`)
- Modify: `ios/Sources/App/AppModel.swift` (delete `playbackURL(for:)`)

- [ ] **Step 9.1: Replace the entire content of `MemoryDetailView.swift`**

```swift
import SwiftUI

struct MemoryDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset

    @State private var selectedAssetID: String?
    @State private var chromeVisible = true
    @State private var confirmDelete = false
    @State private var showTranscript = false

    init(asset: Asset) {
        self.asset = asset
        _selectedAssetID = State(initialValue: asset.id)
    }

    private var currentAsset: Asset? {
        model.assets.first { $0.id == selectedAssetID }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            TabView(selection: $selectedAssetID) {
                ForEach(model.assets) { entry in
                    MemoryPageView(
                        asset: entry,
                        isActive: entry.id == selectedAssetID,
                        chromeVisible: $chromeVisible,
                        showTranscript: $showTranscript
                    )
                    .tag(Optional(entry.id))
                    .task { await model.loadMoreIfNeeded(after: entry) }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarVisibility(chromeVisible ? .visible : .hidden, for: .navigationBar)
        .statusBarHidden(!chromeVisible)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let currentAsset {
                        Text(Self.fileSize(currentAsset.byteSize))
                        Button("削除", systemImage: "trash", role: .destructive) {
                            confirmDelete = true
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("その他")
            }
        }
        .sheet(isPresented: $showTranscript) {
            if let currentAsset {
                TranscriptSheet(asset: currentAsset)
            }
        }
        .confirmationDialog("このafterimageを削除しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) { deleteCurrent() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("R2上の写真・動画も完全に削除されます。")
        }
        .onChange(of: model.assets) { _, assets in
            guard currentAsset == nil else { return }
            if let fallback = assets.first?.id {
                selectedAssetID = fallback
            } else {
                dismiss()
            }
        }
    }

    private var title: String {
        (currentAsset ?? asset).capturedAt.formatted(.dateTime.month(.wide).day().hour().minute())
    }

    private func deleteCurrent() {
        guard let target = currentAsset,
              let index = model.assets.firstIndex(where: { $0.id == target.id }) else { return }
        let remaining = model.assets.filter { $0.id != target.id }
        let nextID = MemoryPagerPolicy.selectionAfterDeletion(of: index, count: model.assets.count)
            .flatMap { remaining.indices.contains($0) ? remaining[$0].id : nil }
        Task {
            guard await model.delete(target) else { return }
            if let nextID {
                selectedAssetID = nextID
            } else {
                dismiss()
            }
        }
    }

    private static func fileSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

private struct MemoryPageView: View {
    let asset: Asset
    let isActive: Bool
    @Binding var chromeVisible: Bool
    @Binding var showTranscript: Bool

    var body: some View {
        if asset.mediaType == .video {
            VideoMemoryView(
                asset: asset,
                isActive: isActive,
                chromeVisible: $chromeVisible,
                showTranscript: $showTranscript
            )
        } else {
            PhotoMemoryView(asset: asset) {
                withAnimation(.easeInOut(duration: 0.2)) {
                    chromeVisible.toggle()
                }
            }
        }
    }
}
```

- [ ] **Step 9.2: Delete `playbackURL(assetID:)` from `APIClient.swift`** (lines defining `func playbackURL` and its body; `playbackGrant(assetID:)` stays).

- [ ] **Step 9.3: Delete `playbackURL(for:)` from `AppModel.swift`** (`playbackGrant(for:)` stays).

- [ ] **Step 9.4: Build + full test run** (after `xcodegen generate`). Expected: green — nothing else references `playbackURL`.

- [ ] **Step 9.5: Commit**

```bash
git add ios/Sources/Features/Memory/MemoryDetailView.swift ios/Sources/Networking/APIClient.swift ios/Sources/App/AppModel.swift
git commit -m "feat(ios): immersive paged memory detail with chrome toggling"
```

---

### Task 10: Zoom transition from the timeline

**Files:**
- Modify: `ios/Sources/Features/Timeline/TimelineView.swift`

- [ ] **Step 10.1:** Add a namespace property after `@State private var pendingOpen: Asset?`:

```swift
    @Namespace private var zoomTransition
```

- [ ] **Step 10.2:** Mark each tile as the transition source — the NavigationLink becomes:

```swift
                                            NavigationLink(value: asset) {
                                                MemoryTile(asset: asset)
                                            }
                                            .buttonStyle(.plain)
                                            .matchedTransitionSource(id: asset.id, in: zoomTransition)
                                            .task { await model.loadMoreIfNeeded(after: asset) }
```

- [ ] **Step 10.3:** Attach the zoom transition in the destination:

```swift
            .navigationDestination(for: Asset.self) { asset in
                MemoryDetailView(asset: asset)
                    .navigationTransition(.zoom(sourceID: asset.id, in: zoomTransition))
            }
```

(The debug `navigationDestination(item: $pendingOpen)` keeps no transition — no visible source tile is guaranteed.)

- [ ] **Step 10.4: Build + full test run.** Expected: green.

- [ ] **Step 10.5: Commit**

```bash
git add ios/Sources/Features/Timeline/TimelineView.swift
git commit -m "feat(ios): zoom transition from timeline tiles into memory detail"
```

---

### Task 11: Contract script + full gates

**Files:**
- Modify: `scripts/verify-ios-contract.mjs`

- [ ] **Step 11.1:** In the required-symbol array (the `for (const symbol of [...])` list), add after `"AVPlayer",`:

```js
  "AVPlayerLayer",
  "navigationTransition",
  "matchedTransitionSource",
```

- [ ] **Step 11.2: Run the gates from the repo root:**

```bash
node scripts/verify-ios-contract.mjs   # Expected: iOS source contract: PASS
npm run check                          # Expected: backend vitest + tsc + wrangler dry-run all pass
```

- [ ] **Step 11.3: Full iOS suite one last time** (from `ios/`): `xcodegen generate && xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 11.4: Commit**

```bash
git add scripts/verify-ios-contract.mjs
git commit -m "ci: require AVPlayerLayer and zoom transition in iOS contract"
```

---

### Task 12: Adversarial diff review, then PR

- [ ] **Step 12.1:** Run a multi-agent review of `git diff main...HEAD` (correctness / Swift 6 concurrency / repo-contract dimensions, verified findings only). Fix confirmed findings; re-run affected gates.
- [ ] **Step 12.2:** Push and open the PR:

```bash
git push -u origin feat/memory-detail-ux
gh pr create --title "feat(ios): photo-app-grade memory detail experience" --body "<summary of spec, changes, verification>"
```
