import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredState, createApp, pollTranscriptions, type AppleIdentity } from "../src/app";

const NOW = new Date("2026-07-27T00:00:00.000Z");

type TestDailySummaryGenerator = (
  bindings: Env,
  transcripts: Array<{ capturedAt: string; text: string }>,
) => Promise<{ summary: string; model: string }>;

function makeApp(identity: AppleIdentity = {
  subject: "apple-user-a",
  email: "a@example.com",
  displayName: "A User",
}, generateDailySummary?: TestDailySummaryGenerator) {
  return createApp({
    verifyAppleIdentityToken: async () => identity,
    now: () => NOW,
    ...(generateDailySummary ? { generateDailySummary } : {}),
  });
}

async function signIn(subject = "apple-user-a", generateDailySummary?: TestDailySummaryGenerator) {
  const app = makeApp(
    { subject, email: `${subject}@example.com`, displayName: subject },
    generateDailySummary,
  );
  const response = await app.request("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: `token-for-${subject}` }),
  }, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string }>();
  return { app, authorization: "Bearer " + body.token };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function envWithMediaHooks(hooks: {
  beforePut?: () => Promise<void>;
  afterPut?: () => Promise<void>;
  afterDelete?: () => Promise<void>;
  beforeUploadPart?: () => Promise<void>;
  beforeComplete?: () => Promise<void>;
  afterAbort?: () => Promise<void>;
}): Env {
  const media = new Proxy(env.MEDIA, {
    get(target, property) {
      if (property === "put") {
        return async (
          key: string,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
          options?: R2PutOptions,
        ) => {
          await hooks.beforePut?.();
          const object = await target.put(key, value, options);
          await hooks.afterPut?.();
          return object;
        };
      }
      if (property === "delete") {
        return async (keys: string | string[]) => {
          await target.delete(keys);
          await hooks.afterDelete?.();
        };
      }
      if (property === "resumeMultipartUpload") {
        return (key: string, uploadId: string) => {
          const upload = target.resumeMultipartUpload(key, uploadId);
          return new Proxy(upload, {
            get(multipart, member) {
              if (member === "uploadPart") {
                return async (
                  partNumber: number,
                  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
                  options?: R2UploadPartOptions,
                ) => {
                  await hooks.beforeUploadPart?.();
                  return multipart.uploadPart(partNumber, value, options);
                };
              }
              if (member === "complete") {
                return async (parts: R2UploadedPart[]) => {
                  await hooks.beforeComplete?.();
                  return multipart.complete(parts);
                };
              }
              if (member === "abort") {
                return async () => {
                  await multipart.abort();
                  await hooks.afterAbort?.();
                };
              }
              const multipartMember = Reflect.get(multipart, member, multipart) as unknown;
              return typeof multipartMember === "function" ? multipartMember.bind(multipart) : multipartMember;
            },
          });
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, MEDIA: media };
}

function envWithOneBatchFailure(): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async () => { throw new Error("injected D1 batch failure"); };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
}

function wrapStatementWithCommittedRunFailure(
  statement: D1PreparedStatement,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrapStatementWithCommittedRunFailure(target.bind(...values));
      }
      if (property === "run") {
        return async () => {
          await target.run();
          throw new Error("injected D1 response loss after commit");
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function envWithCommittedRunFailure(sqlFragment: string): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.includes(sqlFragment)
            ? wrapStatementWithCommittedRunFailure(statement)
            : statement;
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
}

function wrapStatementWithRunFailureBeforeCommit(
  statement: D1PreparedStatement,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrapStatementWithRunFailureBeforeCommit(target.bind(...values));
      }
      if (property === "run") {
        return async () => { throw new Error("injected D1 failure before commit"); };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function envWithRunFailureBeforeCommit(sqlFragment: string): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.includes(sqlFragment)
            ? wrapStatementWithRunFailureBeforeCommit(statement)
            : statement;
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health and authentication", () => {
  it("returns a versioned health response", async () => {
    const response = await makeApp().request("/health", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "afterimage-api", version: 1 });
  });

  it("rejects private routes without a bearer session", async () => {
    const response = await makeApp().request("/v1/assets", {}, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
  });

  it("exchanges a verified Apple identity for a reusable bearer session", async () => {
    const { app, authorization } = await signIn();
    const response = await app.request("/v1/me", { headers: { authorization } }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { appleSubject: "apple-user-a", email: "apple-user-a@example.com" },
    });
  });

  it("does not expose development sign-in in production", async () => {
    const response = await makeApp().request("/v1/auth/dev", { method: "POST" }, {
      ...env,
      ENVIRONMENT: "production",
    });
    expect(response.status).toBe(404);
  });

  it("allows development sign-in outside production", async () => {
    const response = await makeApp().request("/v1/auth/dev", { method: "POST" }, env);
    expect(response.status).toBe(200);
  });

  it("revokes the current bearer session on logout", async () => {
    const { app, authorization } = await signIn();
    const logout = await app.request("/v1/auth/session", {
      method: "DELETE",
      headers: { authorization },
    }, env);
    expect(logout.status).toBe(204);

    const reused = await app.request("/v1/me", { headers: { authorization } }, env);
    expect(reused.status).toBe(401);
  });
});

describe("asset upload and private timeline", () => {
  it("stores capture time and optional GPS coordinates and returns them on the timeline", async () => {
    const { app, authorization } = await signIn("capture-metadata-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "hiroshima.mov",
        contentType: "video/quicktime",
        byteSize: 11,
        capturedAt: "2024-04-05T06:07:08.000Z",
        durationMs: 1_200,
        width: 1_920,
        height: 1_080,
        location: { latitude: 34.3853, longitude: 132.4553 },
      }),
    }, env);

    expect(create.status).toBe(201);
    const created = await create.json<{
      asset: {
        id: string;
        capturedAt: string;
        createdAt: string;
        location: { latitude: number; longitude: number } | null;
      };
    }>();
    expect(created.asset).toMatchObject({
      capturedAt: "2024-04-05T06:07:08.000Z",
      createdAt: NOW.toISOString(),
      location: { latitude: 34.3853, longitude: 132.4553 },
    });

    const stored = await env.DB.prepare(
      "SELECT captured_at, latitude, longitude FROM assets WHERE id = ?",
    ).bind(created.asset.id).first<{
      captured_at: string;
      latitude: number | null;
      longitude: number | null;
    }>();
    expect(stored).toEqual({
      captured_at: "2024-04-05T06:07:08.000Z",
      latitude: 34.3853,
      longitude: 132.4553,
    });

    const timeline = await app.request("/v1/assets", { headers: { authorization } }, env);
    expect(timeline.status).toBe(200);
    await expect(timeline.json()).resolves.toMatchObject({
      items: [{
        id: created.asset.id,
        capturedAt: "2024-04-05T06:07:08.000Z",
        location: { latitude: 34.3853, longitude: 132.4553 },
      }],
    });
  });

  it("returns a null location when the source has no GPS metadata", async () => {
    const { app, authorization } = await signIn("capture-without-location-owner");
    const response = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "without-gps.heic",
        contentType: "image/heic",
        byteSize: 4,
        capturedAt: "2024-04-05T06:07:08.000Z",
        width: 1_024,
        height: 768,
      }),
    }, env);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ asset: { location: null } });
  });

  it.each([
    { latitude: 90.0001, longitude: 0 },
    { latitude: -90.0001, longitude: 0 },
    { latitude: 0, longitude: 180.0001 },
    { latitude: 0, longitude: -180.0001 },
    { latitude: 34.3853 },
  ])("rejects invalid or incomplete GPS coordinates: %o", async (location) => {
    const { app, authorization } = await signIn("invalid-location-owner");
    const response = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "invalid-location.heic",
        contentType: "image/heic",
        byteSize: 4,
        capturedAt: "2024-04-05T06:07:08.000Z",
        location,
      }),
    }, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_asset" } });
  });

  it("streams a small upload into private R2 and supports authenticated Range playback", async () => {
    const { app, authorization } = await signIn();
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "IMG_0001.MOV",
        contentType: "video/quicktime",
        byteSize: 11,
        capturedAt: "2026-07-26T12:00:00.000Z",
        durationMs: 1200,
        width: 1920,
        height: 1080,
      }),
    }, env);
    expect(create.status).toBe(201);
    const created = await create.json<{ asset: { id: string }; upload: { mode: string; url: string } }>();
    expect(created.upload.mode).toBe("single");
    const objectKey = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(created.asset.id).first<{ object_key: string }>();
    expect(objectKey?.object_key).toMatch(/\/media$/);

    const undersizedUpload = await app.request(created.upload.url, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "video/quicktime",
        "content-length": "3",
      },
      body: "hey",
    }, env);
    expect(undersizedUpload.status).toBe(400);
    await expect(undersizedUpload.json()).resolves.toMatchObject({ error: { code: "upload_size_mismatch" } });

    const upload = await app.request(created.upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "video/quicktime", "content-length": "11" },
      body: "hello world",
    }, env);
    expect(upload.status).toBe(204);

    const complete = await app.request(`/v1/assets/${created.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(complete.status).toBe(200);

    await env.DB.prepare(
      `UPDATE assets
          SET transcription_status = 'completed', transcript = ?, transcript_language = 'ja'
        WHERE id = ?`,
    ).bind("夕方の海沿いを歩いた。風が気持ちよかった。", created.asset.id).run();

    const timeline = await app.request("/v1/assets", { headers: { authorization } }, env);
    const timelineBody = await timeline.json<{
      items: Array<{
        id: string;
        status: string;
        transcriptionStatus: string | null;
        transcriptPreview: string | null;
        transcriptUrl: string | null;
      }>;
    }>();
    expect(timelineBody.items).toEqual([expect.objectContaining({
      id: created.asset.id,
      status: "ready",
      transcriptionStatus: "completed",
      transcriptPreview: "夕方の海沿いを歩いた。風が気持ちよかった。",
      transcriptUrl: `/v1/assets/${created.asset.id}/transcript`,
    })]);

    const media = await app.request(`/v1/assets/${created.asset.id}/content`, {
      headers: { authorization, range: "bytes=6-10" },
    }, env);
    expect(media.status).toBe(206);
    expect(media.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(new TextDecoder().decode(await media.arrayBuffer())).toBe("world");
  });

  it("issues a short-lived hashed playback grant that AVKit can use for Range requests", async () => {
    const { app, authorization } = await signIn();
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "playback.mp4",
        contentType: "video/mp4",
        byteSize: 10,
        capturedAt: "2026-07-26T12:30:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "video/mp4", "content-length": "10" },
      body: "0123456789",
    }, env);
    await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);

    const grant = await app.request(`/v1/assets/${asset.id}/playback`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(grant.status).toBe(201);
    const granted = await grant.json<{ url: string; expiresAt: string }>();
    expect(new Date(granted.expiresAt).getTime()).toBeGreaterThan(NOW.getTime());

    const playback = await app.request(granted.url, {
      headers: { range: "bytes=3-6" },
    }, env);
    expect(playback.status).toBe(206);
    expect(playback.headers.get("content-range")).toBe("bytes 3-6/10");
    expect(new TextDecoder().decode(await playback.arrayBuffer())).toBe("3456");

    const rawToken = granted.url.split("/").at(-1)!;
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM media_grants WHERE asset_id = ?",
    ).bind(asset.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toBeTruthy();
    expect(stored?.token_hash).not.toBe(rawToken);
  });

  it("uploads large media in ordered R2 multipart chunks and completes from server-recorded ETags", async () => {
    const { app, authorization } = await signIn();
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const second = new Uint8Array([66, 67, 68]);
    const total = first.byteLength + second.byteLength;

    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "large.mp4",
        contentType: "video/mp4",
        byteSize: total,
        capturedAt: "2026-07-26T13:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string }; upload: { mode: string; partSize: number; partCount: number } }>();
    expect(created.upload).toMatchObject({ mode: "multipart", partSize: 5 * 1024 * 1024, partCount: 2 });

    for (const [partNumber, bytes] of [[1, first], [2, second]] as const) {
      const response = await app.request(`/v1/assets/${created.asset.id}/upload/parts/${partNumber}`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        body: bytes,
      }, env);
      expect(response.status).toBe(200);
    }

    const complete = await app.request(`/v1/assets/${created.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({ asset: { status: "ready", byteSize: total } });
  }, 30_000);

  it("renews a stale multipart upload before storing a part", async () => {
    const { app, authorization } = await signIn("multipart-race-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "resumed-large.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + 3,
        capturedAt: "2026-07-25T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    await env.DB.prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
      .bind("2026-07-25T00:00:00.000Z", created.asset.id).run();

    const raceEnv = envWithMediaHooks({
      beforeUploadPart: async () => { await cleanupExpiredState(env, NOW); },
    });
    const part = await app.request(`/v1/assets/${created.asset.id}/upload/parts/1`, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "content-length": String(first.byteLength),
      },
      body: first,
    }, raceEnv);

    expect(part.status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(created.asset.id).first()).toMatchObject({ status: "uploading" });
  }, 30_000);

  it("aborts a multipart upload when the part loses its D1 claim", async () => {
    const { app, authorization } = await signIn("multipart-claim-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "cancelled-large.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + 3,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    const raceEnv = envWithMediaHooks({
      beforeUploadPart: async () => {
        await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?")
          .bind(created.asset.id).run();
      },
    });

    const part = await app.request(`/v1/assets/${created.asset.id}/upload/parts/1`, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "content-length": String(first.byteLength),
      },
      body: first,
    }, raceEnv);

    expect(part.status).toBe(409);
    await expect(part.json()).resolves.toMatchObject({ error: { code: "upload_conflict" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE asset_id = ?")
      .bind(created.asset.id).first<{ count: number }>()).toMatchObject({ count: 0 });
  }, 30_000);

  it("aborts a known multipart upload before a late part can outlive deletion", async () => {
    const { app, authorization } = await signIn("multipart-delete-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(73);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "deleted-large.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + 3,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    const partReachedR2 = deferred();
    const releasePart = deferred();
    let successfulAborts = 0;
    const raceEnv = envWithMediaHooks({
      beforeUploadPart: async () => {
        partReachedR2.resolve();
        await releasePart.promise;
      },
      afterAbort: async () => { successfulAborts += 1; },
    });
    const latePart = app.request(`/v1/assets/${created.asset.id}/upload/parts/1`, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "content-length": String(first.byteLength),
      },
      body: first,
    }, raceEnv);
    await partReachedR2.promise;

    const deleted = await app.request(`/v1/assets/${created.asset.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, raceEnv);
    expect(deleted.status).toBe(204);
    expect(successfulAborts).toBe(1);
    releasePart.resolve();
    expect((await latePart).status).toBe(409);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(created.asset.id).first()).toMatchObject({ status: "failed" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE asset_id = ?")
      .bind(created.asset.id).first<{ count: number }>()).toMatchObject({ count: 0 });

    const afterGrace = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(await cleanupExpiredState(raceEnv, afterGrace)).toMatchObject({ abandonedAssets: 1 });
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(created.asset.id).first()).toBeNull();
  }, 30_000);

  it("allows a multipart part retry after a transient D1 batch failure", async () => {
    const { app, authorization } = await signIn("multipart-retry-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "retry-large.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + 3,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    const request = {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "content-length": String(first.byteLength),
      },
      body: first,
    };

    const failed = await app.request(
      `/v1/assets/${created.asset.id}/upload/parts/1`,
      request,
      envWithOneBatchFailure(),
    );
    expect(failed.status).toBe(500);

    const retried = await app.request(`/v1/assets/${created.asset.id}/upload/parts/1`, request, env);
    expect(retried.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE asset_id = ?")
      .bind(created.asset.id).first<{ count: number }>()).toMatchObject({ count: 1 });
  }, 30_000);

  it("rejects a late duplicate part after completion without changing ready media", async () => {
    const { app, authorization } = await signIn("multipart-late-part-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(21);
    const second = new Uint8Array([22, 23, 24]);
    const replacement = new Uint8Array([31, 32, 33]);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "late-part.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + second.byteLength,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string }; upload: { partUrlTemplate: string } }>();
    for (const [partNumber, bytes] of [[1, first], [2, second]] as const) {
      const uploaded = await app.request(
        created.upload.partUrlTemplate.replace("{partNumber}", String(partNumber)),
        {
          method: "PUT",
          headers: {
            authorization,
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
          body: bytes,
        },
        env,
      );
      expect(uploaded.status).toBe(200);
    }

    const lateReachedR2 = deferred();
    const releaseLate = deferred();
    const latePart = app.request(created.upload.partUrlTemplate.replace("{partNumber}", "2"), {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "content-length": String(replacement.byteLength),
      },
      body: replacement,
    }, envWithMediaHooks({
      beforeUploadPart: async () => {
        lateReachedR2.resolve();
        await releaseLate.promise;
      },
    }));
    await lateReachedR2.promise;

    const completed = await app.request(`/v1/assets/${created.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(completed.status).toBe(200);
    releaseLate.resolve();
    const rejected = await latePart;

    expect(rejected.status).toBe(409);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(created.asset.id).first()).toMatchObject({ status: "ready" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE asset_id = ?")
      .bind(created.asset.id).first<{ count: number }>()).toMatchObject({ count: 0 });
    const objectKey = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(created.asset.id).first<{ object_key: string }>();
    const body = new Uint8Array(await (await env.MEDIA.get(objectKey!.object_key))!.arrayBuffer());
    expect(Array.from(body.slice(-3))).toEqual(Array.from(second));
  }, 30_000);

  it("renews a stale multipart upload before completing it", async () => {
    const { app, authorization } = await signIn("multipart-complete-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const second = new Uint8Array([66, 67, 68]);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "resumed-completion.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + second.byteLength,
        capturedAt: "2026-07-25T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    for (const [partNumber, body] of [[1, first], [2, second]] as const) {
      const part = await app.request(`/v1/assets/${created.asset.id}/upload/parts/${partNumber}`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/octet-stream",
          "content-length": String(body.byteLength),
        },
        body,
      }, env);
      expect(part.status).toBe(200);
    }
    await env.DB.prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
      .bind("2026-07-25T00:00:00.000Z", created.asset.id).run();

    const raceEnv = envWithMediaHooks({
      beforeComplete: async () => { await cleanupExpiredState(env, NOW); },
    });
    const complete = await app.request(`/v1/assets/${created.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, raceEnv);

    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({ asset: { status: "ready" } });
  }, 30_000);

  it("retries multipart completion after R2 succeeds but D1 ready rolls back", async () => {
    const { app, authorization } = await signIn("multipart-complete-retry-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(12);
    const second = new Uint8Array([4, 5, 6]);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "retry-complete.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + second.byteLength,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const body = await create.json<{
      asset: { id: string };
      upload: { partUrlTemplate: string };
    }>();
    for (const [partNumber, bytes] of [[1, first], [2, second]] as const) {
      await app.request(body.upload.partUrlTemplate.replace("{partNumber}", String(partNumber)), {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      }, env);
    }

    const firstCompletion = await app.request(`/v1/assets/${body.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, envWithRunFailureBeforeCommit("UPDATE assets SET status = 'ready', updated_at"));
    expect(firstCompletion.status).toBe(500);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(body.asset.id).first()).toMatchObject({ status: "uploading" });

    const retried = await app.request(`/v1/assets/${body.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ asset: { status: "ready" } });
  });

  it("removes a completed multipart object when the D1 ready transition loses its claim", async () => {
    const { app, authorization } = await signIn("multipart-complete-claim-owner");
    const first = new Uint8Array(5 * 1024 * 1024).fill(65);
    const second = new Uint8Array([66, 67, 68]);
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "cancelled-completion.mp4",
        contentType: "video/mp4",
        byteSize: first.byteLength + second.byteLength,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const created = await create.json<{ asset: { id: string } }>();
    for (const [partNumber, body] of [[1, first], [2, second]] as const) {
      const part = await app.request(`/v1/assets/${created.asset.id}/upload/parts/${partNumber}`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/octet-stream",
          "content-length": String(body.byteLength),
        },
        body,
      }, env);
      expect(part.status).toBe(200);
    }
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(created.asset.id).first<{ object_key: string }>();
    const raceEnv = envWithMediaHooks({
      beforeComplete: async () => {
        await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?")
          .bind(created.asset.id).run();
      },
    });

    const complete = await app.request(`/v1/assets/${created.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, raceEnv);

    expect(complete.status).toBe(409);
    await expect(complete.json()).resolves.toMatchObject({ error: { code: "upload_conflict" } });
    expect(await env.MEDIA.head(stored!.object_key)).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(created.asset.id).first()).toMatchObject({ status: "failed" });
  }, 30_000);

  it("does not expose another user's metadata or media", async () => {
    const owner = await signIn("owner");
    const stranger = await signIn("stranger");
    const create = await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "private.jpg",
        contentType: "image/jpeg",
        byteSize: 3,
        capturedAt: "2026-07-26T10:00:00.000Z",
      }),
    }, env);
    const { asset } = await create.json<{ asset: { id: string } }>();

    const media = await stranger.app.request(`/v1/assets/${asset.id}/content`, {
      headers: { authorization: stranger.authorization },
    }, env);
    expect(media.status).toBe(404);

    const timeline = await stranger.app.request("/v1/assets", {
      headers: { authorization: stranger.authorization },
    }, env);
    await expect(timeline.json()).resolves.toMatchObject({ items: [] });
  });

  it("rejects unsafe metadata before creating an R2 upload", async () => {
    const { app, authorization } = await signIn();
    const response = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: "../../secret.exe",
        contentType: "application/x-msdownload",
        byteSize: 1,
        capturedAt: "not-a-date",
      }),
    }, env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_asset" } });
  });

  it("rejects an upload whose body length differs from declared metadata before writing R2", async () => {
    const { app, authorization } = await signIn();
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "short.jpg",
        contentType: "image/jpeg",
        byteSize: 10,
        capturedAt: "2026-07-26T10:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    const rejected = await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "3" },
      body: "bad",
    }, env);
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "upload_size_mismatch" } });

    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();
    expect(stored).not.toBeNull();
    expect(await env.MEDIA.head(stored!.object_key)).toBeNull();
  });

  it("renews a stale upload before R2 so cleanup cannot reclaim it mid-request", async () => {
    const { app, authorization } = await signIn("cleanup-race-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "resumed.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-25T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await env.DB.prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
      .bind("2026-07-25T00:00:00.000Z", asset.id).run();

    let cleanupResult: Awaited<ReturnType<typeof cleanupExpiredState>> | undefined;
    const raceEnv = envWithMediaHooks({
      beforePut: async () => {
        cleanupResult = await cleanupExpiredState(env, NOW);
      },
    });
    const uploaded = await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "fresh",
    }, raceEnv);

    expect(uploaded.status).toBe(204);
    expect(cleanupResult).toMatchObject({ abandonedAssets: 0 });
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(asset.id).first()).toMatchObject({ status: "uploading" });
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();
    expect(await env.MEDIA.head(stored!.object_key)).not.toBeNull();
  });

  it("serializes single uploads and completion with an upload lease", async () => {
    const { app, authorization } = await signIn("single-lease-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "lease-race.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();

    const uploadReachedR2 = deferred();
    const releaseUpload = deferred();
    const raceEnv = envWithMediaHooks({
      beforePut: async () => {
        uploadReachedR2.resolve();
        await releaseUpload.promise;
      },
    });
    const firstUploadPromise = app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "first",
    }, raceEnv);
    await uploadReachedR2.promise;

    const competingUpload = await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "other",
    }, env);
    const blockedComplete = await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);

    expect(competingUpload.status).toBe(409);
    expect(blockedComplete.status).toBe(409);
    releaseUpload.resolve();
    expect((await firstUploadPromise).status).toBe(204);

    const stored = await env.DB.prepare("SELECT user_id, object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ user_id: string; object_key: string }>();
    const orphanKey = `users/${stored!.user_id}/assets/${asset.id}/attempts/orphan`;
    await env.MEDIA.put(orphanKey, "orphan");

    const completed = await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ asset: { status: "ready" } });

    const object = await env.MEDIA.get(stored!.object_key);
    expect(await object!.text()).toBe("first");
    expect(await env.MEDIA.head(orphanKey)).toBeNull();
  });

  it("preserves a single attempt when D1 commits finalization before returning an error", async () => {
    const { app, authorization } = await signIn("single-ambiguous-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "ambiguous-upload.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    const uploaded = await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "image",
    }, envWithCommittedRunFailure("UPDATE assets SET object_key"));

    expect(uploaded.status).toBe(500);
    const stored = await env.DB.prepare(
      "SELECT status, object_key, upload_lease FROM assets WHERE id = ?",
    ).bind(asset.id).first<{ status: string; object_key: string; upload_lease: string | null }>();
    expect(stored).toMatchObject({ status: "uploading", upload_lease: null });
    expect(await env.MEDIA.head(stored!.object_key)).not.toBeNull();

    const completed = await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(completed.status).toBe(200);
  });

  it("preserves completed media when D1 commits ready before returning an error", async () => {
    const { app, authorization } = await signIn("complete-ambiguous-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "ambiguous-complete.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "image",
    }, env);
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();

    const completed = await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, envWithCommittedRunFailure("UPDATE assets SET status = 'ready', upload_lease"));

    expect(completed.status).toBe(500);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(asset.id).first()).toMatchObject({ status: "ready" });
    expect(await env.MEDIA.head(stored!.object_key)).not.toBeNull();
    expect((await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env)).status).toBe(200);
  });

  it("reconciles a stale single attempt when ready wins before an ambiguous finalize", async () => {
    const { app, authorization } = await signIn("single-ready-reconcile-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "ready-reconcile.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    const user = await env.DB.prepare("SELECT user_id FROM assets WHERE id = ?")
      .bind(asset.id).first<{ user_id: string }>();

    const staleReachedR2 = deferred();
    const releaseStale = deferred();
    const mediaEnv = envWithMediaHooks({
      beforePut: async () => {
        staleReachedR2.resolve();
        await releaseStale.promise;
      },
    });
    const failedDbEnv = envWithRunFailureBeforeCommit("UPDATE assets SET object_key");
    const staleEnv: Env = { ...mediaEnv, DB: failedDbEnv.DB };
    const staleUpload = app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "older",
    }, staleEnv);
    await staleReachedR2.promise;

    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    const newerApp = createApp({ now: () => later });
    const newerUpload = await newerApp.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "newer",
    }, env);
    expect(newerUpload.status).toBe(204);
    const completed = await newerApp.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(completed.status).toBe(200);

    releaseStale.resolve();
    expect((await staleUpload).status).toBe(500);
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();
    const objects = await env.MEDIA.list({ prefix: `users/${user!.user_id}/assets/${asset.id}/` });
    expect(objects.objects.map((object) => object.key)).toEqual([stored!.object_key]);
    expect(await (await env.MEDIA.get(stored!.object_key))!.text()).toBe("newer");
  });

  it("keeps a delete tombstone until it reclaims an ambiguous late single attempt", async () => {
    const { app, authorization } = await signIn("single-delete-tombstone-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "delete-tombstone.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    const user = await env.DB.prepare("SELECT user_id FROM assets WHERE id = ?")
      .bind(asset.id).first<{ user_id: string }>();

    const uploadReachedR2 = deferred();
    const releaseUpload = deferred();
    const mediaEnv = envWithMediaHooks({
      beforePut: async () => {
        uploadReachedR2.resolve();
        await releaseUpload.promise;
      },
    });
    const failedDbEnv = envWithRunFailureBeforeCommit("UPDATE assets SET object_key");
    const uploadEnv: Env = { ...mediaEnv, DB: failedDbEnv.DB };
    const uploadPromise = app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "later",
    }, uploadEnv);
    await uploadReachedR2.promise;

    const deleted = await app.request(`/v1/assets/${asset.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, env);
    releaseUpload.resolve();
    const lateUpload = await uploadPromise;

    expect(deleted.status).toBe(204);
    expect(lateUpload.status).toBe(500);
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(asset.id).first()).toMatchObject({ status: "failed" });
    const timeline = await app.request("/v1/assets", { headers: { authorization } }, env);
    expect((await timeline.json<{ items: Array<{ id: string }> }>()).items)
      .not.toContainEqual(expect.objectContaining({ id: asset.id }));
    const prefix = `users/${user!.user_id}/assets/${asset.id}/`;
    expect((await env.MEDIA.list({ prefix })).objects).toHaveLength(0);
    await env.MEDIA.put(`${prefix}attempts/unreconciled-late-write`, "later");
    expect((await env.MEDIA.list({ prefix })).objects).toHaveLength(1);

    const afterGrace = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(await cleanupExpiredState(env, afterGrace)).toMatchObject({ abandonedAssets: 1 });
    expect((await env.MEDIA.list({ prefix })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).toBeNull();
  });

  it("removes an R2 object when deletion wins during a single upload", async () => {
    const { app, authorization } = await signIn("delete-race-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "deleted-during-upload.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();

    const uploadReachedR2 = deferred();
    const releaseUpload = deferred();
    const deleteRemovedR2 = deferred();
    const releaseDelete = deferred();
    let interceptFirstDelete = true;
    const raceEnv = envWithMediaHooks({
      beforePut: async () => {
        uploadReachedR2.resolve();
        await releaseUpload.promise;
      },
      afterDelete: async () => {
        if (!interceptFirstDelete) return;
        interceptFirstDelete = false;
        deleteRemovedR2.resolve();
        await releaseDelete.promise;
      },
    });

    const uploadPromise = app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "later",
    }, raceEnv);
    await uploadReachedR2.promise;
    const deletePromise = app.request(`/v1/assets/${asset.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, raceEnv);
    await deleteRemovedR2.promise;
    releaseUpload.resolve();
    const uploaded = await uploadPromise;
    releaseDelete.resolve();
    const deleted = await deletePromise;

    expect(deleted.status).toBe(204);
    expect(uploaded.status).toBe(409);
    await expect(uploaded.json()).resolves.toMatchObject({ error: { code: "upload_conflict" } });
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(asset.id).first())
      .toMatchObject({ status: "failed" });
    expect(await env.MEDIA.head(stored!.object_key)).toBeNull();
  });

  it("stores a bounded JPEG thumbnail and deletes all owned R2 objects with the asset", async () => {
    const { app, authorization } = await signIn();
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "memory.jpg",
        contentType: "image/jpeg",
        byteSize: 5,
        capturedAt: "2026-07-26T14:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "5" },
      body: "image",
    }, env);
    await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);

    const thumbnailUpload = await app.request(`/v1/assets/${asset.id}/thumbnail`, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "5" },
      body: "thumb",
    }, env);
    expect(thumbnailUpload.status).toBe(204);

    const thumbnail = await app.request(`/v1/assets/${asset.id}/thumbnail`, {
      headers: { authorization },
    }, env);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    expect(new TextDecoder().decode(await thumbnail.arrayBuffer())).toBe("thumb");

    const stored = await env.DB.prepare(
      "SELECT object_key, thumbnail_key FROM assets WHERE id = ?",
    ).bind(asset.id).first<{ object_key: string; thumbnail_key: string }>();
    expect(stored?.thumbnail_key).toBeTruthy();

    const deleted = await app.request(`/v1/assets/${asset.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, env);
    expect(deleted.status).toBe(204);
    expect(await env.MEDIA.head(stored!.object_key)).toBeNull();
    expect(await env.MEDIA.head(stored!.thumbnail_key)).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(asset.id).first())
      .toMatchObject({ status: "failed" });

    await env.MEDIA.put(stored!.thumbnail_key, "late!", {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const inaccessible = await app.request(`/v1/assets/${asset.id}/thumbnail`, {
      headers: { authorization },
    }, env);
    expect(inaccessible.status).toBe(404);

    const afterGrace = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(await cleanupExpiredState(env, afterGrace)).toMatchObject({ abandonedAssets: 1 });
    expect(await env.MEDIA.head(stored!.thumbnail_key)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).toBeNull();
  });

  it("preserves a thumbnail when D1 commits before returning an error", async () => {
    const { app, authorization } = await signIn("thumbnail-ambiguous-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "ambiguous-thumbnail.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "image",
    }, env);
    await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);

    const thumbnailKey = `users/${(await env.DB.prepare("SELECT user_id FROM assets WHERE id = ?")
      .bind(asset.id).first<{ user_id: string }>())!.user_id}/assets/${asset.id}/thumbnail.jpg`;
    const response = await app.request(`/v1/assets/${asset.id}/thumbnail`, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "4" },
      body: "jpeg",
    }, envWithCommittedRunFailure("UPDATE assets SET thumbnail_key"));

    expect(response.status).toBe(500);
    expect(await env.DB.prepare("SELECT thumbnail_key FROM assets WHERE id = ?")
      .bind(asset.id).first()).toMatchObject({ thumbnail_key: thumbnailKey });
    expect(await env.MEDIA.head(thumbnailKey)).not.toBeNull();
  });

  it("removes a thumbnail object when deletion wins during its upload", async () => {
    const { app, authorization } = await signIn("thumbnail-race-owner");
    const create = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "thumbnail-race.jpg",
        contentType: "image/jpeg",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const { asset, upload } = await create.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "5" },
      body: "image",
    }, env);
    await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    const stored = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(asset.id).first<{ object_key: string }>();
    const thumbnailKey = stored!.object_key.replace(/\/media$/, "/thumbnail.jpg");

    const thumbnailReachedR2 = deferred();
    const releaseThumbnail = deferred();
    const deleteRemovedR2 = deferred();
    const releaseDelete = deferred();
    let interceptFirstDelete = true;
    const raceEnv = envWithMediaHooks({
      beforePut: async () => {
        thumbnailReachedR2.resolve();
        await releaseThumbnail.promise;
      },
      afterDelete: async () => {
        if (!interceptFirstDelete) return;
        interceptFirstDelete = false;
        deleteRemovedR2.resolve();
        await releaseDelete.promise;
      },
    });

    const thumbnailPromise = app.request(`/v1/assets/${asset.id}/thumbnail`, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "5" },
      body: "thumb",
    }, raceEnv);
    await thumbnailReachedR2.promise;
    const deletePromise = app.request(`/v1/assets/${asset.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, raceEnv);
    await deleteRemovedR2.promise;
    releaseThumbnail.resolve();
    const thumbnail = await thumbnailPromise;
    releaseDelete.resolve();
    const deleted = await deletePromise;

    expect(deleted.status).toBe(204);
    expect(thumbnail.status).toBe(409);
    await expect(thumbnail.json()).resolves.toMatchObject({ error: { code: "thumbnail_conflict" } });
    expect(await env.MEDIA.head(thumbnailKey)).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(asset.id).first())
      .toMatchObject({ status: "failed" });
  });

  it("cleans expired state and abandoned uploads without touching active data", async () => {
    const { app, authorization } = await signIn("cleanup-owner");

    const createAbandoned = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "abandoned.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-25T00:00:00.000Z",
      }),
    }, env);
    const abandoned = await createAbandoned.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(abandoned.upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "stale",
    }, env);
    await env.DB.prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
      .bind("2026-07-25T00:00:00.000Z", abandoned.asset.id).run();
    const abandonedKey = await env.DB.prepare("SELECT object_key FROM assets WHERE id = ?")
      .bind(abandoned.asset.id).first<{ object_key: string }>();

    const createReady = await app.request("/v1/assets", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "photo",
        filename: "ready.heic",
        contentType: "image/heic",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
      }),
    }, env);
    const ready = await createReady.json<{ asset: { id: string }; upload: { url: string } }>();
    await app.request(ready.upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/heic", "content-length": "5" },
      body: "ready",
    }, env);
    await app.request(`/v1/assets/${ready.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);

    const user = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("cleanup-owner").first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("expired-session", user!.id, "expired-session-hash", "2026-07-26T00:00:00.000Z", "2026-07-25T00:00:00.000Z"),
      env.DB.prepare(
        "INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("expired-grant", ready.asset.id, user!.id, "expired-grant-hash", "2026-07-26T00:00:00.000Z", "2026-07-25T00:00:00.000Z"),
    ]);

    const firstCleanup = await cleanupExpiredState(env, NOW);

    expect(firstCleanup).toMatchObject({
      expiredSessions: 1,
      expiredGrants: 1,
      quarantinedAssets: 1,
      abandonedAssets: 0,
    });
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE id = 'expired-session'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM media_grants WHERE id = 'expired-grant'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM assets WHERE id = ?").bind(abandoned.asset.id).first())
      .toMatchObject({ status: "failed" });
    expect(await env.MEDIA.head(abandonedKey!.object_key)).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ? AND status = 'ready'")
      .bind(ready.asset.id).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
      .bind(user!.id).first<{ count: number }>()).toMatchObject({ count: 1 });

    const afterGrace = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    const secondCleanup = await cleanupExpiredState(env, afterGrace);
    expect(secondCleanup).toMatchObject({ expiredSessions: 0, expiredGrants: 0, abandonedAssets: 1 });
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(abandoned.asset.id).first()).toBeNull();
    expect(await env.MEDIA.head(abandonedKey!.object_key)).toBeNull();
  });
});

describe("scheduled transcription polling", () => {
  it("checks a newly processing Soniox job on the next five-minute tick", async () => {
    await signIn("transcription-poll-owner");
    const user = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("transcription-poll-owner").first<{ id: string }>();
    expect(user).not.toBeNull();

    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at,
        status, object_key, upload_mode, created_at, updated_at,
        transcription_status, soniox_file_id, soniox_transcription_id, transcription_updated_at
      ) VALUES (?, ?, 'video', 'memory.mov', 'video/quicktime', 4, ?,
        'ready', ?, 'single', ?, ?, 'processing', 'file-1', 'job-1', ?)`,
    ).bind(
      "poll-asset",
      user!.id,
      NOW.toISOString(),
      `users/${user!.id}/assets/poll-asset/media`,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();

    const sonioxFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/transcript")) {
        return Response.json({ text: "今日の記憶を話した。", language: "ja" });
      }
      return Response.json({ status: "completed" });
    });
    vi.stubGlobal("fetch", sonioxFetch);

    const result = await pollTranscriptions({ ...env, SONIOX_API_KEY: "test-key" } as Env, NOW);

    expect(result.processed).toBe(1);
    expect(sonioxFetch).toHaveBeenCalledWith(
      "https://api.soniox.com/v1/transcriptions/job-1",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(await env.DB.prepare(
      "SELECT transcription_status, transcript, transcript_language FROM assets WHERE id = ?",
    ).bind("poll-asset").first()).toMatchObject({
      transcription_status: "completed",
      transcript: "今日の記憶を話した。",
      transcript_language: "ja",
    });
  });
});

