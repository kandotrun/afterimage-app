import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredState, createApp, pollTranscriptions, type AppleIdentity } from "../src/app";
import { AI_CONSENT_VERSION } from "../src/privacy";

const NOW = new Date("2026-07-27T00:00:00.000Z");

type TestDailySummaryGenerator = (
  bindings: Env,
  sources: Array<{
    capturedAt: string;
    transcript: string | null;
    visualSummary: string | null;
    visualSegments: Array<{ startMs: number; endMs: number; caption: string }>;
  }>,
) => Promise<{ summary: string; model: string }>;

type TestMcpResponse = {
  result: {
    tools: Array<{
      name: string;
      annotations?: Record<string, unknown>;
      inputSchema?: {
        properties?: Record<string, {
          type?: string;
          enum?: string[];
          maximum?: number;
        }>;
      };
    }>;
    structuredContent: {
      items: Array<Record<string, unknown>>;
      derivativeId: string;
      [key: string]: unknown;
    };
    content: Array<{
      type: string;
      uri?: string;
      mimeType?: string;
      size?: number;
    }>;
    isError?: boolean;
  };
};

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
  const challengeResponse = await app.request("/v1/auth/apple/challenge", {
    headers: { "cf-connecting-ip": "203.0.113.200" },
  }, env);
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json<{ challengeId: string }>();
  const response = await app.request("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      identityToken: `token-for-${subject}`,
    }),
  }, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string }>();
  const authorization = "Bearer " + body.token;
  const consent = await app.request("/v1/privacy/ai", {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ version: AI_CONSENT_VERSION, consented: true }),
  }, env);
  expect(consent.status).toBe(200);
  return { app, authorization };
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

