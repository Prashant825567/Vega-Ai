/**
 * Max v1.0 — Pure Headless AI & Voice Agent Backend Server for Vega App
 * Ready for deployment on Render.com (No Web UI, Pure JSON/SSE/Audio API)
 *
 * Architecture:
 * 1. STT (Speech-to-Text):
 *    - Model: Google AI Studio `gemini-2.5-flash` (audio input -> text transcript)
 * 2. Middle LLM (Brain):
 *    - Model: OpenCode `mimo-v2.6-flash-free` (Persona: Max v1.0 for Vega App)
 *    - Fast Voice Mode: Disables internal reasoning (`reasoning_tokens: 0`) for instant replies.
 *    - Smart Thinking/Research Mode: Detects when a question requires deep thinking/research,
 *      provides instant "Ek second, abhi batata hoon..." filler speech + full answer.
 * 3. TTS (Text-to-Speech):
 *    - Model: Google AI Studio `gemini-2.5-flash-preview-tts` (24kHz PCM wrapped as playable WAV)
 *
 * Security:
 * - Reads OPENCODE_API_KEY and GEMINI_API_KEY (or GOOGLE_API_KEY / GOOGLE_AI_STUDIO_API_KEY)
 *   strictly from Environment Variables. Zero hardcoded keys in source code.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Load local .env file if present (for local dev; on Render use Environment Variables)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx !== -1) {
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// ─── Configuration (Strictly via Environment Variables) ──────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const OPENCODE_API_KEY = (process.env.OPENCODE_API_KEY || "").trim();

// Accepts GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_AI_STUDIO_API_KEY from Render Environment
const rawGeminiKeys =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_AI_STUDIO_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_API_KEYS = rawGeminiKeys
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let geminiKeyIndex = 0;
function getGeminiApiKey() {
  if (GEMINI_API_KEYS.length === 0) return "";
  const key = GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length];
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
  return key;
}

const UPSTREAM_URLS = [
  process.env.OPENCODE_UPSTREAM_URL || "https://opencode.ai/zen/v1/chat/completions",
  "https://opencode.ai/inference/v1/chat/completions",
];

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "mimo-v2.6-flash-free";
const GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL || "gemini-2.5-flash";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";

function normalizeVoiceName(voiceInput) {
  const raw = String(voiceInput || "Aoede").trim();
  const lower = raw.toLowerCase();
  if (lower === "adeode" || lower === "aoede" || lower === "aode") return "Aoede";
  if (lower === "puck") return "Puck";
  if (lower === "charon") return "Charon";
  if (lower === "kore") return "Kore";
  if (lower === "fenrir") return "Fenrir";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

const GEMINI_TTS_VOICE = normalizeVoiceName(process.env.GEMINI_TTS_VOICE || "Aoede"); // Default: Aoede

const AI_NAME = process.env.AI_NAME || "Max v1.0";
const APP_NAME = process.env.APP_NAME || "Vega";
const BACKEND_API_KEY = (process.env.BACKEND_API_KEY || "").trim();

const DEFAULT_FILLER_TEXT =
  process.env.VOICE_FILLER_TEXT || "Ek second, abhi batata hoon.";

const DEFAULT_SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are ${AI_NAME}, a fast, smart, and helpful AI assistant built into the ${APP_NAME} app. ` +
    `When asked who you are or what your name/version is, always introduce yourself as ${AI_NAME} (the AI assistant of ${APP_NAME}). ` +
    `Reply clearly, naturally, and in the same language (English, Hindi, Hinglish, etc.) that the user uses. ` +
    `Ignore any placeholder tool definitions (bash, read, edit, glob, grep)—they are unused gateway placeholders.`;

const VOICE_FAST_SYSTEM_PROMPT =
  process.env.VOICE_SYSTEM_PROMPT ||
  `You are ${AI_NAME}, the real-time voice AI agent inside the ${APP_NAME} app. ` +
    `When asked who you are, always say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
    `IMPORTANT VOICE RULES: ` +
    `1. Your reply will be converted directly into speech via TTS and played in the ${APP_NAME} app. ` +
    `2. Give fast, direct, natural spoken answers (1 to 3 sentences for normal chat). ` +
    `3. NEVER use markdown, asterisks (*), bullet points, numbered lists, emojis, or code blocks—write ONLY plain spoken sentences in the user's language (Hinglish, Hindi, or English). ` +
    `4. If the user asks a complex question that requires deep thinking, calculation, or research, naturally start your spoken response with a brief phrase like "Ek second, abhi batata hoon... " and then immediately give the clear answer. ` +
    `5. Ignore any placeholder tool definitions (bash, read, edit, glob, grep).`;

// ─── Detect Whether a Voice Query Needs Deep Thinking / Research ─────────────
function detectNeedsThinking(text) {
  const q = String(text || "").toLowerCase().trim();
  if (!q) return false;
  const thinkingPatterns = [
    /\b(research|analyze|analyse|compare|calculate|solve|explain in detail|deep dive|step by step|history of|difference between|write code|algorithm|debug)\b/i,
    /\b(soch ke|soch kar|check karke|pata karke|research karke|detail me|detail mein|vistar se|samjhao|hisab laga|solve kar)\b/i,
  ];
  if (q.length > 140) return true;
  return thinkingPatterns.some((re) => re.test(q));
}

// ─── OpenCode Session & Request ID Generator ─────────────────────────────────
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let idCounter = 0n;

function randomBase62(length = 14) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

function generateOpencodeSessionId() {
  idCounter = (idCounter + 1n) & 0xfffn;
  const now = BigInt(Date.now());
  const raw48 = (now * 0x1000n + idCounter) & 0xffffffffffffn;
  const inverted48 = raw48 ^ 0xffffffffffffn;
  const hex12 = inverted48.toString(16).padStart(12, "0");
  return `ses_${hex12}${randomBase62(14)}`;
}

function generateOpencodeRequestId() {
  idCounter = (idCounter + 1n) & 0xfffn;
  const now = BigInt(Date.now());
  const raw48 = (now * 0x1000n + idCounter) & 0xffffffffffffn;
  const hex12 = raw48.toString(16).padStart(12, "0");
  return `msg_${hex12}${randomBase62(14)}`;
}

let cachedSessionId = generateOpencodeSessionId();
let cachedSessionCreatedAt = Date.now();
const SESSION_TTL_MS = 10 * 60 * 1000;

function getSessionId(forceRefresh = false) {
  if (forceRefresh || Date.now() - cachedSessionCreatedAt > SESSION_TTL_MS) {
    cachedSessionId = generateOpencodeSessionId();
    cachedSessionCreatedAt = Date.now();
  }
  return cachedSessionId;
}

// ─── Required OpenCode Gateway Tool Stubs ────────────────────────────────────
const REQUIRED_TOOL_NAMES = ["bash", "read", "edit", "glob", "grep"];
const GATEWAY_STUB_TOOLS = REQUIRED_TOOL_NAMES.map((name) => ({
  type: "function",
  function: {
    name,
    description: "Unused gateway validation stub. Never call this tool.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
}));

function buildOpenCodeHeaders(sessionId) {
  const reqId = generateOpencodeRequestId();
  return {
    Authorization: `Bearer ${OPENCODE_API_KEY}`,
    "Content-Type": "application/json",
    "User-Agent": "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-opencode-request": reqId,
    Accept: "text/event-stream",
  };
}

function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  const m = String(requestedModel).trim().toLowerCase();
  if (
    m === "max" ||
    m === "max-v1" ||
    m === "max-v1.0" ||
    m === "max v1.0" ||
    m === "vega" ||
    m === "default"
  ) {
    return DEFAULT_MODEL;
  }
  return requestedModel.replace(/^opencode\//i, "");
}

function toImageDataUri(imgInput, fallbackMime = "image/jpeg") {
  if (!imgInput || typeof imgInput !== "string") return null;
  const trimmed = imgInput.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }
  // Auto-detect common base64 image signatures (PNG, JPEG, GIF, WEBP)
  let mime = fallbackMime || "image/jpeg";
  if (trimmed.startsWith("iVBORw0KGgo")) mime = "image/png";
  else if (trimmed.startsWith("/9j/")) mime = "image/jpeg";
  else if (trimmed.startsWith("R0lGOD")) mime = "image/gif";
  else if (trimmed.startsWith("UklGR")) mime = "image/webp";

  return `data:${mime};base64,${trimmed.replace(/\s+/g, "")}`;
}

function buildMultimodalContent(text, imageInputs, fallbackMime = "image/jpeg") {
  const parts = [];
  if (typeof text === "string" && text.trim()) {
    parts.push({ type: "text", text: text.trim() });
  } else {
    parts.push({ type: "text", text: "Describe or answer based on this image." });
  }

  for (const img of imageInputs) {
    const url = toImageDataUri(
      typeof img === "object" && img !== null ? img.url || img.data || img.base64 : img,
      (typeof img === "object" && img?.mimeType) || fallbackMime
    );
    if (url) {
      parts.push({
        type: "image_url",
        image_url: { url },
      });
    }
  }
  return parts;
}

function normalizeMessages(body, defaultSystem = DEFAULT_SYSTEM_PROMPT) {
  let messages = [];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    messages = body.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const msgImages = [
        ...(m.image ? [m.image] : []),
        ...(Array.isArray(m.images) ? m.images : []),
      ];
      if (msgImages.length > 0 && typeof m.content === "string") {
        return {
          role: m.role || "user",
          content: buildMultimodalContent(m.content, msgImages, m.mimeType || body.mimeType),
        };
      }
      return m;
    });
  } else {
    if (Array.isArray(body.history)) {
      for (const item of body.history) {
        if (item && item.role && item.content) {
          const histImages = [
            ...(item.image ? [item.image] : []),
            ...(Array.isArray(item.images) ? item.images : []),
          ];
          messages.push({
            role: item.role,
            content:
              histImages.length > 0
                ? buildMultimodalContent(String(item.content), histImages, item.mimeType)
                : String(item.content),
          });
        }
      }
    }

    const userText = body.message ?? body.prompt ?? body.text ?? body.query ?? "";
    const topImages = [
      ...(body.image ? [body.image] : []),
      ...(body.imageUrl ? [body.imageUrl] : []),
      ...(body.imageBase64 ? [body.imageBase64] : []),
      ...(Array.isArray(body.images) ? body.images : []),
    ];

    if (topImages.length > 0) {
      messages.push({
        role: "user",
        content: buildMultimodalContent(
          typeof userText === "string" ? userText : "",
          topImages,
          body.mimeType || "image/jpeg"
        ),
      });
    } else if (typeof userText === "string" && userText.trim()) {
      messages.push({ role: "user", content: userText.trim() });
    }
  }

  const hasSystem = messages.some(
    (m) => m && (m.role === "system" || m.role === "developer")
  );
  const customSystem = body.system || body.systemPrompt;
  if (customSystem) {
    messages.unshift({ role: "system", content: String(customSystem) });
  } else if (!hasSystem) {
    messages.unshift({ role: "system", content: defaultSystem });
  }

  return messages;
}

// ─── Step 2 (LLM): OpenCode Upstream Call (`mimo-v2.6-flash-free`) ──────────
async function callOpenCodeUpstream(payload) {
  if (!OPENCODE_API_KEY) {
    return {
      ok: false,
      status: 500,
      errorText:
        "Server misconfiguration: OPENCODE_API_KEY environment variable is not set.",
    };
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const existingNames = new Set(
    existingTools
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean)
  );
  const missingStubs = GATEWAY_STUB_TOOLS.filter(
    (s) => !existingNames.has(s.function.name)
  );

  const userProvidedRealTools = existingTools.length > 0;
  const disableReasoning = payload.disableReasoning === true;

  const upstreamBody = {
    model: resolveModel(payload.model),
    messages: payload.messages,
    stream: true,
    tools: [...existingTools, ...missingStubs],
    tool_choice: userProvidedRealTools ? payload.tool_choice || "auto" : "none",
    ...(disableReasoning
      ? {
          reasoning_effort: "none",
          reasoning: { enabled: false, effort: "none" },
          thinking: { type: "disabled" },
        }
      : {}),
  };

  if (typeof payload.temperature === "number") {
    upstreamBody.temperature = payload.temperature;
  }
  if (typeof payload.max_tokens === "number") {
    upstreamBody.max_tokens = payload.max_tokens;
  }

  const bodyJson = JSON.stringify(upstreamBody);

  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = getSessionId(attempt > 0);
    const upstreamUrl = UPSTREAM_URLS[attempt % UPSTREAM_URLS.length];

    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: buildOpenCodeHeaders(sessionId),
      body: bodyJson,
    });

    if (response.ok) {
      return { ok: true, response, model: upstreamBody.model, sessionId };
    }

    const errText = await response.text().catch(() => "");
    if (response.status === 403 && attempt === 0) {
      continue;
    }

    return {
      ok: false,
      status: response.status,
      errorText: errText || `Upstream returned HTTP ${response.status}`,
    };
  }
}

async function collectSSEStream(response, fallbackModel) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      try {
        const chunk = JSON.parse(dataStr);
        if (chunk.id) id = chunk.id;
        if (chunk.created) created = chunk.created;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (choice) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          if (typeof delta.content === "string") {
            content += delta.content;
          }
          if (typeof delta.reasoning === "string") {
            reasoning += delta.reasoning;
          }
        }
      } catch {
        // Ignore keep-alive comments
      }
    }
  }

  return { id, created, model, content, reasoning, finishReason, usage };
}

// ─── Audio / WAV Helpers for Gemini STT & TTS ────────────────────────────────
function normalizeAudioMimeType(rawMime, fallback = "audio/wav") {
  const clean = String(rawMime || fallback)
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!clean || !clean.includes("/")) return fallback;
  return clean;
}

function parseBase64AudioInput(audioInput, fallbackMimeType = "audio/wav") {
  if (!audioInput || typeof audioInput !== "string") {
    throw new Error("Missing or invalid 'audio' base64 string in request body.");
  }
  const trimmed = audioInput.trim();

  // Handle any Data URI: e.g. "data:audio/webm;codecs=opus;base64,GkXfo..." or "data:audio/wav;base64,UklGR..."
  if (trimmed.startsWith("data:")) {
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx !== -1) {
      const header = trimmed.slice(5, commaIdx); // e.g. "audio/webm;codecs=opus;base64"
      const dataPart = trimmed.slice(commaIdx + 1);
      const mimeType = normalizeAudioMimeType(header, fallbackMimeType);
      return {
        mimeType,
        base64Data: dataPart.replace(/\s+/g, ""),
      };
    }
  }

  return {
    mimeType: normalizeAudioMimeType(fallbackMimeType, "audio/wav"),
    base64Data: trimmed.replace(/\s+/g, ""),
  };
}

/**
 * Wraps raw 16-bit signed little-endian PCM (24kHz mono) from Gemini TTS
 * into a standard 44-byte RIFF WAVE file buffer so Vega app can play it directly.
 */
