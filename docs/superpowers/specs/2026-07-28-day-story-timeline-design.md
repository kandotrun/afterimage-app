# Day Story Timeline

Date: 2026-07-28
Status: approved in session

## Problem

The timeline is a utilitarian 3-column photo grid. For a lifelog whose promise
is "keep the afterimages of your life", the list should read like days of a
life, not a camera roll. An earlier per-asset card attempt (`MemoryCardView`)
exists but was never wired in.

## Design (user picked direction B: "その日の物語", story view only — no grid)

One module per day, newest day first:

1. **Date heading** — 今日 / 昨日 / localized full date with wide weekday.
   No pinned headers; generous spacing (40pt between days).
2. **Day quote** — the newest non-empty `transcriptPreview` of the day,
   rendered as 「…」 in a serif face. Omitted when the day has none.
3. **Hero** — the day's most story-rich memory as a full-width rounded card
   (4:3, gradient foot, capture time, video duration badge).
   Priority: transcript-completed video > newest video > newest asset.
4. **Strip** — the remaining assets as a 64pt horizontally scrolling
   thumbnail row. Hero and strip cells keep the zoom transition into
   `MemoryDetailView`.

Selection logic lives in a pure `DayStoryPolicy` (XCTest-covered):
`story(for: [Asset]) -> DayStory?` with `DayStory { hero, strip, quote }`.

Unchanged: backdrop, UploadDock, empty state, pull-to-refresh, incremental
loading (section-level `loadMoreIfNeeded` on the day's oldest asset),
toolbar, localization contract (no new keys required).

Cleanup: delete dead `MemoryCardView`, `MemoryCardLayout`, retired
`TimelineGridLayout`, and their tests.

## Files

```
ios/Sources/Features/Timeline/
  DayStoryPolicy.swift    (new, pure)
  DayStorySection.swift   (new, view)
  TimelineView.swift      (grid → day story modules)
  MemoryCardView.swift / MemoryCardLayout.swift / TimelineGridLayout.swift (delete)
ios/Tests/
  DayStoryPolicyTests.swift (new)
  MemoryCardLayoutTests.swift / TimelineGridLayoutTests.swift (delete)
```

## Verification

`xcodebuild test` full suite; `npm run check` (contract + localization +
backend); seeded-simulator screenshots of the new timeline.
