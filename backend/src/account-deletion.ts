import {
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
} from "./apple";
import { deleteSonioxResources } from "./soniox";

export interface AccountDeletionDependencies {
  exchangeAppleAuthorizationCode: (
    bindings: Env,
    authorizationCode: string,
  ) => Promise<{ token: string; tokenType: "refresh_token" | "access_token" }>;
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

interface DeletionJobRow {
  id: string;
  user_id: string;
  status: "pending" | "processing" | "completed";
  authorization_code: string | null;
  revocation_token: string | null;
  revocation_token_type: "refresh_token" | "access_token" | null;
  apple_revoked_at: string | null;
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

async function returnJobToPending(
  bindings: Env,
  jobId: string,
  now: Date,
  attemptCount: number,
  errorCode: string | null,
): Promise<void> {
  await bindings.DB.prepare(
    `UPDATE account_deletion_jobs
        SET status = 'pending',
            attempt_count = MIN(attempt_count + ?, 100),
            next_attempt_at = ?,
            last_error_code = ?,
            updated_at = ?
      WHERE id = ? AND status = 'processing'`,
  ).bind(
    errorCode ? 1 : 0,
    errorCode ? retryAt(now, attemptCount) : now.toISOString(),
    errorCode,
    now.toISOString(),
    jobId,
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
  authorizationCode: string,
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
          id, user_id, apple_subject, status, authorization_code,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).bind(
        jobId,
        user.userId,
        user.appleSubject,
        authorizationCode,
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
        "UPDATE assets SET agent_access_enabled = 0, updated_at = ? WHERE user_id = ?",
      ).bind(nowIso, user.userId),
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
  const claimed = await bindings.DB.prepare(
    `UPDATE account_deletion_jobs
        SET status = 'processing', updated_at = ?
      WHERE id = ? AND (
        (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'processing' AND updated_at <= ?)
      )
    RETURNING id, user_id, status, authorization_code, revocation_token,
              revocation_token_type, apple_revoked_at, attempt_count`,
  ).bind(nowIso, jobId, nowIso, staleProcessing).first<DeletionJobRow>();
  if (!claimed) {
    const current = await bindings.DB.prepare(
      "SELECT status FROM account_deletion_jobs WHERE id = ?",
    ).bind(jobId).first<{ status: "pending" | "processing" | "completed" }>();
    return current?.status === "completed" ? "completed" : "pending";
  }

  try {
    let revocationToken = claimed.revocation_token;
    let revocationTokenType = claimed.revocation_token_type;
    if (!claimed.apple_revoked_at) {
      if (!revocationToken || !revocationTokenType) {
        if (!claimed.authorization_code) {
          throw new AccountDeletionError("apple_reauthorization_missing");
        }
        const exchanged = await dependencies.exchangeAppleAuthorizationCode(
          bindings,
          claimed.authorization_code,
        );
        revocationToken = exchanged.token;
        revocationTokenType = exchanged.tokenType;
        const persisted = await bindings.DB.prepare(
          `UPDATE account_deletion_jobs
              SET revocation_token = ?, revocation_token_type = ?,
                  authorization_code = NULL, updated_at = ?
            WHERE id = ? AND status = 'processing'`,
        ).bind(
          revocationToken,
          revocationTokenType,
          nowIso,
          jobId,
        ).run();
        if ((persisted.meta.changes ?? 0) !== 1) {
          throw new AccountDeletionError("deletion_job_conflict");
        }
      }
      await dependencies.revokeAppleToken(
        bindings,
        revocationToken,
        revocationTokenType,
      );
      await bindings.DB.prepare(
        `UPDATE account_deletion_jobs
            SET apple_revoked_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'`,
      ).bind(nowIso, nowIso, jobId).run();
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
        await bindings.DB.prepare(
          `UPDATE account_deletion_assets SET soniox_cleaned_at = ?
            WHERE job_id = ? AND asset_id = ?`,
        ).bind(nowIso, jobId, asset.asset_id).run();
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
          await bindings.DB.prepare(
            `UPDATE account_deletion_assets SET multipart_aborted_at = ?
              WHERE job_id = ? AND asset_id = ?`,
          ).bind(nowIso, jobId, asset.asset_id).run();
        }
        await bindings.MEDIA.delete([
          asset.object_key,
          `${prefix}thumbnail.jpg`,
        ]);
        await deletePrefixObjects(bindings, prefix);
        await bindings.DB.prepare(
          `UPDATE account_deletion_assets SET r2_cleaned_at = ?
            WHERE job_id = ? AND asset_id = ?`,
        ).bind(nowIso, jobId, asset.asset_id).run();
      }
    }

    const remaining = await bindings.DB.prepare(
      `SELECT 1 AS found
         FROM account_deletion_assets
        WHERE job_id = ?
          AND (soniox_cleaned_at IS NULL OR r2_cleaned_at IS NULL)
        LIMIT 1`,
    ).bind(jobId).first<{ found: number }>();
    if (remaining) {
      await returnJobToPending(bindings, jobId, now, claimed.attempt_count, null);
      return "pending";
    }

    await deletePrefixObjects(bindings, `users/${claimed.user_id}/`);
    await bindings.DB.batch([
      bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(claimed.user_id),
      bindings.DB.prepare(
        "DELETE FROM account_deletion_assets WHERE job_id = ?",
      ).bind(jobId),
      bindings.DB.prepare(
        `UPDATE account_deletion_jobs
            SET status = 'completed', user_id = id,
                apple_subject = 'deleted:' || id, authorization_code = NULL,
                revocation_token = NULL, revocation_token_type = NULL,
                last_error_code = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'`,
      ).bind(nowIso, nowIso, jobId),
    ]);
    return "completed";
  } catch (error) {
    const errorCode = error instanceof AccountDeletionError
      ? error.code
      : "external_cleanup_failed";
    await returnJobToPending(
      bindings,
      jobId,
      now,
      claimed.attempt_count,
      errorCode,
    );
    console.error(JSON.stringify({
      event: "account_deletion_retry_scheduled",
      jobId,
      errorCode,
    }));
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
