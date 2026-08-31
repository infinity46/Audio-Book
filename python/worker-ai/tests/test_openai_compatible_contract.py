"""Contract tests for `OpenAiCompatibleSemanticAnalyzer` against a mocked HTTP
transport -- never a real network call. This is the only place this adapter is
exercised at all in this test suite (see `openai_compatible.py`'s module docstring);
a deployment that actually wants LLM-backed analysis should be verified against its
real endpoint separately.
"""

from __future__ import annotations

import json

import httpx
import pytest

from worker_ai.semantic.deterministic import DeterministicSemanticAnalyzer
from worker_ai.semantic.openai_compatible import OpenAiCompatibleSemanticAnalyzer
from worker_ai.semantic.schemas import AnalyzeChapterInput, ParagraphInput, PriorContext
from workers_common.queue import TerminalJobError, TransientJobError


def _chapter_input() -> AnalyzeChapterInput:
    return AnalyzeChapterInput(
        chapter_id="ch1",
        book_id="book1",
        paragraphs=[ParagraphInput(id="p1", order_index=0, spine_position=0, text="Hello.")],
        prior_context=PriorContext(),
    )


def _chat_completion_body(content: str) -> dict[str, object]:
    return {"choices": [{"message": {"content": content}}]}


def _valid_result_json() -> str:
    payload = {
        "characters": [],
        "scenes": [],
        "relationships": [],
        "locations": [],
        "objects": [],
        "factions": [],
        "threads": [],
        "timeline_events": [],
        "pov_type": None,
    }
    return json.dumps(payload)


@pytest.mark.asyncio
async def test_valid_response_parses_into_chapter_analysis_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_completion_body(_valid_result_json()))

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    result = await analyzer.analyze_chapter(_chapter_input())
    assert result.characters == []
    assert result.scenes == []
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_invalid_json_retries_then_raises_terminal() -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(200, json=_chat_completion_body("not valid json at all"))

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    with pytest.raises(TerminalJobError) as exc_info:
        await analyzer.analyze_chapter(_chapter_input())
    assert exc_info.value.error_code == "INVALID_MODEL_OUTPUT"
    assert calls["count"] == 2  # bounded repair retry, not unbounded
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_second_attempt_succeeding_after_first_invalid_response() -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(200, json=_chat_completion_body("{not json"))
        return httpx.Response(200, json=_chat_completion_body(_valid_result_json()))

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    result = await analyzer.analyze_chapter(_chapter_input())
    assert result.scenes == []
    assert calls["count"] == 2
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_timeout_is_transient() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out")

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    with pytest.raises(TransientJobError) as exc_info:
        await analyzer.analyze_chapter(_chapter_input())
    assert exc_info.value.error_code == "MODEL_TIMEOUT"
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_unauthorized_is_terminal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    with pytest.raises(TerminalJobError) as exc_info:
        await analyzer.analyze_chapter(_chapter_input())
    assert exc_info.value.error_code == "MODEL_UNAUTHORIZED"
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_rate_limited_is_transient() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "slow down"})

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    with pytest.raises(TransientJobError) as exc_info:
        await analyzer.analyze_chapter(_chapter_input())
    assert exc_info.value.error_code == "QUOTA_EXCEEDED"
    await analyzer.aclose()


@pytest.mark.asyncio
async def test_server_error_is_transient() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, base_url="https://example.invalid")
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key="key", model_name="test-model", client=client
    )

    with pytest.raises(TransientJobError) as exc_info:
        await analyzer.analyze_chapter(_chapter_input())
    assert exc_info.value.error_code == "MODEL_UNAVAILABLE"
    await analyzer.aclose()


def test_model_identity_reflects_configured_model_name() -> None:
    analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://example.invalid", api_key=None, model_name="gpt-test"
    )
    identity = analyzer.model_identity
    assert identity.model_id == "gpt-test"
    assert identity.provider_id == "openai-compatible"


def test_deterministic_and_openai_compatible_share_the_same_protocol() -> None:
    """Domain code depends on `SemanticAnalyzer` only -- both concrete
    implementations must satisfy it structurally (task: "provider-independent
    semantic analysis abstraction")."""
    from worker_ai.semantic.analyzer import SemanticAnalyzer

    assert isinstance(DeterministicSemanticAnalyzer(), SemanticAnalyzer)
    openai_analyzer = OpenAiCompatibleSemanticAnalyzer(
        base_url="https://x.invalid", api_key=None, model_name="m"
    )
    assert isinstance(openai_analyzer, SemanticAnalyzer)
