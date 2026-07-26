import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupExpiredState, createApp, type AppleIdentity } from "../src/app";

const NOW = new Date("2026-07-27T00:00:00.000Z");

function makeApp(identity: AppleIdentity = {
  subject: "apple-user-a",
  email: "a@example.com",
  displayName: "A User",
}) {
  return createApp({
    verifyAppleIdentityToken: async () => identity,
    now: () => NOW,
  });
}

async function signIn(subject = "apple-user-a") {
  const app = makeApp({ subject, email: `${subject}@example.com`, displayName: subject });
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
    env.DB.prepare("DELETE FROM assets"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
  ]);
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

    const timeline = await app.request("/v1/assets", { headers: { authorization } }, env);
    const timelineBody = await timeline.json<{ items: Array<{ id: string; status: string }> }>();
    expect(timelineBody.items).toEqual([expect.objectContaining({ id: created.asset.id, status: "ready" })]);

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
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).toBeNull();
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
    expect(await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).toBeNull();
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
