# Vega App — MAX v1 Voice Agent (Pipecat + SmallWebRTC)

Self-hosted real-time voice agent backend replacing LiveKit with **Pipecat (`pipecat-ai`) + SmallWebRTC (`aiortc`)**:

```text
SmallWebRTC Peer Audio Input (16kHz PCM)
  └──► VADProcessor (Silero VAD)
         └──► GeminiFlashSTTService (`gemini-3.1-flash-lite-preview`, WAV-segmented)
                └──► LLMContextAggregatorPair.user() (Turn Detection & Barge-In Interruption)
                       └──► OpenCodeMiMoLLMService (`mimo-v2.6-flash-free`, Streaming SSE + WebSearch)
                              └──► Gemini25NativeAudioTTSService (`gemini-2.5-flash-native-audio-preview-12-2025`, `Aoede`)
                                     └──► TurnLatencyObserverProcessor (STT / LLM TTFT / TTS TTFA / Total)
                                            └──► SmallWebRTC Peer Audio Output (24kHz PCM)
```

---

## 💻 Windows CMD Setup & Run Commands

```cmd
cd livekit_voice_agent
python -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
copy .env.example .env
```
Edit `.env` (set `GOOGLE_API_KEY` and `SESSION_SECRET`), then start the server:
```cmd
python -m uvicorn app.server:app --host 0.0.0.0 --port 8000
```

Verify health in another CMD window:
```cmd
curl http://localhost:8000/health
```

---

## 🌐 Public Internet Deployment & STUN/TURN Networking

1. **Signaling Over HTTPS:**
   - `GET /health`
   - `POST /api/session` (creates a signed session token and returns `iceServers`)
   - `POST /api/offer` (exchanges WebRTC SDP Offer/Answer via `SmallWebRTCRequestHandler`)
   - `PATCH /api/offer` (trickle ICE candidates)
   - `DELETE /api/session/{pc_id}` (disconnect & resource cleanup)
2. **UDP Media Ports & TURN Server Requirement:**
   - `SmallWebRTC` (`aiortc`) establishes a direct peer-to-peer WebRTC media connection between the mobile client and the Python server.
   - On a VPS/VM (AWS EC2, DigitalOcean, Hetzner, GCP VM) with a public IP and open UDP ports, STUN (`stun:stun.l.google.com:19302`) works for most networks.
   - For mobile clients behind **Symmetric NAT / carrier-grade NAT (4G/5G)** or when hosting the backend behind a container proxy (like Render/Railway where arbitrary UDP ports are not exposed), configure a **TURN server** (e.g., self-hosted `coturn`, Cloudflare Calls TURN, or Metered TURN) in `.env`:
     ```ini
     TURN_SERVER_URL=turn:your-turn-server.com:3478?transport=tcp
     TURN_USERNAME=your_turn_user
     TURN_CREDENTIAL=your_turn_password
     ```
