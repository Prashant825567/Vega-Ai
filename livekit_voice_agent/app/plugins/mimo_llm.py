"""MiMo 2.6 Flash LLM plugin for LiveKit Agents (OpenAI plugin + Custom OpenCode Streaming LLM).

Supports two modes automatically based on `MIMO_BASE_URL` in `.env`:
1. OpenCode Zen/Inference Gateway (`https://opencode.ai/inference/v1`):
   Uses `OpenCodeMiMoLLM(llm.LLM)` which injects OpenCode CLI's dynamic 48-bit inverted-timestamp
   session/request headers, authentic tool schemas, and built-in `websearch` MCP execution.
2. Standard OpenAI-Compatible Endpoint:
   Uses `livekit.plugins.openai.LLM(model=..., api_key=..., base_url=...)`.
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from livekit.agents import APIConnectOptions, llm, utils
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr
from livekit.plugins import openai as lk_openai
from loguru import logger

from app.config import Settings, settings
from app.latency import TurnLatencyTracker
from app.prompts import (
    VOICE_SYSTEM_PROMPT,
    trim_openai_messages,
    truncate_livekit_chat_ctx,
)

_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_TOOLS_PATH = Path(__file__).with_name("opencode_tools.json")
_OPENCODE_TOOLS: List[Dict[str, Any]] = (
    json.loads(_TOOLS_PATH.read_text("utf-8")) if _TOOLS_PATH.exists() else []
)


def _generate_opencode_id(prefix: str) -> str:
    """Generate an OpenCode CLI compatible ID (`ses_...` or `msg_...`) with 48-bit inverted timestamp."""
    scaled = int(time.time() * 1000) * 0x1000
    inverted = (~scaled) & 0xFFFFFFFFFFFF
    hex_part = f"{inverted:012x}"
    rand_part = "".join(secrets.choice(_BASE62) for _ in range(14))
    return f"{prefix}_{hex_part}{rand_part}"


def _build_opencode_headers(api_key: str, session_id: str) -> Dict[str, str]:
    req_id = _generate_opencode_id("msg")
    return {
        "Authorization": f"Bearer {api_key or 'public'}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
        "x-opencode-client": "cli",
        "x-opencode-project": "a070fc6ab60b2140452f8e06012ae52a1ed73781",
        "x-opencode-session": session_id,
        "x-opencode-session-id": session_id,
        "x-opencode-request": req_id,
    }


async def _execute_opencode_websearch(
    http_client: httpx.AsyncClient, query: str, session_id: str, model_name: str
) -> str:
    """Execute OpenCode's built-in Parallel MCP web search (`https://search.parallel.ai/mcp`)."""
    if not query.strip():
        return "No search query provided."
    try:
        resp = await http_client.post(
            "https://search.parallel.ai/mcp",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "User-Agent": "opencode/1.19.0",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "web_search",
                    "arguments": {
                        "objective": query,
                        "search_queries": [query],
                        "session_id": session_id,
                        "model_name": model_name,
                    },
                },
            },
            timeout=10.0,
        )
        raw = resp.text.strip()
        for line in raw.splitlines():
            candidate = line[6:].strip() if line.startswith("data: ") else line.strip()
            if candidate.startswith("{"):
                data = json.loads(candidate)
                content = data.get("result", {}).get("content", [])
                for item in content:
                    if isinstance(item.get("text"), str) and item["text"]:
                        return item["text"][:4000]
    except Exception as exc:
        logger.warning(f"OpenCode websearch error: {exc}")
    return f"Search completed for {query}."


