import json

import pytest

from afterimage_mage_worker.contracts import (
    ContractError,
    FailureCode,
    parse_analysis,
    parse_lease,
)


def lease_payload(kind: str = "analysis") -> dict[str, object]:
    return {
        "job": {
            "id": "job-1",
            "kind": kind,
            "leaseToken": "l" * 43,
            "leaseExpiresAt": "2026-07-28T12:15:00.000Z",
            "asset": {
                "id": "asset-1",
                "contentType": "video/quicktime",
                "byteSize": 5,
                "durationMs": 4000,
                "width": 1920,
                "height": 1080,
                "capturedAt": "2026-07-28T12:00:00.000Z",
            },
            "media": {
                "url": "https://afterimage.example/v1/media/private-token",
                "expiresAt": "2026-07-28T12:10:00.000Z",
            },
            "analysis": {
                "modelId": "microsoft/Mage-VL",
                "modelRevision": "8484f3154beea3b563bee99e2fab2d6c8bb5d3f3",
                "backend": "frames",
            },
            "request": {},
        }
    }


def test_parses_strict_analysis_lease() -> None:
    lease = parse_lease(lease_payload())
    assert lease.id == "job-1"
    assert lease.asset.duration_ms == 4000
    assert lease.analysis is not None
    assert lease.analysis.backend == "frames"


def test_rejects_unknown_lease_fields() -> None:
    payload = lease_payload()
    job = payload["job"]
    assert isinstance(job, dict)
    job["unexpected"] = True
    with pytest.raises(ContractError):
        parse_lease(payload)


def test_analysis_rejects_out_of_bounds_segment() -> None:
    payload = {
        "summary": "keys on desk",
        "segments": [{"startMs": 2000, "endMs": 5000, "caption": "keys"}],
    }
    with pytest.raises(ContractError):
        parse_analysis(json.dumps(payload), duration_ms=4000)


def test_analysis_accepts_bounded_json() -> None:
    result = parse_analysis(
        json.dumps({
            "summary": "keys on desk",
            "segments": [{"startMs": 2000, "endMs": 3500, "caption": "keys"}],
        }),
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"
    assert result.segments[0].caption == "keys"


def test_analysis_accepts_json_code_fence() -> None:
    result = parse_analysis(
        "```json\n"
        + json.dumps({"summary": "keys on desk", "segments": []})
        + "\n```",
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"


def test_analysis_accepts_json_surrounded_by_model_prose() -> None:
    result = parse_analysis(
        "Here is the requested JSON:\n"
        + json.dumps({"summary": "keys on desk", "segments": []})
        + "\nThis describes the visible content.",
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"


def test_analysis_ignores_additional_model_fields() -> None:
    result = parse_analysis(
        json.dumps({
            "summary": "keys on desk",
            "segments": [],
            "confidence": "high",
        }),
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"


def test_analysis_accepts_nested_contract_object() -> None:
    result = parse_analysis(
        json.dumps({
            "analysis": {
                "summary": "keys on desk",
                "segments": [],
            },
        }),
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"


def test_analysis_skips_unrelated_json_before_contract() -> None:
    result = parse_analysis(
        "Metadata: "
        + json.dumps({"confidence": "high"})
        + "\nResult: "
        + json.dumps({"summary": "keys on desk", "segments": []}),
        duration_ms=4000,
    )
    assert result.summary == "keys on desk"


def test_analysis_accepts_plain_visual_summary() -> None:
    result = parse_analysis(
        "Keys are visible on a desk next to a notebook.",
        duration_ms=4000,
    )
    assert result.summary == "Keys are visible on a desk next to a notebook."
    assert result.segments == ()


@pytest.mark.parametrize(
    "value",
    [
        json.dumps({"summary": "keys on desk"}),
        json.dumps({"segments": []}),
        "Metadata: " + json.dumps({"confidence": "high"}),
        json.dumps([]),
        json.dumps("visual summary"),
        json.dumps(42),
        json.dumps(True),
        json.dumps(None),
        'prefix {"summary":"keys","segments":',
        "[1,",
        '"unterminated',
    ],
)
def test_analysis_rejects_json_without_complete_contract(value: str) -> None:
    with pytest.raises(ContractError, match="analysis_output_fields_invalid"):
        parse_analysis(value, duration_ms=4000)


@pytest.mark.parametrize(
    "value",
    [
        "Narration: [inaudible]",
        "A person walks past [a red door].",
        "The display shows {offline}.",
        "A person walks past [1st floor].",
        "A person sees [true story].",
        "Status: {false alarm}.",
    ],
)
def test_analysis_accepts_plain_prose_with_brackets(value: str) -> None:
    result = parse_analysis(value, duration_ms=4000)
    assert result.summary == value
    assert result.segments == ()


def test_failure_code_serializes_to_api_value() -> None:
    assert FailureCode.OUTPUT_INVALID.value == "output_invalid"
