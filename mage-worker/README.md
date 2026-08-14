# Afterimage Mage-VL worker

This service polls the authenticated Afterimage GPU lease API. It opens no
listening port. Source videos are downloaded through short-lived private media
grants, processed in one job directory, and removed after every outcome.

The enabled analysis backend is frame sampling with at most 32 frames per
120-second window. The model and revision are fixed to:

```text
microsoft/Mage-VL
8484f3154beea3b563bee99e2fab2d6c8bb5d3f3
```

Codec-native processing is intentionally disabled until `codec-video-prep` is
validated on ARM64. Frame extraction and clips use FFmpeg without a shell.
The offline loader does not activate Mage-VL's optional StreamMind gate, so the
unrelated `mamba_ssm` CUDA extension is not installed.

## Local tests

```bash
python3 -m venv /tmp/afterimage-mage-worker-venv
/tmp/afterimage-mage-worker-venv/bin/pip install -e 'mage-worker[test]'
/tmp/afterimage-mage-worker-venv/bin/pytest mage-worker/tests -q
```

The test extra does not install Torch, Transformers, or download the model.

## DGX Spark layout

```text
<home>/afterimage-mage-vl
/srv/afterimage-mage-vl/data
/srv/afterimage-mage-vl/models
/srv/afterimage-mage-vl/secrets/worker-token
<home>/.config/afterimage-mage-vl/worker.env
```

The token file must contain one `aft_worker_...` token and have mode `0600`.
`worker.env` provides only paths, the API origin, numeric user IDs, and the
worker name:

```text
AFTERIMAGE_API_BASE_URL=https://afterimage.example.com
AFTERIMAGE_WORKER_ID=gpu-worker-1
AFTERIMAGE_MODEL_CACHE=/srv/afterimage-mage-vl/models
AFTERIMAGE_DATA_ROOT=/srv/afterimage-mage-vl/data
AFTERIMAGE_TOKEN_FILE_HOST=/srv/afterimage-mage-vl/secrets/worker-token
```

`AFTERIMAGE_API_BASE_URL` must be the canonical HTTPS origin that exposes the
internal GPU routes under `/v1/internal/gpu-jobs/*`. Do not point the worker at
an alternate health-only origin: a successful health response does not prove
that the authenticated GPU routes are registered there.

From the `mage-worker` checkout, build and install the user service:

```bash
install -d -m 0750 \
  /srv/afterimage-mage-vl/data/jobs \
  /srv/afterimage-mage-vl/data/tmp/cache/torch/kernels \
  /srv/afterimage-mage-vl/data/tmp/home \
  /srv/afterimage-mage-vl/models \
  /srv/afterimage-mage-vl/secrets \
  ~/.config/systemd/user
docker compose config
docker compose build
install -Dm644 deploy/afterimage-mage-vl.service \
  ~/.config/systemd/user/afterimage-mage-vl.service
systemctl --user daemon-reload
```

Deploy migration `0010_agent_video_access.sql`, deploy the matching backend,
and configure its `MAGE_WORKER_TOKEN_HASH` from the DGX credential before
activating the service:

```bash
systemctl --user enable --now afterimage-mage-vl.service
```

Inspect only sanitized lifecycle events:

```bash
systemctl --user status afterimage-mage-vl.service
journalctl --user -u afterimage-mage-vl.service --since today
```

The logs never include bearer tokens, media grant URLs, prompts, source
filenames, or media contents.
