# Privacy safety backend runbook

This runbook describes configuration and operational checks for the backend changes in D1 migrations `0012_privacy_safety.sql` and `0013_soniox_cleanup_safety.sql`. It does not assert that any environment has already been migrated or deployed.

## Required configuration

Keep `APPLE_TEAM_ID` and `APPLE_KEY_ID` as non-secret Worker variables. Store the Apple Sign in with Apple private key only as the `APPLE_PRIVATE_KEY` Worker secret. Do not place the private key, Soniox key, Qwen key, worker token, bearer token, authorization code, or generated deployment configuration in this repository.

The Apple private key may contain literal newlines or escaped `\n` sequences. The backend uses it only to create the short-lived client secret required for Apple authorization-code exchange and token revocation.

## API rollout

Coordinate rollout with a client that obtains `GET /v1/auth/apple/challenge`, hashes the returned raw nonce with SHA-256 for Apple, and sends `challengeId` with the Apple identity token. Direct identity-token sign-in without a challenge is intentionally rejected. Account deletion sends the fresh challenge ID, identity token, and Apple authorization code together. The backend verifies both the credential token and the token returned by the code exchange against the nonce and current Apple subject before atomically storing only the revocation token with the deletion intent. Every accepted deletion response tells the client to clear its local session even while durable external cleanup remains pending.

## Migration

Do not apply the privacy reset while the old Worker remains live. For production, use `scripts/deploy-backend-production.sh`: it first deploys the schema-independent maintenance Worker and confirms HTTP 503 for `/health`, then applies migrations `0012_privacy_safety.sql` and `0013_soniox_cleanup_safety.sql`, and only then deploys the final Worker. Migration `0012` preserves users and assets, backfills `assets.agent_access_enabled` to off, and clears existing external-agent grants and GPU jobs; `0013` adds the asset deletion marker and bounded Soniox work leases. If migration or final deployment fails, keep maintenance active and forward-fix instead of restoring the old privacy boundary.

After migration, verify:

- all existing assets have `agent_access_enabled = 0`;
- the consent, Apple challenge, quota ledger, external-AI lease, Soniox work lease, and deletion-job tables exist;
- `assets.deletion_requested_at` exists and is null for active assets;
- no agent, worker, or transcription media grant from before the consent boundary remains;
- no pre-migration GPU job remains.

Mage-VL operation after this rollout is gated by the active global AI consent, not
by `assets.agent_access_enabled`. The latter is the per-asset MCP/agent boundary.
On every minute tick the Worker fills at most four consented Mage analysis jobs per
owner; completing or failing a job refills the next eligible video. Withdrawing AI
consent cancels queued/leased worker jobs and revokes worker grants. Disabling only
agent access cancels frame/clip derivatives and agent grants but leaves Mage
analysis work intact.

## Account deletion retries

Account deletion records intent before external cleanup, revokes sessions immediately, and is resumed by the minute and daily scheduled handlers. A pending job keeps bounded error metadata in `last_error_code`, `attempt_count`, and `next_attempt_at`. Do not delete a pending job to work around a provider outage.

Investigate repeated retries using only the deletion job ID and error code. Never copy `revocation_token` into logs or tickets. Restore Apple, Soniox, D1, or R2 availability and allow the scheduled handler to retry. Completed jobs discard asset snapshots, anonymize account identifiers, and retain only the tombstone metadata needed for idempotent session-receipt responses. Revocation tokens are cleared immediately, and completed tombstones and receipts are pruned after 30 days by scheduled cleanup.

## Soniox cleanup retries

A transcription tick acquires a bounded `soniox_work_leases` row before any provider request. Asset or account deletion first marks the asset and withdraws consent, then waits for any active lease. Provider IDs created by a racing request are persisted on the failed asset tombstone before strict Soniox deletion is attempted. A non-2xx response keeps those IDs durable; daily cleanup retries them and removes the D1/R2 tombstone only after Soniox returns success or 404. Do not manually clear provider IDs to force deletion forward.

## Review checks

Run from the repository root:

```bash
npm ci
npm --workspace backend test
npm --workspace backend run typecheck
npm run check
npm audit --audit-level=moderate
git diff --check
```

Linux verification does not replace Xcode build or test execution, and this backend migration does not require iOS source changes.
