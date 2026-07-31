from collections.abc import Iterator
from dataclasses import dataclass
from enum import Enum
import json
from urllib.parse import urlparse

from . import MODEL_ID, MODEL_REVISION


class ContractError(ValueError):
    pass


class FailureCode(str, Enum):
    DOWNLOAD_FAILED = "download_failed"
    SIZE_MISMATCH = "size_mismatch"
    DECODE_FAILED = "decode_failed"
    MODEL_LOAD_FAILED = "model_load_failed"
    INFERENCE_FAILED = "inference_failed"
    OUTPUT_INVALID = "output_invalid"
    DISK_SPACE_LOW = "disk_space_low"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class Asset:
    id: str
    content_type: str
    byte_size: int
    duration_ms: int | None
    width: int | None
    height: int | None
    captured_at: str


@dataclass(frozen=True, slots=True)
class MediaGrant:
    url: str
    expires_at: str


@dataclass(frozen=True, slots=True)
class AnalysisSpec:
    model_id: str
    model_revision: str
    backend: str


@dataclass(frozen=True, slots=True)
class JobLease:
    id: str
    kind: str
    lease_token: str
    lease_expires_at: str
    asset: Asset
    media: MediaGrant
    request: dict[str, object]
    analysis: AnalysisSpec | None


@dataclass(frozen=True, slots=True)
class TimeRange:
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class Segment(TimeRange):
    caption: str


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    summary: str
    segments: tuple[Segment, ...]
    analyzed_ranges: tuple[TimeRange, ...] = ()
    coverage_mode: str = "full"


def _object(value: object, keys: set[str], name: str) -> dict[str, object]:
    if type(value) is not dict:
        raise ContractError(f"{name}_invalid")
    result = value
    if set(result) != keys:
        raise ContractError(f"{name}_fields_invalid")
    return result


def _string(value: object, name: str, minimum: int = 1, maximum: int = 8000) -> str:
    if type(value) is not str:
        raise ContractError(f"{name}_invalid")
    result = value.strip()
    if len(result) < minimum or len(result) > maximum:
        raise ContractError(f"{name}_invalid")
    return result


