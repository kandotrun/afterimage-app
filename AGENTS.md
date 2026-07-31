# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-31T14:13:11+0900
**Commit:** 10c8fcf
**Branch:** kandotrun/update-agents-hierarchy

## OVERVIEW

Afterimage は iOS-first の private lifelog。iOS は動画を端末上で HEVC 化し、Hono Worker は owner-scoped D1/R2 を管理する。独立した Python Mage-VL worker は短命 grant で private video を処理し、解析結果だけを API へ戻す。

## STRUCTURE

```text
backend/                     Hono Worker、D1 metadata、private R2
  src/app.ts                 API・auth・upload・cleanup の中央ハブ
  src/{gpu-jobs,mcp}.ts      agent video lease、MCP surface
  migrations/               順序付き D1 schema
  tests/                    Worker/D1/R2 behavior tests
ios/
  Sources/                  SwiftUI app、media pipeline、playback
  AfterimageUploadWidget/   upload Live Activity extension
  Tests/                    policy・contract unit tests
  UITests/                  iOS UI smoke tests
mage-worker/                 outbound-only Python Mage-VL lease worker
  src/afterimage_mage_worker/
  tests/                    client・contract・runtime・worker tests
scripts/                    executable contracts、archive/deploy tooling
.github/workflows/          backend、iOS、TestFlight、screenshots
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Worker entry / cron | `backend/src/index.ts` | `fetch` と scheduled dispatch |
| API / auth / media lifecycle | `backend/src/app.ts` | 主要 routes と D1/R2 orchestration |
| Provider integrations | `backend/src/{apple,soniox,qwen-summary}.ts` | identity、transcription、summary |
| Agent video / MCP | `backend/src/{gpu-jobs,mcp}.ts` | lease fencing、derivatives、owner-scoped tools |
| Privacy / deletion | `backend/src/{privacy,account-deletion}.ts` | consent、revocation、durable cleanup |
| Daily weather | `backend/src/weather.ts`, `ios/Sources/{Weather,Features/Timeline,Models}/` | owner-scoped D1 snapshot、WeatherKit recorder、timeline badge |
| Schema | `backend/migrations/` | append-only numbered SQL |
| Backend behavior | `backend/tests/` | auth、race、cleanup、ownership、provider lifecycle |
| iOS app state | `ios/Sources/App/AppModel.swift` | bootstrap、timeline、import、upload |
| API contract | `ios/Sources/Networking/APIClient.swift`, `ios/Sources/Models/` | URL policy と wire models |
| Media pipeline | `ios/Sources/{Import,Compression,Upload}/` | file import → optimize → background upload |
| UI / playback | `ios/Sources/Features/`, `ios/Sources/Playback/` | pure policy と `@MainActor` controller |
| Build targets | `ios/project.yml` | XcodeGen の source of truth |
| Mage worker | `mage-worker/src/afterimage_mage_worker/` | HTTPS polling、FFmpeg、Mage runtime |
| Executable contracts | `scripts/` | iOS、App Store、archive、backend rollout |
| Release automation | `.github/workflows/` | self-hosted CI、production deploy、TestFlight |

## CODE MAP

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `createApp` | function | `backend/src/app.ts` | 8 callers | Hono composition root |
| `cleanupExpiredState` | function | `backend/src/app.ts` | cron + tests | session/grant/lease/media cleanup |
| `pollVideoAnalyses` | function | `backend/src/gpu-jobs.ts` | 2 callers | GPU job queue lifecycle |
| `AfterimageApp` | `@main` struct | `ios/Sources/App/afterimageApp.swift` | entry | app composition root |
| `AppModel` | `@MainActor` class | `ios/Sources/App/AppModel.swift` | 24 callers | auth・timeline・media orchestration |
| `APIClient` | actor | `ios/Sources/Networking/APIClient.swift` | AppModel + upload | authenticated HTTP boundary |
| `BackgroundUploadManager` | class | `ios/Sources/Upload/BackgroundUploadManager.swift` | AppModel + AppDelegate | staged background upload |
| `DailyPlaybackPlan` | struct | `ios/Sources/Features/Memory/DailyPlaybackPlan.swift` | 6 callers | day-to-clip mapping policy |
| `run_one_job` | function | `mage-worker/src/afterimage_mage_worker/worker.py` | 6 callers | lease heartbeat・処理・cleanup |
| `MageRuntime` | class | `mage-worker/src/afterimage_mage_worker/runtime.py` | 4 callers | bounded FFmpeg/Mage inference |

## CONVENTIONS

- RED → GREEN → REFACTOR。production code より先に failing behavior test を置く。
- 新規コメントは追加しない。TypeScript で `any` を使わない。既存実装・import・命名・error handling に合わせる。
- `useEffect` は導入しない。将来 React surface を追加する場合も、使わないと極度に複雑な場合だけ許容する。
- 実装後は diff をセルフレビューし、重複・不要な abstraction・近接実装からの逸脱を除く。
- 変更対象の子 `AGENTS.md` を追加で読む。特に `backend/`、`ios/`、`mage-worker/`、`scripts/`、`ios/Sources/Features/` は独立ルールを持つ。
- `scripts/verify-*.{mjs,py}` は executable specification。source/wire/workflow contract 変更と同じ diff で更新する。
- `backend/src/app.ts`、`APIModels.swift`、`APIClient.swift`、`AppModel.swift` を跨ぐ変更は backend tests、iOS contract tests、root checks を同期する。
- `backend/src/gpu-jobs.ts` と Mage lease/result shape は Python contracts/client/tests を同じ diff で同期する。
- `docs/superpowers/specs/` と `plans/` は意図と TDD 順序を記録するが、現行 source/tests が実装の authority。

## ANTI-PATTERNS (THIS PROJECT)

- Apple keys、Cloudflare/R2 credentials、bearer/worker tokens、`.dev.vars`、temporary source video、生成済み deployment config を commit しない。
- private media、MCP、GPU job から owner/lease scope を外さない。signed URL、grant、session を通常の永続データとして扱わない。
- Worker で unbounded media を buffer しない。single upload と multipart part は request body を R2 へ stream する。
- R2 に original media を保存しない。変換失敗時に original upload へ fallback しない。
- iOS 26 に `#available` や legacy Material fallback を追加しない。
- Linux check を Xcode build/test の代替として報告しない。実行していない build/test を成功扱いしない。
- repo-managed Actions を GitHub-hosted runner に戻さない。label は `[self-hosted, macOS, ARM64, afterimage-ci]`。
- TestFlight で login keychain を unlock しない。Afterimage 専用 CI keychain を cleanup で再 lock し、job-local temporary ASC key は `if: always()` で削除する。

