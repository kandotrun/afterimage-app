import json
import math
from collections.abc import Callable
from pathlib import Path
import subprocess
import threading
import time

from . import MODEL_ID, MODEL_REVISION
from .contracts import (
    AnalysisResult,
    ContractError,
    FailureCode,
    JobLease,
    Segment,
    TimeRange,
    parse_analysis,
)


class RuntimeFailure(RuntimeError):
    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)


def offline_model_imports(
    filename: str,
    check_imports: Callable[[str], list[str]],
    get_relative_imports: Callable[[str], list[str]],
) -> list[str]:
    try:
        return check_imports(filename)
    except ImportError as error:
        if Path(filename).name == "streammind_gate.py" and "mamba_ssm" in str(error):
            return get_relative_imports(filename)
        raise


def analysis_windows(duration_ms: int) -> tuple[tuple[TimeRange, ...], str]:
    if duration_ms <= 0:
        raise RuntimeFailure(FailureCode.DECODE_FAILED)
    window_ms = 120000
    if duration_ms <= 600000:
        windows = tuple(
            TimeRange(start_ms=start, end_ms=min(start + window_ms, duration_ms))
            for start in range(0, duration_ms, window_ms)
        )
        return windows, "full"
    window_count = min(30, math.ceil(duration_ms / window_ms))
    last_start = max(0, duration_ms - window_ms)
    starts = [
        round(position * last_start / (window_count - 1))
        for position in range(window_count)
    ]
    windows = tuple(
        TimeRange(start_ms=start, end_ms=min(start + window_ms, duration_ms))
        for start in starts
    )
    return windows, "sampled"


def sample_frame_indices(
    frame_count: int,
    duration_ms: int,
    time_range_start_ms: int,
    time_range_end_ms: int,
) -> tuple[int, ...]:
    if frame_count <= 0 or duration_ms <= 0 or time_range_end_ms <= time_range_start_ms:
        raise RuntimeFailure(FailureCode.DECODE_FAILED)
    start_index = min(
        frame_count - 1,
        math.floor(time_range_start_ms * frame_count / duration_ms),
    )
    end_index = min(
        frame_count - 1,
        max(
            start_index,
            math.ceil(time_range_end_ms * frame_count / duration_ms) - 1,
        ),
    )
    sample_count = min(32, end_index - start_index + 1)
    if sample_count == 1:
        return (start_index,)
    return tuple(
        round(start_index + position * (end_index - start_index) / (sample_count - 1))
        for position in range(sample_count)
    )


def normalize_window_segments(
    result: AnalysisResult,
    window_duration_ms: int,
) -> AnalysisResult:
    if not result.segments:
        return result
    seconds_limit = math.ceil(window_duration_ms / 1000) + 5
    uses_seconds = (
        window_duration_ms >= 1000
        and max(segment.end_ms for segment in result.segments) <= seconds_limit
    )
    multiplier = 1000 if uses_seconds else 1
    segments: list[Segment] = []
    for segment in result.segments:
        start_ms = segment.start_ms * multiplier
        end_ms = min(segment.end_ms * multiplier, window_duration_ms)
        if start_ms >= window_duration_ms or end_ms <= start_ms:
            continue
        segments.append(Segment(
            start_ms=start_ms,
            end_ms=end_ms,
            caption=segment.caption,
        ))
    return AnalysisResult(summary=result.summary, segments=tuple(segments))


