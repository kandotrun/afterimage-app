import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppleIdentity } from "../src/app";

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
  return { app, authorization: `Bearer ${body.token}` };
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

  it("fails closed when the uploaded object size differs from declared metadata", async () => {
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
    await app.request(upload.url, {
      method: "PUT",
      headers: { authorization, "content-type": "image/jpeg", "content-length": "3" },
      body: "bad",
    }, env);

    const complete = await app.request(`/v1/assets/${asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization },
    }, env);
    expect(complete.status).toBe(409);
    await expect(complete.json()).resolves.toMatchObject({ error: { code: "upload_size_mismatch" } });
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
});
