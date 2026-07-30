import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollTranscriptions } from "../src/app";
import { AI_CONSENT_VERSION } from "../src/privacy";
import { uploadToSoniox } from "../src/soniox";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const OBJECT_KEY = "users/transcription-owner/assets/streamed-asset/media";

function deferred() {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve() {
      complete?.();
    },
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media_grants"),
    env.DB.prepare("DELETE FROM assets"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  await env.DB.prepare(
    `INSERT INTO users (id, apple_subject, created_at, updated_at)
     VALUES ('transcription-owner', 'transcription-owner', ?, ?)`,
  ).bind(NOW.toISOString(), NOW.toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO ai_consents (
      user_id, version, consented_at, updated_at
    ) VALUES ('transcription-owner', ?, ?, ?)`,
  ).bind(AI_CONSENT_VERSION, NOW.toISOString(), NOW.toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO assets (
      id, user_id, kind, filename, content_type, byte_size, captured_at,
      status, object_key, upload_mode, created_at, updated_at,
      transcription_status, transcription_updated_at
    ) VALUES (
      'streamed-asset', 'transcription-owner', 'video', 'memory.mov',
      'video/quicktime', 14, ?, 'ready', ?, 'single', ?, ?, 'pending', ?
    )`,
  ).bind(
    NOW.toISOString(),
    OBJECT_KEY,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
  await env.MEDIA.put(OBJECT_KEY, "streamed-media");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.MEDIA.delete(OBJECT_KEY);
});

describe("scheduled transcription upload", () => {
  it("streams ready media to Soniox without materializing the R2 body", async () => {
    let uploadedFilename: string | undefined;
    let uploadedText: string | undefined;
    const sonioxFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/files")) {
        const uploadRequest = new Request(url, {
          method: "POST",
          headers: new Headers(init?.headers),
          body: init?.body ?? null,
        });
        const form = await uploadRequest.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return Response.json({ message: "missing file" }, { status: 400 });
        }
        uploadedFilename = file.name;
        uploadedText = await file.text();
        return Response.json({
          id: "file-stream",
          filename: file.name,
          size: file.size,
          created_at: NOW.toISOString(),
        }, { status: 201 });
      }
      if (url.endsWith("/transcriptions")) {
        return Response.json({ id: "job-stream" }, { status: 201 });
      }
      return Response.json({ message: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", sonioxFetch);

    const streamingMedia = new Proxy(env.MEDIA, {
      get(target, property) {
        if (property === "get") {
          return async (key: string) => {
            const object = await target.get(key);
            if (!object) return null;
            return new Proxy(object, {
              get(objectTarget, member) {
                if (member === "arrayBuffer") {
                  return async () => {
                    throw new Error("R2 body was materialized");
                  };
                }
                const value = Reflect.get(objectTarget, member, objectTarget);
                return typeof value === "function" ? value.bind(objectTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transcriptionEnv: Env = {
      ...env,
      MEDIA: streamingMedia,
      SONIOX_API_KEY: "test-key",
    };

    const result = await pollTranscriptions(transcriptionEnv, NOW);

    expect(result).toEqual({ processed: 1 });
    expect(uploadedFilename).toBe("memory.mov");
    expect(uploadedText).toBe("streamed-media");
    expect(await env.DB.prepare(
      `SELECT transcription_status, soniox_file_id, soniox_transcription_id
         FROM assets WHERE id = 'streamed-asset'`,
    ).first()).toEqual({
      transcription_status: "processing",
      soniox_file_id: "file-stream",
      soniox_transcription_id: "job-stream",
    });
  });

  it("claims a pending asset before upload so overlapping ticks do not duplicate it", async () => {
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    let fileRequests = 0;
    const sonioxFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/files")) {
        fileRequests += 1;
        const drained = init?.body instanceof ReadableStream
          ? new Response(init.body).arrayBuffer()
          : Promise.resolve();
        uploadStarted.resolve();
        await releaseUpload.promise;
        await drained;
        return Response.json({ id: `file-${fileRequests}` }, { status: 201 });
      }
      if (url.endsWith("/transcriptions")) {
        return Response.json({ id: `job-${fileRequests}` }, { status: 201 });
      }
      return Response.json({ message: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", sonioxFetch);
    const transcriptionEnv: Env = {
      ...env,
      SONIOX_API_KEY: "test-key",
    };

    const firstPoll = pollTranscriptions(transcriptionEnv, NOW);
    await uploadStarted.promise;

    try {
      expect(await env.DB.prepare(
        `SELECT transcription_status, soniox_transcription_id
           FROM assets WHERE id = 'streamed-asset'`,
      ).first()).toEqual({
        transcription_status: "processing",
        soniox_transcription_id: null,
      });
      expect(await pollTranscriptions(transcriptionEnv, NOW)).toEqual({ processed: 0 });
      expect(fileRequests).toBe(1);
    } finally {
      releaseUpload.resolve();
      await firstPoll;
    }
  });

  it("uses a short-lived private media URL for large assets", async () => {
    let audioUrl: string | undefined;
    const sonioxFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/files")) {
        return Response.json({ message: "large files must not be uploaded" }, { status: 500 });
      }
      if (url.endsWith("/transcriptions")) {
        const payload: unknown = await new Response(init?.body ?? null).json();
        if (typeof payload !== "object" || payload === null
          || !("audio_url" in payload) || typeof payload.audio_url !== "string") {
          return Response.json({ message: "missing audio URL" }, { status: 400 });
        }
        audioUrl = payload.audio_url;
        return Response.json({ id: "job-from-url" }, { status: 201 });
      }
      return Response.json({ message: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", sonioxFetch);
    const transcriptionEnv: Env = {
      ...env,
      SONIOX_API_KEY: "test-key",
      TRANSCRIPTION_MEDIA_BASE_URL: "https://api.example.test",
      SONIOX_DIRECT_UPLOAD_MAX_BYTES: "10",
    };

    expect(await pollTranscriptions(transcriptionEnv, NOW)).toEqual({ processed: 1 });
    expect(audioUrl).toMatch(/^https:\/\/api\.example\.test\/v1\/media\/[A-Za-z0-9_-]+$/);
    const rawToken = audioUrl?.split("/").at(-1);
    const grant = await env.DB.prepare(
      "SELECT token_hash, expires_at FROM media_grants WHERE asset_id = 'streamed-asset'",
    ).first<{ token_hash: string; expires_at: string }>();
    expect(grant?.token_hash).toBeTruthy();
    expect(grant?.token_hash).not.toBe(rawToken);
    expect(new Date(grant?.expires_at ?? 0).getTime()).toBeGreaterThan(NOW.getTime());
    expect(await env.DB.prepare(
      "SELECT soniox_file_id, soniox_transcription_id FROM assets WHERE id = 'streamed-asset'",
    ).first()).toEqual({
      soniox_file_id: null,
      soniox_transcription_id: "job-from-url",
    });
  });

  it("declares the exact multipart length while streaming an R2 object", async () => {
    let bodyLength = 0;
    let declaredLength: number | bigint | undefined;
    class RecordingFixedLengthStream {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<ArrayBuffer | ArrayBufferView>;

      constructor(expectedLength: number | bigint) {
        declaredLength = expectedLength;
        const stream = new TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array>();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    }
    vi.stubGlobal("FixedLengthStream", RecordingFixedLengthStream);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodyLength = (await new Response(init?.body ?? null).arrayBuffer()).byteLength;
      return Response.json({ id: "file-sized" }, { status: 201 });
    }));
    const media = new TextEncoder().encode("streamed-media");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(media);
        controller.close();
      },
    });
    const upload = {
      body: source,
      filename: "memory.mov",
      contentType: "video/quicktime",
      size: media.byteLength,
    };

    await expect(uploadToSoniox(
      { SONIOX_API_KEY: "test-key" },
      upload,
    )).resolves.toBe("file-sized");
    expect(declaredLength).toBe(bodyLength);
    expect(bodyLength).toBeGreaterThan(upload.size);
  });
});
