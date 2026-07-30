# Mage Memory Search & Insight Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Mage-VLの解析結果をAfterimage iOSから検索・閲覧でき、視覚イベントを日次要約にも反映する。

**Architecture:** Owner bearer認証のREST APIとして検索と動画解析詳細を追加し、MCPの外部AI共有境界とは分離する。検索はD1上のfilename・Soniox transcript・Mage summary/segment captionをowner scopeで照合する。iOSは記録画面の明示的な検索導線、独立した検索結果画面、解析シート、segment timestampへのseekを追加する。

**Tech Stack:** Cloudflare Workers/Hono/D1/TypeScript/Vitest、Swift 6/SwiftUI/iOS 26/XCTest、XcodeGen。

---

## API contract

### `GET /v1/memories/search`

Query:
- `q`: trim後1〜200文字、必須
- `cursor`: 任意
- `limit`: 1〜50、既定20

Response:
```json
{
  "items": [
    {
      "asset": {},
      "match": {
        "kind": "filename|transcript|visual",
        "text": "matched excerpt",
        "startMs": 500,
        "endMs": 1500
      },
      "visualSummary": "Mage summary or null"
    }
  ],
  "nextCursor": null
}
```

Rules:
- `auth.userId`、`kind='video'`、`status='ready'`を必ずbindする。
- ownerアプリ検索はMCPと異なり`agent_access_enabled`でtranscriptを隠さない。activeなグローバルAI同意がMage解析・検索をゲートし、`agent_access_enabled`は動画ごとのMCP共有だけを制御する。共有OFFでもownerのMage解析は取消・非表示にしない。
- `%`、`_`、`\\`をliteralとしてescapeする。
- 他ownerの文字起こし・解析・filenameを応答/ログへ出さない。
- `Cache-Control: private, no-store`、`Pragma: no-cache`、`Vary: Authorization`。

### `GET /v1/assets/:assetId/analysis`

Response:
```json
{
  "assetId": "...",
  "status": "queued|processing|completed|failed|unavailable",
  "summary": null,
  "modelId": null,
  "modelRevision": null,
  "backend": null,
  "coverageMode": null,
  "coverage": [],
  "segments": [],
  "updatedAt": null
}
```

Rules:
- ownerのready videoのみ。不存在・他owner・photoは404で同じ応答。
- timestamp順をDBの`position`で固定する。
- worker token、job request/error、R2 key、media grantは返さない。

## Task 1: Backend search and analysis detail

**Files:**
- Modify: `backend/tests/app.test.ts`
- Modify: `backend/src/app.ts`

**TDD:**
1. owner/other/共有OFF/LIKE escape/invalid queryを含むsearch routeテストを追加する。
2. owner completed/queued/unavailableと他owner 404を含むanalysis routeテストを追加する。
3. `npm --workspace backend test -- --run tests/app.test.ts`でroute不存在によるREDを確認する。
4. Zod query、owner-scoped SQL、match excerpt、private headersを最小実装する。
5. 同じテストをGREENにし、backend全テストとtypecheckを通す。

## Task 2: Mage-aware daily summary

**Files:**
- Create: `backend/migrations/0011_daily_summary_memory_sources.sql`
- Modify: `backend/src/qwen-summary.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/tests/qwen-summary.test.ts`
- Modify: `backend/tests/app.test.ts`

**Contract:**
- Qwen sourceは`capturedAt`、nullable transcript、nullable visual summary、timestamp付きvisual segments。
- visual-only dayでも要約を生成する。
- `sourceTranscriptCount`を維持し、`sourceVisualAnalysisCount`を追加する。
- digestはtranscriptとMage summary/segments/update時刻を含む。
- migrationは既存cacheを保持しつつcountの`>=0`と総source数`>0`を保証する。
- transcript/visualの文字数と件数をboundedにする。

**TDD:**
1. visual-only、visual変更時cache invalidation、他owner非混入のREDテストを追加する。
2. Qwen payloadが映像情報を含み、prompt内命令を未信頼データとして扱うREDテストを追加する。
3. targeted testsでRED確認後、migration→types→queries→generatorの順で最小実装する。
4. targeted/full testsとtypecheckをGREENにする。

## Task 3: iOS wire contracts and search

**Files:**
- Modify: `ios/Tests/APIContractTests.swift`
- Modify: `scripts/verify-ios-contract.mjs`
- Modify: `ios/Sources/Models/APIModels.swift`
- Modify: `ios/Sources/Networking/APIClient.swift`
- Modify: `ios/Sources/App/AppModel.swift`
- Create: `ios/Sources/Features/Search/MemorySearchView.swift`
- Modify: `ios/Sources/Features/Timeline/TimelineView.swift`

**TDD:**
1. search page/match/analysis response decodeとdaily visual countのXCTestを先に追加する。
2. source contractへ検索API、検索toolbar、解析sheet/seekの必須anchorを追加し、`npm run check:ios`でREDを確認する。
3. Codable/Sendable model、APIClient、AppModel passthrough、300ms debounceとcursor paginationを実装する。
4. 記録toolbarに常時見えるmagnifying-glass導線を置く。
5. 検索前・0件・loading・error・resultを明確に表示し、未ロードの古いassetはstandalone detailで開く。

## Task 4: iOS analysis sheet and timestamp seek

**Files:**
- Create: `ios/Sources/Features/Memory/VideoAnalysisSheet.swift`
- Modify: `ios/Sources/Features/Memory/MemoryDetailView.swift`
- Modify: `ios/Sources/Features/Memory/VideoMemoryView.swift`
- Modify: `ios/Sources/App/AppModel.swift`

**Behavior:**
- completedはsummaryとtimestamp付きsegmentsを表示する。
- queued/processing/failed/unavailableをそれぞれ明示する。
- queued/processing中はsheet表示中だけ低頻度pollする。
- segment tapでsheetを閉じ、同じassetのAVPlayerを`startMs`へseekする。
- 通常timeline pagerは維持し、search結果はstandalone detailとして安全に開く。

**TDD:**
1. source contractのREDを確認する。
2. request valueをbindingでVideoMemoryViewへ渡し、既存`scrubBegan/to/Ended`だけでseekする。
3. iOS unit/UI CIでbuild/testする。

## Task 5: Localization and verification

**Files:**
- Modify: `ios/Resources/Localizable.xcstrings`
- Modify: `scripts/verify-ios-localizations.mjs`

**Steps:**
1. `memory.search.*`、`memory.analysis.*`のja/en/zh-Hans/koを追加する。
2. semantic key detectorへ`search|analysis`を追加する。
3. `npm run check:ios`、`npm run check`、backend test/typecheck/deploy dry-runを実行する。
4. GitHub self-hosted macOS/ARM64 runnerでiOS build/testを実測する。
5. diff security scan、独立spec review、独立quality reviewを通してからcommit/push/PRを作成する。

## Acceptance criteria

- 記録画面から1タップで検索を開ける。
- transcript、Mage summary、Mage segment captionの各matchを検索できる。
- 他ユーザーのデータは全API pathで返らない。
- Mage summaryとsegment timestampを動画詳細で閲覧できる。
- segmentを押すと該当時刻へseekする。
- 解析中/失敗/共有OFFが無表示にならず説明される。
- visual-only videoが日次要約へ反映される。
- 既存MCPの`agent_access_enabled`境界とagent grant境界を維持し、Mage workerはactiveなグローバルAI同意でゲートする。
- backend全テスト、typecheck、root check、macOS self-hosted iOS testが成功する。
