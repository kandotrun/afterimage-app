import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollTranscriptions } from "../src/app";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const OWNER_ID = "transcription-large-no-url-owner";
const ASSET_ID = "transcription-large-no-url-asset";
const OBJECT_KEY = `users/${OWNER_ID}/assets/${ASSET_ID}/media`;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(OWNER_ID).run();
  await env.DB.prepare(
    `INSERT INTO users (id, apple_subject, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(OWNER_ID, OWNER_ID, NOW.toISOString(), NOW.toISOString()).run();
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
});
