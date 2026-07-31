from pathlib import Path
import subprocess

import pytest

from afterimage_mage_worker.contracts import AnalysisResult, ContractError, Segment
from afterimage_mage_worker.runtime import (
    MageRuntime,
    analysis_prompt,
    analysis_retry_prompt,
    analysis_windows,
    model_output_invalid_event,
    normalize_window_segments,
    offline_model_imports,
    parse_window_analysis_with_retry,
    sample_frame_indices,
)


def test_model_output_error_event_excludes_generated_content() -> None:
    assert model_output_invalid_event(ContractError("analysis_json_invalid")) == {
        "event": "model_output_invalid",
        "reason": "analysis_json_invalid",
    }


def test_analysis_prompt_requires_japanese_output() -> None:
    prompt = analysis_prompt(start_ms=1200, end_ms=3400, duration_ms=5000)
    assert "要約と各場面の説明" in prompt
    assert "すべて簡潔で事実に基づく日本語" in prompt
    assert "JSONやコードブロックではなく、自然文だけ" in prompt
    assert "5000ミリ秒" in prompt
    assert "1200ミリ秒から3400ミリ秒" in prompt


def test_analysis_retry_prompt_forbids_numeric_only_output_without_time_values() -> None:
    prompt = analysis_retry_prompt()
    assert "数値だけの回答" in prompt
    assert "一文以上" in prompt
    assert not any(character.isascii() and character.isdigit() for character in prompt)


def test_invalid_numeric_analysis_retries_once_with_narrative_output() -> None:
    retry_calls = 0

    def retry() -> str:
        nonlocal retry_calls
        retry_calls += 1
        return "作業場で人物が板を運んでいる。"

    result = parse_window_analysis_with_retry("0.5", 120000, retry)
    assert result.summary == "作業場で人物が板を運んでいる。"
    assert retry_calls == 1


def test_valid_analysis_does_not_retry_generation() -> None:
    def unexpected_retry() -> str:
        raise AssertionError("valid analysis must not retry")

    result = parse_window_analysis_with_retry(
        "作業場で人物が板を運んでいる。",
        120000,
        unexpected_retry,
    )
    assert result.summary == "作業場で人物が板を運んでいる。"


def test_retry_still_rejects_a_second_numeric_analysis() -> None:
    with pytest.raises(ContractError, match="analysis_output_fields_invalid"):
        parse_window_analysis_with_retry("0.5", 120000, lambda: "1.0")


def test_long_video_uses_bounded_sampled_windows() -> None:
    windows, mode = analysis_windows(3_600_000)
    assert mode == "sampled"
    assert len(windows) == 30
    assert windows[0].start_ms == 0
    assert windows[-1].end_ms == 3_600_000


def test_offline_model_ignores_only_optional_streaming_dependency() -> None:
    def missing_mamba(filename: str) -> list[str]:
        raise ImportError(f"{filename} requires mamba_ssm")

    assert offline_model_imports(
        "/models/streammind_gate.py",
        missing_mamba,
        lambda filename: [filename],
    ) == ["/models/streammind_gate.py"]
    with pytest.raises(ImportError):
        offline_model_imports(
            "/models/modeling_mage_vl.py",
            missing_mamba,
            lambda filename: [filename],
        )


def test_sample_frame_indices_include_decodable_window_boundaries() -> None:
    indices = sample_frame_indices(
        frame_count=900,
        duration_ms=30000,
        time_range_start_ms=0,
        time_range_end_ms=30000,
    )
    assert len(indices) == 32
    assert indices[0] == 0
    assert indices[-1] == 899


def test_normalizes_model_seconds_to_window_milliseconds() -> None:
    result = normalize_window_segments(
        AnalysisResult(
            summary="football commentary",
            segments=(
                Segment(start_ms=0, end_ms=4, caption="presenter"),
                Segment(start_ms=29, end_ms=31, caption="match"),
                Segment(start_ms=31, end_ms=32, caption="outlier"),
            ),
        ),
        window_duration_ms=30000,
    )
    assert result.segments == (
        Segment(start_ms=0, end_ms=4000, caption="presenter"),
        Segment(start_ms=29000, end_ms=30000, caption="match"),
    )


def test_ffmpeg_frame_and_clip_outputs(tmp_path: Path) -> None:
    source = tmp_path / "source.mov"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=10:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-y",
            str(source),
        ],
        check=True,
    )
    runtime = MageRuntime()
    frame = tmp_path / "frame.jpg"
    clip = tmp_path / "clip.mp4"
    runtime.frame(source, frame, 750)
    runtime.clip(source, clip, 500, 1500)
    assert frame.stat().st_size > 0
    assert clip.stat().st_size > 0
