# Agent Video MCP and Mage-VL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-controlled AI sharing, video-capable MCP tools, private frame and clip derivatives, and an outbound-only Mage-VL worker on the DGX Spark.

**Architecture:** D1 is the control plane for agent authorization, GPU leases, analyses, and derivative metadata. Cloudflare Workers stream private R2 media through purpose-scoped grants. A systemd-managed Docker worker on the DGX polls authenticated jobs, runs the pinned Mage-VL frame backend or FFmpeg derivative commands, submits bounded results, and removes local source files.

**Tech Stack:** TypeScript 7, Hono, D1, private R2, MCP SDK, Vitest, Swift 6, SwiftUI iOS 26, XCTest, Python 3.12, PyTorch, Transformers, FFmpeg, Docker, systemd, NVIDIA CUDA 13 ARM64.

## Global Constraints

- Follow RED → GREEN → REFACTOR for every behavior change.
- Do not add source-code comments.
- Do not use TypeScript `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Do not load large videos fully into Worker or iOS memory.
- Enforce owner scope and `agent_access_enabled = 1` for every MCP, agent-grant, worker-grant, analysis, and derivative operation.
- Keep app playback and transcription available when agent access is disabled.
- Keep the DGX service outbound-only and publish no port.
- Store no bearer token, Cloudflare identifier, Apple credential, R2 credential, or source video in Git.
- Pin Mage-VL to revision `8484f3154beea3b563bee99e2fab2d6c8bb5d3f3`.
- Initial Mage backend is `frames`; codec-native inference remains disabled until ARM64 validation succeeds.
- Spec: `docs/superpowers/specs/2026-07-28-agent-video-mcp-mage-vl-design.md`.

---

### Task 1: D1 privacy boundary and owner toggle API

**Files:**
- Create: `backend/migrations/0009_agent_video_access.sql`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/app.test.ts`

**Interfaces:**
- Produces: `AssetRow.agent_access_enabled: 0 | 1`
- Produces: asset JSON fields `agentAccessEnabled` and `videoAnalysisStatus`
- Produces: `PATCH /v1/assets/:assetId/agent-access`

- [ ] **Step 1.1: Write failing backend tests**

Add tests that:

```typescript
it("defaults existing and new assets to agent access enabled", async () => {
  const asset = await createReadyVideo();
  expect(asset.agentAccessEnabled).toBe(true);
});

it("lets only the owner disable agent access without changing transcription", async () => {
  const { app, authorization, assetId } = await createTranscribedVideo();
  const response = await app.request(`/v1/assets/${assetId}/agent-access`, {
    method: "PATCH",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  }, env);
  expect(response.status).toBe(200);
  expect((await response.json()).asset.agentAccessEnabled).toBe(false);
  expect(await storedTranscript(assetId)).not.toBeNull();
});

it("hides ownership when another user changes agent access", async () => {
  const response = await other.app.request(`/v1/assets/${assetId}/agent-access`, {
    method: "PATCH",
    headers: { authorization: other.authorization, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  }, env);
  expect(response.status).toBe(404);
});
```

- [ ] **Step 1.2: Run RED**

Run:

```bash
npm --workspace backend test -- --runInBand -t "agent access"
```

Expected: tests fail because the field, migration, and route do not exist.

- [ ] **Step 1.3: Add the schema and minimal API**

Create the migration with:

```sql
ALTER TABLE assets ADD COLUMN agent_access_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(agent_access_enabled IN (0, 1));
CREATE INDEX assets_agent_timeline_idx
  ON assets(user_id, agent_access_enabled, captured_at DESC, id DESC);
```

Extend every `AssetRow` projection and `assetJson`. Add a strict Zod boolean
body and an owner-scoped route that returns `404 asset_not_found` for foreign,
missing, non-video, or non-ready assets.

- [ ] **Step 1.4: Run GREEN and refactor**

Run:

```bash
npm --workspace backend test -- -t "agent access"
npm --workspace backend run typecheck
```

Expected: selected tests and typecheck pass.

- [ ] **Step 1.5: Commit**

```bash
git add backend/migrations/0009_agent_video_access.sql backend/src/app.ts backend/tests/app.test.ts
git commit -m "feat(api): add agent access privacy boundary"
```

