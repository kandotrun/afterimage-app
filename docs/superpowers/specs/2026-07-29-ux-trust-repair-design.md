# UX Trust Repair (audit tiers 1–2)

Date: 2026-07-29
Status: approved in session (owner selected all four audit tiers; this spec covers
the first PR — bug-grade fixes and state/trust surfacing. Tiers 3–4 land in a
follow-up PR from latest main.)

## Background

A ten-lens UI/UX audit of main@8346c20 (timeline, detail, daily playback, camera,
upload, auth/settings/notifications, states, accessibility, emotional design,
copy/l10n) produced 75 findings. The owner chose to address all four priority
tiers. This PR fixes the failures that actively break the experience, and the
silent-failure states that erode trust in a lifelog.

## Fixes (bug grade)

1. **Control Center no longer stops a recording.** `scenePhase == .inactive`
   (Control Center, notification shade, call banner) was treated like
   `.background`. New pure `CameraCapturePolicy.sceneChangeAction` maps
   active/inactive/background → resume/ignore/suspend; the view uses it.
   Real interruptions still stop capture via the AVCaptureSession interruption path.
2. **Capture review plays audio in silent mode.** `ReviewVideoView` now activates
   `PlaybackAudioSession` (the b337e15 fix had missed this surface).
3. **Day-story preview no longer loops forever refetching grants.**
   `DayPreviewPlaybackController.nextIndex` stops after one pass (the preview
   rests on the last frame); grants are cached per asset until their TTL
   (via `PlaybackRecoveryPolicy`) and survive re-activation; failures evict the
   cached grant. Hero previews additionally skip Low Power Mode.
4. **Tapping the nightly reminder opens the camera.** `AppDelegate` implements
   `didReceive` and routes through a new `NotificationIntentRouter` that
   `TimelineView` consumes (warm and cold launch); `willPresent` suppresses the
   reminder banner while the app is foregrounded.
   `DailyPostReminderPolicy.isReminder(identifier:)` is the shared, tested check.
5. **A failed background upload is no longer a dead end.** `AppModel` exposes
   `hasStalledUpload`; the dock swaps "+" for resume/discard pills, so the
   persisted state can be resumed in-session instead of only at next app launch
   (previously importItems silently refused all new work).
6. **A finished upload always shows up.** `refreshTimeline` coalesces concurrent
   calls instead of silently returning when one is in flight;
   `refreshTimelineEnsuringFresh` (used by upload completion) waits out the
   current fetch and fetches again.
7. **Daily playback load failure gets a retry button** (errorState already
   supported an action; the initial-load call site never passed one).
8. **Sign-out clears the client bearer token** after revoking the session.

## State & trust surfacing

- **Timeline three-state.** `TimelineLoadState` (loading/loaded/failed):
  loading shows a spinner instead of a blank screen; failure with no content
  shows a dedicated retry view — an offline launch no longer shows years of
  records as "最初のafterimageを残そう".
- **Refresh failures are visible.** Pull-to-refresh and the account-menu reload
  route through `refreshTimelineReportingFailure`, which surfaces a transient
  glass toast (`transientNotice`, auto-clears) instead of swallowing errors.
- **Pagination failures are non-modal.** `loadMoreIfNeeded` sets
  `paginationFailed` (no more repeating alerts); the timeline footer shows a
  loading indicator or an inline retry row.
- **Thumbnails retry.** `AuthenticatedThumbnail` retries with backoff and
  re-attempts after each successful refresh (`timelineGeneration`).
- **Transcript states are visible in the detail pager.** The transcript button
  also appears for pending/processing/failed; `TranscriptSheet` explains each
  state and offers retry on load errors (parity with daily playback).
- **Session expiry says why.** Any 401 signs out locally, clears the bearer
  token, and shows "セッションの有効期限が切れました" instead of a dead
  authenticated screen or an unexplained login screen.
- **Batch imports survive one broken file.** Item-scoped errors
  (unsupported media, missing capture date, compression failure) are counted and
  reported once ("%lld件を保存できませんでした") instead of silently dropping
  the rest of the batch; global errors still abort.
- **Destructive taps confirm.** Multi-item upload cancel and sign-out get
  confirmation dialogs (sign-out notes the interrupted upload when one is running).

## Contract & localization

- 21 new catalog keys (12 semantic, 9 Japanese-literal), each in ja/en/zh-Hans/ko.
- `verify-ios-contract.mjs` and `verify-ios-localizations.mjs` pass unchanged.

## Verification

Full `xcodebuild test` suite (unit + UI) and `npm run check`; seeded-simulator
smoke of the timeline. New XCTest coverage: scene-change policy, reminder
identifier routing, preview single-pass + grant cache reuse/expiry.
