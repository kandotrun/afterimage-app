from pathlib import Path
from typing import Protocol
import shutil
import tempfile
import threading

from .client import APIError
from .contracts import AnalysisResult, FailureCode, JobLease
from .runtime import RuntimeFailure


class ClientProtocol(Protocol):
    def heartbeat(self, lease: JobLease) -> bool: ...
    def download(self, lease: JobLease, destination: Path) -> None: ...
    def submit_analysis(self, lease: JobLease, result: AnalysisResult) -> None: ...
    def upload_derivative(self, lease: JobLease, path: Path, content_type: str) -> None: ...
    def fail(self, job_id: str, lease_token: str, code: FailureCode) -> None: ...


class RuntimeProtocol(Protocol):
    def prepare(self) -> None: ...
    def analyze(self, source: Path, lease: JobLease) -> AnalysisResult: ...
    def frame(self, source: Path, destination: Path, time_ms: int) -> None: ...
    def clip(self, source: Path, destination: Path, start_ms: int, end_ms: int) -> None: ...
    def cancel(self) -> None: ...


class Heartbeat:
    def __init__(
        self,
        client: ClientProtocol,
        runtime: RuntimeProtocol,
        lease: JobLease,
        interval: float,
    ) -> None:
        self._client = client
        self._runtime = runtime
        self._lease = lease
        self._interval = interval
        self._stop = threading.Event()
        self.cancelled = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                active = self._client.heartbeat(self._lease)
            except APIError:
                continue
            if active:
                continue
            self.cancelled.set()
            self._runtime.cancel()
            return


def _report_failure(client: ClientProtocol, lease: JobLease, code: FailureCode) -> None:
    try:
        client.fail(lease.id, lease.lease_token, code)
    except APIError:
        pass


def run_one_job(
    client: ClientProtocol,
    runtime: RuntimeProtocol,
    lease: JobLease,
    work_root: Path,
    heartbeat_interval: float = 60,
) -> None:
    work_root.mkdir(parents=True, exist_ok=True)
    job_directory = Path(tempfile.mkdtemp(prefix="job-", dir=work_root))
    source = job_directory / "source.mov"
    heartbeat: Heartbeat | None = None
    failure_code = FailureCode.INFERENCE_FAILED
    try:
        runtime.prepare()
        if not client.heartbeat(lease):
            runtime.cancel()
            return
        required_bytes = lease.asset.byte_size * 2 + 1024 * 1024 * 1024
        if shutil.disk_usage(work_root).free < required_bytes:
            _report_failure(client, lease, FailureCode.DISK_SPACE_LOW)
            return
        heartbeat = Heartbeat(client, runtime, lease, heartbeat_interval)
        heartbeat.start()
        failure_code = FailureCode.DOWNLOAD_FAILED
        client.download(lease, source)
        if heartbeat.cancelled.is_set():
            return
        if lease.kind == "analysis":
            failure_code = FailureCode.INFERENCE_FAILED
            result = runtime.analyze(source, lease)
            if heartbeat.cancelled.is_set():
                return
            client.submit_analysis(lease, result)
            return
        if lease.kind == "frame":
            failure_code = FailureCode.DECODE_FAILED
            output = job_directory / "frame.jpg"
            runtime.frame(source, output, int(lease.request["timeMs"]))
            if heartbeat.cancelled.is_set():
                return
            failure_code = FailureCode.INFERENCE_FAILED
            client.upload_derivative(lease, output, "image/jpeg")
            return
        failure_code = FailureCode.DECODE_FAILED
        output = job_directory / "clip.mp4"
        runtime.clip(
            source,
            output,
            int(lease.request["startMs"]),
            int(lease.request["endMs"]),
        )
        if heartbeat.cancelled.is_set():
            return
        failure_code = FailureCode.INFERENCE_FAILED
        client.upload_derivative(lease, output, "video/mp4")
    except RuntimeFailure as error:
        if error.code != FailureCode.CANCELLED:
            _report_failure(client, lease, error.code)
    except APIError as error:
        code = FailureCode.SIZE_MISMATCH if error.code == "size_mismatch" else failure_code
        _report_failure(client, lease, code)
    except Exception:
        _report_failure(client, lease, failure_code)
    finally:
        if heartbeat is not None:
            heartbeat.stop()
        shutil.rmtree(job_directory, ignore_errors=True)
