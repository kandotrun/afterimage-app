#!/usr/bin/env node
/**
 * Local development seeder for afterimage-api (wrangler dev).
 *
 * Creates a dev user + session by inserting directly into the local D1
 * database, then uploads sample media through the real public API flow
 * (create asset -> PUT upload -> complete -> PUT thumbnail), so the
 * timeline and detail screens show real content end to end.
 *
 * Usage:
 *   npm run dev              # in one terminal (wrangler dev, port 8787)
 *   node scripts/seed-dev.mjs
 *
 * Prints the bearer token for the DEBUG-only -afterimageDevSession launch arg.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const apiBase = process.env.AFTERIMAGE_DEV_API ?? "http://127.0.0.1:8787";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wranglerD1(sql) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "afterimage-dev", "--local", "--config", "wrangler.dev.jsonc", "--command", sql],
    { cwd: backendDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// --- 1. Dev user + session directly in local D1 ---------------------------
const userId = randomUUID();
const sessionId = randomUUID();
const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""); // 64 chars, matches Bearer regex
const tokenHash = sha256Hex(token);
const nowIso = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

wranglerD1(`DELETE FROM users WHERE apple_subject = 'dev-seed';`);
wranglerD1(
  `INSERT INTO users (id, apple_subject, email, display_name, created_at, updated_at)
   VALUES ('${userId}', 'dev-seed', 'dev@afterimage.local', 'Dev User', '${nowIso}', '${nowIso}');`,
);
wranglerD1(
  `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
   VALUES ('${sessionId}', '${userId}', '${tokenHash}', '${expiresAt}', '${nowIso}');`,
);
console.log("dev user + session created");

// --- 2. Generate sample media ---------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "afterimage-seed-"));
const photos = [
  { file: "photo-01.jpg", label: "Sunset over the bay", hue: 18, capturedAt: "2026-07-27T08:12:00.000Z" },
  { file: "photo-02.jpg", label: "Morning coffee", hue: 32, capturedAt: "2026-07-26T23:41:00.000Z" },
  { file: "photo-03.jpg", label: "Mountain trail", hue: 140, capturedAt: "2026-07-26T05:20:00.000Z" },
  { file: "photo-04.jpg", label: "City lights", hue: 220, capturedAt: "2026-07-25T12:05:00.000Z" },
  { file: "photo-05.jpg", label: "Beach walk", hue: 195, capturedAt: "2026-07-25T02:30:00.000Z" },
  { file: "photo-06.jpg", label: "Garden flowers", hue: 330, capturedAt: "2026-07-24T09:15:00.000Z" },
  { file: "photo-07.jpg", label: "Rainy window", hue: 210, capturedAt: "2026-07-24T00:50:00.000Z" },
  { file: "photo-08.jpg", label: "Night drive", hue: 260, capturedAt: "2026-07-23T13:25:00.000Z" },
  { file: "photo-09.jpg", label: "Autumn leaves", hue: 35, capturedAt: "2026-07-23T04:10:00.000Z" },
];

function runFfmpeg(args) {
  try {
    execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : String(error);
    throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-8).join("\n")}`);
  }
}

function hslToHex(h, s, l) {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const value = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * Math.max(0, Math.min(1, value))).toString(16).padStart(2, "0");
  };
  return `0x${channel(0)}${channel(8)}${channel(4)}`;
}

function generatePhoto(spec, index) {
  const path = join(workDir, spec.file);
  const base = hslToHex(spec.hue, 62, 46);
  const band = hslToHex((spec.hue + 40) % 360, 70, 62);
  const stack = `color=c=${base}:s=1170x1266[top];color=c=${band}:s=1170x1266[bot];[top][bot]vstack`;
  const withLabel = `${stack},drawtext=text='${spec.label}':fontsize=72:fontcolor=white@0.9:x=(w-text_w)/2:y=h*0.82`;
  try {
    runFfmpeg(["-y", "-f", "lavfi", "-i", withLabel, "-frames:v", "1", "-q:v", "3", path]);
  } catch {
    // ffmpeg builds without libfreetype have no drawtext; a plain duotone is fine.
    runFfmpeg(["-y", "-f", "lavfi", "-i", stack, "-frames:v", "1", "-q:v", "3", path]);
  }
  return path;
}

function generateVideo() {
  const path = join(workDir, "video-01.mp4");
  runFfmpeg([
    "-y", "-f", "lavfi",
    "-i", "testsrc2=size=1280x720:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "128k", "-shortest", path,
  ]);
  return path;
}

function generateThumbnail(sourcePath, isVideo) {
  const path = join(workDir, `thumb-${randomUUID()}.jpg`);
  const args = isVideo
    ? ["-y", "-i", sourcePath, "-ss", "1", "-frames:v", "1", "-vf", "scale=512:-1", "-q:v", "4", path]
    : ["-y", "-i", sourcePath, "-vf", "scale=512:-1", "-frames:v", "1", "-q:v", "4", path];
  runFfmpeg(args);
  return path;
}

// --- 3. Upload through the real API flow ----------------------------------
async function api(method, path, { body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return raw ? response : response.json();
}

async function uploadAsset({ kind, filename, contentType, filePath, capturedAt, durationMs, width, height }) {
  const bytes = readFileSync(filePath);
  const created = await api("POST", "/v1/assets", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind, filename, contentType,
      byteSize: bytes.length, capturedAt,
      ...(durationMs ? { durationMs } : {}),
      ...(width ? { width, height } : {}),
    }),
  });
  const { asset, upload } = created;
  if (upload.mode !== "single") throw new Error("expected single upload mode for sample media");
  await api("PUT", upload.url, {
    headers: { "content-type": contentType, "content-length": String(bytes.length) },
    body: bytes,
    raw: true,
  });
  const completed = await api("POST", `/v1/assets/${asset.id}/upload/complete`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: null }),
  });
  const thumbPath = generateThumbnail(filePath, kind === "video");
  const thumbBytes = readFileSync(thumbPath);
  await api("PUT", `/v1/assets/${asset.id}/thumbnail`, {
    headers: { "content-type": "image/jpeg", "content-length": String(thumbBytes.length) },
    body: thumbBytes,
    raw: true,
  });
  return completed.asset;
}

console.log("generating sample media...");
for (const [index, spec] of photos.entries()) {
  const path = generatePhoto(spec, index);
  await uploadAsset({
    kind: "photo", filename: spec.file, contentType: "image/jpeg",
    filePath: path, capturedAt: spec.capturedAt, width: 1170, height: 2532,
  });
  console.log(`  uploaded ${spec.file}`);
}

const videoPath = generateVideo();
await uploadAsset({
  kind: "video", filename: "video-01.mp4", contentType: "video/mp4",
  filePath: videoPath, capturedAt: "2026-07-26T11:30:00.000Z",
  durationMs: 4000, width: 1280, height: 720,
});
console.log("  uploaded video-01.mp4");

rmSync(workDir, { recursive: true, force: true });

const timeline = await api("GET", "/v1/assets?limit=50");
console.log(`\nseeded ${timeline.items.length} assets (ready: ${timeline.items.filter((a) => a.status === "ready").length})`);
console.log(`\nAPI base: ${apiBase}`);
console.log(`Dev bearer token:\n${token}`);
