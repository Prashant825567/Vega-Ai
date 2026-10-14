"""Gemini 2.5 Audio TTS plugin for LiveKit Agents.

Why both a custom `Gemini25NativeAudioTTS` and `livekit.plugins.google.beta.GeminiTTS`?
1. `livekit.plugins.google.TTS` uses Google Cloud Text-to-Speech (`google-cloud-texttospeech`),
   which requires GCP Service Account credentials (`GOOGLE_APPLICATION_CREDENTIALS`).
2. `livekit.plugins.google.beta.GeminiTTS` uses `generate_content_stream` (`gemini-2.5-flash-preview-tts`),
   which has a strict 10 requests/day Free Tier quota on Google AI Studio and does not support
   `models/gemini-2.5-flash-native-audio-preview-12-2025`.
3. `Gemini25NativeAudioTTS` connects directly to `models/gemini-2.5-flash-native-audio-preview-12-2025`
   over Google's `BidiGenerateContent` WebSocket with `thinkingBudget=0` and default voice `Aoede`,
   streaming 24kHz PCM audio chunks into LiveKit's `AudioEmitter` as each chunk arrives!
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import List, Optional

import websockets
from livekit.agents import APIConnectOptions, tts, utils
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.plugins.google import beta as google_beta
from loguru import logger

from app.config import Settings, settings
from app.latency import TurnLatencyTracker
from app.prompts import clean_text_for_speech, normalize_voice_name


class Gemini25NativeAudioTTS(tts.TTS):
    """Custom LiveKit TTS streaming 24kHz PCM chunks from `gemini-2.5-flash-native-audio-preview-12-2025`."""

    def __init__(
        self,
        *,
        app_settings: Settings = settings,
        latency_tracker: Optional[TurnLatencyTracker] = None,
        voice_name: Optional[str] = None,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=app_settings.tts_sample_rate,
            num_channels=1,
        )
        self._cfg = app_settings
        self._tracker = latency_tracker
        self._voice = normalize_voice_name(voice_name or self._cfg.gemini_tts_voice, "Aoede")
        self._models: List[str] = []
        for m in (
            self._cfg.gemini_tts_model,
            "models/gemini-2.5-flash-native-audio-preview-12-2025",
            "models/gemini-2.5-flash-native-audio-latest",
            "models/gemini-3.1-flash-live-preview",
        ):
            clean = m.replace("models/", "").strip()
            if clean:
                full = f"models/{clean}"
                if full not in self._models:
                    self._models.append(full)

    @property
    def model(self) -> str:
        return self._models[0]

    @property
    def provider(self) -> str:
        return "gemini-live-native-audio"

    def update_options(self, *, voice_name: Optional[str] = None) -> None:
        if voice_name:
            self._voice = normalize_voice_name(voice_name, self._voice)

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> tts.ChunkedStream:
        return Gemini25NativeAudioChunkedStream(
            tts=self,
            input_text=text,
            conn_options=conn_options,
            app_settings=self._cfg,
            models=self._models,
            voice_name=self._voice,
            latency_tracker=self._tracker,
        )


class Gemini25NativeAudioChunkedStream(tts.ChunkedStream):
    """Streams 24kHz 16-bit mono PCM chunks from `BidiGenerateContent` WebSocket into LiveKit."""

    def __init__(
        self,
        *,
        tts: Gemini25NativeAudioTTS,
        input_text: str,
        conn_options: APIConnectOptions,
        app_settings: Settings,
        models: List[str],
        voice_name: str,
        latency_tracker: Optional[TurnLatencyTracker] = None,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._cfg = app_settings
        self._models = models
        self._voice = voice_name
        self._tracker = latency_tracker

    async def _stream_from_model(
        self,
        full_model: str,
        api_key: str,
        spoken_text: str,
        output_emitter: tts.AudioEmitter,
    ) -> bool:
        ws_url = (
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
            f"?key={api_key}"
        )
        chunks_pushed = 0
        first_chunk_recorded = False

        async with websockets.connect(
            ws_url,
            open_timeout=5.0,
            close_timeout=1.0,
            max_size=16 * 1024 * 1024,
        ) as ws:
            # 1. Send BidiGenerateContent setup with Aoede voice & thinkingBudget=0
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

            # 2. Wait for setupComplete, then send sentence to speak
            setup_done = False
            while True:
                # Once audio chunks have started arriving, use a short 320ms idle timeout
                # so we never wait if `turnComplete` is delayed.
                recv_timeout = 0.32 if chunks_pushed > 0 else 8.0
                try:
                    raw_msg = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
                except asyncio.TimeoutError:
                    if chunks_pushed > 0:
                        break
                    raise

                if isinstance(raw_msg, bytes):
                    raw_msg = raw_msg.decode("utf-8", errors="replace")
                msg = json.loads(raw_msg)

                if "error" in msg:
                    if chunks_pushed > 0:
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
                    inline = part.get("inlineData") or {}
                    b64_audio = inline.get("data")
                    if b64_audio:
                        pcm_bytes = base64.b64decode(b64_audio)
                        if pcm_bytes:
                            if not first_chunk_recorded:
                                first_chunk_recorded = True
                                if self._tracker:
                                    self._tracker.mark_tts_first_audio()
                            output_emitter.push(pcm_bytes)
                            chunks_pushed += 1

                if (
                    server_content.get("generationComplete")
                    or server_content.get("turnComplete")
                ) and chunks_pushed > 0:
                    break

        return chunks_pushed > 0

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        spoken_text = clean_text_for_speech(self._input_text)
        if not spoken_text:
            return

        if self._tracker:
            self._tracker.mark_tts_start(spoken_text)

        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=self._tts.sample_rate,
            num_channels=self._tts.num_channels,
            mime_type="audio/pcm",
        )

        last_err: Optional[Exception] = None
        for full_model in self._models:
            try:
                api_key = self._cfg.next_google_api_key()
                ok = await self._stream_from_model(
                    full_model=full_model,
                    api_key=api_key,
                    spoken_text=spoken_text,
                    output_emitter=output_emitter,
                )
                if ok:
                    output_emitter.flush()
                    return
            except asyncio.CancelledError:
                # Barge-in interruption: exit immediately
                raise
            except Exception as exc:
                last_err = exc
                logger.warning(f"Gemini25NativeAudioTTS ({full_model}) retry warning: {exc}")
                continue

        if last_err:
            logger.error(f"All Gemini 2.5 Native Audio TTS models failed: {last_err}")
            raise last_err


def create_gemini_tts(
    *,
    app_settings: Settings = settings,
    latency_tracker: Optional[TurnLatencyTracker] = None,
) -> tts.TTS:
    """Create the Gemini 2.5 Audio TTS instance.

    - Uses `Gemini25NativeAudioTTS` (`BidiGenerateContent` WebSocket streaming) for
      `gemini-2.5-flash-native-audio-*` / `live` models (no 10/day free tier cap).
    - Uses `livekit.plugins.google.beta.GeminiTTS` if configured with `gemini-2.5-flash-preview-tts`.
    """
    model_lower = app_settings.gemini_tts_model.lower()
    voice = normalize_voice_name(app_settings.gemini_tts_voice, "Aoede")

    if "native-audio" in model_lower or "live" in model_lower:
        logger.info(
            f"Using Gemini25NativeAudioTTS ({app_settings.gemini_tts_model}, voice={voice})"
        )
        return Gemini25NativeAudioTTS(
            app_settings=app_settings,
            latency_tracker=latency_tracker,
            voice_name=voice,
        )

    logger.info(
        f"Using livekit.plugins.google.beta.GeminiTTS ({app_settings.gemini_tts_model}, voice={voice})"
    )
    return google_beta.GeminiTTS(
        model=app_settings.gemini_tts_model.replace("models/", ""),
        voice_name=voice,
        api_key=app_settings.next_google_api_key(),
    )
