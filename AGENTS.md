# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-28T19:38:32+0900
**Base commit:** d03dacc
**Branch:** kandotrun/init-deep-agents

## OVERVIEW

Afterimage は iOS-first の private lifelog。新規取り込みは動画のみで、端末上で HEVC 化した最適化メディアだけを private R2 に保存する。既存画像は認証済み timeline/playback で継続対応し、transcription/search はこの privacy boundary の上に構築する。

## STRUCTURE

```text
backend/                     Hono Worker、D1 metadata、private R2
  src/app.ts                 API・auth・upload・cleanup の中央ハブ
  src/weather.ts             owner-scoped daily weather API
  migrations/               順序付き D1 schema
  tests/                    Worker/D1/R2 behavior tests
ios/
  Sources/                  SwiftUI app、media pipeline、playback
  AfterimageUploadWidget/   upload Live Activity extension
  Tests/                    policy・contract unit tests
  UITests/                  iOS UI smoke tests
scripts/                    iOS source/localization contract gates
.github/workflows/          backend、iOS、TestFlight
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Worker entry / cron | `backend/src/index.ts` | `fetch` と scheduled dispatch |
| API / auth / media lifecycle | `backend/src/app.ts` | 主要 routes と D1/R2 orchestration |
| Provider integrations | `backend/src/{apple,soniox,qwen-summary,mcp}.ts` | identity、transcription、summary、MCP |
| Daily weather | `backend/src/weather.ts`, `ios/Sources/{Weather,Features/Timeline,Models}/` | owner-scoped D1 snapshot、WeatherKit recorder、timeline badge |
| Schema | `backend/migrations/` | append-only numbered SQL |
| Backend behavior | `backend/tests/app.test.ts` | auth、race、cleanup、ownership |
| iOS app state | `ios/Sources/App/AppModel.swift` | bootstrap、timeline、import、upload |
| API contract | `ios/Sources/Networking/APIClient.swift`, `ios/Sources/Models/` | URL policy と wire models |
| Media pipeline | `ios/Sources/{Import,Compression,Upload}/` | file import → optimize → background upload |
| Timeline / playback | `ios/Sources/Features/`, `ios/Sources/Playback/` | pure policy と controller を分離 |
| Build targets | `ios/project.yml` | XcodeGen の source of truth |
| Executable contracts | `scripts/verify-ios-*.mjs` | `npm run check:ios` から実行 |
| Release automation | `.github/workflows/ios-deploy.yml` | isolated keychain と一時 ASC key |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createApp` | function | `backend/src/app.ts` | Hono composition root |
| `registerDailyWeatherRoutes` | function | `backend/src/weather.ts` | owner-scoped weather API |
| `pollTranscriptions` | function | `backend/src/app.ts` | Soniox lifecycle |
| `cleanupExpiredState` | function | `backend/src/app.ts` | session/grant/upload cleanup |
| `AfterimageApp` | `@main` struct | `ios/Sources/App/afterimageApp.swift` | app composition root |
| `AppModel` | `@MainActor` class | `ios/Sources/App/AppModel.swift` | app state orchestrator |
| `APIClient` | actor | `ios/Sources/Networking/APIClient.swift` | authenticated HTTP boundary |
| `Asset` | struct | `ios/Sources/Models/APIModels.swift` | timeline/media wire model |
| `MediaCompressor` | actor | `ios/Sources/Compression/MediaCompressor.swift` | HEVC/HEIC optimization |
| `WeatherKitDailyWeatherRecorder` | struct | `ios/Sources/Weather/DailyWeatherRecorder.swift` | current-location daily snapshot |
| `DailyPlaybackPlan` | struct | `ios/Sources/Features/Memory/DailyPlaybackPlan.swift` | day-to-clip mapping policy |

## CONVENTIONS

- RED → GREEN → REFACTOR。production code より先に failing behavior test を置く。
- 新規コメントは追加しない。TypeScript で `any` を使わない。既存実装・import・命名・error handling に合わせる。
- `useEffect` は導入しない。将来 React surface を追加する場合も、使わないと極度に複雑な場合だけ許容する。
- 実装後は diff をセルフレビューし、重複・不要な abstraction・近接実装からの逸脱を除く。
- `backend/` 変更時は `backend/AGENTS.md`、`ios/` 変更時は `ios/AGENTS.md` を追加で読む。
- `scripts/verify-ios-contract.mjs` と `verify-ios-localizations.mjs` は executable specification。iOS contract 変更と同じ diff で更新する。
- `backend/src/app.ts`、`APIModels.swift`、`APIClient.swift`、`AppModel.swift` を跨ぐ変更は backend tests、iOS contract tests、root checks を同期する。
- `docs/superpowers/specs/` と `plans/` は意図と TDD 順序を記録するが、現行 source/tests が実装の authority。

## ANTI-PATTERNS

- Apple keys、Cloudflare resource IDs、R2 credentials、bearer tokens、`.dev.vars`、生成済み deployment config を commit しない。
- private media route から owner scope を外さない。signed URL と bearer session を通常データとして扱わない。
- Worker で unbounded media を buffer しない。single upload と multipart part は request body を R2 へ stream する。
- R2 に original media を保存しない。変換失敗時に original upload へ fallback しない。
- iOS 26 に `#available` や legacy Material fallback を追加しない。
- Linux check を Xcode build/test の代替として報告しない。実行していない build/test を成功扱いしない。
- repo-managed Actions を GitHub-hosted runner に戻さない。label は `[self-hosted, macOS, ARM64, afterimage-ci]`。
- TestFlight で login keychain を unlock しない。Afterimage 専用 CI keychain を cleanup で再 lock し、job-local temporary ASC key は `if: always()` で削除する。

## UNIQUE STYLES

- Backend は route folder 分割ではなく `app.ts` を hub にし、provider を leaf module として dependency injection する。
- iOS は `AppModel` が state を所有し、network/compression/upload は actor、UI 判定は testable policy に切り出す。
- Upload Live Activity は app と extension が `Sources/Shared/UploadActivityAttributes.swift` を共有する。
- Root checks は backend test/typecheck/deploy dry-run と iOS source/localization contracts を一括実行する。

## COMMANDS

```bash
npm ci
npm run check
npm --workspace backend run test
npm --workspace backend run typecheck
```

## NOTES

- `backend/src/app.ts` と `backend/tests/app.test.ts` は大規模 hotspot。周辺の既存 helper/test pattern を先に確認する。
- `ios/Sources/Upload/BackgroundUploadManager.swift`、`Compression/MediaCompressor.swift`、`App/AppModel.swift` は cross-lifecycle hotspot。
- `ios/Resources/Localizable.xcstrings` は大規模 catalog。localized key と4言語の placeholder parity を contract script で確認する。
