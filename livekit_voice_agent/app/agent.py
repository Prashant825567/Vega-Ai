"""LiveKit Agents real-time voice worker entrypoint for Max v1.0 (Vega App).

Pipeline:
  LiveKit Room Audio
    -> Silero VAD + Turn Detection (`StreamAdapter`)
    -> STT (`GeminiFlashSTT`: `gemini-3.1-flash-lite-preview`)
    -> LLM (`OpenCodeMiMoLLM` / `openai.LLM`: `mimo-v2.6-flash-free`, streaming)
    -> TTS (`Gemini25NativeAudioTTS`: `gemini-2.5-flash-native-audio-preview-12-2025`, `Aoede`)
    -> Back to LiveKit Room (with barge-in interruption + per-turn latency logging)
"""

from __future__ import annotations

from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
    llm,
)
from livekit.plugins import silero
from loguru import logger

from app.config import settings
from app.latency import TurnLatencyTracker
from app.plugins.gemini_stt import create_gemini_stt
from app.plugins.gemini_tts import create_gemini_tts
from app.plugins.mimo_llm import create_mimo_llm
from app.prompts import VOICE_SYSTEM_PROMPT, truncate_livekit_chat_ctx


class MaxVoiceAgent(Agent):
    """Max v1.0 voice assistant with automatic N-turn chat history truncation."""

    def __init__(self, *, max_history_turns: int = 6) -> None:
        super().__init__(instructions=VOICE_SYSTEM_PROMPT)
        self._max_history_turns = max_history_turns

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        """Trim chat history to the last N turns before every LLM invocation."""
        truncate_livekit_chat_ctx(turn_ctx, max_turns=self._max_history_turns)


def prewarm(proc: JobProcess) -> None:
    """Preload Silero VAD ONNX model once per worker process for 0ms startup delay."""
    logger.info("Prewarming Silero VAD model...")
    proc.userdata["vad"] = silero.VAD.load(
        min_speech_duration=settings.vad_min_speech_duration,
        min_silence_duration=settings.vad_min_silence_duration,
        activation_threshold=settings.vad_activation_threshold,
        force_cpu=True,
    )
    logger.info("Silero VAD model prewarmed successfully.")


async def entrypoint(ctx: JobContext) -> None:
    """Main per-room job entrypoint executed by the LiveKit Agent worker."""
    room_name = ctx.room.name or "vega-voice-room"
    logger.info(f"Starting Max v1.0 Voice Agent for LiveKit room: {room_name}")

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    tracker = TurnLatencyTracker(room_name=room_name)

    silero_vad: silero.VAD = ctx.proc.userdata.get("vad") or silero.VAD.load(
        min_speech_duration=settings.vad_min_speech_duration,
        min_silence_duration=settings.vad_min_silence_duration,
        activation_threshold=settings.vad_activation_threshold,
        force_cpu=True,
    )

    stt_engine = create_gemini_stt(
        silero_vad=silero_vad,
        app_settings=settings,
        latency_tracker=tracker,
    )
    llm_engine = create_mimo_llm(
        app_settings=settings,
        latency_tracker=tracker,
    )
    tts_engine = create_gemini_tts(
        app_settings=settings,
        latency_tracker=tracker,
    )

    session = AgentSession(
        vad=silero_vad,
        stt=stt_engine,
        llm=llm_engine,
        tts=tts_engine,
        allow_interruptions=settings.allow_interruptions,
        min_interruption_duration=settings.min_interruption_duration,
        min_endpointing_delay=settings.min_endpointing_delay,
        max_endpointing_delay=settings.max_endpointing_delay,
    )

    @session.on("metrics_collected")
    def _on_metrics_collected(ev) -> None:
        tracker.on_livekit_metrics(ev)

    @session.on("user_input_transcribed")
    def _on_user_transcribed(ev) -> None:
        transcript = getattr(ev, "transcript", "")
        is_final = getattr(ev, "is_final", True)
        if is_final and transcript:
            logger.info(f"[{room_name}] User Final Transcript: {transcript!r}")

    @session.on("speech_created")
    def _on_speech_created(ev) -> None:
        speech_handle = getattr(ev, "speech_handle", None)
        if speech_handle is not None:
            def _on_interrupted(_sh) -> None:
                if getattr(_sh, "interrupted", False):
                    tracker.mark_interruption()

            try:
                speech_handle.add_done_callback(_on_interrupted)
            except Exception:
                pass

    await session.start(
        agent=MaxVoiceAgent(max_history_turns=settings.max_history_turns),
        room=ctx.room,
    )

    # Speak an initial concise greeting so the user knows Max v1.0 is connected
    await session.generate_reply(
        instructions="Greet the user warmly in 1 short Hinglish sentence as Max v1.0, Vega's voice AI."
    )


def create_worker_options() -> WorkerOptions:
    return WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=prewarm,
        agent_name=settings.livekit_agent_name,
        ws_url=settings.livekit_url or None,
        api_key=settings.livekit_api_key or None,
        api_secret=settings.livekit_api_secret or None,
    )


if __name__ == "__main__":
    cli.run_app(create_worker_options())
