"""Pipecat LLMService for MiMo v2.6 Flash (Replacing LiveKit LLM plugin).

Preserves the existing MiMo v2.6 Flash (`mimo-v2.6-flash-free`) API integration:
1. OpenCode Gateway (`https://opencode.ai/inference/v1`):
   Uses `OpenCodeMiMoLLMService(LLMService)` which generates dynamic 48-bit inverted-timestamp
   session/request headers, attaches OpenCode's authentic tool schemas, streams SSE tokens
   as `LLMTextFrame`s so TTS starts on the first sentence, executes OpenCode's built-in
   `websearch` MCP tool with `"Ek second, abhi batata hoon. "` filler, trims chat history to
   the last N turns, and cancels in-flight streams immediately on barge-in (`StartInterruptionFrame`).
2. Standard OpenAI-Compatible Endpoint:
   Uses Pipecat's `OpenAILLMService(model=..., api_key=..., base_url=...)`.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.settings import LLMSettings

from app.config import Settings, settings
from app.latency import TurnLatencyTracker
from app.prompts import trim_openai_messages, trim_pipecat_llm_context

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
        for line in resp.text.strip().splitlines():
            candidate = line[6:].strip() if line.startswith("data: ") else line.strip()
            if candidate.startswith("{"):
                data = json.loads(candidate)
                for item in data.get("result", {}).get("content", []):
                    if isinstance(item.get("text"), str) and item["text"]:
                        return item["text"][:4000]
    except Exception as exc:
        logger.warning(f"OpenCode websearch error: {exc}")
    return f"Search completed for {query}."


class OpenCodeMiMoLLMService(LLMService):
    """Pipecat `LLMService` streaming tokens from MiMo v2.6 Flash (`mimo-v2.6-flash-free`)."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
        **kwargs,
    ) -> None:
        super().__init__(
            settings=LLMSettings(
                model=app_settings.mimo_model,
                system_instruction=None,
                temperature=app_settings.mimo_temperature,
                max_tokens=app_settings.mimo_max_tokens,
                top_p=None,
                top_k=None,
                frequency_penalty=None,
                presence_penalty=None,
                seed=None,
                filter_incomplete_user_turns=False,
                user_turn_completion_config=None,
            ),
            **kwargs,
        )
        self._cfg = app_settings
        self._tracker = latency_tracker
        self._session_id = _generate_opencode_id("ses")
        self._active_task: Optional[asyncio.Task] = None

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

    async def stop(self, frame: EndFrame) -> None:
        self._cancel_active_stream()
        await super().stop(frame)
        await self._http.aclose()

    async def cancel(self, frame: CancelFrame) -> None:
        self._cancel_active_stream()
        await super().cancel(frame)

    def _cancel_active_stream(self) -> None:
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
        self._active_task = None

    async def _stream_single_turn(
        self, messages: List[Dict[str, Any]], emit_tokens: bool = True
    ) -> tuple[str, List[Dict[str, Any]]]:
        """Stream one SSE turn from MiMo v2.6 Flash and push `LLMTextFrame`s downstream."""
        url = f"{self._cfg.mimo_base_url}/chat/completions"
        headers = _build_opencode_headers(self._cfg.mimo_api_key, self._session_id)
        payload: Dict[str, Any] = {
            "model": self._cfg.mimo_model,
            "messages": messages,
            "stream": True,
            "temperature": self._cfg.mimo_temperature,
            "max_tokens": self._cfg.mimo_max_tokens,
            "reasoning_effort": "none",
            "reasoning": {"enabled": False, "effort": "none"},
            "thinking": {"type": "disabled"},
            "tools": _OPENCODE_TOOLS,
            "tool_choice": "auto",
        }

        full_text = ""
        tool_calls_by_idx: Dict[int, Dict[str, Any]] = {}
        first_token_seen = False

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

                token = delta.get("content")
                if token:
                    if not first_token_seen:
                        first_token_seen = True
                        await self.stop_ttfb_metrics()
                        if self._tracker:
                            self._tracker.mark_llm_first_token(token)
                    full_text += token
                    if emit_tokens:
                        await self._push_llm_text(token)

                for tc in delta.get("tool_calls") or []:
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

    async def process_context_messages(self, messages: List[Dict[str, Any]]) -> str:
        """Execute a complete streaming turn (including optional `websearch` tool call)."""
        if self._tracker:
            self._tracker.mark_llm_start()

        await self.start_ttfb_metrics()
        trimmed = trim_openai_messages(messages, max_turns=self._cfg.max_history_turns)
        full_text, tool_calls = await self._stream_single_turn(trimmed, emit_tokens=True)

        if tool_calls:
            filler = "Ek second, abhi batata hoon. "
            await self._push_llm_text(filler)
            trimmed.append({"role": "assistant", "content": "", "tool_calls": tool_calls})
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

                trimmed.append(
                    {"role": "tool", "tool_call_id": tc["id"], "content": result}
                )

            second_text, _ = await self._stream_single_turn(trimmed, emit_tokens=True)
            full_text = f"{filler}{second_text}".strip()

        return full_text

    async def _process_context(self, context: LLMContext) -> None:
        messages = trim_pipecat_llm_context(
            context, max_turns=self._cfg.max_history_turns
        )
        await self.process_context_messages(messages)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InterruptionFrame):
            self._cancel_active_stream()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMContextFrame):
            self._cancel_active_stream()
            try:
                await self.push_frame(LLMFullResponseStartFrame())
                await self.start_processing_metrics()
                self._active_task = asyncio.current_task()
                await self._process_context(frame.context)
            except asyncio.CancelledError:
                logger.info("OpenCodeMiMoLLMService stream cancelled due to barge-in interruption.")
                raise
            except Exception as exc:
                await self.push_error(error_msg=f"MiMo LLM error: {exc}", exception=exc)
            finally:
                self._active_task = None
                await self.stop_processing_metrics()
                await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)


def create_mimo_llm(
    *,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
) -> LLMService:
    """Create the Pipecat LLMService for MiMo v2.6 Flash."""
    if app_settings.is_opencode_gateway:
        logger.info(
            f"Using OpenCodeMiMoLLMService ({app_settings.mimo_model}) -> {app_settings.mimo_base_url}"
        )
        return OpenCodeMiMoLLMService(
            app_settings=app_settings,
            latency_tracker=latency_tracker,
        )

    logger.info(
        f"Using Pipecat OpenAILLMService ({app_settings.mimo_model}) -> {app_settings.mimo_base_url}"
    )
    return OpenAILLMService(
        model=app_settings.mimo_model,
        api_key=app_settings.mimo_api_key,
        base_url=app_settings.mimo_base_url,
    )
