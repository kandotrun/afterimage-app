import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  verifyAppleIdentityToken as verifyAppleIdentityTokenAgainstApple,
  type AppleIdentity,
} from "./apple";
import {
  uploadToSoniox,
  createTranscription,
  getTranscriptionStatus,
  getTranscript,
  cleanupSoniox,
} from "./soniox";

export type { AppleIdentity } from "./apple";

type VerifyAppleIdentityToken = (
  identityToken: string,
  audience: string,
) => Promise<AppleIdentity>;

interface AppDependencies {
  verifyAppleIdentityToken: VerifyAppleIdentityToken;
  now: () => Date;
}

interface AuthContext {
  sessionId: string;
  userId: string;
  appleSubject: string;
  email: string | null;
  displayName: string | null;
}

type AppEnvironment = {
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

const appleAuthSchema = z.object({
  identityToken: z.string().min(10).max(16_384),
  displayName: z.string().trim().min(1).max(100).optional(),
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

const assetSchema = z.object({
  kind: z.enum(["photo", "video"]),
  filename: z.string().trim().min(1).max(255).refine(
    (value) => value !== "." && value !== ".." && !/[\/\\\0]/.test(value),
    "unsafe filename",
  ),
  contentType: z.enum(contentTypes),
  byteSize: z.number().int().positive().max(50 * 1024 * 1024 * 1024),
  capturedAt: z.string().datetime({ offset: true }),
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

function userJson(user: UserRow) {
  return {
    id: user.id,
    appleSubject: user.apple_subject,
    email: user.email,
    displayName: user.display_name,
  };
}

function assetJson(asset: AssetRow) {
  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    contentType: asset.content_type,
    byteSize: asset.byte_size,
    capturedAt: asset.captured_at,
    durationMs: asset.duration_ms,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    contentUrl: asset.status === "ready" ? `/v1/assets/${asset.id}/content` : null,
    thumbnailUrl: asset.thumbnail_key ? `/v1/assets/${asset.id}/thumbnail` : null,
    transcriptionStatus: asset.transcription_status ?? null,
    transcriptUrl: asset.transcription_status === "completed" ? `/v1/assets/${asset.id}/transcript` : null,
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  };
}

async function findOwnedAsset(bindings: Env, assetId: string, userId: string): Promise<AssetRow | null> {
  return bindings.DB.prepare(
    `SELECT id, user_id, kind, filename, content_type, byte_size, captured_at,
            duration_ms, width, height, status, object_key, thumbnail_key,
            upload_mode, upload_id, part_size, created_at, updated_at,
            transcription_status, soniox_file_id, soniox_transcription_id,
            transcript, transcript_language, transcript_error, transcription_updated_at
       FROM assets WHERE id = ? AND user_id = ?`,
  ).bind(assetId, userId).first<AssetRow>();
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

async function serveAssetBody(context: Context<AppEnvironment>, asset: AssetRow) {
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
        WHERE s.token_hash = ? AND s.expires_at > ?`,
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

interface TranscriptionPollRow {
  id: string;
  user_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  transcription_status: string;
  soniox_file_id: string | null;
  soniox_transcription_id: string | null;
}

/**
 * Poll pending/processing video assets and advance their Soniox transcription state.
 * Called from the scheduled handler every 5 minutes.
 */
export async function pollTranscriptions(bindings: Env, now = new Date()) {
  if (!bindings.SONIOX_API_KEY) return { processed: 0 };
  const nowIso = now.toISOString();
  const staleProcessing = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  // Pick up pending assets (not yet uploaded to Soniox) and stale processing ones.
  const pending = await bindings.DB.prepare(
    `SELECT id, user_id, object_key, filename, content_type,
            transcription_status, soniox_file_id, soniox_transcription_id
       FROM assets
      WHERE kind = 'video' AND status = 'ready'
        AND (
          transcription_status = 'pending'
          OR (transcription_status = 'processing' AND transcription_updated_at <= ?)
        )
      ORDER BY transcription_updated_at ASC LIMIT 10`,
  ).bind(staleProcessing).all<TranscriptionPollRow>();

  let processed = 0;
  for (const asset of pending.results) {
    try {
      if (asset.transcription_status === "pending" || !asset.soniox_transcription_id) {
        // Upload media to Soniox and create transcription job.
        const object = await bindings.MEDIA.get(asset.object_key);
        if (!object) {
          await bindings.DB.prepare(
            "UPDATE assets SET transcription_status = 'failed', transcript_error = 'media_not_found', transcription_updated_at = ? WHERE id = ?",
          ).bind(nowIso, asset.id).run();
          continue;
        }
        const bytes = await object.arrayBuffer();
        const fileId = await uploadToSoniox(bindings, bytes, asset.filename, asset.content_type);
        const transcriptionId = await createTranscription(bindings, fileId);
        await bindings.DB.prepare(
          `UPDATE assets SET transcription_status = 'processing', soniox_file_id = ?, soniox_transcription_id = ?, transcription_updated_at = ?
            WHERE id = ? AND transcription_status IN ('pending', 'processing')`,
        ).bind(fileId, transcriptionId, nowIso, asset.id).run();
        processed++;
      } else {
        // Check status of an in-flight Soniox transcription.
        const status = await getTranscriptionStatus(bindings, asset.soniox_transcription_id);
        if (status.status === "completed") {
          const transcript = await getTranscript(bindings, asset.soniox_transcription_id);
          await bindings.DB.prepare(
            `UPDATE assets SET transcription_status = 'completed', transcript = ?, transcript_language = ?,
              transcript_error = NULL, transcription_updated_at = ?
              WHERE id = ? AND transcription_status = 'processing'`,
          ).bind(transcript.text || "", transcript.language || null, nowIso, asset.id).run();
          await cleanupSoniox(bindings, asset.soniox_transcription_id, asset.soniox_file_id);
          processed++;
        } else if (status.status === "error") {
          await bindings.DB.prepare(
            `UPDATE assets SET transcription_status = 'failed', transcript_error = ?, transcription_updated_at = ?
              WHERE id = ? AND transcription_status = 'processing'`,
          ).bind(status.error_message || "soniox_error", nowIso, asset.id).run();
          await cleanupSoniox(bindings, asset.soniox_transcription_id, asset.soniox_file_id);
          processed++;
        }
        // queued/processing: leave for next poll.
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "transcription_poll_error", assetId: asset.id, message: String(error) }));
    }
  }
  return { processed };
}

export async function cleanupExpiredState(bindings: Env, now = new Date()) {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [expiredSessions, expiredGrants] = await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso),
    bindings.DB.prepare("DELETE FROM media_grants WHERE expires_at <= ?").bind(nowIso),
  ]);
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
    quarantinedAssets,
    abandonedAssets,
  };
}

export function createApp(overrides: Partial<AppDependencies> = {}) {
  const dependencies: AppDependencies = {
    verifyAppleIdentityToken: overrides.verifyAppleIdentityToken ?? verifyAppleIdentityTokenAgainstApple,
    now: overrides.now ?? (() => new Date()),
  };
  const app = new Hono<AppEnvironment>();

  app.get("/health", (context) => context.json({ ok: true, service: "afterimage-api", version: 1 }));

  app.post("/v1/auth/apple", async (context) => {
    const parsed = appleAuthSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_request", "A valid Apple identity token is required.");

    let identity: AppleIdentity;
    try {
      identity = await dependencies.verifyAppleIdentityToken(
        parsed.data.identityToken,
        context.env.APPLE_BUNDLE_ID,
      );
    } catch {
      return errorResponse(context, 401, "invalid_apple_token", "Apple identity verification failed.");
    }

    const now = dependencies.now();
    const nowIso = now.toISOString();
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
    await context.env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), user.id, await sha256Hex(sessionToken), expiresAt, nowIso).run();

    return context.json({ token: sessionToken, expiresAt, user: userJson(user) });
  });

  // Development login: issues a session without Apple verification.
  // Intended for sideloaded builds where the Sign in with Apple entitlement is unavailable.
  app.post("/v1/auth/dev", async (context) => {
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const devSubject = "dev-kan";
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
    await context.env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), user.id, await sha256Hex(sessionToken), expiresAt, nowIso).run();

    return context.json({ token: sessionToken, expiresAt, user: userJson(user) });
  });

  app.get("/v1/media/:token", async (context) => {
    const token = context.req.param("token");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      return errorResponse(context, 404, "media_grant_not_found", "Playback grant was not found.");
    }
    const asset = await context.env.DB.prepare(
      `SELECT a.id, a.user_id, a.kind, a.filename, a.content_type, a.byte_size, a.captured_at,
              a.duration_ms, a.width, a.height, a.status, a.object_key, a.thumbnail_key,
              a.upload_mode, a.upload_id, a.part_size, a.created_at, a.updated_at
         FROM media_grants g JOIN assets a ON a.id = g.asset_id AND a.user_id = g.user_id
        WHERE g.token_hash = ? AND g.expires_at > ? AND a.status = 'ready'`,
    ).bind(await sha256Hex(token), dependencies.now().toISOString()).first<AssetRow>();
    if (!asset) return errorResponse(context, 404, "media_grant_not_found", "Playback grant was not found.");
    return serveAssetBody(context, asset);
  });

  const api = new Hono<AppEnvironment>();
  api.use("*", authMiddleware(dependencies.now));

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

  api.delete("/auth/session", async (context) => {
    await context.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(context.get("auth").sessionId).run();
    return new Response(null, { status: 204 });
  });

  api.post("/assets", async (context) => {
    const parsed = assetSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_asset", "Asset metadata is invalid.");
    const auth = context.get("auth");
    const nowIso = dependencies.now().toISOString();
    const assetId = crypto.randomUUID();
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
    if (partCount > 10_000) return errorResponse(context, 413, "asset_too_large", "Asset requires too many upload parts.");

    let uploadId: string | null = null;
    let multipart: R2MultipartUpload | null = null;
    if (uploadMode === "multipart") {
      multipart = await context.env.MEDIA.createMultipartUpload(objectKey, {
        httpMetadata: { contentType: parsed.data.contentType },
        customMetadata: { assetId, userId: auth.userId },
      });
      uploadId = multipart.uploadId;
    }

    try {
      await context.env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at,
          duration_ms, width, height, status, object_key, thumbnail_key,
          upload_mode, upload_id, part_size, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, NULL, ?, ?, ?, ?, ?)`,
      ).bind(
        assetId,
        auth.userId,
        parsed.data.kind,
        parsed.data.filename,
        parsed.data.contentType,
        parsed.data.byteSize,
        parsed.data.capturedAt,
        parsed.data.durationMs ?? null,
        parsed.data.width ?? null,
        parsed.data.height ?? null,
        objectKey,
        uploadMode,
        uploadId,
        uploadMode === "multipart" ? partSize : null,
        nowIso,
        nowIso,
      ).run();
    } catch (error) {
      if (multipart) await multipart.abort();
      throw error;
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
    // Queue video assets for async transcription via Soniox.
    if (completed.kind === "video" && context.env.SONIOX_API_KEY) {
      try {
        await context.env.DB.prepare(
          "UPDATE assets SET transcription_status = 'pending', transcription_updated_at = ? WHERE id = ? AND transcription_status IS NULL",
        ).bind(dependencies.now().toISOString(), completed.id).run();
      } catch {
        // Transcription is best-effort; the asset is already ready.
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
    return context.json({ asset: assetJson(completed) });
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
        `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
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

  api.get("/assets", async (context) => {
    const auth = context.get("auth");
    const requestedLimit = Number(context.req.query("limit") ?? 30);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
    const rawCursor = context.req.query("cursor");
    const cursor = decodeCursor(rawCursor);
    if (rawCursor && !cursor) return errorResponse(context, 400, "invalid_cursor", "Timeline cursor is invalid.");

    const select = `SELECT id, user_id, kind, filename, content_type, byte_size, captured_at,
      duration_ms, width, height, status, object_key, thumbnail_key,
      upload_mode, upload_id, part_size, created_at, updated_at FROM assets`;
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

  app.route("/v1", api);
  app.notFound((context) => errorResponse(context, 404, "not_found", "Route was not found."));
  app.onError((error, context) => {
    console.error(JSON.stringify({ event: "request_failed", message: error.message }));
    return errorResponse(context, 500, "internal_error", "The request could not be completed.");
  });

  return app;
}
