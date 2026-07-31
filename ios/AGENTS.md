# iOS Knowledge Base

## SCOPE

- Swift 6 / iOS 26 SwiftUI app と `AfterimageUploadWidget` extension。
- `project.yml` が target、scheme、resource、localization の source of truth。xcodeproj は生成物。
- `ios/Sources/Features/AGENTS.md` が画面・feature policy の詳細ルール。ここでは重複記述しない。

## ROUTING

- `Sources/App/AppModel.swift`: bootstrap、auth generation、timeline/weather、import、upload、AI consent、account deletion の状態集約。
- `Sources/Networking/APIClient.swift` / `Sources/Models/APIModels.swift`: HTTPS origin、相対/絶対 API path、session-bound request、wire model。
- `Sources/Security/KeychainSessionStore.swift`: bearer session の永続境界。`AuthGenerationGate` と logout race を併読。
- `Sources/Import/MediaImporter.swift` → `Sources/Compression/MediaCompressor.swift`: file-based PhotosPicker、metadata、HEVC 出力、thumbnail。
- `Sources/Upload/BackgroundUploadManager.swift` / `MediaUploader.swift`: staged file、single PUT/multipart、retry、handoff、background callback。
- `Sources/Playback/`: grant recovery、clock/audio、player chrome の共通 policy。feature controller は子 guide を参照。
- `Sources/Privacy/`: AI consent version と transfer policy。Settings の deletion UI は子 guide を参照。
- `Sources/Shared/UploadActivityAttributes.swift` + `AfterimageUploadWidget/`: app/widget 共通の stage/progress/filename 契約。
- `Sources/Localization/L10n.swift` + `Resources/Localizable.xcstrings`: dynamic/error/accessibility text と ja/en/zh-Hans/ko catalog。
- `Tests/` は policy・wire・lifecycle unit tests、`UITests/` は camera/accessibility/consent/navigation/screenshots。

## BOUNDARIES

- `APIClient`、`MediaCompressor`、`MediaUploader` は actor。`AppModel`、camera model、playback controller は `@MainActor`。境界値は `Sendable`。
- `BackgroundUploadState` は URL、asset、progress、generation のみ。bearer は Keychain から request ごとに取得し、Activity/UserDefaults/log に渡さない。
- import/camera/optimized temporary files は所有者が明確な URL。handoff、cancel、account deletion 後に cleanup し、HEVC 失敗時は原本を upload しない。
- camera は permission → configure → ready → recording/finalizing/reviewing の phase を守る。`.inactive` は capture 継続、`.background` は policy に従い停止する。
- playback は API grant を `AVPlayer` に解決し、expiry/error を recovery policy で扱う。remote URL や非 video descriptor を preview 境界へ入れない。
- 外部 AI 転送と agent access は `AIConsentPolicy` の current version、grant、withdrawal、timestamp を全て満たす場合だけ許可する。
- `UploadActivityAttributes` の変更は app/widget 両 target、4言語 catalog、stage/progress contract scripts を同じ変更で更新する。
- SwiftUI の static text 以外は `L10n` 経由。placeholder、fallback、accessibility string を catalog contract で確認する。

## VALIDATION

- `cd ios && xcodegen generate` 後、`project.yml` と生成差分を確認。
- `xcrun simctl list devices available` で実在する iOS 26 simulator ID を選ぶ。
- `cd ios && xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath DerivedData -resultBundlePath TestResults.xcresult CODE_SIGNING_ALLOWED=NO`。
- source/contract 変更時は `node scripts/verify-ios-contract.mjs`、`node scripts/verify-ios-haptics.mjs`、`node scripts/verify-ios-localizations.mjs` を実行。
- archive/release の確認は `scripts/verify-ios-archive.py` と workflow の実 destination/log を使用する。

## ANTI-PATTERNS

- generated `afterimage.xcodeproj`、scheme、Info.plist を source として編集しない。
- Swift concurrency の警告を `@unchecked Sendable`、detached task、MainActor hop の追加だけで隠さない。
- camera recording URL、background transfer identifier、session generation を別 owner の cleanup で消さない。
- localization、widget stage、privacy manifest、entitlement の変更を単一 target の動作確認だけで完了扱いにしない。
