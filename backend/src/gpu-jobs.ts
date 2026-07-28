import { Hono, type Context } from "hono";
import { z } from "zod";

type GpuEnvironment = {
  Bindings: Env;
};

type GpuJobDependencies = {
  now: () => Date;
};

type GpuJobRow = {
  id: string;
  asset_id: string;
  kind: "analysis" | "frame" | "clip";
  request_json: string;
  attempt_count: number;
};

type GpuAssetRow = {
  id: string;
  user_id: string;
  content_type: string;
  byte_size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  captured_at: string;
};

const modelId = "microsoft/Mage-VL";
const modelRevision = "8484f3154beea3b563bee99e2fab2d6c8bb5d3f3";
const leaseDurationMs = 15 * 60 * 1_000;
const mediaGrantDurationMs = 10 * 60 * 1_000;

const leaseSchema = z.object({
  workerId: z.string().trim().min(1).max(100),
  capabilities: z.object({
    backends: z.array(z.enum(["frames", "codec"])).min(1).max(2),
    modelId: z.literal(modelId),
  }).strict(),
}).strict();

const leaseTokenSchema = z.object({
  leaseToken: z.string().min(32).max(256),
}).strict();

const rangeSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).refine((value) => value.endMs > value.startMs);

const analysisSchema = z.object({
  leaseToken: z.string().min(32).max(256),
  modelId: z.literal(modelId),
  modelRevision: z.literal(modelRevision),
  backend: z.enum(["frames", "codec"]),
  coverageMode: z.enum(["full", "sampled"]),
  analyzedRanges: z.array(rangeSchema).min(1).max(30),
  summary: z.string().trim().min(1).max(8_000),
  segments: z.array(z.object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    caption: z.string().trim().min(1).max(2_000),
  }).refine((value) => value.endMs > value.startMs)).max(200),
}).strict();

const failureCodes = [
  "download_failed",
  "size_mismatch",
  "decode_failed",
  "model_load_failed",
  "inference_failed",
  "output_invalid",
  "disk_space_low",
  "cancelled",
] as const;

