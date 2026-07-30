# App Privacy回答とPrivacy Manifest

`release-metadata.json` の `appPrivacy` と `ios/Resources/PrivacyInfo.xcprivacy` を同じdata type集合に保つ。全項目はユーザーにlinked、trackingなし、App Functionality目的とする。広告、第三者広告、developer advertising、data broker、他社横断trackingには利用しない。

## 収集するデータ

| App Store項目 | 利用 | コード上の根拠 |
|---|---|---|
| Precise Location | 動画の撮影座標を所有者のasset metadataとして保存し、場所名とMaps導線に利用 | `0007_asset_capture_location.sql`、`MediaImporter.swift` |
| Audio Data | 動画の音声を保存し、同意後の文字起こしへ送信 | `MediaCompressor.swift`、`soniox.ts` |
| Photos or Videos | 端末で最適化した動画とthumbnailを非公開保存 | `MediaCompressor.swift`、`app.ts` |
| User ID | Sign in with Apple subjectをowner boundaryとして利用 | `apple.ts`、`0001_initial.sql` |
| Name | Appleが初回に提供した場合の表示名 | `AppModel.swift`、`app.ts` |
| Email Address | Appleの実メールまたはprivate relay address | `apple.ts`、`0001_initial.sql` |
| Other User Content | transcript、visual analysis、daily summary | `0004_transcriptions.sql`、`0008_daily_summaries.sql`、`0010_agent_video_access.sql` |

WeatherKitで取得する現在地はその日の天気snapshot作成に使う。サーバーのdaily weather rowには現在座標を保存しない。一方、取り込んだ動画の埋め込み撮影座標はasset metadataとして送信・保存するため、Precise Locationを収集ありとして回答する。

## Processor

- Cloudflare: Worker、D1、private R2で認証、metadata、最適化mediaを処理・保存
- Soniox: 明示同意後の動画音声から文字起こし
- Alibaba Cloud Qwen: 明示同意後のframe、transcript、analysisから映像解析と日次要約
- MCP client or agent: ユーザーが個別に許可した動画等を読み取り

processor名、送信データ、目的、保持と削除、同意撤回後の扱いは公開Privacy Policy本文にも一致させる。`AI_CONSENT` がverifiedになるまで、ここに書いた同意境界が実装済みとは扱わない。

## Required Reason API

`UserDefaults` は日次通知のユーザー設定を端末内で読み書きするため`NSPrivacyAccessedAPICategoryUserDefaults` / `CA92.1`。File Timestampはユーザーが選んだmediaのcapture dateを扱うため`NSPrivacyAccessedAPICategoryFileTimestamp` / `C617.1`。archive内manifestのread-backとApple処理警告なしは`REQUIRED_REASON_API`へ記録する。

## 提出直前の再監査

- [ ] data type集合がmanifest、JSON、ASCで一致
- [ ] processorと目的が公開Privacy Policyで一致
- [ ] tracking=false、tracking domains空
- [ ] AI未同意・撤回後の新規送信停止をtest evidenceで確認
- [ ] account deletion後のD1、R2、Soniox、Apple revokeをread-back
- [ ] Required Reason APIのarchive検査とupload warning確認
