import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  createAccountDeletionIntent,
  defaultAccountDeletionDependencies,
  findAccountDeletionByReceipt,
  processAccountDeletionJob,
  type AccountDeletionDependencies,
} from "./account-deletion";
import {
  verifyAppleIdentityToken as verifyAppleIdentityTokenAgainstApple,
  type AppleIdentity,
} from "./apple";
import { legalPageResponse } from "./legal";
import { handleMcpRequest } from "./mcp";
import { createGpuJobRoutes } from "./gpu-jobs";
import {
  AI_CONSENT_VERSION,
  aiConsentJson,
  findAiConsent,
  hasActiveAiConsent,
} from "./privacy";
import {
  configuredDailySummaryModel,
  DAILY_SUMMARY_MAX_CHARACTERS,
  generateDailySummary as generateQwenDailySummary,
  type DailyMemorySource,
  type GeneratedDailySummary,
} from "./qwen-summary";
import { registerDailyWeatherRoutes } from "./weather";

export type { AppleIdentity } from "./apple";
export { pollTranscriptions } from "./transcription";

type VerifyAppleIdentityToken = (
  identityToken: string,
  audience: string,
  expectedNonce: string,
) => Promise<AppleIdentity>;

type GenerateDailySummary = (
  bindings: Env,
  sources: DailyMemorySource[],
) => Promise<GeneratedDailySummary>;

interface AppDependencies {
  verifyAppleIdentityToken: VerifyAppleIdentityToken;
  generateDailySummary: GenerateDailySummary;
  accountDeletion: AccountDeletionDependencies;
  now: () => Date;
}

interface AuthContext {
  sessionId: string;
  userId: string;
  appleSubject: string;
  email: string | null;
  displayName: string | null;
}

export type AppEnvironment = {
  Bindings: Env;
  Variables: {
    auth: AuthContext;
  };
};

interface UserRow {
  id: string;
  apple_subject: string;
  email: string | null;
  display_name: string | null;
}

interface SessionUserRow extends UserRow {
  session_id: string;
}

interface AssetRow {
  id: string;
  user_id: string;
  kind: "photo" | "video";
  filename: string;
  content_type: string;
  byte_size: number;
  captured_at: string;
  latitude: number | null;
  longitude: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  status: "uploading" | "ready" | "failed";
  object_key: string;
  thumbnail_key: string | null;
  upload_mode: "single" | "multipart";
  upload_id: string | null;
  part_size: number | null;
  created_at: string;
  updated_at: string;
  transcription_status: "pending" | "processing" | "completed" | "failed" | "skipped" | null;
  soniox_file_id: string | null;
  soniox_transcription_id: string | null;
  transcript: string | null;
  transcript_language: string | null;
  transcript_error: string | null;
  transcription_updated_at: string | null;
  agent_access_enabled: 0 | 1;
  video_analysis_status?: "queued" | "processing" | "completed" | "failed" | null;
}

interface MediaBodyRow {
  filename: string;
  content_type: string;
  byte_size: number;
  object_key: string;
}

interface DailySummaryCacheRow {
  source_digest: string;
  source_transcript_count: number;
  source_visual_analysis_count: number;
  summary: string;
  model: string;
  generated_at: string;
}

interface DailySummaryMemoryRow {
  id: string;
  captured_at: string;
  transcript: string | null;
  transcription_updated_at: string | null;
  visual_summary: string | null;
  visual_updated_at: string | null;
  visual_model_id: string | null;
  visual_model_revision: string | null;
  visual_backend: "frames" | "codec" | null;
  visual_coverage_mode: "full" | "sampled" | null;
}

interface DailySummaryBoundsRow {
  source_count: number;
  source_transcript_count: number;
  source_visual_analysis_count: number;
  source_rows: number;
  source_characters: number;
}

interface DailySummaryVisualSegmentRow extends VideoAnalysisSegmentRow {
  analysis_asset_id: string;
}

interface MemorySearchRow extends AssetRow {
  visual_summary: string | null;
  matched_segment_position: number | null;
  matched_segment_start_ms: number | null;
  matched_segment_end_ms: number | null;
  matched_segment_caption: string | null;
}

interface VideoAnalysisRow {
  model_id: string;
  model_revision: string;
  backend: "frames" | "codec";
  coverage_mode: "full" | "sampled";
  summary: string;
  updated_at: string;
}

interface VideoAnalysisRangeRow {
  position: number;
  start_ms: number;
  end_ms: number;
}

interface VideoAnalysisSegmentRow extends VideoAnalysisRangeRow {
  caption: string;
}

interface UploadPartRow {
  part_number: number;
  etag: string;
}

interface CleanupAssetRow {
  id: string;
  user_id: string;
  object_key: string;
  thumbnail_key: string | null;
  upload_mode: "single" | "multipart";
  upload_id: string | null;
  status: "uploading" | "failed";
}

interface CleanupDerivativeRow {
  id: string;
  job_id: string;
  object_key: string | null;
}

interface McpTokenRow {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

const appleAuthSchema = z.object({
  challengeId: z.string().uuid(),
  identityToken: z.string().min(10).max(16_384),
  displayName: z.string().trim().min(1).max(100).optional(),
}).strict();

const aiConsentSchema = z.object({
  version: z.literal(AI_CONSENT_VERSION),
  consented: z.boolean(),
}).strict();

const accountDeletionSchema = z.object({
  authorizationCode: z.string().min(10).max(2_048),
}).strict();

const mcpTokenSchema = z.object({
  name: z.string().trim().min(1).max(48),
});

const agentAccessSchema = z.object({
  enabled: z.boolean(),
}).strict();

const memorySearchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const contentTypes = [
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
] as const;

const sourceFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const dailyPlaybackQuerySchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
});

const MAX_DAILY_PLAYBACK_SPAN_MS = 48 * 60 * 60 * 1_000;
const MAX_DAILY_PLAYBACK_CLIPS = 200;
const MAX_DAILY_PLAYBACK_TRANSCRIPT_CHARS = 500_000;
const MAX_DAILY_SUMMARY_SOURCES = 200;
const MAX_DAILY_SUMMARY_SOURCE_ROWS = 1_000;
const MAX_DAILY_SUMMARY_SOURCE_CHARACTERS = 200_000;
const MIN_DAILY_SUMMARY_RANGE_MS = 22 * 60 * 60 * 1_000;
const MAX_DAILY_SUMMARY_RANGE_MS = 26 * 60 * 60 * 1_000;
const APPLE_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const APPLE_CHALLENGE_RATE_WINDOW_MS = 60 * 1_000;
const APPLE_CHALLENGE_RATE_LIMIT = 10;
const ASSET_CREATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ASSET_CREATION_LIMIT = 10;
const ACTIVE_STORAGE_QUOTA_BYTES = 30 * 1024 * 1024 * 1024;
const ACTIVE_GPU_JOB_LIMIT = 4;
const ACTIVE_EXTERNAL_AI_WORK_LIMIT = 4;
const EXTERNAL_AI_WORK_LEASE_MS = 2 * 60 * 1_000;
const COMPLETED_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const existingAssetsSchema = z.object({
  items: z.array(z.object({
    sourceFingerprint: sourceFingerprintSchema,
    filename: z.string().trim().min(1).max(255).refine(
      (value) => value !== "." && value !== ".." && !/[\/\\\0]/.test(value),
      "unsafe filename",
    ),
  })).min(1).max(12),
}).superRefine((value, context) => {
  const fingerprints = value.items.map((item) => item.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "duplicate source fingerprints" });
  }
});

const assetSchema = z.object({
  kind: z.enum(["photo", "video"]),
  sourceFingerprint: sourceFingerprintSchema.optional(),
  filename: z.string().trim().min(1).max(255).refine(
    (value) => value !== "." && value !== ".." && !/[\/\\\0]/.test(value),
    "unsafe filename",
  ),
  contentType: z.enum(contentTypes),
  byteSize: z.number().int().positive().max(50 * 1024 * 1024 * 1024),
  capturedAt: z.string().datetime({ offset: true }),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }).optional(),
  durationMs: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1000).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
}).superRefine((value, context) => {
  const expectedPrefix = value.kind === "photo" ? "image/" : "video/";
  if (!value.contentType.startsWith(expectedPrefix)) {
    context.addIssue({ code: "custom", path: ["contentType"], message: "kind and contentType differ" });
  }
});

function errorResponse(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return context.json({ error: { code, message } }, status);
}

async function parseJson(context: Context<AppEnvironment>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

function integerBinding(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trustedClientIp(context: Context<AppEnvironment>): string | null {
  const value = context.req.header("cf-connecting-ip")?.trim();
  if (value && /^[0-9a-f:.]{2,64}$/i.test(value)) return value;
  return String(context.env.ENVIRONMENT) === "production" ? null : "development";
}

function userJson(user: UserRow) {
  return {
    id: user.id,
    appleSubject: user.apple_subject,
    email: user.email,
    displayName: user.display_name,
  };
}

function mcpTokenJson(token: McpTokenRow) {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.created_at,
    expiresAt: token.expires_at,
    lastUsedAt: token.last_used_at,
  };
}

function ownerVideoAnalysisStatusSql(assetAlias = "assets"): string {
  return `CASE
    WHEN ${assetAlias}.kind <> 'video' OR ${assetAlias}.agent_access_enabled = 0 THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM video_analyses va WHERE va.asset_id = ${assetAlias}.id
    ) THEN 'completed'
    WHEN EXISTS (
      SELECT 1 FROM gpu_jobs j
       WHERE j.asset_id = ${assetAlias}.id AND j.kind = 'analysis' AND j.status = 'leased'
    ) THEN 'processing'
    WHEN EXISTS (
      SELECT 1 FROM gpu_jobs j
       WHERE j.asset_id = ${assetAlias}.id AND j.kind = 'analysis' AND j.status = 'queued'
    ) THEN 'queued'
    WHEN EXISTS (
      SELECT 1 FROM gpu_jobs j
       WHERE j.asset_id = ${assetAlias}.id AND j.kind = 'analysis' AND j.status = 'failed'
    ) THEN 'failed'
    ELSE NULL
  END AS video_analysis_status`;
}

function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function searchExcerpt(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) return normalized;
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return `${normalized.slice(0, 239)}…`;
  const start = Math.max(0, index - 80);
  const end = Math.min(normalized.length, start + 240);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function setPrivateResponseHeaders(context: Context<AppEnvironment>): void {
  context.header("Cache-Control", "private, no-store");
  context.header("Pragma", "no-cache");
  context.header("Vary", "Authorization");
}

function assetJson(asset: AssetRow) {
  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    contentType: asset.content_type,
    byteSize: asset.byte_size,
    capturedAt: asset.captured_at,
    location: asset.latitude !== null && asset.longitude !== null
      ? { latitude: asset.latitude, longitude: asset.longitude }
      : null,
    durationMs: asset.duration_ms,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    contentUrl: asset.status === "ready" ? `/v1/assets/${asset.id}/content` : null,
    thumbnailUrl: asset.thumbnail_key ? `/v1/assets/${asset.id}/thumbnail` : null,
    transcriptionStatus: asset.transcription_status ?? null,
    transcriptPreview: asset.transcription_status === "completed" && asset.transcript
      ? asset.transcript.slice(0, 240)
      : null,
    transcriptUrl: asset.transcription_status === "completed" ? `/v1/assets/${asset.id}/transcript` : null,
    agentAccessEnabled: asset.agent_access_enabled === 1,
    videoAnalysisStatus: asset.video_analysis_status ?? null,
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  };
}

async function findOwnedAsset(bindings: Env, assetId: string, userId: string): Promise<AssetRow | null> {
  return bindings.DB.prepare(
    `SELECT id, user_id, kind, filename, content_type, byte_size, captured_at,
            latitude, longitude, duration_ms, width, height, status, object_key, thumbnail_key,
            upload_mode, upload_id, part_size, created_at, updated_at,
            transcription_status, soniox_file_id, soniox_transcription_id,
            transcript, transcript_language, transcript_error, transcription_updated_at,
            agent_access_enabled, ${ownerVideoAnalysisStatusSql()}
       FROM assets WHERE id = ? AND user_id = ?`,
  ).bind(assetId, userId).first<AssetRow>();
}