class OpenCodeMiMoLLM(llm.LLM):
    """Custom LiveKit `llm.LLM` for MiMo 2.6 Flash (`mimo-v2.6-flash-free`) via OpenCode."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
    ) -> None:
        super().__init__()
        self._cfg = app_settings
        self._tracker = latency_tracker
        self._session_id = _generate_opencode_id("ses")
        try:
            import h2 as _h2  # noqa: F401
            use_http2 = True
        except ImportError:
            use_http2 = False

        self._http = httpx.AsyncClient(
            http2=use_http2,
            timeout=httpx.Timeout(25.0, connect=5.0),
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )

    @property
    def model(self) -> str:
        return self._cfg.mimo_model

    @property
    def provider(self) -> str:
        return "opencode-mimo"

    async def aclose(self) -> None:
        await self._http.aclose()

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        return OpenCodeMiMoLLMStream(
            self,
            chat_ctx=chat_ctx,
            tools=tools or [],
            conn_options=conn_options,
            app_settings=self._cfg,
            http_client=self._http,
            session_id=self._session_id,
            latency_tracker=self._tracker,
        )


class OpenCodeMiMoLLMStream(llm.LLMStream):
    """Streaming SSE response handler for MiMo 2.6 Flash with first-sentence TTS & barge-in support."""

    def __init__(
        self,
        llm_instance: OpenCodeMiMoLLM,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        conn_options: APIConnectOptions,
        app_settings: Settings,
        http_client: httpx.AsyncClient,
        session_id: str,
        latency_tracker: Optional[TurnLatencyTracker] = None,
    ) -> None:
        super().__init__(
            llm_instance,
            chat_ctx=chat_ctx,
            tools=tools,
            conn_options=conn_options,
        )
        self._cfg = app_settings
        self._http = http_client
        self._session_id = session_id
        self._tracker = latency_tracker

    def _extract_openai_messages(self) -> List[Dict[str, Any]]:
        """Convert LiveKit ChatContext into trimmed OpenAI messages (last N turns)."""
        truncate_livekit_chat_ctx(self._chat_ctx, self._cfg.max_history_turns)
        provider_msgs, _ = self._chat_ctx.to_provider_format(format="openai")
        normalized: List[Dict[str, Any]] = []
        for m in provider_msgs:
            role = m.get("role", "user")
            if role == "developer":
                role = "system"
            content = m.get("content", "")
            if isinstance(content, list):
                text_parts = [
                    p.get("text", "")
                    for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                content = " ".join(t for t in text_parts if t).strip()
            if content:
                normalized.append({"role": role, "content": str(content)})

        return trim_openai_messages(normalized, max_turns=self._cfg.max_history_turns)

    async def _stream_single_turn(
        self, messages: List[Dict[str, Any]], emit_tokens: bool = True
    ) -> tuple[str, List[Dict[str, Any]]]:
        """Stream one SSE completion turn from OpenCode MiMo 2.6 Flash."""
        url = f"{self._cfg.mimo_base_url}/chat/completions"
        headers = _build_opencode_headers(self._cfg.mimo_api_key, self._session_id)

        payload: Dict[str, Any] = {
            "model": self._cfg.mimo_model,
            "messages": messages,
            "stream": True,
            "temperature": self._cfg.mimo_temperature,
            "max_tokens": self._cfg.mimo_max_tokens,
            "reasoning_effort": "none",
            "thinking": {"type": "disabled"},
            "tools": _OPENCODE_TOOLS,
            "tool_choice": "auto",
        }

        full_text = ""
        tool_calls_by_idx: Dict[int, Dict[str, Any]] = {}
        first_token_seen = False
        req_id = utils.shortuuid()

        async with self._http.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", errors="replace")
                raise RuntimeError(f"MiMo 2.6 HTTP {resp.status_code}: {body[:200]}")

            async for raw_line in resp.aiter_lines():
                line = raw_line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # 1. Stream text tokens immediately so TTS starts on the first sentence
                token = delta.get("content")
                if token:
                    if not first_token_seen:
                        first_token_seen = True
                        if self._tracker:
                            self._tracker.mark_llm_first_token(token)
                    full_text += token
                    if emit_tokens:
                        self._event_ch.send_nowait(
                            llm.ChatChunk(
                                id=req_id,
                                delta=llm.ChoiceDelta(
                                    role="assistant",
                                    content=token,
                                ),
                            )
                        )

                # 2. Collect tool_calls if MiMo invokes `websearch`
                tc_deltas = delta.get("tool_calls") or []
                for tc in tc_deltas:
                    idx = tc.get("index", 0)
                    entry = tool_calls_by_idx.setdefault(
                        idx,
                        {
                            "id": tc.get("id") or f"call_{idx}",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tc.get("id"):
                        entry["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        entry["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        entry["function"]["arguments"] += fn["arguments"]

        return full_text, list(tool_calls_by_idx.values())

    async def _run(self) -> None:
        if self._tracker:
            self._tracker.mark_llm_start()

        messages = self._extract_openai_messages()
        _, tool_calls = await self._stream_single_turn(messages, emit_tokens=True)

        # If MiMo 2.6 Flash decided to run `websearch`, speak filler immediately and fetch live results
        if tool_calls:
            filler_id = utils.shortuuid()
            self._event_ch.send_nowait(
                llm.ChatChunk(
                    id=filler_id,
                    delta=llm.ChoiceDelta(
                        role="assistant",
                        content="Ek second, abhi batata hoon. ",
                    ),
                )
            )
            messages.append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": tool_calls,
                }
            )
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}

                if fn_name == "websearch":
                    query = str(args.get("query") or "")
                    logger.info(f"MiMo 2.6 executing OpenCode websearch: {query!r}")
                    result = await _execute_opencode_websearch(
                        self._http, query, self._session_id, self._cfg.mimo_model
                    )
                else:
                    result = "Tool not required in voice mode."

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    }
                )

            await self._stream_single_turn(messages, emit_tokens=True)


def create_mimo_llm(
    *,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
) -> llm.LLM:
    """Create the MiMo 2.6 Flash LLM instance.

    - Uses `OpenCodeMiMoLLM` when `MIMO_BASE_URL` points to `opencode.ai` (handles dynamic CLI headers & tools).
    - Uses `livekit.plugins.openai.LLM` when pointed at any standard OpenAI-compatible base URL.
    """
    if app_settings.is_opencode_gateway:
        logger.info(
            f"Using OpenCodeMiMoLLM ({app_settings.mimo_model}) -> {app_settings.mimo_base_url}"
        )
        return OpenCodeMiMoLLM(
            app_settings=app_settings,
            latency_tracker=latency_tracker,
        )

    logger.info(
        f"Using livekit.plugins.openai.LLM ({app_settings.mimo_model}) -> {app_settings.mimo_base_url}"
    )
    return lk_openai.LLM(
        model=app_settings.mimo_model,
        api_key=app_settings.mimo_api_key,
        base_url=app_settings.mimo_base_url,
        temperature=app_settings.mimo_temperature,
        max_completion_tokens=app_settings.mimo_max_tokens,
    )
