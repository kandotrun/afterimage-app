import {
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
} from "./apple";
import { deleteSonioxResources } from "./soniox";

export interface AccountDeletionDependencies {
  exchangeAppleAuthorizationCode: (
    bindings: Env,
    authorizationCode: string,
  ) => Promise<{
    token: string;
    tokenType: "refresh_token" | "access_token";
    identityToken: string;
  }>;
  revokeAppleToken: (
    bindings: Env,
    token: string,
    tokenType: "refresh_token" | "access_token",
  ) => Promise<void>;
  deleteSonioxResources: (
    bindings: Env,
    transcriptionId: string | null,
    fileId: string | null,
  ) => Promise<void>;
}

export const defaultAccountDeletionDependencies: AccountDeletionDependencies = {
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
  deleteSonioxResources,
};

interface DeletionUser {
  userId: string;
  appleSubject: string;
}

export interface AppleRevocationCredential {
  token: string;
  tokenType: "refresh_token" | "access_token";
}

interface DeletionJobRow {
  id: string;
  user_id: string;
  status: "pending" | "processing" | "completed";
  revocation_token: string | null;
  revocation_token_type: "refresh_token" | "access_token" | null;
  apple_revoked_at: string | null;
  owner_token: string;
  attempt_count: number;
}

interface DeletionAssetRow {
  asset_id: string;
  user_id: string;
  object_key: string;
  upload_mode: "single" | "multipart";
  upload_id: string | null;
  soniox_file_id: string | null;
  soniox_transcription_id: string | null;
  soniox_cleaned_at: string | null;
  multipart_aborted_at: string | null;
  r2_cleaned_at: string | null;
}

export interface AccountDeletionReceipt {
  id: string;
  status: "pending" | "processing" | "completed";
}

class AccountDeletionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function assetPrefix(userId: string, assetId: string): string {
  return `users/${userId}/assets/${assetId}/`;
}

async function deletePrefixObjects(
  bindings: Env,
  prefix: string,
): Promise<void> {
  for (let page = 0; page < 10; page += 1) {
    const listed = await bindings.MEDIA.list({ prefix, limit: 1_000 });
    if (listed.objects.length > 0) {
      await bindings.MEDIA.delete(listed.objects.map((object) => object.key));
    }
    if (!listed.truncated) return;
  }
  throw new AccountDeletionError("r2_cleanup_batch_limit");
}

function retryAt(now: Date, attemptCount: number): string {
  const exponent = Math.min(Math.max(attemptCount, 0), 10);
  const delay = Math.min(24 * 60 * 60 * 1_000, 60_000 * (2 ** exponent));
  return new Date(now.getTime() + delay).toISOString();
}

async function renewDeletionLease(
  bindings: Env,
  jobId: string,
  ownerToken: string,
  now: Date,
): Promise<void> {
  const renewed = await bindings.DB.prepare(
    `UPDATE account_deletion_jobs
        SET updated_at = ?
      WHERE id = ? AND status = 'processing' AND owner_token = ?`,
  ).bind(now.toISOString(), jobId, ownerToken).run();
  if ((renewed.meta.changes ?? 0) !== 1) {
    throw new AccountDeletionError("deletion_lease_lost");
  }
}

async function returnJobToPending(
  bindings: Env,
  jobId: string,
  ownerToken: string,
  now: Date,
  attemptCount: number,
  errorCode: string | null,
): Promise<void> {
  await bindings.DB.prepare(
    `UPDATE account_deletion_jobs
        SET status = 'pending',
            owner_token = NULL,
            attempt_count = MIN(attempt_count + ?, 100),
            next_attempt_at = ?,
            last_error_code = ?,
            updated_at = ?
      WHERE id = ? AND status = 'processing' AND owner_token = ?`,
  ).bind(
    errorCode ? 1 : 0,
    errorCode ? retryAt(now, attemptCount) : now.toISOString(),
    errorCode,
    now.toISOString(),
    jobId,
    ownerToken,
  ).run();
}

export async function findAccountDeletionByReceipt(
  bindings: Env,
  tokenHash: string,
): Promise<AccountDeletionReceipt | null> {
  return bindings.DB.prepare(
    `SELECT job.id, job.status
       FROM account_deletion_receipts receipt
       JOIN account_deletion_jobs job ON job.id = receipt.job_id
      WHERE receipt.token_hash = ?`,
  ).bind(tokenHash).first<AccountDeletionReceipt>();
}

