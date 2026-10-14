"""Centralized .env configuration for Max v1.0 LiveKit Voice Agent."""

from __future__ import annotations

import itertools
import os
from dataclasses import dataclass, field
from typing import List

from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()


def _parse_csv(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    # 1. LiveKit Credentials
    livekit_url: str = field(
        default_factory=lambda: os.getenv("LIVEKIT_URL", "").strip()
    )
    livekit_api_key: str = field(
        default_factory=lambda: os.getenv("LIVEKIT_API_KEY", "").strip()
    )
    livekit_api_secret: str = field(
        default_factory=lambda: os.getenv("LIVEKIT_API_SECRET", "").strip()
    )
    livekit_agent_name: str = field(
        default_factory=lambda: os.getenv("LIVEKIT_AGENT_NAME", "vega-max-v1").strip()
    )

    # 2. Google AI Studio API Key(s) (STT + TTS)
    google_api_keys: List[str] = field(
        default_factory=lambda: _parse_csv(
            os.getenv("GOOGLE_API_KEY")
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_AI_STUDIO_API_KEY")
            or ""
        )
    )

    # 3. STT (Gemini 3.1 Flash)
    gemini_stt_model: str = field(
        default_factory=lambda: os.getenv(
            "GEMINI_STT_MODEL", "gemini-3.1-flash-lite-preview"
        ).strip()
    )
    gemini_stt_fallback_model: str = field(
        default_factory=lambda: os.getenv(
            "GEMINI_STT_FALLBACK_MODEL", "gemini-3-flash-preview"
        ).strip()
    )
    stt_language: str = field(
        default_factory=lambda: os.getenv("STT_LANGUAGE", "hi-IN").strip()
    )

    # 4. LLM (MiMo 2.6 Flash — OpenCode or Standard OpenAI-Compatible Endpoint)
    mimo_base_url: str = field(
        default_factory=lambda: (
            os.getenv("MIMO_BASE_URL")
            or os.getenv("LLM_BASE_URL")
            or "https://opencode.ai/inference/v1"
        )
        .strip()
        .rstrip("/")
    )
    mimo_api_key: str = field(
        default_factory=lambda: (
            os.getenv("MIMO_API_KEY")
            or os.getenv("OPENCODE_API_KEY")
            or os.getenv("LLM_API_KEY")
            or "public"
        ).strip()
    )
    mimo_model: str = field(
        default_factory=lambda: (
            os.getenv("MIMO_MODEL") or os.getenv("LLM_MODEL") or "mimo-v2.6-flash-free"
        ).strip()
    )
    mimo_max_tokens: int = field(
        default_factory=lambda: int(os.getenv("MIMO_MAX_TOKENS", "180"))
    )
    mimo_temperature: float = field(
        default_factory=lambda: float(os.getenv("MIMO_TEMPERATURE", "0.6"))
    )
    max_history_turns: int = field(
        default_factory=lambda: max(1, int(os.getenv("MAX_HISTORY_TURNS", "6")))
    )

    # 5. TTS (Gemini 2.5 Audio Model)
    gemini_tts_model: str = field(
        default_factory=lambda: os.getenv(
            "GEMINI_TTS_MODEL", "models/gemini-2.5-flash-native-audio-preview-12-2025"
        ).strip()
    )
    gemini_tts_voice: str = field(
        default_factory=lambda: os.getenv("GEMINI_TTS_VOICE", "Aoede").strip()
    )
    tts_sample_rate: int = field(
        default_factory=lambda: int(os.getenv("TTS_SAMPLE_RATE", "24000"))
    )

    # 6. Silero VAD & Turn Detection / Interruption (Barge-In)
    vad_min_speech_duration: float = field(
        default_factory=lambda: float(os.getenv("VAD_MIN_SPEECH_DURATION", "0.05"))
    )
    vad_min_silence_duration: float = field(
        default_factory=lambda: float(os.getenv("VAD_MIN_SILENCE_DURATION", "0.35"))
    )
    vad_activation_threshold: float = field(
        default_factory=lambda: float(os.getenv("VAD_ACTIVATION_THRESHOLD", "0.50"))
    )
    min_endpointing_delay: float = field(
        default_factory=lambda: float(os.getenv("MIN_ENDPOINTING_DELAY", "0.35"))
    )
    max_endpointing_delay: float = field(
        default_factory=lambda: float(os.getenv("MAX_ENDPOINTING_DELAY", "1.50"))
    )
    min_interruption_duration: float = field(
        default_factory=lambda: float(os.getenv("MIN_INTERRUPTION_DURATION", "0.25"))
    )
    allow_interruptions: bool = field(
        default_factory=lambda: os.getenv("ALLOW_INTERRUPTIONS", "true").lower()
        in ("1", "true", "yes")
    )

    # 7. FastAPI Server
    host: str = field(default_factory=lambda: os.getenv("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8000")))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))

    def __post_init__(self) -> None:
        self._key_cycle = (
            itertools.cycle(self.google_api_keys) if self.google_api_keys else None
        )
        # Ensure GOOGLE_API_KEY is exported in os.environ for LiveKit plugins if configured
        if self.google_api_keys and not os.environ.get("GOOGLE_API_KEY"):
            os.environ["GOOGLE_API_KEY"] = self.google_api_keys[0]

    def next_google_api_key(self) -> str:
        """Round-robin across configured GOOGLE_API_KEY values."""
        if not self._key_cycle:
            raise RuntimeError(
                "GOOGLE_API_KEY is not set in environment or .env file."
            )
        return next(self._key_cycle)

    @property
    def is_opencode_gateway(self) -> bool:
        """Return True if MIMO_BASE_URL points to OpenCode's inference gateway."""
        return "opencode.ai" in self.mimo_base_url.lower()


settings = Settings()
