# Privacy safety backend runbook

This runbook describes configuration and operational checks for the backend changes in D1 migration `0012_privacy_safety.sql`. It does not assert that any environment has already been migrated or deployed.

## Required configuration

Keep `APPLE_TEAM_ID` and `APPLE_KEY_ID` as non-secret Worker variables. Store the Apple Sign in with Apple private key only as the `APPLE_PRIVATE_KEY` Worker secret. Do not place the private key, Soniox key, Qwen key, worker token, bearer token, authorization code, or generated deployment configuration in this repository.

The Apple private key may contain literal newlines or escaped `\n` sequences. The backend uses it only to create the short-lived client secret required for Apple authorization-code exchange and token revocation.

## API rollout

Coordinate rollout with a client that obtains `GET /v1/auth/apple/challenge`, hashes the returned raw nonce with SHA-256 for Apple, and sends `challengeId` with the Apple identity token. Direct identity-token sign-in without a challenge is intentionally rejected. Account deletion also requires a fresh Apple authorization code on its first `DELETE /v1/account` request; every accepted deletion response tells the client to clear its local session even while durable external cleanup remains pending.

## Migration

Before deploying the Worker, inspect the target D1 database and apply pending migrations through the repository's Wrangler migration workflow. Migration `0012_privacy_safety.sql` is append-only and safe to run again: it preserves users and assets, backfills `assets.agent_access_enabled` to off, and clears existing external-agent grants and GPU jobs.

After migration, verify:

- all existing assets have `agent_access_enabled = 0`;
- the consent, Apple challenge, quota ledger, external-AI lease, and deletion-job tables exist;
- no agent, worker, or transcription media grant from before the consent boundary remains;
- no pre-migration GPU job remains.

## Account deletion retries

Account deletion records intent before external cleanup, revokes sessions immediately, and is resumed by the minute and daily scheduled handlers. A pending job keeps bounded error metadata in `last_error_code`, `attempt_count`, and `next_attempt_at`. Do not delete a pending job to work around a provider outage.

Investigate repeated retries using only the deletion job ID and error code. Never copy `authorization_code` or `revocation_token` into logs or tickets. Restore Apple, Soniox, D1, or R2 availability and allow the scheduled handler to retry. Completed jobs discard asset snapshots, anonymize account identifiers, and retain only the tombstone metadata needed for idempotent session-receipt responses. Authorization and revocation tokens are cleared immediately, and completed tombstones and receipts are pruned after 30 days.

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