---

### Task 2: Purpose-scoped media grants and GPU lease API

**Files:**
- Modify: `backend/migrations/0009_agent_video_access.sql`
- Modify: `backend/src/env-secrets.d.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/src/gpu-jobs.ts`
- Test: `backend/tests/app.test.ts`

**Interfaces:**
- Consumes: `AssetRow.agent_access_enabled`
- Produces: `MediaGrantPurpose = "app" | "agent" | "worker"`
- Produces: `POST /v1/internal/gpu-jobs/lease`
- Produces: heartbeat, analysis-completion, derivative-upload, and failure routes

- [ ] **Step 2.1: Write failing grant and lifecycle tests**

Cover these real HTTP behaviors:

```typescript
it("keeps app grants valid while revoking agent and worker grants", async () => {
  const appGrant = await insertGrant(assetId, "app");
  const agentGrant = await insertGrant(assetId, "agent");
  await disableAgentAccess(assetId);
  expect((await requestGrant(appGrant)).status).toBe(200);
  expect((await requestGrant(agentGrant)).status).toBe(404);
});

it("leases one enabled ready video atomically", async () => {
  const [first, second] = await Promise.all([leaseGpuJob(), leaseGpuJob()]);
  expect([first.status, second.status].sort()).toEqual([200, 204]);
});

it("rejects stale completion after agent access is disabled", async () => {
  const lease = await leaseAnalysis();
  await disableAgentAccess(lease.assetId);
  expect((await completeAnalysis(lease)).status).toBe(404);
});
```

Also test invalid worker bearer, expired lease, wrong job token, retry count,
derivative priority, and bounded completion payloads.

- [ ] **Step 2.2: Run RED**

```bash
npm --workspace backend test -- -t "media grant|GPU job|analysis lease"
```

Expected: failures for missing purpose columns, tables, and routes.

- [ ] **Step 2.3: Complete migration `0008`**

Add `media_grants.purpose`, `gpu_jobs`, `video_analyses`,
`video_analysis_ranges`, `video_analysis_segments`, and `media_derivatives`.
Use foreign keys with `ON DELETE CASCADE`, checks for all finite enums, and
indexes for leasing, asset cleanup, and derivative cache lookup.

- [ ] **Step 2.4: Implement worker auth and lease state**

`backend/src/gpu-jobs.ts` exports:

```typescript
export type GpuJobKind = "analysis" | "frame" | "clip";
export type GpuFailureCode =
  | "download_failed"
  | "size_mismatch"
  | "decode_failed"
  | "model_load_failed"
  | "inference_failed"
  | "output_invalid"
  | "disk_space_low"
  | "cancelled";

export function gpuJobRoutes(dependencies: {
  now: () => Date;
  randomToken: () => string;
}): Hono<{ Bindings: Env }>;
```

Hash the worker bearer and compare it with `MAGE_WORKER_TOKEN_HASH`. Hash
job-specific tokens before D1 storage. Use conditional updates so two lease
requests cannot receive the same job.

- [ ] **Step 2.5: Stream derivative uploads**

Accept only `image/jpeg` for frame jobs and `video/mp4` for clip jobs. Require a
valid positive content length within the configured bound. Stream
`context.req.raw.body` to R2, verify the stored object size, then atomically
mark the derivative ready.

- [ ] **Step 2.6: Run GREEN and full backend tests**

```bash
npm --workspace backend test
npm --workspace backend run typecheck
```

Expected: all backend tests and typecheck pass.

- [ ] **Step 2.7: Commit**

```bash
git add backend/migrations/0009_agent_video_access.sql backend/src/env-secrets.d.ts backend/src/app.ts backend/src/gpu-jobs.ts backend/tests/app.test.ts
git commit -m "feat(api): add private GPU job leases"
```

---

### Task 3: Video-capable MCP

**Files:**
- Modify: `backend/src/mcp.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/app.test.ts`

**Interfaces:**
- Consumes: purpose-scoped media grants and analysis tables
- Produces: `search_memories`, `get_memory`, `get_video`,
  `get_video_frame`, `get_video_clip`, `get_video_derivative`

