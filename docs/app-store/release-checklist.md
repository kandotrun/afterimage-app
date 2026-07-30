# App Store Connect / release / device smoke checklist

チェックは実行者が実測したときだけ`[x]`にする。各sectionの証跡欄には日付、担当、commit SHA、version/build、端末/OSまたはartifact URL、結果、既知制約を書く。予定、推測、Linux上のsource contractを実機/Xcode成功の代わりにしない。

## Release identity

- [ ] 対象commitがレビュー済みでworktree clean
- [ ] version/buildがarchive、ASC、証跡で一致
- [ ] iPhone-only app/extensionをarchive settingsでread-back
- [ ] secret scanで検出なし
- [ ] P0/P1未解決なし

証跡: `日時= / 担当= / commit= / version(build)= / URL= / 結果= / 既知制約=`

## App Store Connect metadata

- [ ] App名、サブタイトル、descriptionを`release-metadata.json`と一致
- [ ] keywordsがカンマ込み100文字以内
- [ ] Primary 写真／ビデオ、Secondary ライフスタイルを最終確認
- [ ] iOS 26 age rating questionnaireを回答し、計算結果を記録
- [ ] App Privacy data type、linked、purpose、trackingをmanifestと一致
- [ ] Privacy / Support / Terms URLを未認証HTTP 200でread-back
- [ ] copyright、価格、提供地域、release optionを確認
- [ ] export compliance回答をarchive設定と一致
- [ ] 日本語6.9-inch screenshotを3枚以上登録
- [ ] Review Notesのplaceholderを実証跡へ置換

証跡: `日時= / 担当= / ASC app/version= / metadata revision= / 結果= / 既知制約=`

## Backend / privacy boundary

- [ ] staging migration一覧、適用、read-back
- [ ] production migration一覧、適用、read-back
- [ ] auth challenge nonce不一致、期限切れ、replay拒否
- [ ] AI未同意でSoniox/Qwen/MCPへの新規送信なし
- [ ] 同意後の処理と撤回後の停止
- [ ] 新規・既存assetのagent access default OFF
- [ ] account deletionのD1/R2/Soniox/Apple revokeと再試行
- [ ] private mediaがowner scopeと短命grantを維持

証跡: `日時= / 担当= / environment= / migration= / test run= / 結果= / 既知制約=`

## Fresh installと主要フロー

- [ ] fresh install → Sign in with Apple
- [ ] アプリ内撮影 → HEVC圧縮 → background upload
- [ ] timeline → 再生 → 個別削除
- [ ] PhotosPickerから動画取り込み
- [ ] AI説明 → 未同意動作 → 同意 → 撤回
- [ ] account deletion → login画面 → remote read-back

証跡: `日時= / 担当= / iPhone= / iOS= / version(build)= / network= / 結果= / 既知制約=`

## Lifecycle / failure

- [ ] upload中の通信断と復帰
- [ ] background → kill → relaunch → resume
- [ ] 空き容量不足
- [ ] camera拒否
- [ ] microphone拒否
- [ ] PhotosPickerのcancel/限定選択
- [ ] location拒否
- [ ] notification拒否とnotification tap
- [ ] 録画割り込み
- [ ] サイレントモードと音声再生
- [ ] API失敗時のユーザー向けerrorとretry

証跡: `日時= / 担当= / iPhone= / iOS= / version(build)= / scenario log= / 結果= / 既知制約=`

## Media compatibility

- [ ] AAC入力の音声保持
- [ ] ALAC入力の音声保持または明示した非対応動作
- [ ] portrait / landscape / rotation metadata
- [ ] 長い動画とmultipart upload
- [ ] HEVC変換失敗時にoriginal uploadへfallbackしない
- [ ] optimized mediaだけがprivate R2に存在

音声証跡は入力codec、出力track format、packet/sample比較方法を記録し、「聴こえた」だけでbyte-for-byte passthroughを断定しない。

証跡: `日時= / 担当= / fixture hash= / codec= / tool output= / 結果= / 既知制約=`

## Archive / processing

- [ ] self-hosted macOS unit/UI test xcresult
- [ ] screenshot artifactとverification report
- [ ] Release archive成功
- [ ] PrivacyInfo.xcprivacyがapp bundleに一つ同梱
- [ ] UserDefaults CA92.1 / FileTimestamp C617.1
- [ ] Required Reason API警告なし
- [ ] export/validation成功
- [ ] TestFlight処理結果を確認
- [ ] ASC keyとtemporary keychain cleanup確認

証跡: `日時= / 担当= / runner= / Xcode= / artifact= / ASC processing= / 結果= / 既知制約=`

## Submission gate

- [ ] `release-evidence.json`の全required entryがverified
- [ ] `npm run verify:app-store:submission`が対象artifactでPASS
- [ ] Review Notes、公開法務本文、binaryの挙動が一致
- [ ] Submit for Reviewの最終承認者が記録済み

最終承認: `日時= / 担当= / commit= / version(build)= / evidence revision= / 判断=`