type VideoAnalysisQueueResult =
  | "queued"
  | "already_queued"
  | "analysis_queue_limit"
  | "external_ai_work_limit"
  | "not_eligible";

async function activeAiWorkCounts(bindings: Env, userId: string, now: Date) {
  const row = await bindings.DB.prepare(
    `SELECT
       (
         SELECT COUNT(*)
           FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
          WHERE a.user_id = ? AND j.status IN ('queued', 'leased')
       ) AS gpu_count,
       (
         SELECT COUNT(*)
           FROM assets a
          WHERE a.user_id = ? AND a.transcription_status IN ('pending', 'processing')
       ) AS transcription_count,
       (
         SELECT COUNT(*)
           FROM external_ai_work_leases lease
          WHERE lease.user_id = ? AND lease.expires_at > ?
       ) AS lease_count`,
  ).bind(userId, userId, userId, now.toISOString()).first<{
    gpu_count: number;
    transcription_count: number;
    lease_count: number;
  }>();
  return {
    gpu: Number(row?.gpu_count ?? 0),
    external: Number(row?.gpu_count ?? 0)
      + Number(row?.transcription_count ?? 0)
      + Number(row?.lease_count ?? 0),
  };
}

async function acquireExternalAiWorkLease(
  bindings: Env,
  userId: string,
  now: Date,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + EXTERNAL_AI_WORK_LEASE_MS).toISOString();
  await bindings.DB.prepare(
    `DELETE FROM external_ai_work_leases
      WHERE id IN (
        SELECT id FROM external_ai_work_leases
         WHERE expires_at <= ?
         ORDER BY expires_at ASC LIMIT 10000
      )`,
  ).bind(nowIso).run();
  const inserted = await bindings.DB.prepare(
    `INSERT INTO external_ai_work_leases (id, user_id, kind, created_at, expires_at)
     SELECT ?, ?, 'qwen_summary', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ai_consents consent
         WHERE consent.user_id = ? AND consent.version = ?
           AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
      )
        AND (
          (
            SELECT COUNT(*)
              FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
             WHERE a.user_id = ? AND j.status IN ('queued', 'leased')
          )
          +
          (
            SELECT COUNT(*)
              FROM assets a
             WHERE a.user_id = ? AND a.transcription_status IN ('pending', 'processing')
          )
          +
          (
            SELECT COUNT(*)
              FROM external_ai_work_leases lease
             WHERE lease.user_id = ? AND lease.expires_at > ?
          )
        ) < ?`,
  ).bind(
    id,
    userId,
    nowIso,
    expiresAt,
    userId,
    AI_CONSENT_VERSION,
    userId,
    userId,
    userId,
    nowIso,
    ACTIVE_EXTERNAL_AI_WORK_LIMIT,
  ).run();
  return (inserted.meta.changes ?? 0) === 1 ? id : null;
}

async function queueVideoAnalysis(
  bindings: Env,
  assetId: string,
  userId: string,
  now: Date,
): Promise<VideoAnalysisQueueResult> {
  const nowIso = now.toISOString();
  const queued = await bindings.DB.prepare(
    `INSERT INTO gpu_jobs (
      id, asset_id, kind, status, request_json, priority, attempt_count,
      available_at, created_at, updated_at
    )
    SELECT ?, a.id, 'analysis', 'queued', '{}', 0, 0, ?, ?, ?
      FROM assets a
     WHERE a.id = ? AND a.user_id = ?
       AND a.kind = 'video' AND a.status = 'ready' AND a.agent_access_enabled = 1
       AND EXISTS (
         SELECT 1 FROM ai_consents consent
          WHERE consent.user_id = a.user_id AND consent.version = ?
            AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM gpu_jobs
          WHERE asset_id = a.id AND kind = 'analysis' AND status IN ('queued', 'leased')
       )
       AND (
         SELECT COUNT(*)
           FROM gpu_jobs active_job
           JOIN assets active_asset ON active_asset.id = active_job.asset_id
          WHERE active_asset.user_id = a.user_id
            AND active_job.status IN ('queued', 'leased')
       ) < ?
       AND (
         (
           SELECT COUNT(*)
             FROM gpu_jobs active_job
             JOIN assets active_asset ON active_asset.id = active_job.asset_id
            WHERE active_asset.user_id = a.user_id
              AND active_job.status IN ('queued', 'leased')
         )
         +
         (
           SELECT COUNT(*)
             FROM assets active_transcription
            WHERE active_transcription.user_id = a.user_id
              AND active_transcription.transcription_status IN ('pending', 'processing')
         )
         +
         (
           SELECT COUNT(*)
             FROM external_ai_work_leases lease
            WHERE lease.user_id = a.user_id AND lease.expires_at > ?
         )
       ) < ?`,
  ).bind(
    crypto.randomUUID(),
    nowIso,
    nowIso,
    nowIso,
    assetId,
    userId,
    AI_CONSENT_VERSION,
    ACTIVE_GPU_JOB_LIMIT,
    nowIso,
    ACTIVE_EXTERNAL_AI_WORK_LIMIT,
  ).run();
  if ((queued.meta.changes ?? 0) === 1) return "queued";
  const existing = await bindings.DB.prepare(
    `SELECT 1 AS found
       FROM assets a
      WHERE a.id = ? AND a.user_id = ?
        AND (
          EXISTS (
            SELECT 1 FROM gpu_jobs
             WHERE asset_id = a.id AND kind = 'analysis' AND status IN ('queued', 'leased')
          )
          OR EXISTS (
            SELECT 1 FROM video_analyses WHERE asset_id = a.id
          )
        )`,
  ).bind(assetId, userId).first<{ found: number }>();
  if (existing) return "already_queued";
  const counts = await activeAiWorkCounts(bindings, userId, now);
  if (counts.gpu >= ACTIVE_GPU_JOB_LIMIT) return "analysis_queue_limit";
  if (counts.external >= ACTIVE_EXTERNAL_AI_WORK_LIMIT) return "external_ai_work_limit";
  return "not_eligible";
}

function parseRangeHeader(value: string | undefined, size: number): { offset: number; length: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd)
    || offset < 0 || offset >= size || requestedEnd < offset) return "invalid";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

async function serveAssetBody(context: Context<AppEnvironment>, asset: MediaBodyRow) {
  const range = parseRangeHeader(context.req.header("range"), asset.byte_size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${asset.byte_size}` },
    });
  }
  const object = await context.env.MEDIA.get(asset.object_key, range ? { range } : undefined);
  if (!object) return errorResponse(context, 404, "asset_not_found", "Asset body was not found.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", asset.content_type);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.byte_size}`);
  } else {
    headers.set("content-length", String(asset.byte_size));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function encodeCursor(asset: AssetRow): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([asset.captured_at, asset.id])));
}

function decodeCursor(value: string | undefined): [string, string] | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    return [parsed[0], parsed[1]];
  } catch {
    return null;
  }
}

async function renewAssetStatus(
  bindings: Env,
  assetId: string,
  userId: string,
  status: "uploading" | "ready",
  now: Date,
): Promise<boolean> {
  const result = await bindings.DB.prepare(
    "UPDATE assets SET updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
  ).bind(now.toISOString(), assetId, userId, status).run();
  return (result.meta.changes ?? 0) === 1;
}

const SINGLE_UPLOAD_LEASE_TTL_MS = 15 * 60 * 1000;

async function claimSingleUploadLease(
  bindings: Env,
  assetId: string,
  userId: string,
  lease: string,
  now: Date,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - SINGLE_UPLOAD_LEASE_TTL_MS).toISOString();
  const result = await bindings.DB.prepare(
    `UPDATE assets SET upload_lease = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_mode = 'single'
        AND (upload_lease IS NULL OR updated_at <= ?)`,
  ).bind(lease, now.toISOString(), assetId, userId, staleBefore).run();
  return (result.meta.changes ?? 0) === 1;
}

async function releaseSingleUploadLease(
  bindings: Env,
  assetId: string,
  userId: string,
  lease: string,
  now: Date,
): Promise<void> {
  await bindings.DB.prepare(
    `UPDATE assets SET upload_lease = NULL, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_lease = ?`,
  ).bind(now.toISOString(), assetId, userId, lease).run();
}

function assetObjectPrefix(userId: string, assetId: string): string {
  return `users/${userId}/assets/${assetId}/`;
}

async function deleteAssetPrefixObjects(
  bindings: Env,
  userId: string,
  assetId: string,
  keepKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  const prefix = assetObjectPrefix(userId, assetId);
  let cursor: string | undefined;
  do {
    const options: R2ListOptions = cursor
      ? { prefix, cursor, limit: 1_000 }
      : { prefix, limit: 1_000 };
    const listed = await bindings.MEDIA.list(options);
    const keys = listed.objects.map((object) => object.key).filter((key) => !keepKeys.has(key));
    if (keys.length > 0) await bindings.MEDIA.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function authMiddleware(now: () => Date): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = authorization ? /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization) : null;
    if (!match?.[1]) return errorResponse(context, 401, "unauthorized", "A valid bearer session is required.");
    const tokenHash = await sha256Hex(match[1]);
    const row = await context.env.DB.prepare(
      `SELECT s.id AS session_id, u.id, u.apple_subject, u.email, u.display_name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_jobs deletion
             WHERE deletion.user_id = u.id AND deletion.status IN ('pending', 'processing')
          )`,
    ).bind(tokenHash, now().toISOString()).first<SessionUserRow>();
    if (!row) return errorResponse(context, 401, "unauthorized", "The bearer session is invalid or expired.");
    context.set("auth", {
      sessionId: row.session_id,
      userId: row.id,
      appleSubject: row.apple_subject,
      email: row.email,
      displayName: row.display_name,
    });
    await next();
  };
}

export async function cleanupExpiredState(bindings: Env, now = new Date()) {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const completedDeletionBefore = new Date(
    now.getTime() - COMPLETED_DELETION_RETENTION_MS,
  ).toISOString();
  const [
    expiredSessions,
    expiredGrants,
    expiredChallenges,
    expiredAssetLedger,
    expiredExternalAiLeases,
    expiredDeletionJobs,
  ] = await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso),
    bindings.DB.prepare("DELETE FROM media_grants WHERE expires_at <= ?").bind(nowIso),
    bindings.DB.prepare(
      `DELETE FROM apple_auth_challenges
        WHERE id IN (
          SELECT id FROM apple_auth_challenges
           WHERE expires_at <= ?
           ORDER BY expires_at ASC LIMIT 10000
        )`,
    ).bind(nowIso),
    bindings.DB.prepare(
      `DELETE FROM asset_creation_ledger
        WHERE id IN (
          SELECT id FROM asset_creation_ledger
           WHERE created_at <= ?
           ORDER BY created_at ASC LIMIT 10000
        )`,
    ).bind(staleBefore),
    bindings.DB.prepare(
      `DELETE FROM external_ai_work_leases
        WHERE id IN (
          SELECT id FROM external_ai_work_leases
           WHERE expires_at <= ?
           ORDER BY expires_at ASC LIMIT 10000
        )`,
    ).bind(nowIso),
    bindings.DB.prepare(
      `DELETE FROM account_deletion_jobs
        WHERE id IN (
          SELECT id FROM account_deletion_jobs
           WHERE status = 'completed' AND completed_at <= ?
           ORDER BY completed_at ASC LIMIT 10000
        )`,
    ).bind(completedDeletionBefore),
  ]);
  const derivatives = await bindings.DB.prepare(
    `SELECT id, job_id, object_key
       FROM media_derivatives
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, id ASC LIMIT 100`,
  ).bind(nowIso).all<CleanupDerivativeRow>();
  let expiredDerivatives = 0;
  for (const derivative of derivatives.results) {
    if (derivative.object_key) await bindings.MEDIA.delete(derivative.object_key);
    const [deleted] = await bindings.DB.batch([
      bindings.DB.prepare(
        "DELETE FROM media_derivatives WHERE id = ? AND expires_at <= ?",
      ).bind(derivative.id, nowIso),
      bindings.DB.prepare("DELETE FROM gpu_jobs WHERE id = ?").bind(derivative.job_id),
    ]);
    expiredDerivatives += deleted?.meta.changes ?? 0;
  }
  const candidates = await bindings.DB.prepare(
    `SELECT id, user_id, object_key, thumbnail_key, upload_mode, upload_id, status
       FROM assets
      WHERE status IN ('uploading', 'failed') AND updated_at <= ?
      ORDER BY updated_at ASC, id ASC LIMIT 100`,
  ).bind(staleBefore).all<CleanupAssetRow>();

  let quarantinedAssets = 0;
  let abandonedAssets = 0;
  for (const asset of candidates.results) {
    if (asset.status === "uploading") {
      const quarantined = await bindings.DB.prepare(
        `UPDATE assets SET status = 'failed', updated_at = ?
          WHERE id = ? AND status = 'uploading' AND updated_at <= ?`,
      ).bind(nowIso, asset.id, staleBefore).run();
      quarantinedAssets += quarantined.meta.changes ?? 0;
      continue;
    }

    if (asset.upload_mode === "multipart" && asset.upload_id) {
      try {
        await bindings.MEDIA.resumeMultipartUpload(asset.object_key, asset.upload_id).abort();
      } catch {
        // R2 may already have expired or aborted the multipart upload.
      }
    }
    const thumbnailKey = `${assetObjectPrefix(asset.user_id, asset.id)}thumbnail.jpg`;
    await bindings.MEDIA.delete([asset.object_key, thumbnailKey]);
    await deleteAssetPrefixObjects(bindings, asset.user_id, asset.id);
    const deleted = await bindings.DB.prepare(
      "DELETE FROM assets WHERE id = ? AND status = 'failed'",
    ).bind(asset.id).run();
    abandonedAssets += deleted.meta.changes ?? 0;
  }

  return {
    expiredSessions: expiredSessions?.meta.changes ?? 0,
    expiredGrants: expiredGrants?.meta.changes ?? 0,
    expiredChallenges: expiredChallenges?.meta.changes ?? 0,
    expiredAssetLedger: expiredAssetLedger?.meta.changes ?? 0,
    expiredExternalAiLeases: expiredExternalAiLeases?.meta.changes ?? 0,
    expiredDeletionJobs: expiredDeletionJobs?.meta.changes ?? 0,
    expiredDerivatives,
    quarantinedAssets,
    abandonedAssets,
  };
}