- [ ] **Step 3.1: Write failing MCP contract tests**

Exercise the MCP HTTP transport and assert:

```typescript
expect(toolNames).toEqual(expect.arrayContaining([
  "list_transcriptions",
  "get_transcription",
  "search_memories",
  "get_memory",
  "get_video",
  "get_video_frame",
  "get_video_clip",
  "get_video_derivative",
]));
```

Add tests for:

- silent videos appearing in `search_memories`;
- disabled and foreign videos being absent and not found by ID;
- completed transcript and Mage summary matching `query`;
- cursor pagination;
- `get_video` returning a resource link instead of media bytes;
- frame and clip cache hits;
- queued derivative results;
- clip ranges over 60 seconds being rejected;
- old transcription tools respecting agent access.

- [ ] **Step 3.2: Run RED**

```bash
npm --workspace backend test -- -t "MCP"
```

Expected: new tool names and behaviors are absent.

- [ ] **Step 3.3: Implement discovery tools**

Use owner ID from the MCP token for every query. Build bounded SQL predicates
from validated input and escape wildcard characters for text matching. Opaque
cursors encode `capturedAt` and `id` and reject malformed input.

- [ ] **Step 3.4: Implement media tools**

Create grants with `purpose = "agent"`. Produce MCP `resource_link` content
containing absolute HTTPS URI, MIME type, byte size, expiry, and Range support.
Create idempotent high-priority derivative jobs when no ready cache entry
exists.

- [ ] **Step 3.5: Run GREEN**

```bash
npm --workspace backend test -- -t "MCP"
npm --workspace backend run typecheck
```

Expected: MCP tests and typecheck pass.

- [ ] **Step 3.6: Commit**

```bash
git add backend/src/mcp.ts backend/src/app.ts backend/tests/app.test.ts
git commit -m "feat(mcp): expose private video memories"
```

---

### Task 4: iOS sharing toggle

**Files:**
- Modify: `ios/Sources/Models/APIModels.swift`
- Modify: `ios/Sources/Networking/APIClient.swift`
- Modify: `ios/Sources/App/AppModel.swift`
- Modify: `ios/Sources/Features/Memory/MemoryDetailView.swift`
- Modify: `ios/Resources/en.lproj/Localizable.strings`
- Modify: `ios/Resources/ja.lproj/Localizable.strings`
- Modify: `ios/Tests/APIContractTests.swift`
- Test: `ios/Tests/AgentAccessPolicyTests.swift`

**Interfaces:**
- Consumes: owner toggle API and asset JSON
- Produces: `APIClient.setAgentAccess(assetID:enabled:) async throws -> Asset`
- Produces: `AppModel.setAgentAccess(_:enabled:) async -> Bool`

- [ ] **Step 4.1: Write failing Swift tests**

Add asset decoding coverage and a pure request-state policy:

```swift
func testAssetDecodesAgentAccessEnabled() throws {
    let asset = try decodeAsset(agentAccessEnabled: false)
    XCTAssertFalse(asset.agentAccessEnabled)
}

func testAgentAccessMutationRestoresServerValueAfterFailure() {
    var policy = AgentAccessPolicy(enabled: true)
    policy.beginChange(to: false)
    policy.finishFailure()
    XCTAssertTrue(policy.enabled)
    XCTAssertFalse(policy.isUpdating)
}
```

- [ ] **Step 4.2: Run RED**

From `ios/`:

```bash
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:afterimageTests/AgentAccessPolicyTests \
  CODE_SIGNING_ALLOWED=NO
```

Expected: the model and policy symbols are missing.

- [ ] **Step 4.3: Implement model, client, and AppModel mutation**

Add non-optional `agentAccessEnabled`. Decode `videoAnalysisStatus` as an
optional finite enum. Update only the matching asset returned by the server;
do not recreate or reorder the timeline array.

- [ ] **Step 4.4: Implement the localized menu toggle**

Add:

```text
English: Share with AI agents
Japanese: AIエージェントに共有
```

Disable the control during the request. On failure, preserve the server-backed
value and use the existing notice/error surface.

- [ ] **Step 4.5: Run GREEN and iOS contract checks**