## UNIQUE STYLES

- npm workspace は backend のみ。iOS/XcodeGen と Python/Docker/systemd worker は別の build/runtime boundary。
- Backend は route folder 分割ではなく `app.ts` を hub にし、provider・GPU・deletion を leaf module として注入/登録する。
- iOS は `AppModel` が state を所有し、network/compression/upload は actor、UI 判定は testable policy に切り出す。
- Mage worker は HTTP server ではなく lease polling。job directory、heartbeat、短命 grant、result submission を一単位にする。
- Upload Live Activity は app と extension が `Sources/Shared/UploadActivityAttributes.swift` を共有する。

## COMMANDS

```bash
npm ci
npm run check
```

## NOTES

- `backend/src/app.ts`、`mcp.ts`、`gpu-jobs.ts`、`account-deletion.ts` は auth/privacy/lease の大規模 hotspot。
- `ios/Sources/Upload/BackgroundUploadManager.swift`、`Compression/MediaCompressor.swift`、`App/AppModel.swift` は cross-lifecycle hotspot。
- `ios/Resources/Localizable.xcstrings` は大規模 catalog。localized key と4言語の placeholder parity を contract script で確認する。
- root `npm run check` は Mage worker tests を含まない。Python 契約変更は Mage test suite を別に実行する。
- `backend/src/worker-configuration.d.ts` と生成した Xcode project は生成物。source of truth として手編集しない。
