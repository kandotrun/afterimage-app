import json
from http.client import HTTPMessage
from pathlib import Path
import re
from typing import BinaryIO, Iterator, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import MODEL_ID, MODEL_REVISION
from .contracts import AnalysisResult, FailureCode, JobLease, parse_lease

_USER_AGENT = "afterimage-mage-worker/0.1.0"


class APIError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class Opener(Protocol):
    def __call__(self, request: Request, *, timeout: float) -> object: ...


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        _req: Request,
        _fp: BinaryIO | None,
        _code: int,
        _msg: str,
        _headers: HTTPMessage,
        _newurl: str,
    ) -> None:
        return None


_OPENER = build_opener(_NoRedirectHandler())


def _open(request: Request, *, timeout: float) -> object:
    return _OPENER.open(request, timeout=timeout)


def _https_origin(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("url_origin_invalid") from None
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("url_origin_invalid")
    return parsed.scheme, parsed.hostname, port or 443


def read_chunks(body: BinaryIO) -> Iterator[bytes]:
    while True:
        chunk = body.read(1024 * 1024)
        if not chunk:
            return
        yield chunk


class WorkerClient:
    def __init__(
        self,
        base_url: str,
        token_path: Path,
        timeout: float = 60,
        opener: Opener = _open,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        try:
            self._api_origin = _https_origin(self._base_url)
        except ValueError:
            raise ValueError("api_base_url_invalid")
        self._token = token_path.read_text().strip()
        if not re.fullmatch(r"aft_worker_[A-Za-z0-9_-]{43}", self._token):
            raise ValueError("worker_token_invalid")
        self._timeout = timeout
        self._opener = opener

    @staticmethod
    def parse_lease_payload(payload: object) -> JobLease:
        return parse_lease(payload)

    def _api_request(
        self,
        path: str,
        method: str,
        payload: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
        data: object | None = None,
        allow_not_found: bool = False,
    ) -> object | None:
        body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else data
        request_headers = {
            "Authorization": f"Bearer {self._token}",
            "User-Agent": _USER_AGENT,
            **(headers or {}),
        }
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        request = Request(
            f"{self._base_url}{path}",
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            return self._opener(request, timeout=self._timeout)
        except HTTPError as error:
            error.close()
            if allow_not_found and error.code == 404:
                return None
            raise APIError(f"http_{error.code}") from None
        except (URLError, TimeoutError, OSError):
            raise APIError("network_error") from None

    @staticmethod
    def _json_response(response: object) -> object:
        try:
            with response:
                body = response.read()
            return json.loads(body)
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            raise APIError("response_invalid") from None

    def lease(self, worker_id: str) -> JobLease | None:
        response = self._api_request(
            "/v1/internal/gpu-jobs/lease",
            "POST",
            {
                "workerId": worker_id,
                "capabilities": {
                    "backends": ["frames"],
                    "modelId": MODEL_ID,
                },
            },
        )
        if response is None or getattr(response, "status", None) == 204:
            if response is not None:
                response.close()
            return None
        return parse_lease(self._json_response(response))

    def heartbeat(self, lease: JobLease) -> bool:
        response = self._api_request(
            f"/v1/internal/gpu-jobs/{lease.id}/heartbeat",
            "POST",
            {"leaseToken": lease.lease_token},
            allow_not_found=True,
        )
        if response is None:
            return False
        payload = self._json_response(response)
        return type(payload) is dict and payload.get("status") == "leased"

    def download(self, lease: JobLease, destination: Path) -> None:
        try:
            media_origin = _https_origin(lease.media.url)
        except ValueError:
            raise APIError("download_origin_invalid") from None
        if media_origin != self._api_origin:
            raise APIError("download_origin_invalid")
        request = Request(lease.media.url, headers={"User-Agent": _USER_AGENT}, method="GET")
        written = 0
        try:
            response = self._opener(request, timeout=self._timeout)
            with response, destination.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > lease.asset.byte_size:
                        raise APIError("size_mismatch")
                    output.write(chunk)
        except APIError:
            raise
        except HTTPError as error:
            error.close()
            raise APIError("download_failed") from None
        except (URLError, TimeoutError, OSError):
            raise APIError("download_failed") from None
        if written != lease.asset.byte_size:
            raise APIError("size_mismatch")

    def submit_analysis(self, lease: JobLease, result: AnalysisResult) -> None:
        if lease.analysis is None:
            raise APIError("analysis_spec_missing")
        response = self._api_request(
            f"/v1/internal/gpu-jobs/{lease.id}/analysis",
            "POST",
            {
                "leaseToken": lease.lease_token,
                "modelId": MODEL_ID,
                "modelRevision": MODEL_REVISION,
                "backend": lease.analysis.backend,
                "coverageMode": result.coverage_mode,
                "analyzedRanges": [
                    {"startMs": item.start_ms, "endMs": item.end_ms}
                    for item in result.analyzed_ranges
                ],
                "summary": result.summary,
                "segments": [
                    {
                        "startMs": item.start_ms,
                        "endMs": item.end_ms,
                        "caption": item.caption,
                    }
                    for item in result.segments
                ],
            },
        )
        if response is not None:
            response.close()

    def upload_derivative(self, lease: JobLease, path: Path, content_type: str) -> None:
        size = path.stat().st_size
        with path.open("rb") as body:
            response = self._api_request(
                f"/v1/internal/gpu-jobs/{lease.id}/derivative",
                "PUT",
                headers={
                    "Content-Type": content_type,
                    "Content-Length": str(size),
                    "X-Afterimage-Lease-Token": lease.lease_token,
                },
                data=read_chunks(body),
            )
        if response is not None:
            response.close()

    def fail(self, job_id: str, lease_token: str, code: FailureCode) -> None:
        response = self._api_request(
            f"/v1/internal/gpu-jobs/{job_id}/fail",
            "POST",
            {"leaseToken": lease_token, "code": code.value},
        )
        if response is not None:
            response.close()