function pcm16ToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function cleanTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Step 1 (STT): Gemini Speech-to-Text (with automatic model fallback) ─────
let resolvedSttModel = null;

async function resolveWorkingGeminiSttModel(apiKey) {
  if (resolvedSttModel) return resolvedSttModel;
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey
    )}`;
    const res = await fetch(listUrl);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(
          (m) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes("generateContent")
        )
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .filter(
          (name) =>
            name.startsWith("gemini-") &&
            !name.includes("tts") &&
            !name.includes("image") &&
            !name.includes("embedding") &&
            !name.includes("veo") &&
            !name.includes("imagen")
        );

      const preferredOrder = [
        "gemini-3.8-flash",
        "gemini-2.5-flash-lite",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
      ];
      for (const pref of preferredOrder) {
        if (models.includes(pref)) {
          resolvedSttModel = pref;
          return resolvedSttModel;
        }
      }
      const anyFlash = models.find((n) => n.includes("flash"));
      if (anyFlash) {
        resolvedSttModel = anyFlash;
        return resolvedSttModel;
      }
    }
  } catch {
    // Ignore model listing errors
  }
  return "gemini-3.8-flash";
}

async function transcribeWithGeminiSTT({ audioBase64, mimeType = "audio/wav", languageHint = "" }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Server misconfiguration: GEMINI_API_KEY (Google AI Studio API Key) environment variable is not set."
    );
  }

  const promptText = languageHint
    ? `Transcribe this spoken audio accurately (${languageHint}). Return ONLY the exact spoken words without any extra commentary, timestamps, or quotes. If there is only silence or noise, return an empty string.`
    : `Transcribe this spoken audio accurately. Return ONLY the exact spoken words without any extra commentary, timestamps, or quotes. If there is only silence or noise, return an empty string.`;

  const candidateModels = [
    ...(resolvedSttModel ? [resolvedSttModel] : []),
    GEMINI_STT_MODEL,
    "gemini-3.8-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
  ];

  const tried = new Set();
  let lastError = "";
  const cleanMimeType = normalizeAudioMimeType(mimeType, "audio/wav");

  for (let i = 0; i < candidateModels.length; i++) {
    let modelName = candidateModels[i];
    if (!modelName || tried.has(modelName)) continue;
    tried.add(modelName);

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      modelName
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: cleanMimeType,
                  data: audioBase64,
                },
              },
              { text: promptText },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
        },
      }),
    });

    if (res.ok) {
      resolvedSttModel = modelName;
      const data = await res.json();
      const transcript = (
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join(" ") || ""
      ).trim();

      return {
        model: modelName,
        transcript,
      };
    }

    const errText = await res.text().catch(() => "");
    lastError = `Gemini STT (${modelName}) error [${res.status}]: ${errText}`;

    // Retry with next Flash model on 404 (not found), 429 (rate limit), or 503/500 (high demand)
    if (res.status === 404 || res.status === 429 || res.status >= 500) {
      if (res.status === 404) {
        const discovered = await resolveWorkingGeminiSttModel(apiKey);
        if (discovered && !tried.has(discovered)) {
          candidateModels.splice(i + 1, 0, discovered);
        }
      }
      continue;
    }

    break;
  }

  throw new Error(lastError || "Gemini STT failed");
}

// ─── Step 3 (TTS): Gemini 2.5 Flash Preview TTS (`gemini-2.5-flash-preview-tts`) ───
async function synthesizeWithGeminiTTS({ text, voice }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Server misconfiguration: GEMINI_API_KEY (Google AI Studio API Key) environment variable is not set."
    );
  }

  const selectedVoice = normalizeVoiceName(voice || GEMINI_TTS_VOICE || "Aoede");
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) {
    throw new Error("Cannot synthesize empty text for TTS.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_TTS_MODEL
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const ttsPrompt = `Read the following text aloud exactly as written, without adding or changing any words:\n${spokenText}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: ttsPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: selectedVoice,
            },
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini TTS (${GEMINI_TTS_MODEL}) error [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  const inlineData = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;

  if (!inlineData || !inlineData.data) {
    throw new Error(`Gemini TTS (${GEMINI_TTS_MODEL}) did not return audio data.`);
  }

  const rawMime = inlineData.mimeType || "audio/L16;codec=pcm;rate=24000";
  const rateMatch = rawMime.match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;

  const pcmBuffer = Buffer.from(inlineData.data, "base64");
  const wavBuffer = pcm16ToWavBuffer(pcmBuffer, sampleRate, 1, 16);
  const wavBase64 = wavBuffer.toString("base64");

  return {
    model: GEMINI_TTS_MODEL,
    voice: selectedVoice,
    sampleRate,
    mimeType: "audio/wav",
    wavBuffer,
    wavBase64,
    dataUri: `data:audio/wav;base64,${wavBase64}`,
  };
}

