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
/home/tsuqrea/afterimage-mage-vl
/home/tsuqrea/afterimage-mage-vl-data
/home/tsuqrea/.cache/afterimage-mage-vl
/home/tsuqrea/.config/afterimage-mage-vl/worker-token
/home/tsuqrea/.config/afterimage-mage-vl/worker.env
```

The token file must contain one `aft_worker_...` token and have mode `0600`.
`worker.env` provides only paths, the API origin, numeric user IDs, and the
worker name:

```text
AFTERIMAGE_API_BASE_URL=https://api.example.com
AFTERIMAGE_WORKER_ID=dgx-spark
AFTERIMAGE_MODEL_CACHE=/home/tsuqrea/.cache/afterimage-mage-vl
AFTERIMAGE_DATA_ROOT=/home/tsuqrea/afterimage-mage-vl-data
AFTERIMAGE_TOKEN_FILE_HOST=/home/tsuqrea/.config/afterimage-mage-vl/worker-token
```

Build and install the user service:

```bash
install -d -m 0750 \
  /home/tsuqrea/afterimage-mage-vl-data/jobs \
  /home/tsuqrea/afterimage-mage-vl-data/tmp/cache/torch/kernels \
  /home/tsuqrea/afterimage-mage-vl-data/tmp/home \
  /home/tsuqrea/.cache/afterimage-mage-vl \
  /home/tsuqrea/.config/afterimage-mage-vl
cd /home/tsuqrea/afterimage-mage-vl
docker compose config
docker compose build
install -Dm644 deploy/afterimage-mage-vl.service \
  /home/tsuqrea/.config/systemd/user/afterimage-mage-vl.service
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