export async function createAccountDeletionIntent(
  bindings: Env,
  user: DeletionUser,
  credential: AppleRevocationCredential,
  now: Date,
): Promise<AccountDeletionReceipt> {
  const existing = await bindings.DB.prepare(
    `SELECT id, status
       FROM account_deletion_jobs
      WHERE user_id = ?`,
  ).bind(user.userId).first<AccountDeletionReceipt>();
  if (existing) return existing;

  const jobId = crypto.randomUUID();
  const nowIso = now.toISOString();
  try {
    await bindings.DB.batch([
      bindings.DB.prepare(
        `INSERT INTO account_deletion_jobs (
          id, user_id, apple_subject, status,
          revocation_token, revocation_token_type,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).bind(
        jobId,
        user.userId,
        user.appleSubject,
        credential.token,
        credential.tokenType,
        nowIso,
        nowIso,
        nowIso,
      ),
      bindings.DB.prepare(
        `INSERT OR IGNORE INTO account_deletion_receipts (
          token_hash, job_id, created_at
        )
        SELECT token_hash, ?, ?
          FROM sessions
         WHERE user_id = ?`,
      ).bind(jobId, nowIso, user.userId),
      bindings.DB.prepare(
        `INSERT OR IGNORE INTO account_deletion_assets (
          job_id, asset_id, user_id, object_key, upload_mode, upload_id,
          soniox_file_id, soniox_transcription_id
        )
        SELECT ?, id, user_id, object_key, upload_mode, upload_id,
               soniox_file_id, soniox_transcription_id
          FROM assets
         WHERE user_id = ?`,
      ).bind(jobId, user.userId),
      bindings.DB.prepare(
        `UPDATE assets
            SET agent_access_enabled = 0,
                deletion_requested_at = COALESCE(deletion_requested_at, ?),
                updated_at = ?
          WHERE user_id = ?`,
      ).bind(nowIso, nowIso, user.userId),
      bindings.DB.prepare(
        `UPDATE ai_consents
            SET withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ?
          WHERE user_id = ?`,
      ).bind(nowIso, nowIso, user.userId),
      bindings.DB.prepare(
        `UPDATE mcp_tokens SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(nowIso, user.userId),
      bindings.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.userId),
    ]);
  } catch (error) {
    const raced = await bindings.DB.prepare(
      "SELECT id, status FROM account_deletion_jobs WHERE user_id = ?",
    ).bind(user.userId).first<AccountDeletionReceipt>();
    if (raced) return raced;
    throw error;
  }
  return { id: jobId, status: "pending" };
}