```bash
xcodebuild test -project afterimage.xcodeproj -scheme afterimage \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO
cd ..
npm run check:ios
```

Expected: iOS tests and both contract scripts pass.

- [ ] **Step 4.6: Commit**

```bash
git add ios/Sources ios/Resources ios/Tests
git commit -m "feat(ios): add AI agent sharing control"
```

---

### Task 5: DGX Mage-VL worker

**Files:**
- Create: `mage-worker/pyproject.toml`
- Create: `mage-worker/src/afterimage_mage_worker/__init__.py`
- Create: `mage-worker/src/afterimage_mage_worker/client.py`
- Create: `mage-worker/src/afterimage_mage_worker/contracts.py`
- Create: `mage-worker/src/afterimage_mage_worker/runtime.py`
- Create: `mage-worker/src/afterimage_mage_worker/worker.py`
- Create: `mage-worker/src/afterimage_mage_worker/main.py`
- Create: `mage-worker/tests/test_client.py`
- Create: `mage-worker/tests/test_contracts.py`
- Create: `mage-worker/tests/test_worker.py`
- Create: `mage-worker/Dockerfile`
- Create: `mage-worker/compose.yaml`
- Create: `mage-worker/deploy/afterimage-mage-vl.service`
- Create: `mage-worker/README.md`

**Interfaces:**
- Consumes: GPU lease API
- Produces: `afterimage-mage-worker` CLI
- Produces: no listening socket

- [ ] **Step 5.1: Write failing contract tests**

Cover strict lease parsing, strict Mage JSON parsing, range validation, and
failure-code serialization:

```python
def test_analysis_rejects_out_of_bounds_segment():
    payload = {
        "summary": "keys on desk",
        "segments": [{"startMs": 2000, "endMs": 5000, "caption": "keys"}],
    }
    with pytest.raises(ContractError):
        parse_analysis(payload, duration_ms=4000)
```

- [ ] **Step 5.2: Write failing lifecycle tests**

Use a temporary directory and injected fake client/runtime to prove:

```python
def test_worker_removes_source_after_success(tmp_path):
    run_one_job(client, runtime, tmp_path)
    assert list(tmp_path.iterdir()) == []

def test_worker_cancels_when_heartbeat_reports_cancelled(tmp_path):
    run_one_job(cancelled_client, runtime, tmp_path)
    assert runtime.cancelled
    assert list(tmp_path.iterdir()) == []
```

- [ ] **Step 5.3: Run RED**

```bash
python3 -m venv .mage-worker-venv
.mage-worker-venv/bin/pip install -e 'mage-worker[test]'
.mage-worker-venv/bin/pytest mage-worker/tests -q
```

Expected: imports fail because the package is not implemented.

- [ ] **Step 5.4: Implement the HTTP client and worker lifecycle**

Use standard-library HTTP streaming for downloads and uploads. Read the bearer
from a file path. Redact authorization and media URLs from exceptions. Create
one temporary directory per job and remove it in a `finally` block.

- [ ] **Step 5.5: Implement FFmpeg derivatives**

Frame command:

```text
ffmpeg -ss 12.000 -i input.mov -frames:v 1 -q:v 2 -f image2 output.jpg
```

Clip command:

```text
ffmpeg -ss 12.000 -i input.mov -t 8.000 -c:v libx264 -c:a aac
  -movflags +faststart output.mp4
```

Pass arguments as an array, never through a shell.

- [ ] **Step 5.6: Implement Mage frame inference**

Load `AutoModelForCausalLM` and its processor from the pinned revision with
`trust_remote_code=True`. Build bounded windows, use at most 32 frames per
window, request the exact JSON contract, validate each response, and combine
ranges and segments without inventing coverage.

- [ ] **Step 5.7: Run GREEN**

```bash
.mage-worker-venv/bin/pytest mage-worker/tests -q
```

Expected: all Python tests pass with no model download.

- [ ] **Step 5.8: Build and inspect the container**

```bash
docker compose -f mage-worker/compose.yaml config
docker build -t afterimage-mage-worker:test mage-worker
docker inspect afterimage-mage-worker:test
```

