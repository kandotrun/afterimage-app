import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "backend/wrangler.example.jsonc"), "utf8"));

assert.deepEqual(
  config.triggers?.crons,
  ["* * * * *", "17 3 * * *"],
  "production config must poll transcriptions every minute and retain daily cleanup",
);

assert.equal(
  config.vars?.TRANSCRIPTION_MEDIA_BASE_URL,
  "https://afterimage.2-38.com",
  "production config must expose large videos through the private media route",
);

assert.equal(
  config.vars?.SONIOX_DIRECT_UPLOAD_MAX_BYTES,
  "104857600",
  "production config must route videos larger than 100 MiB through a private media URL",
);

console.log("Backend cron contract: PASS");