export async function processAccountDeletionJob(
  bindings: Env,
  jobId: string,
  now: Date,
  dependencies: AccountDeletionDependencies = defaultAccountDeletionDependencies,
): Promise<"pending" | "completed"> {
  const nowIso = now.toISOString();
  const staleProcessing = new Date(now.getTime() - 5 * 60 * 1_000).toISOString();
  const ownerToken = crypto.randomUUID();
  const claimed = await bindings.DB.prepare(
    `UPDATE account_deletion_jobs
        SET status = 'processing', owner_token = ?, updated_at = ?
      WHERE id = ? AND (
        (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'processing' AND updated_at <= ?)
      )
    RETURNING id, user_id, status, revocation_token,
              revocation_token_type, apple_revoked_at, owner_token, attempt_count`,
  ).bind(ownerToken, nowIso, jobId, nowIso, staleProcessing).first<DeletionJobRow>();
  if (!claimed) {
    const current = await bindings.DB.prepare(
      "SELECT status FROM account_deletion_jobs WHERE id = ?",
    ).bind(jobId).first<{ status: "pending" | "processing" | "completed" }>();
    return current?.status === "completed" ? "completed" : "pending";
  }

  try {
    const heartbeatNow = () => new Date(Math.max(now.getTime(), Date.now()));
    const revocationToken = claimed.revocation_token;
    const revocationTokenType = claimed.revocation_token_type;
    if (!claimed.apple_revoked_at) {
      if (!revocationToken || !revocationTokenType) {
        throw new AccountDeletionError("apple_revocation_token_missing");
      }
      await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
      await dependencies.revokeAppleToken(
        bindings,
        revocationToken,
        revocationTokenType,
      );
      const checkpointed = await bindings.DB.prepare(
        `UPDATE account_deletion_jobs
            SET apple_revoked_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND owner_token = ?`,
      ).bind(nowIso, nowIso, jobId, claimed.owner_token).run();
      if ((checkpointed.meta.changes ?? 0) !== 1) {
        throw new AccountDeletionError("deletion_lease_lost");
      }
    }

    const activeSonioxWork = await bindings.DB.prepare(
      `SELECT 1 AS found
         FROM soniox_work_leases
        WHERE user_id = ? AND expires_at > ?
        LIMIT 1`,
    ).bind(claimed.user_id, nowIso).first<{ found: number }>();
    if (activeSonioxWork) {
      await returnJobToPending(
        bindings,
        jobId,
        claimed.owner_token,
        now,
        claimed.attempt_count,
        null,
      );
      return "pending";
    }

    await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
    await bindings.DB.prepare(
      `UPDATE account_deletion_assets
          SET soniox_file_id = COALESCE(
                (SELECT asset.soniox_file_id FROM assets asset
                  WHERE asset.id = account_deletion_assets.asset_id
                    AND asset.user_id = account_deletion_assets.user_id),
                soniox_file_id
              ),
              soniox_transcription_id = COALESCE(
                (SELECT asset.soniox_transcription_id FROM assets asset
                  WHERE asset.id = account_deletion_assets.asset_id
                    AND asset.user_id = account_deletion_assets.user_id),
                soniox_transcription_id
              )
        WHERE job_id = ?
          AND EXISTS (
            SELECT 1 FROM account_deletion_jobs job
             WHERE job.id = account_deletion_assets.job_id
               AND job.status = 'processing' AND job.owner_token = ?
          )`,
    ).bind(jobId, claimed.owner_token).run();

    const provisionalSoniox = await bindings.DB.prepare(
      `SELECT id, soniox_file_id, soniox_transcription_id
         FROM soniox_cleanup_outbox
        WHERE user_id = ? AND promoted_at IS NULL
        ORDER BY created_at LIMIT 100`,
    ).bind(claimed.user_id).all<{
      id: string;
      soniox_file_id: string | null;
      soniox_transcription_id: string | null;
    }>();
    for (const resource of provisionalSoniox.results) {
      await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
      await dependencies.deleteSonioxResources(
        bindings,
        resource.soniox_transcription_id,
        resource.soniox_file_id,
      );
      const removed = await bindings.DB.prepare(
        `DELETE FROM soniox_cleanup_outbox
          WHERE id = ? AND promoted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM account_deletion_jobs job
               WHERE job.id = ? AND job.status = 'processing'
                 AND job.owner_token = ?
            )`,
      ).bind(resource.id, jobId, claimed.owner_token).run();
      if ((removed.meta.changes ?? 0) !== 1) {
        throw new AccountDeletionError("deletion_lease_lost");
      }
    }

    const assets = await bindings.DB.prepare(
      `SELECT asset_id, user_id, object_key, upload_mode, upload_id,
              soniox_file_id, soniox_transcription_id, soniox_cleaned_at,
              multipart_aborted_at, r2_cleaned_at
         FROM account_deletion_assets
        WHERE job_id = ?
          AND (soniox_cleaned_at IS NULL OR r2_cleaned_at IS NULL)
        ORDER BY asset_id LIMIT 100`,
    ).bind(jobId).all<DeletionAssetRow>();
    for (const asset of assets.results) {
      await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
      const prefix = assetPrefix(claimed.user_id, asset.asset_id);
      if (asset.user_id !== claimed.user_id || !asset.object_key.startsWith(prefix)) {
        throw new AccountDeletionError("ownership_guard_failed");
      }
      if (!asset.soniox_cleaned_at) {
        if (asset.soniox_transcription_id || asset.soniox_file_id) {
          await dependencies.deleteSonioxResources(
            bindings,
            asset.soniox_transcription_id,
            asset.soniox_file_id,
          );
        }
        const sonioxCheckpoint = await bindings.DB.prepare(
          `UPDATE account_deletion_assets SET soniox_cleaned_at = ?
            WHERE job_id = ? AND asset_id = ?
              AND EXISTS (
                SELECT 1 FROM account_deletion_jobs job
                 WHERE job.id = account_deletion_assets.job_id
                   AND job.status = 'processing' AND job.owner_token = ?
              )`,
        ).bind(nowIso, jobId, asset.asset_id, claimed.owner_token).run();
        if ((sonioxCheckpoint.meta.changes ?? 0) !== 1) {
          throw new AccountDeletionError("deletion_lease_lost");
        }
      }
      if (!asset.r2_cleaned_at) {
        if (
          asset.upload_mode === "multipart"
          && asset.upload_id
          && !asset.multipart_aborted_at
        ) {
          await bindings.MEDIA.resumeMultipartUpload(
            asset.object_key,
            asset.upload_id,
          ).abort();
          const multipartCheckpoint = await bindings.DB.prepare(
            `UPDATE account_deletion_assets SET multipart_aborted_at = ?
              WHERE job_id = ? AND asset_id = ?
                AND EXISTS (
                  SELECT 1 FROM account_deletion_jobs job
                   WHERE job.id = account_deletion_assets.job_id
                     AND job.status = 'processing' AND job.owner_token = ?
                )`,
          ).bind(nowIso, jobId, asset.asset_id, claimed.owner_token).run();
          if ((multipartCheckpoint.meta.changes ?? 0) !== 1) {
            throw new AccountDeletionError("deletion_lease_lost");
          }
        }
        await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
        await bindings.MEDIA.delete([
          asset.object_key,
          `${prefix}thumbnail.jpg`,
        ]);
        await deletePrefixObjects(bindings, prefix);
        const r2Checkpoint = await bindings.DB.prepare(
          `UPDATE account_deletion_assets SET r2_cleaned_at = ?
            WHERE job_id = ? AND asset_id = ?
              AND EXISTS (
                SELECT 1 FROM account_deletion_jobs job
                 WHERE job.id = account_deletion_assets.job_id
                   AND job.status = 'processing' AND job.owner_token = ?
              )`,
        ).bind(nowIso, jobId, asset.asset_id, claimed.owner_token).run();
        if ((r2Checkpoint.meta.changes ?? 0) !== 1) {
          throw new AccountDeletionError("deletion_lease_lost");
        }
      }
    }

    const remaining = await bindings.DB.prepare(
      `SELECT 1 AS found
         FROM account_deletion_assets
        WHERE job_id = ?
          AND (soniox_cleaned_at IS NULL OR r2_cleaned_at IS NULL)
       UNION ALL
       SELECT 1 AS found
         FROM soniox_cleanup_outbox
        WHERE user_id = ? AND promoted_at IS NULL
       LIMIT 1`,
    ).bind(jobId, claimed.user_id).first<{ found: number }>();
    if (remaining) {
      await returnJobToPending(
        bindings,
        jobId,
        claimed.owner_token,
        now,
        claimed.attempt_count,
        null,
      );
      return "pending";
    }

    await renewDeletionLease(bindings, jobId, claimed.owner_token, heartbeatNow());
    await deletePrefixObjects(bindings, `users/${claimed.user_id}/`);
    const completion = await bindings.DB.batch([
      bindings.DB.prepare(
        `DELETE FROM users
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM account_deletion_jobs job
             WHERE job.id = ? AND job.status = 'processing'
               AND job.owner_token = ?
          )`,
      ).bind(claimed.user_id, jobId, claimed.owner_token),
      bindings.DB.prepare(
        `DELETE FROM soniox_cleanup_outbox
          WHERE user_id = ? AND EXISTS (
            SELECT 1 FROM account_deletion_jobs job
             WHERE job.id = ? AND job.status = 'processing'
               AND job.owner_token = ?
          )`,
      ).bind(claimed.user_id, jobId, claimed.owner_token),
      bindings.DB.prepare(
        `DELETE FROM account_deletion_assets
          WHERE job_id = ? AND EXISTS (
            SELECT 1 FROM account_deletion_jobs job
             WHERE job.id = account_deletion_assets.job_id
               AND job.status = 'processing' AND job.owner_token = ?
          )`,
      ).bind(jobId, claimed.owner_token),
      bindings.DB.prepare(
        `UPDATE account_deletion_jobs
            SET status = 'completed', user_id = id,
                apple_subject = 'deleted:' || id,
                owner_token = NULL,
                revocation_token = NULL, revocation_token_type = NULL,
                last_error_code = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND owner_token = ?`,
      ).bind(nowIso, nowIso, jobId, claimed.owner_token),
    ]);
    return (completion[3]?.meta.changes ?? 0) === 1 ? "completed" : "pending";
  } catch (error) {
    const errorCode = error instanceof AccountDeletionError
      ? error.code
      : "external_cleanup_failed";
    await returnJobToPending(
      bindings,
      jobId,
      claimed.owner_token,
      now,
      claimed.attempt_count,
      errorCode,
    );
    if (errorCode !== "deletion_lease_lost") {
      console.error(JSON.stringify({
        event: "account_deletion_retry_scheduled",
        jobId,
        errorCode,
      }));
    }
    return "pending";
  }
}

export async function processPendingAccountDeletions(
  bindings: Env,
  now = new Date(),
  dependencies: AccountDeletionDependencies = defaultAccountDeletionDependencies,
): Promise<{ processed: number }> {
  const jobs = await bindings.DB.prepare(
    `SELECT id
       FROM account_deletion_jobs
      WHERE (
        status = 'pending' AND next_attempt_at <= ?
      ) OR (
        status = 'processing' AND updated_at <= ?
      )
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT 10`,
  ).bind(
    now.toISOString(),
    new Date(now.getTime() - 5 * 60 * 1_000).toISOString(),
  ).all<{ id: string }>();
  for (const job of jobs.results) {
    await processAccountDeletionJob(bindings, job.id, now, dependencies);
  }
  return { processed: jobs.results.length };
}
