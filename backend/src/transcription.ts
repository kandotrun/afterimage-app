import {
  createTranscription,
  deleteSonioxResources,
  getTranscript,
  getTranscriptionStatus,
  uploadToSoniox,
} from "./soniox";
import { AI_CONSENT_VERSION, hasActiveAiConsent } from "./privacy";

interface TranscriptionPollRow {
  readonly id: string;
  readonly user_id: string;
  readonly object_key: string;
  readonly filename: string;
  readonly content_type: string;
  readonly transcription_status: string;
  readonly soniox_file_id: string | null;
  readonly soniox_transcription_id: string | null;
}

const TRANSCRIPTION_CLAIM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DIRECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const TRANSCRIPTION_GRANT_TTL_MS = 60 * 60 * 1000;

function directUploadMaxBytes(bindings: Env): number {
  const configured = Number(bindings.SONIOX_DIRECT_UPLOAD_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DIRECT_UPLOAD_MAX_BYTES;
}

function transcriptionGrantId(assetId: string): string {
  return `transcription:${assetId}`;
}

function transcriptionToken(): string {
  return [crypto.randomUUID(), crypto.randomUUID()]
    .map((value) => value.replaceAll("-", ""))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createTranscriptionMediaUrl(
  bindings: Env,
  asset: TranscriptionPollRow,
  now: Date,
  nowIso: string,
): Promise<{ readonly url: string; readonly tokenHash: string }> {
  const baseUrl = bindings.TRANSCRIPTION_MEDIA_BASE_URL;
  if (!baseUrl) throw new Error("TRANSCRIPTION_MEDIA_BASE_URL is not configured");
  const token = transcriptionToken();
  const url = new URL(`/v1/media/${token}`, baseUrl);
  if (url.protocol !== "https:") throw new Error("TRANSCRIPTION_MEDIA_BASE_URL must use HTTPS");
  const expiresAt = new Date(now.getTime() + TRANSCRIPTION_GRANT_TTL_MS).toISOString();
  const tokenHash = await sha256Hex(token);
  const granted = await bindings.DB.prepare(
    `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at)
      SELECT ?, a.id, a.user_id, ?, ?, ?
        FROM assets a
       WHERE a.id = ? AND a.user_id = ?
         AND a.deletion_requested_at IS NULL
         AND EXISTS (
           SELECT 1 FROM ai_consents consent
            WHERE consent.user_id = a.user_id AND consent.version = ?
              AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
         )
      ON CONFLICT(id) DO UPDATE SET
        asset_id = excluded.asset_id,
        user_id = excluded.user_id,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at`,
  ).bind(
    transcriptionGrantId(asset.id),
    tokenHash,
    expiresAt,
    nowIso,
    asset.id,
    asset.user_id,
    AI_CONSENT_VERSION,
  ).run();
  if ((granted.meta.changes ?? 0) !== 1) throw new Error("AI consent is no longer active");
  return { url: url.toString(), tokenHash };
}

async function deleteTranscriptionMediaGrant(
  bindings: Env,
  assetId: string,
  expectedTokenHash?: string,
): Promise<void> {
  try {
    if (expectedTokenHash) {
      await bindings.DB.prepare("DELETE FROM media_grants WHERE id = ? AND token_hash = ?")
        .bind(transcriptionGrantId(assetId), expectedTokenHash)
        .run();
    } else {
      await bindings.DB.prepare("DELETE FROM media_grants WHERE id = ?")
        .bind(transcriptionGrantId(assetId))
        .run();
    }
  } catch {
  }
}

async function acquireSonioxLease(
  bindings: Env,
  asset: TranscriptionPollRow,
  now: Date,
): Promise<string | null> {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + TRANSCRIPTION_CLAIM_TTL_MS).toISOString();
  const ownerToken = crypto.randomUUID();
  const acquired = await bindings.DB.prepare(
    `INSERT INTO soniox_work_leases (
      asset_id, user_id, owner_token, created_at, expires_at
    )
      SELECT a.id, a.user_id, ?, ?, ?
        FROM assets a
       WHERE a.id = ? AND a.user_id = ? AND a.deletion_requested_at IS NULL
         AND EXISTS (
           SELECT 1 FROM ai_consents consent
            WHERE consent.user_id = a.user_id AND consent.version = ?
              AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
         )
      ON CONFLICT(asset_id) DO UPDATE SET
        user_id = excluded.user_id,
        owner_token = excluded.owner_token,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
      WHERE soniox_work_leases.expires_at <= ?`,
  ).bind(
    ownerToken,
    nowIso,
    expiresAt,
    asset.id,
    asset.user_id,
    AI_CONSENT_VERSION,
    nowIso,
  ).run();
  return (acquired.meta.changes ?? 0) === 1 ? ownerToken : null;
}

export async function releaseSonioxLease(
  bindings: Env,
  assetId: string,
  ownerToken: string,
): Promise<void> {
  await bindings.DB.prepare(
    "DELETE FROM soniox_work_leases WHERE asset_id = ? AND owner_token = ?",
  ).bind(assetId, ownerToken).run();
}

interface SonioxCleanupOutboxRow {
  readonly id: string;
  readonly asset_id: string;
  readonly user_id: string;
  readonly owner_token: string;
  readonly soniox_file_id: string | null;
  readonly soniox_transcription_id: string | null;
  readonly attempt_count: number;
}

function sonioxCleanupRetryAt(now: Date, attemptCount: number): string {
  const exponent = Math.min(Math.max(attemptCount, 0), 10);
  return new Date(now.getTime() + Math.min(24 * 60 * 60 * 1_000, 60_000 * (2 ** exponent)))
    .toISOString();
}

async function recordSonioxCleanupAttempt(
  bindings: Env,
  asset: Pick<TranscriptionPollRow, "id" | "user_id">,
  ownerToken: string,
  transcriptionId: string | null,
  fileId: string | null,
  nowIso: string,
): Promise<void> {
  if (!transcriptionId && !fileId) return;
  const cleanupEligibleAt = new Date(
    new Date(nowIso).getTime() + TRANSCRIPTION_CLAIM_TTL_MS,
  ).toISOString();
  await bindings.DB.prepare(
    `INSERT INTO soniox_cleanup_outbox (
      id, asset_id, user_id, owner_token, soniox_file_id,
      soniox_transcription_id, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      soniox_file_id = COALESCE(excluded.soniox_file_id, soniox_cleanup_outbox.soniox_file_id),
      soniox_transcription_id = COALESCE(
        excluded.soniox_transcription_id,
        soniox_cleanup_outbox.soniox_transcription_id
      ),
      updated_at = excluded.updated_at`,
  ).bind(
    `soniox:${ownerToken}`,
    asset.id,
    asset.user_id,
    ownerToken,
    fileId,
    transcriptionId,
    cleanupEligibleAt,
    nowIso,
    nowIso,
  ).run();
}

async function cleanupProvisionalSoniox(
  bindings: Env,
  asset: Pick<TranscriptionPollRow, "id" | "user_id">,
  ownerToken: string,
  transcriptionId: string | null,
  fileId: string | null,
  now: Date,
): Promise<boolean> {
  if (!transcriptionId && !fileId) return true;
  const nowIso = now.toISOString();
  await recordSonioxCleanupAttempt(
    bindings,
    asset,
    ownerToken,
    transcriptionId,
    fileId,
    nowIso,
  );
  try {
    await deleteSonioxResources(bindings, transcriptionId, fileId);
    await bindings.DB.prepare(
      "DELETE FROM soniox_cleanup_outbox WHERE id = ? AND promoted_at IS NULL",
    ).bind(`soniox:${ownerToken}`).run();
    return true;
  } catch {
    await bindings.DB.prepare(
      `UPDATE soniox_cleanup_outbox
          SET attempt_count = MIN(attempt_count + 1, 100),
              next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND promoted_at IS NULL`,
    ).bind(
      sonioxCleanupRetryAt(now, 1),
      nowIso,
      `soniox:${ownerToken}`,
    ).run();
    console.error(JSON.stringify({
      event: "soniox_cleanup_retry_required",
      assetId: asset.id,
      durable: true,
    }));
    return false;
  }
}

async function promoteSonioxSubmission(
  bindings: Env,
  asset: TranscriptionPollRow,
  ownerToken: string,
  transcriptionId: string,
  fileId: string | null,
  nowIso: string,
  claimTimestamp: string,
): Promise<boolean> {
  const [finalized, promoted] = await bindings.DB.batch([
    bindings.DB.prepare(
      `UPDATE assets
          SET transcription_status = 'processing', soniox_file_id = ?,
              soniox_transcription_id = ?, transcription_updated_at = ?
        WHERE id = ? AND user_id = ? AND transcription_status = 'processing'
          AND deletion_requested_at IS NULL
          AND soniox_transcription_id IS NULL AND transcription_updated_at = ?
          AND EXISTS (
            SELECT 1 FROM ai_consents consent
             WHERE consent.user_id = assets.user_id AND consent.version = ?
               AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM soniox_work_leases lease
             WHERE lease.asset_id = assets.id AND lease.owner_token = ?
               AND lease.expires_at > ?
          )`,
    ).bind(
      fileId,
      transcriptionId,
      nowIso,
      asset.id,
      asset.user_id,
      claimTimestamp,
      AI_CONSENT_VERSION,
      ownerToken,
      nowIso,
    ),
    bindings.DB.prepare(
      `UPDATE soniox_cleanup_outbox
          SET promoted_at = ?, updated_at = ?
        WHERE id = ? AND promoted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM assets asset
             WHERE asset.id = soniox_cleanup_outbox.asset_id
               AND asset.user_id = soniox_cleanup_outbox.user_id
               AND asset.soniox_transcription_id = ?
               AND (asset.soniox_file_id = ? OR (asset.soniox_file_id IS NULL AND ? IS NULL))
          )
          AND EXISTS (
            SELECT 1 FROM soniox_work_leases lease
             WHERE lease.asset_id = soniox_cleanup_outbox.asset_id
               AND lease.owner_token = ? AND lease.expires_at > ?
          )`,
    ).bind(
      nowIso,
      nowIso,
      `soniox:${ownerToken}`,
      transcriptionId,
      fileId,
      fileId,
      ownerToken,
      nowIso,
    ),
  ]);
  return (finalized?.meta.changes ?? 0) === 1
    && (promoted?.meta.changes ?? 0) === 1;
}

async function cleanupCanonicalSoniox(
  bindings: Env,
  asset: Pick<TranscriptionPollRow, "id" | "user_id">,
  ownerToken: string,
  transcriptionId: string | null,
  fileId: string | null,
  nowIso: string,
): Promise<boolean> {
  try {
    await deleteSonioxResources(bindings, transcriptionId, fileId);
  } catch {
    return false;
  }
  await bindings.DB.batch([
    bindings.DB.prepare(
      `UPDATE assets
          SET soniox_file_id = CASE WHEN soniox_file_id = ? THEN NULL ELSE soniox_file_id END,
              soniox_transcription_id = CASE
                WHEN soniox_transcription_id = ? THEN NULL ELSE soniox_transcription_id
              END,
              transcription_updated_at = ?
        WHERE id = ? AND user_id = ?
          AND EXISTS (
            SELECT 1 FROM soniox_work_leases lease
             WHERE lease.asset_id = assets.id AND lease.owner_token = ?
          )`,
    ).bind(fileId, transcriptionId, nowIso, asset.id, asset.user_id, ownerToken),
    bindings.DB.prepare(
      `DELETE FROM soniox_cleanup_outbox
        WHERE asset_id = ? AND user_id = ? AND promoted_at IS NOT NULL
          AND (soniox_file_id = ? OR (soniox_file_id IS NULL AND ? IS NULL))
          AND (soniox_transcription_id = ?
            OR (soniox_transcription_id IS NULL AND ? IS NULL))`,
    ).bind(
      asset.id,
      asset.user_id,
      fileId,
      fileId,
      transcriptionId,
      transcriptionId,
    ),
  ]);
  return true;
}

export async function cleanupSonioxOutbox(
  bindings: Env,
  now = new Date(),
): Promise<{ processed: number }> {
  if (!bindings.SONIOX_API_KEY) return { processed: 0 };
  const nowIso = now.toISOString();
  const rows = await bindings.DB.prepare(
    `SELECT id, asset_id, user_id, owner_token, soniox_file_id,
            soniox_transcription_id, attempt_count
       FROM soniox_cleanup_outbox
      WHERE promoted_at IS NULL AND next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at LIMIT 100`,
  ).bind(nowIso).all<SonioxCleanupOutboxRow>();
  let processed = 0;
  for (const row of rows.results) {
    try {
      await deleteSonioxResources(
        bindings,
        row.soniox_transcription_id,
        row.soniox_file_id,
      );
      const deleted = await bindings.DB.prepare(
        "DELETE FROM soniox_cleanup_outbox WHERE id = ? AND promoted_at IS NULL",
      ).bind(row.id).run();
      processed += deleted.meta.changes ?? 0;
    } catch {
      await bindings.DB.prepare(
        `UPDATE soniox_cleanup_outbox
            SET attempt_count = MIN(attempt_count + 1, 100),
                next_attempt_at = ?, updated_at = ?
          WHERE id = ? AND promoted_at IS NULL`,
      ).bind(
        sonioxCleanupRetryAt(now, row.attempt_count + 1),
        nowIso,
        row.id,
      ).run();
    }
  }
  return { processed };
}

export async function pollTranscriptions(bindings: Env, now = new Date()) {
  if (!bindings.SONIOX_API_KEY) return { processed: 0 };
  await cleanupSonioxOutbox(bindings, now);
  const nowIso = now.toISOString();
  const expiredClaimIso = new Date(now.getTime() - TRANSCRIPTION_CLAIM_TTL_MS).toISOString();
  const pending = await bindings.DB.prepare(
    `SELECT id, user_id, object_key, filename, content_type,
            transcription_status, soniox_file_id, soniox_transcription_id
      FROM assets
      WHERE kind = 'video' AND status = 'ready'
        AND deletion_requested_at IS NULL
        AND EXISTS (
          SELECT 1 FROM ai_consents consent
           WHERE consent.user_id = assets.user_id AND consent.version = ?
             AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
        )
        AND (
          transcription_status = 'pending'
          OR (
            transcription_status = 'processing'
            AND (
              soniox_transcription_id IS NOT NULL
              OR transcription_updated_at IS NULL
              OR transcription_updated_at <= ?
            )
          )
        )
      ORDER BY transcription_updated_at ASC LIMIT 10`,
  ).bind(AI_CONSENT_VERSION, expiredClaimIso).all<TranscriptionPollRow>();

  let processed = 0;
  for (const asset of pending.results) {
    let provisionalFileId: string | null = null;
    let provisionalTranscriptionId: string | null = null;
    let mediaGrantTokenHash: string | null = null;
    let providerIDsCommitted = false;
    let leaseToken: string | null = null;
    try {
      if (!await hasActiveAiConsent(bindings, asset.user_id)) continue;
      const needsSubmission = asset.transcription_status === "pending"
        || !asset.soniox_transcription_id;
      if (needsSubmission) {
        const claim = await bindings.DB.prepare(
          `UPDATE assets
              SET transcription_status = 'processing', transcription_updated_at = ?
            WHERE id = ? AND soniox_transcription_id IS NULL
              AND deletion_requested_at IS NULL
              AND (
                transcription_status = 'pending'
                OR (
                  transcription_status = 'processing'
                  AND (
                    transcription_updated_at IS NULL
                    OR transcription_updated_at <= ?
                  )
                )
              )
              AND EXISTS (
                SELECT 1 FROM ai_consents consent
                 WHERE consent.user_id = assets.user_id AND consent.version = ?
                   AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
              )`,
        ).bind(nowIso, asset.id, expiredClaimIso, AI_CONSENT_VERSION).run();
        if (claim.meta.changes !== 1) continue;
      }

      leaseToken = await acquireSonioxLease(bindings, asset, now);
      if (!leaseToken) continue;

      if (needsSubmission) {
        const object = await bindings.MEDIA.get(asset.object_key);
        if (!object) {
          await bindings.DB.prepare(
            `UPDATE assets
                SET transcription_status = 'failed', transcript_error = 'media_not_found', transcription_updated_at = ?
              WHERE id = ? AND transcription_status = 'processing'
                AND deletion_requested_at IS NULL
                AND soniox_transcription_id IS NULL AND transcription_updated_at = ?
                AND EXISTS (
                  SELECT 1 FROM soniox_work_leases lease
                   WHERE lease.asset_id = assets.id AND lease.owner_token = ?
                     AND lease.expires_at > ?
                )`,
          ).bind(nowIso, asset.id, nowIso, leaseToken, nowIso).run();
          continue;
        }
        if (object.size > directUploadMaxBytes(bindings)) {
          const mediaGrant = await createTranscriptionMediaUrl(bindings, asset, now, nowIso);
          mediaGrantTokenHash = mediaGrant.tokenHash;
          provisionalTranscriptionId = await createTranscription(
            bindings,
            { audioUrl: mediaGrant.url },
          );
          await recordSonioxCleanupAttempt(
            bindings,
            asset,
            leaseToken,
            provisionalTranscriptionId,
            null,
            nowIso,
          );
        } else {
          provisionalFileId = await uploadToSoniox(bindings, {
            body: object.body,
            size: object.size,
            filename: asset.filename,
            contentType: asset.content_type,
          });
          await recordSonioxCleanupAttempt(
            bindings,
            asset,
            leaseToken,
            null,
            provisionalFileId,
            nowIso,
          );
          provisionalTranscriptionId = await createTranscription(
            bindings,
            { fileId: provisionalFileId },
          );
          await recordSonioxCleanupAttempt(
            bindings,
            asset,
            leaseToken,
            provisionalTranscriptionId,
            provisionalFileId,
            nowIso,
          );
        }
        if (!provisionalTranscriptionId) throw new Error("Soniox transcription ID is missing");
        const finalized = await promoteSonioxSubmission(
          bindings,
          asset,
          leaseToken,
          provisionalTranscriptionId,
          provisionalFileId,
          nowIso,
          nowIso,
        );
        if (!finalized) {
          await cleanupProvisionalSoniox(
            bindings,
            asset,
            leaseToken,
            provisionalTranscriptionId,
            provisionalFileId,
            now,
          );
          if (mediaGrantTokenHash) {
            await deleteTranscriptionMediaGrant(bindings, asset.id, mediaGrantTokenHash);
          }
          continue;
        }
        providerIDsCommitted = true;
        processed++;
      } else {
        const status = await getTranscriptionStatus(bindings, asset.soniox_transcription_id);
        switch (status.status) {
          case "completed": {
            const transcript = await getTranscript(bindings, asset.soniox_transcription_id);
            const saved = await bindings.DB.prepare(
              `UPDATE assets SET transcription_status = 'completed', transcript = ?, transcript_language = ?,
                transcript_error = NULL, transcription_updated_at = ?
                WHERE id = ? AND transcription_status = 'processing'
                  AND deletion_requested_at IS NULL
                  AND soniox_transcription_id = ?
                  AND EXISTS (
                    SELECT 1 FROM ai_consents consent
                     WHERE consent.user_id = assets.user_id AND consent.version = ?
                       AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM soniox_work_leases lease
                     WHERE lease.asset_id = assets.id AND lease.owner_token = ?
                       AND lease.expires_at > ?
                  )`,
            ).bind(
              transcript.text || "",
              transcript.language || null,
              nowIso,
              asset.id,
              asset.soniox_transcription_id,
              AI_CONSENT_VERSION,
              leaseToken,
              nowIso,
            ).run();
            if ((saved.meta.changes ?? 0) === 1) {
              await cleanupCanonicalSoniox(
                bindings,
                asset,
                leaseToken,
                asset.soniox_transcription_id,
                asset.soniox_file_id,
                nowIso,
              );
              await deleteTranscriptionMediaGrant(bindings, asset.id);
              processed++;
            }
            break;
          }
          case "error": {
            const failed = await bindings.DB.prepare(
              `UPDATE assets SET transcription_status = 'failed', transcript_error = ?, transcription_updated_at = ?
                WHERE id = ? AND transcription_status = 'processing'
                  AND deletion_requested_at IS NULL
                  AND soniox_transcription_id = ?
                  AND EXISTS (
                    SELECT 1 FROM ai_consents consent
                     WHERE consent.user_id = assets.user_id AND consent.version = ?
                       AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM soniox_work_leases lease
                     WHERE lease.asset_id = assets.id AND lease.owner_token = ?
                       AND lease.expires_at > ?
                  )`,
            ).bind(
              status.error_message || "soniox_error",
              nowIso,
              asset.id,
              asset.soniox_transcription_id,
              AI_CONSENT_VERSION,
              leaseToken,
              nowIso,
            ).run();
            if ((failed.meta.changes ?? 0) === 1) {
              await cleanupCanonicalSoniox(
                bindings,
                asset,
                leaseToken,
                asset.soniox_transcription_id,
                asset.soniox_file_id,
                nowIso,
              );
              await deleteTranscriptionMediaGrant(bindings, asset.id);
              processed++;
            }
            break;
          }
          case "queued":
          case "processing":
            break;
          default: {
            const unexpectedStatus: never = status.status;
            throw unexpectedStatus;
          }
        }
      }
    } catch (error) {
      if (!providerIDsCommitted && leaseToken
        && (provisionalTranscriptionId || provisionalFileId)) {
        try {
          await cleanupProvisionalSoniox(
            bindings,
            asset,
            leaseToken,
            provisionalTranscriptionId,
            provisionalFileId,
            now,
          );
        } catch {
          console.error(JSON.stringify({
            event: "soniox_cleanup_persistence_failed",
            assetId: asset.id,
          }));
        }
      }
      if (mediaGrantTokenHash) {
        await deleteTranscriptionMediaGrant(bindings, asset.id, mediaGrantTokenHash);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "transcription_poll_error",
        assetId: asset.id,
        message,
      }));
    } finally {
      if (leaseToken) {
        try {
          await releaseSonioxLease(bindings, asset.id, leaseToken);
        } catch {
        }
      }
    }
  }
  return { processed };
}
