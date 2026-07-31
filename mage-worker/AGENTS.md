# MAGE-WORKER GUIDE

## OVERVIEW

- Python 3.12 pull worker for private Mage-VL video jobs.
- Outbound-only process: poll authenticated GPU lease API; never open a listening port.
- One lease maps to one temporary job directory; source and derivatives are removed on every exit path.
- Return analysis metadata or derivatives only; do not persist private media or model prompts.

## STRUCTURE

- `src/afterimage_mage_worker/client.py`: HTTPS API transport, lease, grant download, heartbeat, result/failure upload.
- `src/afterimage_mage_worker/contracts.py`: strict lease/result parsing and bounded failure vocabulary.
- `src/afterimage_mage_worker/runtime.py`: FFmpeg probing/extraction, bounded frame sampling, Mage inference.
- `src/afterimage_mage_worker/worker.py`: job orchestration, heartbeat cancellation, disk guard, cleanup.
- `src/afterimage_mage_worker/main.py`: signal handling, idle backoff, process entrypoint.
- `tests/`: client, contract, runtime, and lifecycle behavior; `Dockerfile`, `compose.yaml`, `deploy/` define DGX/systemd packaging.

## WHERE TO LOOK

- Lease/result wire changes: `contracts.py`, `client.py`, backend `gpu-jobs` routes, and matching tests.
- Media transport policy: `WorkerClient.download`; API and grant origins must remain HTTPS and same-origin.
- Cancellation and ownership fencing: `worker.py` `Heartbeat` and `run_one_job`.
- Frame/clip limits and inference policy: `runtime.py` `analysis_windows`, `sample_frame_indices`, `MageRuntime`.
- Runtime/deploy settings: `README.md`, `compose.yaml`, `deploy/afterimage-mage-vl.service`, `deploy/worker.env.example`.

## CONVENTIONS

- Keep lease payloads strict: reject unknown/missing fields, invalid ranges, non-HTTPS grants, and model mismatches.
- Stream downloads and derivative uploads in bounded chunks; enforce declared byte size before processing.
- Send bearer authentication only to the configured API origin; reject redirects and cross-origin media grants.
- Heartbeat before work and periodically during work; a lost lease cancels runtime and prevents later submission.
- Handle SIGTERM/SIGINT through runtime cancellation; stop heartbeat threads before deleting the job directory.
- Pin `MODEL_ID` and `MODEL_REVISION`; use the `frames` backend and bounded sampling (at most 32 frames per 120-second window).
- Invoke `ffprobe`/`ffmpeg` with argument lists and bounded timeouts; do not route commands through a shell.
- Keep model-output parsing defensive; invalid output becomes an explicit failure, never a successful result.
- Logs are sanitized lifecycle events only: no token, grant URL, prompt, source filename, or media content.
- Keep optional inference dependencies out of the test extra; tests must run without downloading Mage-VL.

## ANTI-PATTERNS

- Do not add an HTTP server, inbound webhook, open port, or long-lived media cache.
- Do not buffer unbounded media, follow redirects, accept HTTP origins, or upload to a different origin.
- Do not reuse a stale lease token, submit after heartbeat loss, or skip temporary-directory cleanup.
- Do not change the pinned model/revision, enable codec-native prep, or expand frame/window limits without contract tests.
- Do not invoke FFmpeg through `shell=True`, log sensitive values, or commit worker tokens/configured secrets.
## COMMANDS

```bash
python3 -m venv /tmp/afterimage-mage-worker-venv
/tmp/afterimage-mage-worker-venv/bin/pip install -e 'mage-worker[test]'
/tmp/afterimage-mage-worker-venv/bin/pytest mage-worker/tests -q
docker compose -f mage-worker/compose.yaml config
docker compose -f mage-worker/compose.yaml build
systemctl --user status afterimage-mage-vl.service
journalctl --user -u afterimage-mage-vl.service --since today
```
