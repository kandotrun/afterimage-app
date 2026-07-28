from pathlib import Path

from afterimage_mage_worker.contracts import (
    AnalysisResult,
    AnalysisSpec,
    Asset,
    JobLease,
    MediaGrant,
    TimeRange,
)
from afterimage_mage_worker.worker import run_one_job


def analysis_lease() -> JobLease:
    return JobLease(
        id="job-1",
        kind="analysis",
        lease_token="l" * 43,
        lease_expires_at="2026-07-28T12:15:00.000Z",
        asset=Asset(
            id="asset-1",
            content_type="video/quicktime",
            byte_size=5,
            duration_ms=4000,
            width=1920,
            height=1080,
            captured_at="2026-07-28T12:00:00.000Z",
        ),
        media=MediaGrant(
            url="https://afterimage.example/v1/media/private",
            expires_at="2026-07-28T12:10:00.000Z",
        ),
        request={},
        analysis=AnalysisSpec(
            model_id="microsoft/Mage-VL",
            model_revision="8484f3154beea3b563bee99e2fab2d6c8bb5d3f3",
            backend="frames",
        ),
    )


class Client:
    def __init__(self, heartbeat_result: bool = True) -> None:
        self.heartbeat_result = heartbeat_result
        self.submitted = False
        self.failed = False

    def heartbeat(self, lease: JobLease) -> bool:
        return self.heartbeat_result

    def download(self, lease: JobLease, destination: Path) -> None:
        destination.write_bytes(b"video")

    def submit_analysis(self, lease: JobLease, result: AnalysisResult) -> None:
        self.submitted = True

    def upload_derivative(self, lease: JobLease, path: Path, content_type: str) -> None:
        raise AssertionError("not a derivative job")

    def fail(self, job_id: str, lease_token: str, code: object) -> None:
        self.failed = True


class Runtime:
    def __init__(self) -> None:
        self.cancelled = False
        self.analyzed = False

    def analyze(self, source: Path, lease: JobLease) -> AnalysisResult:
        if self.cancelled:
            raise AssertionError("cancelled runtime was not prepared")
        self.analyzed = True
        return AnalysisResult(
            summary="a short memory",
            segments=(),
            analyzed_ranges=(TimeRange(start_ms=0, end_ms=4000),),
            coverage_mode="full",
        )

    def frame(self, source: Path, destination: Path, time_ms: int) -> None:
        raise AssertionError("not a frame job")

    def clip(self, source: Path, destination: Path, start_ms: int, end_ms: int) -> None:
        raise AssertionError("not a clip job")

    def cancel(self) -> None:
        self.cancelled = True

    def prepare(self) -> None:
        self.cancelled = False


def test_worker_removes_source_after_success(tmp_path: Path) -> None:
    client = Client()
    runtime = Runtime()
    run_one_job(client, runtime, analysis_lease(), tmp_path)
    assert client.submitted
    assert list(tmp_path.iterdir()) == []


def test_worker_cancels_when_heartbeat_reports_cancelled(tmp_path: Path) -> None:
    client = Client(heartbeat_result=False)
    runtime = Runtime()
    run_one_job(client, runtime, analysis_lease(), tmp_path)
    assert runtime.cancelled
    assert not runtime.analyzed
    assert list(tmp_path.iterdir()) == []


def test_worker_prepares_runtime_for_job_after_cancellation(tmp_path: Path) -> None:
    client = Client(heartbeat_result=False)
    runtime = Runtime()
    run_one_job(client, runtime, analysis_lease(), tmp_path)
    client.heartbeat_result = True
    run_one_job(client, runtime, analysis_lease(), tmp_path)
    assert client.submitted
    assert runtime.analyzed