export function createApp(overrides: Partial<AppDependencies> = {}) {
  const dependencies: AppDependencies = {
    verifyAppleIdentityToken: overrides.verifyAppleIdentityToken ?? verifyAppleIdentityTokenAgainstApple,
    generateDailySummary: overrides.generateDailySummary ?? generateQwenDailySummary,
    accountDeletion: overrides.accountDeletion ?? defaultAccountDeletionDependencies,
    now: overrides.now ?? (() => new Date()),
  };
  const app = new Hono<AppEnvironment>();

  app.get("/health", (context) => context.json({ ok: true, service: "afterimage-api", version: 1 }));
  app.get("/privacy", () => legalPageResponse("privacy"));
  app.get("/support", () => legalPageResponse("support"));
  app.get("/terms", () => legalPageResponse("terms"));

  app.get("/v1/auth/apple/challenge", async (context) => {
    const clientIp = trustedClientIp(context);
    if (!clientIp) {
      return errorResponse(
        context,
        503,
        "trusted_client_ip_required",
        "A trusted Cloudflare client address is required.",
      );
    }
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const rateWindowStart = new Date(now.getTime() - APPLE_CHALLENGE_RATE_WINDOW_MS).toISOString();
    const expiresAt = new Date(now.getTime() + APPLE_CHALLENGE_TTL_MS).toISOString();
    const challengeId = crypto.randomUUID();
    const nonce = randomToken();
    const clientIpHash = await sha256Hex(clientIp);
    await context.env.DB.prepare(
      `DELETE FROM apple_auth_challenges
        WHERE id IN (
          SELECT id FROM apple_auth_challenges
           WHERE expires_at <= ?
           ORDER BY expires_at ASC LIMIT 10000
        )`,
    ).bind(nowIso).run();
    const inserted = await context.env.DB.prepare(
      `INSERT INTO apple_auth_challenges (
        id, nonce, client_ip_hash, created_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM apple_auth_challenges
          WHERE client_ip_hash = ? AND created_at > ?
       ) < ?`,
    ).bind(
      challengeId,
      nonce,
      clientIpHash,
      nowIso,
      expiresAt,
      clientIpHash,
      rateWindowStart,
      APPLE_CHALLENGE_RATE_LIMIT,
    ).run();
    context.header("Cache-Control", "no-store, max-age=0");
    context.header("Pragma", "no-cache");
    if ((inserted.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        429,
        "apple_challenge_rate_limited",
        "Too many Apple authentication challenges were requested.",
      );
    }
    return context.json({ challengeId, nonce, expiresAt });
  });

  app.get("/.well-known/mcp.json", (context) => context.json({
    mcpServers: {
      afterimage: {
        url: new URL("/mcp", context.req.url).toString(),
        transport: "streamable-http",
        authentication: "Bearer personal access token",
      },
    },
  }));

  app.all("/mcp", (context) => handleMcpRequest(
    context.req.raw,
    context.env,
    dependencies.now(),
  ));

  app.post("/v1/auth/apple", async (context) => {
    const parsed = appleAuthSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(
        context,
        400,
        "invalid_request",
        "A valid Apple challenge and identity token are required.",
      );
    }

    const now = dependencies.now();
    const nowIso = now.toISOString();
    const challenge = await context.env.DB.prepare(
      `SELECT nonce
         FROM apple_auth_challenges
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    ).bind(parsed.data.challengeId, nowIso).first<{ nonce: string }>();
    if (!challenge) {
      return errorResponse(
        context,
        401,
        "invalid_apple_challenge",
        "The Apple authentication challenge is invalid, expired, or already used.",
      );
    }

    let identity: AppleIdentity;
    try {
      identity = await dependencies.verifyAppleIdentityToken(
        parsed.data.identityToken,
        context.env.APPLE_BUNDLE_ID,
        await sha256Hex(challenge.nonce),
      );
    } catch {
      return errorResponse(context, 401, "invalid_apple_token", "Apple identity verification failed.");
    }

    const identityTokenHash = await sha256Hex(parsed.data.identityToken);
    let consumed: D1Result;
    try {
      consumed = await context.env.DB.prepare(
        `UPDATE apple_auth_challenges
            SET identity_token_hash = ?, consumed_at = ?
          WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM apple_auth_challenges
               WHERE identity_token_hash = ?
            )`,
      ).bind(
        identityTokenHash,
        nowIso,
        parsed.data.challengeId,
        nowIso,
        identityTokenHash,
      ).run();
    } catch {
      return errorResponse(
        context,
        401,
        "invalid_apple_challenge",
        "The Apple authentication challenge or identity token was already used.",
      );
    }
    if ((consumed.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        401,
        "invalid_apple_challenge",
        "The Apple authentication challenge or identity token was already used.",
      );
    }

    const pendingDeletion = await context.env.DB.prepare(
      `SELECT 1 AS found
         FROM account_deletion_jobs
        WHERE apple_subject = ? AND status IN ('pending', 'processing')
        LIMIT 1`,
    ).bind(identity.subject).first<{ found: number }>();
    if (pendingDeletion) {
      return errorResponse(
        context,
        409,
        "account_deletion_pending",
        "Account deletion is still being processed.",
      );
    }

    const proposedUserId = crypto.randomUUID();
    const displayName = identity.displayName ?? parsed.data.displayName ?? null;
    await context.env.DB.prepare(
      `INSERT INTO users (id, apple_subject, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(apple_subject) DO UPDATE SET
         email = COALESCE(excluded.email, users.email),
         display_name = COALESCE(users.display_name, excluded.display_name),
         updated_at = excluded.updated_at`,
    ).bind(proposedUserId, identity.subject, identity.email ?? null, displayName, nowIso, nowIso).run();
    const user = await context.env.DB.prepare(
      "SELECT id, apple_subject, email, display_name FROM users WHERE apple_subject = ?",
    ).bind(identity.subject).first<UserRow>();
    if (!user) throw new Error("failed to persist verified Apple user");

    const sessionToken = randomToken();
    const sessionTtlSeconds = integerBinding(
      context.env.SESSION_TTL_SECONDS,
      2_592_000,
      300,
      31_536_000,
    );
    const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString();
    const sessionCreated = await context.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       SELECT ?, u.id, ?, ?, ?
         FROM users u
        WHERE u.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_jobs deletion
             WHERE deletion.user_id = u.id AND deletion.status IN ('pending', 'processing')
          )`,
    ).bind(
      crypto.randomUUID(),
      await sha256Hex(sessionToken),
      expiresAt,
      nowIso,
      user.id,
    ).run();
    if ((sessionCreated.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        409,
        "account_deletion_pending",
        "Account deletion is still being processed.",
      );
    }

    return context.json({ token: sessionToken, expiresAt, user: userJson(user) });
  });

  app.delete("/v1/account", async (context) => {
    const authorization = context.req.header("authorization");
    const match = authorization ? /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization) : null;
    if (!match?.[1]) {
      return errorResponse(context, 401, "unauthorized", "A valid bearer session is required.");
    }
    const tokenHash = await sha256Hex(match[1]);
    const receipt = await findAccountDeletionByReceipt(context.env, tokenHash);
    if (receipt) {
      const status = receipt.status === "completed"
        ? "completed"
        : await processAccountDeletionJob(
            context.env,
            receipt.id,
            dependencies.now(),
            dependencies.accountDeletion,
          );
      context.header("Cache-Control", "no-store");
      return context.json({
        deletion: { status },
        localSessionShouldBeCleared: true,
      }, 202);
    }

    const now = dependencies.now();
    const session = await context.env.DB.prepare(
      `SELECT s.id AS session_id, u.id, u.apple_subject, u.email, u.display_name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_jobs deletion
             WHERE deletion.user_id = u.id AND deletion.status IN ('pending', 'processing')
          )`,
    ).bind(tokenHash, now.toISOString()).first<SessionUserRow>();
    if (!session) {
      return errorResponse(context, 401, "unauthorized", "The bearer session is invalid or expired.");
    }
    const parsed = accountDeletionSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(
        context,
        400,
        "apple_reauthorization_required",
        "A fresh Apple authorization code is required to delete the account.",
      );
    }
    const job = await createAccountDeletionIntent(
      context.env,
      {
        userId: session.id,
        appleSubject: session.apple_subject,
      },
      parsed.data.authorizationCode,
      now,
    );
    const status = await processAccountDeletionJob(
      context.env,
      job.id,
      now,
      dependencies.accountDeletion,
    );
    context.header("Cache-Control", "no-store");
    return context.json({
      deletion: { status },
      localSessionShouldBeCleared: true,
    }, 202);
  });

  // Development login: issues a session without Apple verification.
  // Never expose this route in production.
  app.post("/v1/auth/dev", async (context) => {
    if (String(context.env.ENVIRONMENT) === "production") return context.notFound();

    const now = dependencies.now();
    const nowIso = now.toISOString();
    const devSubject = "dev-kan";
    const pendingDeletion = await context.env.DB.prepare(
      `SELECT 1 AS found
         FROM account_deletion_jobs
        WHERE apple_subject = ? AND status IN ('pending', 'processing')
        LIMIT 1`,
    ).bind(devSubject).first<{ found: number }>();
    if (pendingDeletion) {
      return errorResponse(
        context,
        409,
        "account_deletion_pending",
        "Account deletion is still being processed.",
      );
    }
    const proposedUserId = crypto.randomUUID();
    await context.env.DB.prepare(
      `INSERT INTO users (id, apple_subject, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(apple_subject) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(proposedUserId, devSubject, "kan@2-38.com", "Kan", nowIso, nowIso).run();
    const user = await context.env.DB.prepare(
      "SELECT id, apple_subject, email, display_name FROM users WHERE apple_subject = ?",
    ).bind(devSubject).first<UserRow>();
    if (!user) throw new Error("failed to persist dev user");

    const sessionToken = randomToken();
    const sessionTtlSeconds = integerBinding(
      context.env.SESSION_TTL_SECONDS,
      2_592_000,
      300,
      31_536_000,
    );
    const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString();
    const sessionCreated = await context.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       SELECT ?, u.id, ?, ?, ?
         FROM users u
        WHERE u.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_jobs deletion
             WHERE deletion.user_id = u.id AND deletion.status IN ('pending', 'processing')
          )`,
    ).bind(
      crypto.randomUUID(),
      await sha256Hex(sessionToken),
      expiresAt,
      nowIso,
      user.id,
    ).run();
    if ((sessionCreated.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        409,
        "account_deletion_pending",
        "Account deletion is still being processed.",
      );
    }

    return context.json({ token: sessionToken, expiresAt, user: userJson(user) });
  });

  app.get("/v1/media/:token", async (context) => {
    const token = context.req.param("token");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      return errorResponse(context, 404, "media_grant_not_found", "Playback grant was not found.");
    }
    const nowIso = dependencies.now().toISOString();
    const asset = await context.env.DB.prepare(
      `SELECT
          CASE WHEN g.derivative_id IS NULL THEN a.filename
               WHEN d.kind = 'frame' THEN 'frame.jpg'
               ELSE 'clip.mp4' END AS filename,
          COALESCE(d.content_type, a.content_type) AS content_type,
          COALESCE(d.byte_size, a.byte_size) AS byte_size,
          COALESCE(d.object_key, a.object_key) AS object_key
         FROM media_grants g
         JOIN assets a ON a.id = g.asset_id AND a.user_id = g.user_id
        LEFT JOIN media_derivatives d ON d.id = g.derivative_id AND d.asset_id = a.id
        WHERE g.token_hash = ? AND g.expires_at > ? AND a.status = 'ready'
          AND (
            (g.purpose = 'app' AND g.id NOT LIKE 'transcription:%')
            OR (
              EXISTS (
                SELECT 1 FROM ai_consents consent
                 WHERE consent.user_id = a.user_id AND consent.version = ?
                   AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
              )
              AND (g.id LIKE 'transcription:%' OR a.agent_access_enabled = 1)
            )
          )
          AND (
            g.derivative_id IS NULL
            OR (d.status = 'ready' AND d.expires_at > ?)
          )`,
    ).bind(
      await sha256Hex(token),
      nowIso,
      AI_CONSENT_VERSION,
      nowIso,
    ).first<MediaBodyRow>();
    if (!asset) return errorResponse(context, 404, "media_grant_not_found", "Playback grant was not found.");
    return serveAssetBody(context, asset);
  });

  const api = new Hono<AppEnvironment>();
  api.use("*", authMiddleware(dependencies.now));
  registerDailyWeatherRoutes(api, dependencies.now);

  api.get("/me", (context) => {
    const auth = context.get("auth");
    return context.json({
      user: {
        id: auth.userId,
        appleSubject: auth.appleSubject,
        email: auth.email,
        displayName: auth.displayName,
      },
    });
  });

  api.get("/privacy/ai", async (context) => {
    const row = await findAiConsent(context.env, context.get("auth").userId);
    return context.json(aiConsentJson(row));
  });

  api.put("/privacy/ai", async (context) => {
    const parsed = aiConsentSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(
        context,
        400,
        "invalid_ai_consent",
        `AI consent must use version ${AI_CONSENT_VERSION}.`,
      );
    }
    const auth = context.get("auth");
    const nowIso = dependencies.now().toISOString();
    if (parsed.data.consented) {
      await context.env.DB.prepare(
        `INSERT INTO ai_consents (
          user_id, version, consented_at, withdrawn_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          version = excluded.version,
          consented_at = excluded.consented_at,
          withdrawn_at = NULL,
          updated_at = excluded.updated_at`,
      ).bind(auth.userId, AI_CONSENT_VERSION, nowIso, nowIso).run();
    } else {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO ai_consents (
            user_id, version, consented_at, withdrawn_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            version = excluded.version,
            withdrawn_at = excluded.withdrawn_at,
            updated_at = excluded.updated_at`,
        ).bind(auth.userId, AI_CONSENT_VERSION, nowIso, nowIso),
        context.env.DB.prepare(
          "UPDATE assets SET agent_access_enabled = 0, updated_at = ? WHERE user_id = ?",
        ).bind(nowIso, auth.userId),
        context.env.DB.prepare(
          `UPDATE assets
              SET transcription_status = 'skipped',
                  transcript_error = 'consent_withdrawn',
                  transcription_updated_at = ?
            WHERE user_id = ? AND transcription_status = 'pending'`,
        ).bind(nowIso, auth.userId),
        context.env.DB.prepare(
          `DELETE FROM media_grants
            WHERE user_id = ?
              AND (purpose IN ('agent', 'worker') OR id LIKE 'transcription:%')`,
        ).bind(auth.userId),
        context.env.DB.prepare(
          `DELETE FROM gpu_jobs
            WHERE asset_id IN (SELECT id FROM assets WHERE user_id = ?)`,
        ).bind(auth.userId),
        context.env.DB.prepare(
          `UPDATE mcp_tokens SET revoked_at = ?
            WHERE user_id = ? AND revoked_at IS NULL`,
        ).bind(nowIso, auth.userId),
      ]);
    }
    const row = await findAiConsent(context.env, auth.userId);
    return context.json(aiConsentJson(row));
  });

  api.get("/mcp/tokens", async (context) => {
    const auth = context.get("auth");
    const tokens = await context.env.DB.prepare(
      `SELECT id, name, created_at, expires_at, last_used_at
         FROM mcp_tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
    ).bind(auth.userId, dependencies.now().toISOString()).all<McpTokenRow>();
    return context.json({ items: tokens.results.map(mcpTokenJson) });
  });

  api.post("/mcp/tokens", async (context) => {
    const parsed = mcpTokenSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_mcp_token", "A token name between 1 and 48 characters is required.");
    }
    const auth = context.get("auth");
    if (!await hasActiveAiConsent(context.env, auth.userId)) {
      return errorResponse(
        context,
        403,
        "ai_consent_required",
        "Active AI and MCP consent is required.",
      );
    }
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const active = await context.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
    ).bind(auth.userId, nowIso).first<{ count: number }>();
    if ((active?.count ?? 0) >= 10) {
      return errorResponse(context, 409, "mcp_token_limit", "Revoke an existing token before creating another.");
    }

    const id = crypto.randomUUID();
    const token = `aft_mcp_${randomToken()}`;
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await context.env.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, name, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, auth.userId, parsed.data.name, await sha256Hex(token), nowIso, expiresAt).run();

    return context.json({
      item: mcpTokenJson({
        id,
        name: parsed.data.name,
        created_at: nowIso,
        expires_at: expiresAt,
        last_used_at: null,
      }),
      token,
    }, 201);
  });

  api.delete("/mcp/tokens/:id", async (context) => {
    const result = await context.env.DB.prepare(
      `UPDATE mcp_tokens SET revoked_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(
      dependencies.now().toISOString(),
      context.req.param("id"),
      context.get("auth").userId,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 404, "mcp_token_not_found", "MCP token was not found.");
    }
    return new Response(null, { status: 204 });
  });

  api.delete("/auth/session", async (context) => {
    await context.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(context.get("auth").sessionId).run();
    return new Response(null, { status: 204 });
  });

  api.patch("/assets/:assetId/agent-access", async (context) => {
    const parsed = agentAccessSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_agent_access", "Agent access setting is invalid.");
    }
    const auth = context.get("auth");
    const assetId = context.req.param("assetId");
    if (parsed.data.enabled && !await hasActiveAiConsent(context.env, auth.userId)) {
      return errorResponse(
        context,
        403,
        "ai_consent_required",
        "Active AI and MCP consent is required.",
      );
    }
    const asset = await findOwnedAsset(context.env, assetId, auth.userId);
    if (!asset || asset.kind !== "video" || asset.status !== "ready") {
      return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    }
    const now = dependencies.now();
    const updatedAt = now.toISOString();
    const statements = [
      context.env.DB.prepare(
        `UPDATE assets SET agent_access_enabled = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND kind = 'video' AND status = 'ready'`,
      ).bind(parsed.data.enabled ? 1 : 0, updatedAt, assetId, auth.userId),
    ];
    if (!parsed.data.enabled) {
      statements.push(
        context.env.DB.prepare(
          "DELETE FROM media_grants WHERE asset_id = ? AND purpose IN ('agent', 'worker')",
        ).bind(assetId),
        context.env.DB.prepare("DELETE FROM gpu_jobs WHERE asset_id = ?").bind(assetId),
        context.env.DB.prepare("DELETE FROM video_analyses WHERE asset_id = ?").bind(assetId),
        context.env.DB.prepare("DELETE FROM media_derivatives WHERE asset_id = ?").bind(assetId),
      );
    }
    const [updated] = await context.env.DB.batch(statements);
    if ((updated?.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    }
    if (parsed.data.enabled) {
      const queueResult = await queueVideoAnalysis(context.env, assetId, auth.userId, now);
      if (queueResult === "analysis_queue_limit" || queueResult === "external_ai_work_limit") {
        await context.env.DB.prepare(
          `UPDATE assets SET agent_access_enabled = 0, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        ).bind(updatedAt, assetId, auth.userId).run();
        return errorResponse(
          context,
          429,
          queueResult,
          queueResult === "analysis_queue_limit"
            ? "At most four Mage jobs may be active."
            : "At most four external AI jobs may be active.",
        );
      }
      if (queueResult === "not_eligible") {
        await context.env.DB.prepare(
          `UPDATE assets SET agent_access_enabled = 0, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        ).bind(updatedAt, assetId, auth.userId).run();
        return errorResponse(
          context,
          409,
          "agent_access_conflict",
          "Agent access could not be enabled.",
        );
      }
    } else {
      const keep = new Set([asset.object_key, ...(asset.thumbnail_key ? [asset.thumbnail_key] : [])]);
      await deleteAssetPrefixObjects(context.env, auth.userId, assetId, keep);
    }
    const result = await findOwnedAsset(context.env, assetId, auth.userId);
    if (!result) return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    return context.json({ asset: assetJson(result) });
  });

  api.post("/assets/existing", async (context) => {
    const parsed = existingAssetsSchema.safeParse(await parseJson(context));
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_asset_candidates", "Asset candidates are invalid.");
    }
    const auth = context.get("auth");
    const placeholders = parsed.data.items.map(() => "?").join(", ");
    const fingerprints = parsed.data.items.map((item) => item.sourceFingerprint);
    const filenames = parsed.data.items.map((item) => item.filename);
    const rows = await context.env.DB.prepare(
      `SELECT source_fingerprint, filename
         FROM assets
        WHERE user_id = ? AND status IN ('uploading', 'ready')
          AND (
            source_fingerprint IN (${placeholders})
            OR (source_fingerprint IS NULL AND filename IN (${placeholders}))
          )`,
    ).bind(auth.userId, ...fingerprints, ...filenames).all<{
      source_fingerprint: string | null;
      filename: string;
    }>();
    const storedFingerprints = new Set(
      rows.results.flatMap((row) => row.source_fingerprint ? [row.source_fingerprint] : []),
    );
    const legacyFilenames = new Set(
      rows.results.filter((row) => row.source_fingerprint === null).map((row) => row.filename),
    );
    const existingSourceFingerprints = parsed.data.items
      .filter((item) => storedFingerprints.has(item.sourceFingerprint) || legacyFilenames.has(item.filename))
      .map((item) => item.sourceFingerprint);
    return context.json({ existingSourceFingerprints });
  });

  api.post("/assets", async (context) => {
    const parsed = assetSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_asset", "Asset metadata is invalid.");
    const auth = context.get("auth");
    const now = dependencies.now();
    const nowIso = now.toISOString();
    if (parsed.data.sourceFingerprint) {
      const duplicate = await context.env.DB.prepare(
        `SELECT id FROM assets
          WHERE user_id = ? AND status IN ('uploading', 'ready')
            AND (
              source_fingerprint = ?
              OR (source_fingerprint IS NULL AND filename = ?)
            )
          LIMIT 1`,
      ).bind(auth.userId, parsed.data.sourceFingerprint, parsed.data.filename).first<{ id: string }>();
      if (duplicate) {
        return errorResponse(
          context,
          409,
          "duplicate_asset",
          "This photo or video is already in afterimage.",
        );
      }
    }
    const assetId = crypto.randomUUID();
    const creationWindowStart = new Date(now.getTime() - ASSET_CREATION_WINDOW_MS).toISOString();
    await context.env.DB.prepare(
      `DELETE FROM asset_creation_ledger
        WHERE id IN (
          SELECT id FROM asset_creation_ledger
           WHERE created_at <= ?
           ORDER BY created_at ASC LIMIT 10000
        )`,
    ).bind(creationWindowStart).run();
    const quotaClaim = await context.env.DB.prepare(
      `INSERT INTO asset_creation_ledger (id, user_id, created_at)
      SELECT ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM asset_creation_ledger
          WHERE user_id = ? AND created_at > ?
       ) < ?`,
    ).bind(
      assetId,
      auth.userId,
      nowIso,
      auth.userId,
      creationWindowStart,
      ASSET_CREATION_LIMIT,
    ).run();
    if ((quotaClaim.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        429,
        "asset_creation_quota_exceeded",
        "At most ten assets may be created in a rolling 24-hour window.",
      );
    }
    const objectKey = `users/${auth.userId}/assets/${assetId}/media`;
    const singleLimit = integerBinding(context.env.SINGLE_UPLOAD_MAX_BYTES, 5_242_880, 1, 100 * 1024 * 1024);
    const partSize = integerBinding(
      context.env.MULTIPART_PART_SIZE_BYTES,
      8_388_608,
      5 * 1024 * 1024,
      100 * 1024 * 1024,
    );
    const uploadMode: "single" | "multipart" = parsed.data.byteSize <= singleLimit ? "single" : "multipart";
    const partCount = uploadMode === "multipart" ? Math.ceil(parsed.data.byteSize / partSize) : 1;
    if (partCount > 10_000) {
      await context.env.DB.prepare("DELETE FROM asset_creation_ledger WHERE id = ?")
        .bind(assetId)
        .run();
      return errorResponse(context, 413, "asset_too_large", "Asset requires too many upload parts.");
    }

    let uploadId: string | null = null;
    let multipart: R2MultipartUpload | null = null;
    try {
      if (uploadMode === "multipart") {
        multipart = await context.env.MEDIA.createMultipartUpload(objectKey, {
          httpMetadata: { contentType: parsed.data.contentType },
          customMetadata: { assetId, userId: auth.userId },
        });
        uploadId = multipart.uploadId;
      }
    } catch (error) {
      await context.env.DB.prepare("DELETE FROM asset_creation_ledger WHERE id = ?")
        .bind(assetId)
        .run();
      throw error;
    }

    let inserted: D1Result;
    try {
      inserted = await context.env.DB.prepare(
        `INSERT OR IGNORE INTO assets (
          id, user_id, kind, source_fingerprint, filename, content_type, byte_size, captured_at,
          latitude, longitude, duration_ms, width, height, status, object_key, thumbnail_key,
          upload_mode, upload_id, part_size, created_at, updated_at, agent_access_enabled
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, NULL, ?, ?, ?, ?, ?, 0
         WHERE (
           SELECT COALESCE(SUM(byte_size), 0)
             FROM assets
            WHERE user_id = ? AND status IN ('uploading', 'ready')
         ) + ? <= ?
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_jobs deletion
              WHERE deletion.user_id = ?
                AND deletion.status IN ('pending', 'processing')
           )`,
      ).bind(
        assetId,
        auth.userId,
        parsed.data.kind,
        parsed.data.sourceFingerprint ?? null,
        parsed.data.filename,
        parsed.data.contentType,
        parsed.data.byteSize,
        new Date(parsed.data.capturedAt).toISOString(),
        parsed.data.location?.latitude ?? null,
        parsed.data.location?.longitude ?? null,
        parsed.data.durationMs ?? null,
        parsed.data.width ?? null,
        parsed.data.height ?? null,
        objectKey,
        uploadMode,
        uploadId,
        uploadMode === "multipart" ? partSize : null,
        nowIso,
        nowIso,
        auth.userId,
        parsed.data.byteSize,
        ACTIVE_STORAGE_QUOTA_BYTES,
        auth.userId,
      ).run();
    } catch (error) {
      if (multipart) await multipart.abort();
      await context.env.DB.prepare("DELETE FROM asset_creation_ledger WHERE id = ?")
        .bind(assetId)
        .run();
      throw error;
    }
    if ((inserted.meta.changes ?? 0) !== 1) {
      if (multipart) await multipart.abort();
      await context.env.DB.prepare("DELETE FROM asset_creation_ledger WHERE id = ?")
        .bind(assetId)
        .run();
      const deletionPending = await context.env.DB.prepare(
        `SELECT 1 AS found FROM account_deletion_jobs
          WHERE user_id = ? AND status IN ('pending', 'processing')`,
      ).bind(auth.userId).first<{ found: number }>();
      if (deletionPending) {
        return errorResponse(
          context,
          409,
          "account_deletion_pending",
          "Account deletion is still being processed.",
        );
      }
      const duplicate = parsed.data.sourceFingerprint
        ? await context.env.DB.prepare(
            `SELECT 1 AS found FROM assets
              WHERE user_id = ? AND status IN ('uploading', 'ready')
                AND (
                  source_fingerprint = ?
                  OR (source_fingerprint IS NULL AND filename = ?)
                )
              LIMIT 1`,
          ).bind(
            auth.userId,
            parsed.data.sourceFingerprint,
            parsed.data.filename,
          ).first<{ found: number }>()
        : null;
      if (duplicate) {
        return errorResponse(
          context,
          409,
          "duplicate_asset",
          "This photo or video is already in afterimage.",
        );
      }
      return errorResponse(
        context,
        429,
        "storage_quota_exceeded",
        "Active uploads and stored assets may use at most 30 GiB.",
      );
    }

    const asset = await findOwnedAsset(context.env, assetId, auth.userId);
    if (!asset) throw new Error("asset insert did not persist");
    const upload = uploadMode === "single"
      ? { mode: "single" as const, url: `/v1/assets/${assetId}/upload` }
      : {
          mode: "multipart" as const,
          partSize,
          partCount,
          partUrlTemplate: `/v1/assets/${assetId}/upload/parts/{partNumber}`,
        };
    return context.json({ asset: assetJson(asset), upload }, 201);
  });

  api.put("/assets/:assetId/upload", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "uploading" || asset.upload_mode !== "single") {
      return errorResponse(context, 404, "upload_not_found", "Upload was not found.");
    }
    const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== asset.content_type) {
      return errorResponse(context, 415, "content_type_mismatch", "Upload Content-Type differs from metadata.");
    }
    const contentLength = Number(context.req.header("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== asset.byte_size) {
      return errorResponse(context, 400, "upload_size_mismatch", "Upload length differs from its declared size.");
    }
    if (!context.req.raw.body) return errorResponse(context, 400, "missing_body", "Upload body is required.");

    const lease = crypto.randomUUID();
    const now = dependencies.now();
    const claimed = await claimSingleUploadLease(context.env, asset.id, auth.userId, lease, now);
    if (!claimed) {
      return errorResponse(context, 409, "upload_conflict", "Another upload or completion is active.");
    }
    const attemptKey = `${assetObjectPrefix(auth.userId, asset.id)}attempts/${lease}`;
    try {
      await context.env.MEDIA.put(attemptKey, context.req.raw.body, {
        httpMetadata: { contentType: asset.content_type },
        customMetadata: { assetId: asset.id, userId: auth.userId, uploadLease: lease },
      });
    } catch (error) {
      try {
        await releaseSingleUploadLease(context.env, asset.id, auth.userId, lease, dependencies.now());
      } catch {
        // The lease expires; preserve an ambiguously written attempt for prefix cleanup.
      }
      throw error;
    }

    let finalized: D1Result;
    try {
      finalized = await context.env.DB.prepare(
        `UPDATE assets SET object_key = ?, upload_lease = NULL, updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_lease = ?`,
      ).bind(attemptKey, dependencies.now().toISOString(), asset.id, auth.userId, lease).run();
    } catch (error) {
      // The UPDATE outcome is ambiguous. Read back the authoritative pointer before compensating.
      try {
        const current = await findOwnedAsset(context.env, asset.id, auth.userId);
        if (!current || current.status === "failed" || current.object_key !== attemptKey) {
          await context.env.MEDIA.delete(attemptKey);
        }
      } catch {
        // If reconciliation is also unavailable, a failed-row tombstone retains prefix cleanup eligibility.
      }
      throw error;
    }
    if ((finalized.meta.changes ?? 0) !== 1) {
      await context.env.MEDIA.delete(attemptKey);
      return errorResponse(context, 409, "upload_conflict", "Upload was cancelled while data was being stored.");
    }
    return new Response(null, { status: 204 });
  });

  api.put("/assets/:assetId/upload/parts/:partNumber", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "uploading" || asset.upload_mode !== "multipart"
      || !asset.upload_id || !asset.part_size) {
      return errorResponse(context, 404, "upload_not_found", "Multipart upload was not found.");
    }
    const partNumber = Number(context.req.param("partNumber"));
    const partCount = Math.ceil(asset.byte_size / asset.part_size);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
      return errorResponse(context, 400, "invalid_part", "Part number is outside the upload plan.");
    }
    const expectedLength = partNumber === partCount
      ? asset.byte_size - asset.part_size * (partCount - 1)
      : asset.part_size;
    const contentLength = Number(context.req.header("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== expectedLength) {
      return errorResponse(context, 400, "invalid_part_size", "Part length differs from the upload plan.");
    }
    if (!context.req.raw.body) return errorResponse(context, 400, "missing_body", "Part body is required.");
    const leaseRenewed = await renewAssetStatus(
      context.env,
      asset.id,
      auth.userId,
      "uploading",
      dependencies.now(),
    );
    if (!leaseRenewed) {
      return errorResponse(context, 409, "upload_conflict", "Upload is no longer active.");
    }

    const upload = context.env.MEDIA.resumeMultipartUpload(asset.object_key, asset.upload_id);
    let uploadedPart: R2UploadedPart;
    try {
      uploadedPart = await upload.uploadPart(partNumber, context.req.raw.body);
    } catch (error) {
      try {
        const current = await findOwnedAsset(context.env, asset.id, auth.userId);
        if (!current || current.status !== "uploading") {
          return errorResponse(context, 409, "upload_conflict", "Upload completed or was cancelled before the part was stored.");
        }
      } catch {
        // Preserve the original R2 error when D1 cannot reconcile the state.
      }
      throw error;
    }
    const batchResults = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO upload_parts (asset_id, part_number, etag) VALUES (?, ?, ?)
         ON CONFLICT(asset_id, part_number) DO UPDATE SET etag = excluded.etag`,
      ).bind(asset.id, uploadedPart.partNumber, uploadedPart.etag),
      context.env.DB.prepare(
        "UPDATE assets SET updated_at = ? WHERE id = ? AND user_id = ? AND status = 'uploading'",
      ).bind(dependencies.now().toISOString(), asset.id, auth.userId),
    ]);
    if ((batchResults[1]?.meta.changes ?? 0) !== 1) {
      const current = await findOwnedAsset(context.env, asset.id, auth.userId);
      if (!current || current.status === "failed") {
        try {
          await upload.abort();
        } catch {
          // The winning deletion or cleanup may already have aborted it.
        }
      }
      await context.env.DB.prepare(
        "DELETE FROM upload_parts WHERE asset_id = ? AND part_number = ?",
      ).bind(asset.id, partNumber).run();
      return errorResponse(context, 409, "upload_conflict", "Upload was cancelled while the part was being stored.");
    }
    return context.json({ part: uploadedPart });
  });

  api.post("/assets/:assetId/upload/complete", async (context) => {
    const auth = context.get("auth");
    let asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset) return errorResponse(context, 404, "upload_not_found", "Upload was not found.");
    if (asset.status === "ready") {
      try {
        await context.env.DB.prepare("DELETE FROM upload_parts WHERE asset_id = ?").bind(asset.id).run();
      } catch {
        // Part metadata is non-authoritative after ready and can be cleaned on another idempotent call.
      }
      try {
        const keep = new Set([asset.object_key, ...(asset.thumbnail_key ? [asset.thumbnail_key] : [])]);
        await deleteAssetPrefixObjects(context.env, auth.userId, asset.id, keep);
      } catch {
        // Prefix cleanup is best-effort; the ready object remains authoritative in D1.
      }
      return context.json({ asset: assetJson(asset) });
    }
    if (asset.status !== "uploading") return errorResponse(context, 409, "upload_failed", "Upload cannot be completed.");

    let completionLease: string | undefined;
    if (asset.upload_mode === "single") {
      completionLease = crypto.randomUUID();
      const claimed = await claimSingleUploadLease(
        context.env,
        asset.id,
        auth.userId,
        completionLease,
        dependencies.now(),
      );
      if (!claimed) {
        return errorResponse(context, 409, "upload_conflict", "An upload or completion is still active.");
      }
      const refreshed = await findOwnedAsset(context.env, asset.id, auth.userId);
      if (!refreshed || refreshed.status !== "uploading") {
        return errorResponse(context, 409, "upload_conflict", "Upload state changed during completion.");
      }
      asset = refreshed;
    } else {
      const leaseRenewed = await renewAssetStatus(
        context.env,
        asset.id,
        auth.userId,
        "uploading",
        dependencies.now(),
      );
      if (!leaseRenewed) {
        return errorResponse(context, 409, "upload_conflict", "Upload is no longer active.");
      }
    }

    if (asset.upload_mode === "multipart") {
      if (!asset.upload_id || !asset.part_size) {
        return errorResponse(context, 409, "upload_state_invalid", "Multipart state is incomplete.");
      }
      const rows = await context.env.DB.prepare(
        "SELECT part_number, etag FROM upload_parts WHERE asset_id = ? ORDER BY part_number",
      ).bind(asset.id).all<UploadPartRow>();
      const expectedCount = Math.ceil(asset.byte_size / asset.part_size);
      const completeParts = rows.results.map((row) => ({ partNumber: row.part_number, etag: row.etag }));
      if (completeParts.length !== expectedCount
        || completeParts.some((part, index) => part.partNumber !== index + 1)) {
        return errorResponse(context, 409, "upload_parts_missing", "Not all multipart chunks are present.");
      }
      try {
        await context.env.MEDIA.resumeMultipartUpload(asset.object_key, asset.upload_id).complete(completeParts);
      } catch {
        const alreadyCompleted = await context.env.MEDIA.head(asset.object_key);
        if (!alreadyCompleted) {
          return errorResponse(context, 409, "multipart_completion_failed", "R2 rejected multipart completion.");
        }
      }
    }

    let object: R2Object | null;
    try {
      object = await context.env.MEDIA.head(asset.object_key);
    } catch (error) {
      if (completionLease) {
        try {
          await releaseSingleUploadLease(context.env, asset.id, auth.userId, completionLease, dependencies.now());
        } catch {
          // The lease expires if D1 is unavailable.
        }
      }
      throw error;
    }
    if (!object) {
      if (completionLease) {
        await releaseSingleUploadLease(context.env, asset.id, auth.userId, completionLease, dependencies.now());
      }
      return errorResponse(context, 409, "upload_object_missing", "Uploaded object does not exist.");
    }
    if (object.size !== asset.byte_size) {
      const failed = completionLease
        ? await context.env.DB.prepare(
            `UPDATE assets SET status = 'failed', upload_lease = NULL, updated_at = ?
              WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_lease = ?`,
          ).bind(dependencies.now().toISOString(), asset.id, auth.userId, completionLease).run()
        : await context.env.DB.prepare(
            "UPDATE assets SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'uploading'",
          ).bind(dependencies.now().toISOString(), asset.id, auth.userId).run();
      if ((failed.meta.changes ?? 0) === 1) await context.env.MEDIA.delete(asset.object_key);
      return errorResponse(context, 409, "upload_size_mismatch", "Uploaded object size differs from metadata.");
    }

    const updatedAt = dependencies.now().toISOString();
    let readyTransition: D1Result;
    try {
      readyTransition = completionLease
        ? await context.env.DB.prepare(
            `UPDATE assets SET status = 'ready', upload_lease = NULL, updated_at = ?
              WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_lease = ?`,
          ).bind(updatedAt, asset.id, auth.userId, completionLease).run()
        : await context.env.DB.prepare(
            "UPDATE assets SET status = 'ready', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'uploading'",
          ).bind(updatedAt, asset.id, auth.userId).run();
    } catch (error) {
      // A D1 exception is ambiguous: preserving the referenced R2 object avoids committed-row data loss.
      throw error;
    }
    if ((readyTransition.meta.changes ?? 0) !== 1) {
      const concurrent = await findOwnedAsset(context.env, asset.id, auth.userId);
      if (concurrent?.status === "ready") {
        return context.json({ asset: assetJson(concurrent) });
      }
      if (!concurrent || concurrent.status === "failed") {
        await context.env.MEDIA.delete(asset.object_key);
      }
      return errorResponse(context, 409, "upload_conflict", "Upload was cancelled while completion was being stored.");
    }
    const completed = await findOwnedAsset(context.env, asset.id, auth.userId);
    if (!completed) {
      return errorResponse(context, 409, "upload_conflict", "Asset was deleted during completion.");
    }
    if (completed.kind === "video" && context.env.SONIOX_API_KEY) {
      try {
        const transcriptionQueued = await context.env.DB.prepare(
          `UPDATE assets
              SET transcription_status = 'pending',
                  transcript_error = NULL,
                  transcription_updated_at = ?
            WHERE id = ? AND user_id = ? AND transcription_status IS NULL
              AND EXISTS (
                SELECT 1 FROM ai_consents consent
                 WHERE consent.user_id = assets.user_id AND consent.version = ?
                   AND consent.consented_at IS NOT NULL AND consent.withdrawn_at IS NULL
              )
              AND (
                (
                  SELECT COUNT(*)
                    FROM gpu_jobs active_job
                    JOIN assets active_asset ON active_asset.id = active_job.asset_id
                   WHERE active_asset.user_id = assets.user_id
                     AND active_job.status IN ('queued', 'leased')
                )
                +
                (
                  SELECT COUNT(*)
                    FROM assets active_transcription
                   WHERE active_transcription.user_id = assets.user_id
                     AND active_transcription.transcription_status IN ('pending', 'processing')
                )
                +
                (
                  SELECT COUNT(*)
                    FROM external_ai_work_leases lease
                   WHERE lease.user_id = assets.user_id AND lease.expires_at > ?
                )
              ) < ?`,
        ).bind(
          dependencies.now().toISOString(),
          completed.id,
          auth.userId,
          AI_CONSENT_VERSION,
          dependencies.now().toISOString(),
          ACTIVE_EXTERNAL_AI_WORK_LIMIT,
        ).run();
        if (
          (transcriptionQueued.meta.changes ?? 0) !== 1
          && await hasActiveAiConsent(context.env, auth.userId)
        ) {
          await context.env.DB.prepare(
            `UPDATE assets
                SET transcription_status = 'skipped',
                    transcript_error = 'external_ai_work_limit',
                    transcription_updated_at = ?
              WHERE id = ? AND user_id = ? AND transcription_status IS NULL`,
          ).bind(dependencies.now().toISOString(), completed.id, auth.userId).run();
        }
      } catch {
      }
    }
    if (completed.kind === "video" && completed.agent_access_enabled === 1) {
      try {
        await queueVideoAnalysis(context.env, completed.id, auth.userId, dependencies.now());
      } catch (error) {
        console.error(JSON.stringify({
          event: "video_analysis_queue_failed",
          assetId: completed.id,
          message: String(error),
        }));
      }
    }
    try {
      await context.env.DB.prepare("DELETE FROM upload_parts WHERE asset_id = ?").bind(completed.id).run();
    } catch {
      // Part metadata is non-authoritative after ready and can be retried by idempotent completion.
    }
    try {
      const keep = new Set([completed.object_key, ...(completed.thumbnail_key ? [completed.thumbnail_key] : [])]);
      await deleteAssetPrefixObjects(context.env, auth.userId, completed.id, keep);
    } catch {
      // Orphan attempt cleanup is best-effort and can be retried by an idempotent completion call.
    }
    const responseAsset = completed.kind === "video"
      ? await findOwnedAsset(context.env, completed.id, auth.userId) ?? completed
      : completed;
    return context.json({ asset: assetJson(responseAsset) });
  });

  api.post("/assets/:assetId/playback", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "ready") {
      return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    }
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const ttlSeconds = integerBinding(
      context.env.PLAYBACK_GRANT_TTL_SECONDS,
      300,
      60,
      3_600,
    );
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const token = randomToken();
    await context.env.DB.batch([
      context.env.DB.prepare("DELETE FROM media_grants WHERE expires_at <= ?").bind(nowIso),
      context.env.DB.prepare(
        `INSERT INTO media_grants (
          id, asset_id, user_id, token_hash, expires_at, created_at, purpose
        ) VALUES (?, ?, ?, ?, ?, ?, 'app')`,
      ).bind(crypto.randomUUID(), asset.id, auth.userId, await sha256Hex(token), expiresAt, nowIso),
    ]);
    return context.json({ url: `/v1/media/${token}`, expiresAt }, 201);
  });

  api.put("/assets/:assetId/thumbnail", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "ready") {
      return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    }
    const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
    const contentLength = Number(context.req.header("content-length"));
    if (contentType !== "image/jpeg") {
      return errorResponse(context, 415, "thumbnail_type_invalid", "Thumbnail must be JPEG.");
    }
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > 5 * 1024 * 1024) {
      return errorResponse(context, 413, "thumbnail_size_invalid", "Thumbnail must be at most 5 MiB.");
    }
    if (!context.req.raw.body) return errorResponse(context, 400, "missing_body", "Thumbnail body is required.");
    const leaseRenewed = await renewAssetStatus(
      context.env,
      asset.id,
      auth.userId,
      "ready",
      dependencies.now(),
    );
    if (!leaseRenewed) {
      return errorResponse(context, 409, "thumbnail_conflict", "Asset is no longer available for thumbnail upload.");
    }
    const thumbnailKey = `users/${auth.userId}/assets/${asset.id}/thumbnail.jpg`;
    await context.env.MEDIA.put(thumbnailKey, context.req.raw.body, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { assetId: asset.id, userId: auth.userId, role: "thumbnail" },
    });
    const thumbnailTransition = await context.env.DB.prepare(
      "UPDATE assets SET thumbnail_key = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'ready'",
    ).bind(thumbnailKey, dependencies.now().toISOString(), asset.id, auth.userId).run();
    if ((thumbnailTransition.meta.changes ?? 0) !== 1) {
      await context.env.MEDIA.delete(thumbnailKey);
      return errorResponse(context, 409, "thumbnail_conflict", "Asset was deleted while its thumbnail was being stored.");
    }
    return new Response(null, { status: 204 });
  });

  api.get("/assets/:assetId/thumbnail", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "ready" || !asset.thumbnail_key) {
      return errorResponse(context, 404, "thumbnail_not_found", "Thumbnail was not found.");
    }
    const object = await context.env.MEDIA.get(asset.thumbnail_key);
    if (!object) return errorResponse(context, 404, "thumbnail_not_found", "Thumbnail body was not found.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", "image/jpeg");
    headers.set("content-length", String(object.size));
    headers.set("cache-control", "private, no-store");
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  });

  api.delete("/assets/:assetId", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset) return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    await context.env.DB.prepare(
      `UPDATE assets SET status = 'failed', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('uploading', 'ready')`,
    ).bind(dependencies.now().toISOString(), asset.id, auth.userId).run();
    if (asset.upload_mode === "multipart" && asset.status === "uploading" && asset.upload_id) {
      try {
        await context.env.MEDIA.resumeMultipartUpload(asset.object_key, asset.upload_id).abort();
      } catch {
        // An already-expired or completed multipart upload is safe to continue deleting.
      }
    }
    const thumbnailKey = `${assetObjectPrefix(auth.userId, asset.id)}thumbnail.jpg`;
    await context.env.MEDIA.delete([asset.object_key, thumbnailKey]);
    await deleteAssetPrefixObjects(context.env, auth.userId, asset.id);
    // Keep the failed row as a tombstone. Scheduled cleanup repeats prefix deletion after the
    // grace period, catching writes that were already in flight when this request deleted R2.
    return new Response(null, { status: 204 });
  });

  api.get("/days/summary", async (context) => {
    const auth = context.get("auth");
    setPrivateResponseHeaders(context);
    if (!await hasActiveAiConsent(context.env, auth.userId)) {
      return errorResponse(
        context,
        403,
        "ai_consent_required",
        "Active AI consent is required for daily summaries.",
      );
    }
    const parsed = dailyPlaybackQuerySchema.safeParse({
      startAt: context.req.query("startAt"),
      endAt: context.req.query("endAt"),
    });
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_day_range", "A valid startAt and endAt are required.");
    }

    const startAt = new Date(parsed.data.startAt);
    const endAt = new Date(parsed.data.endAt);
    const spanMs = endAt.getTime() - startAt.getTime();
    if (spanMs < MIN_DAILY_SUMMARY_RANGE_MS || spanMs > MAX_DAILY_SUMMARY_RANGE_MS) {
      return errorResponse(context, 400, "invalid_day_range", "The summary range must describe one calendar day.");
    }

    const startIso = startAt.toISOString();
    const endIso = endAt.toISOString();
    const transcriptWhere = "a.transcription_status = 'completed' AND a.transcript IS NOT NULL AND length(trim(a.transcript)) > 0";
    const rangeWhere = `a.user_id = ? AND a.kind = 'video' AND a.status = 'ready'
      AND julianday(a.captured_at) >= julianday(?) AND julianday(a.captured_at) < julianday(?)`;
    const bounds = await context.env.DB.prepare(
      `WITH source_assets AS (
         SELECT a.id,
                CASE WHEN ${transcriptWhere} THEN a.transcript ELSE NULL END AS transcript,
                va.summary AS visual_summary
           FROM assets a
           LEFT JOIN video_analyses va
             ON va.asset_id = a.id AND a.agent_access_enabled = 1
          WHERE ${rangeWhere}
            AND ((${transcriptWhere}) OR va.asset_id IS NOT NULL)
       ), segment_totals AS (
         SELECT COUNT(*) AS row_count, COALESCE(SUM(length(segment.caption)), 0) AS character_count
           FROM video_analysis_segments segment
           JOIN source_assets source
             ON source.id = segment.analysis_asset_id AND source.visual_summary IS NOT NULL
       )
       SELECT COUNT(*) AS source_count,
              COALESCE(SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END), 0) AS source_transcript_count,
              COALESCE(SUM(CASE WHEN visual_summary IS NOT NULL THEN 1 ELSE 0 END), 0) AS source_visual_analysis_count,
              COUNT(*) + (SELECT row_count FROM segment_totals) AS source_rows,
              COALESCE(SUM(length(COALESCE(transcript, '')) + length(COALESCE(visual_summary, ''))), 0)
                + (SELECT character_count FROM segment_totals) AS source_characters
         FROM source_assets`,
    ).bind(auth.userId, startIso, endIso).first<DailySummaryBoundsRow>();
    const sourceCount = Number(bounds?.source_count ?? 0);
    const sourceRows = Number(bounds?.source_rows ?? 0);
    const sourceCharacters = Number(bounds?.source_characters ?? 0);
    if (
      sourceCount > MAX_DAILY_SUMMARY_SOURCES
      || sourceRows > MAX_DAILY_SUMMARY_SOURCE_ROWS
      || sourceCharacters > MAX_DAILY_SUMMARY_SOURCE_CHARACTERS
    ) {
      return errorResponse(context, 413, "daily_summary_too_large", "This day is too large to summarize.");
    }

    if (sourceCount === 0) {
      await context.env.DB.prepare(
        "DELETE FROM daily_summaries WHERE user_id = ? AND start_at = ? AND end_at = ?",
      ).bind(auth.userId, startIso, endIso).run();
      return context.json({
        startAt: startIso,
        endAt: endIso,
        summary: null,
        model: null,
        sourceTranscriptCount: 0,
        sourceVisualAnalysisCount: 0,
        generatedAt: null,
      });
    }

    const [memoryRows, visualSegments] = await Promise.all([
      context.env.DB.prepare(
        `SELECT a.id, a.captured_at,
                CASE WHEN ${transcriptWhere} THEN a.transcript ELSE NULL END AS transcript,
                CASE WHEN ${transcriptWhere} THEN a.transcription_updated_at ELSE NULL END AS transcription_updated_at,
                va.summary AS visual_summary, va.updated_at AS visual_updated_at,
                va.model_id AS visual_model_id, va.model_revision AS visual_model_revision,
                va.backend AS visual_backend, va.coverage_mode AS visual_coverage_mode
           FROM assets a
           LEFT JOIN video_analyses va
             ON va.asset_id = a.id AND a.agent_access_enabled = 1
          WHERE ${rangeWhere}
            AND ((${transcriptWhere}) OR va.asset_id IS NOT NULL)
          ORDER BY julianday(a.captured_at) ASC, a.id ASC
          LIMIT ?`,
      ).bind(auth.userId, startIso, endIso, MAX_DAILY_SUMMARY_SOURCES + 1).all<DailySummaryMemoryRow>(),
      context.env.DB.prepare(
        `SELECT segment.analysis_asset_id, segment.position,
                segment.start_ms, segment.end_ms, segment.caption
           FROM video_analysis_segments segment
           JOIN assets a ON a.id = segment.analysis_asset_id
          WHERE ${rangeWhere} AND a.agent_access_enabled = 1
          ORDER BY segment.analysis_asset_id, segment.position
          LIMIT ?`,
      ).bind(auth.userId, startIso, endIso, MAX_DAILY_SUMMARY_SOURCE_ROWS + 1).all<DailySummaryVisualSegmentRow>(),
    ]);
    if (
      memoryRows.results.length > MAX_DAILY_SUMMARY_SOURCES
      || memoryRows.results.length + visualSegments.results.length > MAX_DAILY_SUMMARY_SOURCE_ROWS
    ) {
      return errorResponse(context, 413, "daily_summary_too_large", "This day is too large to summarize.");
    }

    const segmentsByAsset = new Map<string, DailySummaryVisualSegmentRow[]>();
    for (const segment of visualSegments.results) {
      const segments = segmentsByAsset.get(segment.analysis_asset_id) ?? [];
      segments.push(segment);
      segmentsByAsset.set(segment.analysis_asset_id, segments);
    }

    const sources: DailyMemorySource[] = memoryRows.results.map((row) => ({
      capturedAt: row.captured_at,
      transcript: row.transcript,
      visualSummary: row.visual_summary,
      visualSegments: (segmentsByAsset.get(row.id) ?? []).map((segment) => ({
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        caption: segment.caption,
      })),
    }));
    const fetchedCharacters = sources.reduce((total, source) => total
      + Array.from(source.transcript ?? "").length
      + Array.from(source.visualSummary ?? "").length
      + source.visualSegments.reduce((segmentTotal, segment) => segmentTotal + Array.from(segment.caption).length, 0), 0);
    if (fetchedCharacters > MAX_DAILY_SUMMARY_SOURCE_CHARACTERS) {
      return errorResponse(context, 413, "daily_summary_too_large", "This day is too large to summarize.");
    }

    const sourceTranscriptCount = memoryRows.results.filter((row) => row.transcript !== null).length;
    const sourceVisualAnalysisCount = memoryRows.results.filter((row) => row.visual_summary !== null).length;
    const digestSources = sourceVisualAnalysisCount === 0
      ? memoryRows.results.map((row) => [
        row.id,
        row.captured_at,
        row.transcription_updated_at,
        row.transcript,
      ])
      : memoryRows.results.map((row) => [
        row.id,
        row.captured_at,
        row.transcription_updated_at,
        row.transcript,
        row.visual_updated_at,
        row.visual_model_id,
        row.visual_model_revision,
        row.visual_backend,
        row.visual_coverage_mode,
        row.visual_summary,
        (segmentsByAsset.get(row.id) ?? []).map((segment) => [
          segment.position,
          segment.start_ms,
          segment.end_ms,
          segment.caption,
        ]),
      ]);
    const sourceDigest = await sha256Hex(JSON.stringify(digestSources));
    const model = configuredDailySummaryModel(context.env);
    const cached = await context.env.DB.prepare(
      `SELECT source_digest, source_transcript_count, source_visual_analysis_count,
              summary, model, generated_at
         FROM daily_summaries
        WHERE user_id = ? AND source_digest = ? AND model = ?
        ORDER BY generated_at DESC LIMIT 1`,
    ).bind(auth.userId, sourceDigest, model).first<DailySummaryCacheRow>();
    if (cached?.source_digest === sourceDigest && cached.model === model) {
      return context.json({
        startAt: startIso,
        endAt: endIso,
        summary: cached.summary,
        model: cached.model,
        sourceTranscriptCount: cached.source_transcript_count,
        sourceVisualAnalysisCount: cached.source_visual_analysis_count,
        generatedAt: cached.generated_at,
      });
    }

    const leaseId = await acquireExternalAiWorkLease(
      context.env,
      auth.userId,
      dependencies.now(),
    );
    if (!leaseId) {
      return errorResponse(
        context,
        429,
        "external_ai_work_limit",
        "Too many external AI operations are active.",
      );
    }
    let generated: GeneratedDailySummary;
    try {
      generated = await dependencies.generateDailySummary(context.env, sources);
    } catch {
      console.error(JSON.stringify({ event: "daily_summary_generation_failed", model }));
      return errorResponse(context, 503, "summary_unavailable", "The daily summary is temporarily unavailable.");
    } finally {
      try {
        await context.env.DB.prepare("DELETE FROM external_ai_work_leases WHERE id = ?")
          .bind(leaseId)
          .run();
      } catch {
      }
    }
    if (!await hasActiveAiConsent(context.env, auth.userId)) {
      return errorResponse(
        context,
        403,
        "ai_consent_required",
        "Active AI consent is required for daily summaries.",
      );
    }
    const summary = generated.summary.trim();
    if (
      generated.model !== model
      || !summary
      || /[\r\n]/.test(summary)
      || Array.from(summary).length > DAILY_SUMMARY_MAX_CHARACTERS
    ) {
      console.error(JSON.stringify({ event: "daily_summary_validation_failed", model }));
      return errorResponse(context, 503, "summary_unavailable", "The daily summary is temporarily unavailable.");
    }

    const generatedAt = dependencies.now().toISOString();
    await context.env.DB.prepare(
      `INSERT INTO daily_summaries (
        user_id, start_at, end_at, source_digest, source_transcript_count,
        source_visual_analysis_count, summary, model, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, start_at, end_at) DO UPDATE SET
        source_digest = excluded.source_digest,
        source_transcript_count = excluded.source_transcript_count,
        source_visual_analysis_count = excluded.source_visual_analysis_count,
        summary = excluded.summary,
        model = excluded.model,
        generated_at = excluded.generated_at`,
    ).bind(
      auth.userId,
      startIso,
      endIso,
      sourceDigest,
      sourceTranscriptCount,
      sourceVisualAnalysisCount,
      summary,
      model,
      generatedAt,
    ).run();

    return context.json({
      startAt: startIso,
      endAt: endIso,
      summary,
      model,
      sourceTranscriptCount,
      sourceVisualAnalysisCount,
      generatedAt,
    });
  });

  api.get("/days/playback", async (context) => {
    const auth = context.get("auth");
    const parsed = dailyPlaybackQuerySchema.safeParse({
      startAt: context.req.query("startAt"),
      endAt: context.req.query("endAt"),
    });
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_day_range", "A valid startAt and endAt are required.");
    }

    const startAt = new Date(parsed.data.startAt);
    const endAt = new Date(parsed.data.endAt);
    const spanMs = endAt.getTime() - startAt.getTime();
    if (spanMs <= 0 || spanMs > MAX_DAILY_PLAYBACK_SPAN_MS) {
      return errorResponse(context, 400, "invalid_day_range", "The playback range must be greater than zero and no longer than 48 hours.");
    }

    const startIso = startAt.toISOString();
    const endIso = endAt.toISOString();
    const rangeWhere = `user_id = ? AND kind = 'video' AND status = 'ready'
      AND julianday(captured_at) >= julianday(?) AND julianday(captured_at) < julianday(?)`;
    const bounds = await context.env.DB.prepare(
      `SELECT COUNT(*) AS clip_count,
        COALESCE(SUM(CASE WHEN transcription_status = 'completed' THEN length(COALESCE(transcript, '')) ELSE 0 END), 0) AS transcript_chars
       FROM assets WHERE ${rangeWhere}`,
    ).bind(auth.userId, startIso, endIso).first<{ clip_count: number; transcript_chars: number }>();
    const clipCount = Number(bounds?.clip_count ?? 0);
    const transcriptChars = Number(bounds?.transcript_chars ?? 0);
    if (clipCount > MAX_DAILY_PLAYBACK_CLIPS || transcriptChars > MAX_DAILY_PLAYBACK_TRANSCRIPT_CHARS) {
      return errorResponse(context, 413, "daily_playback_too_large", "This day is too large for combined playback.");
    }

    const select = `SELECT id, user_id, kind, filename, content_type, byte_size, captured_at,
      latitude, longitude, duration_ms, width, height, status, object_key, thumbnail_key,
      upload_mode, upload_id, part_size, created_at, updated_at,
      transcription_status, soniox_file_id, soniox_transcription_id,
      transcript, transcript_language, transcript_error, transcription_updated_at,
      agent_access_enabled, ${ownerVideoAnalysisStatusSql()} FROM assets`;
    const result = await context.env.DB.prepare(
      `${select} WHERE ${rangeWhere}
       ORDER BY julianday(captured_at) ASC, id ASC LIMIT ?`,
    ).bind(
      auth.userId,
      startIso,
      endIso,
      MAX_DAILY_PLAYBACK_CLIPS,
    ).all<AssetRow>();

    let offsetMs = 0;
    const clips = result.results.map((asset) => {
      const durationMs = Math.max(0, Number(asset.duration_ms) || 0);
      const startMs = offsetMs;
      offsetMs += durationMs;
      return {
        asset: assetJson(asset),
        startMs,
        endMs: offsetMs,
        transcript: {
          status: asset.transcription_status,
          language: asset.transcript_language,
          text: asset.transcription_status === "completed" && asset.transcript ? asset.transcript : null,
          updatedAt: asset.transcription_updated_at,
        },
      };
    });

    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
    context.header("Vary", "Authorization");
    return context.json({
      startAt: startIso,
      endAt: endIso,
      clipCount: clips.length,
      durationMs: offsetMs,
      clips,
    });
  });

  api.get("/memories/search", async (context) => {
    setPrivateResponseHeaders(context);
    const parsed = memorySearchSchema.safeParse({
      q: context.req.query("q"),
      cursor: context.req.query("cursor"),
      limit: context.req.query("limit"),
    });
    if (!parsed.success) {
      return errorResponse(context, 400, "invalid_search", "Search query must be 1-200 characters and limit 1-50.");
    }
    const decodedCursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !decodedCursor) {
      return errorResponse(context, 400, "invalid_cursor", "The pagination cursor is invalid.");
    }

    const auth = context.get("auth");
    const pattern = likePattern(parsed.data.q);
    const clauses = [
      "a.user_id = ?",
      "a.kind = 'video'",
      "a.status = 'ready'",
      `(
        a.filename LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR (a.transcription_status = 'completed' AND a.transcript LIKE ? ESCAPE '\\' COLLATE NOCASE)
        OR va.summary LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR matched_segment.analysis_asset_id IS NOT NULL
      )`,
    ];
    const values: unknown[] = [pattern, auth.userId, pattern, pattern, pattern];
    if (decodedCursor) {
      clauses.push("(a.captured_at < ? OR (a.captured_at = ? AND a.id < ?))");
      values.push(decodedCursor[0], decodedCursor[0], decodedCursor[1]);
    }
    values.push(parsed.data.limit + 1);

    const result = await context.env.DB.prepare(
      `SELECT a.id, a.user_id, a.kind, a.filename, a.content_type, a.byte_size, a.captured_at,
              a.latitude, a.longitude, a.duration_ms, a.width, a.height, a.status,
              a.object_key, a.thumbnail_key, a.upload_mode, a.upload_id, a.part_size,
              a.created_at, a.updated_at, a.transcription_status, a.soniox_file_id,
              a.soniox_transcription_id, a.transcript, a.transcript_language,
              a.transcript_error, a.transcription_updated_at, a.agent_access_enabled,
              ${ownerVideoAnalysisStatusSql("a")}, va.summary AS visual_summary,
              matched_segment.position AS matched_segment_position,
              matched_segment.start_ms AS matched_segment_start_ms,
              matched_segment.end_ms AS matched_segment_end_ms,
              matched_segment.caption AS matched_segment_caption
         FROM assets a
         LEFT JOIN video_analyses va
           ON va.asset_id = a.id AND a.agent_access_enabled = 1
         LEFT JOIN video_analysis_segments matched_segment
           ON matched_segment.analysis_asset_id = a.id
          AND va.asset_id IS NOT NULL
          AND matched_segment.position = (
            SELECT MIN(segment.position)
              FROM video_analysis_segments segment
             WHERE segment.analysis_asset_id = a.id
               AND segment.caption LIKE ? ESCAPE '\\' COLLATE NOCASE
          )
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.captured_at DESC, a.id DESC
        LIMIT ?`,
    ).bind(...values).all<MemorySearchRow>();

    const rows = result.results.slice(0, parsed.data.limit);
    const items = rows.map((row) => {
      const match = row.matched_segment_caption
        ? {
          kind: "visual",
          text: row.matched_segment_caption,
          startMs: row.matched_segment_start_ms,
          endMs: row.matched_segment_end_ms,
        }
        : row.visual_summary?.toLocaleLowerCase().includes(parsed.data.q.toLocaleLowerCase())
        ? {
          kind: "visual",
          text: searchExcerpt(row.visual_summary, parsed.data.q),
          startMs: null,
          endMs: null,
        }
        : row.transcription_status === "completed"
          && row.transcript
          && row.transcript.toLocaleLowerCase().includes(parsed.data.q.toLocaleLowerCase())
        ? {
          kind: "transcript",
          text: searchExcerpt(row.transcript, parsed.data.q),
          startMs: null,
          endMs: null,
        }
        : {
          kind: "filename",
          text: row.filename,
          startMs: null,
          endMs: null,
        };
      return {
        asset: assetJson(row),
        match,
        visualSummary: row.visual_summary,
      };
    });
    const last = rows.at(-1);
    return context.json({
      items,
      nextCursor: result.results.length > parsed.data.limit && last ? encodeCursor(last) : null,
    });
  });

  api.get("/assets/:assetId/analysis", async (context) => {
    setPrivateResponseHeaders(context);
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.kind !== "video" || asset.status !== "ready") {
      return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    }

    const requestedStatus = asset.video_analysis_status ?? "unavailable";
    const [analysis, coverage, segments] = requestedStatus === "completed"
      ? await Promise.all([
        context.env.DB.prepare(
          `SELECT va.model_id, va.model_revision, va.backend, va.coverage_mode,
                  va.summary, va.updated_at
             FROM video_analyses va
             JOIN assets a ON a.id = va.asset_id
            WHERE va.asset_id = ? AND a.user_id = ? AND a.kind = 'video'
              AND a.status = 'ready' AND a.agent_access_enabled = 1`,
        ).bind(asset.id, auth.userId).first<VideoAnalysisRow>(),
        context.env.DB.prepare(
          `SELECT range_item.position, range_item.start_ms, range_item.end_ms
             FROM video_analysis_ranges range_item
             JOIN assets a ON a.id = range_item.analysis_asset_id
            WHERE range_item.analysis_asset_id = ? AND a.user_id = ?
              AND a.kind = 'video' AND a.status = 'ready' AND a.agent_access_enabled = 1
            ORDER BY range_item.position`,
        ).bind(asset.id, auth.userId).all<VideoAnalysisRangeRow>(),
        context.env.DB.prepare(
          `SELECT segment.position, segment.start_ms, segment.end_ms, segment.caption
             FROM video_analysis_segments segment
             JOIN assets a ON a.id = segment.analysis_asset_id
            WHERE segment.analysis_asset_id = ? AND a.user_id = ?
              AND a.kind = 'video' AND a.status = 'ready' AND a.agent_access_enabled = 1
            ORDER BY segment.position`,
        ).bind(asset.id, auth.userId).all<VideoAnalysisSegmentRow>(),
      ])
      : [null, { results: [] as VideoAnalysisRangeRow[] }, { results: [] as VideoAnalysisSegmentRow[] }];
    const status = analysis ? "completed" : requestedStatus === "completed" ? "unavailable" : requestedStatus;
    return context.json({
      assetId: asset.id,
      status,
      summary: analysis?.summary ?? null,
      modelId: analysis?.model_id ?? null,
      modelRevision: analysis?.model_revision ?? null,
      backend: analysis?.backend ?? null,
      coverageMode: analysis?.coverage_mode ?? null,
      coverage: coverage.results.map((range) => ({
        position: range.position,
        startMs: range.start_ms,
        endMs: range.end_ms,
      })),
      segments: segments.results.map((segment) => ({
        position: segment.position,
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        caption: segment.caption,
      })),
      updatedAt: analysis?.updated_at ?? null,
    });
  });

  api.get("/assets", async (context) => {
    const auth = context.get("auth");
    const requestedLimit = Number(context.req.query("limit") ?? 30);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
    const rawCursor = context.req.query("cursor");
    const cursor = decodeCursor(rawCursor);
    if (rawCursor && !cursor) return errorResponse(context, 400, "invalid_cursor", "Timeline cursor is invalid.");

    const select = `SELECT id, user_id, kind, filename, content_type, byte_size, captured_at,
      latitude, longitude, duration_ms, width, height, status, object_key, thumbnail_key,
      upload_mode, upload_id, part_size, created_at, updated_at,
      transcription_status, soniox_file_id, soniox_transcription_id,
      transcript, transcript_language, transcript_error, transcription_updated_at,
      agent_access_enabled, ${ownerVideoAnalysisStatusSql()} FROM assets`;
    const statement = cursor
      ? context.env.DB.prepare(
          `${select} WHERE user_id = ? AND status IN ('uploading', 'ready')
             AND (captured_at < ? OR (captured_at = ? AND id < ?))
           ORDER BY captured_at DESC, id DESC LIMIT ?`,
        ).bind(auth.userId, cursor[0], cursor[0], cursor[1], limit + 1)
      : context.env.DB.prepare(
          `${select} WHERE user_id = ? AND status IN ('uploading', 'ready')
           ORDER BY captured_at DESC, id DESC LIMIT ?`,
        ).bind(auth.userId, limit + 1);
    const result = await statement.all<AssetRow>();
    const hasMore = result.results.length > limit;
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return context.json({
      items: rows.map(assetJson),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  });

  api.get("/assets/:assetId/content", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset || asset.status !== "ready") return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    return serveAssetBody(context, asset);
  });

  api.get("/assets/:assetId/transcript", async (context) => {
    const auth = context.get("auth");
    const asset = await findOwnedAsset(context.env, context.req.param("assetId"), auth.userId);
    if (!asset) return errorResponse(context, 404, "asset_not_found", "Asset was not found.");
    if (asset.transcription_status !== "completed" || !asset.transcript) {
      return errorResponse(context, 404, "transcript_not_found", "Transcript is not available.");
    }
    return context.json({
      assetId: asset.id,
      status: asset.transcription_status,
      language: asset.transcript_language,
      text: asset.transcript,
      updatedAt: asset.transcription_updated_at,
    });
  });

  app.route("/v1/internal/gpu-jobs", createGpuJobRoutes({ now: dependencies.now }));
  app.route("/v1", api);
  app.notFound((context) => errorResponse(context, 404, "not_found", "Route was not found."));
  app.onError((error, context) => {
    console.error(JSON.stringify({ event: "request_failed", message: error.message }));
    return errorResponse(context, 500, "internal_error", "The request could not be completed.");
  });

  return app;
}
