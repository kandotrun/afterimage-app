import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollTranscriptions } from "../src/app";
import { AI_CONSENT_VERSION } from "../src/privacy";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const OWNER_ID = "transcription-large-no-url-owner";
const ASSET_ID = "transcription-large-no-url-asset";
const OBJECT_KEY = `users/${OWNER_ID}/assets/${ASSET_ID}/media`;

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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(OWNER_ID).run();
  await env.DB.prepare(
    `INSERT INTO users (id, apple_subject, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(OWNER_ID, OWNER_ID, NOW.toISOString(), NOW.toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO ai_consents (user_id, version, consented_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(OWNER_ID, AI_CONSENT_VERSION, NOW.toISOString(), NOW.toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO assets (
      id, user_id, kind, filename, content_type, byte_size, captured_at,
      status, object_key, upload_mode, created_at, updated_at,
      transcription_status, transcription_updated_at
    ) VALUES (
      ?, ?, 'video', 'memory.mov', 'video/quicktime', 14, ?,
      'ready', ?, 'single', ?, ?, 'pending', ?
    )`,
  ).bind(
    ASSET_ID,
    OWNER_ID,
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
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(OWNER_ID).run();
});

describe("large transcription configuration", () => {
  it("does not directly upload large assets when the private media URL is not configured", async () => {
    let fileRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/files")) {
        fileRequests += 1;
        return Response.json({ id: "unexpected-large-file" }, { status: 201 });
      }
      if (url.endsWith("/transcriptions")) {
        return Response.json({ id: "unexpected-large-job" }, { status: 201 });
      }
      return Response.json({ message: "unexpected request" }, { status: 404 });
    }));
    const transcriptionEnv: Env = {
      ...env,
      SONIOX_API_KEY: "test-key",
      SONIOX_DIRECT_UPLOAD_MAX_BYTES: "10",
    };
    delete transcriptionEnv.TRANSCRIPTION_MEDIA_BASE_URL;

    expect(await pollTranscriptions(transcriptionEnv, NOW)).toEqual({ processed: 0 });
    expect(fileRequests).toBe(0);
    expect(await env.DB.prepare(
      "SELECT soniox_file_id, soniox_transcription_id FROM assets WHERE id = ?",
    ).bind(ASSET_ID).first()).toEqual({
      soniox_file_id: null,
      soniox_transcription_id: null,
    });
  });

  it("keeps the replacement worker media grant when a stale worker returns after takeover", async () => {
    const firstTranscriptionStarted = deferred();
    const releaseFirstTranscription = deferred();
    const audioUrls: string[] = [];
    let transcriptionRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/transcriptions") && init?.method === "POST") {
        transcriptionRequests += 1;
        const requestNumber = transcriptionRequests;
        const payload = await new Response(init.body ?? null).json<{ audio_url: string }>();
        audioUrls.push(payload.audio_url);
        if (requestNumber === 1) {
          firstTranscriptionStarted.resolve();
          await releaseFirstTranscription.promise;
        }
        return Response.json({ id: `job-worker-${requestNumber}` }, { status: 201 });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ message: "unexpected request" }, { status: 404 });
    }));
    const transcriptionEnv: Env = {
      ...env,
      SONIOX_API_KEY: "test-key",
      SONIOX_DIRECT_UPLOAD_MAX_BYTES: "10",
      TRANSCRIPTION_MEDIA_BASE_URL: "https://media.example.test",
    };

    const stalePoll = pollTranscriptions(transcriptionEnv, NOW);
    await firstTranscriptionStarted.promise;
    const replacementNow = new Date(NOW.getTime() + 6 * 60 * 1_000);
    await expect(pollTranscriptions(transcriptionEnv, replacementNow))
      .resolves.toEqual({ processed: 1 });

    expect(audioUrls).toHaveLength(2);
    const replacementToken = new URL(audioUrls[1]!).pathname.split("/").at(-1)!;
    const replacementGrant = await env.DB.prepare(
      "SELECT token_hash FROM media_grants WHERE id = ?",
    ).bind(`transcription:${ASSET_ID}`).first<{ token_hash: string }>();
    expect(replacementGrant).toEqual({ token_hash: await sha256Hex(replacementToken) });

    releaseFirstTranscription.resolve();
    await expect(stalePoll).resolves.toEqual({ processed: 0 });
    expect(await env.DB.prepare(
      "SELECT token_hash FROM media_grants WHERE id = ?",
    ).bind(`transcription:${ASSET_ID}`).first()).toEqual(replacementGrant);
  });
});
