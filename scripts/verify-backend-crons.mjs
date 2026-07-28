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

console.log("Backend cron contract: PASS");
