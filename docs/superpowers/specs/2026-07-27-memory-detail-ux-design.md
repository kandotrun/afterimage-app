# Memory Detail UX Redesign

Date: 2026-07-27
Status: approved (user approved design in session; review gate waived by user request)

## Problem

`MemoryDetailView` is a thin stock implementation: AVKit `VideoPlayer` with no
autoplay and no thumbnail placeholder, plain push navigation with no zoom
transition or swipe-to-dismiss, no horizontal paging between memories, photos
cannot pinch-zoom, transcripts exist on the backend but have no UI, and playback
grants (TTL 300 s) expire mid-session with no recovery.

## Goals

1. Photo-app-grade immersion: zoom transition from the timeline tile,
   interactive swipe-down dismiss, horizontal paging between memories.
2. Fast video start: thumbnail-first, autoplay when ready, custom Liquid Glass
   controls with auto-hiding chrome.
3. Pinch-zoomable photos.
4. Transcript display for completed video transcriptions.
5. Playback-grant expiry recovery.

Non-goals: loop playback, AirPlay/route picker, share sheet, transcript UI for
pending/processing/failed states (button appears only when completed).

## Design

### Navigation and immersion

- Timeline tile: `matchedTransitionSource(id: asset.id, in: namespace)`.
  Detail: `navigationTransition(.zoom(sourceID:in:))`. Interactive swipe-down
  dismiss comes with the native zoom transition.
- `MemoryDetailView` becomes a host for a horizontal pager (`TabView`, page
  style, index display hidden) over `model.assets`, initial selection = tapped
  asset. Near the tail it calls `loadMoreIfNeeded`.
- Chrome (nav bar + playback controls) toggles on tap; auto-fades after ~3 s
  during playback. Hidden chrome = black immersive background only.
- Navigation title follows the current page's `capturedAt`. Ellipsis menu keeps
  file size + delete; after delete, move to the neighbor page or dismiss if
  none.

### Video playback

- Replace `VideoPlayer` with an `AVPlayerLayer`-backed `UIViewRepresentable`
  plus custom Liquid Glass controls (`.glassEffect`, tone-matched to
  `GlassProgressPill`).
- Startup: show the (cached) thumbnail immediately, fetch the playback grant
  and prepare `AVPlayer` concurrently, autoplay at `.readyToPlay`. Spinner
  overlays the thumbnail. Audio on; silent-mode playback behavior unchanged
  (`PlaybackAudioSession`).
- Controls: play/pause, scrubber (pause while scrubbing, resume after),
  elapsed/remaining time. Replay button at end; no loop.
- Only the visible page holds a live player; swiping away pauses and releases
  it. Audio session activates/deactivates per page.
- Grant recovery: keep `PlaybackGrant.expiresAt`; re-grant proactively when
  playing after expiry, and once reactively on `AVPlayerItem` failure, then
  seek back to the prior position.

### Photos

- `ZoomableImageView`: `UIScrollView`-based pinch zoom (1x–4x), double-tap
  toggle, pan; no pager conflict while zoomed.
- Thumbnail first, swap in the full image when loaded.

### Transcript

- Add optional `transcriptionStatus` / `transcriptUrl` to `Asset` (backend
  `assetJson` already returns them).
- `APIClient.transcript(assetID:)` → `GET /v1/assets/:id/transcript` →
  `{ assetId, status, language, text, updatedAt }`.
- Videos with a completed transcript show a glass button opening a sheet
  (`presentationDetents([.medium, .large])`) with the text and a copy button.

### Testing (TDD) and contract

Pure policy objects with XCTest, per repo convention:

- `PlayerChromePolicy` — chrome visibility state machine (tap, scrub,
  pause, ended, auto-hide timing).
- `PlaybackRecoveryPolicy` — decide reuse / re-grant / give-up from
  `expiresAt` and a retry budget.
- `MemoryPagerPolicy` — load-more trigger and active-page decisions.
- Time formatting; `Asset`/transcript decoding added to the API contract
  tests.
- `scripts/verify-ios-contract.mjs`: add required symbols `AVPlayerLayer` and
  `navigationTransition`; all existing required symbols (`AVPlayer`,
  `/playback`, …) remain present.

### Files

```
ios/Sources/Features/Memory/
  MemoryDetailView.swift      # pager host (destination name kept)
  VideoMemoryView.swift       # video page + controls
  VideoPlaybackController.swift
  PhotoMemoryView.swift
  ZoomableImageView.swift
  TranscriptSheet.swift
ios/Sources/Playback/
  PlayerChromePolicy.swift
  PlaybackRecoveryPolicy.swift
```

`AppModel` gains `playbackGrant(for:)` (returns URL + `expiresAt`; replaces
`playbackURL(for:)`) and `transcript(for:)`.

## Error handling

- Load failure keeps the existing failure view, plus a retry button.
- Grant re-fetch failure surfaces the standard error notice; playback stays
  paused at the last position.

## Verification

- `npm run check`, `node scripts/verify-ios-contract.mjs`
- `cd ios && xcodegen generate && xcodebuild test -project afterimage.xcodeproj
  -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
  CODE_SIGNING_ALLOWED=NO`
