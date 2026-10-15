"""Pipecat SegmentedSTTService for Gemini 3.1 Flash (Replacing LiveKit STT + StreamAdapter).

Preserves the existing Gemini 3.1 Flash (`gemini-3.1-flash-lite-preview` + fallback `gemini-3-flash-preview`)
Speech-to-Text API integration and `GOOGLE_API_KEY` / `GEMINI_API_KEY` configuration.
Upstream `VADProcessor(SileroVADAnalyzer)` emits `VADUserStartedSpeakingFrame` and
`VADUserStoppedSpeakingFrame`, which `SegmentedSTTService` buffers into a 16-bit mono WAV
container and passes into `run_stt(audio: bytes)`.
"""

from __future__ import annotations

import base64
from typing import AsyncGenerator, List, Optional

import httpx
from loguru import logger
from pipecat.frames.frames import CancelFrame, EndFrame, ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.utils.time import time_now_iso8601

from app.config import Settings, settings
from app.latency import TurnLatencyTracker


class GeminiFlashSTTService(SegmentedSTTService):
    """VAD-segmented Speech-to-Text service using Gemini 3.1 Flash."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
        sample_rate: Optional[int] = None,
        trailing_silence_secs: float = 0.15,
        **kwargs,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            trailing_silence_secs=trailing_silence_secs,
            settings=STTSettings(
                model=app_settings.gemini_stt_model,
                language=app_settings.stt_language,
            ),
            **kwargs,
        )
        self._cfg = app_settings
        self._tracker = latency_tracker

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

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._http.aclose()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        """Transcribe a VAD-segmented WAV buffer using Gemini 3.1 Flash."""
        if not audio or len(audio) < 600:
            return

        if self._tracker:
            self._tracker.mark_stt_start()

        await self.start_ttfb_metrics()
        await self.start_processing_metrics()

        b64_wav = base64.b64encode(audio).decode("ascii")
        lang = self._cfg.stt_language
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
                resp = await self._http.post(url, json=payload)
                if resp.status_code != 200:
                    last_err = f"{model_name} HTTP {resp.status_code}: {resp.text[:160]}"
                    continue

                data = resp.json()
                await self.stop_ttfb_metrics()
                candidates = data.get("candidates") or []
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts") or []
                    transcript = "".join(p.get("text", "") for p in parts).strip()
                break
            except Exception as exc:
                last_err = f"{model_name} error: {exc}"
                continue

        await self.stop_processing_metrics()

        if not transcript:
            if last_err:
                logger.warning(f"GeminiFlashSTTService warning: {last_err}")
                yield ErrorFrame(error=f"STT failed: {last_err}")
            return

        if self._tracker:
            self._tracker.mark_stt_done(transcript)

        yield TranscriptionFrame(
            transcript,
            self._user_id,
            time_now_iso8601(),
        )


def create_gemini_stt(
    *,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
) -> GeminiFlashSTTService:
    """Create the Pipecat `GeminiFlashSTTService` instance."""
    return GeminiFlashSTTService(
        app_settings=app_settings,
        latency_tracker=latency_tracker,
        trailing_silence_secs=0.15,
    )