function envWithFirstResultHook(sqlFragment: string, afterFirst: () => Promise<void>): Env {
  let armed = true;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrap(target.bind(...values));
      }
      if (property === "first") {
        return async (columnName?: string) => {
          const result = columnName === undefined
            ? await target.first()
            : await target.first(columnName);
          if (armed && result !== null) {
            armed = false;
            await afterFirst();
          }
          return result;
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => query.includes(sqlFragment)
          ? wrap(target.prepare(query))
          : target.prepare(query);
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { ...env, DB: db };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_deletion_receipts"),
    env.DB.prepare("DELETE FROM account_deletion_assets"),
    env.DB.prepare("DELETE FROM account_deletion_jobs"),
    env.DB.prepare("DELETE FROM asset_creation_ledger"),
    env.DB.prepare("DELETE FROM ai_consents"),
    env.DB.prepare("DELETE FROM apple_auth_challenges"),
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

describe("daily weather privacy", () => {
  const weather = {
    symbolName: "cloud.sun.fill",
    temperatureCelsius: 28.4,
    highTemperatureCelsius: 31.2,
    lowTemperatureCelsius: 24.8,
    recordedAt: "2026-07-28T01:15:00.000Z",
    attributionLegalUrl: "https://weatherkit.apple.com/legal-attribution.html",
    attributionLightUrl: "https://example.com/weather-light.svg",
    attributionDarkUrl: "https://example.com/weather-dark.svg",
  };

  it("returns a stored weather snapshot only to its owner", async () => {
    const owner = await signIn("weather-owner");
    const other = await signIn("weather-other");

    const stored = await owner.app.request("/v1/weather/days/2026-07-28", {
      method: "PUT",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(weather),
    }, env);
    expect(stored.status).toBe(200);

    const ownerResponse = await owner.app.request(
      "/v1/weather/days?from=2026-07-28&to=2026-07-28",
      { headers: { authorization: owner.authorization } },
      env,
    );
    await expect(ownerResponse.json()).resolves.toEqual({
      items: [{ localDate: "2026-07-28", ...weather }],
    });

    const otherResponse = await other.app.request(
      "/v1/weather/days?from=2026-07-28&to=2026-07-28",
      { headers: { authorization: other.authorization } },
      env,
    );
    await expect(otherResponse.json()).resolves.toEqual({ items: [] });
  });

  it("replaces the owner's snapshot when the same day is recorded again", async () => {
    const owner = await signIn("weather-update-owner");
    const path = "/v1/weather/days/2026-07-28";

    await owner.app.request(path, {
      method: "PUT",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify(weather),
    }, env);
    const replaced = await owner.app.request(path, {
      method: "PUT",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        ...weather,
        symbolName: "sun.max.fill",
        temperatureCelsius: 30.1,
        recordedAt: "2026-07-28T03:00:00.000Z",
      }),
    }, env);

    expect(replaced.status).toBe(200);
    const body = await replaced.json<{
      item: { symbolName: string; temperatureCelsius: number; recordedAt: string };
    }>();
    expect(body.item).toMatchObject({
      symbolName: "sun.max.fill",
      temperatureCelsius: 30.1,
      recordedAt: "2026-07-28T03:00:00.000Z",
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM daily_weather WHERE local_date = ?",
    ).bind("2026-07-28").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
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
    expect(await env.DB.prepare(
      "SELECT upload_id, part_size FROM assets WHERE id = ?",
    ).bind(created.asset.id).first()).toMatchObject({ upload_id: null, part_size: null });
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
    }, envWithRunFailureBeforeCommit("SET status = 'ready', upload_id = NULL"));
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
    }, envWithCommittedRunFailure("SET status = 'ready', upload_lease = NULL"));

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
    const derivativeKey = `users/${user!.id}/assets/${ready.asset.id}/derivatives/expired.jpg`;
    await env.MEDIA.put(derivativeKey, "expired derivative");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("expired-session", user!.id, "expired-session-hash", "2026-07-26T00:00:00.000Z", "2026-07-25T00:00:00.000Z"),
      env.DB.prepare(
        "INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("expired-grant", ready.asset.id, user!.id, "expired-grant-hash", "2026-07-26T00:00:00.000Z", "2026-07-25T00:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES ('expired-derivative-job', ?, 'frame', 'queued', '{}', 0, 0, ?, ?, ?)`,
      ).bind(ready.asset.id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(
        `INSERT INTO media_derivatives (
          id, asset_id, job_id, kind, start_ms, end_ms, status, object_key,
          content_type, byte_size, expires_at, created_at, updated_at
        ) VALUES ('expired-derivative', ?, 'expired-derivative-job', 'frame', 0, 0,
          'ready', ?, 'image/jpeg', 18, '2026-07-26T00:00:00.000Z', ?, ?)`,
      ).bind(ready.asset.id, derivativeKey, NOW.toISOString(), NOW.toISOString()),
    ]);

    const firstCleanup = await cleanupExpiredState(env, NOW);

    expect(firstCleanup).toMatchObject({
      expiredSessions: 1,
      expiredGrants: 1,
      expiredDerivatives: 1,
      quarantinedAssets: 1,
      abandonedAssets: 0,
    });
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE id = 'expired-session'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM media_grants WHERE id = 'expired-grant'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM media_derivatives WHERE id = 'expired-derivative'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM gpu_jobs WHERE id = 'expired-derivative-job'").first()).toBeNull();
    expect(await env.MEDIA.head(derivativeKey)).toBeNull();
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
  it("checks a newly processing Soniox job on the next one-minute tick", async () => {
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

  it("exposes only agent-enabled owner video memories through read-only tools", async () => {
    const owner = await signIn("mcp-tools-owner");
    await signIn("mcp-tools-other");
    const ownerUser = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("mcp-tools-owner").first<{ id: string }>();
    const otherUser = await env.DB.prepare("SELECT id FROM users WHERE apple_subject = ?")
      .bind("mcp-tools-other").first<{ id: string }>();
    const ownerAssetId = crypto.randomUUID();
    const silentAssetId = crypto.randomUUID();
    const disabledAssetId = crypto.randomUUID();
    const otherAssetId = crypto.randomUUID();
    const silentAnalysisJobId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcript, transcript_language, transcription_updated_at
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 11, ?, 12000,
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
          status, object_key, upload_mode, created_at, updated_at, transcription_status
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 12, ?, 20000,
          'ready', ?, 'single', ?, ?, 'pending')`,
      ).bind(
        silentAssetId,
        ownerUser!.id,
        "silent.mp4",
        "2026-07-27T06:30:00.000Z",
        `users/${ownerUser!.id}/assets/${silentAssetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO video_analyses (
          asset_id, job_id, model_id, model_revision, backend, coverage_mode,
          summary, created_at, updated_at
        ) VALUES (?, ?, 'microsoft/Mage-VL', 'pinned-revision', 'frames', 'full', ?, ?, ?)`,
      ).bind(
        silentAssetId,
        silentAnalysisJobId,
        "机の上に鍵を置く様子。",
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO video_analysis_ranges (
          analysis_asset_id, position, start_ms, end_ms
        ) VALUES (?, 0, 0, 20000)`,
      ).bind(silentAssetId),
      env.DB.prepare(
        `INSERT INTO video_analysis_segments (
          analysis_asset_id, position, start_ms, end_ms, caption
        ) VALUES (?, 0, 500, 1500, ?)`,
      ).bind(silentAssetId, "机の上に鍵を置いた。"),
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at, duration_ms,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcript, transcript_language, transcription_updated_at,
          agent_access_enabled
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 12, ?, 9000,
          'ready', ?, 'single', ?, ?, 'completed', ?, 'ja', ?, 0)`,
      ).bind(
        disabledAssetId,
        ownerUser!.id,
        "disabled.mp4",
        "2026-07-27T06:15:00.000Z",
        `users/${ownerUser!.id}/assets/${disabledAssetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
        "共有しない秘密の記憶。",
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
    await env.DB.prepare(
      "UPDATE assets SET agent_access_enabled = 1 WHERE id IN (?, ?)",
    ).bind(ownerAssetId, silentAssetId).run();
    await env.MEDIA.put(`users/${ownerUser!.id}/assets/${ownerAssetId}/media`, "owner-video");
    await env.MEDIA.put(`users/${ownerUser!.id}/assets/${silentAssetId}/media`, "silent-video");

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
      return response.json<TestMcpResponse>();
    }

    const tools = await callMcp(1, "tools/list", {});
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_transcriptions",
      "get_transcription",
      "search_memories",
      "get_memory",
      "get_video",
      "get_video_frame",
      "get_video_clip",
      "get_video_derivative",
    ]);
    expect(tools.result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "list_transcriptions",
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
      }),
    ]));
    const searchTool = tools.result.tools.find((tool) => tool.name === "search_memories");
    expect(searchTool?.inputSchema?.properties).toMatchObject({
      capturedAfter: { type: "string" },
      capturedBefore: { type: "string" },
      analysisStatus: {
        enum: ["queued", "processing", "completed", "failed", "unavailable"],
      },
      limit: { maximum: 50 },
    });
    expect(searchTool?.inputSchema?.properties).not.toHaveProperty("from");
    expect(searchTool?.inputSchema?.properties).not.toHaveProperty("to");

    const listed = await callMcp(2, "tools/call", {
      name: "list_transcriptions",
      arguments: { query: "計画", limit: 10 },
    });
    expect(listed.result.structuredContent.items).toEqual([
      expect.objectContaining({ id: ownerAssetId, filename: "owner.mp4" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("他人だけの秘密");
    expect(JSON.stringify(listed)).not.toContain("共有しない秘密");

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

    const searched = await callMcp(5, "tools/call", {
      name: "search_memories",
      arguments: {
        query: "鍵",
        capturedAfter: "2026-07-27T06:20:00.000Z",
        capturedBefore: "2026-07-27T06:40:00.000Z",
        analysisStatus: "completed",
        limit: 10,
      },
    });
    expect(searched.result.structuredContent.items).toEqual([
      expect.objectContaining({
        id: silentAssetId,
        filename: "silent.mp4",
        visualSummary: "机の上に鍵を置く様子。",
        videoAnalysisStatus: "completed",
      }),
    ]);
    expect(JSON.stringify(searched)).not.toContain("共有しない秘密");
    expect(JSON.stringify(searched)).not.toContain("他人だけの秘密");

    const memory = await callMcp(6, "tools/call", {
      name: "get_memory",
      arguments: { assetId: silentAssetId },
    });
    expect(memory.result.structuredContent).toMatchObject({
      id: silentAssetId,
      transcript: null,
      videoAnalysis: {
        status: "completed",
        summary: "机の上に鍵を置く様子。",
        coverage: [{ startMs: 0, endMs: 20000 }],
        segments: [{ startMs: 500, endMs: 1500, caption: "机の上に鍵を置いた。" }],
      },
      applicableMediaTools: [
        "get_video",
        "get_video_frame",
        "get_video_clip",
        "get_video_derivative",
      ],
    });

    const video = await callMcp(7, "tools/call", {
      name: "get_video",
      arguments: { assetId: ownerAssetId },
    });
    expect(video.result.structuredContent).toMatchObject({
      id: ownerAssetId,
      mimeType: "video/mp4",
      byteSize: 11,
      acceptsRanges: true,
    });
    expect(video.result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource_link",
        mimeType: "video/mp4",
        size: 11,
      }),
    ]));
    const videoUri = video.result.content.find(
      (content: { type: string; uri?: string }) => content.type === "resource_link",
    )?.uri;
    expect(videoUri).toEqual(expect.any(String));
    const rangedVideo = await owner.app.request(videoUri!, {
      headers: { range: "bytes=0-4" },
    }, env);
    expect(rangedVideo.status).toBe(206);
    expect(new TextDecoder().decode(await rangedVideo.arrayBuffer())).toBe("owner");

    const frame = await callMcp(8, "tools/call", {
      name: "get_video_frame",
      arguments: { assetId: silentAssetId, timeMs: 750 },
    });
    expect(frame.result.structuredContent).toMatchObject({
      status: "queued",
      kind: "frame",
      startMs: 750,
      endMs: 750,
      retryAfterMs: 15000,
    });
    expect(frame.result.structuredContent.derivativeId).toEqual(expect.any(String));

    const clip = await callMcp(9, "tools/call", {
      name: "get_video_clip",
      arguments: { assetId: silentAssetId, startMs: 1000, endMs: 3000 },
    });
    expect(clip.result.structuredContent).toMatchObject({
      status: "queued",
      kind: "clip",
      startMs: 1000,
      endMs: 3000,
    });

    const derivative = await callMcp(10, "tools/call", {
      name: "get_video_derivative",
      arguments: { derivativeId: frame.result.structuredContent.derivativeId },
    });
    expect(derivative.result.structuredContent).toMatchObject({
      status: "queued",
      derivativeId: frame.result.structuredContent.derivativeId,
    });

    const frameObjectKey = `users/${ownerUser!.id}/assets/${silentAssetId}/derivatives/frame.jpg`;
    await env.MEDIA.put(frameObjectKey, "jpeg");
    await env.DB.prepare(
      `UPDATE media_derivatives
          SET status = 'ready', object_key = ?, content_type = 'image/jpeg', byte_size = 4
        WHERE id = ?`,
    ).bind(frameObjectKey, frame.result.structuredContent.derivativeId).run();
    const readyDerivative = await callMcp(11, "tools/call", {
      name: "get_video_derivative",
      arguments: { derivativeId: frame.result.structuredContent.derivativeId },
    });
    expect(readyDerivative.result.structuredContent).toMatchObject({
      status: "ready",
      mimeType: "image/jpeg",
      byteSize: 4,
      acceptsRanges: true,
    });
    expect(readyDerivative.result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_link", mimeType: "image/jpeg", size: 4 }),
    ]));

    const oversizedClip = await callMcp(12, "tools/call", {
      name: "get_video_clip",
      arguments: { assetId: silentAssetId, startMs: 0, endMs: 61000 },
    });
    expect(oversizedClip.result).toMatchObject({ isError: true });

    const disabledMemory = await callMcp(13, "tools/call", {
      name: "get_memory",
      arguments: { assetId: disabledAssetId },
    });
    expect(disabledMemory.result).toMatchObject({ isError: true });
    expect(JSON.stringify(disabledMemory)).not.toContain("共有しない秘密");

    const disabledTranscription = await callMcp(14, "tools/call", {
      name: "get_transcription",
      arguments: { assetId: disabledAssetId },
    });
    expect(disabledTranscription.result).toMatchObject({ isError: true });
    expect(JSON.stringify(disabledTranscription)).not.toContain("共有しない秘密");
  });
});

describe("agent access privacy boundary", () => {
  const workerToken = `aft_worker_${"w".repeat(43)}`;

  async function tokenHash(value: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function gpuEnv() {
    return { ...env, MAGE_WORKER_TOKEN_HASH: await tokenHash(workerToken) };
  }

  async function createReadyVideo(subject: string, enableAgentAccess = true) {
    const owner = await signIn(subject);
    const created = await owner.app.request("/v1/assets", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video",
        filename: `${subject}.mov`,
        contentType: "video/quicktime",
        byteSize: 5,
        capturedAt: "2026-07-27T00:00:00.000Z",
        durationMs: 2_000,
        width: 1_920,
        height: 1_080,
      }),
    }, env);
    const body = await created.json<{
      asset: { id: string; agentAccessEnabled: boolean };
      upload: { url: string };
    }>();
    await owner.app.request(body.upload.url, {
      method: "PUT",
      headers: {
        authorization: owner.authorization,
        "content-type": "video/quicktime",
        "content-length": "5",
      },
      body: "video",
    }, env);
    await owner.app.request(`/v1/assets/${body.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization: owner.authorization },
    }, env);
    if (enableAgentAccess) {
      const enabled = await owner.app.request(`/v1/assets/${body.asset.id}/agent-access`, {
        method: "PATCH",
        headers: { authorization: owner.authorization, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }, env);
      expect(enabled.status).toBe(200);
    }
    return { ...owner, assetId: body.asset.id, createdAsset: body.asset };
  }

  it("enables existing and new assets after active consent", async () => {
    const owner = await createReadyVideo("agent-access-default", false);
    expect(owner.createdAsset.agentAccessEnabled).toBe(true);

    const timeline = await owner.app.request("/v1/assets", {
      headers: { authorization: owner.authorization },
    }, env);
    await expect(timeline.json()).resolves.toMatchObject({
      items: [{
        id: owner.assetId,
        agentAccessEnabled: true,
        videoAnalysisStatus: "queued",
      }],
    });
    await expect(env.DB.prepare(
      "SELECT kind, status FROM gpu_jobs WHERE asset_id = ?",
    ).bind(owner.assetId).first()).resolves.toEqual({ kind: "analysis", status: "queued" });
  });

  it("reports the owner-visible video analysis lifecycle", async () => {
    const owner = await createReadyVideo("agent-analysis-lifecycle");
    const disabled = await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }, env);
    await expect(disabled.json()).resolves.toMatchObject({
      asset: { videoAnalysisStatus: "queued" },
    });

    const enabled = await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }, env);
    await expect(enabled.json()).resolves.toMatchObject({
      asset: { videoAnalysisStatus: "queued" },
    });

    await env.DB.prepare(
      `INSERT INTO video_analyses (
        asset_id, job_id, model_id, model_revision, backend, coverage_mode,
        summary, created_at, updated_at
      ) VALUES (?, 'completed-analysis-job', 'microsoft/Mage-VL', 'pinned-revision',
        'frames', 'full', '完了した解析', ?, ?)`,
    ).bind(owner.assetId, NOW.toISOString(), NOW.toISOString()).run();
    const timeline = await owner.app.request("/v1/assets", {
      headers: { authorization: owner.authorization },
    }, env);
    await expect(timeline.json()).resolves.toMatchObject({
      items: [{ id: owner.assetId, videoAnalysisStatus: "completed" }],
    });
  });

  it("lets the owner disable agent access without changing transcription", async () => {
    const owner = await createReadyVideo("agent-access-owner");
    await env.DB.prepare(
      `UPDATE assets
          SET transcription_status = 'completed', transcript = '残しておく文字起こし'
        WHERE id = ?`,
    ).bind(owner.assetId).run();

    const disabled = await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }, env);

    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      asset: { id: owner.assetId, agentAccessEnabled: false },
    });
    await expect(env.DB.prepare(
      "SELECT agent_access_enabled, transcript FROM assets WHERE id = ?",
    ).bind(owner.assetId).first()).resolves.toEqual({
      agent_access_enabled: 0,
      transcript: "残しておく文字起こし",
    });

    const enabled = await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }, env);
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      asset: { id: owner.assetId, agentAccessEnabled: true },
    });
  });

  it("hides ownership when another user changes agent access", async () => {
    const owner = await createReadyVideo("agent-access-private-owner");
    const other = await signIn("agent-access-private-other");
    const response = await other.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: other.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }, env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "asset_not_found" } });
  });

  it("keeps app and Mage worker grants while revoking agent grants", async () => {
    const owner = await createReadyVideo("agent-access-grants");
    const appGrant = await owner.app.request(`/v1/assets/${owner.assetId}/playback`, {
      method: "POST",
      headers: { authorization: owner.authorization },
    }, env);
    const appGrantBody = await appGrant.json<{ url: string }>();
    const agentToken = "a".repeat(43);
    const workerGrantToken = "b".repeat(43);
    const derivativeWorkerToken = "c".repeat(43);
    const expiresAt = new Date(NOW.getTime() + 300_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at, purpose)
         SELECT 'agent-grant', id, user_id, ?, ?, ?, 'agent' FROM assets WHERE id = ?`,
      ).bind(await tokenHash(agentToken), expiresAt, NOW.toISOString(), owner.assetId),
      env.DB.prepare(
        `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at, purpose)
         SELECT 'worker-grant', id, user_id, ?, ?, ?, 'worker' FROM assets WHERE id = ?`,
      ).bind(await tokenHash(workerGrantToken), expiresAt, NOW.toISOString(), owner.assetId),
      env.DB.prepare(
        `INSERT INTO media_grants (id, asset_id, user_id, token_hash, expires_at, created_at, purpose, derivative_id)
         SELECT 'derivative-worker-grant', id, user_id, ?, ?, ?, 'worker', 'derivative-worker'
           FROM assets WHERE id = ?`,
      ).bind(await tokenHash(derivativeWorkerToken), expiresAt, NOW.toISOString(), owner.assetId),
    ]);

    await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
      method: "PATCH",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }, env);

    expect((await owner.app.request(appGrantBody.url, {}, env)).status).toBe(200);
    expect((await owner.app.request(`/v1/media/${agentToken}`, {}, env)).status).toBe(404);
    expect((await owner.app.request(`/v1/media/${workerGrantToken}`, {}, env)).status).toBe(200);
    expect((await owner.app.request(`/v1/media/${derivativeWorkerToken}`, {}, env)).status).toBe(404);
  });

  it("does not create an agent grant after access is disabled following asset lookup", async () => {
    const owner = await createReadyVideo("agent-access-interleaved-grant");
    const created = await owner.app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "Interleaved grant" }),
    }, env);
    const { token } = await created.json<{ token: string }>();
    const interleavedEnvironment = envWithFirstResultHook(
      "SELECT id, filename, content_type, byte_size, duration_ms",
      async () => {
        await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
          method: "PATCH",
          headers: { authorization: owner.authorization, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }, env);
      },
    );
    const response = await owner.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_video", arguments: { assetId: owner.assetId } },
      }),
    }, interleavedEnvironment);
    const result = await response.json<TestMcpResponse>();

    expect(result.result.isError).toBe(true);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_grants WHERE asset_id = ? AND purpose = 'agent'",
    ).bind(owner.assetId).first()).resolves.toEqual({ count: 0 });
  });

  it("does not queue a derivative after access is disabled following asset lookup", async () => {
    const owner = await createReadyVideo("agent-access-interleaved-derivative");
    const created = await owner.app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "Interleaved derivative" }),
    }, env);
    const { token } = await created.json<{ token: string }>();
    const interleavedEnvironment = envWithFirstResultHook(
      "SELECT id, filename, content_type, byte_size, duration_ms",
      async () => {
        await owner.app.request(`/v1/assets/${owner.assetId}/agent-access`, {
          method: "PATCH",
          headers: { authorization: owner.authorization, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }, env);
      },
    );
    const response = await owner.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_video_frame",
          arguments: { assetId: owner.assetId, timeMs: 750 },
        },
      }),
    }, interleavedEnvironment);
    const result = await response.json<TestMcpResponse>();

    expect(result.result.isError).toBe(true);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_derivatives WHERE asset_id = ?",
    ).bind(owner.assetId).first()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM gpu_jobs WHERE asset_id = ? AND kind IN ('frame', 'clip')",
    ).bind(owner.assetId).first()).resolves.toEqual({ count: 0 });
  });

  it("leases one enabled ready video atomically", async () => {
    const owner = await createReadyVideo("agent-access-lease");
    const workerEnvironment = await gpuEnv();
    const leaseRequest = () => owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);

    const [first, second] = await Promise.all([leaseRequest(), leaseRequest()]);
    expect([first.status, second.status].sort()).toEqual([200, 204]);
    const leased = first.status === 200 ? first : second;
    await expect(leased.json()).resolves.toMatchObject({
      job: {
        kind: "analysis",
        asset: { id: owner.assetId },
        analysis: {
          modelId: "microsoft/Mage-VL",
          modelRevision: "8484f3154beea3b563bee99e2fab2d6c8bb5d3f3",
          backend: "frames",
        },
      },
    });
  });

  it("rejects stale analysis completion after AI consent is withdrawn", async () => {
    const owner = await createReadyVideo("agent-access-stale-job");
    const workerEnvironment = await gpuEnv();
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();

    await owner.app.request("/v1/privacy/ai", {
      method: "PUT",
      headers: { authorization: owner.authorization, "content-type": "application/json" },
      body: JSON.stringify({ version: AI_CONSENT_VERSION, consented: false }),
    }, env);
    const completed = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/analysis`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseToken: leased.job.leaseToken,
        modelId: "microsoft/Mage-VL",
        modelRevision: "8484f3154beea3b563bee99e2fab2d6c8bb5d3f3",
        backend: "frames",
        coverageMode: "full",
        analyzedRanges: [{ startMs: 0, endMs: 2_000 }],
        summary: "机の上に鍵を置いた。",
        segments: [{ startMs: 500, endMs: 1_200, caption: "鍵を置いた。" }],
      }),
    }, workerEnvironment);

    expect(completed.status).toBe(404);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM video_analyses WHERE asset_id = ?",
    ).bind(owner.assetId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("rejects analysis completion when AI consent is withdrawn after lease validation", async () => {
    const owner = await createReadyVideo("agent-access-interleaved-disable");
    const workerEnvironment = await gpuEnv();
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();
    const interleavedEnvironment = {
      ...envWithFirstResultHook("j.lease_token_hash = ?", async () => {
        await owner.app.request("/v1/privacy/ai", {
          method: "PUT",
          headers: { authorization: owner.authorization, "content-type": "application/json" },
          body: JSON.stringify({ version: AI_CONSENT_VERSION, consented: false }),
        }, env);
      }),
      MAGE_WORKER_TOKEN_HASH: workerEnvironment.MAGE_WORKER_TOKEN_HASH,
    };
    const completed = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/analysis`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseToken: leased.job.leaseToken,
        modelId: "microsoft/Mage-VL",
        modelRevision: "8484f3154beea3b563bee99e2fab2d6c8bb5d3f3",
        backend: "frames",
        coverageMode: "full",
        analyzedRanges: [{ startMs: 0, endMs: 2_000 }],
        summary: "机の上に鍵を置いた。",
        segments: [{ startMs: 500, endMs: 1_200, caption: "鍵を置いた。" }],
      }),
    }, interleavedEnvironment);

    expect(completed.status).toBe(404);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM video_analyses WHERE asset_id = ?",
    ).bind(owner.assetId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("rejects a heartbeat when lease ownership changes after validation", async () => {
    const owner = await createReadyVideo("agent-access-interleaved-lease");
    const workerEnvironment = await gpuEnv();
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();
    const replacementExpiresAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    const replacementHash = await tokenHash("r".repeat(43));
    const interleavedEnvironment = {
      ...envWithFirstResultHook("j.lease_token_hash = ?", async () => {
        await env.DB.prepare(
          "UPDATE gpu_jobs SET lease_token_hash = ?, lease_expires_at = ? WHERE id = ?",
        ).bind(replacementHash, replacementExpiresAt, leased.job.id).run();
      }),
      MAGE_WORKER_TOKEN_HASH: workerEnvironment.MAGE_WORKER_TOKEN_HASH,
    };
    const heartbeat = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ leaseToken: leased.job.leaseToken }),
    }, interleavedEnvironment);

    expect(heartbeat.status).toBe(404);
    await expect(env.DB.prepare(
      "SELECT lease_token_hash, lease_expires_at FROM gpu_jobs WHERE id = ?",
    ).bind(leased.job.id).first()).resolves.toEqual({
      lease_token_hash: replacementHash,
      lease_expires_at: replacementExpiresAt,
    });
  });

  it("streams a leased frame derivative to private R2 before marking it ready", async () => {
    const owner = await createReadyVideo("agent-access-frame-job");
    const workerEnvironment = await gpuEnv();
    const nowIso = NOW.toISOString();
    const expiresAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES ('frame-job', ?, 'frame', 'queued', ?, 100, 0, ?, ?, ?)`,
      ).bind(owner.assetId, JSON.stringify({ derivativeId: "frame-derivative", timeMs: 750 }), nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO media_derivatives (
          id, asset_id, job_id, kind, start_ms, end_ms, status,
          expires_at, created_at, updated_at
        ) VALUES ('frame-derivative', ?, 'frame-job', 'frame', 750, 750, 'queued', ?, ?, ?)`,
      ).bind(owner.assetId, expiresAt, nowIso, nowIso),
    ]);
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();
    expect(leased.job.id).toBe("frame-job");

    const uploaded = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/derivative`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "x-afterimage-lease-token": leased.job.leaseToken,
        "content-type": "image/jpeg",
        "content-length": "4",
      },
      body: "jpeg",
    }, workerEnvironment);

    expect(uploaded.status).toBe(200);
    const derivative = await env.DB.prepare(
      `SELECT status, content_type, byte_size, object_key
         FROM media_derivatives WHERE id = 'frame-derivative'`,
    ).first<{
      status: string;
      content_type: string;
      byte_size: number;
      object_key: string;
    }>();
    expect(derivative).toMatchObject({
      status: "ready",
      content_type: "image/jpeg",
      byte_size: 4,
    });
    expect((await env.MEDIA.get(derivative!.object_key))?.size).toBe(4);
  });

  it("keeps a replacement lease derivative when a stale upload finishes later", async () => {
    const owner = await createReadyVideo("agent-access-stale-derivative-upload");
    const workerEnvironment = await gpuEnv();
    const nowIso = NOW.toISOString();
    const expiresAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES ('raced-frame-job', ?, 'frame', 'queued', ?, 100, 0, ?, ?, ?)`,
      ).bind(
        owner.assetId,
        JSON.stringify({ derivativeId: "raced-frame-derivative", timeMs: 750 }),
        nowIso,
        nowIso,
        nowIso,
      ),
      env.DB.prepare(
        `INSERT INTO media_derivatives (
          id, asset_id, job_id, kind, start_ms, end_ms, status,
          expires_at, created_at, updated_at
        ) VALUES (
          'raced-frame-derivative', ?, 'raced-frame-job', 'frame',
          750, 750, 'queued', ?, ?, ?
        )`,
      ).bind(owner.assetId, expiresAt, nowIso, nowIso),
    ]);
    const firstPutStarted = deferred();
    const releaseFirstPut = deferred();
    let putCount = 0;
    const media = new Proxy(env.MEDIA, {
      get(target, property) {
        if (property === "put") {
          return async (
            key: string,
            value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
            options?: R2PutOptions,
          ) => {
            putCount += 1;
            if (putCount === 1) {
              firstPutStarted.resolve();
              await releaseFirstPut.promise;
            }
            return target.put(key, value, options);
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const racedEnvironment = { ...workerEnvironment, MEDIA: media };
    const leaseRequest = () => owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, racedEnvironment);
    const firstLease = await leaseRequest();
    const firstLeased = await firstLease.json<{ job: { id: string; leaseToken: string } }>();
    const firstUpload = owner.app.request(`/v1/internal/gpu-jobs/${firstLeased.job.id}/derivative`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "x-afterimage-lease-token": firstLeased.job.leaseToken,
        "content-type": "image/jpeg",
        "content-length": "4",
      },
      body: "old!",
    }, racedEnvironment);
    await firstPutStarted.promise;

    await env.DB.prepare(
      "UPDATE gpu_jobs SET lease_expires_at = ? WHERE id = ?",
    ).bind(nowIso, firstLeased.job.id).run();
    const secondLease = await leaseRequest();
    const secondLeased = await secondLease.json<{ job: { id: string; leaseToken: string } }>();
    expect(secondLeased.job.id).toBe(firstLeased.job.id);
    expect(secondLeased.job.leaseToken).not.toBe(firstLeased.job.leaseToken);
    const secondUpload = await owner.app.request(`/v1/internal/gpu-jobs/${secondLeased.job.id}/derivative`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "x-afterimage-lease-token": secondLeased.job.leaseToken,
        "content-type": "image/jpeg",
        "content-length": "4",
      },
      body: "new!",
    }, racedEnvironment);
    expect(secondUpload.status).toBe(200);

    releaseFirstPut.resolve();
    expect((await firstUpload).status).toBe(404);
    const derivative = await env.DB.prepare(
      "SELECT status, object_key FROM media_derivatives WHERE id = 'raced-frame-derivative'",
    ).first<{ status: string; object_key: string }>();
    expect(derivative?.status).toBe("ready");
    expect(await (await env.MEDIA.get(derivative!.object_key))?.text()).toBe("new!");
    expect((await env.MEDIA.list({
      prefix: derivative!.object_key.split("/derivatives/", 1)[0] + "/derivatives/",
    })).objects.map((object) => object.key)).toEqual([derivative!.object_key]);
  });

  it("requeues a retryable failed lease without storing exception text", async () => {
    const owner = await createReadyVideo("agent-access-failed-job");
    const workerEnvironment = await gpuEnv();
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();
    const failed = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/fail`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseToken: leased.job.leaseToken,
        code: "inference_failed",
      }),
    }, workerEnvironment);

    expect(failed.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT status, error_code, available_at, lease_token_hash FROM gpu_jobs WHERE id = ?",
    ).bind(leased.job.id).first()).resolves.toEqual({
      status: "queued",
      error_code: "inference_failed",
      available_at: "2026-07-27T00:01:00.000Z",
      lease_token_hash: null,
    });
  });

  it("marks a derivative failed after the final worker attempt", async () => {
    const owner = await createReadyVideo("agent-access-final-derivative-failure");
    const workerEnvironment = await gpuEnv();
    const nowIso = NOW.toISOString();
    const expiresAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES ('final-frame-job', ?, 'frame', 'queued', ?, 100, 2, ?, ?, ?)`,
      ).bind(
        owner.assetId,
        JSON.stringify({ derivativeId: "final-frame-derivative", timeMs: 750 }),
        nowIso,
        nowIso,
        nowIso,
      ),
      env.DB.prepare(
        `INSERT INTO media_derivatives (
          id, asset_id, job_id, kind, start_ms, end_ms, status,
          expires_at, created_at, updated_at
        ) VALUES (
          'final-frame-derivative', ?, 'final-frame-job', 'frame',
          750, 750, 'queued', ?, ?, ?
        )`,
      ).bind(owner.assetId, expiresAt, nowIso, nowIso),
    ]);
    const lease = await owner.app.request("/v1/internal/gpu-jobs/lease", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: "spark-1721",
        capabilities: { backends: ["frames"], modelId: "microsoft/Mage-VL" },
      }),
    }, workerEnvironment);
    const leased = await lease.json<{ job: { id: string; leaseToken: string } }>();
    expect(leased.job.id).toBe("final-frame-job");

    const failed = await owner.app.request(`/v1/internal/gpu-jobs/${leased.job.id}/fail`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseToken: leased.job.leaseToken,
        code: "decode_failed",
      }),
    }, workerEnvironment);

    expect(failed.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT status, error_code FROM gpu_jobs WHERE id = 'final-frame-job'",
    ).first()).resolves.toEqual({ status: "failed", error_code: "decode_failed" });
    await expect(env.DB.prepare(
      "SELECT status, error_code FROM media_derivatives WHERE id = 'final-frame-derivative'",
    ).first()).resolves.toEqual({ status: "failed", error_code: "decode_failed" });
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
    await env.DB.prepare("UPDATE assets SET agent_access_enabled = 1 WHERE id = ?")
      .bind(options.id)
      .run();
  }

  async function insertVisualAnalysis(options: {
    assetId: string;
    summary: string;
    caption: string;
  }) {
    await env.DB.prepare(
      `INSERT INTO video_analyses (
        asset_id, job_id, model_id, model_revision, backend, coverage_mode,
        summary, created_at, updated_at
      ) VALUES (?, ?, 'microsoft/Mage-VL', 'revision', 'frames', 'full', ?, ?, ?)`,
    ).bind(
      options.assetId,
      `job-${options.assetId}`,
      options.summary,
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
    await env.DB.prepare(
      `INSERT INTO video_analysis_segments (
        analysis_asset_id, position, start_ms, end_ms, caption
      ) VALUES (?, 0, 500, 1500, ?)`,
    ).bind(options.assetId, options.caption).run();
    await env.DB.prepare(
      `INSERT INTO video_analysis_ranges (
        analysis_asset_id, position, start_ms, end_ms
      ) VALUES (?, 0, 0, 2000)`,
    ).bind(options.assetId).run();
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
      sourceVisualAnalysisCount: 0,
      generatedAt: NOW.toISOString(),
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[1]).toEqual([
      {
        capturedAt: "2026-07-27T01:00:00.000Z",
        transcript: "検査書類を確認した",
        visualSummary: null,
        visualSegments: [],
      },
      {
        capturedAt: "2026-07-27T12:00:00.000Z",
        transcript: "車の設定を見直した",
        visualSummary: null,
        visualSegments: [],
      },
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

  it("reuses a migrated transcript-only cache entry without regenerating it", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>();
    const owner = await signIn("summary-migrated-cache-owner", generator);
    const ownerId = await userId("summary-migrated-cache-owner");
    await insertTranscript({
      id: "migrated-cache-source",
      userId: ownerId,
      capturedAt: "2026-07-27T01:00:00.000Z",
      text: "移行前に要約された記録",
    });
    const digestInput = JSON.stringify([[
      "migrated-cache-source",
      "2026-07-27T01:00:00.000Z",
      NOW.toISOString(),
      "移行前に要約された記録",
    ]]);
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestInput));
    const sourceDigest = Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare(
      `INSERT INTO daily_summaries (
        user_id, start_at, end_at, source_digest, source_transcript_count,
        source_visual_analysis_count, summary, model, generated_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?, 'qwen3.8-max-preview', ?)`,
    ).bind(
      ownerId,
      "2026-07-27T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z",
      sourceDigest,
      "移行済みの要約",
      "2026-07-27T23:00:00.000Z",
    ).run();

    const requestHeaders = new Headers();
    requestHeaders.set("Author" + "ization", owner.authorization);
    const response = await owner.app.request(summaryPath, { headers: requestHeaders }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: "移行済みの要約",
      sourceTranscriptCount: 1,
      sourceVisualAnalysisCount: 0,
      generatedAt: "2026-07-27T23:00:00.000Z",
    });
    expect(generator).not.toHaveBeenCalled();
  });

  it("summarizes visual-only memories, excludes other owners, and invalidates when Mage output changes", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>()
      .mockResolvedValueOnce({ summary: "犬が庭を走り、玄関で止まった。", model: "qwen3.8-max-preview" })
      .mockResolvedValueOnce({ summary: "犬が庭を走り、飼い主の前で止まった。", model: "qwen3.8-max-preview" });
    const owner = await signIn("summary-visual-owner", generator);
    await signIn("summary-visual-other");
    const ownerId = await userId("summary-visual-owner");
    const otherId = await userId("summary-visual-other");

    await insertTranscript({
      id: "visual-only",
      userId: ownerId,
      capturedAt: "2026-07-27T03:00:00.000Z",
      text: null,
      transcriptionStatus: "pending",
    });
    await insertVisualAnalysis({
      assetId: "visual-only",
      summary: "犬が庭を走っている。",
      caption: "犬が玄関で止まった。",
    });
    await insertTranscript({
      id: "other-visual-only",
      userId: otherId,
      capturedAt: "2026-07-27T04:00:00.000Z",
      text: null,
      transcriptionStatus: "pending",
    });
    await insertVisualAnalysis({
      assetId: "other-visual-only",
      summary: "他人の部屋が映っている。",
      caption: "他人の秘密が見える。",
    });

    const first = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      summary: "犬が庭を走り、玄関で止まった。",
      sourceTranscriptCount: 0,
      sourceVisualAnalysisCount: 1,
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[1]).toEqual([{
      capturedAt: "2026-07-27T03:00:00.000Z",
      transcript: null,
      visualSummary: "犬が庭を走っている。",
      visualSegments: [{ startMs: 500, endMs: 1500, caption: "犬が玄関で止まった。" }],
    }]);
    expect(JSON.stringify(generator.mock.calls)).not.toContain("他人の秘密");

    await env.DB.prepare(
      "UPDATE video_analysis_ranges SET end_ms = ? WHERE analysis_asset_id = ? AND position = 0",
    ).bind(2500, "visual-only").run();
    const coverageHeaders = new Headers();
    coverageHeaders.set("Authorization", owner.authorization);
    const coverageRefreshed = await owner.app.request(summaryPath, { headers: coverageHeaders }, env);
    expect(coverageRefreshed.status).toBe(200);
    expect(generator).toHaveBeenCalledOnce();

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE video_analyses SET summary = ?, updated_at = ? WHERE asset_id = ?",
      ).bind("犬が庭を走り、飼い主へ近づく。", "2026-07-27T14:00:00.000Z", "visual-only"),
      env.DB.prepare(
        "UPDATE video_analysis_segments SET caption = ? WHERE analysis_asset_id = ? AND position = 0",
      ).bind("犬が飼い主の前で止まった。", "visual-only"),
    ]);

    const refreshed = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      summary: "犬が庭を走り、飼い主の前で止まった。",
      sourceTranscriptCount: 0,
      sourceVisualAnalysisCount: 1,
    });
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls[1]?.[1][0]).toMatchObject({
      visualSummary: "犬が庭を走り、飼い主へ近づく。",
      visualSegments: [{ caption: "犬が飼い主の前で止まった。" }],
    });
  });

  it("counts Mage output against daily summary source bounds even when agent sharing is disabled", async () => {
    const generator = vi.fn<TestDailySummaryGenerator>(async () => ({
      summary: "文字起こしだけを要約した。",
      model: "qwen3.8-max-preview",
    }));
    const owner = await signIn("summary-disabled-visual-owner", generator);
    const ownerId = await userId("summary-disabled-visual-owner");
    await insertTranscript({
      id: "disabled-visual",
      userId: ownerId,
      capturedAt: "2026-07-27T03:00:00.000Z",
      text: "文字起こしだけを使う。",
    });
    await insertVisualAnalysis({
      assetId: "disabled-visual",
      summary: "送信してはいけない映像解析。",
      caption: "送信してはいけない映像説明。",
    });
    const segmentStatements = Array.from({ length: 100 }, (_, index) => env.DB.prepare(
      `INSERT INTO video_analysis_segments (
        analysis_asset_id, position, start_ms, end_ms, caption
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "disabled-visual",
      index + 1,
      2000 + index * 10,
      2001 + index * 10,
      "秘".repeat(2000),
    ));
    await env.DB.batch(segmentStatements);
    await env.DB.prepare("UPDATE assets SET agent_access_enabled = 0 WHERE id = ?")
      .bind("disabled-visual").run();

    const response = await owner.app.request(summaryPath, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "daily_summary_too_large" },
    });
    expect(generator).not.toHaveBeenCalled();
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

  it("rejects oversized transcript and visual sources before calling the provider", async () => {
    const transcriptGenerator = vi.fn<TestDailySummaryGenerator>();
    const transcriptOwner = await signIn("summary-row-limit-owner", transcriptGenerator);
    const transcriptOwnerId = await userId("summary-row-limit-owner");
    for (let index = 0; index < 201; index += 1) {
      await insertTranscript({
        id: `row-limit-${index}`,
        userId: transcriptOwnerId,
        capturedAt: `2026-07-27T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
        text: `記録${index}`,
      });
    }
    const tooMany = await transcriptOwner.app.request(summaryPath, {
      headers: { authorization: transcriptOwner.authorization },
    }, env);
    expect(tooMany.status).toBe(413);
    await expect(tooMany.json()).resolves.toMatchObject({ error: { code: "daily_summary_too_large" } });
    expect(transcriptGenerator).not.toHaveBeenCalled();

    const visualGenerator = vi.fn<TestDailySummaryGenerator>();
    const visualOwner = await signIn("summary-char-limit-owner", visualGenerator);
    const visualOwnerId = await userId("summary-char-limit-owner");
    await insertTranscript({
      id: "visual-char-limit",
      userId: visualOwnerId,
      capturedAt: "2026-07-27T03:00:00.000Z",
      text: null,
      transcriptionStatus: "pending",
    });
    await insertVisualAnalysis({
      assetId: "visual-char-limit",
      summary: "映".repeat(200_001),
      caption: "短い映像説明",
    });
    const tooLong = await visualOwner.app.request(summaryPath, {
      headers: { authorization: visualOwner.authorization },
    }, env);
    expect(tooLong.status).toBe(413);
    await expect(tooLong.json()).resolves.toMatchObject({ error: { code: "daily_summary_too_large" } });
    expect(visualGenerator).not.toHaveBeenCalled();
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
      sourceVisualAnalysisCount: 0,
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
