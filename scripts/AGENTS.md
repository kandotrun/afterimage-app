# SCRIPTS GUIDE

## OVERVIEW

- `scripts/` は補助 shell ではなく、CI・App Store・archive・production rollout を拘束する executable specification。
- verifier の PASS/FAIL、JSON evidence、fixture と workflow の形がリリース契約。実装変更だけで完了扱いにしない。
- 変更は RED → GREEN → REFACTOR。まず再現 fixture/test、次に verifier、最後に source/workflow を同時更新する。

## WHERE TO LOOK

- `verify-app-store.mjs`: project/privacy、screenshot manifest/PNG、workflow trust、release evidence、submission gate。
- `verify-ios-archive.py`: `.xcarchive` の app/appex、Mach-O、codesign (macOS)、device family、commit/build、PrivacyInfo、atomic report。
- `verify-ios-contract.mjs`, `verify-ios-haptics.mjs`, `verify-ios-localizations.mjs`, `verify-ios-pr37-port-contract.mjs`, `verify-ios-pr39-port-contract.mjs`: iOS source の executable contracts。
- `tests/verify-app-store.test.mjs`, `tests/test_verify_ios_archive.py`, `fixtures/app-store/`: failure shape、workflow parser、archive fixture の authority。
- `generate-app-store-screenshots.sh`: iOS 26 simulator、固定 status bar、Xcode result bundle、PNG verifier の入口。
- `deploy-backend-production.sh`: Wrangler dry-run/bindings/secrets、maintenance Worker、D1 migration、production deploy、health/legal checks。
- `.github/workflows/ios.yml`, `ios-deploy.yml`, `backend.yml`, `app-store-screenshots.yml`: path filters、self-hosted labels、証跡 upload、実行順。

## CONVENTIONS

- verifier が読む source、fixture、test、`package.json` script、workflow `paths` は一組。新規/改名した script は全利用箇所の path filter と test fixture を同じ diff で更新する。
- App Store contract は `npm run verify:app-store`、screenshots は `npm run verify:app-store:screenshots`、submission は `npm run verify:app-store:submission`。必要なら `--report` で構造化証跡を残す。
- archive は export/upload 前に `python3 scripts/verify-ios-archive.py` を実行し、expected commit/build/privacy と `ios/ArchiveEvidence.json` を結び付ける。
- backend production rollout は dry-run と migration list → maintenance Worker (503確認) → remote D1 migration/list → schema依存 Worker deploy → `/health` と legal URL (200) の順序を崩さない。
- screenshot capture は macOS/Xcode の iOS 26 simulator 限定。固定 device、`9:41` status bar、serial output directory/result bundle/log、`parallel-testing-enabled NO` を維持する。
- evidence は再利用せず run-local artifact に書く。既存 result bundle/PNG は上書きせず、新しい artifact directory を指定する。
- Node は root `package.json` の npm script、Python は標準 library/pytest 契約、shell は `set -euo pipefail` と既存の終了コード方針に合わせる。

## ANTI-PATTERNS

- script の変更だけを path filter 外に置く、または source/fixture/test/package/workflow の片方だけを更新する。
- Linux の `xcodebuild` 代替、生成済み Xcode project の手編集、iOS 26 以外の simulator/device family を成功条件にする。
- archive read-back 前の export、production maintenance 中の離脱、D1 migration と schema依存 deploy の順序逆転。
- Apple/Cloudflare/ASC secrets、private key、bearer token、temporary config/media を stdout、report、git、永続 workspace に残す。
- ASC keychain を login keychain と共有、temporary `.p8`/config を cleanup しない、予期しない path を `rm -rf` する。
- screenshot の時刻/status bar/random data を放置、既存 artifact を上書き、実機/CI 未実行を PASS と報告する。

## COMMANDS

```bash
npm run check:ios
npm run test:app-store
npm run verify:app-store
npm run verify:app-store:screenshots -- --report artifacts/app-store/screenshots/verification.json
python3 scripts/verify-ios-archive.py --archive ios/build/afterimage.xcarchive --expected-commit "$GITHUB_SHA" --expected-build "$GITHUB_RUN_NUMBER" --expected-privacy-manifest ios/Resources/PrivacyInfo.xcprivacy --report ios/ArchiveEvidence.json
bash scripts/generate-app-store-screenshots.sh
./scripts/deploy-backend-production.sh
```

- `generate-app-store-screenshots.sh` と archive/codesign は self-hosted macOS + Xcode が必須。Linux check は代替証拠にならない。
