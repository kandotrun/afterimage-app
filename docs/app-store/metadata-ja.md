# 日本語App Store metadata

機械可読な正本は `release-metadata.json`。App Store Connectへ貼り付ける直前にJSONから転記し、入力画面で文字数、改行、最新設問を再確認する。公開URLの存在や審査完了をこの原稿だけで証明しない。

## 名前とサブタイトル

- App名: `afterimage`
- サブタイトル: `撮った日々が、あとから見つかる`
- 初回platform: iPhoneのみ
- Primary category推奨: 写真／ビデオ（`PHOTO_AND_VIDEO`）
- Secondary category推奨: ライフスタイル（`LIFESTYLE`）

動画の撮影、取り込み、HEVC最適化、再生が中核なので写真／ビデオを第一候補にする。日々を個人的に記録して振り返る用途からライフスタイルを第二候補とする。カテゴリはApp Store Connectの最新候補を確認してから確定する。

## Description

`release-metadata.json` の `description` をそのまま使用する。主張しているアカウント削除とAI同意は `ACCOUNT_DELETION` と `AI_CONSENT` がverifiedになるまでApp Store Connectへ登録しない。公開版の実装と一致しない文章を先行公開しない。

## Keywords

`ライフログ,動画日記,思い出,記録,文字起こし,プライベート,振り返り,検索`

カンマ込み100文字以内をverifierで固定する。競合名、商標、無関係な人気語は含めない。

## Age Rating回答案

iOS 26向け最新questionnaireを前提に、ユーザー自身の動画を扱うためUser-Generated ContentはYesとする。公開feed、他者とのchat、広告、無制限Web access、gambling、loot box、contest、医療助言はNo。暴力、成人向け、薬物、恐怖、性的表現等のcontent descriptorはアプリが提供するfixtureと機能について`NONE`とする。

ユーザーが私的に取り込む動画の内容は開発者が選ばないため、ASC上の説明とAppleの最新定義を提出担当者が再読する。Kids categoryは選択せず、rating overrideは`NOT_APPLICABLE`。計算結果はこのrepoで事前に断定せず、ASCの結果をrelease evidenceへ残す。

## URL

- Privacy Policy: `https://afterimage.2-38.com/privacy`
- Support URL: `https://afterimage.2-38.com/support`
- Terms of Use: `https://afterimage.2-38.com/terms`

URL文字列は提出先のsource of truthだが、HTTP 200は未検証。`LEGAL_PRIVACY`、`LEGAL_SUPPORT`、`LEGAL_TERMS` に日時付きread-backが入るまで提出不可とする。
