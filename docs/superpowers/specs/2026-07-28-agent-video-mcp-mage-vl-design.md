# Agent Video MCP and Mage-VL

Date: 2026-07-28
Status: approved in session; detailed execution delegated to Codex

## Problem

Afterimage's MCP surface exposes only completed video transcriptions. An AI
agent cannot discover a silent video, inspect the visual content, retrieve the
original video, request a frame or clip, or distinguish a private lifelog entry
that must not leave the app.

The product needs a single owner-controlled privacy boundary that applies to
MCP discovery, media grants, visual analysis, and generated derivatives without
changing app playback or transcription retention.

## Goals

1. Add `agentAccessEnabled` to every asset, defaulting to `true`.
2. Let the owner switch video sharing off from `MemoryDetailView`.
3. Treat sharing as authorization: disabled assets are indistinguishable from
   missing assets to MCP and GPU-worker callers.
4. Expand MCP from transcription-only access to memory search, metadata,
   original video, frames, and clips.
5. Run Microsoft Mage-VL on the owner's DGX Spark as an outbound-only pull
   worker.
6. Keep upload, playback, and transcription available when Mage-VL is offline.
7. Never store service credentials or temporary source videos in the
   repository.

## Non-goals

- Publicly exposing Mage-VL or SGLang.
- Replacing Soniox transcription.
- Adding conversational video question answering in the first release.
- Making Cloudflare Media Transformations a required dependency.
- Sharing an asset with MCP while withholding it from the DGX worker.
- Persisting source-video copies or an unbounded derivative cache on the DGX.

## Privacy boundary

`assets.agent_access_enabled` is an integer boolean with a database default of
`1`. Existing and newly uploaded assets therefore start enabled. The first
release exposes video assets through MCP; the column lives on `assets` so
legacy photos can use the same boundary in a later release.

Transcription and agent access are independent:

| Agent access | App playback | Transcription | MCP | Mage-VL |
|---|---|---|---|---|
| Enabled | allowed | retained | allowed | allowed |
| Disabled | allowed | retained | hidden as missing | cancelled and purged |

Disabling access performs one owner-scoped mutation that:

1. sets `agent_access_enabled = 0`;
2. deletes agent and worker media grants for the asset;
3. deletes queued and leased GPU jobs for the asset;
4. deletes Mage analyses, segments, and generated derivatives;
5. deletes derivative R2 objects after the D1 mutation;
6. preserves app playback grants, the optimized source video, thumbnails, and
   transcription.

Every agent or worker media request rechecks the current asset flag. A grant
issued while enabled becomes unusable immediately after the flag is disabled.
App grants do not consult the flag.

Re-enabling access never revives a grant or analysis. It creates a new
background-analysis job with a new identifier.

## D1 schema

Migration `0010_agent_video_access.sql` adds:

```sql
ALTER TABLE assets ADD COLUMN agent_access_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(agent_access_enabled IN (0, 1));

ALTER TABLE media_grants ADD COLUMN purpose TEXT NOT NULL DEFAULT 'app'
  CHECK(purpose IN ('app', 'agent', 'worker'));
```

Existing grants become `app` grants.

`gpu_jobs` is the common lease queue:

```text
id
asset_id
kind                  analysis | frame | clip
status                queued | leased | failed
request_json
priority
attempt_count
available_at
lease_token_hash
lease_expires_at
created_at
updated_at
```

Deleting an asset cascades through all new tables.

`video_analyses` stores the current successful background result:

```text
asset_id
job_id
model_id
model_revision
backend               frames | codec
coverage_mode         full | sampled
summary
created_at
updated_at
```

`video_analysis_ranges` records the windows actually analyzed. This prevents a
sampled result from being represented as full coverage.

`video_analysis_segments` records ordered `start_ms`, `end_ms`, and `caption`
values. No model score is exposed as a calibrated confidence.

`media_derivatives` represents private, expiring output:

```text
id
asset_id
job_id
kind                  frame | clip
start_ms
end_ms
status                queued | ready | failed
object_key
content_type
byte_size
expires_at
created_at
updated_at
```

Frame and clip jobs use deterministic cache keys so identical requests reuse a
ready, unexpired derivative. Derivative R2 keys remain below the owning asset
prefix. The daily cleanup deletes expired rows and objects.

## Owner API and iOS

Asset JSON gains:

```text
agentAccessEnabled: boolean
videoAnalysisStatus: queued | processing | completed | failed | null
```

The owner mutation is:

```http
PATCH /v1/assets/:assetId/agent-access
Content-Type: application/json

{ "enabled": false }
```

Only the owner can mutate a ready video. Missing, non-video, and non-owned
assets return `404 asset_not_found`. The response contains the updated asset.

`MemoryDetailView` places an `AIエージェントに共有` toggle between the file size
and delete actions. It disables while the request runs, updates the matching
asset in `AppModel` from the server response, and restores the server value if
the request fails.

## Media grants

`media_grants.purpose` separates three audiences:

| Purpose | Issuer | Disabled-asset behavior |
|---|---|---|
| `app` | owner playback API | remains valid |
| `agent` | authenticated MCP tool | rejected |
| `worker` | authenticated GPU lease API | rejected |

The public token route still streams R2 bodies and supports HTTP Range. It
never buffers an unbounded media body. A derivative grant joins through the
owning asset and uses the derivative's object key, content type, and byte size.

Grant tokens are random and only their SHA-256 hashes are stored. Agent and
worker grants use short expiry times and are returned only over HTTPS.

## MCP tools

The existing `list_transcriptions` and `get_transcription` tools remain for
compatibility but add the agent-access predicate.

New tools:

### `search_memories`

Inputs:

```text
query?: string
capturedAfter?: RFC3339 timestamp
capturedBefore?: RFC3339 timestamp
analysisStatus?: queued | processing | completed | failed | unavailable
limit?: 1..50
cursor?: opaque string
```

The query matches filename, completed transcript, Mage summary, and segment
captions. Results are owner-scoped ready videos with agent access enabled,
ordered by capture time and ID. Results include metadata, transcript preview,
analysis status, visual summary preview, and an opaque next cursor.

### `get_memory`

Input: `assetId`.

Returns owner-scoped video metadata, completed transcript when present,
analysis metadata, coverage ranges, visual summary, visual segments, and the
names of applicable media tools. A disabled or foreign asset returns the same
not-found result as a missing ID.

### `get_video`

Input: `assetId`.

Creates an `agent` grant for the optimized original video and returns an MCP
resource link with URI, MIME type, byte size, expiry, and Range support.

### `get_video_frame`

Inputs: `assetId`, `timeMs`.

If a ready cached JPEG exists, returns its resource link. Otherwise it creates
a high-priority frame job and returns `queued`, `derivativeId`, and
`retryAfterMs`.

### `get_video_clip`

Inputs: `assetId`, `startMs`, `endMs`.

The range must be inside the video and at most 60 seconds. A ready cached
H.264/AAC MP4 returns immediately; otherwise the tool returns a queued
derivative job.

### `get_video_derivative`

Input: `derivativeId`.

Returns `queued`, `failed` with a stable code, or a ready resource link. It
applies the same owner and agent-access checks as the creating tool.

Large media is never embedded as base64 or text in an MCP response.

## DGX pull protocol

The DGX uses a dedicated `aft_worker_...` bearer token. The raw token exists
only in a mode-`0600` credential file on the DGX. Cloudflare stores only its
SHA-256 hash as a secret. Worker routes accept no iOS or MCP token.

The worker calls:

```text
POST /v1/internal/gpu-jobs/lease
POST /v1/internal/gpu-jobs/:id/heartbeat
POST /v1/internal/gpu-jobs/:id/analysis
PUT  /v1/internal/gpu-jobs/:id/derivative
POST /v1/internal/gpu-jobs/:id/fail
```

