#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.jsonc}"
D1_DATABASE="${D1_DATABASE:-DB}"
PRODUCTION_ORIGIN="${PRODUCTION_ORIGIN:-https://afterimage.2-38.com}"
DEPLOY_MESSAGE="${DEPLOY_MESSAGE:-App Store privacy and deletion safety rollout}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/afterimage-prod-rollout.XXXXXX")"
MAINTENANCE_ACTIVE=0

cleanup() {
  rm -rf "$TEMP_DIR"
  if [[ "$MAINTENANCE_ACTIVE" == "1" ]]; then
    printf '%s\n' "ERROR: production remains in maintenance mode; fix the failure and rerun the final deploy." >&2
  fi
}
trap cleanup EXIT

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
  printf 'Missing production Wrangler config: %s\n' "$WRANGLER_CONFIG" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  CLOUDFLARE_ACCOUNT_ID="$(WRANGLER_CONFIG="$WRANGLER_CONFIG" node -e '
    const source = require("fs").readFileSync(process.env.WRANGLER_CONFIG, "utf8");
    const match = source.match(/"account_id"\s*:\s*"([^"]+)"/);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  ')" || {
    printf 'Missing account_id in production Wrangler config: %s\n' "$WRANGLER_CONFIG" >&2
    exit 1
  }
  export CLOUDFLARE_ACCOUNT_ID
fi

expect_status() {
  local expected="$1"
  local path="${2:-/health}"
  local code=""
  for _ in $(seq 1 20); do
    code="$(curl --silent --show-error --output "$TEMP_DIR/response" \
      --write-out '%{http_code}' --max-time 15 \
      -H 'cache-control: no-cache' "$PRODUCTION_ORIGIN$path" || true)"
    if [[ "$code" == "$expected" ]]; then
      return 0
    fi
    sleep 3
  done
  printf 'Expected HTTP %s from %s%s, got %s\n' \
    "$expected" "$PRODUCTION_ORIGIN" "$path" "$code" >&2
  return 1
}

require_binding() {
  local binding="$1"
  if [[ "$FINAL_DRY_RUN_OUTPUT" != *"env.$binding"* ]]; then
    printf 'Missing production Worker binding: %s\n' "$binding" >&2
    return 1
  fi
  if [[ "$FINAL_DRY_RUN_OUTPUT" == *"env.$binding (\"<"* ]]; then
    printf 'Production Worker binding is still a placeholder: %s\n' "$binding" >&2
    return 1
  fi
}

require_secret() {
  local secret="$1"
  SECRET_LIST_JSON="$SECRET_LIST_JSON" REQUIRED_SECRET="$secret" node -e '
    const secrets = JSON.parse(process.env.SECRET_LIST_JSON || "[]");
    if (!secrets.some((entry) => entry.name === process.env.REQUIRED_SECRET)) {
      console.error(`Missing production Worker secret: ${process.env.REQUIRED_SECRET}`);
      process.exit(1);
    }
  '
}

npm run typecheck
FINAL_DRY_RUN_OUTPUT="$(npx wrangler deploy --config "$WRANGLER_CONFIG" --dry-run \
  --outdir "$TEMP_DIR/final" --keep-vars 2>&1)"
printf '%s\n' "$FINAL_DRY_RUN_OUTPUT"
npx wrangler deploy src/maintenance.ts --config "$WRANGLER_CONFIG" --dry-run \
  --outdir "$TEMP_DIR/maintenance" --keep-vars
npx wrangler d1 migrations list "$D1_DATABASE" --remote --config "$WRANGLER_CONFIG"
SECRET_LIST_JSON="$(npx wrangler secret list --config "$WRANGLER_CONFIG" --format json)"
require_binding APPLE_TEAM_ID
require_binding APPLE_KEY_ID
require_secret APPLE_PRIVATE_KEY

# Phase 1: stop auth, uploads, AI dispatch, deletion jobs, and all cron work.
npx wrangler deploy src/maintenance.ts --config "$WRANGLER_CONFIG" --keep-vars \
  --message "privacy-safe maintenance before D1 migration"
MAINTENANCE_ACTIVE=1
expect_status 503

# Wrangler captures a D1 backup and applies each migration transactionally.
CI=1 npx wrangler d1 migrations apply "$D1_DATABASE" --remote \
  --config "$WRANGLER_CONFIG"
npx wrangler d1 migrations list "$D1_DATABASE" --remote --config "$WRANGLER_CONFIG"

# Phase 2: activate code that requires and enforces the migrated schema.
npx wrangler deploy --config "$WRANGLER_CONFIG" --keep-vars \
  --message "$DEPLOY_MESSAGE"
expect_status 200
expect_status 200 /privacy
expect_status 200 /support
expect_status 200 /terms
MAINTENANCE_ACTIVE=0

printf '%s\n' "Production migration and Worker rollout: PASS"
