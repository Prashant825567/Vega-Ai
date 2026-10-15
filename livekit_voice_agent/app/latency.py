"""Per-turn latency tracker & Pipecat FrameProcessor for STT, LLM TTFT, TTS TTFA, and Total latency."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any, Deque, Dict, List, Optional

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class TurnLatencyRecord:
    turn_id: int
    session_id: str
    transcript: str
    stt_ms: float
    llm_first_token_ms: float
    tts_first_audio_ms: float
    total_ms: float
    interrupted: bool = False
    timestamp: float = 0.0


class LatencyMetricsStore:
    """In-memory ring buffer storing recent per-turn latency measurements."""

    def __init__(self, maxlen: int = 100) -> None:
        self._records: Deque[TurnLatencyRecord] = deque(maxlen=maxlen)

    def add(self, record: TurnLatencyRecord) -> None:
        self._records.append(record)

    def recent(self, limit: int = 20) -> List[Dict[str, Any]]:
        items = list(self._records)[-limit:]
        return [asdict(r) for r in reversed(items)]

    def summary(self) -> Dict[str, float | int]:
        if not self._records:
            return {
                "turns_recorded": 0,
                "avg_stt_ms": 0.0,
                "avg_llm_first_token_ms": 0.0,
                "avg_tts_first_audio_ms": 0.0,
                "avg_total_ms": 0.0,
            }
        n = len(self._records)
        return {
            "turns_recorded": n,
            "avg_stt_ms": round(sum(r.stt_ms for r in self._records) / n, 1),
            "avg_llm_first_token_ms": round(
                sum(r.llm_first_token_ms for r in self._records) / n, 1
            ),
            "avg_tts_first_audio_ms": round(
                sum(r.tts_first_audio_ms for r in self._records) / n, 1
            ),
            "avg_total_ms": round(sum(r.total_ms for r in self._records) / n, 1),
        }


global_latency_store = LatencyMetricsStore()


class TurnLatencyTracker:
    """Tracks per-turn STT, LLM first token, TTS first audio, and total turnaround latency."""

    def __init__(self, session_id: str = "default") -> None:
        self.session_id = session_id
        self.turn_id: int = 0
        self.t_turn_start: Optional[float] = None
        self.t_stt_start: Optional[float] = None
        self.t_stt_end: Optional[float] = None
        self.t_llm_start: Optional[float] = None
        self.t_llm_first_token: Optional[float] = None
        self.t_tts_start: Optional[float] = None
        self.t_tts_first_audio: Optional[float] = None
        self.last_stt_ms: float = 0.0
        self.last_llm_ttft_ms: float = 0.0
        self.last_tts_ttfa_ms: float = 0.0
        self.current_transcript: str = ""
        self._logged_turn_id: int = 0

    def mark_stt_start(self) -> None:
        now = time.perf_counter()
        self.turn_id += 1
        self.t_turn_start = now
        self.t_stt_start = now
        self.t_stt_end = None
        self.t_llm_start = None
        self.t_llm_first_token = None
        self.t_tts_start = None
        self.t_tts_first_audio = None
        self.last_stt_ms = 0.0
        self.last_llm_ttft_ms = 0.0
        self.last_tts_ttfa_ms = 0.0

    def mark_stt_done(self, transcript: str, duration_ms: Optional[float] = None) -> float:
        now = time.perf_counter()
        if self.t_stt_start is None:
            self.mark_stt_start()
        self.t_stt_end = now
        self.current_transcript = transcript
        stt_ms = (
            duration_ms
            if duration_ms is not None
            else (now - (self.t_stt_start or now)) * 1000.0
        )
        self.last_stt_ms = stt_ms
        logger.info(
            f"[Session={self.session_id} | Turn #{self.turn_id}] "
            f"STT Latency = {stt_ms:.1f}ms | Transcript={transcript!r}"
        )
        return stt_ms

    def mark_llm_start(self) -> None:
        now = time.perf_counter()
        if self.t_turn_start is None:
            self.turn_id += 1
            self.t_turn_start = now
        self.t_llm_start = now
        self.t_llm_first_token = None

    def mark_llm_first_token(
        self, first_token: str = "", ttft_ms_override: Optional[float] = None
    ) -> float:
        if self.t_llm_first_token is not None and ttft_ms_override is None:
            return self.last_llm_ttft_ms
        now = time.perf_counter()
        self.t_llm_first_token = now
        start = self.t_llm_start or self.t_stt_end or self.t_turn_start or now
        ttft_ms = (
            ttft_ms_override
            if ttft_ms_override is not None
            else (now - start) * 1000.0
        )
        self.last_llm_ttft_ms = ttft_ms
        logger.info(
            f"[Session={self.session_id} | Turn #{self.turn_id}] "
            f"LLM First Token (TTFT) = {ttft_ms:.1f}ms | FirstChunk={first_token!r}"
        )
        return ttft_ms

    def mark_tts_start(self, sentence: str = "") -> None:
        if self.t_tts_start is None:
            self.t_tts_start = time.perf_counter()
            logger.debug(
                f"[Session={self.session_id} | Turn #{self.turn_id}] "
                f"TTS starting on first LLM sentence: {sentence!r}"
            )

    def mark_tts_first_audio(
        self, ttfa_ms_override: Optional[float] = None
    ) -> Optional[TurnLatencyRecord]:
        if self._logged_turn_id == self.turn_id and self.turn_id > 0:
            return None
        now = time.perf_counter()
        if self.turn_id == 0:
            self.turn_id = 1
        self.t_tts_first_audio = now
        self._logged_turn_id = self.turn_id

        tts_start = self.t_tts_start or self.t_llm_first_token or now
        tts_ms = (
            ttfa_ms_override
            if ttfa_ms_override is not None
            else (now - tts_start) * 1000.0
        )
        self.last_tts_ttfa_ms = tts_ms

        stt_ms = self.last_stt_ms
        llm_ms = self.last_llm_ttft_ms
        if self.t_turn_start is not None:
            total_ms = (now - self.t_turn_start) * 1000.0
        else:
            total_ms = stt_ms + llm_ms + tts_ms

        record = TurnLatencyRecord(
            turn_id=self.turn_id,
            session_id=self.session_id,
            transcript=self.current_transcript,
            stt_ms=round(stt_ms, 1),
            llm_first_token_ms=round(llm_ms, 1),
            tts_first_audio_ms=round(tts_ms, 1),
            total_ms=round(total_ms, 1),
            interrupted=False,
            timestamp=time.time(),
        )
        global_latency_store.add(record)

        logger.success(
            f"⚡ [TURN #{self.turn_id} LATENCY | session={self.session_id}] "
            f"STT={record.stt_ms:.1f}ms | "
            f"LLM_first_token={record.llm_first_token_ms:.1f}ms | "
            f"TTS_first_audio={record.tts_first_audio_ms:.1f}ms | "
            f"TOTAL={record.total_ms:.1f}ms"
        )
        return record

    def mark_interruption(self) -> None:
        logger.warning(
            f"🛑 [BARGE-IN | session={self.session_id} | Turn #{self.turn_id}] "
            f"User interrupted — active LLM + TTS streams cancelled!"
        )


class TurnLatencyObserverProcessor(FrameProcessor):
    """Pipecat FrameProcessor observing VAD, STT, LLM, TTS, and Barge-In frames."""

    def __init__(self, tracker: TurnLatencyTracker, **kwargs) -> None:
        super().__init__(**kwargs)
        self._tracker = tracker

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InterruptionFrame):
            self._tracker.mark_interruption()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._tracker.t_stt_start is None:
                self._tracker.mark_stt_start()
        elif isinstance(frame, TranscriptionFrame):
            if self._tracker.last_stt_ms == 0.0 and frame.text:
                self._tracker.mark_stt_done(frame.text)
        elif isinstance(frame, LLMFullResponseStartFrame):
            if self._tracker.t_llm_start is None:
                self._tracker.mark_llm_start()
        elif isinstance(frame, LLMTextFrame):
            self._tracker.mark_llm_first_token(frame.text)
        elif isinstance(frame, TTSAudioRawFrame):
            self._tracker.mark_tts_first_audio()

        await self.push_frame(frame, direction)