const failureSchema = z.object({
  leaseToken: z.string().min(32).max(256),
  code: z.enum(failureCodes),
}).strict();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function parseJson(context: Context<GpuEnvironment>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

function errorResponse(
  context: Context<GpuEnvironment>,
  status: 400 | 401 | 404,
  code: string,
  message: string,
) {
  return context.json({ error: { code, message } }, status);
}

async function validLease(
  context: Context<GpuEnvironment>,
  jobId: string,
  leaseTokenHash: string,
  nowIso: string,
) {
  return context.env.DB.prepare(
    `SELECT j.id, j.asset_id, j.kind, j.attempt_count, a.user_id, a.duration_ms
       FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
      WHERE j.id = ? AND j.status = 'leased' AND j.lease_token_hash = ?
        AND j.lease_expires_at > ? AND a.kind = 'video' AND a.status = 'ready'
        AND a.agent_access_enabled = 1`,
  ).bind(jobId, leaseTokenHash, nowIso).first<{
    id: string;
    asset_id: string;
    kind: "analysis" | "frame" | "clip";
    attempt_count: number;
    user_id: string;
    duration_ms: number | null;
  }>();
}

export function createGpuJobRoutes(dependencies: GpuJobDependencies) {
  const app = new Hono<GpuEnvironment>();

  app.use("*", async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = authorization ? /^Bearer (aft_worker_[A-Za-z0-9_-]{43})$/.exec(authorization) : null;
    if (!match?.[1] || !context.env.MAGE_WORKER_TOKEN_HASH) {
      return errorResponse(context, 401, "unauthorized", "A valid worker bearer is required.");
    }
    if (await sha256Hex(match[1]) !== context.env.MAGE_WORKER_TOKEN_HASH) {
      return errorResponse(context, 401, "unauthorized", "The worker bearer is invalid.");
    }
    await next();
  });

  app.post("/lease", async (context) => {
    const parsed = leaseSchema.safeParse(await parseJson(context));
    if (!parsed.success || !parsed.data.capabilities.backends.includes("frames")) {
      return errorResponse(context, 400, "invalid_worker_capabilities", "Worker capabilities are invalid.");
    }
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const leaseToken = randomToken();
    const leaseTokenHash = await sha256Hex(leaseToken);
    const row = await context.env.DB.prepare(
      `UPDATE gpu_jobs
          SET status = 'leased', lease_token_hash = ?, lease_expires_at = ?,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = (
          SELECT j.id
            FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
           WHERE a.kind = 'video' AND a.status = 'ready' AND a.agent_access_enabled = 1
             AND j.attempt_count < 3
             AND (
               (j.status = 'queued' AND j.available_at <= ?)
               OR (j.status = 'leased' AND j.lease_expires_at <= ?)
             )
           ORDER BY j.priority DESC, j.available_at ASC, j.created_at ASC
           LIMIT 1
        )
      RETURNING id, asset_id, kind, request_json, attempt_count`,
    ).bind(
      leaseTokenHash,
      leaseExpiresAt,
      nowIso,
      nowIso,
      nowIso,
    ).first<GpuJobRow>();
    if (!row) return new Response(null, { status: 204 });

    const asset = await context.env.DB.prepare(
      `SELECT id, user_id, content_type, byte_size, duration_ms, width, height, captured_at
         FROM assets
        WHERE id = ? AND kind = 'video' AND status = 'ready' AND agent_access_enabled = 1`,
    ).bind(row.asset_id).first<GpuAssetRow>();
    if (!asset) {
      await context.env.DB.prepare("DELETE FROM gpu_jobs WHERE id = ?").bind(row.id).run();
      return new Response(null, { status: 204 });
    }

    const mediaToken = randomToken();
    const mediaExpiresAt = new Date(now.getTime() + mediaGrantDurationMs).toISOString();
    const granted = await context.env.DB.prepare(
      `INSERT INTO media_grants (
        id, asset_id, user_id, token_hash, expires_at, created_at, purpose
      )
      SELECT ?, a.id, a.user_id, ?, ?, ?, 'worker'
        FROM assets a JOIN gpu_jobs j ON j.asset_id = a.id
       WHERE a.id = ? AND a.kind = 'video' AND a.status = 'ready'
         AND a.agent_access_enabled = 1
         AND j.id = ? AND j.status = 'leased' AND j.lease_token_hash = ?
         AND j.lease_expires_at > ?`,
    ).bind(
      crypto.randomUUID(),
      await sha256Hex(mediaToken),
      mediaExpiresAt,
      nowIso,
      asset.id,
      row.id,
      leaseTokenHash,
      nowIso,
    ).run();
    if ((granted.meta.changes ?? 0) !== 1) {
      await context.env.DB.prepare(
        "DELETE FROM gpu_jobs WHERE id = ? AND status = 'leased' AND lease_token_hash = ?",
      ).bind(row.id, leaseTokenHash).run();
      return new Response(null, { status: 204 });
    }

    const mediaUrl = new URL(`/v1/media/${mediaToken}`, context.req.url);
    if (String(context.env.ENVIRONMENT) === "production") mediaUrl.protocol = "https:";
    return context.json({
      job: {
        id: row.id,
        kind: row.kind,
        leaseToken,
        leaseExpiresAt,
        asset: {
          id: asset.id,
          contentType: asset.content_type,
          byteSize: asset.byte_size,
          durationMs: asset.duration_ms,
          width: asset.width,
          height: asset.height,
          capturedAt: asset.captured_at,
        },
        media: {
          url: mediaUrl.toString(),
          expiresAt: mediaExpiresAt,
        },
        analysis: row.kind === "analysis" ? {
          modelId,
          modelRevision,
          backend: "frames",
        } : undefined,
        request: JSON.parse(row.request_json) as unknown,
      },
    });
  });

  app.post("/:jobId/heartbeat", async (context) => {
    const parsed = leaseTokenSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_heartbeat", "Heartbeat is invalid.");
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const leaseTokenHash = await sha256Hex(parsed.data.leaseToken);
    const lease = await validLease(context, context.req.param("jobId"), leaseTokenHash, nowIso);
    if (!lease) return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const updated = await context.env.DB.prepare(
      `UPDATE gpu_jobs
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token_hash = ?
          AND lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM assets a
             WHERE a.id = gpu_jobs.asset_id AND a.kind = 'video'
               AND a.status = 'ready' AND a.agent_access_enabled = 1
          )
      RETURNING id`,
    ).bind(leaseExpiresAt, nowIso, lease.id, leaseTokenHash, nowIso).first<{ id: string }>();
    if (!updated) return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    return context.json({ status: "leased", leaseExpiresAt });
  });

  app.post("/:jobId/analysis", async (context) => {
    const parsed = analysisSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_analysis", "Analysis result is invalid.");
    const nowIso = dependencies.now().toISOString();
    const jobId = context.req.param("jobId");
    const leaseTokenHash = await sha256Hex(parsed.data.leaseToken);
    const lease = await validLease(context, jobId, leaseTokenHash, nowIso);
    if (!lease) return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    const durationMs = lease.duration_ms;
    const inBounds = [...parsed.data.analyzedRanges, ...parsed.data.segments]
      .every((range) => durationMs === null || range.endMs <= durationMs);
    if (!inBounds) return errorResponse(context, 400, "invalid_analysis", "Analysis ranges are invalid.");

    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `DELETE FROM video_analyses
          WHERE asset_id = ?
            AND EXISTS (
              SELECT 1 FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
               WHERE j.id = ? AND j.asset_id = ? AND j.status = 'leased'
                 AND j.lease_token_hash = ? AND j.lease_expires_at > ?
                 AND a.kind = 'video' AND a.status = 'ready'
                 AND a.agent_access_enabled = 1
            )`,
      ).bind(lease.asset_id, jobId, lease.asset_id, leaseTokenHash, nowIso),
      context.env.DB.prepare(
        `INSERT INTO video_analyses (
          asset_id, job_id, model_id, model_revision, backend, coverage_mode,
          summary, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
            WHERE j.id = ? AND j.asset_id = ? AND j.status = 'leased'
              AND j.lease_token_hash = ? AND j.lease_expires_at > ?
              AND a.kind = 'video' AND a.status = 'ready'
              AND a.agent_access_enabled = 1
         )`,
      ).bind(
        lease.asset_id,
        jobId,
        parsed.data.modelId,
        parsed.data.modelRevision,
        parsed.data.backend,
        parsed.data.coverageMode,
        parsed.data.summary,
        nowIso,
        nowIso,
        jobId,
        lease.asset_id,
        leaseTokenHash,
        nowIso,
      ),
      ...parsed.data.analyzedRanges.map((range, position) => context.env.DB.prepare(
        `INSERT INTO video_analysis_ranges (
          analysis_asset_id, position, start_ms, end_ms
        )
        SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
             FROM video_analyses va
             JOIN gpu_jobs j ON j.id = va.job_id
             JOIN assets a ON a.id = j.asset_id
            WHERE va.asset_id = ? AND va.job_id = ?
              AND j.status = 'leased' AND j.lease_token_hash = ?
              AND j.lease_expires_at > ? AND a.agent_access_enabled = 1
         )`,
      ).bind(
        lease.asset_id,
        position,
        range.startMs,
        range.endMs,
        lease.asset_id,
        jobId,
        leaseTokenHash,
        nowIso,
      )),
      ...parsed.data.segments.map((segment, position) => context.env.DB.prepare(
        `INSERT INTO video_analysis_segments (
          analysis_asset_id, position, start_ms, end_ms, caption
        )
        SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
             FROM video_analyses va
             JOIN gpu_jobs j ON j.id = va.job_id
             JOIN assets a ON a.id = j.asset_id
            WHERE va.asset_id = ? AND va.job_id = ?
              AND j.status = 'leased' AND j.lease_token_hash = ?
              AND j.lease_expires_at > ? AND a.agent_access_enabled = 1
         )`,
      ).bind(
        lease.asset_id,
        position,
        segment.startMs,
        segment.endMs,
        segment.caption,
        lease.asset_id,
        jobId,
        leaseTokenHash,
        nowIso,
      )),
      context.env.DB.prepare(
        `DELETE FROM gpu_jobs
          WHERE id = ? AND asset_id = ? AND status = 'leased'
            AND lease_token_hash = ? AND lease_expires_at > ?
            AND EXISTS (
              SELECT 1 FROM assets a
               WHERE a.id = gpu_jobs.asset_id AND a.kind = 'video'
                 AND a.status = 'ready' AND a.agent_access_enabled = 1
            )`,
      ).bind(jobId, lease.asset_id, leaseTokenHash, nowIso),
    ]);
    if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    }
    return context.json({ status: "completed" });
  });

  app.put("/:jobId/derivative", async (context) => {
    const leaseToken = context.req.header("x-afterimage-lease-token");
    if (!leaseToken || leaseToken.length < 32 || leaseToken.length > 256) {
      return errorResponse(context, 400, "invalid_derivative", "Derivative lease token is invalid.");
    }
    const nowIso = dependencies.now().toISOString();
    const jobId = context.req.param("jobId");
    const leaseTokenHash = await sha256Hex(leaseToken);
    const lease = await validLease(context, jobId, leaseTokenHash, nowIso);
    if (!lease || lease.kind === "analysis") {
      return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    }
    const derivative = await context.env.DB.prepare(
      `SELECT id, kind
         FROM media_derivatives
        WHERE job_id = ? AND asset_id = ? AND status = 'queued'`,
    ).bind(context.req.param("jobId"), lease.asset_id).first<{
      id: string;
      kind: "frame" | "clip";
    }>();
    if (!derivative || derivative.kind !== lease.kind) {
      return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    }
    const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
    const expectedType = derivative.kind === "frame" ? "image/jpeg" : "video/mp4";
    const contentLength = Number(context.req.header("content-length"));
    const maximumBytes = derivative.kind === "frame" ? 10 * 1024 * 1024 : 512 * 1024 * 1024;
    if (contentType !== expectedType
      || !Number.isSafeInteger(contentLength)
      || contentLength <= 0
      || contentLength > maximumBytes
      || !context.req.raw.body) {
      return errorResponse(context, 400, "invalid_derivative", "Derivative body is invalid.");
    }
    const extension = derivative.kind === "frame" ? "jpg" : "mp4";
    const objectKey = [
      `users/${lease.user_id}/assets/${lease.asset_id}/derivatives`,
      `${derivative.id}/${crypto.randomUUID()}.${extension}`,
    ].join("/");
    const object = await context.env.MEDIA.put(objectKey, context.req.raw.body, {
      httpMetadata: { contentType: expectedType },
      customMetadata: {
        assetId: lease.asset_id,
        derivativeId: derivative.id,
        role: derivative.kind,
      },
    });
    if (object.size !== contentLength) {
      await context.env.MEDIA.delete(objectKey);
      return errorResponse(context, 400, "size_mismatch", "Derivative size differs from metadata.");
    }
    const [updated, deleted] = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE media_derivatives
            SET status = 'ready', object_key = ?, content_type = ?, byte_size = ?, updated_at = ?
          WHERE id = ? AND job_id = ? AND asset_id = ? AND status = 'queued'
            AND EXISTS (
            SELECT 1 FROM gpu_jobs j JOIN assets a ON a.id = j.asset_id
             WHERE j.id = media_derivatives.job_id AND j.asset_id = media_derivatives.asset_id
               AND j.status = 'leased' AND j.lease_token_hash = ?
               AND j.lease_expires_at > ? AND a.kind = 'video'
               AND a.status = 'ready' AND a.agent_access_enabled = 1
          )`,
      ).bind(
        objectKey,
        expectedType,
        contentLength,
        nowIso,
        derivative.id,
        jobId,
        lease.asset_id,
        leaseTokenHash,
        nowIso,
      ),
      context.env.DB.prepare(
        `DELETE FROM gpu_jobs
          WHERE id = ? AND asset_id = ? AND status = 'leased'
            AND lease_token_hash = ? AND lease_expires_at > ?
            AND EXISTS (
              SELECT 1 FROM assets a
               WHERE a.id = gpu_jobs.asset_id AND a.kind = 'video'
                 AND a.status = 'ready' AND a.agent_access_enabled = 1
            )`,
      ).bind(jobId, lease.asset_id, leaseTokenHash, nowIso),
    ]);
    if ((updated?.meta.changes ?? 0) !== 1 || (deleted?.meta.changes ?? 0) !== 1) {
      await context.env.MEDIA.delete(objectKey);
      return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    }
    return context.json({ status: "completed", derivativeId: derivative.id });
  });

  app.post("/:jobId/fail", async (context) => {
    const parsed = failureSchema.safeParse(await parseJson(context));
    if (!parsed.success) return errorResponse(context, 400, "invalid_failure", "Failure report is invalid.");
    const now = dependencies.now();
    const nowIso = now.toISOString();
    const jobId = context.req.param("jobId");
    const leaseTokenHash = await sha256Hex(parsed.data.leaseToken);
    const lease = await validLease(context, jobId, leaseTokenHash, nowIso);
    if (!lease) return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    const retryDelayMs = lease.attempt_count === 1 ? 60_000 : 5 * 60_000;
    if (lease.attempt_count >= 3) {
      const [updated] = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE gpu_jobs
              SET status = 'failed', error_code = ?, lease_token_hash = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'leased' AND lease_token_hash = ?
              AND lease_expires_at > ?
              AND EXISTS (
                SELECT 1 FROM assets a
                 WHERE a.id = gpu_jobs.asset_id AND a.kind = 'video'
                   AND a.status = 'ready' AND a.agent_access_enabled = 1
              )`,
        ).bind(parsed.data.code, nowIso, lease.id, leaseTokenHash, nowIso),
        context.env.DB.prepare(
          `UPDATE media_derivatives
              SET status = 'failed', error_code = ?, updated_at = ?
            WHERE job_id = ? AND status = 'queued'
              AND EXISTS (
                SELECT 1 FROM gpu_jobs j
                 WHERE j.id = media_derivatives.job_id AND j.status = 'failed'
                   AND j.error_code = ? AND j.updated_at = ?
              )`,
        ).bind(parsed.data.code, nowIso, jobId, parsed.data.code, nowIso),
      ]);
      if ((updated?.meta.changes ?? 0) !== 1) {
        return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
      }
      return context.json({ status: "failed" });
    }
    const availableAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const updated = await context.env.DB.prepare(
      `UPDATE gpu_jobs
          SET status = 'queued', error_code = ?, available_at = ?,
              lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token_hash = ?
          AND lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM assets a
             WHERE a.id = gpu_jobs.asset_id AND a.kind = 'video'
               AND a.status = 'ready' AND a.agent_access_enabled = 1
          )`,
    ).bind(
      parsed.data.code,
      availableAt,
      nowIso,
      lease.id,
      leaseTokenHash,
      nowIso,
    ).run();
    if ((updated.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 404, "gpu_job_not_found", "GPU job was not found.");
    }
    return context.json({ status: "queued", availableAt });
  });

  return app;
}
