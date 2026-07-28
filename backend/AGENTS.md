# Backend Knowledge Base

## OVERVIEW

- Cloudflare Worker の Hono API。`src/index.ts` が fetch と scheduled の境界。
- `createApp` が公開ルートと `/v1` ルートを組み立て、D1 は状態、R2 `MEDIA` は本文を持つ。
- 認証、アップロード、再生、文字起こし、日次要約、daily weather、MCP を同じ Worker で扱う。

## WHERE TO LOOK

- `src/index.ts`: `createApp()` の fetch 委譲、cron 分岐。`17 3 * * *` は期限状態 cleanup、それ以外は Soniox polling（production example の trigger は daily cron のみ）。
- `src/app.ts`: `createApp`、`authMiddleware`、全 `/v1` route、asset の D1/R2 状態遷移。
- `src/apple.ts`: Apple JWKS の JWT 検証。issuer と `APPLE_BUNDLE_ID` audience。
- `src/soniox.ts`: Soniox の file upload、async job 作成、status/transcript 取得、resource cleanup。
- `src/qwen-summary.ts`: Qwen Token Plan の endpoint 制約、model 選択、日次要約の正規化。
- `src/weather.ts`: 認証ユーザー単位の daily weather upsert/list、日付範囲、WeatherKit attribution URL。
- `src/mcp.ts`: MCP bearer token の hash 照合、認証ユーザー専用の read-only tools、CORS。
- `migrations/`: D1 schema の履歴。新しい SQL は番号を追加し、適用済み migration は書き換えない。
- `tests/app.test.ts`, `tests/qwen-summary.test.ts`: route lifecycle、weather ownership、Qwen provider の境界テスト。`tests/setup.ts` は D1 migrations を適用する。
- `wrangler.dev.jsonc`, `wrangler.test.jsonc`, `wrangler.example.jsonc`: 環境別 D1/R2 binding と vars。`scripts/seed-dev.mjs` は dev 用データ入口。
- `src/worker-configuration.d.ts`: Wrangler 生成の ambient binding 型。手編集せず、手動実装の対象から除外。

## CONVENTIONS

- `createApp(overrides)` に Apple verifier、Qwen generator、clock を注入。テストは外部 provider を stub 化する。
- `authMiddleware` は bearer token を SHA-256 hash 化し、D1 の sessions/users join で `auth` context を設定する。`/v1` は middleware 配下。
- asset・MCP token・session の D1 query は `auth.userId` を必ず bind。R2 key は `users/{userId}/assets/{assetId}/` prefix で揃える。
- upload は `uploading` → `ready`/`failed`。single は lease、multipart は `upload_parts` と R2 upload id を D1 で追跡する。
- complete は R2 object の存在・size を確認してから D1 を `ready` に遷移。thumbnail、delete、stale cleanup は D1 と R2 を同じ owner prefix で掃除する。
- video が ready になった後、Soniox key がある場合だけ transcription を `pending` に queue。poll は pending/processing を順に進める。
- daily weather は `auth.userId` と local date で所有者分離し、保存した WeatherKit attribution URL を応答へ維持する。
- Qwen は HTTPS かつ許可された Token Plan host のみ。応答 model は設定値と一致し、要約は 60 文字以内。

## ANTI-PATTERNS

- `findOwnedAsset` や同等の owner 条件を外した D1 asset query、または別ユーザーの R2 prefix 参照。
- single upload や multipart part を Worker memory に全量展開する処理。request body は R2 へ stream する。
- migration の既存番号編集・並べ替え、schema の手動適用。D1 の `migrations_dir` と履歴を壊さない。
- `17 3 * * *` の daily cleanup と Soniox polling の責務を一つの処理へ混在させる。
- Soniox/Qwen の許可されていない endpoint、model の無検証利用、provider の生レスポンスを API に露出する実装。
- `scripts/seed-dev.mjs` を本番・remote D1/R2 に向ける変更。これは `wrangler ... --local` 前提のローカル専用 seeder。

## COMMANDS

```bash
npm --workspace backend test
npm --workspace backend run typecheck
npm --workspace backend run deploy:dry
npm --workspace backend run dev
npm --workspace backend run seed:dev
npm --workspace backend run types
```
