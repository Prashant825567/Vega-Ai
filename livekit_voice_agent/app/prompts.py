"""MAX v1 voice-first system prompt, voice normalization, and N-turn chat history trimmer."""

from __future__ import annotations

import re
from typing import Any, Dict, List

from pipecat.processors.aggregators.llm_context import LLMContext

VOICE_SYSTEM_PROMPT = (
    "You are Max v1.0, the ultra-fast real-time voice AI assistant for the Vega app. "
    "Reply in natural spoken Hinglish, Hindi, or English matching the user's language. "
    "Keep every answer concise (1 to 2 short sentences), warm, and directly speakable—no markdown, "
    "bullet points, asterisks, or emojis. End your first short clause with a period or question mark "
    "so streaming TTS begins speaking immediately."
)

SUPPORTED_FEMALE_VOICES = [
    "Aoede",
    "Kore",
    "Leda",
    "Zephyr",
    "Callirrhoe",
    "Despina",
    "Autonoe",
    "Erinome",
    "Laomedeia",
    "Pulcherrima",
    "Sulafat",
    "Vindemiatrix",
]


def normalize_voice_name(voice: str | None, default: str = "Aoede") -> str:
    """Resolve user-requested voice name against Gemini 2.5's smooth female voice list."""
    if not voice:
        return default
    cleaned = voice.strip().lower()
    for candidate in SUPPORTED_FEMALE_VOICES:
        if candidate.lower() == cleaned:
            return candidate
    return default


def clean_text_for_speech(text: str) -> str:
    """Strip markdown formatting or code blocks so TTS speaks natural prose."""
    if not text:
        return ""
    cleaned = re.sub(r"```[\s\S]*?```", " ", text)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"[*_~#>]+", " ", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def trim_openai_messages(
    messages: List[Dict[str, Any]], max_turns: int = 6
) -> List[Dict[str, Any]]:
    """Trim OpenAI-formatted messages list to system prompt + last `max_turns` turns."""
    if not messages:
        return [{"role": "system", "content": VOICE_SYSTEM_PROMPT}]

    system_msgs = [
        m
        for m in messages
        if isinstance(m, dict) and m.get("role") in ("system", "developer")
    ]
    non_system = [
        m
        for m in messages
        if isinstance(m, dict) and m.get("role") not in ("system", "developer")
    ]

    max_non_system = max(2, max_turns * 2)
    trimmed = non_system[-max_non_system:]
    while trimmed and trimmed[0].get("role") != "user":
        trimmed.pop(0)

    head = (
        [system_msgs[0]]
        if system_msgs
        else [{"role": "system", "content": VOICE_SYSTEM_PROMPT}]
    )
    return head + trimmed


def trim_pipecat_llm_context(context: LLMContext, max_turns: int = 6) -> List[Dict[str, Any]]:
    """Trim a Pipecat `LLMContext` in-place to the system prompt + last `max_turns` turns."""
    raw_messages = list(context.get_messages())
    normalized: List[Dict[str, Any]] = []
    for m in raw_messages:
        if isinstance(m, dict):
            role = "system" if m.get("role") == "developer" else str(m.get("role", "user"))
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

    trimmed = trim_openai_messages(normalized, max_turns=max_turns)
    context.set_messages(trimmed)
    return trimmed