describe("MCP personal access tokens", () => {
  it("issues a hash-only token, lists metadata, and revokes it for MCP access", async () => {
    const { app, authorization } = await signIn("mcp-token-owner");

    const created = await app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "Hermes" }),
    }, env);
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      token: string;
      item: { id: string; name: string; expiresAt: string; token?: string };
    }>();
    expect(createdBody.token).toMatch(/^aft_mcp_[A-Za-z0-9_-]{43}$/);
    expect(createdBody.item).toMatchObject({ name: "Hermes" });
    expect(createdBody.item).not.toHaveProperty("token");

    const stored = await env.DB.prepare(
      "SELECT token_hash, revoked_at FROM mcp_tokens WHERE id = ?",
    ).bind(createdBody.item.id).first<{ token_hash: string; revoked_at: string | null }>();
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.token_hash).not.toContain(createdBody.token);
    expect(stored?.revoked_at).toBeNull();

    const listed = await app.request("/v1/mcp/tokens", { headers: { authorization } }, env);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json<{ items: Array<Record<string, unknown>> }>();
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]).toMatchObject({ id: createdBody.item.id, name: "Hermes" });
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.token);
    expect(JSON.stringify(listedBody)).not.toContain(stored!.token_hash);

    const other = await signIn("mcp-token-other");
    const forbidden = await other.app.request(`/v1/mcp/tokens/${createdBody.item.id}`, {
      method: "DELETE",
      headers: { authorization: other.authorization },
    }, env);
    expect(forbidden.status).toBe(404);

    const revoked = await app.request(`/v1/mcp/tokens/${createdBody.item.id}`, {
      method: "DELETE",
      headers: { authorization },
    }, env);
    expect(revoked.status).toBe(204);
    expect(await env.DB.prepare("SELECT revoked_at FROM mcp_tokens WHERE id = ?")
      .bind(createdBody.item.id).first<{ revoked_at: string }>()).toMatchObject({
      revoked_at: NOW.toISOString(),
    });

    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createdBody.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }, env);
    expect(mcp.status).toBe(401);
  });

  it("exposes only the owner's completed transcriptions through read-only tools", async () => {
    const owner = await signIn("mcp-tools-owner");
    await signIn("mcp-tools-other");
    const ownerUser = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("mcp-tools-owner").first<{ id: string }>();
    const otherUser = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("mcp-tools-other").first<{ id: string }>();
    const ownerAssetId = crypto.randomUUID();
    const otherAssetId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcript, transcript_language, transcription_updated_at
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 100, ?, 12000,
          'ready', ?, 'single', ?, ?, 'completed', ?, 'ja', ?)`,
      ).bind(
        ownerAssetId,
        ownerUser!.id,
        "owner.mp4",
        "2026-07-27T07:00:00.000Z",
        `users/${ownerUser!.id}/assets/${ownerAssetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
        "海辺で今日の計画を話した。",
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcript, transcript_language, transcription_updated_at
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 100, ?, 9000,
          'ready', ?, 'single', ?, ?, 'completed', ?, 'ja', ?)`,
      ).bind(
        otherAssetId,
        otherUser!.id,
        "private.mp4",
        "2026-07-27T06:00:00.000Z",
        `users/${otherUser!.id}/assets/${otherAssetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
        "他人だけの秘密の記憶。",
        NOW.toISOString(),
      ),
    ]);

    const created = await owner.app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "MCP tools test" }),
    }, env);
    const { token } = await created.json<{ token: string }>();

    async function callMcp(id: number, method: string, params: Record<string, unknown>) {
      const response = await owner.app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }, env);
      expect(response.status).toBe(200);
      return response.json<any>();
    }

    const tools = await callMcp(1, "tools/list", {});
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_transcriptions",
      "get_transcription",
    ]);
    expect(tools.result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "list_transcriptions",
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
      }),
    ]));

    const listed = await callMcp(2, "tools/call", {
      name: "list_transcriptions",
      arguments: { query: "計画", limit: 10 },
    });
    expect(listed.result.structuredContent.items).toEqual([
      expect.objectContaining({ id: ownerAssetId, filename: "owner.mp4" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("他人だけの秘密");

    const ownDetail = await callMcp(3, "tools/call", {
      name: "get_transcription",
      arguments: { assetId: ownerAssetId },
    });
    expect(ownDetail.result.structuredContent).toMatchObject({
      id: ownerAssetId,
      transcript: "海辺で今日の計画を話した。",
    });

    const otherDetail = await callMcp(4, "tools/call", {
      name: "get_transcription",
      arguments: { assetId: otherAssetId },
    });
    expect(otherDetail.result).toMatchObject({ isError: true });
    expect(JSON.stringify(otherDetail)).not.toContain("他人だけの秘密");
  });
});