Leasing is an atomic D1 state transition. Derivative jobs have higher priority
than background analysis jobs. Initial settings:

```text
worker concurrency: 1
lease duration: 15 minutes
heartbeat interval: 60 seconds
maximum attempts: 3
retry delays after the first and second failures: 1 minute, 5 minutes
idle poll delay: 15 to 30 seconds with jitter
```

Each lease returns a job-specific token and a short-lived `worker` media grant.
Heartbeat and completion require both the service bearer and the job token.
Stale, expired, disabled, or replaced jobs cannot commit results.

Analysis completion accepts a bounded summary, at most 200 validated segments,
coverage ranges, exact model revision, and backend. Derivative upload streams
the request body directly to private R2, verifies the declared length, and
marks the row ready only after the R2 size check.

Failure reports contain only a stable code:

```text
download_failed
size_mismatch
decode_failed
model_load_failed
inference_failed
output_invalid
disk_space_low
cancelled
```

Tokens, grant URLs, prompts, source filenames, and video content are excluded
from logs.

## DGX runtime

The service is an independent user-level systemd unit, not part of the existing
`med-local-ai` Nomad job. The DGX's current Nomad client does not advertise a
GPU device resource, while Docker GPU access is already configured.

The unit starts a digest-pinned NVIDIA CUDA 13 ARM64 PyTorch container with no
published port. It mounts dedicated model-cache and temporary-data
directories. The model is fixed to:

```text
model: microsoft/Mage-VL
revision: 8484f3154beea3b563bee99e2fab2d6c8bb5d3f3
initial backend: frames
```

The container includes FFmpeg and ffprobe. It loads Mage-VL once, polls jobs,
streams the source to a job-specific temporary directory, validates size and
media metadata, performs work, submits the result, and removes the directory
for success, failure, cancellation, and shutdown.

Background analysis uses 120-second windows with at most 32 frames per window.
Videos up to ten minutes receive full window coverage. Longer videos use at
most thirty evenly distributed windows and are marked `sampled`.

Frames are encoded as JPEG. Clips are bounded to 60 seconds and encoded as
H.264/AAC MP4 for broad agent compatibility.

Codec-native Mage inference remains behind a disabled capability until
`codec-video-prep` is built and validated on ARM64. Failure of that optional
path never removes the frame backend.

## Error behavior

- Mage downtime leaves upload, app playback, transcription, MCP metadata, and
  original-video grants available.
- Disabled assets are reported as missing, not forbidden.
- Expired leases can be retried; stale workers cannot overwrite a newer job.
- Invalid model JSON is never stored as a successful analysis.
- A derivative failure is visible through a stable error code and does not
  affect the source asset.
- Deleting or disabling an asset removes derivative access and schedules
  best-effort R2 object cleanup.

## Verification

Automated:

- Backend behavior tests for owner scope, default-on migration, toggle
  lifecycle, grant purpose, grant revocation, lease races, stale completion,
  MCP filtering, resource links, derivative validation, and cleanup.
- Swift decoding and AppModel toggle tests.
- Python unit tests for API parsing, output validation, file cleanup, and
  cancellation.
- `npm run check`.
- Xcode simulator tests on macOS.

Manual:

1. Confirm the existing Ollama, Nomad job, and port 8080 service remain alive.
2. Run a CUDA container and observe the GB10.
3. Load the pinned Mage-VL revision.
4. Analyze the official Mage sample.
5. Analyze a real Afterimage HEVC/MOV through a worker grant.
6. Request an arbitrary JPEG frame and a short MP4 clip through MCP.
7. Disable sharing during a lease and observe rejected completion plus local
   temporary-file deletion.
8. Restart the DGX and observe automatic worker recovery.
9. Inspect logs for secrets or media content.
