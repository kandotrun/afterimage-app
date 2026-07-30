# UX Emotional Polish (audit tiers 3–4)

Date: 2026-07-29
Status: approved in session (second of two PRs from the ten-lens UX audit;
tiers 1–2 are `2026-07-29-ux-trust-repair-design.md`)

## Emotional core moments (tier 3)

1. **「1年前のきょう」** — the timeline's first module resurfaces the same day
   one year ago when it has videos (`AppModel.loadOneYearAgoStory`, cached per
   calendar day; `OneYearAgoCard` glass row → existing `DailyPlaybackRoute`).
2. **Daily playback end card** — finishing a day now closes it:
   「この日は、ここまで。」 in serif, the date, its weather badge, the daily
   summary, clip count/duration, and a 「もう一度」 replay (glass) fading in
   over the last frame.
3. **Upload payoff** — after the success haptic, the dock shows a
   「今日の残像を受け取りました」 glass pill for 2.5 s instead of vanishing.
4. **Launch moment** — bootstrapping shows the breathing brand mark and
   wordmark instead of an anonymous spinner; root transitions cross-fade.
   Reduce Motion gets a static mark.
5. **Considerate notification consent** — `reschedule` no longer fires the OS
   permission dialog during sign-in. After the first post lands, a glass sheet
   (「おやすみ前のお知らせ」) explains the nightly invitation; only accepting
   calls `requestAuthorization`. Offered once (`UserDefaults` flag).
6. **First-load skeleton** — day-story-shaped placeholders (title bar, 4:3
   hero, 64pt strip) pulse while the first page loads.
7. **Detail title with distance** — the pager title adds the year for non-current
   years plus a relative line (「1年前」) in a principal toolbar stack.
8. **Empty today invitation** — the standalone today-weather row gains
   「今日の残像は、これから。」.

Deferred: place-name location chips — superseded in-session by the owner's
PR #36 (`feat/readable-place-names`); the chip's 44pt hit target follows up
after #36 merges.

## Copy & accessibility (tier 4)

- **No infrastructure words at emotional moments**: the delete dialog loses
  「R2」 (「サーバーに保存された写真・動画も完全に削除され、元に戻せません。」).
- **残像 vocabulary**: ja/zh/ko stop embedding the English word "afterimage"
  (「この残像を削除しますか？」「最初の残像を残そう」, `api.asset_not_found`,
  `upload.stage.uploading`). The brand name itself stays.
- **Nightly reminder rewritten**: no SNS 「投稿」, invitation framing, video-only
  wording, matching all locales.
- **ことば unification**: transcript surfaces use the 「ことば」 voice
  (sheet title, daily-playback panel states); VoiceOver labels keep the
  descriptive 「文字起こし」. Dead catalog keys (memory.kind.*, orphaned
  literals) are deleted.
- **Upload stage narration keeps one voice** end-to-end (checking/retrying/
  waiting/completed rewritten in the same register as importing/compressing).
- **Retry label unified** to ja「もう一度」 / en "Try Again" via `action.retry`;
  the camera status view gains `cameraRetryButton` a11y identifier so UI tests
  stay unambiguous.
- **ko 기억 unification** (추억 mixture removed; `upload.stage.importing`
  mistranslation fixed) — including `InfoPlist.strings`.
- **VoiceOver**: photo pages become real elements (label + image trait +
  activate-to-toggle-chrome); chrome auto-hide is disabled under VoiceOver /
  Switch Control; both scrubbers gain labels and mm:ss values (time texts
  hidden); the daily-playback transcript panel un-combines so its location link
  and scroll work; the recording timer speaks 「録画時間 1分12秒」 with
  `.updatesFrequently`; weather badges announce the condition (「晴れ」 etc.)
  via a pure `WeatherConditionDescriber` (XCTest-covered).
- **Contrast/hit targets**: hero overlay gradient deepens to 0.78 (matching
  DailyPlaybackCard); the weather attribution link's hit area grows to ~44pt
  without layout shift.

Open question flagged for the owner: `timeline.title` ja「記録」 vs en "Journal"
tone mismatch — left unchanged pending a naming decision.

## Catalog

+23 keys (4 locales each), 16 value retunes, −10 dead keys → 250 keys total.

## Verification

Full `xcodebuild test` (unit + UI) and `npm run check` pass; seeded-simulator
screenshots of the timeline (weather badges, darker hero gradient) and the
daily-playback end card (serif title, weather, summary, replay).
