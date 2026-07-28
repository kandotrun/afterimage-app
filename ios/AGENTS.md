# iOS Knowledge Base

## OVERVIEW

- Afterimage の iOS 26 / Swift 6 SwiftUI 本体と `AfterimageUploadWidget` 拡張。
- `project.yml` が XcodeGen の唯一のプロジェクト定義。
- `AppModel`（`@MainActor`）が認証・タイムライン・取り込み・再開を束ね、UI は状態を表示する。

## WHERE TO LOOK

- `project.yml`: targets、依存関係、scheme、resource/localization の組み込み。
- `Sources/App/AppModel.swift`: 起動、Keychain セッション、重複判定、取り込みからバックグラウンド移譲まで。
- `Sources/Networking/APIClient.swift`: API パス解決、Bearer 管理、認証済みデータ/再生 grant。
- `Sources/Security/KeychainSessionStore.swift`: bearer を保存する唯一の永続境界。
- `Sources/Import/MediaImporter.swift`: PhotosPicker の file-based `Transferable`、一時ファイル、日時/位置メタデータ。
- `Sources/Compression/MediaCompressor.swift`: AVAssetReader/Writer の HEVC 出力、プレビュー、サイズ計測。
- `Sources/Upload/BackgroundUploadManager.swift`: URLSession background、staged file、再開可能な secret-free JSON state。
- `Sources/Upload/MediaUploader.swift`: 単一 PUT と multipart chunk の計画/検証。
- `Sources/Features/{Auth,Timeline,Memory,Settings}`: 画面と AppModel/API の接続。
- `Sources/Playback`: AVAudioSession、再生時計、grant 失敗時の recovery policy。
- `Sources/Weather/DailyWeatherRecorder.swift`, `Sources/Models/DailyWeather.swift`, `Sources/Features/Timeline/DailyWeatherBadge.swift`: current location の WeatherKit snapshot、API model、timeline 表示。
- `Sources/Shared/UploadActivityAttributes.swift` と `AfterimageUploadWidget/`: Live Activity の共有契約と表示。
- `Tests/`・`UITests/`: API/圧縮/取り込み/再生/アップロード契約、実画面ナビゲーション。

## CONVENTIONS

- Swift 6 の actor 境界を保つ。`APIClient`、`MediaCompressor`、`MediaUploader` は actor、画面モデル/Controller は `@MainActor`、値型は必要に応じて `Sendable`。
- プロジェクト変更は `project.yml` に記述して `xcodegen generate`。新規 source/resource は target の sources 定義と scheme の test 対象を確認する。
- 取り込みは `PhotosPickerItem.loadTransferable` のファイル表現を使い、所有一時ファイルを処理後に削除する。元動画/画像をメモリ全量へ読まない。
- 動画は AVAssetReader/Writer で HEVC に変換し、音声は `outputSettings: nil` と source format hint の passthrough。変換失敗時に原本を送信しない。
- 最適化結果には content type、byte size、寸法、duration、capture metadata、thumbnail URL を揃えてから asset を作成する。
- 背景 upload は staged file と chunk 単位。永続 state に base URL、asset、進捗だけを置き、bearer は Keychain から都度取得して widget/Activity に渡さない。
- `UploadActivityAttributes` を変更したら app と widget の両 target、Localization、Live Activity の stage/progress 表示を同時に確認する。
- daily weather は日単位で記録し、WeatherKit attribution の legal/light/dark URL を model、API、badge 間で欠落させない。
- ユーザー向け文言・アクセシビリティ・エラーは `Localizable.xcstrings` と `L10n` のキーを通す。ja/en/zh-Hans/ko の resource と fallback を契約テストで確認する。
- 再生は API の短命 grant を `AVPlayer` に渡し、`PlaybackRecoveryPolicy`/`PlaybackAudioSession` の状態遷移を単体テストで固定する。

## ANTI-PATTERNS

- `afterimage.xcodeproj` や scheme を手編集して `project.yml` と乖離させる。
- bearer、grant、署名 URL、API token を `BackgroundUploadState`、UserDefaults、Activity attributes、ログへ書く。
- `Data(contentsOf:)` 等で大容量メディア全体を抱える、音声を再エンコードする、HEVC 失敗時に原本へフォールバックする。
- actor の状態を直接共有する、`@MainActor` UI を非 Sendable callback から更新する、重複 upload を task 調査なしで起動する。
- SwiftUI の表示文言や widget stage をハードコードし、string catalog/contract test を迂回する。
- scheme や simulator 名を推測して結果を読む。`project.yml` と CI の実 destination を合わせる。

## COMMANDS

- `cd ios && xcodegen generate`
- `xcrun simctl list devices available` で iOS 26 の iPhone UDID を選ぶ。
- `cd ios && xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,id=<UDID>'`
- CI 同等の実測は iOS 26 simulator の UDID を選び、`-derivedDataPath DerivedData -resultBundlePath TestResults.xcresult CODE_SIGNING_ALLOWED=NO` とログ/xcresult を保存する。
