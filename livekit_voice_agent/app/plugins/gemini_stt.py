"""Custom LiveKit STT plugin for Gemini 3.1 Flash using Silero VAD + StreamAdapter.

Why a custom STT class?
- `livekit.plugins.google.STT` uses Google Cloud Speech-to-Text (`cloud_speech_v2`), which
  requires GCP Service Account credentials (`GOOGLE_APPLICATION_CREDENTIALS`).
- `livekit.plugins.google.beta.GeminiSTT` only accepts Live models (`gemini-3.5-transcribe-live`)
  and rejects standard Gemini Flash models (`gemini-3.1-flash-lite-preview`).
- `GeminiFlashSTT` accepts VAD-segmented audio buffers via `stt.StreamAdapter(stt=..., vad=...)`
  and transcribes them with `gemini-3.1-flash-lite-preview` (with fallback to `gemini-3-flash-preview`)
  using your `GOOGLE_API_KEY`.
"""

from __future__ import annotations

import base64
from typing import List, Optional

import httpx
from livekit.agents import APIConnectOptions, LanguageCode, stt, utils, vad
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr
from loguru import logger

from app.config import Settings, settings
from app.latency import TurnLatencyTracker


class GeminiFlashSTT(stt.STT):
    """Non-streaming Gemini 3.1 Flash STT designed to be wrapped with `stt.StreamAdapter` + Silero VAD."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
        language: str = "hi-IN",
    ) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(
                streaming=False,
                interim_results=False,
            )
        )
        self._cfg = app_settings
        self._tracker = latency_tracker
        self._language = language or self._cfg.stt_language
        try:
            import h2 as _h2  # noqa: F401
            use_http2 = True
        except ImportError:
            use_http2 = False

        self._http = httpx.AsyncClient(
            http2=use_http2,
            timeout=httpx.Timeout(12.0, connect=4.0),
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )
        self._models: List[str] = []
        for m in (
            self._cfg.gemini_stt_model,
            self._cfg.gemini_stt_fallback_model,
            "gemini-3.1-flash-lite-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-flash-lite",
        ):
            clean = m.replace("models/", "").strip()
            if clean and clean not in self._models:
                self._models.append(clean)

    @property
    def model(self) -> str:
        return self._models[0]

    @property
    def provider(self) -> str:
        return "google-gemini-flash"

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _recognize_impl(
        self,
        buffer: utils.AudioBuffer,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> stt.SpeechEvent:
        """Convert Silero VAD-segmented AudioBuffer to WAV and transcribe with Gemini 3.1 Flash."""
        if self._tracker:
            self._tracker.mark_stt_start()

        merged_frame = utils.merge_frames(buffer)
        wav_bytes = merged_frame.to_wav_bytes()

        lang = language if isinstance(language, str) and language else self._language
        b64_wav = base64.b64encode(wav_bytes).decode("ascii")

        prompt = (
            "Transcribe this spoken audio accurately into plain text. "
            f"Primary languages: {lang}, Hinglish (Hindi in Latin script), Hindi, or English. "
            "Return ONLY the exact words spoken with no extra labels, quotes, or commentary. "
            "If the audio contains only silence or noise, return an empty string."
        )

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        {
                            "inline_data": {
                                "mime_type": "audio/wav",
                                "data": b64_wav,
                            }
                        },
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 128,
            },
        }

        transcript = ""
        last_err: Optional[str] = None

        for model_name in self._models:
            try:
                api_key = self._cfg.next_google_api_key()
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model_name}:generateContent?key={api_key}"
                )
                resp = await self._http.post(
                    url,
                    json=payload,
                    timeout=conn_options.timeout if conn_options else 10.0,
                )
                if resp.status_code != 200:
                    last_err = f"{model_name} HTTP {resp.status_code}: {resp.text[:160]}"
                    continue

                data = resp.json()
                candidates = data.get("candidates") or []
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts") or []
                    transcript = "".join(p.get("text", "") for p in parts).strip()
                break
            except Exception as exc:
                last_err = f"{model_name} error: {exc}"
                continue

        if not transcript and last_err:
            logger.warning(f"GeminiFlashSTT warning: {last_err}")

        if self._tracker and transcript:
            self._tracker.mark_stt_done(transcript)

        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            request_id=utils.shortuuid(),
            alternatives=[
                stt.SpeechData(
                    language=LanguageCode(lang),
                    text=transcript,
                    confidence=1.0 if transcript else 0.0,
                )
            ],
        )


def create_gemini_stt(
    *,
    silero_vad: vad.VAD,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
) -> stt.StreamAdapter:
    """Create a streaming-compatible Gemini 3.1 Flash STT wrapped in LiveKit's `stt.StreamAdapter`."""
    base_stt = GeminiFlashSTT(
        app_settings=app_settings,
        latency_tracker=latency_tracker,
        language=app_settings.stt_language,
    )
    return stt.StreamAdapter(stt=base_stt, vad=silero_vad)