class MageRuntime:
    def __init__(self) -> None:
        self._cancelled = threading.Event()
        self._processor = None
        self._model = None

    def cancel(self) -> None:
        self._cancelled.set()

    def prepare(self) -> None:
        self._cancelled.clear()

    def _check_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise RuntimeFailure(FailureCode.CANCELLED)

    def _process(self, command: list[str], timeout: float) -> None:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            if self._cancelled.wait(0.25):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise RuntimeFailure(FailureCode.CANCELLED)
            if time.monotonic() >= deadline:
                process.kill()
                process.wait()
                raise RuntimeFailure(FailureCode.DECODE_FAILED)
        if process.returncode != 0:
            raise RuntimeFailure(FailureCode.DECODE_FAILED)

    def _probe(self, source: Path) -> dict[str, object]:
        try:
            completed = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration:stream=codec_type,width,height",
                    "-of",
                    "json",
                    str(source),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            payload = json.loads(completed.stdout)
        except (
            OSError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            json.JSONDecodeError,
        ) as error:
            raise RuntimeFailure(FailureCode.DECODE_FAILED) from error
        if type(payload) is not dict or type(payload.get("streams")) is not list:
            raise RuntimeFailure(FailureCode.DECODE_FAILED)
        if not any(
            type(stream) is dict and stream.get("codec_type") == "video"
            for stream in payload["streams"]
        ):
            raise RuntimeFailure(FailureCode.DECODE_FAILED)
        return payload

    def frame(self, source: Path, destination: Path, time_ms: int) -> None:
        self._probe(source)
        self._process(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                f"{time_ms / 1000:.3f}",
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-f",
                "image2",
                "-y",
                str(destination),
            ],
            120,
        )
        if not destination.is_file() or destination.stat().st_size <= 0:
            raise RuntimeFailure(FailureCode.DECODE_FAILED)

    def clip(self, source: Path, destination: Path, start_ms: int, end_ms: int) -> None:
        self._probe(source)
        self._process(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                f"{start_ms / 1000:.3f}",
                "-i",
                str(source),
                "-t",
                f"{(end_ms - start_ms) / 1000:.3f}",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-y",
                str(destination),
            ],
            300,
        )
        if not destination.is_file() or destination.stat().st_size <= 0:
            raise RuntimeFailure(FailureCode.DECODE_FAILED)
        self._probe(destination)

    def _load_model(self) -> None:
        if self._processor is not None and self._model is not None:
            return
        try:
            from transformers import AutoModelForCausalLM, AutoProcessor, dynamic_module_utils

            check_imports = dynamic_module_utils.check_imports
            dynamic_module_utils.check_imports = lambda filename: offline_model_imports(
                filename,
                check_imports,
                dynamic_module_utils.get_relative_imports,
            )
            try:
                self._processor = AutoProcessor.from_pretrained(
                    MODEL_ID,
                    revision=MODEL_REVISION,
                    trust_remote_code=True,
                )
                self._model = AutoModelForCausalLM.from_pretrained(
                    MODEL_ID,
                    revision=MODEL_REVISION,
                    trust_remote_code=True,
                    torch_dtype="auto",
                    device_map="auto",
                ).eval()
            finally:
                dynamic_module_utils.check_imports = check_imports
        except Exception as error:
            raise RuntimeFailure(FailureCode.MODEL_LOAD_FAILED) from error

    def _sample_frames(
        self,
        source: Path,
        time_range: TimeRange,
        duration_ms: int,
    ) -> list[object]:
        try:
            import cv2
            from PIL import Image

            capture = cv2.VideoCapture(str(source))
            if not capture.isOpened():
                raise RuntimeFailure(FailureCode.DECODE_FAILED)
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            indices = sample_frame_indices(
                frame_count,
                duration_ms,
                time_range.start_ms,
                time_range.end_ms,
            )
            frames: list[object] = []
            try:
                for index in indices:
                    self._check_cancelled()
                    capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                    ok, frame = capture.read()
                    if not ok:
                        raise RuntimeFailure(FailureCode.DECODE_FAILED)
                    frames.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
            finally:
                capture.release()
            return frames
        except RuntimeFailure:
            raise
        except Exception as error:
            raise RuntimeFailure(FailureCode.DECODE_FAILED) from error

    def _infer_window(
        self,
        source: Path,
        time_range: TimeRange,
        duration_ms: int,
    ) -> AnalysisResult:
        self._load_model()
        self._check_cancelled()
        frames = self._sample_frames(source, time_range, duration_ms)
        window_duration_ms = time_range.end_ms - time_range.start_ms
        prompt = (
            "Return only one valid JSON object. It must contain exactly two fields: "
            "summary, a concise factual description of the visible video content; and "
            "segments, an array of visible events. Each segment must contain exactly "
            "startMs, endMs, and caption. "
            f"The sampled frames cover {time_range.start_ms}ms through {time_range.end_ms}ms "
            f"of a {duration_ms}ms private lifelog video. Segment timestamps must be integer "
            f"millisecond offsets from 0 through {window_duration_ms} within this sampled window. "
            "Four seconds must be written as 4000, never 4. "
            "Include only clearly visible events, do not infer identity or facts not shown, "
            "and do not repeat text from these instructions."
        )
        try:
            import torch

            processor = self._processor
            model = self._model
            messages = [{
                "role": "user",
                "content": [
                    {"type": "video"},
                    {"type": "text", "text": prompt},
                ],
            }]
            text = processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            inputs = processor(
                text=[text],
                videos=[frames],
                return_tensors="pt",
                padding=True,
            )
            inputs = {
                key: value.to(model.device) if hasattr(value, "to") else value
                for key, value in inputs.items()
            }
            if "pixel_values" in inputs:
                inputs["pixel_values"] = inputs["pixel_values"].to(model.dtype)
            with torch.inference_mode():
                output = model.generate(
                    **inputs,
                    max_new_tokens=768,
                    do_sample=False,
                )
            answer = processor.tokenizer.decode(
                output[0, inputs["input_ids"].shape[1]:],
                skip_special_tokens=True,
            ).strip()
            local_result = normalize_window_segments(
                parse_analysis(answer, window_duration_ms),
                window_duration_ms,
            )
            return AnalysisResult(
                summary=local_result.summary,
                segments=tuple(
                    Segment(
                        start_ms=time_range.start_ms + segment.start_ms,
                        end_ms=time_range.start_ms + segment.end_ms,
                        caption=segment.caption,
                    )
                    for segment in local_result.segments
                ),
            )
        except ContractError as error:
            raise RuntimeFailure(FailureCode.OUTPUT_INVALID) from error
        except RuntimeFailure:
            raise
        except Exception as error:
            raise RuntimeFailure(FailureCode.INFERENCE_FAILED) from error

    def analyze(self, source: Path, lease: JobLease) -> AnalysisResult:
        self._probe(source)
        duration_ms = lease.asset.duration_ms
        if duration_ms is None:
            raise RuntimeFailure(FailureCode.DECODE_FAILED)
        windows, coverage_mode = analysis_windows(duration_ms)
        summaries: list[str] = []
        segments: list[Segment] = []
        for time_range in windows:
            result = self._infer_window(source, time_range, duration_ms)
            summaries.append(result.summary)
            segments.extend(result.segments)
            if len(segments) > 200:
                segments = segments[:200]
        summary = " ".join(summaries).strip()
        if len(summary) > 8000:
            summary = summary[:8000].rstrip()
        if not summary:
            raise RuntimeFailure(FailureCode.OUTPUT_INVALID)
        return AnalysisResult(
            summary=summary,
            segments=tuple(segments),
            analyzed_ranges=windows,
            coverage_mode=coverage_mode,
        )