// In-memory cache for filler audio ("Ek second, abhi batata hoon.") per voice
// so subsequent filler audio plays in 0ms!
const fillerAudioCache = new Map();

async function getFillerAudio(voice = GEMINI_TTS_VOICE, customFillerText = DEFAULT_FILLER_TEXT) {
  const key = `${voice}::${customFillerText}`;
  if (fillerAudioCache.has(key)) {
    return fillerAudioCache.get(key);
  }
  const tts = await synthesizeWithGeminiTTS({
    text: customFillerText,
    voice,
  });
  const cached = {
    text: customFillerText,
    mimeType: tts.mimeType,
    sampleRate: tts.sampleRate,
    voice: tts.voice,
    base64: tts.wavBase64,
    dataUri: tts.dataUri,
  };
  fillerAudioCache.set(key, cached);
  return cached;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key"
  );
}

function sendJson(res, status, data) {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendSSEEvent(res, eventName, dataObj) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Payload too large (max 25MB)"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req) {
  if (!BACKEND_API_KEY) return true;
  const authHeader = req.headers["authorization"] || "";
  const apiKeyHeader = req.headers["x-api-key"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || apiKeyHeader;
  return token === BACKEND_API_KEY;
}

// ─── Pure Headless HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // 1. Root & Health Check (Pure JSON — No Web UI)
  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/api/health" || pathname === "/health")
  ) {
    return sendJson(res, 200, {
      ok: true,
      status: "online",
      service: `${AI_NAME} Backend & Voice Agent API`,
      app: APP_NAME,
      models: {
        stt: GEMINI_STT_MODEL,
        llm: DEFAULT_MODEL,
        tts: GEMINI_TTS_MODEL,
        ttsDefaultVoice: GEMINI_TTS_VOICE,
      },
      voiceAgentConfig: {
        fastNoReasoningByDefault: true,
        smartFillerEnabled: true,
        defaultFillerPhrase: DEFAULT_FILLER_TEXT,
      },
      configuredKeys: {
        OPENCODE_API_KEY: Boolean(OPENCODE_API_KEY),
        GEMINI_API_KEY: GEMINI_API_KEYS.length > 0,
      },
      endpoints: {
        textAndImageChat: "POST /api/chat",
        visionChat: "POST /api/vision",
        voiceAgent: "POST /api/voice",
        voiceFillerAudio: "GET /api/voice/filler",
        speechToText: "POST /api/stt",
        textToSpeech: "POST /api/tts",
        openAICompatible: "POST /v1/chat/completions",
        models: "GET /v1/models",
        health: "GET /api/health",
      },
    });
  }

  // 2. OpenAI Models Endpoint
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    return sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: "max-v1.0",
          object: "model",
          created: 1700000000,
          owned_by: APP_NAME.toLowerCase(),
        },
        {
          id: DEFAULT_MODEL,
          object: "model",
          created: 1700000000,
          owned_by: "opencode-zen",
        },
        {
          id: GEMINI_STT_MODEL,
          object: "model",
          created: 1700000000,
          owned_by: "google-gemini-stt",
        },
        {
          id: GEMINI_TTS_MODEL,
          object: "model",
          created: 1700000000,
          owned_by: "google-gemini-tts",
        },
      ],
    });
  }

  // Optional Backend API Key check
  if (!checkAuth(req)) {
    return sendJson(res, 401, {
      success: false,
      error: "Unauthorized: Invalid or missing BACKEND_API_KEY",
    });
  }

  // 3. Pre-Cached Filler Audio Endpoint: GET /api/voice/filler
  //    Returns "Ek second, abhi batata hoon." WAV audio for Vega App instant playback
  if (req.method === "GET" && pathname === "/api/voice/filler") {
    try {
      const voice = url.searchParams.get("voice") || GEMINI_TTS_VOICE;
      const text = url.searchParams.get("text") || DEFAULT_FILLER_TEXT;
      const filler = await getFillerAudio(voice, text);
      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        filler,
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Failed to generate filler audio",
      });
    }
  }

  // 4. Standalone STT Endpoint: POST /api/stt (`gemini-2.5-flash`)
  if (req.method === "POST" && pathname === "/api/stt") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }

    try {
      const { mimeType, base64Data } = parseBase64AudioInput(
        body.audio || body.audioBase64,
        body.mimeType || "audio/wav"
      );
      const sttResult = await transcribeWithGeminiSTT({
        audioBase64: base64Data,
        mimeType,
        languageHint: body.language || "",
      });

      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: sttResult.model,
        transcript: sttResult.transcript,
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "STT failed",
      });
    }
  }

  // 5. Standalone TTS Endpoint: POST /api/tts (`gemini-2.5-flash-preview-tts`)
  if (req.method === "POST" && pathname === "/api/tts") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }

    const text = body.text ?? body.message ?? body.reply;
    if (!text || typeof text !== "string" || !text.trim()) {
      return sendJson(res, 400, {
        success: false,
        error: 'Please provide "text" (string) in the JSON body.',
      });
    }

    try {
      const ttsResult = await synthesizeWithGeminiTTS({
        text,
        voice: body.voice,
      });

      if (body.format === "wav-binary" || req.headers["accept"] === "audio/wav") {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": ttsResult.wavBuffer.length,
        });
        return res.end(ttsResult.wavBuffer);
      }

      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: ttsResult.model,
        voice: ttsResult.voice,
        audio: {
          mimeType: ttsResult.mimeType,
          sampleRate: ttsResult.sampleRate,
          base64: ttsResult.wavBase64,
          dataUri: ttsResult.dataUri,
        },
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "TTS failed",
      });
    }
  }

  // 6. Full Voice Agent Endpoint: POST /api/voice (or /api/voice-agent)
  //    Pipeline:
  //    [1] STT: `gemini-2.5-flash`
  //    [2] LLM: `mimo-v2.6-flash-free` (Max v1.0, Fast No-Reasoning by default, or Smart Filler if research needed)
  //    [3] TTS: `gemini-2.5-flash-preview-tts` (Playable 24kHz WAV output for Vega App)
  if (
    req.method === "POST" &&
    (pathname === "/api/voice" || pathname === "/api/voice-agent" || pathname === "/voice")
  ) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }

    const wantsStream = body.stream === true;
    const selectedVoice = (body.voice || GEMINI_TTS_VOICE || "Puck").trim();

    try {
      // Step 1: Speech-to-Text (`gemini-2.5-flash`)
      let userTranscript = (body.text ?? body.message ?? "").trim();
      const audioInput = body.audio || body.audioBase64;

      if (!userTranscript && audioInput) {
        const { mimeType, base64Data } = parseBase64AudioInput(
          audioInput,
          body.mimeType || "audio/wav"
        );
        const sttResult = await transcribeWithGeminiSTT({
          audioBase64: base64Data,
          mimeType,
          languageHint: body.language || "",
        });
        userTranscript = sttResult.transcript;
      }

      if (!userTranscript) {
        return sendJson(res, 400, {
          success: false,
          error:
            "No speech detected in audio (or empty input). Please send 'audio' (base64) or 'message' (text).",
          transcript: "",
        });
      }

      // Check if this voice query requires deep thinking / research
      const needsThinking =
        typeof body.thinking === "boolean"
          ? body.thinking
          : detectNeedsThinking(userTranscript);

      // By default in voice mode: disable reasoning for ultra-fast response!
      // Only enable reasoning if the user explicitly asked for deep thinking (`body.reasoning === true`).
      const disableReasoning = body.reasoning === true ? false : true;

      // If client requested SSE stream (`stream: true`), emit transcript & instant filler audio first!
      if (wantsStream) {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        sendSSEEvent(res, "transcript", {
          type: "transcript",
          transcript: userTranscript,
          needsThinking,
        });

        if (needsThinking && body.tts !== false) {
          try {
            const filler = await getFillerAudio(
              selectedVoice,
              body.fillerText || DEFAULT_FILLER_TEXT
            );
            sendSSEEvent(res, "filler", {
              type: "filler",
              text: filler.text,
              audio: filler,
            });
          } catch {
            // Continue even if filler TTS fails
          }
        }
      }

      // Step 2: Middle LLM (`mimo-v2.6-flash-free` via OpenCode as Max v1.0)
      // Start filler audio generation in parallel if needsThinking is true (for non-streaming JSON mode)
      const fillerPromise =
        !wantsStream && needsThinking && body.tts !== false
          ? getFillerAudio(selectedVoice, body.fillerText || DEFAULT_FILLER_TEXT).catch(() => null)
          : Promise.resolve(null);

      const llmMessages = normalizeMessages(
        {
          history: body.history,
          system: body.system || body.systemPrompt,
          message: userTranscript,
        },
        VOICE_FAST_SYSTEM_PROMPT
      );

      const llmUpstream = await callOpenCodeUpstream({
        model: body.model || DEFAULT_MODEL,
        messages: llmMessages,
        temperature: body.temperature ?? 0.6,
        max_tokens: body.max_tokens,
        disableReasoning,
      });

      if (!llmUpstream.ok) {
        const errPayload = {
          success: false,
          error: "Middle LLM (OpenCode mimo-v2.6-flash-free) error",
          details: llmUpstream.errorText,
          transcript: userTranscript,
        };
        if (wantsStream) {
          sendSSEEvent(res, "error", errPayload);
          return res.end();
        }
        return sendJson(res, llmUpstream.status || 502, errPayload);
      }

      const assembled = await collectSSEStream(llmUpstream.response, llmUpstream.model);
      const replyText = assembled.content.trim();

      // Step 3: Text-to-Speech (`gemini-2.5-flash-preview-tts`)
      let audioOutput = null;
      if (body.tts !== false && replyText) {
        const ttsResult = await synthesizeWithGeminiTTS({
          text: replyText,
          voice: selectedVoice,
        });
        audioOutput = {
          mimeType: ttsResult.mimeType,
          sampleRate: ttsResult.sampleRate,
          voice: ttsResult.voice,
          base64: ttsResult.wavBase64,
          dataUri: ttsResult.dataUri,
        };
      }

      const fillerAudio = await fillerPromise;

      const finalPayload = {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        pipeline: {
          sttModel: GEMINI_STT_MODEL,
          llmModel: assembled.model,
          ttsModel: GEMINI_TTS_MODEL,
          voice: selectedVoice,
          fastNoReasoning: disableReasoning,
          needsThinking,
        },
        transcript: userTranscript,
        ...(needsThinking
          ? {
              fillerText: body.fillerText || DEFAULT_FILLER_TEXT,
              fillerAudio,
            }
          : {}),
        reply: replyText,
        reasoning: assembled.reasoning || null,
        audio: audioOutput,
        usage: assembled.usage,
      };

      if (wantsStream) {
        sendSSEEvent(res, "response", finalPayload);
        res.write("event: done\ndata: [DONE]\n\n");
        return res.end();
      }

      return sendJson(res, 200, finalPayload);
    } catch (err) {
      if (wantsStream && res.headersSent) {
        sendSSEEvent(res, "error", {
          success: false,
          error: err.message || "Voice agent pipeline error",
        });
        return res.end();
      }
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Voice agent pipeline error",
      });
    }
  }

  // 7. Vega App Normal Agent (Text-to-Text AND Image + Text-to-Text): POST /api/chat (or /api/vision)
  if (
    req.method === "POST" &&
    (pathname === "/api/chat" ||
      pathname === "/chat" ||
      pathname === "/api/vision" ||
      pathname === "/vision")
  ) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }

    const messages = normalizeMessages(body, DEFAULT_SYSTEM_PROMPT);
    if (messages.length === 0 || !messages.some((m) => m.role === "user")) {
      return sendJson(res, 400, {
        success: false,
        error: 'Please provide "message" (string) or "messages" (array) in the JSON body.',
      });
    }

    try {
      const disableReasoning = body.fast === true || body.reasoning === false;
      const result = await callOpenCodeUpstream({
        model: body.model || DEFAULT_MODEL,
        messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        disableReasoning,
      });

      if (!result.ok) {
        return sendJson(res, result.status || 502, {
          success: false,
          error: "Upstream OpenCode API error",
          details: result.errorText,
        });
      }

      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const reader = result.response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return res.end();
      }

      const assembled = await collectSSEStream(result.response, result.model);
      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: assembled.model,
        reply: assembled.content,
        reasoning: assembled.reasoning || null,
        usage: assembled.usage,
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Internal server error",
      });
    }
  }

  // 8. OpenAI-Compatible Endpoint: POST /v1/chat/completions
  if (
    req.method === "POST" &&
    (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
  ) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
    }

    const messages = normalizeMessages(body, DEFAULT_SYSTEM_PROMPT);
    const wantsStream = body.stream === true;
    const disableReasoning =
      body.reasoning_effort === "none" || body.fast === true || body.reasoning === false;

    try {
      const result = await callOpenCodeUpstream({
        model: body.model || DEFAULT_MODEL,
        messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        disableReasoning,
      });

      if (!result.ok) {
        return sendJson(res, result.status || 502, {
          error: {
            message: result.errorText,
            type: "upstream_error",
          },
        });
      }

      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const reader = result.response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return res.end();
      }

      const assembled = await collectSSEStream(result.response, result.model);
      return sendJson(res, 200, {
        id: assembled.id,
        object: "chat.completion",
        created: assembled.created,
        model: assembled.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: assembled.content,
              ...(assembled.reasoning ? { reasoning: assembled.reasoning } : {}),
            },
            finish_reason: assembled.finishReason || "stop",
          },
        ],
        usage: assembled.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    } catch (err) {
      return sendJson(res, 500, {
        error: {
          message: err.message || "Internal server error",
          type: "server_error",
        },
      });
    }
  }

  return sendJson(res, 404, {
    success: false,
    error: `Route ${req.method} ${pathname} not found. Available routes: POST /api/voice, GET /api/voice/filler, POST /api/stt, POST /api/tts, POST /api/chat, POST /v1/chat/completions`,
  });
});

server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 ${AI_NAME} (${APP_NAME}) Backend & Voice Agent API on http://${HOST}:${PORT}`);
  console.log(`🔑 OPENCODE_API_KEY: ${OPENCODE_API_KEY ? "Configured (env)" : "MISSING"}`);
  console.log(`🔑 GEMINI_API_KEY:   ${GEMINI_API_KEYS.length > 0 ? `Configured (${GEMINI_API_KEYS.length} key(s))` : "MISSING"}`);
  console.log(`🎙️ Voice Pipeline:   ${GEMINI_STT_MODEL} (STT) -> ${DEFAULT_MODEL} [No-Reasoning Fast Mode] -> ${GEMINI_TTS_MODEL} (TTS)`);
  console.log(`====================================================`);
});
