"""Pipecat + SmallWebRTC Real-Time Voice Pipeline for Vega MAX v1 (Replacing LiveKit Agent).

Pipeline:
  SmallWebRTCTransport.input()
    -> VADProcessor(SileroVADAnalyzer)
    -> GeminiFlashSTTService (`gemini-3.1-flash-lite-preview`)
    -> LLMContextAggregatorPair.user() (Turn Detection & Barge-In Interruption)
    -> OpenCodeMiMoLLMService (`mimo-v2.6-flash-free`, Streaming SSE + WebSearch)
    -> Gemini25NativeAudioTTSService (`gemini-2.5-flash-native-audio-preview-12-2025`, `Aoede`)
    -> TurnLatencyObserverProcessor (Per-Turn STT / LLM TTFT / TTS TTFA / Total Latency)
    -> SmallWebRTCTransport.output()
    -> LLMContextAggregatorPair.assistant()
"""

from __future__ import annotations

import asyncio
from typing import Dict, Optional

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMContextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from app.config import settings
from app.latency import TurnLatencyObserverProcessor, TurnLatencyTracker
from app.plugins.gemini_stt import create_gemini_stt
from app.plugins.gemini_tts import create_gemini_tts
from app.plugins.mimo_llm import create_mimo_llm
from app.prompts import VOICE_SYSTEM_PROMPT, normalize_voice_name

# Active PipelineTask registry keyed by `pc_id` for clean shutdown & monitoring
active_pipeline_tasks: Dict[str, PipelineTask] = {}


def create_vad_analyzer() -> SileroVADAnalyzer:
    """Create a Silero VAD analyzer configured for responsive turn detection & barge-in."""
    return SileroVADAnalyzer(
        params=VADParams(
            start_secs=settings.vad_min_speech_duration,
            stop_secs=settings.vad_min_silence_duration,
            confidence=settings.vad_activation_threshold,
            min_volume=settings.vad_min_volume,
        )
    )


async def run_voice_pipeline_for_connection(
    webrtc_connection: SmallWebRTCConnection,
    *,
    voice: Optional[str] = None,
    session_id: Optional[str] = None,
) -> None:
    """Build and run the Pipecat + SmallWebRTC voice pipeline for a connected peer."""
    pc_id = webrtc_connection.pc_id or session_id or "peer"
    selected_voice = normalize_voice_name(voice or settings.gemini_tts_voice, "Aoede")
    logger.info(
        f"Starting MAX v1 Pipecat SmallWebRTC pipeline | pc_id={pc_id} | voice={selected_voice}"
    )

    tracker = TurnLatencyTracker(session_id=pc_id)

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_in_sample_rate=16000,
            audio_out_enabled=True,
            audio_out_sample_rate=settings.tts_sample_rate,
            audio_out_10ms_chunks=2,
        ),
    )

    vad_processor = VADProcessor(vad_analyzer=create_vad_analyzer())
    stt_service = create_gemini_stt(app_settings=settings, latency_tracker=tracker)
    llm_service = create_mimo_llm(app_settings=settings, latency_tracker=tracker)
    tts_service = create_gemini_tts(
        app_settings=settings,
        latency_tracker=tracker,
        voice_name=selected_voice,
    )
    latency_observer = TurnLatencyObserverProcessor(tracker=tracker)

    context = LLMContext(
        messages=[
            {"role": "system", "content": VOICE_SYSTEM_PROMPT},
        ]
    )
    context_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            vad_processor,
            stt_service,
            context_aggregator.user(),
            llm_service,
            tts_service,
            latency_observer,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=16000,
            audio_out_sample_rate=settings.tts_sample_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        idle_timeout_secs=300,
    )
    active_pipeline_tasks[pc_id] = task

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _client) -> None:
        logger.info(f"SmallWebRTC client connected | pc_id={pc_id}")
        # Greet the user concisely as soon as the WebRTC audio channel opens
        greeting_ctx = LLMContext(
            messages=[
                {"role": "system", "content": VOICE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": "Greet me warmly in 1 short Hinglish sentence as Max v1.0, Vega's voice AI.",
                },
            ]
        )
        await task.queue_frames([LLMContextFrame(context=greeting_ctx)])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client) -> None:
        logger.info(f"SmallWebRTC client disconnected | pc_id={pc_id} — cleaning up pipeline")
        active_pipeline_tasks.pop(pc_id, None)
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    except asyncio.CancelledError:
        logger.info(f"Pipeline task cancelled cleanly | pc_id={pc_id}")
    except Exception as exc:
        logger.error(f"Pipeline error for pc_id={pc_id}: {exc}")
    finally:
        active_pipeline_tasks.pop(pc_id, None)
        logger.info(f"Pipeline resources released | pc_id={pc_id}")
