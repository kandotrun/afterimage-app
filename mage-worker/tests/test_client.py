import io
import json
from dataclasses import replace
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from afterimage_mage_worker.client import APIError, WorkerClient
from afterimage_mage_worker.contracts import FailureCode

from test_contracts import lease_payload


class Response(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status
        self.headers: dict[str, str] = {}

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def test_lease_uses_worker_bearer_without_exposing_it(tmp_path: Path) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(f"aft_worker_{'w' * 43}\n")
    requests: list[Request] = []

    def opener(request: Request, *, timeout: float) -> Response:
        requests.append(request)
        return Response(json.dumps(lease_payload()).encode())

    client = WorkerClient("https://afterimage.example", token_path, opener=opener)
    lease = client.lease("dgx-spark")

    assert lease is not None
    assert requests[0].full_url.endswith("/v1/internal/gpu-jobs/lease")
    assert requests[0].get_header("Authorization") == f"Bearer aft_worker_{'w' * 43}"


def test_download_validates_declared_size(tmp_path: Path) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(f"aft_worker_{'w' * 43}")

    def opener(request: Request, timeout: float) -> Response:
        return Response(b"four")

    client = WorkerClient("https://afterimage.example", token_path, opener=opener)
    lease = WorkerClient.parse_lease_payload(lease_payload())
    with pytest.raises(APIError, match="size_mismatch"):
        client.download(lease, tmp_path / "source.mov")


def test_http_error_redacts_urls_and_tokens(tmp_path: Path) -> None:
    token = f"aft_worker_{'s' * 43}"
    token_path = tmp_path / "token"
    token_path.write_text(token)

    def opener(request: Request, timeout: float) -> Response:
        raise HTTPError(request.full_url, 503, "unavailable", {}, None)

    client = WorkerClient("https://afterimage.example", token_path, opener=opener)
    with pytest.raises(APIError) as raised:
        client.fail("job-1", "l" * 43, FailureCode.INFERENCE_FAILED)
    message = str(raised.value)
    assert token not in message
    assert "https://" not in message


def test_derivative_upload_streams_bounded_chunks(tmp_path: Path) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(f"aft_worker_{'w' * 43}")
    derivative = tmp_path / "clip.mp4"
    derivative.write_bytes(b"x" * (2 * 1024 * 1024 + 7))
    chunk_sizes: list[int] = []

    def opener(request: Request, *, timeout: float) -> Response:
        body = request.data
        assert body is not None and not isinstance(body, bytes)
        chunk_sizes.extend(len(chunk) for chunk in body)
        return Response(b"{}")

    lease = replace(
        WorkerClient.parse_lease_payload(lease_payload()),
        kind="clip",
        request={"derivativeId": "derivative-1", "startMs": 0, "endMs": 1000},
        analysis=None,
    )
    client = WorkerClient("https://afterimage.example", token_path, opener=opener)
    client.upload_derivative(lease, derivative, "video/mp4")
    assert sum(chunk_sizes) == derivative.stat().st_size
    assert max(chunk_sizes) <= 1024 * 1024
