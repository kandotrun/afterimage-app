# App Store release runbook

このrunbookは承認済みrelease commitに対して担当者が実行する。secret、Cloudflare resource ID、ASC private key、session、実ユーザーmediaをrepoやartifactへ保存しない。この文書の存在はdeploy、URL公開、migration、TestFlight upload、ASC submissionの成功を意味しない。

## 1. Release candidate固定

1. `git status --short --branch` がcleanで対象branch/commitを指すことを記録する。
2. `npm ci`、`npm run check`、`npm audit --audit-level=moderate`、`git diff --check`を実行する。
3. `actionlint .github/workflows/*.yml`を実行する。actionlintを導入していないlocal環境では、PyYAML等の利用可能なparserで全workflowをparseし、CIまたはreview環境ではactionlintを必須にする。
4. macOS self-hosted jobのiOS unit/UI `xcresult`と6.9-inch screenshot artifactを取得する。
5. secret scanとP0/P1 review clearanceを取得する。
6. `release-evidence.json` は実測結果だけをverifiedにする。`releaseCommit`には実際にbuild/testした40桁commit SHAを記録し、全evidence itemの`commit`を同じ値へbindする。各itemは`type`（`github_actions` / `artifact` / `live_probe` / `app_store_connect` / `human_review`）、`result: "passed"`、ISO 8601の`recordedAt`、具体的な`details`に加え、canonical GitHub Actions run URL、`runId`、`runAttempt`、`workflowPath`、`jobName`を持たせる。`artifact`にはGitHubの`artifactId`と実ファイルの64桁`sha256`も記録する。submission verifierはGitHub APIからrun、job、artifactをread-backし、repository、commit、workflow、attempt、成功状態、artifact digestを照合する。private repositoryをlocalで検証する場合は`GITHUB_TOKEN="$(gh auth token)" npm run verify:app-store:submission`を実行する。文字列だけの自己申告、別commit、予定、推測、APIで確認できない証跡を記録しない。

## 2. Backend migration

Issue #42の認証challenge、versioned AI consent、agent access default OFF、非同期account deletion/revoke retryに必要なappend-only migrationが対象commitに含まれることを確認する。migration番号、checksum、対象environmentを記録し、古いmigrationを書き換えない。

権限のある運用者がrepo-managed経路で次の順に行う。

1. stagingで`wrangler d1 migrations list`相当のpending一覧を保存する。
2. stagingへmigrationを適用し、同じ一覧を再取得する。
3. 既存user/asset件数、owner scope、default OFF backfill、nonce一回消費、consent状態、deletion job状態をread-backする。
4. staging backendをdeployし、health、auth challenge、consent gate、upload/playback、account deletion再試行をsmokeする。
5. rollback条件を確認する。破壊的なschema rollbackは行わず、必要ならforward-fix migrationを用意する。
6. productionでは`WRANGLER_CONFIG`、`D1_DATABASE`、`PRODUCTION_ORIGIN`を管理環境で設定し、repoの`scripts/deploy-backend-production.sh`だけを使う。
7. scriptはfinal/maintenanceのdry-run後、schema非依存maintenance Workerを先にdeployして503をread-backし、auth/upload/AI/cronを停止する。その状態でD1 backup付きmigrationを適用し、最終Workerをdeployしてhealthと法務URLの200をread-backする。
8. migrationまたはfinal deployに失敗した場合は旧privacy境界へ戻さずmaintenanceを維持し、forward-fix後にscriptを再実行する。

実コマンドには運用環境の管理configを使う。`wrangler.example.jsonc`のplaceholderを実resource IDへ置換した生成物やCLI tokenをcommitしない。実施前後のmigration一覧、件数だけをprivate release evidenceへ保存し、ユーザー行やtokenを添付しない。

### GitHub Actionsからのproduction自動deploy

`.github/workflows/backend.yml` はtrustedな`main` push（またはmainへの明示的な`workflow_dispatch`）で、`check`成功後に`scripts/deploy-backend-production.sh`を実行する。concurrencyは同一refで直列化し、maintenance→migration→final Worker→health/legal URLの順序はrepo-managed scriptに集約する。PRからproduction deploy jobは実行しない。

Actionsのrepository secretsに次を登録する。

- `CLOUDFLARE_API_TOKEN`: Worker deploy、Worker secret list、対象D1へのmigration applyに必要な最小権限のCloudflare API Token。値はSlack、workflow log、repoへ貼らず、定期的にrotateする。
- `AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG`: 現在のproduction `backend/wrangler.jsonc`全文。`APPLE_PRIVATE_KEY`などのprivate keyは含めない。workflowはjob内で一時ファイルへ書き、終了時に削除する。

secret未設定時はmaintenance deployの前にfail-fastする。`AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG`を更新した場合は、次回のmain deployで新しいbinding/resource設定が使われる。

## 3. 法務URL

認証なしの新しいsessionで次をread-backする。redirect後の最終URL、HTTP status、content type、確認日時、content revisionを記録する。

```bash
curl --fail --silent --show-error --location --output /dev/null --write-out '%{http_code} %{url_effective}\n' https://afterimage.2-38.com/privacy
curl --fail --silent --show-error --location --output /dev/null --write-out '%{http_code} %{url_effective}\n' https://afterimage.2-38.com/support
curl --fail --silent --show-error --location --output /dev/null --write-out '%{http_code} %{url_effective}\n' https://afterimage.2-38.com/terms
```

Privacy本文はdata type、利用目的、Cloudflare/Soniox/Alibaba Cloud Qwen/MCP、保持、削除、問い合わせ、同意撤回、既存生成物の扱いを含む。Supportは問い合わせ手段とaccount deletion案内、Termsはサービス条件と適用日を含む。login/settingsからの導線も実機で確認する。

## 4. Screenshot

macOS self-hosted runnerで`npm run screenshots:app-store`を実行する。生成元はDebug-onlyの決定的fixtureで、実ユーザーsessionやnetworkへ接続しない。artifact内の3 PNG、`TestResults.xcresult`、build log、`verification.json`を取得する。

PNGを目視し、日本語、status bar、切れ、実データなし、debug overlayなし、動画・場所・文字起こし・解析の意味が伝わることを二名で確認する。Linuxで代替PNGを作らない。

## 5. ArchiveとASC preflight

`ios-deploy.yml`のdeploy jobはPRから実行せず、`AFTERIMAGE_CI_KEYCHAIN_PASSWORD`、`ASC_ISSUER_ID`、`ASC_KEY_ID`、`ASC_PRIVATE_KEY`の存在だけをpreflightする。値はログへ出さない。ASC keyとsigning keychain copyは`RUNNER_TEMP`配下に作り、成功・失敗を問わず`if: always()`で削除する。login keychainをunlockしない。

Release archive内のapp/extensionがiPhone family、Privacy Manifest同梱、version/build一致であることをread-backする。Required Reason API warning、export validation、処理結果を記録する。このブランチのローカル検証ではworkflowをdispatchせず、ASCへupload/submissionしない。

## 6. App Store Connect

`release-checklist.md`を順に埋め、JSONとASC入力を相互確認する。build選択、価格/提供地域、export compliance、privacy、age rating、screenshots、review notes、release optionを別担当がレビューする。`npm run verify:app-store:submission`がPASSし、全証跡が対象commitに対応するまでSubmit for Reviewを押さない。
