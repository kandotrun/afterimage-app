import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppleIdentity } from "../src/app";

const NOW = new Date("2026-07-29T00:00:00.000Z");

function makeApp(identity: AppleIdentity) {
  return createApp({
    verifyAppleIdentityToken: async () => identity,
    now: () => NOW,
  });
}

async function signIn(subject: string) {
  const app = makeApp({
    subject,
    email: `${subject}@example.com`,
    displayName: subject,
  });
  const response = await app.request("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: `token-for-${subject}` }),
  }, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string }>();
  const user = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
    .bind(subject).first<{ id: string }>();
  expect(user).not.toBeNull();
  return { app, authorization: `Bearer ${body.token}`, userId: user!.id };
}

async function insertVideo(options: {
  id: string;
  userId: string;
  capturedAt: string;
  filename?: string;
  transcript?: string | null;
  transcriptionStatus?: "completed" | "pending";
  agentAccessEnabled?: 0 | 1;
}) {
  await env.DB.prepare(
    `INSERT INTO assets (
      id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
      status, object_key, upload_mode, created_at, updated_at,
      transcription_status, transcript, transcript_language, transcription_updated_at,
      agent_access_enabled
    ) VALUES (?, ?, 'video', ?, 'video/mp4', 100, ?, 20000,
      'ready', ?, 'single', ?, ?, ?, ?, 'ja', ?, ?)`,
  ).bind(
    options.id,
    options.userId,
    options.filename ?? `${options.id}.mp4`,
    options.capturedAt,
    `users/${options.userId}/assets/${options.id}/media`,
    NOW.toISOString(),
    NOW.toISOString(),
    options.transcriptionStatus ?? (options.transcript ? "completed" : "pending"),
    options.transcript ?? null,
    NOW.toISOString(),
    options.agentAccessEnabled ?? 1,
  ).run();
}

