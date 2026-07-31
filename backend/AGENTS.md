# Backend Knowledge Base

## RUNTIME MAP

- `src/index.ts`: Worker entry. `fetch` delegates to `createApp`; `17 3 * * *` runs state cleanup plus account-deletion work, every other trigger runs transcription polling, Mage queue polling, and account-deletion work.
- `src/app.ts`: composition root for auth, `/v1` routes, upload/playback, weather, summaries, MCP handoff, and deletion intent; `createApp(overrides)` is the test seam. Keep provider and lease mechanics in leaf modules.
- `src/transcription.ts`: Soniox submission/status polling. Claim an asset, acquire `soniox_work_leases`, persist provider IDs before promotion, and use `soniox_cleanup_outbox` for retryable deletion; never clear IDs manually after a provider failure.
- `src/gpu-jobs.ts`: consent-gated Mage-VL queue and worker lease API. Analysis jobs use the pinned model/revision and a per-owner limit of four; frame/clip derivatives additionally require `agent_access_enabled`.
- `src/mcp.ts`: Streamable HTTP MCP endpoint. Hash `aft_mcp_…` tokens, require current AI consent, scope every query and grant to the authenticated owner, and return short-lived agent resource links only.
- `src/account-deletion.ts`: durable intent, immediate session/token quarantine, Apple revocation, owner-token fencing, Soniox/R2 cleanup, and idempotent tombstone completion. `processPendingAccountDeletions` is the scheduled retry driver.
- `src/privacy.ts`: `AI_CONSENT_VERSION` and active-consent predicates are the authority for Soniox, Qwen, Mage, and MCP work. `src/soniox.ts` and `src/qwen-summary.ts` contain provider-specific HTTP and response validation.

## STATE AND PRIVACY BOUNDARIES

- Bind all asset, transcript, derivative, grant, MCP, and deletion queries to the authenticated `user_id`; object keys are `users/{userId}/assets/{assetId}/…` and must pass the same-prefix guard before deletion.
- Upload lifecycle is `uploading` → `ready`/`failed`; single and multipart operations hold D1 claims while streaming request bodies to R2. Completion verifies object existence and declared size before publishing `ready`.
- App, worker, transcription, and agent media grants are hashed, purpose-tagged, owner-bound, and expiring. Large Soniox inputs use an HTTPS private media grant; do not buffer the R2 body in Worker memory.
- Withdrawal or account deletion must stop new AI work, revoke applicable grants, and fence stale leases. Account deletion waits for active Soniox/external-AI work before removing provider resources and the owner prefix.
- `migrations/` is append-only. `0012_privacy_safety.sql` resets agent access and external jobs; `0013_soniox_cleanup_safety.sql` adds deletion markers/leases/outbox; `0014_account_deletion_work_fence.sql` blocks new work during deletion. Use the maintenance Worker rollout sequence for schema changes.
- `src/worker-configuration.d.ts` is Wrangler-generated ambient binding type; regenerate with the `types` script, never hand-edit or treat it as source of truth. Keep `wrangler.*.jsonc` bindings aligned per environment.

## PROVIDER AND LEASE RULES

- Soniox direct upload is bounded by `SONIOX_DIRECT_UPLOAD_MAX_BYTES` (default 100 MiB); oversized media must use the HTTPS grant path. Lease takeover must not let stale workers promote IDs or release a replacement lease.
- Mage worker requests require a token matching `MAGE_WORKER_TOKEN_HASH`, supported capabilities, active consent, and a live lease token. Validate model/revision, ranges, bounded summaries, and failure codes with Zod; persist no raw provider payloads or secrets.
- Qwen requests require HTTPS and an allowed Token Plan host/model; normalize output to the 60-character summary contract and hide upstream response bodies. External-AI leases are owner-scoped and counted against concurrency limits.

## TEST AND CHANGE SURFACE

- Route/auth/upload/cleanup/weather/MCP/GPU behavior: `backend/tests/app.test.ts`, `memory-api.test.ts`, `privacy-safety.test.ts`.
- Soniox claim, streaming, takeover, and large-asset paths: `backend/tests/transcription.test.ts`, `transcription-large-assets.test.ts`; provider summary boundaries: `qwen-summary.test.ts`.
- Run `npm --workspace backend test`, `npm --workspace backend run typecheck`, `npm --workspace backend run types`, and `npm --workspace backend run deploy:dry`; use `npm run check` for the repository gate. Update migration/contract tests with any schema or wire change.
