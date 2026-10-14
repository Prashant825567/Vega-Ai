# Vega App — Max v1.0 Real-Time Voice Agent (Python + LiveKit Agents)

Real-time streaming voice assistant backend built with **LiveKit Agents (`livekit-agents`)** and **FastAPI**:

```text
LiveKit Room Audio (WebRTC)
  └──► Silero VAD + Turn Detection (`stt.StreamAdapter`)
         └──► STT: Gemini 3.1 Flash (`gemini-3.1-flash-lite-preview`)
                └──► LLM: MiMo 2.6 Flash (`mimo-v2.6-flash-free` via OpenCode / OpenAI-compatible SSE)
                       └──► TTS: Gemini 2.5 Native Audio (`gemini-2.5-flash-native-audio-preview-12-2025`, `Aoede`)
                              └──► Back to LiveKit Room (with Barge-In Interruption)
```

---

## 📁 Project Structure

```text
livekit_voice_agent/
├── .env.example              # Environment variable template (no hardcoded secrets)
├── requirements.txt          # Python dependencies
├── Dockerfile                # Production Dockerfile for LiveKit Cloud / Render
├── README.md                 # Setup, local dev, LiveKit Cloud deploy, and Expo integration guide
└── app/
    ├── __init__.py
    ├── config.py             # Loads & validates .env variables
    ├── prompts.py            # Short voice-first system prompt + N-turn history trimmer
    ├── latency.py            # Per-turn STT, LLM TTFT, TTS TTFA, and Total latency logger
    ├── plugins/
    │   ├── __init__.py
    │   ├── gemini_stt.py     # Custom `GeminiFlashSTT` wrapped in `stt.StreamAdapter` + Silero VAD
    │   ├── mimo_llm.py       # `OpenCodeMiMoLLM` (with dynamic CLI headers & websearch) + `openai.LLM`
    │   ├── opencode_tools.json
    │   └── gemini_tts.py     # `Gemini25NativeAudioTTS` (Bidi WebSocket 24kHz PCM chunk streaming) + `GeminiTTS`
    ├── agent.py              # LiveKit Agents Worker entrypoint (`python -m app.agent dev`)
    └── server.py             # FastAPI Token (`/api/token`), Metrics (`/api/metrics`), and `/health` server
```

---

## 🚀 How to Run Locally

### 1. Create a Virtual Environment & Install Dependencies
```bash
cd livekit_voice_agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure `.env`
```bash
cp .env.example .env
```
Edit `.env` and fill in:
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (from your LiveKit Cloud project or local `livekit-server --dev`)
- `GOOGLE_API_KEY` (your Google AI Studio API key)
- `MIMO_BASE_URL=https://opencode.ai/inference/v1` and `MIMO_API_KEY=public`

### 3. Start the FastAPI Token & Health Server (Terminal 1)
```bash
uvicorn app.server:app --host 0.0.0.0 --port 8000 --reload
```
- **Health Check:** `curl http://localhost:8000/health`
- **Issue Expo Room Token:**
  ```bash
  curl -X POST http://localhost:8000/api/token \
    -H "Content-Type: application/json" \
    -d '{"participant_name":"Prashant","voice":"Aoede"}'
  ```

### 4. Start the LiveKit Voice Agent Worker (Terminal 2)
- **Console / Terminal Audio Mode (test directly with your laptop mic & speaker):**
  ```bash
  python -m app.agent console
  ```
- **Local Development Mode (connects to LiveKit Cloud / local LiveKit Server with hot-reload):**
  ```bash
  python -m app.agent dev
  ```
- **Production Worker Mode:**
  ```bash
  python -m app.agent start
  ```

---

## ☁️ Deploying to LiveKit Cloud

1. Install the LiveKit CLI (`lk`):
   ```bash
   curl -sSL https://get.livekit.io/cli | bash
   lk cloud auth
   ```
2. Inside `livekit_voice_agent/`, initialize and deploy the agent worker:
   ```bash
   lk agent create \
     --name vega-max-v1 \
     --secrets-file .env
   ```
3. For subsequent updates:
   ```bash
   lk agent deploy
   ```
4. Deploy the FastAPI Token Server (`uvicorn app.server:app --host 0.0.0.0 --port $PORT`) on Render / Railway / Fly.io so your Expo React Native app can call `POST /api/token`.

---

## 📱 Expo React Native Client Integration (`@livekit/react-native`)

```tsx
import React, { useState } from "react";
import { Button, View } from "react-native";
import { LiveKitRoom, AudioSession, useVoiceAssistant } from "@livekit/react-native";

const TOKEN_API_URL = "https://your-token-server.onrender.com/api/token";

export default function VegaVoiceScreen() {
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);

  async function startVoiceSession() {
    await AudioSession.startAudioSession();
    const res = await fetch(TOKEN_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_name: "Prashant", voice: "Aoede" }),
    });
    const data = await res.json();
    setConn({ url: data.url, token: data.token });
  }

  if (!conn) {
    return <Button title="Talk to Max v1.0" onPress={startVoiceSession} />;
  }

  return (
    <LiveKitRoom serverUrl={conn.url} token={conn.token} connect={true} audio={true} video={false}>
      <View />
    </LiveKitRoom>
  );
}
```
