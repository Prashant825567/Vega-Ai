"""Short voice-first system prompt and chat history truncation for Max v1.0."""

from __future__ import annotations

import re
from typing import Any, Dict, List

from livekit.agents import llm

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
    """Resolve voice name against Gemini 2.5's smooth female voice list."""
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


def truncate_livekit_chat_ctx(chat_ctx: llm.ChatContext, max_turns: int = 6) -> llm.ChatContext:
    """Keep only the system prompt + last `max_turns` user/assistant turns in LiveKit ChatContext."""
    max_items = max(2, max_turns * 2)
    chat_ctx.truncate(max_items=max_items)
    return chat_ctx


def trim_openai_messages(
    messages: List[Dict[str, Any]], max_turns: int = 6
) -> List[Dict[str, Any]]:
    """Trim OpenAI-formatted messages list to system prompt + last `max_turns` turns."""
    if not messages:
        return [{"role": "system", "content": VOICE_SYSTEM_PROMPT}]

    system_msgs = [m for m in messages if m.get("role") in ("system", "developer")]
    non_system = [m for m in messages if m.get("role") not in ("system", "developer")]

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
