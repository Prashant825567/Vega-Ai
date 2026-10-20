# ⚡ Max v1.0 — Pure Headless Backend & Voice Agent API for Vega App

Render-ready pure Node.js backend API server for **Vega App's AI & Voice Agent ("Max v1.0")**.

## 🧠 Voice Agent Architecture (`POST /api/voice`)
1. **🎙️ STT (Speech-to-Text):** `gemini-2.5-flash` (Google AI Studio audio input -> Text transcript)
2. **🤖 Middle LLM (Brain):** `deepseek-v4.1-flash-free` via OpenCode Zen Gateway (Persona: **Max v1.0**)
   - **Fast No-Reasoning Mode (`reasoning_tokens: 0`):** Disables internal thinking tokens (`reasoning_effort: "none"`, `thinking: { type: "disabled" }`) so voice responses come back fast!
   - **Smart "Ek second, abhi batata hoon..." Filler:** When a question requires research, calculation, or detailed explanation, Max v1.0 naturally starts with *"Ek second, abhi batata hoon..."* and the server also provides instant cached filler audio (`fillerAudio` / `GET /api/voice/filler`).
3. **🔊 TTS (Text-to-Speech):** `gemini-2.5-flash-preview-tts` (Converts Max v1.0's reply to a playable 24kHz `.wav` Base64 & Data URI for direct playback in the Vega App)

---

## 🔐 Render.com Environment Variables Setup

No API keys are hardcoded in the code. Add these in Render **Environment Variables**:

| Key | Value |
| --- | --- |
| `OPENCODE_API_KEY` | Your OpenCode key (`oc_sk_...`) |
| `GEMINI_API_KEY` | Your Google AI Studio API Key (`AIzaSy...`) *(Also accepts `GOOGLE_API_KEY` or `GOOGLE_AI_STUDIO_API_KEY`)* |
| `AI_NAME` | `Max v1.0` |
| `APP_NAME` | `Vega` |
| `DEFAULT_MODEL` | `deepseek-v4.1-flash-free` |
| `GEMINI_STT_MODEL` | `gemini-2.5-flash` |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` |
| `GEMINI_TTS_VOICE` | `Aoede` *(or `Puck`, `Charon`, `Kore`, `Fenrir`)* |

---

## 📱 Vega App Integration & Playback

### 1. Full Voice Agent Call (`POST /api/voice`)
```javascript
const response = await fetch("https://YOUR-RENDER-URL.onrender.com/api/voice", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    audio: base64RecordedAudio, // Base64 string or "data:audio/wav;base64,..."
    mimeType: "audio/wav",      // "audio/wav", "audio/m4a", "audio/webm", "audio/mp3"
    voice: "Puck",
    history: []
  })
});

const data = await response.json();

// 1. User's transcribed speech (from gemini-2.5-flash):
console.log("User said:", data.transcript);

// 2. Max v1.0's fast reply (from deepseek-v4.1-flash-free with reasoning disabled):
console.log("Max v1.0 reply:", data.reply);

// 3. Playable WAV audio in Vega App (from gemini-2.5-flash-preview-tts):
// Pass data.audio.dataUri ("data:audio/wav;base64,...") or data.audio.base64 to your Vega app's Audio player!
```

### 2. Instant Filler Audio for Vega App (`GET /api/voice/filler`)
To play *"Ek second, abhi batata hoon."* immediately in your Vega app whenever the user asks a long/research question:
```javascript
const res = await fetch("https://YOUR-RENDER-URL.onrender.com/api/voice/filler");
const { filler } = await res.json();
// filler.dataUri -> "data:audio/wav;base64,..." (Cached in memory on server for 0ms response!)
```

### 3. Normal Agent: Text-to-Text & Image + Text-to-Text (`POST /api/chat`)

#### A. Text-to-Text (`POST /api/chat`)
```javascript
const response = await fetch("https://YOUR-RENDER-URL.onrender.com/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Hello Max, kaise ho?",
    history: []
  })
});
const data = await response.json();
console.log(data.reply);
```

#### B. Image + Text-to-Text / Vision (`POST /api/chat` or `POST /api/vision`)
```javascript
const response = await fetch("https://YOUR-RENDER-URL.onrender.com/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Is image mein kya hai?",
    image: base64OrDataUriOrImageUrl, // Base64 string, "data:image/jpeg;base64,...", or "https://..."
    mimeType: "image/jpeg"            // Optional (auto-detected for PNG/JPEG/WEBP/GIF)
  })
});
const data = await response.json();
console.log(data.reply);
```

### 4. Streaming Voice Mode (`POST /api/voice` with `"stream": true`)
Emits Server-Sent Events (`event: transcript`, `event: filler` with instant WAV audio if `needsThinking` is true, and `event: response` with the final WAV audio).
