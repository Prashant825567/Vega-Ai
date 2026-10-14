"""FastAPI Token & Health Server for Vega Expo React Native App -> LiveKit Voice Agent."""

from __future__ import annotations

import datetime
import secrets
import time
from typing import Any, Dict, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from livekit import api
from loguru import logger
from pydantic import BaseModel, Field

from app.config import settings
from app.latency import global_latency_store
from app.prompts import SUPPORTED_FEMALE_VOICES, normalize_voice_name

app = FastAPI(
    title="Vega App — Max v1.0 LiveKit Voice Agent Backend",
    version="1.0.0",
    description=(
        "Token & Health API for the Expo React Native client connecting to the "
        "Max v1.0 LiveKit Voice Agent (Silero VAD -> Gemini 3.1 Flash STT -> "
        "MiMo 2.6 Flash LLM -> Gemini 2.5 Audio TTS)."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TokenRequest(BaseModel):
    room_name: Optional[str] = Field(
        default=None, description="LiveKit room name (auto-generated if omitted)"
    )
    participant_identity: Optional[str] = Field(
        default=None, description="Unique user identity for Expo client"
    )
    participant_name: Optional[str] = Field(
        default="Vega User", description="Display name in the LiveKit room"
    )
    voice: Optional[str] = Field(
        default=None, description="Optional Gemini 2.5 TTS female voice (default: Aoede)"
    )
    ttl_minutes: int = Field(
        default=60, ge=5, le=1440, description="Token validity in minutes"
    )


class TokenResponse(BaseModel):
    success: bool = True
    url: str
    token: str
    roomName: str
    participantIdentity: str
    participantName: str
    agentName: str
    voice: str
    expiresAt: int


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
    """Health & readiness endpoint with pipeline status and per-turn latency summary."""
    return {
        "status": "ok",
        "service": "vega-max-v1-livekit-voice-agent",
        "ai": "Max v1.0",
        "app": "Vega",
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
        "configured_keys": {
            "livekit_configured": bool(
                settings.livekit_url
                and settings.livekit_api_key
                and settings.livekit_api_secret
            ),
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


@app.post("/api/token", response_model=TokenResponse)
@app.post("/token", response_model=TokenResponse)
async def create_livekit_token(body: TokenRequest) -> TokenResponse:
    """Create a signed LiveKit room token for the Expo React Native app.

    Keeps `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` strictly on the server.
    Automatically dispatches the `vega-max-v1` voice agent into the room.
    """
    if not settings.livekit_url or not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status_code=500,
            detail=(
                "Server misconfiguration: LIVEKIT_URL, LIVEKIT_API_KEY, and "
                "LIVEKIT_API_SECRET must be set in .env"
            ),
        )

    room_name = (body.room_name or f"vega-room-{secrets.token_hex(4)}").strip()
    identity = (body.participant_identity or f"vega-user-{secrets.token_hex(4)}").strip()
    name = (body.participant_name or "Vega User").strip()
    selected_voice = normalize_voice_name(body.voice or settings.gemini_tts_voice, "Aoede")
    ttl_delta = datetime.timedelta(minutes=body.ttl_minutes)
    expires_at = int(time.time() + ttl_delta.total_seconds())

    try:
        access_token = (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(name)
            .with_ttl(ttl_delta)
            .with_metadata(f'{{"app":"Vega","voice":"{selected_voice}"}}')
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=True,
                )
            )
            .with_room_config(
                api.RoomConfiguration(
                    agents=[
                        api.RoomAgentDispatch(
                            agent_name=settings.livekit_agent_name,
                            metadata=f'{{"voice":"{selected_voice}"}}',
                        )
                    ]
                )
            )
        )
        jwt_token = access_token.to_jwt()
    except Exception as exc:
        logger.error(f"Failed to generate LiveKit token: {exc}")
        raise HTTPException(
            status_code=500, detail=f"Token generation failed: {exc}"
        ) from exc

    logger.info(
        f"Issued LiveKit token | room={room_name} | identity={identity} | voice={selected_voice}"
    )
    return TokenResponse(
        success=True,
        url=settings.livekit_url,
        token=jwt_token,
        roomName=room_name,
        participantIdentity=identity,
        participantName=name,
        agentName=settings.livekit_agent_name,
        voice=selected_voice,
        expiresAt=expires_at,
    )


if __name__ == "__main__":
    uvicorn.run(
        "app.server:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
