# MCP Global Video Access Implementation Plan

> **For Hermes:** Implement with strict RED → GREEN → REFACTOR and verify the deployed MCP boundary after rollout.

**Goal:** Make active global AI consent enable the owner’s existing and future video memories for Afterimage MCP retrieval, while consent withdrawal immediately disables access.

**Architecture:** Keep `agent_access_enabled` as the per-video revocation switch, but use active `ai_consents` as the account-level opt-in. Granting consent bulk-enables existing ready videos and asset creation enables future videos only when consent is active. Withdrawal keeps the existing fail-closed behavior. Update product copy/tests so the privacy contract matches the new scope.

**Tech Stack:** Cloudflare Worker/Hono, D1 migrations, Vitest, SwiftUI string catalog and app UI copy.

---

### Task 1: Add RED backend regression tests ✅

- Extend `backend/tests/privacy-safety.test.ts` to assert that granting consent exposes existing ready videos and that a newly completed video is agent-enabled when consent is active.
- Run the focused tests and confirm they fail because consent currently does not update `agent_access_enabled` and asset creation defaults it off.

### Task 2: Implement consent-to-agent-access propagation ✅

- In `backend/src/app.ts`, bulk-enable the owner’s existing video assets after consent is granted.
- In `POST /v1/assets`, explicitly initialize video agent access from active consent after the privacy-default trigger has run.
- Preserve withdrawal behavior and per-video PATCH disable behavior.
- Run the focused tests to GREEN.

### Task 3: Align privacy copy and executable contracts ✅

- Update iOS privacy copy and App Store review notes from “only individually allowed videos” to global consent with per-video revocation.
- Add/adjust contract assertions if needed; keep the individual toggle visible as a revocation control.

### Task 4: Full verification and independent review ✅

- Run backend tests, typecheck, deploy dry-run, root checks available on Linux, and `git diff --check`.
- Review the final diff for owner scoping, SQL parameterization, withdrawal fail-closed behavior, and no secret changes.
- Push the fix to the existing related PR branch only after verification.

### Task 5: Production rollout and data repair

- Deploy the verified Worker through the existing production workflow/manual rollout path.
- Verify `/health`, MCP tools, and read-only D1 counts.
- Because the authenticated user already has active consent, backfill that user’s existing ready videos through the consent endpoint or a narrowly scoped owner-authorized operation, then verify yesterday’s MCP list is non-empty.