describe("uploaded asset duplicate detection", () => {
  const trackedFingerprint = "a".repeat(64);
  const legacyFingerprint = "b".repeat(64);
  const newFingerprint = "c".repeat(64);

  function assetBody(filename: string, sourceFingerprint?: string) {
    return {
      kind: "video",
      filename,
      contentType: "video/quicktime",
      byteSize: 5,
      capturedAt: "2026-07-27T00:00:00.000Z",
      durationMs: 1_000,
      width: 1_920,
      height: 1_080,
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
    };
  }

  it("finds active owner assets, including uploads created before fingerprints were stored", async () => {
    const owner = await signIn("duplicate-check-owner");
    expect((await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("LEGACY-L0-001.mov")),
    }, env)).status).toBe(201);
    expect((await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("TRACKED-L0-001.mov", trackedFingerprint)),
    }, env)).status).toBe(201);

    const candidates = {
      items: [
        { sourceFingerprint: trackedFingerprint, filename: "TRACKED-L0-001.mov" },
        { sourceFingerprint: legacyFingerprint, filename: "LEGACY-L0-001.mov" },
        { sourceFingerprint: newFingerprint, filename: "NEW-L0-001.mov" },
      ],
    };
    const existing = await owner.app.request("/v1/assets/existing", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(candidates),
    }, env);
    expect(existing.status).toBe(200);
    await expect(existing.json()).resolves.toEqual({
      existingSourceFingerprints: [trackedFingerprint, legacyFingerprint],
    });

    const other = await signIn("duplicate-check-other");
    const privateResult = await other.app.request("/v1/assets/existing", {
      method: "POST",
      headers: { authorization: other.authorization, "content-type": "application/json" },
      body: JSON.stringify(candidates),
    }, env);
    expect(privateResult.status).toBe(200);
    await expect(privateResult.json()).resolves.toEqual({ existingSourceFingerprints: [] });
  });

  it("rejects a duplicate fingerprint for one owner but allows it after failure or for another owner", async () => {
    const owner = await signIn("duplicate-create-owner");
    const sourceFingerprint = "d".repeat(64);
    const first = await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("FIRST-L0-001.mov", sourceFingerprint)),
    }, env);
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ asset: { id: string } }>();

    const duplicate = await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("RENAMED-L0-001.mov", sourceFingerprint)),
    }, env);
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: "duplicate_asset" } });

    const other = await signIn("duplicate-create-other");
    expect((await other.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: other.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("OTHER-L0-001.mov", sourceFingerprint)),
    }, env)).status).toBe(201);

    await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?")
      .bind(firstBody.asset.id).run();
    expect((await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(assetBody("RETRY-L0-001.mov", sourceFingerprint)),
    }, env)).status).toBe(201);
  });
});

