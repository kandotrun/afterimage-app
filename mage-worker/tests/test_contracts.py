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


def test_failure_code_serializes_to_api_value() -> None:
    assert FailureCode.OUTPUT_INVALID.value == "output_invalid"
