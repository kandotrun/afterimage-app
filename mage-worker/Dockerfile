FROM nvcr.io/nvidia/pytorch:25.12-py3@sha256:1dc787f5c6264fcc1c99809f99b84823e73ed4588d5a581b94290fc2a8fecff8

ENV HF_HOME=/models/huggingface \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /models /work \
    && chown -R ubuntu:ubuntu /app /models /work

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN python -m pip install --no-cache-dir ".[inference]"

USER ubuntu:ubuntu
ENTRYPOINT ["afterimage-mage-worker"]
