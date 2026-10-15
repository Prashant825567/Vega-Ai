"""FastAPI Signaling, Session, and Health Server for Vega MAX v1 (Pipecat + SmallWebRTC)."""

from __future__ import annotations

import asyncio
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pydantic import BaseModel, Field

from app.agent import active_pipeline_tasks, run_voice_pipeline_for_connection
from app.config import settings
from app.latency import global_latency_store
from app.prompts import SUPPORTED_FEMALE_VOICES, normalize_voice_name

# Official Pipecat SmallWebRTC signaling handler configured with STUN/TURN ICE servers
small_webrtc_handler = SmallWebRTCRequestHandler(
    ice_servers=settings.build_ice_servers(),
)
_background_tasks: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(
        f"MAX v1 Pipecat + SmallWebRTC Server starting on {settings.host}:{settings.port}"
    )
    yield
    logger.info("Shutting down active SmallWebRTC connections and pipelines...")
    for task in list(active_pipeline_tasks.values()):
        try:
            await task.cancel()
        except Exception:
            pass
    await small_webrtc_handler.close()


app = FastAPI(
    title="Vega App — MAX v1 Voice Agent (Pipecat + SmallWebRTC)",
    version="2.0.0",
    description=(
        "Self-hosted Pipecat + SmallWebRTC signaling and session API for Vega MAX v1 "
        "(Silero VAD -> Gemini 3.1 Flash STT -> MiMo v2.6 Flash LLM -> Gemini 2.5 Audio TTS)."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SessionCreateRequest(BaseModel):
    participant_name: Optional[str] = Field(
        default="Vega User", max_length=80, description="Display name of the user"
    )
    voice: Optional[str] = Field(
        default=None, description="Optional Gemini 2.5 TTS female voice (default: Aoede)"
    )
    ttl_minutes: int = Field(
        default=60, ge=5, le=1440, description="Session token validity in minutes"
    )


class SessionCreateResponse(BaseModel):
    success: bool = True
    sessionId: str
    sessionToken: str
    offerUrl: str
    patchUrl: str
    iceServers: List[Dict[str, Any]]
    voice: str
    expiresAt: int


class WebRTCOfferPayload(BaseModel):
    sdp: str = Field(..., min_length=10, description="WebRTC SDP offer string")
    type: str = Field(default="offer", description="SDP type ('offer')")
    pc_id: Optional[str] = Field(
        default=None, description="Existing peer connection ID for renegotiation/reconnect"
    )
    restart_pc: Optional[bool] = Field(
        default=False, description="Whether to restart ICE/peer connection"
    )
    voice: Optional[str] = Field(
        default=None, description="Optional TTS voice override (e.g., 'Aoede')"
    )
    session_token: Optional[str] = Field(
        default=None, description="Optional session token from POST /api/session"
    )
    request_data: Optional[Dict[str, Any]] = Field(default=None)


class WebRTCIceCandidateItem(BaseModel):
    candidate: str
    sdp_mid: str
    sdp_mline_index: int


class WebRTCPatchPayload(BaseModel):
    pc_id: str = Field(..., min_length=1)
    candidates: List[WebRTCIceCandidateItem] = Field(default_factory=list)


@app.exception_handler(Exception)
async def global_exception_handler(_req: Request, exc: Exception) -> JSONResponse:
    logger.error(f"Unhandled API error: {exc}")
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": str(exc),
        },
    )


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Health & readiness endpoint with SmallWebRTC pipeline status and latency summary."""
    return {
        "status": "ok",
        "service": "vega-max-v1-pipecat-smallwebrtc",
        "ai": "Max v1.0",
        "app": "Vega",
        "transport": "pipecat-smallwebrtc",
        "active_sessions": len(active_pipeline_tasks),
        "pipeline": {
            "vad": "silero-vad",
            "stt": settings.gemini_stt_model,
            "stt_fallback": settings.gemini_stt_fallback_model,
            "llm": settings.mimo_model,
            "llm_gateway": "opencode" if settings.is_opencode_gateway else "openai-compatible",
            "tts": settings.gemini_tts_model,
            "default_voice": normalize_voice_name(settings.gemini_tts_voice, "Aoede"),
            "supported_voices": SUPPORTED_FEMALE_VOICES,
            "barge_in_enabled": settings.allow_interruptions,
            "max_history_turns": settings.max_history_turns,
        },
        "ice_config": {
            "stun_configured": len(settings.stun_server_urls) > 0,
            "turn_configured": bool(settings.turn_server_url),
        },
        "configured_keys": {
            "google_api_key_configured": len(settings.google_api_keys) > 0,
            "mimo_api_key_configured": bool(settings.mimo_api_key),
        },
        "latency": global_latency_store.summary(),
        "timestamp": int(time.time()),
    }


@app.get("/api/metrics")
async def get_latency_metrics() -> Dict[str, Any]:
    """Return per-turn latency summary and recent turn records."""
    return {
        "success": True,
        "summary": global_latency_store.summary(),
        "recent_turns": global_latency_store.recent(limit=25),
    }


@app.post("/api/session", response_model=SessionCreateResponse)
@app.post("/api/token", response_model=SessionCreateResponse)
@app.post("/token", response_model=SessionCreateResponse)
async def create_voice_session(body: SessionCreateRequest) -> SessionCreateResponse:
    """Create a secure SmallWebRTC session token and return ICE server & signaling info.

    Replaces the old LiveKit room token endpoint while keeping `/api/token` as an alias
    so existing frontend callers can migrate seamlessly.
    """
    session_id = f"vega-ses-{secrets.token_hex(6)}"
    participant_name = (body.participant_name or "Vega User").strip()
    selected_voice = normalize_voice_name(body.voice or settings.gemini_tts_voice, "Aoede")

    token, expires_at = settings.create_session_token(
        session_id=session_id,
        participant_name=participant_name,
        voice=selected_voice,
        ttl_minutes=body.ttl_minutes,
    )

    logger.info(
        f"Created SmallWebRTC session | sessionId={session_id} | user={participant_name!r} | voice={selected_voice}"
    )
    return SessionCreateResponse(
        success=True,
        sessionId=session_id,
        sessionToken=token,
        offerUrl="/api/offer",
        patchUrl="/api/offer",
        iceServers=settings.get_client_ice_servers(),
        voice=selected_voice,
        expiresAt=expires_at,
    )


@app.post("/api/offer")
@app.post("/offer")
async def handle_webrtc_offer(
    payload: WebRTCOfferPayload,
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """SmallWebRTC SDP Offer/Answer signaling endpoint.

    Accepts a browser or React Native `RTCPeerConnection` SDP offer, initializes a
    `SmallWebRTCConnection`, launches the MAX v1 Pipecat voice pipeline, and returns
    the server's SDP answer + `pc_id`.
    """
    if payload.type.lower() != "offer":
        raise HTTPException(
            status_code=400, detail=f"Expected SDP type 'offer', got {payload.type!r}"
        )

    # Validate optional session token if sent via header or body
    raw_token = payload.session_token
    if not raw_token and authorization and authorization.lower().startswith("bearer "):
        raw_token = authorization[7:].strip()

    token_data: Optional[Dict[str, Any]] = None
    if raw_token:
        token_data = settings.verify_session_token(raw_token)
        if token_data is None:
            raise HTTPException(
                status_code=401, detail="Invalid or expired session token"
            )

    requested_voice = (
        payload.voice
        or (payload.request_data or {}).get("voice")
        or (token_data or {}).get("voice")
        or settings.gemini_tts_voice
    )
    selected_voice = normalize_voice_name(requested_voice, "Aoede")
    session_id = (token_data or {}).get("sid")

    webrtc_req = SmallWebRTCRequest(
        sdp=payload.sdp,
        type=payload.type,
        pc_id=payload.pc_id,
        restart_pc=payload.restart_pc,
        request_data=payload.request_data,
    )

    async def on_webrtc_connection(conn: SmallWebRTCConnection) -> None:
        bg_task = asyncio.create_task(
            run_voice_pipeline_for_connection(
                conn,
                voice=selected_voice,
                session_id=session_id,
            )
        )
        _background_tasks.add(bg_task)
        bg_task.add_done_callback(_background_tasks.discard)

    answer = await small_webrtc_handler.handle_web_request(
        request=webrtc_req,
        webrtc_connection_callback=on_webrtc_connection,
    )
    if not answer:
        raise HTTPException(
            status_code=500, detail="SmallWebRTC handler returned no SDP answer"
        )
    return answer


@app.patch("/api/offer")
@app.patch("/offer")
async def handle_webrtc_patch(payload: WebRTCPatchPayload) -> Dict[str, Any]:
    """Trickle ICE candidate endpoint for an active SmallWebRTC peer connection."""
    patch_req = SmallWebRTCPatchRequest(
        pc_id=payload.pc_id,
        candidates=[
            IceCandidate(
                candidate=c.candidate,
                sdp_mid=c.sdp_mid,
                sdp_mline_index=c.sdp_mline_index,
            )
            for c in payload.candidates
        ],
    )
    await small_webrtc_handler.handle_patch_request(patch_req)
    return {"status": "ok", "pc_id": payload.pc_id}


class SessionClosePayload(BaseModel):
    pc_id: str = Field(..., min_length=1)


@app.post("/api/session/close")
async def close_voice_session_post(payload: SessionClosePayload) -> Dict[str, Any]:
    """Explicitly stop and clean up an active SmallWebRTC voice pipeline session by pc_id."""
    return await close_voice_session(payload.pc_id)


@app.delete("/api/session/{pc_id:path}")
async def close_voice_session(pc_id: str) -> Dict[str, Any]:
    """Explicitly stop and clean up an active SmallWebRTC voice pipeline session."""
    task = active_pipeline_tasks.pop(pc_id, None)
    if task is not None:
        try:
            await task.cancel()
        except Exception as exc:
            logger.warning(f"Error cancelling task for pc_id={pc_id}: {exc}")
        return {"success": True, "pc_id": pc_id, "closed": True}
    return {"success": True, "pc_id": pc_id, "closed": False}


if __name__ == "__main__":
    uvicorn.run(
        "app.server:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