Expected: no published port, no embedded credential, pinned base reference,
and a non-root worker process.

- [ ] **Step 5.9: Commit**

```bash
git add mage-worker
git commit -m "feat(worker): add private Mage-VL pull worker"
```

---

### Task 6: DGX Spark installation and manual QA

**Files:**
- No repository secret files
- Remote install root: `/home/tsuqrea/afterimage-mage-vl`
- Remote data root: `/home/tsuqrea/afterimage-mage-vl-data`
- Remote credential: `/home/tsuqrea/.config/afterimage-mage-vl/worker-token`

- [ ] **Step 6.1: Record pre-install state**

Over Tailscale SSH, record running containers, user services, listeners,
available disk, GPU status, and existing Nomad allocation. Do not print
credential values.

- [ ] **Step 6.2: Validate NVIDIA container GPU access**

Run the NVIDIA-documented CUDA 13 `nvidia-smi` container check. Expected: GB10
is visible and the command exits zero.

- [ ] **Step 6.3: Install isolated service files**

Create only the three dedicated directories, copy the reviewed worker files,
create a random worker token with restrictive permissions, and install the
user-level service. Do not edit the existing Nomad, Ollama, Cloudflare Tunnel,
or port-8080 service.

- [ ] **Step 6.4: Run Mage sample inference**

Download the pinned model revision inside the dedicated cache and analyze the
official sample in frame mode. Record wall time, peak memory, and sanitized
output.

- [ ] **Step 6.5: Run Afterimage-like HEVC/MOV inference**

Create or obtain a non-sensitive HEVC/MOV fixture, process it through the same
container, and confirm summary JSON plus valid time ranges.

- [ ] **Step 6.6: Validate frame and clip output**

Produce a JPEG at a requested timestamp and an H.264/AAC MP4 clip. Confirm with
`ffprobe`, image dimensions, duration bounds, and successful local playback
metadata.

- [ ] **Step 6.7: Verify service isolation**

Restart the user service, inspect its sanitized logs, confirm no temporary
source remains, and reconfirm that Ollama, Nomad, and the 8080 service remain
running.

---

### Task 7: Full verification, review, and PR

**Files:**
- Modify: `docs/superpowers/plans/2026-07-28-agent-video-mcp-mage-vl.md`
- Create: task evidence artifacts outside Git when they contain environment
  details

- [ ] **Step 7.1: Mark completed plan checkboxes**

Update only boxes supported by command or manual-QA evidence.

- [ ] **Step 7.2: Run repository gates**

```bash
npm ci
npm run check
.mage-worker-venv/bin/pytest mage-worker/tests -q
```

On macOS:

```bash
cd ios
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO
```

- [ ] **Step 7.3: Run diff and secret review**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git grep -n -E 'aft_worker_[A-Za-z0-9_-]{32,}|Bearer [A-Za-z0-9_-]{20,}|account_id = "[0-9a-f]{32}"'
```

The final grep must contain no committed secret.

- [ ] **Step 7.4: Run required review lanes**

Run the repository review and runtime-debugging audits against the exact full
commit SHA. Fix each actionable finding with a failing test first and rerun
the relevant gates.

- [ ] **Step 7.5: Push and create PR**

```bash
git push -u origin kandotrun/agent-video-mcp-mage-vl
gh pr create --base main --head kandotrun/agent-video-mcp-mage-vl \
  --title "feat: add private video access for AI agents" \
  --body $'## Summary\n- add default-on, owner-controlled AI sharing as an authorization boundary\n- expose private videos, frames, and clips through MCP resource links\n- add an outbound-only Mage-VL pull worker for DGX Spark\n\n## Verification\n- `npm run check`\n- full iOS simulator test suite\n- Mage worker pytest suite\n- DGX GPU, sample inference, HEVC/MOV, frame, clip, restart, and isolation checks\n\n## Deployment note\nThe Mage frame backend is enabled. Codec-native inference stays disabled until `codec-video-prep` is validated on ARM64.'
```

The PR body reports the privacy boundary, MCP contracts, DGX architecture,
fresh automated evidence, manual DGX evidence, the frame-backend limitation,
and any post-merge deployment step.