async function insertPhoto(id: string, userId: string) {
  await env.DB.prepare(
    `INSERT INTO assets (
      id, user_id, kind, filename, content_type, byte_size, captured_at,
      status, object_key, upload_mode, created_at, updated_at, agent_access_enabled
    ) VALUES (?, ?, 'photo', ?, 'image/jpeg', 100, ?,
      'ready', ?, 'single', ?, ?, 1)`,
  ).bind(
    id,
    userId,
    `${id}.jpg`,
    NOW.toISOString(),
    `users/${userId}/assets/${id}/media`,
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
}

async function insertAnalysisJob(options: {
  id: string;
  assetId: string;
  status: "queued" | "leased" | "failed";
  requestJson?: string;
  errorCode?: "output_invalid";
}) {
  await env.DB.prepare(
    `INSERT INTO gpu_jobs (
      id, asset_id, kind, status, request_json, priority, attempt_count,
      available_at, error_code, created_at, updated_at
    ) VALUES (?, ?, 'analysis', ?, ?, 0, 1, ?, ?, ?, ?)`,
  ).bind(
    options.id,
    options.assetId,
    options.status,
    options.requestJson ?? "{}",
    NOW.toISOString(),
    options.errorCode ?? null,
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
}

async function insertAnalysis(options: {
  assetId: string;
  summary: string;
  segments?: Array<{ position: number; startMs: number; endMs: number; caption: string }>;
}) {
  await env.DB.prepare(
    `INSERT INTO video_analyses (
      asset_id, job_id, model_id, model_revision, backend, coverage_mode,
      summary, created_at, updated_at
    ) VALUES (?, ?, 'microsoft/Mage-VL', 'pinned-revision', 'frames', 'full', ?, ?, ?)`,
  ).bind(
    options.assetId,
    `job-${options.assetId}`,
    options.summary,
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
  await env.DB.prepare(
    `INSERT INTO video_analysis_ranges (analysis_asset_id, position, start_ms, end_ms)
     VALUES (?, 0, 0, 20000)`,
  ).bind(options.assetId).run();
  for (const segment of options.segments ?? []) {
    await env.DB.prepare(
      `INSERT INTO video_analysis_segments (
        analysis_asset_id, position, start_ms, end_ms, caption
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      options.assetId,
      segment.position,
      segment.startMs,
      segment.endMs,
      segment.caption,
    ).run();
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_parts"),
    env.DB.prepare("DELETE FROM mcp_tokens"),
    env.DB.prepare("DELETE FROM assets"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});

describe("owner memory search", () => {
  it("searches transcripts and Mage visuals without exposing another owner", async () => {
    const owner = await signIn("memory-search-owner");
    const other = await signIn("memory-search-other");
    await insertVideo({
      id: "11111111-1111-4111-8111-111111111111",
      userId: owner.userId,
      capturedAt: "2026-07-29T08:00:00.000Z",
      transcript: "庭で犬と遊んだ記憶。",
    });
    const visualId = "22222222-2222-4222-8222-222222222222";
    await insertVideo({
      id: visualId,
      userId: owner.userId,
      capturedAt: "2026-07-29T07:00:00.000Z",
    });
    await insertAnalysis({
      assetId: visualId,
      summary: "机の上に鍵を置く様子。",
      segments: [
        { position: 0, startMs: 500, endMs: 1500, caption: "机の上に鍵を置いた。" },
      ],
    });
    await insertVideo({
      id: "33333333-3333-4333-8333-333333333333",
      userId: owner.userId,
      capturedAt: "2026-07-29T06:00:00.000Z",
      transcript: "共有しない秘密の記憶。",
      agentAccessEnabled: 0,
    });
    await insertVideo({
      id: "44444444-4444-4444-8444-444444444444",
      userId: other.userId,
      capturedAt: "2026-07-29T05:00:00.000Z",
      transcript: "他人だけの秘密の記憶。",
    });

    const visualResponse = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("鍵")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(visualResponse.status).toBe(200);
    expect(visualResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(visualResponse.headers.get("pragma")).toBe("no-cache");
    expect(visualResponse.headers.get("vary")).toBe("Authorization");
    await expect(visualResponse.json()).resolves.toEqual({
      items: [{
        asset: expect.objectContaining({
          id: visualId,
          videoAnalysisStatus: "completed",
        }),
        match: {
          kind: "visual",
          text: "机の上に鍵を置いた。",
          startMs: 500,
          endMs: 1500,
        },
        visualSummary: "机の上に鍵を置く様子。",
      }],
      nextCursor: null,
    });

    const disabledResponse = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("共有しない")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    await expect(disabledResponse.json()).resolves.toMatchObject({
      items: [{
        asset: {
          id: "33333333-3333-4333-8333-333333333333",
          agentAccessEnabled: false,
          videoAnalysisStatus: null,
        },
        match: { kind: "transcript", text: "共有しない秘密の記憶。" },
      }],
    });

    const hiddenResponse = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("他人だけ")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    const hiddenBody = await hiddenResponse.text();
    expect(hiddenResponse.status).toBe(200);
    expect(hiddenBody).not.toContain("他人だけの秘密");
    expect(JSON.parse(hiddenBody)).toEqual({ items: [], nextCursor: null });
  });

  it("treats LIKE metacharacters literally and paginates without duplicates", async () => {
    const owner = await signIn("memory-search-literal-owner");
    await insertVideo({
      id: "55555555-5555-4555-8555-555555555555",
      userId: owner.userId,
      capturedAt: "2026-07-29T09:00:00.000Z",
      transcript: "進捗は100%完了した記憶。",
    });
    await insertVideo({
      id: "66666666-6666-4666-8666-666666666666",
      userId: owner.userId,
      capturedAt: "2026-07-29T08:00:00.000Z",
      transcript: "進捗は100パーセント完了した記憶。",
    });
    await insertVideo({
      id: "77777777-7777-4777-8777-777777777777",
      userId: owner.userId,
      capturedAt: "2026-07-29T07:00:00.000Z",
      transcript: "別の記憶。",
    });
    const literalFilenameId = "88888888-8888-4888-8888-888888888888";
    await insertVideo({
      id: literalFilenameId,
      userId: owner.userId,
      capturedAt: "2026-07-29T06:00:00.000Z",
      filename: "report_2026\\final.mp4",
    });
    await insertVideo({
      id: "99999999-9999-4999-8999-999999999999",
      userId: owner.userId,
      capturedAt: "2026-07-29T05:00:00.000Z",
      filename: "reportX2026-final.mp4",
    });
    await insertVideo({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: owner.userId,
      capturedAt: "2026-07-29T04:00:00.000Z",
      transcript: "処理中だけの秘密。",
      transcriptionStatus: "pending",
    });

    const literal = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("%")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    const literalBody = await literal.json<{ items: Array<{ asset: { id: string } }> }>();
    expect(literalBody.items.map((item) => item.asset.id)).toEqual([
      "55555555-5555-4555-8555-555555555555",
    ]);

    const escapedFilename = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("_2026\\")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    await expect(escapedFilename.json()).resolves.toEqual({
      items: [{
        asset: expect.objectContaining({ id: literalFilenameId }),
        match: {
          kind: "filename",
          text: "report_2026\\final.mp4",
          startMs: null,
          endMs: null,
        },
        visualSummary: null,
      }],
      nextCursor: null,
    });

    const filenameWithTranscriptId = "abababab-abab-4bab-8bab-abababababab";
    await insertVideo({
      id: filenameWithTranscriptId,
      userId: owner.userId,
      capturedAt: "2026-07-29T05:30:00.000Z",
      filename: "filename-only-match.mp4",
      transcript: "検索語を含まない文字起こし。",
    });
    const filenameWithTranscript = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("filename-only")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    await expect(filenameWithTranscript.json()).resolves.toMatchObject({
      items: [{
        asset: { id: filenameWithTranscriptId },
        match: { kind: "filename", text: "filename-only-match.mp4" },
      }],
    });

    const pendingTranscript = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("処理中だけ")}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    await expect(pendingTranscript.json()).resolves.toEqual({ items: [], nextCursor: null });

    const first = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("記憶")}&limit=1`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    const firstBody = await first.json<{
      items: Array<{ asset: { id: string } }>;
      nextCursor: string | null;
    }>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await owner.app.request(
      `/v1/memories/search?q=${encodeURIComponent("記憶")}&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { authorization: owner.authorization } },
      env,
    );
    const secondBody = await second.json<{ items: Array<{ asset: { id: string } }> }>();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]!.asset.id).not.toBe(firstBody.items[0]!.asset.id);
  });

  it("requires authentication and a bounded non-empty query", async () => {
    const unauthenticated = await makeApp({ subject: "none" }).request(
      "/v1/memories/search?q=memory",
      {},
      env,
    );
    expect(unauthenticated.status).toBe(401);

    const owner = await signIn("memory-search-validation-owner");
    for (const path of [
      "/v1/memories/search",
      "/v1/memories/search?q=%20%20",
      "/v1/memories/search?q=memory&limit=0",
      "/v1/memories/search?q=memory&limit=51",
      `/v1/memories/search?q=${"x".repeat(201)}`,
    ]) {
      const response = await owner.app.request(
        path,
        { headers: { authorization: owner.authorization } },
        env,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_search" } });
    }

    const invalidCursor = await owner.app.request(
      "/v1/memories/search?q=memory&cursor=invalid",
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({ error: { code: "invalid_cursor" } });
  });
});

describe("owner video analysis detail", () => {
  it("returns ordered Mage results and lifecycle states only to the owner", async () => {
    const owner = await signIn("analysis-detail-owner");
    const other = await signIn("analysis-detail-other");
    const completedId = "88888888-8888-4888-8888-888888888888";
    await insertVideo({
      id: completedId,
      userId: owner.userId,
      capturedAt: "2026-07-29T08:00:00.000Z",
    });
    await insertAnalysis({
      assetId: completedId,
      summary: "犬が庭を走り、玄関で止まる。",
      segments: [
        { position: 1, startMs: 5000, endMs: 7000, caption: "玄関で止まった。" },
        { position: 0, startMs: 1000, endMs: 3000, caption: "犬が庭を走った。" },
      ],
    });

    const queuedId = "99999999-9999-4999-8999-999999999999";
    await insertVideo({
      id: queuedId,
      userId: owner.userId,
      capturedAt: "2026-07-29T07:00:00.000Z",
    });
    await insertAnalysisJob({ id: "queued-detail-job", assetId: queuedId, status: "queued" });

    const processingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await insertVideo({
      id: processingId,
      userId: owner.userId,
      capturedAt: "2026-07-29T06:30:00.000Z",
    });
    await insertAnalysisJob({ id: "processing-detail-job", assetId: processingId, status: "leased" });

    const failedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await insertVideo({
      id: failedId,
      userId: owner.userId,
      capturedAt: "2026-07-29T06:15:00.000Z",
    });
    await insertAnalysisJob({
      id: "failed-detail-job",
      assetId: failedId,
      status: "failed",
      requestJson: JSON.stringify({ internalSecret: "must-not-escape" }),
      errorCode: "output_invalid",
    });

    const unavailableId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await insertVideo({
      id: unavailableId,
      userId: owner.userId,
      capturedAt: "2026-07-29T06:00:00.000Z",
      agentAccessEnabled: 0,
    });

    const completed = await owner.app.request(`/v1/assets/${completedId}/analysis`, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("cache-control")).toBe("private, no-store");
    await expect(completed.json()).resolves.toEqual({
      assetId: completedId,
      status: "completed",
      summary: "犬が庭を走り、玄関で止まる。",
      modelId: "microsoft/Mage-VL",
      modelRevision: "pinned-revision",
      backend: "frames",
      coverageMode: "full",
      coverage: [{ position: 0, startMs: 0, endMs: 20000 }],
      segments: [
        { position: 0, startMs: 1000, endMs: 3000, caption: "犬が庭を走った。" },
        { position: 1, startMs: 5000, endMs: 7000, caption: "玄関で止まった。" },
      ],
      updatedAt: NOW.toISOString(),
    });

    const queued = await owner.app.request(`/v1/assets/${queuedId}/analysis`, {
      headers: { authorization: owner.authorization },
    }, env);
    await expect(queued.json()).resolves.toEqual({
      assetId: queuedId,
      status: "queued",
      summary: null,
      modelId: null,
      modelRevision: null,
      backend: null,
      coverageMode: null,
      coverage: [],
      segments: [],
      updatedAt: null,
    });

    for (const [assetId, status] of [
      [processingId, "processing"],
      [failedId, "failed"],
    ] as const) {
      const response = await owner.app.request(`/v1/assets/${assetId}/analysis`, {
        headers: { authorization: owner.authorization },
      }, env);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("must-not-escape");
      expect(body).not.toContain("output_invalid");
      expect(JSON.parse(body)).toEqual({
        assetId,
        status,
        summary: null,
        modelId: null,
        modelRevision: null,
        backend: null,
        coverageMode: null,
        coverage: [],
        segments: [],
        updatedAt: null,
      });
    }

    const unavailable = await owner.app.request(`/v1/assets/${unavailableId}/analysis`, {
      headers: { authorization: owner.authorization },
    }, env);
    await expect(unavailable.json()).resolves.toMatchObject({
      assetId: unavailableId,
      status: "unavailable",
      summary: null,
      coverage: [],
      segments: [],
    });

    const forbidden = await other.app.request(`/v1/assets/${completedId}/analysis`, {
      headers: { authorization: other.authorization },
    }, env);
    expect(forbidden.status).toBe(404);
    const forbiddenBody = await forbidden.text();
    expect(forbiddenBody).not.toContain("犬が庭を走り");
    expect(forbiddenBody).not.toContain("microsoft/Mage-VL");
    expect(forbidden.headers.get("cache-control")).toBe("private, no-store");

    const photoId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertPhoto(photoId, owner.userId);
    const missingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const notFoundBodies: string[] = [];
    for (const assetId of [photoId, missingId]) {
      const response = await owner.app.request(`/v1/assets/${assetId}/analysis`, {
        headers: { authorization: owner.authorization },
      }, env);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      notFoundBodies.push(await response.text());
    }
    expect(notFoundBodies[0]).toBe(forbiddenBody);
    expect(notFoundBodies[1]).toBe(forbiddenBody);
  });
});