describe("daily playback manifest", () => {
  async function userId(subject: string) {
    const user = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind(subject).first<{ id: string }>();
    expect(user).not.toBeNull();
    return user!.id;
  }

  async function insertAsset(options: {
    id: string;
    userId: string;
    capturedAt: string;
    durationMs: number;
    kind?: "video" | "photo";
    status?: "ready" | "failed";
    transcriptionStatus?: "completed" | "pending";
    transcript?: string | null;
  }) {
    const kind = options.kind ?? "video";
    const status = options.status ?? "ready";
    const transcriptionStatus = options.transcriptionStatus ?? "completed";
    const filename = `${options.id}.${kind === "video" ? "mp4" : "jpg"}`;
    const contentType = kind === "video" ? "video/mp4" : "image/jpeg";
    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
        status, object_key, upload_mode, created_at, updated_at,
        transcription_status, transcript, transcript_language, transcription_updated_at
      ) VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, 'single', ?, ?, ?, ?, 'ja', ?)`,
    ).bind(
      options.id,
      options.userId,
      kind,
      filename,
      contentType,
      options.capturedAt,
      options.durationMs,
      status,
      `users/${options.userId}/assets/${options.id}/media`,
      NOW.toISOString(),
      NOW.toISOString(),
      transcriptionStatus,
      options.transcript ?? null,
      NOW.toISOString(),
    ).run();
  }

  it("requires authentication and rejects invalid or oversized day ranges", async () => {
    const app = makeApp();
    const path = "/v1/days/playback?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-28T00%3A00%3A00.000Z";
    expect((await app.request(path, {}, env)).status).toBe(401);

    const owner = await signIn("daily-range-owner");
    const invalid = await owner.app.request(
      "/v1/days/playback?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-27T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "invalid_day_range" } });

    const oversized = await owner.app.request(
      "/v1/days/playback?startAt=2026-07-25T00%3A00%3A00.000Z&endAt=2026-07-28T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(oversized.status).toBe(400);
  });

  it("returns only the owner's ready videos in chronological order with cumulative offsets and full transcripts", async () => {
    const owner = await signIn("daily-owner");
    await signIn("daily-other");
    const ownerId = await userId("daily-owner");
    const otherId = await userId("daily-other");

    await insertAsset({ id: "middle", userId: ownerId, capturedAt: "2026-07-27T00:30:00.000Z", durationMs: 2_000, transcript: "二本目の全文字幕" });
    await insertAsset({ id: "first", userId: ownerId, capturedAt: "2026-07-27T00:10:00.000Z", durationMs: 1_000, transcript: "一本目の全文字幕" });
    await insertAsset({ id: "offset-first", userId: ownerId, capturedAt: "2026-07-27T09:05:00.000+09:00", durationMs: 700, transcript: "offset字幕" });
    await insertAsset({ id: "before-offset", userId: ownerId, capturedAt: "2026-07-27T08:50:00.000+09:00", durationMs: 800, transcript: "範囲外offset字幕" });
    await insertAsset({ id: "pending", userId: ownerId, capturedAt: "2026-07-27T00:50:00.000Z", durationMs: 3_000, transcriptionStatus: "pending" });
    await insertAsset({ id: "photo", userId: ownerId, capturedAt: "2026-07-27T00:20:00.000Z", durationMs: 0, kind: "photo", transcript: "写真" });
    await insertAsset({ id: "failed", userId: ownerId, capturedAt: "2026-07-27T00:05:00.000Z", durationMs: 500, status: "failed", transcript: "失敗asset" });
    await insertAsset({ id: "tomorrow", userId: ownerId, capturedAt: "2026-07-28T00:00:00.000Z", durationMs: 500, transcript: "翌日" });
    await insertAsset({ id: "private", userId: otherId, capturedAt: "2026-07-27T00:00:00.000Z", durationMs: 500, transcript: "他人の字幕" });

    const response = await owner.app.request(
      "/v1/days/playback?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-28T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json<{
      clipCount: number;
      durationMs: number;
      clips: Array<{
        startMs: number;
        endMs: number;
        asset: { id: string };
        transcript: { status: string | null; language: string | null; text: string | null };
      }>;
    }>();

    expect(body.clipCount).toBe(4);
    expect(body.durationMs).toBe(6_700);
    expect(body.clips.map((clip) => clip.asset.id)).toEqual(["offset-first", "first", "middle", "pending"]);
    expect(body.clips.map((clip) => [clip.startMs, clip.endMs])).toEqual([
      [0, 700],
      [700, 1_700],
      [1_700, 3_700],
      [3_700, 6_700],
    ]);
    expect(body.clips[0]!.transcript).toMatchObject({ status: "completed", language: "ja", text: "offset字幕" });
    expect(body.clips[1]!.transcript).toMatchObject({ status: "completed", language: "ja", text: "一本目の全文字幕" });
    expect(body.clips[3]!.transcript).toMatchObject({ status: "pending", text: null });
    expect(JSON.stringify(body)).not.toContain("範囲外offset字幕");
    expect(JSON.stringify(body)).not.toContain("他人の字幕");
    expect(JSON.stringify(body)).not.toContain("翌日");
    expect(JSON.stringify(body)).not.toContain("写真");
  });

  it("rejects a manifest whose completed transcripts exceed the response budget", async () => {
    const owner = await signIn("daily-large-transcript-owner");
    const ownerId = await userId("daily-large-transcript-owner");
    await insertAsset({
      id: "oversized-transcript",
      userId: ownerId,
      capturedAt: "2026-07-27T00:10:00.000Z",
      durationMs: 1_000,
      transcript: "x".repeat(500_001),
    });

    const response = await owner.app.request(
      "/v1/days/playback?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-28T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "daily_playback_too_large" } });
  });
});

describe("daily Qwen summary", () => {
  const summaryPath = "/v1/days/summary?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-28T00%3A00%3A00.000Z";

  async function userId(subject: string): Promise<string> {
    const user = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind(subject).first<{ id: string }>();
    expect(user).not.toBeNull();
    return user!.id;
  }

  async function insertTranscript(options: {
    id: string;
    userId: string;
    capturedAt: string;
    text: string | null;
    transcriptionStatus?: "completed" | "pending";
  }) {
    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
        status, object_key, upload_mode, created_at, updated_at,
        transcription_status, transcript, transcript_language, transcription_updated_at
      ) VALUES (?, ?, 'video', ?, 'video/mp4', 100, ?, 1000, 'ready', ?, 'single', ?, ?, ?, ?, 'ja', ?)`,
    ).bind(
      options.id,
      options.userId,
      `${options.id}.mp4`,
      options.capturedAt,
      `users/${options.userId}/assets/${options.id}/media`,
      NOW.toISOString(),
      NOW.toISOString(),
      options.transcriptionStatus ?? "completed",
      options.text,
      NOW.toISOString(),
    ).run();
  }

  it("summarizes only the owner's completed transcripts and caches an unchanged day", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>(async () => ({
      summary: "検査書類を確認し、昼食後に車の設定を見直した。",
      model: "qwen3.8-max-preview",
    }));
    const owner = await signIn("summary-owner", generator);
    await signIn("summary-other");
    const ownerId = await userId("summary-owner");
    const otherId = await userId("summary-other");

    await insertTranscript({ id: "owner-later", userId: ownerId, capturedAt: "2026-07-27T12:00:00.000Z", text: "車の設定を見直した" });
    await insertTranscript({ id: "owner-earlier", userId: ownerId, capturedAt: "2026-07-27T01:00:00.000Z", text: "検査書類を確認した" });
    await insertTranscript({ id: "owner-pending", userId: ownerId, capturedAt: "2026-07-27T13:00:00.000Z", text: null, transcriptionStatus: "pending" });
    await insertTranscript({ id: "owner-outside", userId: ownerId, capturedAt: "2026-07-28T00:00:00.000Z", text: "翌日の記録" });
    await insertTranscript({ id: "other-private", userId: otherId, capturedAt: "2026-07-27T02:00:00.000Z", text: "他人の秘密" });

    const first = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    await expect(first.json()).resolves.toMatchObject({
      summary: "検査書類を確認し、昼食後に車の設定を見直した。",
      model: "qwen3.8-max-preview",
      sourceTranscriptCount: 2,
      generatedAt: NOW.toISOString(),
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[1]).toEqual([
      { capturedAt: "2026-07-27T01:00:00.000Z", text: "検査書類を確認した" },
      { capturedAt: "2026-07-27T12:00:00.000Z", text: "車の設定を見直した" },
    ]);
    expect(JSON.stringify(generator.mock.calls)).not.toContain("他人の秘密");
    expect(JSON.stringify(generator.mock.calls)).not.toContain("翌日の記録");

    const cached = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(cached.status).toBe(200);
    await expect(cached.json()).resolves.toMatchObject({
      summary: "検査書類を確認し、昼食後に車の設定を見直した。",
      sourceTranscriptCount: 2,
    });
    expect(generator).toHaveBeenCalledOnce();

    const shiftedSameSources = await owner.app.request(
      "/v1/days/summary?startAt=2026-07-27T00%3A00%3A00.001Z&endAt=2026-07-28T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );
    expect(shiftedSameSources.status).toBe(200);
    await expect(shiftedSameSources.json()).resolves.toMatchObject({
      summary: "検査書類を確認し、昼食後に車の設定を見直した。",
      sourceTranscriptCount: 2,
    });
    expect(generator).toHaveBeenCalledOnce();
  });

  it("regenerates the cached summary after a source transcript changes", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>()
      .mockResolvedValueOnce({ summary: "午前の記録。", model: "qwen3.8-max-preview" })
      .mockResolvedValueOnce({ summary: "午前と午後の記録。", model: "qwen3.8-max-preview" });
    const owner = await signIn("summary-refresh-owner", generator);
    const ownerId = await userId("summary-refresh-owner");
    await insertTranscript({ id: "changing", userId: ownerId, capturedAt: "2026-07-27T01:00:00.000Z", text: "午前の記録" });

    const first = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(first.status).toBe(200);
    await env.DB.prepare(
      "UPDATE assets SET transcript = ?, transcription_updated_at = ? WHERE id = ?",
    ).bind("午前と午後の記録", "2026-07-27T14:00:00.000Z", "changing").run();

    const refreshed = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ summary: "午前と午後の記録。" });
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it("rejects ranges that are not a calendar-day-sized window", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>();
    const owner = await signIn("summary-invalid-range-owner", generator);
    const response = await owner.app.request(
      "/v1/days/summary?startAt=2026-07-27T00%3A00%3A00.000Z&endAt=2026-07-27T01%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_day_range" } });
    expect(generator).not.toHaveBeenCalled();
  });

  it("returns no summary without completed transcripts and hides provider failures", async () => {
    const unusedGenerator = vi.fn<TestDailySummaryGenerator>();
    const emptyOwner = await signIn("summary-empty-owner", unusedGenerator);
    const empty = await emptyOwner.app.request(summaryPath, {
      headers: { authorization: emptyOwner.authorization },
    }, env);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({
      summary: null,
      model: null,
      sourceTranscriptCount: 0,
      generatedAt: null,
    });
    expect(unusedGenerator).not.toHaveBeenCalled();

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingGenerator = vi.fn<TestDailySummaryGenerator>(async () => {
      throw new Error("private transcript echoed by provider");
    });
    const failingOwner = await signIn("summary-failure-owner", failingGenerator);
    const failingOwnerId = await userId("summary-failure-owner");
    await insertTranscript({ id: "failure-source", userId: failingOwnerId, capturedAt: "2026-07-27T01:00:00.000Z", text: "秘密の日記" });
    const failed = await failingOwner.app.request(summaryPath, {
      headers: { authorization: failingOwner.authorization },
    }, env);
    expect(failed.status).toBe(503);
    const failedBody = await failed.text();
    expect(failedBody).toContain("summary_unavailable");
    expect(failedBody).not.toContain("private transcript");
    expect(failedBody).not.toContain("秘密の日記");
    expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
      event: "daily_summary_generation_failed",
      model: "qwen3.8-max-preview",
    }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("秘密の日記");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private transcript");
    errorLog.mockRestore();
  });
});
