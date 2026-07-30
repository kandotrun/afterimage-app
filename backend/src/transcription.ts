import {
  cleanupSoniox,
  createTranscription,
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
): Promise<string> {
  const baseUrl = bindings.TRANSCRIPTION_MEDIA_BASE_URL;
  if (!baseUrl) throw new Error("TRANSCRIPTION_MEDIA_BASE_URL is not configured");
  const token = transcriptionToken();
  const url = new URL(`/v1/media/${token}`, baseUrl);
  if (url.protocol !== "https:") throw new Error("TRANSCRIPTION_MEDIA_BASE_URL must use HTTPS");
  const expiresAt = new Date(now.getTime() + TRANSCRIPTION_GRANT_TTL_MS).toISOString();
  const granted = await bindings.DB.prepare(
    `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at)
      SELECT ?, a.id, a.user_id, ?, ?, ?
        FROM assets a
       WHERE a.id = ? AND a.user_id = ?
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
    await sha256Hex(token),
    expiresAt,
    nowIso,
    asset.id,
    asset.user_id,
    AI_CONSENT_VERSION,
  ).run();
  if ((granted.meta.changes ?? 0) !== 1) throw new Error("AI consent is no longer active");
  return url.toString();
}

async function deleteTranscriptionMediaGrant(bindings: Env, assetId: string): Promise<void> {
  try {
    await bindings.DB.prepare("DELETE FROM media_grants WHERE id = ?")
      .bind(transcriptionGrantId(assetId))
      .run();
  } catch {
  }
}

export async function pollTranscriptions(bindings: Env, now = new Date()) {
  if (!bindings.SONIOX_API_KEY) return { processed: 0 };
  const nowIso = now.toISOString();
  const expiredClaimIso = new Date(now.getTime() - TRANSCRIPTION_CLAIM_TTL_MS).toISOString();
  const pending = await bindings.DB.prepare(
    `SELECT id, user_id, object_key, filename, content_type,
            transcription_status, soniox_file_id, soniox_transcription_id
      FROM assets
      WHERE kind = 'video' AND status = 'ready'
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
    let mediaGrantCreated = false;
    let finalizationAttempted = false;
    try {
      if (!await hasActiveAiConsent(bindings, asset.user_id)) continue;
      if (asset.transcription_status === "pending" || !asset.soniox_transcription_id) {
        const claim = await bindings.DB.prepare(
          `UPDATE assets
              SET transcription_status = 'processing', transcription_updated_at = ?
            WHERE id = ? AND soniox_transcription_id IS NULL
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
        const object = await bindings.MEDIA.get(asset.object_key);
        if (!object) {
          await bindings.DB.prepare(
            `UPDATE assets
                SET transcription_status = 'failed', transcript_error = 'media_not_found', transcription_updated_at = ?
              WHERE id = ? AND transcription_status = 'processing'
                AND soniox_transcription_id IS NULL AND transcription_updated_at = ?`,
          ).bind(nowIso, asset.id, nowIso).run();
          continue;
        }
        if (object.size > directUploadMaxBytes(bindings)
          && bindings.TRANSCRIPTION_MEDIA_BASE_URL) {
          const audioUrl = await createTranscriptionMediaUrl(bindings, asset, now, nowIso);
          mediaGrantCreated = true;
          provisionalTranscriptionId = await createTranscription(bindings, { audioUrl });
        } else {
          provisionalFileId = await uploadToSoniox(bindings, {
            body: object.body,
            size: object.size,
            filename: asset.filename,
            contentType: asset.content_type,
          });
          provisionalTranscriptionId = await createTranscription(
            bindings,
            { fileId: provisionalFileId },
          );
        }
        finalizationAttempted = true;
        const finalized = await bindings.DB.prepare(
          `UPDATE assets SET transcription_status = 'processing', soniox_file_id = ?, soniox_transcription_id = ?, transcription_updated_at = ?
            WHERE id = ? AND transcription_status = 'processing'
              AND soniox_transcription_id IS NULL AND transcription_updated_at = ?
              AND EXISTS (
                SELECT 1 FROM ai_consents consent
                 WHERE consent.user_id = assets.user_id AND consent.version = ?
                   AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
              )`,
        ).bind(
          provisionalFileId,
          provisionalTranscriptionId,
          nowIso,
          asset.id,
          nowIso,
          AI_CONSENT_VERSION,
        ).run();
        if (finalized.meta.changes !== 1) {
          await cleanupSoniox(bindings, provisionalTranscriptionId, provisionalFileId);
          if (mediaGrantCreated) await deleteTranscriptionMediaGrant(bindings, asset.id);
          continue;
        }
        processed++;
      } else {
        if (!await hasActiveAiConsent(bindings, asset.user_id)) continue;
        const status = await getTranscriptionStatus(bindings, asset.soniox_transcription_id);
        switch (status.status) {
          case "completed": {
            const transcript = await getTranscript(bindings, asset.soniox_transcription_id);
            const saved = await bindings.DB.prepare(
              `UPDATE assets SET transcription_status = 'completed', transcript = ?, transcript_language = ?,
                transcript_error = NULL, transcription_updated_at = ?
                WHERE id = ? AND transcription_status = 'processing'
                  AND EXISTS (
                    SELECT 1 FROM ai_consents consent
                     WHERE consent.user_id = assets.user_id AND consent.version = ?
                       AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
                  )`,
            ).bind(
              transcript.text || "",
              transcript.language || null,
              nowIso,
              asset.id,
              AI_CONSENT_VERSION,
            ).run();
            await cleanupSoniox(bindings, asset.soniox_transcription_id, asset.soniox_file_id);
            await deleteTranscriptionMediaGrant(bindings, asset.id);
            if ((saved.meta.changes ?? 0) === 1) processed++;
            break;
          }
          case "error": {
            const failed = await bindings.DB.prepare(
              `UPDATE assets SET transcription_status = 'failed', transcript_error = ?, transcription_updated_at = ?
                WHERE id = ? AND transcription_status = 'processing'
                  AND EXISTS (
                    SELECT 1 FROM ai_consents consent
                     WHERE consent.user_id = assets.user_id AND consent.version = ?
                       AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
                  )`,
            ).bind(
              status.error_message || "soniox_error",
              nowIso,
              asset.id,
              AI_CONSENT_VERSION,
            ).run();
            await cleanupSoniox(bindings, asset.soniox_transcription_id, asset.soniox_file_id);
            await deleteTranscriptionMediaGrant(bindings, asset.id);
            if ((failed.meta.changes ?? 0) === 1) processed++;
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
      if (!finalizationAttempted && (provisionalTranscriptionId || provisionalFileId)) {
        await cleanupSoniox(bindings, provisionalTranscriptionId, provisionalFileId);
      }
      if (!finalizationAttempted && mediaGrantCreated) {
        await deleteTranscriptionMediaGrant(bindings, asset.id);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "transcription_poll_error",
        assetId: asset.id,
        message,
      }));
    }
  }
  return { processed };
}