def _integer(value: object, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ContractError(f"{name}_invalid")
    return value


def _nullable_integer(value: object, name: str, minimum: int = 0) -> int | None:
    if value is None:
        return None
    return _integer(value, name, minimum)


def _https_url(value: object, name: str) -> str:
    result = _string(value, name, maximum=4096)
    parsed = urlparse(result)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ContractError(f"{name}_invalid")
    return result


def _range(value: object, duration_ms: int, name: str) -> TimeRange:
    item = _object(value, {"startMs", "endMs"}, name)
    start_ms = _integer(item["startMs"], f"{name}_start")
    end_ms = _integer(item["endMs"], f"{name}_end", 1)
    if end_ms <= start_ms or end_ms > duration_ms:
        raise ContractError(f"{name}_invalid")
    return TimeRange(start_ms=start_ms, end_ms=end_ms)


def parse_lease(payload: object) -> JobLease:
    root = _object(payload, {"job"}, "lease")
    raw_job = root["job"]
    if type(raw_job) is not dict:
        raise ContractError("job_invalid")
    raw_kind = raw_job.get("kind")
    if raw_kind not in {"analysis", "frame", "clip"}:
        raise ContractError("job_kind_invalid")
    kind = str(raw_kind)
    job_keys = {
        "id",
        "kind",
        "leaseToken",
        "leaseExpiresAt",
        "asset",
        "media",
        "request",
    }
    if kind == "analysis":
        job_keys.add("analysis")
    job = _object(raw_job, job_keys, "job")
    asset_value = _object(
        job["asset"],
        {"id", "contentType", "byteSize", "durationMs", "width", "height", "capturedAt"},
        "asset",
    )
    asset = Asset(
        id=_string(asset_value["id"], "asset_id", maximum=100),
        content_type=_string(asset_value["contentType"], "content_type", maximum=200),
        byte_size=_integer(asset_value["byteSize"], "byte_size", 1),
        duration_ms=_nullable_integer(asset_value["durationMs"], "duration_ms", 1),
        width=_nullable_integer(asset_value["width"], "width", 1),
        height=_nullable_integer(asset_value["height"], "height", 1),
        captured_at=_string(asset_value["capturedAt"], "captured_at", maximum=100),
    )
    media_value = _object(job["media"], {"url", "expiresAt"}, "media")
    media = MediaGrant(
        url=_https_url(media_value["url"], "media_url"),
        expires_at=_string(media_value["expiresAt"], "media_expires_at", maximum=100),
    )
    request = _object(
        job["request"],
        set() if kind == "analysis" else (
            {"derivativeId", "timeMs"} if kind == "frame"
            else {"derivativeId", "startMs", "endMs"}
        ),
        "request",
    )
    if kind == "frame":
        time_ms = _integer(request["timeMs"], "time_ms")
        if asset.duration_ms is not None and time_ms >= asset.duration_ms:
            raise ContractError("time_ms_invalid")
        _string(request["derivativeId"], "derivative_id", maximum=100)
    if kind == "clip":
        start_ms = _integer(request["startMs"], "start_ms")
        end_ms = _integer(request["endMs"], "end_ms", 1)
        if end_ms <= start_ms or end_ms - start_ms > 60000:
            raise ContractError("clip_range_invalid")
        if asset.duration_ms is not None and end_ms > asset.duration_ms:
            raise ContractError("clip_range_invalid")
        _string(request["derivativeId"], "derivative_id", maximum=100)
    analysis = None
    if kind == "analysis":
        analysis_value = _object(
            job["analysis"],
            {"modelId", "modelRevision", "backend"},
            "analysis",
        )
        model_id = _string(analysis_value["modelId"], "model_id", maximum=200)
        model_revision = _string(analysis_value["modelRevision"], "model_revision", maximum=100)
        backend = _string(analysis_value["backend"], "backend", maximum=20)
        if model_id != MODEL_ID or model_revision != MODEL_REVISION or backend != "frames":
            raise ContractError("analysis_spec_invalid")
        analysis = AnalysisSpec(
            model_id=model_id,
            model_revision=model_revision,
            backend=backend,
        )
    return JobLease(
        id=_string(job["id"], "job_id", maximum=100),
        kind=kind,
        lease_token=_string(job["leaseToken"], "lease_token", minimum=32, maximum=256),
        lease_expires_at=_string(job["leaseExpiresAt"], "lease_expires_at", maximum=100),
        asset=asset,
        media=media,
        request=request,
        analysis=analysis,
    )


def _json_values(value: str) -> Iterator[object]:
    decoder = json.JSONDecoder()
    stripped = value.strip()
    try:
        decoded = json.loads(stripped)
    except json.JSONDecodeError:
        pass
    else:
        yield decoded
        return
    for position, character in enumerate(value):
        if character not in "{[":
            continue
        try:
            decoded, _ = decoder.raw_decode(value, position)
        except json.JSONDecodeError:
            continue
        if type(decoded) in {dict, list}:
            yield decoded


def _dict_candidates(value: object) -> Iterator[dict[str, object]]:
    stack = [value]
    while stack:
        candidate = stack.pop()
        if type(candidate) is dict:
            yield candidate
            stack.extend(reversed(tuple(candidate.values())))
        elif type(candidate) is list:
            stack.extend(reversed(candidate))


def _contains_json(value: str) -> bool:
    try:
        json.loads(value)
    except json.JSONDecodeError:
        pass
    else:
        return True
    stripped = value.strip()
    if stripped.startswith(("{", "[")):
        return True
    if "```json" in value.lower():
        return True
    if stripped.startswith('"'):
        escaped = False
        for character in stripped[1:]:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                break
        else:
            return True
    decoder = json.JSONDecoder()
    for position, character in enumerate(value):
        if character not in "{[":
            continue
        try:
            decoded, _ = decoder.raw_decode(value, position)
        except json.JSONDecodeError:
            decoded = None
        if type(decoded) in {dict, list}:
            return True
        remainder = value[position + 1:].lstrip()
        if not remainder:
            return True
        if character == "{" and remainder.startswith('"'):
            return True
        if character == "[" and "," in remainder:
            return True
    return False


_SEMANTIC_TEXT_FIELDS = {
    "summary",
    "answer",
    "description",
    "text",
    "response",
    "content",
    "caption",
    "captions",
    "visual",
    "visuals",
    "scene",
    "scenes",
    "event",
    "events",
    "observation",
    "observations",
    "analysis",
    "result",
    "output",
    "要約",
    "概要",
    "説明",
    "描写",
    "内容",
    "回答",
    "場面",
    "シーン",
    "出来事",
    "観察",
    "解析",
    "分析",
    "結果",
    "出力",
    "映像",
    "動画",
}


def _semantic_field(field: str) -> bool:
    normalized = field.replace("_", "").replace("-", "").lower()
    if normalized in _SEMANTIC_TEXT_FIELDS:
        return True
    return any(
        marker in normalized
        for marker in (
            "summary", "answer", "description", "text", "response", "content",
            "caption", "visual", "scene", "event", "observation", "analysis",
            "result", "output", "要約", "概要", "説明", "描写", "内容", "回答",
            "場面", "シーン", "出来事", "観察", "解析", "分析", "結果", "出力",
        )
    )


def _summary_from_values(values: list[str], *, require_descriptive: bool = False) -> str | None:
    unique_values = list(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not unique_values:
        return None
    if require_descriptive and max(map(len, unique_values)) < 12 and sum(map(len, unique_values)) < 20:
        return None
    summary = "\n".join(unique_values)[:8000].rstrip()
    try:
        return _string(summary, "summary")
    except ContractError:
        return None


def _all_string_values(value: object) -> list[str]:
    values: list[str] = []
    stack = [value]
    while stack and len(values) < 200:
        candidate = stack.pop()
        if type(candidate) is str:
            values.append(candidate)
        elif type(candidate) is list:
            stack.extend(reversed(candidate))
        elif type(candidate) is dict:
            stack.extend(reversed(tuple(candidate.values())))
    return values


def _text_summary(candidate: object, *, assume_semantic: bool = False) -> str | None:
    values: list[str] = []
    stack: list[tuple[object, bool]] = [(candidate, assume_semantic)]
    while stack and len(values) < 200:
        value, inside_semantic_field = stack.pop()
        if type(value) is str:
            if inside_semantic_field and value.strip():
                values.append(value.strip())
            continue
        if type(value) is list:
            if inside_semantic_field:
                stack.extend((item, True) for item in reversed(value))
            continue
        if type(value) is not dict:
            continue
        for field, item in reversed(tuple(value.items())):
            is_semantic_field = _semantic_field(field)
            if inside_semantic_field or is_semantic_field:
                stack.append((item, True))
    semantic_summary = _summary_from_values(values)
    if semantic_summary is not None:
        return semantic_summary
    return _summary_from_values(_all_string_values(candidate), require_descriptive=True)


def _salvage_truncated_json(value: str) -> str | None:
    decoder = json.JSONDecoder()
    values: list[str] = []
    semantic_key_seen = False
    position = 0
    while len(values) < 200:
        position = value.find('"', position)
        if position < 0:
            break
        try:
            decoded, end = decoder.raw_decode(value, position)
        except json.JSONDecodeError:
            position += 1
            continue
        position = end
        if type(decoded) is not str:
            continue
        if value[end:].lstrip().startswith(":"):
            semantic_key_seen = semantic_key_seen or _semantic_field(decoded)
            continue
        if semantic_key_seen or len(decoded.strip()) >= 12:
            values.append(decoded)
    return _summary_from_values(values, require_descriptive=not semantic_key_seen)


def parse_analysis(value: str, duration_ms: int) -> AnalysisResult:
    required_fields = {"summary", "segments"}
    payload: dict[str, object] | None = None
    fallback_summary: str | None = None
    found_json = _contains_json(value)
    decoded_json = False
    for decoded in _json_values(value):
        decoded_json = True
        found_json = True
        if fallback_summary is None:
            fallback_summary = _text_summary(
                decoded,
                assume_semantic=type(decoded) is str,
            )
        for candidate in _dict_candidates(decoded):
            if fallback_summary is None:
                fallback_summary = _text_summary(candidate)
            if required_fields.issubset(candidate):
                payload = {field: candidate[field] for field in required_fields}
                break
        if payload is not None:
            break
    if payload is None:
        if fallback_summary is None and found_json and not decoded_json:
            fallback_summary = _salvage_truncated_json(value)
        if fallback_summary is not None:
            return AnalysisResult(summary=fallback_summary, segments=())
        if found_json:
            raise ContractError("analysis_output_fields_invalid")
        return AnalysisResult(summary=_string(value, "summary"), segments=())
    summary = _string(payload["summary"], "summary")
    raw_segments = payload["segments"]
    if type(raw_segments) is not list or len(raw_segments) > 200:
        return AnalysisResult(summary=summary, segments=())
    segments: list[Segment] = []
    expected_segment_fields = {"startMs", "endMs", "caption"}
    for position, raw_segment in enumerate(raw_segments):
        if type(raw_segment) is not dict or set(raw_segment) != expected_segment_fields:
            continue
        time_range = _range(
            {"startMs": raw_segment["startMs"], "endMs": raw_segment["endMs"]},
            duration_ms,
            f"segment_{position}",
        )
        try:
            caption = _string(
                raw_segment["caption"],
                f"segment_{position}_caption",
                maximum=2000,
            )
        except ContractError:
            continue
        segments.append(Segment(
            start_ms=time_range.start_ms,
            end_ms=time_range.end_ms,
            caption=caption,
        ))
    return AnalysisResult(summary=summary, segments=tuple(segments))
