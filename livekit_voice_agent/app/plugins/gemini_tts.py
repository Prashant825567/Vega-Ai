"""Pipecat TTSService for Gemini 2.5 Native Audio (Replacing LiveKit TTS plugin).

Preserves the existing `models/gemini-2.5-flash-native-audio-preview-12-2025` (`BidiGenerateContent`
WebSocket) Text-to-Speech integration with `thinkingBudget=0` and default smooth female voice `Aoede`:
- Uses Pipecat's `TextAggregationMode.SENTENCE` so TTS begins immediately on the first LLM sentence.
- Streams 24kHz 16-bit mono PCM chunks as `TTSAudioRawFrame`s as soon as each chunk arrives.
- Supports immediate barge-in cancellation (`StartInterruptionFrame` / `CancelFrame`).
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import AsyncGenerator, List, Optional

import websockets
from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TextAggregationMode, TTSService

from app.config import Settings, settings
from app.latency import TurnLatencyTracker
from app.prompts import clean_text_for_speech, normalize_voice_name


class Gemini25NativeAudioTTSService(TTSService):
    """Pipecat TTSService streaming 24kHz PCM chunks from `gemini-2.5-flash-native-audio-preview-12-2025`."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
        voice_name: Optional[str] = None,
        sample_rate: Optional[int] = None,
        **kwargs,
    ) -> None:
        resolved_voice = normalize_voice_name(
            voice_name or app_settings.gemini_tts_voice, "Aoede"
        )
        super().__init__(
            text_aggregation_mode=TextAggregationMode.SENTENCE,
            push_text_frames=True,
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate or app_settings.tts_sample_rate,
            settings=TTSSettings(
                model=app_settings.gemini_tts_model,
                voice=resolved_voice,
                language=None,
            ),
            **kwargs,
        )
        self._cfg = app_settings
        self._tracker = latency_tracker
        self._voice = resolved_voice
        self._active_ws: Optional[websockets.ClientConnection] = None
        self._models: List[str] = []
        for m in (
            self._cfg.gemini_tts_model,
            "models/gemini-2.5-flash-native-audio-preview-12-2025",
            "models/gemini-2.5-flash-native-audio-latest",
            "models/gemini-3.1-flash-live-preview",
        ):
            clean = m.replace("models/", "").strip()
            if clean and f"models/{clean}" not in self._models:
                self._models.append(f"models/{clean}")

    def set_voice(self, voice_name: str) -> None:
        self._voice = normalize_voice_name(voice_name, self._voice)

    async def _close_active_ws(self) -> None:
        ws = self._active_ws
        self._active_ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    async def stop(self, frame: EndFrame) -> None:
        await self._close_active_ws()
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame) -> None:
        await self._close_active_ws()
        await super().cancel(frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, InterruptionFrame):
            await self._close_active_ws()
        await super().process_frame(frame, direction)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Synthesize a sentence via Gemini 2.5 Native Audio WebSocket and yield `TTSAudioRawFrame`s."""
        spoken_text = clean_text_for_speech(text)
        if not spoken_text:
            return

        if self._tracker:
            self._tracker.mark_tts_start(spoken_text)

        last_err: Optional[str] = None

        for full_model in self._models:
            chunks_yielded = 0
            try:
                api_key = self._cfg.next_google_api_key()
                ws_url = (
                    "wss://generativelanguage.googleapis.com/ws/"
                    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
                    f"?key={api_key}"
                )

                async with websockets.connect(
                    ws_url,
                    open_timeout=5.0,
                    close_timeout=1.0,
                    max_size=16 * 1024 * 1024,
                ) as ws:
                    self._active_ws = ws
                    setup_msg = {
                        "setup": {
                            "model": full_model,
                            "generationConfig": {
                                "responseModalities": ["AUDIO"],
                                "speechConfig": {
                                    "voiceConfig": {
                                        "prebuiltVoiceConfig": {
                                            "voiceName": self._voice,
                                        }
                                    }
                                },
                                **(
                                    {"thinkingConfig": {"thinkingBudget": 0}}
                                    if "native-audio" in full_model
                                    else {}
                                ),
                            },
                            "systemInstruction": {
                                "parts": [
                                    {
                                        "text": (
                                            "You are a professional, ultra-smooth, sweet, warm, and natural female voice artist. "
                                            "Read the user's provided text aloud verbatim, word for word, in the exact same "
                                            "language (Hinglish, Hindi, or English) with natural Indian flow. "
                                            "Never answer questions or add extra commentary—only speak the exact words provided."
                                        )
                                    }
                                ]
                            },
                        }
                    }
                    await ws.send(json.dumps(setup_msg))

                    setup_done = False
                    first_chunk_seen = False

                    while True:
                        recv_timeout = 0.32 if chunks_yielded > 0 else 8.0
                        try:
                            raw_msg = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
                        except asyncio.TimeoutError:
                            if chunks_yielded > 0:
                                break
                            raise

                        if isinstance(raw_msg, bytes):
                            raw_msg = raw_msg.decode("utf-8", errors="replace")
                        msg = json.loads(raw_msg)

                        if "error" in msg:
                            if chunks_yielded > 0:
                                break
                            raise RuntimeError(f"Gemini Live TTS error: {msg['error']}")

                        if "setupComplete" in msg and not setup_done:
                            setup_done = True
                            client_content = {
                                "clientContent": {
                                    "turns": [
                                        {
                                            "role": "user",
                                            "parts": [
                                                {
                                                    "text": (
                                                        "Please read the following text aloud verbatim, word for word, "
                                                        "in a smooth, sweet, warm, and natural voice without adding "
                                                        f"or changing any words:\n{spoken_text}"
                                                    )
                                                }
                                            ],
                                        }
                                    ],
                                    "turnComplete": True,
                                }
                            }
                            await ws.send(json.dumps(client_content))
                            continue

                        server_content = msg.get("serverContent") or {}
                        parts = (server_content.get("modelTurn") or {}).get("parts") or []
                        for part in parts:
                            b64_audio = (part.get("inlineData") or {}).get("data")
                            if b64_audio:
                                pcm_bytes = base64.b64decode(b64_audio)
                                if pcm_bytes:
                                    if not first_chunk_seen:
                                        first_chunk_seen = True
                                        await self.stop_ttfb_metrics()
                                        if self._tracker:
                                            self._tracker.mark_tts_first_audio()
                                        yield TTSStartedFrame(context_id=context_id)

                                    chunks_yielded += 1
                                    yield TTSAudioRawFrame(
                                        audio=pcm_bytes,
                                        sample_rate=self.sample_rate,
                                        num_channels=1,
                                        context_id=context_id,
                                    )

                        if (
                            server_content.get("generationComplete")
                            or server_content.get("turnComplete")
                        ) and chunks_yielded > 0:
                            break

                self._active_ws = None
                if chunks_yielded > 0:
                    yield TTSStoppedFrame(context_id=context_id)
                    return

            except asyncio.CancelledError:
                await self._close_active_ws()
                raise
            except Exception as exc:
                await self._close_active_ws()
                last_err = f"{full_model}: {exc}"
                logger.warning(f"Gemini25NativeAudioTTSService retry warning: {last_err}")
                continue

        if last_err:
            logger.error(f"All Gemini 2.5 Native Audio TTS models failed: {last_err}")
            yield ErrorFrame(error=f"TTS failed: {last_err}")


def create_gemini_tts(
    *,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
    voice_name: Optional[str] = None,
) -> Gemini25NativeAudioTTSService:
    """Create the Pipecat `Gemini25NativeAudioTTSService` instance."""
    return Gemini25NativeAudioTTSService(
        app_settings=app_settings,
        latency_tracker=latency_tracker,
        voice_name=voice_name or app_settings.gemini_tts_voice,
    )
