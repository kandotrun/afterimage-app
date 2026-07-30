# App Store提出 source of truth

このディレクトリは afterimage 初回公開版の App Store Connect 入力、審査説明、privacy回答、release手順、実測証跡を管理する。文章が重複した場合は `release-metadata.json` の構造化値を入力値のauthorityとし、各Markdownは判断根拠と作業手順として扱う。

現時点で公開URL、実機smoke、macOS screenshot、Release archive、App Store Connect処理は検証済みとみなさない。`release-evidence.json` の `pending` は提出ブロッカーであり、実測した担当者が日時、build、commit SHA、artifact URLまたは保存場所を `evidence` に追加して `verified` へ変更する。推測や予定を証跡として記録しない。

## ファイル

- `release-metadata.json`: 日本語description、keywords、category、age rating、App Privacy、法務URL
- `metadata-ja.md`: App Store Connectへ転記するときの表示稿と文字数確認
- `app-privacy.md`: コードと回答の対応、processor、提出前の再監査観点
- `review-notes-ja.md`: App Review Notesの日本語原稿
- `release-runbook.md`: backend migration、公開URL、archive、ASC preflightの順序
- `release-checklist.md`: App Store Connectと実機/device smokeの証跡欄
- `screenshots/manifest.json`: 6.9-inch日本語画像の寸法・scene・合成内容

## 検証モード

`npm run verify:app-store` はLinuxを含むpre-PR環境で構造契約を検証し、PNGが未生成でも失敗しない。`npm run verify:app-store:screenshots` はmacOSで生成済みPNGの寸法、portrait、alpha channel、manifest対応を検証する。`npm run verify:app-store:submission` は全release evidenceとPNGを要求し、未検証項目が一つでもあれば具体的なIDとともに失敗する。

このブランチを作っただけでは、公開・deploy・TestFlight upload・ASC submissionは実行されない。

Apple一次資料:

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [App privacy](https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy)
- [Set an app age rating](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating)
- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
