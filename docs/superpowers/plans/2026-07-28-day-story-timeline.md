# Day Story Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the utilitarian photo grid with day-based story modules (quote + hero + strip) per the approved spec `docs/superpowers/specs/2026-07-28-day-story-timeline-design.md`.

**Architecture:** Pure `DayStoryPolicy` decides hero/strip/quote (TDD); `DayStorySection` renders one day; `TimelineView` maps existing `MemoryDay` groups through the policy. Dead card/grid code is deleted.

**Tech Stack:** SwiftUI (iOS 26), XCTest, XcodeGen. Test destination: booted iPhone 17 Pro simulator (UDID in scratchpad).

---

### Task 1: DayStoryPolicy (TDD)

**Files:** Create `ios/Sources/Features/Timeline/DayStoryPolicy.swift`, Test `ios/Tests/DayStoryPolicyTests.swift`

- [ ] **Step 1.1: Failing test**

```swift
import XCTest
@testable import afterimage

final class DayStoryPolicyTests: XCTestCase {
    func testHeroPrefersTranscribedVideoOverNewerVideo() {
        let newerVideo = makeAsset(id: "v-new", kind: .video)
        let transcribed = makeAsset(id: "v-old", kind: .video, transcriptionStatus: .completed)
        let story = DayStoryPolicy.story(for: [newerVideo, transcribed])
        XCTAssertEqual(story?.hero.id, "v-old")
    }

    func testHeroFallsBackToNewestVideoThenNewestAsset() {
        XCTAssertEqual(
            DayStoryPolicy.story(for: [
                makeAsset(id: "p1"), makeAsset(id: "v1", kind: .video), makeAsset(id: "v2", kind: .video),
            ])?.hero.id,
            "v1"
        )
        XCTAssertEqual(
            DayStoryPolicy.story(for: [makeAsset(id: "p1"), makeAsset(id: "p2")])?.hero.id,
            "p1"
        )
    }

    func testStripExcludesHeroAndKeepsOrder() {
        let story = DayStoryPolicy.story(for: [
            makeAsset(id: "p1"), makeAsset(id: "v1", kind: .video), makeAsset(id: "p2"),
        ])
        XCTAssertEqual(story?.strip.map(\.id), ["p1", "p2"])
    }

    func testQuotePicksNewestNonEmptyPreview() {
        let story = DayStoryPolicy.story(for: [
            makeAsset(id: "a"),
            makeAsset(id: "b", kind: .video, transcriptionStatus: .completed, transcriptPreview: "   "),
            makeAsset(id: "c", kind: .video, transcriptionStatus: .completed, transcriptPreview: "海沿いを歩いた。"),
        ])
        XCTAssertEqual(story?.quote, "海沿いを歩いた。")
    }

    func testEmptyDayHasNoStory() {
        XCTAssertNil(DayStoryPolicy.story(for: []))
    }

    private func makeAsset(
        id: String,
        kind: MediaKind = .image,
        transcriptionStatus: TranscriptionStatus? = nil,
        transcriptPreview: String? = nil
    ) -> Asset {
        let date = Date(timeIntervalSince1970: 1_000)
        return Asset(
            id: id,
            mediaType: kind,
            status: .ready,
            filename: "memory",
            contentType: kind == .video ? "video/quicktime" : "image/heic",
            byteSize: 1,
            width: nil,
            height: nil,
            durationMs: nil,
            capturedAt: date,
            createdAt: date,
            updatedAt: date,
            thumbnailUrl: nil,
            contentUrl: nil,
            transcriptionStatus: transcriptionStatus,
            transcriptPreview: transcriptPreview,
            transcriptUrl: nil
        )
    }
}
```

- [ ] **Step 1.2: RED** — `xcodegen generate` then run `-only-testing:afterimageTests/DayStoryPolicyTests`; expect `cannot find 'DayStoryPolicy'`.

- [ ] **Step 1.3: Implementation**

```swift
import Foundation

/// One day's story: the most narrative-rich memory leads, the rest follow.
struct DayStory: Equatable {
    let hero: Asset
    let strip: [Asset]
    let quote: String?
}

enum DayStoryPolicy {
    /// `assets` is one day's memories, newest first (timeline order).
    static func story(for assets: [Asset]) -> DayStory? {
        guard let newest = assets.first else { return nil }
        let hero = assets.first { $0.mediaType == .video && $0.transcriptionStatus == .completed }
            ?? assets.first { $0.mediaType == .video }
            ?? newest
        let quote = assets
            .compactMap { $0.transcriptPreview?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return DayStory(hero: hero, strip: assets.filter { $0.id != hero.id }, quote: quote)
    }
}
```

- [ ] **Step 1.4: GREEN** — same command passes.
- [ ] **Step 1.5: Commit** — `feat(ios): add day story selection policy`

### Task 2: DayStorySection view + TimelineView rewrite + cleanup

**Files:** Create `ios/Sources/Features/Timeline/DayStorySection.swift`; rewrite the scroll content of `ios/Sources/Features/Timeline/TimelineView.swift`; delete `MemoryCardView.swift`, `MemoryCardLayout.swift`, `TimelineGridLayout.swift`, `ios/Tests/MemoryCardLayoutTests.swift`, `ios/Tests/TimelineGridLayoutTests.swift`.

- [ ] **Step 2.1:** `DayStorySection.swift` — date heading, serif 「quote」, 4:3 hero card (gradient foot, time, duration via `PlaybackClock`), 64pt strip; every cell is a `NavigationLink(value:)` with `.matchedTransitionSource(id:in:)` and the existing accessibility keys (`accessibility.video_at` / `accessibility.photo_at`).
- [ ] **Step 2.2:** `TimelineView` — drop `GeometryReader`/grid/pinned headers; `LazyVStack(spacing: 40)` of `DayStorySection` with `.padding(.horizontal, 20)`; section-level `.task { await model.loadMoreIfNeeded(after: section.assets.last ?? story.hero) }`; extend `MemoryDay.title` non-relative case with `.weekday(.wide)`. `MemoryTile` struct is deleted with the grid (keep `AuthenticatedThumbnail`).
- [ ] **Step 2.3:** Delete the five dead files listed above; `xcodegen generate`.
- [ ] **Step 2.4:** Full suite green; `node scripts/verify-ios-contract.mjs` and `node scripts/verify-ios-localizations.mjs` PASS.
- [ ] **Step 2.5: Commit** — `feat(ios): day story timeline replaces the photo grid`

### Task 3: Visual verification + gates + PR

- [ ] **Step 3.1:** `npm run check` from repo root.
- [ ] **Step 3.2:** Seeded simulator run (backend `npm run dev` + existing seed session token or re-seed); screenshot the timeline; confirm quote/hero/strip layout and that tapping still zooms (transition source present).
- [ ] **Step 3.3:** Push `feat/day-story-timeline`, open PR with before/after screenshots description.
