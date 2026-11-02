/**
 * Grace — Isolated AI agent for the Intridium app.
 *
 * Completely separate from Max v1.0 / Vega:
 *  - Own routes: POST /api/grace, POST /api/intridium
 *  - Own persona: Grace (never Max / Vega)
 *  - Image generation YES (NVIDIA FLUX.3 Klein), image editing NO
 *  - Chat + image data stored ONLY under data/intridium_grace/
 *    (never ai_chats / ai_messages / Vega Storage)
 *
 * Unsigned / no-email chats are always saved as userKey = "guest".
 * No email or guest identity is required to hit the API — data still stores.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GRACE_AI_NAME = "Grace";
const GRACE_APP_NAME = "Intridium";
const GRACE_STORE_DIR = path.join(__dirname, "data", "intridium_grace");
const GRACE_CHATS_DIR = path.join(GRACE_STORE_DIR, "chats");
const GRACE_IMAGES_DIR = path.join(GRACE_STORE_DIR, "images");
const GRACE_INDEX_PATH = path.join(GRACE_STORE_DIR, "index.json");

const graceImagesMem = new Map();

function ensureGraceDirs() {
  for (const dir of [GRACE_STORE_DIR, GRACE_CHATS_DIR, GRACE_IMAGES_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

function loadGraceIndex() {
  ensureGraceDirs();
  try {
    if (fs.existsSync(GRACE_INDEX_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(GRACE_INDEX_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.users) return parsed;
    }
  } catch {}
  return { users: {} };
}

function saveGraceIndex(index) {
  ensureGraceDirs();
  try {
    fs.writeFileSync(GRACE_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  } catch {}
}

function slugPart(value) {
  return String(value || "guest")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "guest";
}

function resolveGraceIdentity(body = {}, req = null) {
  const email = String(
    (body && (body.user || body.email || body.userId || body.user_id || body.signedInEmail)) || ""
  )
    .trim()
    .toLowerCase();
  // Only a real email is treated as signed-in identity.
  // No email / no guestId / direct API hit → store everything under the name "guest".
  if (email && email.includes("@") && email.length <= 120) {
    return {
      userKey: email,
      isGuest: false,
      guestId: null,
      signedInEmail: email,
    };
  }
  return {
    userKey: "guest",
    isGuest: true,
    guestId: "guest",
    guestIdGenerated: false,
    signedInEmail: null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeGraceChatId(userKey) {
  return `grace_chat_${slugPart(userKey)}_${Date.now()}`;
}

function makeGraceMsgId(chatId, seq) {
  return `grace_msg_${chatId}_${String(seq).padStart(4, "0")}`;
}

function chatPath(chatId) {
  const safe = String(chatId || "").replace(/[^A-Za-z0-9._-]/g, "");
  return path.join(GRACE_CHATS_DIR, `${safe}.json`);
}

function readGraceChat(chatId) {
  const p = chatPath(chatId);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeGraceChat(chat) {
  ensureGraceDirs();
  fs.writeFileSync(chatPath(chat.id), JSON.stringify(chat, null, 2), "utf8");
}

function touchUserIndex(identity, chatId) {
  const index = loadGraceIndex();
  if (!index.users[identity.userKey]) {
    index.users[identity.userKey] = {
      userKey: identity.userKey,
      isGuest: identity.isGuest,
      guestId: identity.guestId,
      signedInEmail: identity.signedInEmail,
      chatIds: [],
      created_at: nowIso(),
    };
  }
  const rec = index.users[identity.userKey];
  rec.updated_at = nowIso();
  if (chatId && !rec.chatIds.includes(chatId)) rec.chatIds.unshift(chatId);
  saveGraceIndex(index);
  return rec;
}

function listGraceChats(identity, limit = 50) {
  const index = loadGraceIndex();
  const rec = index.users[identity.userKey];
  if (!rec) return [];
  const out = [];
  for (const id of rec.chatIds || []) {
    const chat = readGraceChat(id);
    if (!chat || chat.user !== identity.userKey) continue;
    const { messages, ...meta } = chat;
    out.push({ ...meta, messageCount: Array.isArray(messages) ? messages.length : 0 });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return out;
}

function createGraceChat(identity, title = "New chat") {
  const chat = {
    id: makeGraceChatId(identity.userKey),
    user: identity.userKey,
    isGuest: identity.isGuest,
    guestId: identity.guestId,
    signedInEmail: identity.signedInEmail,
    app: GRACE_APP_NAME,
    ai: GRACE_AI_NAME,
    store: "intridium_grace",
    title: String(title || "New chat").slice(0, 60),
    created_at: nowIso(),
    updated_at: nowIso(),
    turns: 0,
    last_text: "",
    messages: [],
  };
  writeGraceChat(chat);
  touchUserIndex(identity, chat.id);
  return chat;
}

function titleFromText(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "New chat";
  return t.slice(0, 60);
}

function appendGraceTurns(identity, chatId, turns) {
  let chat = chatId ? readGraceChat(chatId) : null;
  if (chat && chat.user !== identity.userKey) chat = null;
  if (!chat) {
    const firstUser = (turns || []).find((t) => t && t.role === "user");
    chat = createGraceChat(identity, titleFromText(firstUser && firstUser.text));
  }
  const list = Array.isArray(chat.messages) ? chat.messages : [];
  for (const turn of turns || []) {
    if (!turn || !turn.text) continue;
    list.push({
      id: makeGraceMsgId(chat.id, list.length + 1),
      chat_id: chat.id,
      user: identity.userKey,
      role: turn.role === "user" ? "user" : "ai",
      text: String(turn.text).slice(0, 20000),
      kind: turn.kind || (turn.imageId ? "image" : "text"),
      imageId: turn.imageId || undefined,
      imageUrl: turn.imageUrl || undefined,
      thinking: turn.thinking || undefined,
      at: turn.at || nowIso(),
    });
  }
  chat.messages = list;
  chat.turns = list.length;
  chat.updated_at = nowIso();
  const last = list[list.length - 1];
  chat.last_text = last ? String(last.text || "").slice(0, 120) : chat.last_text;
  if (chat.title === "New chat") {
    const firstUser = list.find((m) => m.role === "user");
    if (firstUser) chat.title = titleFromText(firstUser.text);
  }
  writeGraceChat(chat);
  touchUserIndex(identity, chat.id);
  return chat;
}

function deleteGraceChat(identity, chatId) {
  const chat = readGraceChat(chatId);
  if (!chat || chat.user !== identity.userKey) return false;
  try {
    fs.unlinkSync(chatPath(chatId));
  } catch {}
  const index = loadGraceIndex();
  const rec = index.users[identity.userKey];
  if (rec && Array.isArray(rec.chatIds)) {
    rec.chatIds = rec.chatIds.filter((id) => id !== chatId);
    rec.updated_at = nowIso();
    saveGraceIndex(index);
  }
  return true;
}

function saveGraceImageBuffer(buffer, mimeType = "image/jpeg", meta = {}) {
  ensureGraceDirs();
  const ext = String(mimeType || "").includes("png") ? "png" : "jpg";
  const imageId = `grace_img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const filePath = path.join(GRACE_IMAGES_DIR, imageId);
  fs.writeFileSync(filePath, buffer);
  const entry = {
    imageId,
    mimeType: mimeType || "image/jpeg",
    buffer,
    ...meta,
    createdAt: nowIso(),
    store: "intridium_grace",
  };
  graceImagesMem.set(imageId, entry);
  try {
    const { buffer: _buf, ...sidecar } = entry;
    fs.writeFileSync(path.join(GRACE_IMAGES_DIR, `${imageId}.json`), JSON.stringify(sidecar, null, 2), "utf8");
  } catch {}
  if (graceImagesMem.size > 80) {
    const oldest = graceImagesMem.keys().next().value;
    if (oldest) graceImagesMem.delete(oldest);
  }
  return imageId;
}

function loadGraceImage(imageId) {
  const clean = String(imageId || "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!clean) return null;
  if (graceImagesMem.has(clean)) return graceImagesMem.get(clean);
  const filePath = path.join(GRACE_IMAGES_DIR, clean);
  if (!fs.existsSync(filePath)) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    let meta = {};
    const metaPath = path.join(GRACE_IMAGES_DIR, `${clean}.json`);
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    }
    const mimeType =
      meta.mimeType ||
      (clean.endsWith(".png") ? "image/png" : "image/jpeg");
    const entry = { imageId: clean, mimeType, buffer, ...meta };
    graceImagesMem.set(clean, entry);
    return entry;
  } catch {
    return null;
  }
}

function listGraceImages(identity, limit = 50) {
  ensureGraceDirs();
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(GRACE_IMAGES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(GRACE_IMAGES_DIR, f), "utf8"));
      if (meta && meta.user === identity.userKey) {
        out.push(meta);
      }
    } catch {}
  }
  out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return out.slice(0, limit);
}

function buildLiveContextBlock(body = {}) {
  const nowDate = new Date();
  const utcTimeStr = nowDate.toISOString();
  let istTimeStr = utcTimeStr;
  try {
    istTimeStr = nowDate.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "long",
    });
  } catch {}
  const rawAppLiveContext =
    body.liveContext !== undefined
      ? body.liveContext
      : body.live_context !== undefined
      ? body.live_context
      : body.context;
  const appLiveContextStr =
    typeof rawAppLiveContext === "string"
      ? rawAppLiveContext.trim()
      : rawAppLiveContext && typeof rawAppLiveContext === "object"
      ? JSON.stringify(rawAppLiveContext)
      : "";
  const includeLiveContext = body.includeLiveContext !== false && body.liveContext !== false;
  return { utcTimeStr, istTimeStr, appLiveContextStr, includeLiveContext, year: nowDate.getUTCFullYear() };
}

function buildGraceSystemPrompt(live = {}, extraInstructions = "") {
  const parts = [
    `You are ${GRACE_AI_NAME}, a fast, smart, warm, and helpful AI assistant built into the ${GRACE_APP_NAME} app. ` +
      `When asked who you are or what your name/version is, always introduce yourself as ${GRACE_AI_NAME} (the AI assistant of ${GRACE_APP_NAME}). ` +
      `Never say you are Max, Vega, OpenCode, DeepSeek, or any other assistant. ` +
      `Reply clearly, naturally, and in the same language (English, Hindi, Hinglish, etc.) that the user uses.`,
    `WEB SEARCH RULE: You have real-time internet access via the 'websearch' and 'webfetch' tools. Whenever the user asks about current events, latest news, live prices/rates (crypto, stocks, gold), weather, sports scores, recent releases, or asks you to search/check something online, call the 'websearch' tool first and answer using the live results.`,
    `IMAGE GENERATION POWER: You ALSO have real-time Image Generation via NVIDIA NIM black-forest-labs/flux-3-image-klein (1024x1024 default + dynamic aspect ratios 9:16, 16:9, 4:5, 5:4, 2:3, 3:2). NEVER say that you cannot generate, create, or draw images/photos. If asked whether you can generate images, proudly say YES. Whenever the user asks you to generate/create/draw/make any image/photo/picture/art/logo/wallpaper, output <IMAGE_TASK action="generate" status="Ek second, aapke liye image bana rahi hoon... 🎨" reply="Yeh lijiye, aapki image ban kar taiyar hai! 🎨">Detailed 50-80 word visual English image prompt (describe cars/brands/characters visually by appearance, shapes, and colors without trademarked brand names)</IMAGE_TASK>.`,
    `IMAGE EDITING LIMIT: You do NOT have image editing power. Never claim you can edit, modify, retouch, or change an uploaded photo. Never output action="edit". If the user asks to edit an existing image, politely say you can generate a brand-new image from a description instead, but you cannot edit photos.`,
    `CRITICAL RULE: NEVER invoke or call local shell/file/CLI tools (bash, edit, glob, grep, read, skill, task, todowrite, or write)—they are unused gateway placeholders. Never mention internal server paths (/home/user) or CLI metadata to the user.`,
  ];
  if (live.includeLiveContext) {
    const liveLines = [
      `[Live Context]: Current UTC Time: ${live.utcTimeStr} | Current IST Time (Asia/Kolkata): ${live.istTimeStr} | Current Year: ${live.year}.`,
    ];
    if (live.appLiveContextStr) {
      liveLines.push(`Additional App Context: ${live.appLiveContextStr}`);
    }
    parts.push(liveLines.join("\n"));
  }
  if (extraInstructions) {
    parts.push(`Additional instructions from Intridium app:\n${extraInstructions}`);
  }
  return parts.join("\n\n");
}

function extractUserPrompt(body = {}) {
  const rawMessages = [];
  let extraInstructions = "";
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const m of body.messages) {
      if (!m || !m.role) continue;
      if (m.role === "system" || m.role === "developer") {
        if (!extraInstructions && typeof m.content === "string") extraInstructions = m.content.trim();
        continue;
      }
      rawMessages.push({
        role: m.role === "model" ? "assistant" : m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
      });
    }
  } else {
    if (Array.isArray(body.history)) {
      for (const h of body.history) {
        if (h && h.role && h.content) {
          if (h.role === "system" || h.role === "developer") {
            if (!extraInstructions && typeof h.content === "string") extraInstructions = h.content.trim();
            continue;
          }
          rawMessages.push({
            role: h.role === "model" ? "assistant" : h.role,
            content: String(h.content),
          });
        }
      }
    }
    const userTextPrompt = String(
      body.prompt || body.message || body.query || body.text || body.input || ""
    ).trim();
    if (userTextPrompt) rawMessages.push({ role: "user", content: userTextPrompt });
  }
  if (typeof body.systemPrompt === "string" && body.systemPrompt.trim()) {
    extraInstructions = body.systemPrompt.trim();
  } else if (typeof body.system_prompt === "string" && body.system_prompt.trim()) {
    extraInstructions = body.system_prompt.trim();
  } else if (typeof body.instructions === "string" && body.instructions.trim()) {
    extraInstructions = body.instructions.trim();
  }
  const latestUser = [...rawMessages].reverse().find((m) => m.role === "user");
  return {
    rawMessages,
    extraInstructions,
    userText: latestUser ? String(latestUser.content || "").trim() : "",
  };
}

function looksLikeEditRequest(userText = "") {
  const q = String(userText || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(edit|retouch|inpaint|modify this (photo|image|pic)|change this (photo|image|pic))\b/i.test(q) ||
    /\b(is photo|is image|is pic|is tasveer|yeh photo|ye photo|this photo|this image)\b.{0,40}\b(edit|badal|change|hata|laga|fix|retouch)\b/i.test(
      q
    ) ||
    /\b(photo|image|pic|tasveer)\s*(ko|ki)?\s*(edit|badal|change)\b/i.test(q)
  );
}

function publicBaseFromReq(req) {
  const proto = String((req.headers["x-forwarded-proto"] || "https").split(",")[0] || "https").trim();
  const host = String(
    (req.headers["x-forwarded-host"] || req.headers.host || "vega-ai-6m2k.onrender.com").split(",")[0] ||
      "vega-ai-6m2k.onrender.com"
  ).trim();
  return `${proto}://${host}`;
}

function detectMimeFromBuffer(buf, fallback = "image/jpeg") {
  if (buf && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf && buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  return fallback;
}

async function runGraceImageGenerate({ userText, deps, onStatus, options = {}, publicBaseUrl }) {
  const { width, height, aspectRatio } = deps.resolveFlux3Dimensions(userText, options, null);
  const nvidiaModel = deps.NVIDIA_IMAGE_MODEL;
  let statusMessage = "Ek second, aapke liye image bana rahi hoon... 🎨";
  let maxPrompt = String(options.preCraftedPrompt || "").trim();
  let thinking = String(options.preThinking || "").trim();
  let finalReply = "Yeh lijiye, aapki image ban kar taiyar hai! 🎨";

  const formatThinkingAndPrompt = (thinkStr, promptStr) => {
    const t = String(thinkStr || "").trim();
    const p = String(promptStr || "").trim();
    if (t && p) return `${t}\n\nEnhanced English Prompt (Generate): "${p}"`;
    if (t) return t;
    if (p) return `Understanding user requirement ("${userText}") and crafting an enhanced detailed English prompt.\n\nEnhanced English Prompt: "${p}"`;
    return `Understanding user requirement ("${userText}")...`;
  };

  if (typeof onStatus === "function") {
    try {
      await onStatus({
        type: "image_status",
        phase: "starting",
        isImageTask: true,
        imageAction: "generate",
        imageModel: nvidiaModel,
        imageStatus: "crafting_prompt",
        readyForImage: true,
        width,
        height,
        aspectRatio,
        statusMessage,
        userPrompt: userText,
        maxPrompt: "",
        thinking,
        reasoning: thinking,
        ai: GRACE_AI_NAME,
        app: GRACE_APP_NAME,
      });
    } catch {}
  }

  const strippedSubject =
    String(userText || "")
      .replace(
        /\b(ek|a|an|please|plz|bhai|yar|yaar|zara|jaldi|abhi|image|photo|picture|pic|tasveer|ko|ki|ka|ke|generate|create|make|draw|banao|bana do|bana de|banaiye|dikhao|de do|karo|kar do|kar de|karne|karni|karna|hai|hain|ho)\b/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim() || userText;

  let livePromptBuffer = "";
  const streamTokenCallbacks = {
    rawContentTokens: true,
    onThinkingToken: ({ token, thinking: th }) => {
      thinking = th;
      if (typeof onStatus === "function") {
        try {
          onStatus({
            type: "thinking_delta",
            phase: "thinking",
            isImageTask: true,
            imageAction: "generate",
            imageModel: nvidiaModel,
            imageStatus: "crafting_prompt",
            readyForImage: true,
            width,
            height,
            aspectRatio,
            statusMessage,
            userPrompt: userText,
            token,
            thinkingDelta: token,
            reasoningDelta: token,
            maxPrompt: livePromptBuffer,
            thinking: formatThinkingAndPrompt(thinking, livePromptBuffer),
            reasoning: formatThinkingAndPrompt(thinking, livePromptBuffer),
          });
        } catch {}
      }
    },
    onContentToken: ({ token, content }) => {
      const cleanTok = String(token || "").replace(/<\/?IMAGE_TASK[^>]*>/gi, "");
      if (!cleanTok) return;
      livePromptBuffer = String(content || "")
        .replace(/<IMAGE_TASK[^>]*>([\s\S]*?)<\/IMAGE_TASK>/gi, "$1")
        .replace(/<\/?IMAGE_TASK[^>]*>/gi, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (typeof onStatus === "function") {
        try {
          onStatus({
            type: "prompt_delta",
            phase: "crafting_prompt",
            isImageTask: true,
            imageAction: "generate",
            imageModel: nvidiaModel,
            imageStatus: "crafting_prompt",
            readyForImage: true,
            width,
            height,
            aspectRatio,
            statusMessage,
            userPrompt: userText,
            token: cleanTok,
            promptDelta: cleanTok,
            maxPrompt: livePromptBuffer,
            thinking: formatThinkingAndPrompt(thinking, livePromptBuffer),
            reasoning: formatThinkingAndPrompt(thinking, livePromptBuffer),
          });
        } catch {}
      }
    },
  };

  if (maxPrompt) {
    maxPrompt = deps.debrandForNvidiaCosmos(maxPrompt);
  }

  try {
    if (maxPrompt) {
      // Already have a crafted prompt — skip LLM prompt-crafter.
    } else {
    const craftMessages = [
      {
        role: "system",
        content: `/no_think You are Grace, the AI visual director inside the Intridium app who writes prompts for the FLUX image model. Do not use any tools.

Turn the user's requirement into ONE enhanced English image prompt of 80-110 words.

Rules:
- Stay strictly faithful to the user's requirement and core subject. Never drop or change the subject, count, gender, colors or setting.
- Write flowing, natural descriptive sentences, not a keyword list.
- Cover: (1) main subject with precise details like pose, expression, clothing, materials; (2) camera angle and framing, making sure every person mentioned is clearly visible; (3) environment and background; (4) lighting direction, quality and color temperature; (5) real lens in mm, aperture, depth of field; (6) color palette and mood.
- For any car, bike or gadget, describe the design visually: shape, color, grille, headlights, wheels, exhaust, body lines. Never use brand or trademark names.
- Style: photorealistic, natural skin and material textures, cinematic realism.
- If the requirement is in Hindi or Hinglish, understand the intent and write the prompt in English.
- Never use the words: drenched, swimsuit, wet skin, masterpiece, 8k.
- No negative prompts, no brackets, no emojis, no tags.
- Output ONLY the final prompt text. No thinking, no preface, no quotes, no explanation.`,
      },
      {
        role: "user",
        content: `User requirement: "${userText}"\n\nCore subject: "${strippedSubject}"\n\nWrite ONLY the enhanced English image prompt.\n/no_think`,
      },
    ];
    const up = await deps.callOpenCodeUpstream({
      model: options.model || deps.DEFAULT_MODEL,
      messages: craftMessages,
      disableReasoning: true,
    });
    if (up.ok && up.response) {
      const assembled = await deps.collectSSEStream(up.response, up.model, streamTokenCallbacks);
      if (assembled.reasoning && assembled.reasoning.trim()) thinking = assembled.reasoning.trim();
      const tagParsed = deps.parseModelImageFallback(assembled.content, userText, false);
      if (tagParsed && tagParsed.maxPrompt && String(tagParsed.action || "generate") !== "edit") {
        maxPrompt = deps.debrandForNvidiaCosmos(tagParsed.maxPrompt);
        if (tagParsed.statusMessage) statusMessage = tagParsed.statusMessage;
        if (tagParsed.finalReply) finalReply = tagParsed.finalReply;
      } else {
        maxPrompt = deps.debrandForNvidiaCosmos(
          String(assembled.content || "")
            .replace(/<IMAGE_TASK[^>]*>([\s\S]*?)<\/IMAGE_TASK>/gi, "$1")
            .replace(/<\/?IMAGE_TASK[^>]*>/gi, "")
            .replace(/^["'`]+|["'`]+$/g, "")
            .trim()
        );
      }
    }
    }
  } catch {}

  if (!maxPrompt) {
    maxPrompt = `${deps.sanitizePromptForNvidiaFlux3(userText)}, photorealistic, natural skin and material textures, vivid cinematic lighting, sharp focus`;
  } else {
    maxPrompt = deps.debrandForNvidiaCosmos(maxPrompt);
  }

  const fullThinking = formatThinkingAndPrompt(thinking, maxPrompt);
  if (typeof onStatus === "function") {
    try {
      await onStatus({
        type: "tool_execution",
        phase: "generating_image",
        tool: nvidiaModel,
        toolStatus: "running",
        isImageTask: true,
        imageAction: "generate",
        imageModel: nvidiaModel,
        imageStatus: "processing",
        readyForImage: true,
        width,
        height,
        aspectRatio,
        statusMessage,
        userPrompt: userText,
        maxPrompt,
        thinking: fullThinking,
        reasoning: fullThinking,
      });
    } catch {}
  }

  const nvidiaApiKey = deps.getNvidiaApiKey();
  if (!nvidiaApiKey) {
    throw new Error(
      "Missing NVIDIA_API_KEY in environment variables. Please set NVIDIA_API_KEY in Render Environment settings."
    );
  }

  const nvidiaPayload = {
    prompt: maxPrompt.slice(0, 1950),
    width,
    height,
    steps: Number(options.steps) > 0 && Number(options.steps) <= 50 ? Number(options.steps) : 28,
    seed: Number.isInteger(Number(options.seed)) && Number(options.seed) >= 0 ? Number(options.seed) : 0,
  };

  let imgBuffer = null;
  let contentType = "image/jpeg";
  let lastNvidiaErr = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const nvRes = await fetch(deps.NVIDIA_IMAGE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${nvidiaApiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nvidiaPayload),
      });
      if (nvRes.ok) {
        const ct = (nvRes.headers.get("content-type") || "").toLowerCase();
        if (ct.startsWith("image/")) {
          imgBuffer = Buffer.from(await nvRes.arrayBuffer());
        } else {
          const data = await nvRes.json();
          const finishReason = data?.artifacts?.[0]?.finishReason || "";
          const b64 = data?.artifacts?.[0]?.base64 || data?.image || data?.data?.[0]?.b64_json || "";
          if (b64) {
            imgBuffer = Buffer.from(b64, "base64");
          } else if (finishReason === "CONTENT_FILTERED") {
            lastNvidiaErr = `NVIDIA NIM CONTENT_FILTERED on attempt ${attempt + 1}`;
            nvidiaPayload.seed = (Number(nvidiaPayload.seed) || 0) + 7;
            if (attempt === 0) {
              const rewritten = await deps.rewritePromptForNvidiaGuardrail(
                maxPrompt || userText,
                options.model || deps.DEFAULT_MODEL
              );
              maxPrompt = rewritten;
              nvidiaPayload.prompt = rewritten.slice(0, 1950);
              continue;
            } else if (attempt === 1) {
              const subjectSafeFallback = `${deps.debrandForNvidiaCosmos(
                deps.sanitizePromptForNvidiaFlux3(userText)
              )}, medium cinematic shot, golden hour sunlight, shot on 85mm f/1.4 lens, photorealistic photography, sharp focus`;
              maxPrompt = subjectSafeFallback;
              nvidiaPayload.prompt = subjectSafeFallback.slice(0, 1950);
              continue;
            }
          } else {
            lastNvidiaErr = `NVIDIA NIM returned 200 without base64 artifact: ${JSON.stringify(data).slice(0, 200)}`;
          }
        }
        if (imgBuffer && imgBuffer.length > 0) {
          contentType = detectMimeFromBuffer(imgBuffer, ct.startsWith("image/") ? ct.split(";")[0] : "image/jpeg");
          break;
        }
      } else {
        const errText = await nvRes.text().catch(() => "");
        lastNvidiaErr = `NVIDIA NIM API error (${nvRes.status}): ${errText.slice(0, 240)}`;
      }
    } catch (e) {
      lastNvidiaErr = e.message || "NVIDIA NIM fetch failed";
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
  }

  if (!imgBuffer) {
    throw new Error(lastNvidiaErr || "Image generation failed on NVIDIA NIM flux-3-image-klein");
  }

  const imageId = saveGraceImageBuffer(imgBuffer, contentType, {
    user: options.identity ? options.identity.userKey : null,
    isGuest: options.identity ? options.identity.isGuest : null,
    guestId: options.identity ? options.identity.guestId : null,
    chatId: options.chatId || null,
    action: "generate",
    imageModel: nvidiaModel,
    width,
    height,
    aspectRatio,
    userPrompt: userText,
    maxPrompt,
    finalReply,
  });
  const hostedUrl = `${String(publicBaseUrl || "").replace(/\/+$/, "")}/api/grace/image/view/${imageId}`;
  const outBase64 = imgBuffer.toString("base64");

  return {
    success: true,
    ai: GRACE_AI_NAME,
    app: GRACE_APP_NAME,
    isImageTask: true,
    imageAction: "generate",
    imageModel: nvidiaModel,
    width,
    height,
    aspectRatio,
    statusMessage,
    userPrompt: userText,
    maxPrompt,
    thinking: formatThinkingAndPrompt(thinking, maxPrompt),
    reasoning: formatThinkingAndPrompt(thinking, maxPrompt),
    reply: finalReply,
    imageId,
    imageUrl: hostedUrl,
    image: {
      id: imageId,
      url: hostedUrl,
      mimeType: contentType,
      width,
      height,
      base64: outBase64,
      dataUri: `data:${contentType};base64,${outBase64}`,
    },
  };
}

function docsPayload() {
  return {
    ok: true,
    ai: GRACE_AI_NAME,
    app: GRACE_APP_NAME,
    endpoint: "POST /api/grace",
    aliases: [
      "POST /api/grace",
      "POST /api/grace/chat",
      "POST /api/intridium",
      "POST /api/intridium/chat",
      "POST /api/intridium/grace",
      "POST /v1/grace/chat/completions",
    ],
    model: "deepseek-v4.1-flash-free",
    features: {
      persona: GRACE_AI_NAME,
      webResearchAndFetch: true,
      liveContext: true,
      imageGeneration: true,
      imageEditing: false,
      liveThinkingAndStreaming: true,
      isolatedHistoryStore: true,
    },
    storage: {
      location: "Isolated Grace/Intridium store — data/intridium_grace/ (NOT Vega ai_chats / ai_messages / Vega Storage)",
      signedInUserKey: "lowercase email, e.g. user@example.com",
      guestUserKey: "guest",
      guestRule:
        "Bina email / bina identity ke bhi POST /api/grace directly hit kar sakte ho — data store hota hai. Unsigned chats ka naam sirf `guest` hota hai (koi guest email nahi). Signed-in chats email se save hoti hain.",
      historyRoutes: {
        list: "GET /api/grace/history/chats  (guest)  |  ?user=<email> (signed-in)",
        open: "GET /api/grace/history/chats/:chatId",
        delete: "DELETE /api/grace/history/chats/:chatId",
        images: "GET /api/grace/images",
        imageView: "GET /api/grace/image/view/:imageId",
      },
    },
    usageExample: {
      prompt: "Tum kaun ho?",
      user: "optional-signed-in-email@example.com",
      liveContext: "Optional extra live context from Intridium",
      webSearch: true,
      stream: false,
      chatId: "optional existing grace_chat_... id",
    },
  };
}

function identityFromQuery(url, body = {}, req = null) {
  const qUser = url.searchParams.get("user") || url.searchParams.get("email") || "";
  return resolveGraceIdentity(
    {
      ...body,
      user: body.user || qUser,
    },
    req
  );
}

const GRACE_UI_PATHS = new Set([
  "/grace",
  "/grace/ui",
  "/grace/chat",
  "/intridium",
  "/intridium/ui",
  "/intridium/chat",
]);

function serveGraceChatUI(res) {
  const htmlPath = path.join(__dirname, "public", "grace-chat.html");
  if (!fs.existsSync(htmlPath)) return false;
  const html = fs.readFileSync(htmlPath);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": String(html.length),
  });
  res.end(html);
  return true;
}

async function handleGraceRequest({ req, res, url, pathname, deps }) {
  const isGracePath =
    GRACE_UI_PATHS.has(pathname) ||
    pathname === "/api/grace" ||
    pathname === "/api/grace/chat" ||
    pathname === "/api/intridium" ||
    pathname === "/api/intridium/chat" ||
    pathname === "/api/intridium/grace" ||
    pathname === "/v1/grace/chat/completions" ||
    pathname.startsWith("/api/grace/") ||
    pathname.startsWith("/api/intridium/");
  if (!isGracePath) return false;

  if (req.method === "GET" && GRACE_UI_PATHS.has(pathname)) {
    if (serveGraceChatUI(res)) return true;
    deps.sendJson(res, 500, { success: false, error: "Grace chat UI file missing" });
    return true;
  }

  // Image view
  const imgViewMatch = pathname.match(/^\/api\/(?:grace|intridium)\/image\/view\/([^/]+)$/);
  if (req.method === "GET" && imgViewMatch) {
    const item = loadGraceImage(imgViewMatch[1]);
    if (!item || !item.buffer) {
      deps.sendJson(res, 404, { success: false, error: "Grace image not found", ai: GRACE_AI_NAME, app: GRACE_APP_NAME });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": item.mimeType || "image/jpeg",
      "Cache-Control": "public, max-age=31536000",
      "Content-Length": String(item.buffer.length),
    });
    res.end(item.buffer);
    return true;
  }

  // History + image list
  if (
    req.method === "GET" &&
    (pathname === "/api/grace/history/chats" || pathname === "/api/intridium/history/chats")
  ) {
    const identity = identityFromQuery(url, {}, req);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    deps.sendJson(res, 200, {
      success: true,
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
      store: "intridium_grace",
      userKey: identity.userKey,
      isGuest: identity.isGuest,
      guestId: identity.guestId,
      chats: listGraceChats(identity, limit),
    });
    return true;
  }

  const chatGetMatch = pathname.match(/^\/api\/(?:grace|intridium)\/history\/chats\/([^/]+)$/);
  if (chatGetMatch && (req.method === "GET" || req.method === "DELETE")) {
    const identity = identityFromQuery(url, {}, req);
    const chatId = chatGetMatch[1];
    if (req.method === "DELETE") {
      const ok = deleteGraceChat(identity, chatId);
      deps.sendJson(res, ok ? 200 : 404, {
        success: ok,
        ai: GRACE_AI_NAME,
        app: GRACE_APP_NAME,
        deleted: ok,
        chatId,
        userKey: identity.userKey,
      });
      return true;
    }
    const chat = readGraceChat(chatId);
    if (!chat || chat.user !== identity.userKey) {
      deps.sendJson(res, 404, { success: false, error: "Chat not found in Grace/Intridium store" });
      return true;
    }
    deps.sendJson(res, 200, {
      success: true,
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
      store: "intridium_grace",
      userKey: identity.userKey,
      isGuest: identity.isGuest,
      guestId: identity.guestId,
      chat,
    });
    return true;
  }

  if (
    req.method === "GET" &&
    (pathname === "/api/grace/images" || pathname === "/api/intridium/images")
  ) {
    const identity = identityFromQuery(url, {}, req);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    deps.sendJson(res, 200, {
      success: true,
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
      store: "intridium_grace",
      userKey: identity.userKey,
      isGuest: identity.isGuest,
      guestId: identity.guestId,
      images: listGraceImages(identity, limit),
    });
    return true;
  }

  if (
    req.method === "GET" &&
    (pathname === "/api/grace" ||
      pathname === "/api/grace/chat" ||
      pathname === "/api/intridium" ||
      pathname === "/api/intridium/chat" ||
      pathname === "/api/intridium/grace" ||
      pathname === "/v1/grace/chat/completions")
  ) {
    deps.sendJson(res, 200, docsPayload());
    return true;
  }

  const isChatPost =
    pathname === "/api/grace" ||
    pathname === "/api/grace/chat" ||
    pathname === "/api/intridium" ||
    pathname === "/api/intridium/chat" ||
    pathname === "/api/intridium/grace" ||
    pathname === "/v1/grace/chat/completions" ||
    pathname === "/api/grace/image" ||
    pathname === "/api/intridium/image";

  if (!isChatPost) {
    deps.sendJson(res, 404, {
      success: false,
      error: `Unknown Grace/Intridium route ${req.method} ${pathname}`,
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
    });
    return true;
  }

  if (req.method !== "POST") {
    deps.sendJson(res, 405, {
      success: false,
      error: "Method not allowed. Use POST /api/grace.",
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
    });
    return true;
  }

  try {
    const body = await deps.readJsonBody(req);
    const identity = resolveGraceIdentity(body, req);
    const live = buildLiveContextBlock(body);
    const extracted = extractUserPrompt(body);
    if (!extracted.userText && extracted.rawMessages.length === 0) {
      deps.sendJson(res, 400, {
        success: false,
        error: "Missing prompt or messages. Provide 'prompt', 'message', or 'messages'.",
        ai: GRACE_AI_NAME,
        app: GRACE_APP_NAME,
      });
      return true;
    }

    const allowWebSearch = body.webSearch !== false && body.allowWebSearch !== false;
    const forceWebSearch = body.webSearch === true || body.search === true;
    const isStream = body.stream === true;
    const saveHistory = body.saveHistory !== false && body.save_history !== false;
    const requestedChatId = String(body.chatId || body.chat_id || "").trim();
    const publicBaseUrl = publicBaseFromReq(req);
    const forceImageGenerate =
      pathname.endsWith("/image") ||
      body.imageAction === "generate" ||
      body.mode === "generate" ||
      body.action === "generate";

    const imageIntent = forceImageGenerate
      ? "generate"
      : deps.detectImageTaskIntent(extracted.userText, null, {
          imageAction: body.imageAction,
          mode: body.mode,
          disableImageGen: body.disableImageGen,
        });

    const liveStream = isStream ? deps.createLiveStreamEmitter(res, body.model || deps.DEFAULT_MODEL) : null;

    const persistAndMeta = (payload, extraTurns = []) => {
      let savedChat = null;
      if (saveHistory) {
        const turns = [
          { role: "user", text: extracted.userText, kind: "text" },
          ...extraTurns,
        ];
        savedChat = appendGraceTurns(identity, requestedChatId, turns);
      }
      return {
        ...payload,
        success: true,
        ai: GRACE_AI_NAME,
        app: GRACE_APP_NAME,
        model: payload.model || deps.DEFAULT_MODEL,
        store: "intridium_grace",
        userKey: identity.userKey,
        isGuest: identity.isGuest,
        guestId: identity.guestId,
        guestIdGenerated: Boolean(identity.guestIdGenerated),
        signedInEmail: identity.signedInEmail,
        chatId: savedChat ? savedChat.id : requestedChatId || null,
        liveContext: live.includeLiveContext
          ? { utc: live.utcTimeStr, ist: live.istTimeStr, appContext: live.appLiveContextStr || null }
          : null,
      };
    };

    // Image editing is intentionally NOT supported for Grace.
    if (imageIntent === "edit" || (looksLikeEditRequest(extracted.userText) && body.imageAction === "edit")) {
      const reply =
        "Main Grace hoon — main Intridium ke andar nayi images generate kar sakti hoon, magar existing photo ko edit nahi kar sakti. Jo result chahiye uska description de do, main ek fresh image bana dungi. 🎨";
      const out = persistAndMeta({
        reply,
        thinking: null,
        reasoning: null,
        usedWebSearch: false,
        searchQueries: [],
        webSearchSources: [],
        imageEditing: false,
        imageGeneration: true,
      });
      if (liveStream) {
        liveStream.finishChat(out, { content: reply, finishReason: "stop" });
        return true;
      }
      deps.sendJson(res, 200, out);
      return true;
    }

    if (imageIntent === "generate") {
      try {
        const imgResult = await runGraceImageGenerate({
          userText: extracted.userText,
          deps,
          onStatus: liveStream ? (evt) => liveStream.onImageStatus(evt) : null,
          options: {
            ...body,
            model: body.model || deps.DEFAULT_MODEL,
            identity,
            chatId: requestedChatId,
          },
          publicBaseUrl,
        });
        const out = persistAndMeta(imgResult, [
          {
            role: "ai",
            text: imgResult.reply,
            kind: "image",
            imageId: imgResult.imageId,
            imageUrl: imgResult.imageUrl,
            thinking: imgResult.thinking,
          },
        ]);
        if (liveStream) {
          liveStream.finishImage(out);
          return true;
        }
        deps.sendJson(res, 200, out);
        return true;
      } catch (imgErr) {
        const errPayload = {
          success: false,
          ai: GRACE_AI_NAME,
          app: GRACE_APP_NAME,
          error: imgErr.message || "Grace image generation failed",
        };
        if (liveStream) {
          deps.sendSSEEvent(res, "error", errPayload);
          res.end();
          return true;
        }
        deps.sendJson(res, 502, errPayload);
        return true;
      }
    }

    const finalMessages = [
      { role: "system", content: buildGraceSystemPrompt(live, extracted.extraInstructions) },
      ...(extracted.rawMessages.length ? extracted.rawMessages : [{ role: "user", content: extracted.userText }]),
    ];

    const agentResult = await deps.runOpenCodeAgentWithTools(
      {
        model: body.model || deps.DEFAULT_MODEL,
        messages: finalMessages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        disableReasoning: body.disableReasoning === true || body.noThink === true,
        allowWebSearch,
        webSearch: forceWebSearch,
      },
      liveStream
        ? {
            onToolExecution: (evt) => liveStream.onToolExecution(evt),
            onThinkingToken: (evt) => liveStream.onThinkingToken(evt),
            onContentToken: (evt) => liveStream.onContentToken(evt),
          }
        : null
    );

    if (!agentResult.ok) {
      if (res.headersSent) {
        deps.sendSSEEvent(res, "error", {
          success: false,
          error: "Upstream OpenCode API error",
          details: agentResult.errorText,
        });
        res.end();
        return true;
      }
      deps.sendJson(res, agentResult.status || 502, {
        success: false,
        ai: GRACE_AI_NAME,
        app: GRACE_APP_NAME,
        error: "Upstream OpenCode API error",
        details: agentResult.errorText,
      });
      return true;
    }

    const assembled = agentResult.assembled;
    let reply = assembled.content || "";
    const tagParsed = deps.parseModelImageFallback(reply, extracted.userText, false);

    if (tagParsed && String(tagParsed.action || "generate") === "edit") {
      reply =
        (reply || "").replace(/<IMAGE_TASK[\s\S]*?<\/IMAGE_TASK>/gi, "").trim() ||
        "Main Grace hoon — main nayi images generate kar sakti hoon, magar existing photo ko edit nahi kar sakti.";
    } else if (tagParsed && tagParsed.maxPrompt && String(tagParsed.action || "generate") === "generate") {
      try {
        const imgResult = await runGraceImageGenerate({
          userText: extracted.userText,
          deps,
          onStatus: liveStream ? (evt) => liveStream.onImageStatus(evt) : null,
          options: {
            ...body,
            model: body.model || deps.DEFAULT_MODEL,
            identity,
            chatId: requestedChatId,
            preCraftedPrompt: tagParsed.maxPrompt,
          },
          publicBaseUrl,
        });
        const out = persistAndMeta(
          {
            ...imgResult,
            usedWebSearch: agentResult.usedWebSearch,
            searchQueries: agentResult.searchQueries,
            webSearchSources: agentResult.webSearchSources || [],
            webSearchResults: agentResult.webSearchResults || null,
          },
          [
            {
              role: "ai",
              text: imgResult.reply,
              kind: "image",
              imageId: imgResult.imageId,
              imageUrl: imgResult.imageUrl,
              thinking: imgResult.thinking,
            },
          ]
        );
        if (liveStream) {
          liveStream.finishImage(out);
          return true;
        }
        deps.sendJson(res, 200, out);
        return true;
      } catch {}
    }

    const out = persistAndMeta({
      id: assembled.id,
      object: "chat.completion",
      created: assembled.created,
      model: assembled.model || deps.DEFAULT_MODEL,
      usedWebSearch: agentResult.usedWebSearch,
      searchQueries: agentResult.searchQueries,
      webSearchSources: agentResult.webSearchSources || [],
      webSearchResults: agentResult.webSearchResults || null,
      thinking: assembled.reasoning || null,
      reasoning: assembled.reasoning || null,
      reply,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply,
            ...(assembled.reasoning
              ? {
                  thinking: assembled.reasoning,
                  reasoning: assembled.reasoning,
                  reasoning_content: assembled.reasoning,
                }
              : {}),
          },
          finish_reason: assembled.finishReason || "stop",
        },
      ],
      usage: assembled.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }, [{ role: "ai", text: reply, kind: "text", thinking: assembled.reasoning || undefined }]);

    if (liveStream) {
      liveStream.finishChat(out, assembled);
      return true;
    }
    deps.sendJson(res, 200, out);
    return true;
  } catch (err) {
    if (res.headersSent) {
      deps.sendSSEEvent(res, "error", {
        success: false,
        error: err.message || "Internal server error",
      });
      res.end();
      return true;
    }
    deps.sendJson(res, 500, {
      success: false,
      ai: GRACE_AI_NAME,
      app: GRACE_APP_NAME,
      error: err.message || "Internal server error",
    });
    return true;
  }
}

module.exports = {
  GRACE_AI_NAME,
  GRACE_APP_NAME,
  GRACE_STORE_DIR,
  handleGraceRequest,
  resolveGraceIdentity,
};
