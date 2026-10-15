"""Centralized .env configuration for MAX v1 Voice Agent (Pipecat + SmallWebRTC)."""

from __future__ import annotations

import hashlib
import hmac
import itertools
import json
import os
import secrets
import time
import base64
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from pipecat.transports.smallwebrtc.connection import IceServer

load_dotenv()


def _parse_csv(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    # 1. Server & Session Security
    host: str = field(default_factory=lambda: os.getenv("HOST", "0.0.0.0").strip())
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8000")))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO").strip())
    session_secret: str = field(
        default_factory=lambda: (
            os.getenv("SESSION_SECRET", "").strip() or secrets.token_hex(32)
        )
    )
    session_ttl_minutes: int = field(
        default_factory=lambda: max(5, int(os.getenv("SESSION_TTL_MINUTES", "60")))
    )

    # 2. SmallWebRTC STUN / TURN ICE Servers
    stun_server_urls: List[str] = field(
        default_factory=lambda: _parse_csv(
            os.getenv(
                "STUN_SERVER_URLS",
                "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302",
            )
        )
    )
    turn_server_url: str = field(
        default_factory=lambda: os.getenv("TURN_SERVER_URL", "").strip()
    )
    turn_username: str = field(
        default_factory=lambda: os.getenv("TURN_USERNAME", "").strip()
    )
    turn_credential: str = field(
        default_factory=lambda: os.getenv("TURN_CREDENTIAL", "").strip()
    )

    # 3. Existing Google / Gemini API Keys (Preserved for STT & TTS)
    google_api_keys: List[str] = field(
        default_factory=lambda: _parse_csv(
            os.getenv("GOOGLE_API_KEY")
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_AI_STUDIO_API_KEY")
            or ""
        )
    )

    # 4. Existing STT Configuration (Gemini 3.1 Flash)
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

    # 5. Existing LLM Configuration (MiMo v2.6 Flash API)
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

    # 6. Existing TTS Configuration (Gemini 2.5 Native Audio Streaming Model)
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

    # 7. Silero VAD & Barge-In Interruption Settings
    vad_min_speech_duration: float = field(
        default_factory=lambda: float(os.getenv("VAD_MIN_SPEECH_DURATION", "0.05"))
    )
    vad_min_silence_duration: float = field(
        default_factory=lambda: float(os.getenv("VAD_MIN_SILENCE_DURATION", "0.35"))
    )
    vad_activation_threshold: float = field(
        default_factory=lambda: float(os.getenv("VAD_ACTIVATION_THRESHOLD", "0.50"))
    )
    vad_min_volume: float = field(
        default_factory=lambda: float(os.getenv("VAD_MIN_VOLUME", "0.60"))
    )
    allow_interruptions: bool = field(
        default_factory=lambda: os.getenv("ALLOW_INTERRUPTIONS", "true").lower()
        in ("1", "true", "yes")
    )

    def __post_init__(self) -> None:
        self._key_cycle = (
            itertools.cycle(self.google_api_keys) if self.google_api_keys else None
        )
        if self.google_api_keys and not os.environ.get("GOOGLE_API_KEY"):
            os.environ["GOOGLE_API_KEY"] = self.google_api_keys[0]

    def next_google_api_key(self) -> str:
        """Round-robin across configured GOOGLE_API_KEY / GEMINI_API_KEY values."""
        if not self._key_cycle:
            raise RuntimeError(
                "GOOGLE_API_KEY (or GEMINI_API_KEY) is not set in environment or .env file."
            )
        return next(self._key_cycle)

    @property
    def is_opencode_gateway(self) -> bool:
        return "opencode.ai" in self.mimo_base_url.lower()

    def build_ice_servers(self) -> List[IceServer]:
        """Build Pipecat SmallWebRTC `IceServer` list from STUN/TURN settings."""
        servers: List[IceServer] = []
        for url in self.stun_server_urls:
            servers.append(IceServer(urls=url))
        if self.turn_server_url:
            servers.append(
                IceServer(
                    urls=self.turn_server_url,
                    username=self.turn_username or None,
                    credential=self.turn_credential or None,
                )
            )
        return servers

    def get_client_ice_servers(self) -> List[Dict[str, Any]]:
        """Return WebRTC `RTCIceServer` dictionaries formatted for the frontend client."""
        ice_list: List[Dict[str, Any]] = []
        if self.stun_server_urls:
            ice_list.append({"urls": self.stun_server_urls})
        if self.turn_server_url:
            turn_entry: Dict[str, Any] = {"urls": [self.turn_server_url]}
            if self.turn_username:
                turn_entry["username"] = self.turn_username
            if self.turn_credential:
                turn_entry["credential"] = self.turn_credential
            ice_list.append(turn_entry)
        return ice_list

    def create_session_token(
        self,
        *,
        session_id: str,
        participant_name: str,
        voice: str,
        ttl_minutes: Optional[int] = None,
    ) -> tuple[str, int]:
        """Create an HMAC-SHA256 signed session token (zero LiveKit dependency)."""
        ttl = ttl_minutes or self.session_ttl_minutes
        exp = int(time.time() + ttl * 60)
        payload = {
            "sid": session_id,
            "name": participant_name,
            "voice": voice,
            "exp": exp,
        }
        payload_b64 = (
            base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
            .decode()
            .rstrip("=")
        )
        sig = hmac.new(
            self.session_secret.encode(), payload_b64.encode(), hashlib.sha256
        ).hexdigest()
        return f"{payload_b64}.{sig}", exp

    def verify_session_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Verify an HMAC-SHA256 signed session token and return its payload if valid."""
        if not token or "." not in token:
            return None
        try:
            payload_b64, sig = token.split(".", 1)
            expected = hmac.new(
                self.session_secret.encode(), payload_b64.encode(), hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(sig, expected):
                return None
            padded = payload_b64 + "=" * (-len(payload_b64) % 4)
            data = json.loads(base64.urlsafe_b64decode(padded).decode())
            if int(data.get("exp", 0)) < int(time.time()):
                return None
            return data
        except Exception:
            return None


settings = Settings()
