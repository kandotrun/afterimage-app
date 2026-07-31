# Features Knowledge Base

## OVERVIEW

- SwiftUI の画面は表示・入力・遷移に薄く保ち、認証、撮影、再生、検索、設定の副作用を境界へ出す。
- 値型の policy は状態遷移・選択・整形だけを決定し、I/O を持たない。副作用を持つ model/controller は `@MainActor`。
- `AppModel` が画面間の account、timeline、import、upload を所有し、Feature は environment 経由で接続する。

## STRUCTURE

- `Auth/`: `LoginView` と challenge-bound Apple Sign In。認証結果は `AppModel` の session 世代管理へ渡す。
- `Camera/`: `CameraCaptureView`、`CameraCaptureModel`、AVFoundation client/session、temporary file store。許可、録画、無音確認、review、transfer を管理する。
- `Timeline/`: 日別一覧、day story、weather badge、upload preview。day/story policy と preview playback controller を分離する。
- `Memory/`: 写真・動画 detail、daily pager、transcript/analysis sheet、zoom、Mage polling。grant 付き playback のライフサイクルを保持する。
- `Search/`: query の debounce、cursor pagination、検索結果から standalone memory detail への遷移を扱う。
- `Settings/`: AI consent、legal links、MCP connection、account deletion。削除は backend 受理後に local cleanup を完了させる。
- `AppStore/`: DEBUG 限定の synthetic screenshot fixture。実データ・認証・ネットワークへ依存しない決定的な表示面。

## WHERE TO LOOK

- 純粋な判定は `CameraCapturePolicy`、`CameraIngestPolicy`、`DayStoryPolicy`、`DailyPlaybackPlan`、`MemoryPagerPolicy`、`MageMemoryPolicy`、`AccountDeletionPolicy`。
- 再生制御は `DayPreviewPlaybackController`、`DailyVideoPlaybackController`、`VideoPlaybackController`。grant の取得は注入 closure、`AVPlayer` は controller が所有する。
- 撮影依存は `CameraCaptureClient`。live 実装は `CameraCaptureLiveClient`、テストは permission/session/recording/file store を差し替える。
- 画面文言、VoiceOver label、dynamic type 対応、ready identifier は各 View と `Localizable.xcstrings`、`L10n` を確認する。
- policy の挙動は `ios/Tests/*PolicyTests.swift`、非同期世代・取消しは camera/playback controller tests、導線は `ios/UITests/` を参照する。

## CONVENTIONS

- View は `@EnvironmentObject` の model を呼び、長い処理は `Task` と `@MainActor` model/controller に委譲する。view 内に API/R2/AVFoundation orchestration を置かない。
- async 操作は generation/token を進め、`Task.isCancelled` と世代一致を suspension point 後に確認する。deactivate、disappear、retake、discard で task を取消す。
- playback grant は必要時に取得して memory に限定し、期限切れ時は recovery policy に従い再取得する。grant、署名 URL、bearer、MCP secret を永続 state、Activity、ログへ書かない。
- capture は session ownership と temporary file ownership を明示し、成功 transfer 後だけ所有権を移す。失敗・retake・discard・deinit で一時ファイルを掃除する。
- 追加の表示文言は string catalog のキーと `L10n` を使い、accessibility label、traits、dynamic type、automation identifier を同時に設計する。
- 新しい policy は先に unit test、画面変更は対応する UI smoke/screenshot test を追加し、実 simulator の結果を記録する。

## ANTI-PATTERNS

- SwiftUI View から直接 token/grant を保存、印字、共有する。短命 credential は API boundary から受け取り、表示状態へ漏らさない。
- 古い検索・grant・capture callback が最新画面を書き換える、または cancellation を無視して session/player を再開する。
- camera capture を fake E2E だけで検証する、原本 media を fallback 送信する、temporary file の所有境界を曖昧にする。
- Timeline/Memory の日付・hero・pager 選択を View に重複実装し、純粋 policy と controller state を迂回する。
- localization/accessibility をハードコードし、AppStore fixture に private data や live API を混ぜる。
