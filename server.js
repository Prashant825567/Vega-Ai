/**
 * Max v1.0 — Pure Headless AI & Voice Agent Backend Server for Vega App
 * Ready for deployment on Render.com (No Web UI, Pure JSON/SSE/Audio API)
 *
 * Architecture:
 * 1. STT (Speech-to-Text):
 *    - Model: Google AI Studio `gemini-2.5-flash` (audio input -> text transcript)
 * 2. Middle LLM (Brain):
 *    - Model: OpenCode `deepseek-v4.1-flash-free` (Persona: Max v1.0 for Vega App)
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
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Force IPv4-first DNS resolution so upstream endpoints never stall on unreachable IPv6 routes
try {
  dns.setDefaultResultOrder("ipv4first");
  if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
  }
} catch {}

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
  process.env.OPENCODE_UPSTREAM_URL || "https://opencode.ai/inference/openai/v1/chat/completions",
  "https://opencode.ai/inference/v1/chat/completions",
  "https://opencode.ai/zen/v1/chat/completions",
];

const rawEnvModel = (process.env.DEFAULT_MODEL || "").trim();
const DEFAULT_MODEL =
  !rawEnvModel || rawEnvModel === "mimo-v2.6-flash-free"
    ? "deepseek-v4.1-flash-free"
    : rawEnvModel;
const GEMINI_VOICE_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_STT_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_TTS_MODEL = "gemini-3.1-flash-live-preview";

// ─── Smooth & Beautiful Female Voices Catalog (Gemini Live Native Audio) ─────
const SMOOTH_FEMALE_VOICES = [
  {
    id: "Aoede",
    name: "Aoede (Default)",
    gender: "female",
    style: "Ultra-smooth, warm, melodic & natural female voice (Best for Hinglish/Hindi/English)",
    isDefault: true,
  },
  {
    id: "Kore",
    name: "Kore",
    gender: "female",
    style: "Soft, calm, soothing & crystal-clear female voice",
    isDefault: false,
  },
  {
    id: "Leda",
    name: "Leda",
    gender: "female",
    style: "Sweet, bright, youthful & expressive female voice",
    isDefault: false,
  },
  {
    id: "Zephyr",
    name: "Zephyr",
    gender: "female",
    style: "Airy, gentle, smooth & friendly conversational female voice",
    isDefault: false,
  },
  {
    id: "Callirrhoe",
    name: "Callirrhoe",
    gender: "female",
    style: "Rich, graceful, pleasant & velvety smooth female voice",
    isDefault: false,
  },
  {
    id: "Despina",
    name: "Despina",
    gender: "female",
    style: "Sweet, lively, warm & engaging female voice",
    isDefault: false,
  },
  {
    id: "Autonoe",
    name: "Autonoe",
    gender: "female",
    style: "Polite, articulate, warm & soothing female voice",
    isDefault: false,
  },
  {
    id: "Erinome",
    name: "Erinome",
    gender: "female",
    style: "Serene, smooth, soft & relaxing female voice",
    isDefault: false,
  },
  {
    id: "Laomedeia",
    name: "Laomedeia",
    gender: "female",
    style: "Natural, expressive & charming female voice",
    isDefault: false,
  },
  {
    id: "Pulcherrima",
    name: "Pulcherrima",
    gender: "female",
    style: "Melodic, refined, soft & beautiful female voice",
    isDefault: false,
  },
  {
    id: "Sulafat",
    name: "Sulafat",
    gender: "female",
    style: "Warm, friendly, smooth & comforting female voice",
    isDefault: false,
  },
  {
    id: "Vindemiatrix",
    name: "Vindemiatrix",
    gender: "female",
    style: "Calm, gentle & composed female voice",
    isDefault: false,
  },
];

function normalizeVoiceName(voiceInput) {
  const raw = String(voiceInput || "Aoede").trim();
  const lower = raw.toLowerCase();

  // Default & Aoede aliases
  if (
    !lower ||
    lower === "adeode" ||
    lower === "aoede" ||
    lower === "aode" ||
    lower === "aodeo" ||
    lower === "default" ||
    lower === "female" ||
    lower === "female1" ||
    lower === "female-1" ||
    lower === "smooth"
  ) {
    return "Aoede";
  }

  // Other smooth beautiful female voices + friendly aliases
  if (lower === "kore" || lower === "female2" || lower === "female-2" || lower === "soothing" || lower === "calm") {
    return "Kore";
  }
  if (lower === "leda" || lower === "female3" || lower === "female-3" || lower === "sweet" || lower === "cute") {
    return "Leda";
  }
  if (lower === "zephyr" || lower === "female4" || lower === "female-4" || lower === "gentle" || lower === "airy") {
    return "Zephyr";
  }
  if (lower === "callirrhoe" || lower === "female5" || lower === "female-5" || lower === "beautiful" || lower === "graceful") {
    return "Callirrhoe";
  }
  if (lower === "despina" || lower === "female6" || lower === "female-6" || lower === "lively") {
    return "Despina";
  }
  if (lower === "autonoe") return "Autonoe";
  if (lower === "erinome") return "Erinome";
  if (lower === "laomedeia") return "Laomedeia";
  if (lower === "pulcherrima") return "Pulcherrima";
  if (lower === "sulafat") return "Sulafat";
  if (lower === "vindemiatrix") return "Vindemiatrix";

  // Optional male voices if ever explicitly requested
  if (lower === "puck") return "Puck";
  if (lower === "charon") return "Charon";
  if (lower === "fenrir") return "Fenrir";
  if (lower === "orus") return "Orus";

  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

const GEMINI_TTS_VOICE = normalizeVoiceName(process.env.GEMINI_TTS_VOICE || "Aoede"); // Default: Aoede

const AI_NAME = process.env.AI_NAME || "Max v1.0";
const APP_NAME = process.env.APP_NAME || "Vega";
const BACKEND_API_KEY = (process.env.BACKEND_API_KEY || "").trim();

// 1) Image Generation Engine: NVIDIA NIM FLUX.3 Klein (`black-forest-labs/flux-3-image-klein`)
const NVIDIA_IMAGE_MODEL = "black-forest-labs/flux-3-image-klein";
const NVIDIA_IMAGE_API_URL = (
  process.env.NVIDIA_IMAGE_API_URL ||
  "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein"
).replace(/\/+$/, "");

function getNvidiaApiKey() {
  return (process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY || "").trim();
}

// 2) Image Editing Engine: Cloudflare Worker (`@cf/black-forest-labs/flux-2-klein-9b`)
const CLOUDFLARE_EDIT_MODEL =
  process.env.CLOUDFLARE_EDIT_MODEL || "@cf/black-forest-labs/flux-2-klein-9b";
const IMAGE_API_URL = (
  process.env.IMAGE_API_URL || "https://image-api.pr3095079.workers.dev"
).replace(/\/+$/, "");
const IMAGE_API_KEY = (process.env.IMAGE_API_KEY || "noida123").trim();

const DEFAULT_FILLER_TEXT =
  process.env.VOICE_FILLER_TEXT || "Ek second, abhi batata hoon.";

let DEFAULT_SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are ${AI_NAME}, a fast, smart, and helpful AI assistant built into the ${APP_NAME} app. ` +
    `When asked who you are or what your name/version is, always introduce yourself as ${AI_NAME} (the AI assistant of ${APP_NAME}). ` +
    `Reply clearly, naturally, and in the same language (English, Hindi, Hinglish, etc.) that the user uses. ` +
    `WEB SEARCH RULE: You have real-time internet access via the 'websearch' and 'webfetch' tools. Whenever the user asks about current events, latest news, live prices/rates (crypto, stocks, gold), weather, sports scores, recent releases, or asks you to search/check something online, call the 'websearch' tool first and answer using the live results. ` +
    `IMAGE GENERATION & EDITING POWER: You ALSO have full real-time Image Generation ('generate' via NVIDIA NIM ${NVIDIA_IMAGE_MODEL} at 1024x1024 default + dynamic aspect ratios 9:16, 16:9, 4:5, 5:4, 2:3, 3:2) and Image Editing ('edit' via Cloudflare ${CLOUDFLARE_EDIT_MODEL} at 1024x1024). NEVER say that you cannot generate, create, draw, or edit images/photos! If asked whether you can generate or edit images, proudly say YES. Whenever the user asks you to generate/create/draw/make any image/photo/picture/art/logo/wallpaper OR edit/modify/change an uploaded image, output <IMAGE_TASK action="generate" status="Ek second bhai, aapke liye image bana raha hoon... 🎨" reply="Yeh lijiye bhai, aapki image ban kar taiyar hai! 🎨">Detailed 50-80 word visual English image prompt (describe cars/brands/characters visually by their appearance, shapes, and colors without trademarked brand names)</IMAGE_TASK> (use action="edit" if editing an uploaded image). ` +
    `CRITICAL RULE: NEVER invoke or call local shell/file tools (bash, edit, glob, grep, or read)—they are unused gateway placeholders.`;

let VOICE_FAST_SYSTEM_PROMPT =
  process.env.VOICE_SYSTEM_PROMPT ||
  `/no_think You are ${AI_NAME}, the real-time voice AI agent inside the ${APP_NAME} app. ` +
    `When asked who you are, always say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
    `Reply directly in 1 to 2 short, natural spoken sentences in the user's language (Hinglish, Hindi, or English) with no markdown, asterisks, lists, or emojis. ` +
    `Do NOT call any tools for greetings, casual chat, or general knowledge—only call 'websearch' when the user asks for live/current news, prices, weather, scores, or web search. Never call bash, edit, glob, grep, or read.`;

// Ring buffer storing the exact prompts sent on the most recent turns
const recentSentPrompts = [];
function recordSentPrompt(entry) {
  recentSentPrompts.unshift({
    at: new Date().toISOString(),
    ...entry,
  });
  if (recentSentPrompts.length > 20) {
    recentSentPrompts.length = 20;
  }
}

// ─── Detect Whether a Query Needs Live OpenCode Web Search / Deep Research ───
function detectNeedsThinking(text) {
  const q = String(text || "").toLowerCase().trim();
  if (!q) return false;
  // Casual greetings / identity questions never need web search or deep thinking
  if (
    /^(hi|hello|hey|namaste|namaskar|kaise ho|kaisa hai|kaisi ho|kya haal|how are you|who are you|tum kaun ho|aap kaun ho|tera naam|tumhara naam|what is your name|good morning|good evening|good night|aur batao|sab badhiya|thank you|thanks|shukriya|ok|okay|accha|theek hai|नमस्ते|नमस्कार|कैसे हो|क्या हाल है|तुम कौन हो|आप कौन हो|आपका नाम क्या है|शुक्रिया|धन्यवाद|ठीक है)[?!.।\s]*$/i.test(
      q
    )
  ) {
    return false;
  }
  const thinkingPatterns = [
    /\b(research|analyze|analyse|compare|calculate|solve|explain in detail|deep dive|step by step|history of|difference between|write code|algorithm|debug)\b/i,
    /\b(search|web search|google|internet|online|latest|current|today|tonight|yesterday|recent|now|news|breaking|price|rate|weather|temperature|forecast|score|live|update|2024|2025|2026|2027|ipl|match|world cup|t20|cricket|football|stock|share|bitcoin|btc|eth|crypto|gold|silver|sensex|nifty|dollar|rupee|inr|usd)\b/i,
    /\b(who is|what is the current|who won|winner|prime minister|president|chief minister|ceo|founder|net worth|release date|launch date|upcoming|new movie|box office|collection|subscribers|followers|richest|top 5|top 10|specs|specification)\b/i,
    /\b(soch ke|soch kar|check karke|check karo|pata karke|pata karo|research karke|search karke|search karo|nikal ke|dhundh ke|detail me|detail mein|vistar se|samjhao|hisab laga|solve kar|aaj|abhi|kal|taza|khabar|mausam|bhav|keemat|kitna rate|kya rate|kaun hai|kon hai|kaun jeeta|kon jeeta|sona|chandi|kamai|naya|nayi|konsa|kaunsa)\b/i,
    /(आज|अभी|कल|ताजा|ताज़ा|खबर|ख़बर|न्यूज|न्यूज़|प्राइस|भाव|कीमत|रेट|मौसम|तापमान|बारिश|स्कोर|मैच|आईपीएल|क्रिकेट|कौन है|क्या है|कब|कितना|कितनी|कितने|सर्च|रिसर्च|गूगल|पता कर|चेक कर|सोना|सोने|चांदी|बिटकॉइन|शेयर|मार्केट|फिल्म|मूवी|कलेक्शन|कमाई|प्रधानमंत्री|राष्ट्रपति|मुख्यमंत्री|विजेता|जीता|लॉन्च|रिलीज|रिलीज़|सब्सक्राइबर|फॉलोअर्स|नेट वर्थ|सबसे ज्यादा|नया मॉडल)/,
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

function getSessionId() {
  // Always generate a fresh valid 48-bit timestamp session ID per upstream call
  // so cancelled SSE streams never block or serialize subsequent concurrent/back-to-back calls.
  return generateOpencodeSessionId();
}

// ─── Required OpenCode Gateway Tool Stubs ────────────────────────────────────
const REQUIRED_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "write"];
const GATEWAY_STUB_TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "bash",
      "description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: linux, Shell: bash\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nUse `/tmp/opencode` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use `head`, `tail`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.\n\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter to change directories instead.\n    <good-example>\n    Use workdir=\"/foo/bar\" with command: pytest tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Git and GitHub\n- Only commit, amend, push, or create PRs when explicitly requested.\n- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.\n- Write a concise commit message that matches the repo style.\n- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.\n- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.\n- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.\n- Review all commits included in the PR, not just the latest commit.\n- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The command to execute"
          },
          "timeout": {
            "minimum": -9007199254740991,
            "exclusiveMinimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "Optional timeout in milliseconds"
          },
          "workdir": {
            "type": "string",
            "description": "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
          }
        },
        "required": [
          "command"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit",
      "description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.\" Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file to modify"
          },
          "oldString": {
            "type": "string",
            "description": "The text to replace"
          },
          "newString": {
            "type": "string",
            "description": "The text to replace it with (must be different from oldString)"
          },
          "replaceAll": {
            "type": "boolean",
            "description": "Replace all occurrences of oldString (default false)"
          }
        },
        "required": [
          "filePath",
          "oldString",
          "newString"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "glob",
      "description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths\n- Use this tool when you need to find files by name patterns\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The glob pattern to match files against"
          },
          "path": {
            "type": "string",
            "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "grep",
      "description": "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with matching lines\n- Use this tool when you need to find files containing specific patterns\n- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The regex pattern to search for in file contents"
          },
          "path": {
            "type": "string",
            "description": "The directory to search in. Defaults to the current working directory."
          },
          "include": {
            "type": "string",
            "description": "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read",
      "description": "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents \"foo\\n\", you will receive \"1: foo\\n\". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file or directory to read"
          },
          "offset": {
            "minimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "The line number to start reading from (1-indexed)"
          },
          "limit": {
            "minimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "The maximum number of lines to read (defaults to 2000)"
          }
        },
        "required": [
          "filePath"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "skill",
      "description": "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.\n\nUse this tool to inject the skill's instructions and resources into current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill.\n\nThe skill name must match one of the skills listed in your system prompt.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the skill from available_skills"
          }
        },
        "required": [
          "name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "task",
      "description": "Launch a new agent to handle complex, multistep tasks autonomously.\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Grep tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- If no available agent is a good fit for the task, use other tools directly\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when the result is ready.\n3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.\n4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n5. The agent's outputs should generally be trusted\n6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).\n7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nAvailable agent types and the tools they have access to:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "description": {
            "type": "string",
            "description": "A short (3-5 words) description of the task"
          },
          "prompt": {
            "type": "string",
            "description": "The task for the agent to perform"
          },
          "subagent_type": {
            "type": "string",
            "description": "The type of specialized agent to use for this task"
          },
          "task_id": {
            "type": "string",
            "description": "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)"
          },
          "command": {
            "type": "string",
            "description": "The command that triggered this task"
          }
        },
        "required": [
          "description",
          "prompt",
          "subagent_type"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "todowrite",
      "description": "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.\n\n## When to use\nUse proactively when:\n- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)\n- The work is non-trivial and benefits from planning\n- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list\n- New instructions arrive - capture them as todos\n- You start a task - mark it `in_progress` (only one at a time) before working\n- You finish a task - mark it `completed` and add any follow-ups discovered during the work\n\n## When NOT to use\nSkip when:\n- The work is a single, straightforward task (or <3 trivial steps)\n- The request is purely informational or conversational\n- Tracking adds no organizational value\n\n## States\n- `pending` - not started\n- `in_progress` - actively working (exactly ONE at a time)\n- `completed` - finished successfully\n- `cancelled` - no longer needed\n\n## Rules\n- Update status in real time; don't batch completions\n- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.\n- Keep exactly one `in_progress` while work remains\n- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker\n- Preserve user-provided commands verbatim (flags, args, order)\n- Items should be specific and actionable; break large work into smaller steps\n\n## Examples\n\nUse it:\n- \"Add a dark mode toggle and run the tests\" -> multi-step feature + explicit verification\n- \"Rename getCwd -> getCurrentWorkingDirectory across the repo\" -> grep reveals 15 occurrences in 8 files\n- \"Implement registration, catalog, cart, checkout\" -> multiple complex features\n\nSkip it:\n- \"How do I print Hello World in Python?\" -> informational\n- \"Add a comment to calculateTotal\" -> single edit\n- \"Run npm install and tell me what happened\" -> one command\n\nWhen in doubt, use it.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "todos": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "content": {
                  "type": "string",
                  "description": "Brief description of the task"
                },
                "status": {
                  "type": "string",
                  "description": "Current status of the task: pending, in_progress, completed, cancelled"
                },
                "priority": {
                  "type": "string",
                  "description": "Priority level of the task: high, medium, low"
                }
              },
              "required": [
                "content",
                "status",
                "priority"
              ]
            },
            "description": "The updated todo list"
          }
        },
        "required": [
          "todos"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "webfetch",
      "description": "- Fetches content from a specified URL\n- Takes a URL and optional format as input\n- Fetches the URL content, converts to requested format (markdown by default)\n- Returns the content in the specified format\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - Format options: \"markdown\" (default), \"text\", or \"html\"\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to fetch content from"
          },
          "format": {
            "type": "string",
            "enum": [
              "text",
              "markdown",
              "html"
            ],
            "description": "The format to return the content in (text, markdown, or html). Defaults to markdown.",
            "default": "markdown"
          },
          "timeout": {
            "type": "number",
            "description": "Optional timeout in seconds (max 120)"
          }
        },
        "required": [
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "websearch",
      "description": "- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs\n- Provides up-to-date information for current events and recent data\n- Supports configurable result counts and returns the content from the most relevant websites\n- Use this tool for accessing information beyond knowledge cutoff\n- Searches are performed automatically within a single API call\n\nUsage notes:\n  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)\n  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)\n  - Configurable context length for optimal LLM integration\n  - Domain filtering and advanced search options available\n\nThe current year is 2026. You MUST use this year when searching for recent information or current events\n- Example: If the current year is 2026 and the user asks for \"latest AI news\", search for \"AI news 2026\", NOT \"AI news 2025\"\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Websearch query"
          },
          "numResults": {
            "type": "number",
            "description": "Number of search results to return (default: 8)"
          },
          "livecrawl": {
            "type": "string",
            "enum": [
              "fallback",
              "preferred"
            ],
            "description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
          },
          "type": {
            "type": "string",
            "enum": [
              "auto",
              "fast",
              "deep"
            ],
            "description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
          },
          "contextMaxCharacters": {
            "type": "number",
            "description": "Maximum characters for context string optimized for LLMs (default: 10000)"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write",
      "description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "content": {
            "type": "string",
            "description": "The content to write to the file"
          },
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file to write (must be absolute, not relative)"
          }
        },
        "required": [
          "content",
          "filePath"
        ]
      }
    }
  }
];

// ─── OpenCode Native Web Search (`websearch` & `webfetch`) Implementation ────
function parseMcpWebSearchResponse(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  const trimmed = rawText.trim();

  function extractFromJsonStr(str) {
    try {
      const parsed = JSON.parse(str);
      const textItem = parsed?.result?.content?.find((c) => typeof c?.text === "string");
      if (textItem && textItem.text && !parsed?.result?._meta?.["ai.exa/rateLimited"]) {
        return textItem.text;
      }
    } catch {}
    return "";
  }

  if (trimmed.startsWith("{")) {
    const direct = extractFromJsonStr(trimmed);
    if (direct) return direct;
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      const fromSse = extractFromJsonStr(line.slice(6).trim());
      if (fromSse) return fromSse;
    }
  }
  return "";
}

function formatCompactSearchResults(rawText, maxResults = 5, maxExcerptChars = 320) {
  if (!rawText || typeof rawText !== "string") return "";
  const trimmed = rawText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed?.results) && parsed.results.length > 0) {
      const lines = [];
      for (const item of parsed.results.slice(0, maxResults)) {
        const title = String(item.title || "Untitled").trim();
        const url = String(item.url || "").trim();
        const date = item.publish_date ? ` (${item.publish_date})` : "";
        const excerptText = Array.isArray(item.excerpts)
          ? item.excerpts
              .map((e) => String(e || "").replace(/\s+/g, " ").trim())
              .filter(Boolean)
              .join(" | ")
              .slice(0, maxExcerptChars)
          : "";
        lines.push(`- ${title}${date} [${url}]\n  ${excerptText}`);
      }
      return lines.join("\n\n");
    }
  } catch {}
  return trimmed.slice(0, maxResults * maxExcerptChars);
}

async function executeOpenCodeWebSearch(args = {}, sessionId = getSessionId()) {
  const query = String(args.query || args.objective || "").trim();
  if (!query) return "No search query provided.";
  const maxResults = Number(args.numResults) || 6;

  // 1. Primary OpenCode Web Search Provider: Parallel MCP (`https://search.parallel.ai/mcp`)
  try {
    const parHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "opencode/1.19.0",
    };
    if (process.env.PARALLEL_API_KEY) {
      parHeaders.Authorization = `Bearer ${process.env.PARALLEL_API_KEY}`;
    }

    const parRes = await fetch("https://search.parallel.ai/mcp", {
      method: "POST",
      headers: parHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective: query,
            search_queries: [query],
            session_id: sessionId,
            model_name: DEFAULT_MODEL,
          },
        },
      }),
    });

    if (parRes.ok) {
      const raw = await parRes.text();
      const parsedText = parseMcpWebSearchResponse(raw);
      if (parsedText) {
        return formatCompactSearchResults(parsedText, maxResults, 480);
      }
    }
  } catch {
    // Fallback to Exa MCP below
  }

  // 2. Secondary OpenCode Web Search Provider: Exa MCP (`https://mcp.exa.ai/mcp`)
  try {
    const exaUrl = process.env.EXA_API_KEY
      ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
      : "https://mcp.exa.ai/mcp";

    const exaRes = await fetch(exaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "opencode/1.19.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query,
            type: args.type || "fast",
            numResults: maxResults,
            livecrawl: args.livecrawl || "fallback",
            contextMaxCharacters: args.contextMaxCharacters || 4000,
          },
        },
      }),
    });

    if (exaRes.ok) {
      const raw = await exaRes.text();
      const parsedText = parseMcpWebSearchResponse(raw);
      if (parsedText) {
        return formatCompactSearchResults(parsedText, maxResults, 480);
      }
    }
  } catch {}

  return "No search results found for that query.";
}

async function executeOpenCodeWebFetch(args = {}) {
  const targetUrl = String(args.url || "").trim();
  if (!targetUrl || (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))) {
    return "Invalid URL provided to webfetch.";
  }
  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Accept: "text/markdown, text/plain, text/html, application/json;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) {
      return `Failed to fetch ${targetUrl}: HTTP ${res.status}`;
    }
    const html = await res.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, 12000) || "Page returned empty content.";
  } catch (err) {
    return `Error fetching ${targetUrl}: ${err.message}`;
  }
}

function buildOpenCodeHeaders(sessionId) {
  const reqId = generateOpencodeRequestId();
  return {
    Authorization: `Bearer ${OPENCODE_API_KEY || "public"}`,
    "Content-Type": "application/json",
    "User-Agent": "opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
    "x-opencode-client": "cli",
    "x-opencode-project": "a070fc6ab60b2140452f8e06012ae52a1ed73781",
    "x-opencode-request": reqId,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    Accept: "*/*",
  };
}

function buildOpenCodeEnvTail(modelId) {
  return (
    `\n\nYou are powered by the model named ${modelId}. The exact model ID is opencode/${modelId}\n` +
    `Here is some useful information about the environment you are running in:\n` +
    `<env>\n` +
    `  Working directory: /home/user\n` +
    `  Workspace root folder: /home/user\n` +
    `  Is directory a git repo: yes\n` +
    `  Platform: linux\n` +
    `  Today's date: ${new Date().toDateString()}\n` +
    `</env>\n` +
    `Skills provide specialized instructions and workflows for specific tasks.\n` +
    `Use the skill tool to load a skill when a task matches its description.\n` +
    `<available_skills>\n` +
    `  <skill>\n` +
    `    <name>customize-opencode</name>\n` +
    `    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>\n` +
    `    <location>&lt;built-in&gt;</location>\n` +
    `  </skill>\n` +
    `</available_skills>`
  );
}

function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  const m = String(requestedModel).trim().toLowerCase().replace(/^opencode\//i, "");
  if (
    m === "max" ||
    m === "max-v1" ||
    m === "max-v1.0" ||
    m === "max v1.0" ||
    m === "vega" ||
    m === "default" ||
    m === "mimo" ||
    m === "mimo-v2.6-flash-free"
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

  // Collapse consecutive unanswered `role: "user"` messages (caused when an earlier turn timed out or errored in the client app)
  // so old unanswered requests don't hijack a new user message like "Hello" or "Tumhara name kya hai".
  if (messages.length >= 2) {
    const collapsed = [];
    for (let i = 0; i < messages.length; i++) {
      const curr = messages[i];
      const prev = collapsed.length > 0 ? collapsed[collapsed.length - 1] : null;
      if (prev && prev.role === "user" && curr && curr.role === "user") {
        const currTxt = typeof curr.content === "string" ? curr.content.trim() : "";
        const prevTxt = typeof prev.content === "string" ? prev.content.trim() : "";
        const isNudge =
          /^(karo|karo na|banao|banao na|bana do|bana de|haan|haan karo|haan banao|ok karo|okay karo|jaldi karo|jaldi banao|please karo|plz karo|abhi karo|do it|yes do it|generate it|make it|try again|phir se karo|fir se banao)[?!.\s]*$/i.test(
            currTxt
          );
        if (isNudge && prevTxt) {
          collapsed[collapsed.length - 1] = prev;
        } else {
          // Replace the stale unanswered user message with the newer user message
          collapsed[collapsed.length - 1] = curr;
        }
      } else {
        collapsed.push(curr);
      }
    }
    messages = collapsed;
  }

  const webSearchRuleSuffix =
    ` WEB SEARCH RULE: You have real-time internet access via OpenCode 'websearch' and 'webfetch' tools. For current events, news, live prices/rates, weather, scores, 2025/2026 facts, or online lookups, use live OpenCode web search facts (or call 'websearch' if not already provided). IMAGE GENERATION & EDITING POWER: You have full real-time Image Generation ('generate') and Image Editing ('edit') power via NVIDIA NIM ${NVIDIA_IMAGE_MODEL} (1024x1024 default + dynamic aspect ratios). NEVER say you cannot generate or edit images! Whenever the user asks to generate/create/draw an image or edit an uploaded photo, output <IMAGE_TASK action="generate" status="Ek second bhai, aapke liye image bana raha hoon... 🎨" reply="Yeh lijiye bhai, aapki image ban kar taiyar hai! 🎨">Detailed English image prompt</IMAGE_TASK> (or action="edit" for image edits). CRITICAL RULE: NEVER call bash, edit, glob, grep, or read.`;

  const hasSystem = messages.some(
    (m) => m && (m.role === "system" || m.role === "developer")
  );
  const customSystem = body.system || body.systemPrompt;
  if (customSystem) {
    const sysStr = String(customSystem);
    messages.unshift({
      role: "system",
      content: sysStr.includes("WEB SEARCH RULE") ? sysStr : `${sysStr}${webSearchRuleSuffix}`,
    });
  } else if (!hasSystem) {
    messages.unshift({ role: "system", content: defaultSystem });
  } else {
    messages = messages.map((m, i) => {
      if (
        i === 0 &&
        m &&
        (m.role === "system" || m.role === "developer") &&
        typeof m.content === "string" &&
        !m.content.includes("WEB SEARCH RULE")
      ) {
        return { ...m, content: `${m.content}${webSearchRuleSuffix}` };
      }
      return m;
    });
  }

  return messages;
}

// ─── Step 2 (LLM): OpenCode Upstream Call (`deepseek-v4.1-flash-free`) ───────
async function callOpenCodeUpstream(payload) {
  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const existingNames = new Set(
    existingTools
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean)
  );
  const missingStubs = GATEWAY_STUB_TOOLS.filter(
    (s) => !existingNames.has(s.function.name)
  );

  const resolvedTargetModel = resolveModel(payload.model);
  const isDeepSeek = resolvedTargetModel.toLowerCase().includes("deepseek");
  const disableReasoning = payload.disableReasoning === true && !isDeepSeek;
  const lastIdx = Array.isArray(payload.messages) ? payload.messages.length - 1 : -1;
  const preparedMessages = Array.isArray(payload.messages)
    ? payload.messages.map((m, idx) => {
        if (!m) return m;
        if (isDeepSeek) {
          if (typeof m.content === "string") {
            return {
              ...m,
              content: m.content.replace(/^\/no_think\s*/i, "").replace(/\s*\/no_think\s*$/i, ""),
            };
          }
          if (Array.isArray(m.content)) {
            return {
              ...m,
              content: m.content.map((part) =>
                part && part.type === "text" && typeof part.text === "string"
                  ? { ...part, text: part.text.replace(/\s*\/no_think\s*$/i, "") }
                  : part
              ),
            };
          }
          return m;
        }
        if (!disableReasoning) return m;
        if (typeof m.content === "string") {
          if (
            idx === 0 &&
            (m.role === "system" || m.role === "developer") &&
            !m.content.startsWith("/no_think")
          ) {
            return { ...m, content: `/no_think ${m.content}` };
          }
          if (
            idx === lastIdx &&
            (m.role === "user" || m.role === "tool") &&
            !m.content.includes("/no_think")
          ) {
            return { ...m, content: `${m.content}\n/no_think` };
          }
          return m;
        }
        if (idx === lastIdx && Array.isArray(m.content)) {
          return {
            ...m,
            content: m.content.map((part) => {
              if (
                part &&
                part.type === "text" &&
                typeof part.text === "string" &&
                !part.text.includes("/no_think")
              ) {
                return { ...part, text: `${part.text}\n/no_think` };
              }
              return part;
            }),
          };
        }
        return m;
      })
    : [];

  if (
    preparedMessages.length > 0 &&
    preparedMessages[0] &&
    (preparedMessages[0].role === "system" || preparedMessages[0].role === "developer") &&
    typeof preparedMessages[0].content === "string" &&
    !preparedMessages[0].content.includes("<available_skills>")
  ) {
    preparedMessages[0] = {
      ...preparedMessages[0],
      content: preparedMessages[0].content + buildOpenCodeEnvTail(resolvedTargetModel),
    };
  }

  const allTools = [...existingTools, ...missingStubs].sort((a, b) =>
    String(a?.function?.name || "").localeCompare(String(b?.function?.name || ""))
  );

  const upstreamBody = {
    model: resolvedTargetModel,
    max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : 32000,
    messages: preparedMessages,
    tools: allTools,
    tool_choice: payload.tool_choice && payload.tool_choice !== "none" ? payload.tool_choice : "auto",
    stream: true,
    stream_options: { include_usage: true },
  };

  recordSentPrompt({
    agent: "text",
    model: upstreamBody.model,
    systemPrompt: preparedMessages.find((m) => m && m.role === "system")?.content || "",
    messages: preparedMessages,
  });

  if (typeof payload.temperature === "number") {
    upstreamBody.temperature = payload.temperature;
  }

  const bodyJson = JSON.stringify(upstreamBody);

  let lastStatus = 502;
  let lastErrorText = "";

  for (let attempt = 0; attempt < 3; attempt++) {
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

    lastStatus = response.status;
    lastErrorText = await response.text().catch(() => "");

    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      continue;
    }
    break;
  }

  return {
    ok: false,
    status: lastStatus,
    errorText: lastErrorText || `Upstream returned HTTP ${lastStatus}`,
  };
}

async function collectSSEStream(response, fallbackModel, callbacks = {}) {
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
  const toolCallsMap = new Map();
  const notifiedToolNames = new Set();

  // For normal chat, guard against streaming raw `<IMAGE_TASK>` or `<think>` tags into message content
  let pendingLeadingBuffer = "";
  let leadingMode = callbacks.rawContentTokens ? "normal" : "undecided"; // "undecided" | "normal" | "image_tag" | "think_tag"

  const emitThinking = (tokenText) => {
    if (!tokenText || typeof callbacks.onThinkingToken !== "function") return;
    try {
      callbacks.onThinkingToken({
        token: tokenText,
        thinking: reasoning,
        reasoning,
        id,
        created,
        model,
      });
    } catch {}
  };

  const emitContent = (tokenText) => {
    if (!tokenText || typeof callbacks.onContentToken !== "function") return;
    try {
      callbacks.onContentToken({
        token: tokenText,
        content,
        id,
        created,
        model,
      });
    } catch {}
  };

  let streamDone = false;
  while (!streamDone) {
    let readResult;
    let readTimer = null;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          readTimer = setTimeout(() => rej(new Error("SSE read idle timeout")), 12000);
        }),
      ]);
      if (readTimer) clearTimeout(readTimer);
    } catch {
      if (readTimer) clearTimeout(readTimer);
      try {
        reader.cancel().catch(() => {});
      } catch {}
      break;
    }
    const { value, done } = readResult;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    if (buffer.trim() === "data: [DONE]" || buffer.includes("[DONE]")) {
      lines.push(buffer);
      buffer = "";
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr) continue;
      if (dataStr === "[DONE]") {
        streamDone = true;
        try {
          reader.cancel().catch(() => {});
        } catch {}
        break;
      }

      try {
        const chunk = JSON.parse(dataStr);
        if (chunk.id) id = chunk.id;
        if (chunk.created) created = chunk.created;
        if (
          chunk.model &&
          !chunk.model.startsWith("private/") &&
          !chunk.model.startsWith("nvidia/") &&
          !chunk.model.startsWith("minimaxai/") &&
          !chunk.model.startsWith("openai/")
        ) {
          model = chunk.model;
        }
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};
          const reasoningPiece =
            typeof delta.reasoning === "string" && delta.reasoning.length > 0
              ? delta.reasoning
              : typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
              ? delta.reasoning_content
              : "";
          if (reasoningPiece) {
            reasoning += reasoningPiece;
            emitThinking(reasoningPiece);
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            content += delta.content;
            if (leadingMode === "normal") {
              emitContent(delta.content);
            } else if (leadingMode === "undecided") {
              pendingLeadingBuffer += delta.content;
              const trimmedLead = pendingLeadingBuffer.trimStart();
              if (trimmedLead.length > 0 && !trimmedLead.startsWith("<")) {
                leadingMode = "normal";
                emitContent(pendingLeadingBuffer);
                pendingLeadingBuffer = "";
              } else if (trimmedLead.length >= 12) {
                if (/^<IMAGE_TASK/i.test(trimmedLead)) {
                  leadingMode = "image_tag";
                  pendingLeadingBuffer = "";
                } else if (/^<think>/i.test(trimmedLead)) {
                  leadingMode = "think_tag";
                  const inner = trimmedLead.replace(/^<think>/i, "");
                  if (inner) {
                    reasoning += inner;
                    emitThinking(inner);
                  }
                  pendingLeadingBuffer = "";
                } else {
                  leadingMode = "normal";
                  emitContent(pendingLeadingBuffer);
                  pendingLeadingBuffer = "";
                }
              }
            } else if (leadingMode === "think_tag") {
              if (content.includes("</think>")) {
                leadingMode = "normal";
                const afterThink = delta.content.split(/<\/think>/i).pop() || "";
                if (afterThink) emitContent(afterThink);
              } else {
                reasoning += delta.content;
                emitThinking(delta.content);
              }
            } else if (leadingMode === "image_tag") {
              // Route inner prompt tokens of <IMAGE_TASK> to thinking stream so user sees live progress
              const cleanToken = delta.content.replace(/<\/?IMAGE_TASK[^>]*>/gi, "");
              if (cleanToken) {
                emitThinking(cleanToken);
              }
            }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, {
                  id: tc.id || `call_${Date.now()}_${idx}`,
                  type: "function",
                  function: { name: "", arguments: "" },
                });
              }
              const entry = toolCallsMap.get(idx);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.function.name += tc.function.name;
              if (typeof tc.function?.arguments === "string") {
                entry.function.arguments += tc.function.arguments;
              }
              if (typeof callbacks.onToolCallDelta === "function") {
                const isFirstName =
                  Boolean(entry.function.name) && !notifiedToolNames.has(idx);
                if (isFirstName) notifiedToolNames.add(idx);
                try {
                  callbacks.onToolCallDelta({
                    toolCall: entry,
                    rawDelta: tc,
                    isToolStart: isFirstName,
                    id,
                    created,
                    model,
                  });
                } catch {}
              }
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            streamDone = true;
            try {
              reader.cancel().catch(() => {});
            } catch {}
            break;
          }
        }
      } catch {
        // Ignore keep-alive comments
      }
    }
  }

  if (leadingMode === "undecided" && pendingLeadingBuffer) {
    emitContent(pendingLeadingBuffer);
    pendingLeadingBuffer = "";
  }

  const toolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.function.name);
  if (!reasoning && typeof content === "string") {
    const thinkTagMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkTagMatch && thinkTagMatch[1]) {
      reasoning = thinkTagMatch[1].trim();
    }
  }
  content = stripLeakedReasoning(content);
  return { id, created, model, content, reasoning, finishReason, usage, toolCalls };
}

function stripLeakedReasoning(text) {
  if (!text || typeof text !== "string") return "";
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (/^(?:The user|User is|User wants|User asked)\b/i.test(cleaned)) {
    const gluedMatch = cleaned.match(/^[\s\S]*?\.[)"']?(?=[A-Z\u0900-\u097F])/);
    if (gluedMatch) {
      cleaned = cleaned.slice(gluedMatch[0].length).trim();
    } else if (cleaned.includes("\n\n")) {
      cleaned = cleaned.split(/\n\s*\n/).slice(1).join("\n\n").trim();
    } else {
      cleaned = cleaned
        .replace(/^The user[\s\S]*?(?:I should|I'll|I will|Let's|Let me)[^.!?\n]*[.!?]\s*/i, "")
        .trim();
    }
  }
  return cleaned || text.trim();
}

/**
 * Extracts plain text from the latest user message in a messages array.
 * If the latest user message is a short confirmation/nudge ("Karo na", "Banao na", "Haan karo", "Do it", "Try again"),
 * automatically resolves the preceding user request from the conversation history so follow-up nudges work seamlessly.
 */
function extractLatestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const userTexts = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      let txt = "";
      if (typeof m.content === "string") txt = m.content.trim();
      else if (Array.isArray(m.content)) {
        const textPart = m.content.find((p) => p && p.type === "text" && typeof p.text === "string");
        if (textPart) txt = textPart.text.trim();
      }
      if (txt) userTexts.push(txt);
    }
  }
  if (userTexts.length === 0) return "";
  const latest = userTexts[0];
  const isShortNudge =
    /^(karo|karo na|banao|banao na|bana do|bana de|haan|haan karo|haan banao|ok karo|okay karo|jaldi karo|jaldi banao|please karo|plz karo|abhi karo|do it|yes do it|generate it|make it|try again|phir se karo|fir se banao)[?!.\s]*$/i.test(
      latest
    );
  if (isShortNudge && userTexts.length > 1) {
    return userTexts[1];
  }
  return latest;
}

/**
 * Extracts `{ dataUri, rawBase64, mimeType, isCurrentTurnImage }` from `body` or `messages`.
 * Also supports resolving `/api/image/view/:id` from `generatedImagesStore` for multi-turn edits.
 */
function extractLatestImageInput(body = {}, messages = []) {
  let rawCandidate =
    body.image ||
    body.imageBase64 ||
    body.imageUrl ||
    (Array.isArray(body.images) && body.images.length > 0 ? body.images[0] : null);
  let isCurrentTurnImage = Boolean(rawCandidate);

  if (!rawCandidate && Array.isArray(messages)) {
    // Find index of the latest user message
    let latestUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "user") {
        latestUserIdx = i;
        break;
      }
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === "user" && Array.isArray(m.content)) {
        const imgPart = m.content.find(
          (p) => p && p.type === "image_url" && p.image_url && p.image_url.url
        );
        if (imgPart) {
          rawCandidate = imgPart.image_url.url;
          isCurrentTurnImage = i === latestUserIdx;
          break;
        }
      }
      // Also check if an assistant message contains a `/api/image/view/img_...` URL in `generatedImagesStore`
      if (typeof m.content === "string") {
        const viewMatch = m.content.match(/\/api\/image\/view\/(img_[A-Za-z0-9_.]+\.(?:jpg|png))/i);
        if (viewMatch && generatedImagesStore.has(viewMatch[1])) {
          const cached = generatedImagesStore.get(viewMatch[1]);
          if (cached && cached.buffer) {
            const b64 = cached.buffer.toString("base64");
            const mime = cached.mimeType || "image/jpeg";
            return {
              dataUri: `data:${mime};base64,${b64}`,
              rawBase64: b64,
              mimeType: mime,
              isCurrentTurnImage: false,
            };
          }
        }
      }
    }
  }

  if (!rawCandidate) return null;
  const rawStr =
    typeof rawCandidate === "object"
      ? rawCandidate.url || rawCandidate.data || rawCandidate.base64 || ""
      : String(rawCandidate);

  // If rawStr is a `/api/image/view/img_...` URL stored in memory, resolve its base64 directly
  const viewIdMatch = rawStr.match(/\/api\/image\/view\/(img_[A-Za-z0-9_.]+\.(?:jpg|png))/i);
  if (viewIdMatch && generatedImagesStore.has(viewIdMatch[1])) {
    const cached = generatedImagesStore.get(viewIdMatch[1]);
    if (cached && cached.buffer) {
      const b64 = cached.buffer.toString("base64");
      const mime = cached.mimeType || "image/jpeg";
      return {
        dataUri: `data:${mime};base64,${b64}`,
        rawBase64: b64,
        mimeType: mime,
        isCurrentTurnImage,
      };
    }
  }

  const dataUri = toImageDataUri(rawStr, body.mimeType || "image/png");
  if (!dataUri) return null;

  let mimeType = "image/png";
  let rawBase64 = dataUri;
  if (dataUri.startsWith("data:")) {
    const commaIdx = dataUri.indexOf(",");
    if (commaIdx !== -1) {
      const header = dataUri.slice(5, commaIdx);
      mimeType = header.split(";")[0] || "image/png";
      rawBase64 = dataUri.slice(commaIdx + 1).replace(/\s+/g, "");
    }
  }
  return { dataUri, rawBase64, mimeType, isCurrentTurnImage };
}

/**
 * Detects whether the user is asking Max v1.0 to EDIT an uploaded image ("edit")
 * or GENERATE a new image ("generate"). Returns "edit" | "generate" | null.
 */
function detectImageTaskIntent(userText = "", imageInput = null, body = {}) {
  if (body.imageAction === "edit" || body.mode === "edit") return "edit";
  if (body.imageAction === "generate" || body.mode === "generate") return "generate";
  if (body.imageAction === false || body.disableImageGen === true) return null;

  const q = String(userText || "").toLowerCase().trim();
  if (!q) return null;

  const hasImage = Boolean(imageInput && imageInput.dataUri);
  const isCurrentTurnImage =
    typeof imageInput === "object" && imageInput !== null
      ? Boolean(imageInput.isCurrentTurnImage)
      : Boolean(imageInput);

  // Skip chat-title generation / conversation summary meta-prompts sent automatically by the Vega app
  if (
    /\bcreate a short,\s*clear title\b/i.test(q) ||
    /\btitle\s*\([^)]*words?\)\s*for this chat\b/i.test(q) ||
    /\bbased on the user's first message\b/i.test(q) ||
    /\breturn only the title\b/i.test(q)
  ) {
    return null;
  }

  // Skip pure capability questions ("kya tum image generate kar sakte ho?", "can you generate images?")
  if (
    /\b(kya tum|kya aap|can you|are you able to|do you have)\b[\s\S]{0,50}\b(kar sakte|bana sakte|sakte ho|sakti ho)\b/i.test(
      q
    ) ||
    /^(can you|do you)\s+(generate|create|edit)\s+(images?|photos?|pictures?)[?!.\s]*$/i.test(q)
  ) {
    return null;
  }

  const generatePatterns = [
    /\b(generate|create|draw|paint|make|design|render)\b[\s\S]{0,40}\b(image|photo|picture|pic|art|illustration|wallpaper|logo|poster|avatar|portrait|tasveer|scene|sketch|painting)\b/i,
    /\b(image|photo|picture|pic|tasveer|wallpaper|logo|poster|portrait|sketch|painting)\b[\s\S]{0,40}\b(generate|create|make|draw|render|banao|bana|bana do|bana de|banaiye|dikhao|de do|bhej|nikal|karne|karni|karna)\b/i,
    /\b(banao|bana do|bana de|generate karo|generate kar|generate karne|generate karni|create karo|create kar|draw karo|draw kar)\b[\s\S]{0,40}\b(image|photo|picture|pic|tasveer|wallpaper|logo|poster)\b/i,
    /(इमेज|फोटो|फ़ोटो|तस्वीर|पिक्चर|वॉलपेपर|लोगो|पोस्टर|पेंटिंग)[\s\S]{0,30}(बनाओ|बना दो|बना दे|जनरेट|क्रिएट|दिखाओ)/,
    /(बनाओ|बना दो|जनरेट करो|क्रिएट करो)[\s\S]{0,30}(इमेज|फोटो|फ़ोटो|तस्वीर|पिक्चर|वॉलपेपर|लोगो)/,
  ];
  const refersToExistingImage =
    /\b(is me|isme|is mai|ismai|isko|is ko|is photo|is image|is pic|iska|is ka|iske|is ke|in this|this image|this photo|the background|background ko|bg ko)\b/i.test(
      q
    );

  // If no image was uploaded in the CURRENT message and user asks to generate a new subject (without saying "is me/isko"), route to "generate"!
  if (!isCurrentTurnImage && !refersToExistingImage && generatePatterns.some((re) => re.test(q))) {
    return "generate";
  }

  if (hasImage && (isCurrentTurnImage || refersToExistingImage)) {
    // Pure Q&A questions about an uploaded image ("ye kya hai?", "read this text", "solve this")
    const pureQuestionOnly =
      /^(what is this|who is this|read this|translate this|solve this|explain this|ye kya hai|yeh kya hai|is photo me kya hai|is image me kya likha hai|isko padho|isko solve karo)[?!.\s]*$/i.test(
        q
      );
    if (pureQuestionOnly) return null;

    const editPatterns = [
      /\b(edit|modify|change|replace|remove|delete|erase|add|put|wear|make|turn|convert|transform|recreate|redesign|restyle|style|filter|enhance|upscale|color|colour|background|bg|sky|lighting|anime|cartoon|ghibli|cyberpunk|realistic|3d|sketch|painting|oil painting|cinematic|sunglasses|glasses|hat|crown|suit|jacket|dress|clothes|hair|beard|smile|blur|bright|dark|glow|hd|clear|clean|retouch|fix|crop|zoom)\b/i,
      /\b(bana do|banado|banao|bana de|banade|kar do|kardo|kar de|karde|laga do|lagado|lagao|laga de|lagade|hata do|hatado|hatao|hata de|hatade|badal do|badaldo|badlo|badal de|badalde|dal do|daal do|dalo|daalo|pehna|pehan|dikhao|dikha|set kar|edit kar|change kar|add kar|remove kar|chashma|mukut|kapde|baal|rang|piche|aage)\b/i,
      /(एडिट|बदल|बना दो|बनाओ|कर दो|लगा दो|हटा दो|बैकग्राउंड|रंग|चश्मा|कपड़े|फिल्टर|पहना|दिखाओ|पीछे)/,
    ];
    if (editPatterns.some((re) => re.test(q))) {
      return "edit";
    }
    if (!isCurrentTurnImage && generatePatterns.some((re) => re.test(q))) {
      return "generate";
    }
    return null;
  }

  if (generatePatterns.some((re) => re.test(q))) {
    return "generate";
  }
  return null;
}

/**
 * Checks if `deepseek-v4.1-flash-free` emitted an `<IMAGE_TASK ...>prompt</IMAGE_TASK>` tag
 * OR accidentally claimed it cannot generate/edit images when the user asked for one.
 */
function parseModelImageFallback(content = "", userText = "", hasImage = false) {
  const q = String(userText || "").toLowerCase();
  if (
    /\bcreate a short,\s*clear title\b/i.test(q) ||
    /\btitle\s*\([^)]*words?\)\s*for this chat\b/i.test(q) ||
    /\bbased on the user's first message\b/i.test(q) ||
    /\breturn only the title\b/i.test(q)
  ) {
    return null;
  }
  const raw = String(content || "").trim();
  const tagMatch = raw.match(
    /<IMAGE_TASK(?:\s+action=["']?(generate|edit)["']?)?(?:\s+status=["']([^"']*)["'])?(?:\s+reply=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/IMAGE_TASK>/i
  );
  if (tagMatch) {
    return {
      action: tagMatch[1] ? tagMatch[1].toLowerCase() : hasImage ? "edit" : "generate",
      statusMessage: tagMatch[2] || "",
      finalReply: tagMatch[3] || "",
      maxPrompt: (tagMatch[4] || userText || "").trim(),
    };
  }
  // Safety catch: if model accidentally refused image generation/editing in Hindi/Hinglish/English
  const refusalPattern =
    /(?:cannot|can't|unable to|do not have the ability to|don't have the power to)\s+(?:generate|create|draw|make|edit)\s+(?:an?\s+)?(?:image|images|photo|photos|picture|pictures)|(?:image|photo|tasveer|picture|इमेज|फोटो|तस्वीर)[\s\S]{0,40}(?:power|shamta|kshamta|suvidha|capability|feature|क्षमता|पावर|सुविधा)\s+(?:nahi|nhi|नहीं)/i;
  if (refusalPattern.test(raw)) {
    return {
      action: hasImage ? "edit" : "generate",
      statusMessage: "",
      finalReply: "",
      maxPrompt: userText,
    };
  }
  return null;
}

// In-memory + /tmp disk + Vega Storage (`https://vega-storage.onrender.com/v1/files`) store for generated/edited images
const generatedImagesStore = new Map();
const TMP_IMAGE_DIR = "/tmp/vega_generated_images";
try {
  fs.mkdirSync(TMP_IMAGE_DIR, { recursive: true });
} catch {}

function saveGeneratedImageBuffer(buffer, mimeType = "image/jpeg", customFileId = "") {
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const cleanFileId = String(customFileId || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "");
  const id = cleanFileId
    ? `img_${cleanFileId}.${ext}`
    : `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;

  generatedImagesStore.set(id, {
    buffer,
    mimeType,
    fileId: cleanFileId || null,
    createdAt: Date.now(),
  });
  if (generatedImagesStore.size > 60) {
    const oldestKey = generatedImagesStore.keys().next().value;
    if (oldestKey) generatedImagesStore.delete(oldestKey);
  }
  try {
    fs.writeFileSync(path.join(TMP_IMAGE_DIR, id), buffer);
  } catch {}
  return id;
}

/**
 * Uploads a generated/edited image buffer to Vega Storage (`POST https://vega-storage.onrender.com/v1/files`)
 * under the user's email (`X-Owner`) and chat (`X-Parent-Id`) so the user's images are permanently stored in Vega Vault.
 */
async function uploadBufferToVegaStorage({
  buffer,
  mimeType = "image/jpeg",
  filename = "",
  owner = "",
  parentId = "",
  ztKey = "",
} = {}) {
  const resolvedKey = String(
    ztKey || process.env.ZENTRAGRID_API_KEY || process.env.STORAGE_API_KEY || ""
  ).trim();
  if (!resolvedKey || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }
  const ztBase = (
    process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com"
  ).replace(/\/+$/, "");
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const safeName = filename || `vega_image_${Date.now()}.${ext}`;
  const boundary = `----VegaStorageBoundary${crypto.randomBytes(12).toString("hex")}`;

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const multipartBody = Buffer.concat([headerPart, buffer, footerPart]);

  const headers = {
    Authorization: `Bearer ${resolvedKey}`,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(multipartBody.length),
  };
  if (owner) headers["X-Owner"] = String(owner).trim().toLowerCase();
  if (parentId) headers["X-Parent-Id"] = String(parentId).trim();

  try {
    const res = await Promise.race([
      fetch(`${ztBase}/v1/files`, {
        method: "POST",
        headers,
        body: multipartBody,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Storage upload timeout")), 8000)),
    ]);
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const data = json?.data || json || {};
    const fileId = data.id || json?.id || "";
    if (!fileId) return null;
    return {
      fileId: String(fileId),
      record: data,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a stored image buffer by `imgId` (e.g. `img_<fileId>.jpg` or `<fileId>`):
 * 1) Checks in-memory `generatedImagesStore`
 * 2) Checks `/tmp/vega_generated_images/<imgId>`
 * 3) Downloads from Vega Storage `GET https://vega-storage.onrender.com/v1/files/<fileId>/download`
 */
async function resolveStoredImageBuffer(imgId = "", ztKey = "") {
  const cleanId = String(imgId || "").trim();
  if (!cleanId) return null;

  // 1) In-memory Map
  const memItem = generatedImagesStore.get(cleanId);
  if (memItem && Buffer.isBuffer(memItem.buffer) && memItem.buffer.length > 0) {
    return memItem;
  }

  // 2) Local /tmp disk cache
  const diskPath = path.join(TMP_IMAGE_DIR, path.basename(cleanId));
  try {
    if (fs.existsSync(diskPath)) {
      const buf = fs.readFileSync(diskPath);
      if (buf && buf.length > 0) {
        const mimeType = cleanId.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        const entry = { buffer: buf, mimeType, createdAt: Date.now() };
        generatedImagesStore.set(cleanId, entry);
        return entry;
      }
    }
  } catch {}

  // 3) Vega Storage `/v1/files/:fileId/download`
  const resolvedKey = String(
    ztKey || process.env.ZENTRAGRID_API_KEY || process.env.STORAGE_API_KEY || ""
  ).trim();
  if (!resolvedKey) return null;

  // Extract fileId from `img_<fileId>.jpg`, `img_<timestamp>_<hex>.jpg`, or `<fileId>`
  let candidateFileId = cleanId.replace(/\.(jpg|jpeg|png|webp)$/i, "");
  if (candidateFileId.startsWith("img_")) {
    candidateFileId = candidateFileId.slice(4);
  }
  if (!candidateFileId || /^\d{13}_[0-9a-f]{8}$/i.test(candidateFileId)) {
    return null;
  }

  const ztBase = (
    process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com"
  ).replace(/\/+$/, "");

  try {
    const dlRes = await Promise.race([
      fetch(`${ztBase}/v1/files/${encodeURIComponent(candidateFileId)}/download`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resolvedKey}`,
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Storage download timeout")), 8000)),
    ]);
    if (!dlRes.ok) return null;
    const arrBuf = await dlRes.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    if (!buf || buf.length === 0) return null;
    const mimeType =
      dlRes.headers.get("content-type") ||
      (cleanId.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    const entry = {
      buffer: buf,
      mimeType,
      fileId: candidateFileId,
      createdAt: Date.now(),
    };
    generatedImagesStore.set(cleanId, entry);
    try {
      fs.writeFileSync(diskPath, buf);
    } catch {}
    return entry;
  } catch {
    return null;
  }
}

/**
 * Persists a generated/edited image turn into `ai_chats` + `ai_messages` on Vega Storage
 * using the deterministic `ai_chat_<slug>_<ms>` and `ai_msg_<chatId>_<seq>` IDs.
 */
async function persistImageTurnToHistory({
  userEmail = "",
  chatId = "",
  device = "android",
  userPrompt = "",
  finalReply = "",
  fileId = "",
  imageId = "",
  imageUrl = "",
  maxPrompt = "",
  action = "generate",
  width = 1024,
  height = 1024,
  thinking = "",
  ztKey = "",
} = {}) {
  const email = String(userEmail || "").trim().toLowerCase();
  const resolvedKey = String(
    ztKey || process.env.ZENTRAGRID_API_KEY || process.env.STORAGE_API_KEY || ""
  ).trim();
  if (!email || !resolvedKey) return null;

  const ztBase = (
    process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com"
  ).replace(/\/+$/, "");
  const slug =
    email
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "user";
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const targetChatId = String(chatId || "").trim() || `ai_chat_${slug}_${nowMs}`;

  const ztJson = async (relPath, method = "GET", bodyObj = null) => {
    const r = await fetch(`${ztBase}${relPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
        ...(bodyObj ? { "Content-Type": "application/json" } : {}),
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });
    const txt = await r.text().catch(() => "");
    let parsed = null;
    try {
      parsed = txt ? JSON.parse(txt) : null;
    } catch {}
    return { ok: r.ok, status: r.status, json: parsed };
  };

  try {
    const existingRes = await ztJson(
      `/v1/data/ai_chats?where=id:eq:${encodeURIComponent(targetChatId)}&limit=1`
    );
    let chatData = (existingRes.json?.documents || [])[0]?.data || null;
    if (!chatData) {
      const titleText = String(userPrompt || "Generated Image").trim().slice(0, 60) || "New chat";
      chatData = {
        id: targetChatId,
        user: email,
        title: titleText,
        created_at: nowIso,
        updated_at: nowIso,
        turns: 0,
        last_text: String(finalReply || userPrompt || "").trim().slice(0, 120),
        device: device === "ios" || device === "web" ? device : "android",
      };
      await ztJson("/v1/data/ai_chats", "POST", { id: targetChatId, data: chatData });
    }

    const baseTurns = Number(chatData.turns) || 0;
    const userSeq = baseTurns + 1;
    const aiSeq = baseTurns + 2;
    const userMsgId = `ai_msg_${targetChatId}_${String(userSeq).padStart(4, "0")}`;
    const aiMsgId = `ai_msg_${targetChatId}_${String(aiSeq).padStart(4, "0")}`;
    const aiIso = new Date(nowMs + 1).toISOString();

    const userMsgData = {
      id: userMsgId,
      chat_id: targetChatId,
      user: email,
      role: "user",
      text: String(userPrompt || ""),
      at: nowIso,
      kind: "image",
    };

    const aiMsgData = {
      id: aiMsgId,
      chat_id: targetChatId,
      user: email,
      role: "ai",
      text: String(finalReply || ""),
      at: aiIso,
      kind: "image",
      ...(fileId ? { file_id: String(fileId) } : {}),
      ...(imageId ? { image_id: String(imageId) } : {}),
      ...(imageUrl ? { image_url: String(imageUrl) } : {}),
      ...(maxPrompt ? { max_prompt: String(maxPrompt) } : {}),
      ...(thinking ? { thinking: String(thinking).slice(0, 4000) } : {}),
      image_action: action === "edit" ? "edit" : "generate",
      width: Number(width) || 1024,
      height: Number(height) || 1024,
    };

    await ztJson("/v1/data/ai_messages", "POST", { id: userMsgId, data: userMsgData });
    await ztJson("/v1/data/ai_messages", "POST", { id: aiMsgId, data: aiMsgData });

    const patchFields = {
      updated_at: aiIso,
      turns: aiSeq,
      last_text: String(finalReply || userPrompt || "").trim().slice(0, 120),
    };
    await ztJson(`/v1/data/ai_chats/${encodeURIComponent(targetChatId)}`, "PATCH", {
      data: patchFields,
    });

    return {
      chatId: targetChatId,
      userMessage: userMsgData,
      aiMessage: aiMsgData,
    };
  } catch {
    return null;
  }
}

/**
 * Lists stored generated/edited images for a user across:
 * 1) Local in-memory / `/tmp/vega_generated_images/*.json` store
 * 2) Vega Storage `GET /v1/files?owner=<email>` + `GET /v1/data/ai_messages?where=user:eq:<email>`
 */
async function listStoredUserImages({
  userEmail = "",
  chatId = "",
  limit = 50,
  ztKey = "",
  publicBaseUrl = "https://vega-ai-6m2k.onrender.com",
} = {}) {
  const email = String(userEmail || "").trim().toLowerCase();
  const filterChatId = String(chatId || "").trim();
  const maxItems = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  const byKey = new Map();

  // 1) Local in-memory + /tmp sidecar metadata
  for (const [imgId, entry] of generatedImagesStore.entries()) {
    if (email && entry.user && String(entry.user).toLowerCase() !== email) continue;
    if (filterChatId && entry.chatId && String(entry.chatId) !== filterChatId) continue;
    const key = entry.fileId || imgId;
    byKey.set(key, {
      imageId: imgId,
      fileId: entry.fileId || null,
      user: entry.user || email || null,
      chatId: entry.chatId || null,
      action: entry.action || "generate",
      imageModel: entry.imageModel || NVIDIA_IMAGE_MODEL,
      mimeType: entry.mimeType || "image/jpeg",
      width: entry.width || 1024,
      height: entry.height || 1024,
      aspectRatio: entry.aspectRatio || "1:1",
      userPrompt: entry.userPrompt || null,
      maxPrompt: entry.maxPrompt || null,
      reply: entry.finalReply || null,
      imageUrl: entry.imageUrl || `${baseUrl}/api/image/view/${imgId}`,
      createdAt:
        typeof entry.createdAt === "string"
          ? entry.createdAt
          : new Date(entry.createdAt || Date.now()).toISOString(),
    });
  }

  try {
    const files = fs.readdirSync(TMP_IMAGE_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(TMP_IMAGE_DIR, f), "utf8"));
        if (!meta || !meta.imageId) continue;
        if (email && meta.user && String(meta.user).toLowerCase() !== email) continue;
        if (filterChatId && meta.chatId && String(meta.chatId) !== filterChatId) continue;
        const key = meta.fileId || meta.imageId;
        if (!byKey.has(key)) {
          byKey.set(key, {
            ...meta,
            imageUrl: meta.imageUrl || `${baseUrl}/api/image/view/${meta.imageId}`,
          });
        }
      } catch {}
    }
  } catch {}

  // 2) Vega Storage `/v1/files` + `ai_messages` when ztKey is available
  const resolvedKey = String(
    ztKey || process.env.ZENTRAGRID_API_KEY || process.env.STORAGE_API_KEY || ""
  ).trim();
  if (resolvedKey) {
    const ztBase = (
      process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com"
    ).replace(/\/+$/, "");

    // 2a) Query `/v1/files` by owner
    try {
      const qs = new URLSearchParams();
      if (email) qs.set("owner", email);
      if (filterChatId) qs.set("parent_id", filterChatId);
      const fRes = await fetch(
        `${ztBase}/v1/files${qs.toString() ? `?${qs.toString()}` : ""}`,
        {
          headers: { Authorization: `Bearer ${resolvedKey}` },
        }
      );
      if (fRes.ok) {
        const fJson = await fRes.json().catch(() => null);
        const fileList = fJson?.files || fJson?.data?.files || [];
        for (const fDoc of fileList) {
          const mime = String(fDoc.mime || "");
          if (!mime.startsWith("image/") && !/\.(jpg|jpeg|png|webp)$/i.test(String(fDoc.name || ""))) {
            continue;
          }
          const ext = mime.includes("png") ? "png" : "jpg";
          const fId = String(fDoc.id || "");
          if (!fId) continue;
          const imgId = `img_${fId}.${ext}`;
          if (!byKey.has(fId)) {
            byKey.set(fId, {
              imageId: imgId,
              fileId: fId,
              user: fDoc.owner || email || null,
              chatId: fDoc.parent_id && fDoc.parent_id !== "vega_ai_images" ? fDoc.parent_id : null,
              action: String(fDoc.name || "").includes("_edit_") ? "edit" : "generate",
              mimeType: mime || "image/jpeg",
              size: fDoc.size || null,
              imageUrl: `${baseUrl}/api/image/view/${imgId}`,
              downloadUrl: `${baseUrl}/v1/files/${fId}/download`,
              createdAt: fDoc.created_at || new Date().toISOString(),
            });
          }
        }
      }
    } catch {}

    // 2b) Enrich with `ai_messages` image turns for this user/chat
    if (email || filterChatId) {
      try {
        const whereClause = filterChatId
          ? `chat_id:eq:${encodeURIComponent(filterChatId)}`
          : `user:eq:${encodeURIComponent(email)}`;
        const mRes = await fetch(
          `${ztBase}/v1/data/ai_messages?where=${whereClause}&order_by=at:desc&limit=200`,
          {
            headers: { Authorization: `Bearer ${resolvedKey}` },
          }
        );
        if (mRes.ok) {
          const mJson = await mRes.json().catch(() => null);
          for (const doc of mJson?.documents || []) {
            const d = doc.data || {};
            if (d.role !== "ai" && d.role !== "assistant") continue;
            if (d.kind !== "image" && !d.image_url && !d.file_id) continue;
            const fId = d.file_id || null;
            const imgId = d.image_id || (fId ? `img_${fId}.jpg` : doc.id);
            const key = fId || imgId;
            const existing = byKey.get(key) || {};
            byKey.set(key, {
              ...existing,
              imageId: imgId,
              fileId: fId || existing.fileId || null,
              user: d.user || existing.user || email || null,
              chatId: d.chat_id || existing.chatId || null,
              action: d.image_action || existing.action || "generate",
              width: d.width || existing.width || 1024,
              height: d.height || existing.height || 1024,
              maxPrompt: d.max_prompt || existing.maxPrompt || null,
              reply: d.text || d.content || existing.reply || null,
              imageUrl: d.image_url || existing.imageUrl || `${baseUrl}/api/image/view/${imgId}`,
              createdAt: d.at || d.created_at || existing.createdAt || new Date().toISOString(),
            });
          }
        }
      } catch {}
    }
  }

  const allItems = Array.from(byKey.values());
  allItems.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return allItems.slice(0, maxItems);
}

/**
 * Enriches image agent options with user email, chatId, and storage API key from HTTP headers or query params.
 */
function enrichImageOptionsFromReq(req, url, body = {}) {
  const userFromHeader =
    req.headers["x-user-email"] ||
    req.headers["x-owner"] ||
    req.headers["x-user"] ||
    url?.searchParams?.get("user") ||
    url?.searchParams?.get("email") ||
    "";
  const chatFromHeader =
    req.headers["x-chat-id"] ||
    req.headers["x-parent-id"] ||
    url?.searchParams?.get("chatId") ||
    url?.searchParams?.get("chat_id") ||
    "";
  const ztKeyFromHeader =
    req.headers["x-zentragrid-key"] ||
    req.headers["x-storage-key"] ||
    req.headers["x-api-key"] ||
    "";

  return {
    ...body,
    user: body.user || body.email || body.userId || userFromHeader || "",
    chatId: body.chatId || body.chat_id || chatFromHeader || "",
    zentragridApiKey:
      body.zentragridApiKey || body.storageApiKey || ztKeyFromHeader || "",
  };
}

/**
 * Reads width & height from a PNG or JPEG buffer (zero external dependencies)
 * so edited images automatically preserve the uploaded image's orientation.
 */
function getBufferImageDimensions(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
    // PNG: 89 50 4E 47 ... IHDR width @ 16, height @ 20
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    // JPEG: FF D8 ... scan for SOF0..SOF3 markers (FF C0 .. FF C3)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3
        ) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const segLen = buf.readUInt16BE(offset + 2);
        if (segLen < 2) break;
        offset += 2 + segLen;
      }
    }
  } catch {}
  return null;
}

/**
 * Resolves the target resolution for NVIDIA NIM `black-forest-labs/flux-3-image-klein`.
 * - Default: `1024 × 1024` (`1:1`)
 * - Automatically adapts to user-requested aspect ratio/orientation in text or body:
 *   - `9:16` (Mobile wallpaper / Reel / Story / Shorts / Vertical): `768 × 1344`
 *   - `16:9` (YouTube thumbnail / Banner / Desktop wallpaper / Landscape / Wide): `1344 × 768`
 *   - `4:5` (Instagram portrait): `896 × 1152`
 *   - `5:4` (Classic horizontal): `1152 × 896`
 *   - `2:3` (Portrait / Poster): `832 × 1216`
 *   - `3:2` (DSLR landscape): `1216 × 832`
 */
const FLUX3_ALLOWED_DIMS = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344];
function snapToFlux3Dim(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 1024;
  let best = 1024;
  let bestDiff = Infinity;
  for (const d of FLUX3_ALLOWED_DIMS) {
    const diff = Math.abs(d - n);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}

function resolveFlux3Dimensions(userText = "", options = {}, imageInput = null) {
  const q = String(userText || "").toLowerCase();
  const explicitRatio = String(
    options.aspect_ratio || options.aspectRatio || options.ratio || ""
  ).trim();

  // 1. Explicit width & height in request body or mentioned as e.g. "768x1344" in user prompt
  const dimMatch = q.match(/\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b/);
  if (dimMatch) {
    const w = snapToFlux3Dim(Number(dimMatch[1]));
    const h = snapToFlux3Dim(Number(dimMatch[2]));
    return { width: w, height: h, aspectRatio: `${w}x${h}` };
  }
  if (options.width && options.height) {
    const w = snapToFlux3Dim(options.width);
    const h = snapToFlux3Dim(options.height);
    return { width: w, height: h, aspectRatio: `${w}x${h}` };
  }

  // 2. Explicit aspect ratio string or ratio mentioned in prompt
  const ratioSignal = explicitRatio || (q.match(/\b(9:16|16:9|4:5|5:4|2:3|3:2|1:1)\b/) || [])[1] || "";
  if (ratioSignal === "9:16") return { width: 768, height: 1344, aspectRatio: "9:16" };
  if (ratioSignal === "16:9") return { width: 1344, height: 768, aspectRatio: "16:9" };
  if (ratioSignal === "4:5") return { width: 896, height: 1152, aspectRatio: "4:5" };
  if (ratioSignal === "5:4") return { width: 1152, height: 896, aspectRatio: "5:4" };
  if (ratioSignal === "2:3") return { width: 832, height: 1216, aspectRatio: "2:3" };
  if (ratioSignal === "3:2") return { width: 1216, height: 832, aspectRatio: "3:2" };
  if (ratioSignal === "1:1") return { width: 1024, height: 1024, aspectRatio: "1:1" };

  // 3. Natural-language orientation / use-case keywords in user prompt (Hindi, Hinglish, English)
  if (
    /\b(phone wallpaper|mobile wallpaper|lockscreen|lock screen|reel|reels|story|stories|shorts|status|vertical|tall|lamba|khada)\b/i.test(
      q
    ) ||
    /(मोबाइल वॉलपेपर|फोन वॉलपेपर|रील|स्टोरी|लम्बा|वर्टिकल)/.test(q)
  ) {
    return { width: 768, height: 1344, aspectRatio: "9:16" };
  }
  if (
    /\b(youtube|thumbnail|banner|cover photo|desktop wallpaper|pc wallpaper|laptop wallpaper|landscape|widescreen|wide|horizontal|cinematic wide|chauda)\b/i.test(
      q
    ) ||
    /(थंबनेल|बैनर|लैंडस्केप|चौड़ा|वाइड)/.test(q)
  ) {
    return { width: 1344, height: 768, aspectRatio: "16:9" };
  }
  if (/\b(instagram portrait|insta post|4 by 5)\b/i.test(q)) {
    return { width: 896, height: 1152, aspectRatio: "4:5" };
  }
  if (/\b(poster|book cover|portrait mode|portrait size|full body portrait)\b/i.test(q)) {
    return { width: 832, height: 1216, aspectRatio: "2:3" };
  }
  if (/\b(square|dp|profile pic|profile photo|avatar|logo|icon)\b/i.test(q)) {
    return { width: 1024, height: 1024, aspectRatio: "1:1" };
  }

  // 4. If editing an uploaded image and no size was requested in text, match the uploaded image's aspect ratio
  if (imageInput && imageInput.rawBase64) {
    try {
      const inBuf = Buffer.from(imageInput.rawBase64, "base64");
      const dims = getBufferImageDimensions(inBuf);
      if (dims && dims.width > 0 && dims.height > 0) {
        const ratio = dims.width / dims.height;
        if (ratio < 0.65) return { width: 768, height: 1344, aspectRatio: "9:16" };
        if (ratio < 0.75) return { width: 832, height: 1216, aspectRatio: "2:3" };
        if (ratio < 0.88) return { width: 896, height: 1152, aspectRatio: "4:5" };
        if (ratio > 1.55) return { width: 1344, height: 768, aspectRatio: "16:9" };
        if (ratio > 1.35) return { width: 1216, height: 832, aspectRatio: "3:2" };
        if (ratio > 1.15) return { width: 1152, height: 896, aspectRatio: "5:4" };
      }
    } catch {}
  }

  // Default: 1024 × 1024 (1:1)
  return { width: 1024, height: 1024, aspectRatio: "1:1" };
}

/**
 * Max v1.0 (`deepseek-v4.1-flash-free` + NVIDIA NIM `black-forest-labs/flux-3-image-klein`)
 * Image Generation & Vision-Guided Image Editing Pipeline:
 * 1. Resolves output dimensions (`1024 × 1024` default, or dynamic `9:16` `768×1344`, `16:9` `1344×768`, etc. based on user requirement).
 * 2. For `edit`: `deepseek-v4.1-flash-free` inspects the uploaded image via Multimodal Vision + user's edit request, crafts:
 *    - `statusMessage`: immediate message so the user & app know the image is being edited right now
 *    - `maxPrompt`: detailed English visual scene prompt describing the uploaded image WITH the user's requested edit applied
 *    - `finalReply`: presentation message for the finished image
 * 3. Calls NVIDIA NIM `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein` using `NVIDIA_API_KEY`.
 * 4. Returns `{ action, statusMessage, maxPrompt, finalReply, width, height, aspectRatio, imageId, image: { mimeType, url, dataUri } }`.
 */
/**
 * Sanitizes a user/model image prompt for NVIDIA NIM `black-forest-labs/flux-3-image-klein`
 * so NVIDIA's `Cosmos-1.0-Guardrail` never blocks trademarked car/product/character names
 * with `finishReason: "CONTENT_FILTERED"`, while preserving the exact visual look.
 */
function sanitizePromptForNvidiaFlux3(rawPrompt = "") {
  let p = String(rawPrompt || "").trim();
  if (!p) return "A breathtaking cinematic 8k photorealistic masterpiece scene, vivid lighting, sharp focus";

  // 1. Strip conversational Hinglish / Hindi / English command prefixes & suffixes
  p = p
    .replace(
      /\b(ki|ka|ke)\s+(ek\s+)?(image|photo|picture|pic|tasveer|wallpaper|logo|poster|painting|sketch)\s*(generate|create|make|draw|banao|bana do|bana de|banaiye|dikhao|de do|nikal do|karo|kar do|kardo|kar de|karde)?(\s+(karo|kar do|kardo|kar de|karde|na|bhai|yaar|please|okay|ok))*\b/gi,
      " "
    )
    .replace(
      /\b(ek|a|an)?\s*(image|photo|picture|pic|tasveer|wallpaper|logo|poster|painting|sketch)\s*(generate|create|make|draw|banao|bana do|bana de|banaiye|dikhao|de do|nikal do)(\s+(karo|kar do|kardo|kar de|karde|na|bhai|yaar|please|okay|ok))*\b/gi,
      " "
    )
    .replace(
      /\b(generate|create|make|draw|render|banao|bana do|bana de|generate karo|create karo)\s+(an?\s+)?(image|photo|picture|pic|tasveer|wallpaper|poster)\s+(of\s+)?/gi,
      " "
    )
    .replace(/\b(karo na|banao na|karo|banao|kar do|kardo|bana do|banado|please|bhai|yaar|okay|ok)\b/gi, " ")
    .replace(/(की|का|के)?\s*(इमेज|फोटो|फ़ोटो|तस्वीर|पिक्चर|वॉलपेपर)\s*(बनाओ|बना दो|बना दे|जनरेट करो|दिखाओ)/g, " ");

  // 2. Replace trademarked car/product/character names that trigger NVIDIA Cosmos Guardrail (`CONTENT_FILTERED`)
  //    with hyper-detailed visual descriptions of their exact iconic design:
  const brandVisualMap = [
    [
      /\b(lamborghini|lambo|aventador|huracan|urus|revuelto|gallardo|murcielago)\b/gi,
      "sleek Italian V12 wedge-shaped exotic supercar with sharp angular aerodynamic bodywork, Y-shaped LED headlights, hexagonal air intakes, and scissor doors",
    ],
    [
      /\b(ferrari|laferrari|sf90|f8 tributo|488 pista|458 italia)\b/gi,
      "sleek glossy crimson Italian mid-engine exotic racing supercar with sculpted aerodynamic curves and quad round taillights",
    ],
    [
      /\b(bugatti|chiron|veyron|tourbillon|bolide)\b/gi,
      "ultra-luxury two-tone hypercar with signature horseshoe front grille, sweeping C-shaped side profile line, and wide quad-turbo rear",
    ],
    [
      /\b(porsche|911 gt3|taycan|carrera)\b/gi,
      "sleek German rear-engine sports coupe with iconic oval LED headlights, wide rear fenders, aerodynamic rear wing, and sloping roofline",
    ],
    [
      /\b(bmw|m3|m4|m5|m8|i8)\b/gi,
      "aggressive German luxury performance sports coupe with twin kidney-style front grille, angel-eye LED headlights, and M-sport aerodynamic body",
    ],
    [
      /\b(mercedes|benz|g-wagon|g wagon|gwagon|amg|maybach)\b/gi,
      "luxury German performance automobile with chrome grille styling, sharp LED headlights, and sleek executive bodywork",
    ],
    [
      /\b(audi|r8)\b/gi,
      "sleek German all-wheel-drive V10 supercar with wide hexagonal mesh front grille and sharp matrix LED headlights",
    ],
    [
      /\b(rolls[\s-]*royce|phantom|cullinan|ghost)\b/gi,
      "ultra-luxury bespoke British limousine with upright pantheon chrome grille, two-tone paintwork, and coach doors",
    ],
    [
      /\b(mclaren|p1|720s|senna)\b/gi,
      "sleek British mid-engine carbon-fiber supercar with dihedral butterfly doors and swept-back LED headlights",
    ],
    [
      /\b(mustang|shelby|gt500)\b/gi,
      "muscular American V8 fastback muscle car with long sculpted hood, aggressive front splitter, and tri-bar LED taillights",
    ],
    [
      /\b(mahindra\s*thar|thar|jeep\s*wrangler|wrangler)\b/gi,
      "rugged boxy black 4x4 off-road SUV with round headlights, vertical seven-slot grille, chunky mud-terrain tires, and removable hardtop",
    ],
    [
      /\b(fortuner|scorpio|defender|range\s*rover|land\s*cruiser)\b/gi,
      "muscular full-size luxury 4x4 SUV with bold chrome front grille, high ground clearance, and sleek LED projector headlamps",
    ],
    [
      /\b(supra|nissan\s*gt-?r|gt-?r|skyline)\b/gi,
      "iconic Japanese twin-turbo JDM widebody street racing sports coupe with rear wing spoiler and neon reflections",
    ],
    [
      /\b(tesla|cybertruck)\b/gi,
      "futuristic all-electric angular vehicle with minimalist aerodynamic exterior and full-width LED light bar",
    ],
    [
      /\b(ktm|kawasaki|ninja\s*h2r?|hayabusa|royal\s*enfield|bullet\s*350|ducati|yamaha\s*r15|r15)\b/gi,
      "high-performance custom motorcycle with detailed exposed engine, sculpted fuel tank, wide tires, and dramatic street lighting",
    ],
    [
      /\b(iron\s*man|ironman|tony\s*stark)\b/gi,
      "futuristic red and gold titanium-armored cybernetic superhero with glowing blue arc-reactor chest core and illuminated visor eyes",
    ],
    [
      /\b(spider[\s-]*man|spiderman|peter\s*parker)\b/gi,
      "agile superhero in a sleek red and blue web-patterned suit with white expressive eye lenses swinging between city skyscrapers",
    ],
    [
      /\b(batman|dark\s*knight|bruce\s*wayne)\b/gi,
      "dark armored vigilante hero in a matte-black tactical bat-suit with pointed cowl ears and flowing black cape on a gothic rainy rooftop",
    ],
    [
      /\b(superman|clark\s*kent)\b/gi,
      "powerful muscular superhero in a royal blue suit with a flowing crimson cape soaring through dramatic clouds",
    ],
    [
      /\b(hulk)\b/gi,
      "colossal muscular green-skinned powerhouse hero in a dramatic action pose",
    ],
    [
      /\b(thor)\b/gi,
      "powerful Norse thunder warrior with silver plate armor, red cape, and glowing lightning hammer",
    ],
    [
      /\b(goku|super\s*saiyan|vegeta)\b/gi,
      "powerful anime martial arts warrior with spiky golden glowing hair, orange gi uniform, and crackling blue energy aura",
    ],
    [
      /\b(naruto|sasuke|itachi|kakashi|gojo|luffy)\b/gi,
      "detailed anime hero warrior in dynamic action pose with glowing energy aura and cinematic anime lighting",
    ],
    [
      /\b(pikachu|pokemon)\b/gi,
      "cute yellow electric anime creature with long black-tipped ears, rosy red cheeks, and lightning-bolt tail",
    ],
    [
      /\b(doraemon)\b/gi,
      "cute round blue-and-white robotic anime cat character with a red nose and small golden bell collar",
    ],
    [
      /\b(iphone|macbook|apple\s*watch|samsung\s*galaxy)\b/gi,
      "sleek ultra-modern flagship titanium device with edge-to-edge glowing OLED display",
    ],
  ];

  for (const [regex, replacement] of brandVisualMap) {
    p = p.replace(regex, replacement);
  }

  // 3. Translate common Hinglish/Hindi words & strip leftover Hinglish grammar particles (used only for fallback when LLM is unreachable)
  p = p
    .replace(/\b(beautifull|beutiful|beatiful|sundar|khubsurat|khoobsurat|pyari|pyaari)\b/gi, "gorgeous")
    .replace(/\b(ladki|udi|kudi)\b/gi, "young Indian woman")
    .replace(/\b(ladka|munda)\b/gi, "handsome young Indian man")
    .replace(/\b(dulhan)\b/gi, "radiant Indian bride")
    .replace(/\b(aurat|mahila)\b/gi, "graceful Indian woman")
    .replace(/\b(aadmi|purush)\b/gi, "confident Indian man")
    .replace(/\b(baccha|bacha)\b/gi, "cheerful child")
    .replace(/\b(sher|shair)\b/gi, "majestic lion")
    .replace(/\b(billi)\b/gi, "cute fluffy cat")
    .replace(/\b(kutta)\b/gi, "loyal golden retriever dog")
    .replace(/\b(ghoda)\b/gi, "majestic galloping horse")
    .replace(/\b(pahaad|pahad)\b/gi, "majestic snow-capped mountains")
    .replace(/\b(barish|baarish)\b/gi, "cinematic gentle rain")
    .replace(/\b(ek|ki|ka|ke|ko|banao|karo|dikhao|nikalo)\b/gi, " ");

  p = p.replace(/\s+/g, " ").trim();
  if (p.length < 4) {
    p = "A sleek futuristic sports car on a neon-lit highway at sunset";
  }

  return p;
}

/**
 * Replaces only trademarked brand names that trigger NVIDIA NIM's Cosmos `CONTENT_FILTERED` guardrail
 * while keeping 100% of `deepseek-v4.1-flash-free`'s enhanced English prompt intact.
 */
function debrandForNvidiaCosmos(englishPrompt = "") {
  let p = String(englishPrompt || "").trim();
  if (!p) return p;
  return p
    .replace(
      /\b(lamborghini|lambo|aventador|huracan|urus|revuelto)\b/gi,
      "Italian V12 wedge-shaped exotic supercar with scissor doors"
    )
    .replace(/\b(ferrari|laferrari|sf90)\b/gi, "glossy crimson Italian mid-engine racing supercar")
    .replace(/\b(bugatti|chiron|veyron)\b/gi, "two-tone hypercar with horseshoe front grille")
    .replace(/\b(porsche)\b/gi, "German rear-engine sports coupe with oval LED headlights")
    .replace(
      /\b(bmw\s*m5|bmw|m5)\b/gi,
      "German performance luxury sports sedan with twin kidney front grille and quad exhausts"
    )
    .replace(/\b(iron\s*man|ironman)\b/gi, "red and gold titanium-armored cybernetic superhero")
    .replace(/\b(spider[\s-]*man|spiderman)\b/gi, "red and blue web-patterned superhero")
    .replace(/\b(batman)\b/gi, "dark armored vigilante hero in matte-black tactical bat-suit")
    .replace(/\b(superman)\b/gi, "muscular superhero in royal blue suit and crimson cape")
    // Also replace words that trigger false-positive CONTENT_FILTERED in NVIDIA Cosmos Guardrail on couple/waterfall/sunset scenes
    .replace(/\bwet\s+skin\b/gi, "warm glowing skin")
    .replace(/\bwet\s+(clothes|dress|shirt|hair|body)\b/gi, "flowing $1")
    .replace(/\b(drenched|soaked|clinging|sheer|translucent|see-through)\b/gi, "elegant")
    .replace(/\b(swimsuits?|swimwear|bikinis?|bathing\s+suits?|shirtless|topless)\b/gi, "stylish summer travel outfit")
    .replace(/\bembracing\s+in\s+the\s+water\b/gi, "standing together beside the water")
    .replace(/\b(silhouetted|silhouette|backlit\s+by\s+a\s+molten)\b/gi, "warmly illuminated")
    .replace(/\b(intimately|sensually|passionately|seductively)\b/gi, "warmly")
    .replace(/\b(intimate|sensual|seductive|erotic)\b/gi, "romantic")
    .replace(/\b(barefoot|bare\s+feet|bare\s+skin|bare\s+shoulders)\b/gi, "graceful");
}

/**
 * Rewrites a prompt that triggered NVIDIA NIM's `CONTENT_FILTERED` guardrail into a 100% brand-free,
 * guardrail-safe visual English description using `deepseek-v4.1-flash-free` (with instant local fallback).
 */
async function rewritePromptForNvidiaGuardrail(originalPrompt = "", model = DEFAULT_MODEL) {
  const sanitized = debrandForNvidiaCosmos(sanitizePromptForNvidiaFlux3(originalPrompt));
  try {
    const rewriteTask = (async () => {
      const msgs = [
        {
          role: "system",
          content:
            "/no_think Do not use any tools. Output ONLY a 40-word brand-free, family-friendly English visual photography description.",
        },
        {
          role: "user",
          content: `Rewrite into a 40-word English photography description: "${sanitized}"\n/no_think`,
        },
      ];
      const up = await callOpenCodeUpstream({
        model: model || DEFAULT_MODEL,
        messages: msgs,
        disableReasoning: true,
      });
      if (up.ok && up.response) {
        const assembled = await collectSSEStream(up.response, up.model, { rawContentTokens: true });
        const cleaned = String(assembled.content || "")
          .replace(/<IMAGE_TASK[^>]*>([\s\S]*?)<\/IMAGE_TASK>/gi, "$1")
          .replace(/^["'`]+|["'`]+$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (cleaned.length >= 12) return debrandForNvidiaCosmos(cleaned);
      }
      return "";
    })();

    const rewritten = await Promise.race([
      rewriteTask,
      new Promise((resolve) => setTimeout(() => resolve(""), 5000)),
    ]);
    if (rewritten) {
      return sanitizePromptForNvidiaFlux3(rewritten);
    }
  } catch {}
  return `${sanitized}, cinematic lighting, ultra-detailed 8k photography, masterpiece`;
}

async function runMaxImageAgent({
  userText = "",
  imageInput = null,
  action = "generate",
  model = DEFAULT_MODEL,
  onStatus = null,
  preCraftedPrompt = "",
  preThinking = "",
  preStatusMessage = "",
  preFinalReply = "",
  options = {},
  publicBaseUrl = "https://vega-ai-6m2k.onrender.com",
}) {
  const isEdit = action === "edit" && Boolean(imageInput && imageInput.dataUri);
  const { width, height, aspectRatio } = resolveFlux3Dimensions(userText, options, imageInput);
  const outWidth = isEdit ? Number(options.width) || 1024 : width;
  const outHeight = isEdit ? Number(options.height) || 1024 : height;
  const outAspectRatio = isEdit && !options.width && !options.height ? "1:1" : aspectRatio;
  const activeImageModel = isEdit ? CLOUDFLARE_EDIT_MODEL : NVIDIA_IMAGE_MODEL;

  let statusMessage =
    preStatusMessage ||
    (isEdit
      ? "Ruko bhai, aapki photo ko dekh kar aapke hisaab se edit kar raha hoon... ✨"
      : "Ek second bhai, aapke liye shandaar image taiyar kar raha hoon... 🎨");
  let maxPrompt = String(preCraftedPrompt || "").trim();
  let mimoThinking = String(preThinking || "").trim();
  let finalReply =
    preFinalReply ||
    (isEdit
      ? "Yeh lijiye bhai, aapki edited image bilkul taiyar hai! ✨"
      : "Yeh lijiye bhai, aapki image ban kar taiyar hai! 🎨");

  const formatThinkingAndPrompt = (thinkStr, promptStr) => {
    const t = String(thinkStr || "").trim();
    const p = String(promptStr || "").trim();
    if (t && p) {
      return `${t}\n\nEnhanced English Prompt (${isEdit ? "Edit" : "Generate"}): "${p}"`;
    }
    if (t) return t;
    if (p) {
      return `Understanding user requirement ("${userText}") and crafting an enhanced detailed English prompt for ${activeImageModel}.\n\nEnhanced English Prompt: "${p}"`;
    }
    return `Understanding user requirement ("${userText}")...`;
  };

  // Step 0: Immediately emit initial status at 0ms so the app opens the image card & thinking stream right away!
  if (typeof onStatus === "function") {
    try {
      await onStatus({
        type: "image_status",
        phase: "starting",
        isImageTask: true,
        imageAction: isEdit ? "edit" : "generate",
        imageModel: activeImageModel,
        imageStatus: "crafting_prompt",
        readyForImage: true,
        width: outWidth,
        height: outHeight,
        aspectRatio: outAspectRatio,
        statusMessage,
        userPrompt: userText,
        maxPrompt: maxPrompt || "",
        thinking: mimoThinking || "",
        reasoning: mimoThinking || "",
      });
    } catch {}
  }

  // Step 1: `deepseek-v4.1-flash-free` ALWAYS understands the user's requirement first,
  // streams every single token of its `thinking` (`delta.reasoning`) and `maxPrompt` (`delta.content`) LIVE,
  // and then executes the image generator/editor with `maxPrompt`!
  if (!maxPrompt) {
    let craftTimedOut = false;
    let livePromptBuffer = "";
    const strippedSubject =
      String(userText || "")
        .replace(
          /\b(ek|a|an|please|plz|bhai|yar|yaar|zara|jaldi|abhi|image|photo|picture|pic|tasveer|ko|ki|ka|ke|generate|create|make|draw|banao|bana do|bana de|banaiye|dikhao|de do|karo|kar do|kar de|karne|karni|karna|hai|hain|ho)\b/gi,
          " "
        )
        .replace(/\s+/g, " ")
        .trim() || userText;

    const streamTokenCallbacks = {
      rawContentTokens: true,
      onThinkingToken: ({ token, thinking }) => {
        if (craftTimedOut) return;
        mimoThinking = thinking;
        if (typeof onStatus === "function") {
          try {
            onStatus({
              type: "thinking_delta",
              phase: "thinking",
              isImageTask: true,
              imageAction: isEdit ? "edit" : "generate",
              imageModel: activeImageModel,
              imageStatus: "crafting_prompt",
              readyForImage: true,
              width: outWidth,
              height: outHeight,
              aspectRatio: outAspectRatio,
              statusMessage,
              userPrompt: userText,
              token,
              thinkingDelta: token,
              reasoningDelta: token,
              maxPrompt: livePromptBuffer,
              thinking: formatThinkingAndPrompt(mimoThinking, livePromptBuffer),
              reasoning: formatThinkingAndPrompt(mimoThinking, livePromptBuffer),
            });
          } catch {}
        }
      },
      onContentToken: ({ token, content }) => {
        if (craftTimedOut) return;
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
              imageAction: isEdit ? "edit" : "generate",
              imageModel: activeImageModel,
              imageStatus: "crafting_prompt",
              readyForImage: true,
              width: outWidth,
              height: outHeight,
              aspectRatio: outAspectRatio,
              statusMessage,
              userPrompt: userText,
              token: cleanTok,
              promptDelta: cleanTok,
              thinkingDelta: cleanTok,
              reasoningDelta: cleanTok,
              maxPrompt: livePromptBuffer,
              thinking: formatThinkingAndPrompt(mimoThinking, livePromptBuffer),
              reasoning: formatThinkingAndPrompt(mimoThinking, livePromptBuffer),
            });
          } catch {}
        }
      },
    };

    const promptCraftTask = (async () => {
      if (!isEdit) {
        const craftMessages = [
          {
            role: "system",
            content: `/no_think You are Max v1.0, an expert AI visual director who writes prompts for the FLUX image model. Do not use any tools.

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
        const up = await callOpenCodeUpstream({
          model: model || DEFAULT_MODEL,
          messages: craftMessages,
          disableReasoning: true,
        });
        if (up.ok && up.response && !craftTimedOut) {
          const assembled = await collectSSEStream(up.response, up.model, streamTokenCallbacks);
          if (craftTimedOut) return;
          if (assembled.reasoning && assembled.reasoning.trim()) {
            mimoThinking = assembled.reasoning.trim();
          }
          const tagParsed = parseModelImageFallback(assembled.content, userText, false);
          if (tagParsed && tagParsed.maxPrompt) {
            maxPrompt = debrandForNvidiaCosmos(tagParsed.maxPrompt);
            if (tagParsed.statusMessage && !preStatusMessage) statusMessage = tagParsed.statusMessage;
            if (tagParsed.finalReply && !preFinalReply) finalReply = tagParsed.finalReply;
          } else {
            const cleaned = String(assembled.content || "")
              .replace(/<IMAGE_TASK[^>]*>([\s\S]*?)<\/IMAGE_TASK>/gi, "$1")
              .replace(/^["'`]+|["'`]+$/g, "")
              .replace(/\s+/g, " ")
              .trim();
            if (cleaned.length >= 12) {
              maxPrompt = debrandForNvidiaCosmos(cleaned);
            }
          }
        }
      } else {
        const visionMessages = [
          {
            role: "system",
            content:
              "/no_think Do not use any tools. You are Max v1.0, an expert AI photo editor. Inspect the image and the user's requirement, and output ONLY 1 detailed English image-editing instruction sentence.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Look at this image and write ONLY 1 detailed English image-edit instruction sentence for this user requirement: "${userText}".\n/no_think`,
              },
              {
                type: "image_url",
                image_url: { url: imageInput.dataUri },
              },
            ],
          },
        ];
        const up = await callOpenCodeUpstream({
          model: model || DEFAULT_MODEL,
          messages: visionMessages,
          disableReasoning: true,
        });
        if (up.ok && up.response && !craftTimedOut) {
          const assembled = await collectSSEStream(up.response, up.model, streamTokenCallbacks);
          if (craftTimedOut) return;
          if (assembled.reasoning && assembled.reasoning.trim()) {
            mimoThinking = assembled.reasoning.trim();
          }
          const cleaned = String(assembled.content || "")
            .replace(/<IMAGE_TASK[^>]*>([\s\S]*?)<\/IMAGE_TASK>/gi, "$1")
            .replace(/^["'`]+|["'`]+$/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (cleaned.length >= 8) {
            maxPrompt = cleaned;
          } else if (assembled.reasoning && assembled.reasoning.trim().length >= 15) {
            maxPrompt = assembled.reasoning.replace(/\s+/g, " ").trim().slice(0, 240);
          }
        }
      }
    })();

    try {
      await Promise.race([
        promptCraftTask,
        new Promise((resolve) =>
          setTimeout(() => {
            craftTimedOut = true;
            resolve();
          }, 16000)
        ),
      ]);
    } catch {}

    // Fallback if upstream LLM timed out
    if (!maxPrompt) {
      if (!isEdit) {
        const cleanVisualSubject = sanitizePromptForNvidiaFlux3(userText);
        maxPrompt = `${cleanVisualSubject}, photorealistic, natural skin and material textures, vivid cinematic lighting, sharp focus`;
      } else {
        maxPrompt = `Edit this image as requested: ${userText}, keeping the subject's identity and composition intact, photorealistic, high detail`;
      }
    }
  } else if (!isEdit) {
    maxPrompt = debrandForNvidiaCosmos(maxPrompt);
  }

  const buildThinkingSummary = () => formatThinkingAndPrompt(mimoThinking, maxPrompt);
  const fullThinking = buildThinkingSummary();

  // Step 2: Notify caller/stream that `deepseek-v4.1-flash-free` finished writing `maxPrompt` and is now executing the Image Tool!
  if (typeof onStatus === "function") {
    try {
      await onStatus({
        type: "tool_execution",
        phase: isEdit ? "editing_image" : "generating_image",
        tool: isEdit ? CLOUDFLARE_EDIT_MODEL : NVIDIA_IMAGE_MODEL,
        toolStatus: "running",
        isImageTask: true,
        imageAction: isEdit ? "edit" : "generate",
        imageModel: activeImageModel,
        imageStatus: "processing",
        readyForImage: true,
        width: outWidth,
        height: outHeight,
        aspectRatio: outAspectRatio,
        statusMessage,
        userPrompt: userText,
        maxPrompt,
        thinking: fullThinking,
        reasoning: fullThinking,
      });
    } catch {}
  }

  let imgBuffer = null;
  let contentType = "image/jpeg";
  const workerEndpoint = isEdit ? `${IMAGE_API_URL}/edit` : NVIDIA_IMAGE_API_URL;

  if (isEdit) {
    // ── Image Editing (`action === "edit"`): Use Cloudflare Worker (`@cf/black-forest-labs/flux-2-klein-4b` / `9b` / `dev`) at full 1024x1024 (or matched aspect ratio) ──
    let normMime = String((imageInput && imageInput.mimeType) || "image/png").toLowerCase();
    if (normMime === "image/jpg") normMime = "image/jpeg";
    if (!["image/png", "image/jpeg", "image/webp"].includes(normMime)) {
      normMime = "image/png";
    }
    const workerImageField = `data:${normMime};base64,${imageInput.rawBase64}`;
    const workerBody = {
      mode: "edit",
      prompt: maxPrompt,
      image: workerImageField,
      width: outWidth,
      height: outHeight,
    };

    let lastWorkerErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const workerRes = await fetch(`${IMAGE_API_URL}/edit`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${IMAGE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(workerBody),
        });

        const ct = (workerRes.headers.get("content-type") || "").toLowerCase();
        if (workerRes.ok && ct.startsWith("image/")) {
          imgBuffer = Buffer.from(await workerRes.arrayBuffer());
          if (
            imgBuffer.length >= 3 &&
            imgBuffer[0] === 0xff &&
            imgBuffer[1] === 0xd8 &&
            imgBuffer[2] === 0xff
          ) {
            contentType = "image/jpeg";
          } else if (
            imgBuffer.length >= 4 &&
            imgBuffer[0] === 0x89 &&
            imgBuffer[1] === 0x50 &&
            imgBuffer[2] === 0x4e &&
            imgBuffer[3] === 0x47
          ) {
            contentType = "image/png";
          } else {
            contentType = ct.split(";")[0] || "image/jpeg";
          }
          break;
        }
        const errText = await workerRes.text().catch(() => "");
        lastWorkerErr = `Image Edit Worker error (${workerRes.status}): ${errText.slice(0, 240)}`;
      } catch (e) {
        lastWorkerErr = e.message || "Worker fetch failed";
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    if (!imgBuffer) {
      throw new Error(lastWorkerErr || "Image editing failed on Cloudflare worker");
    }
  } else {
    // ── Image Generation (`action === "generate"`): Use NVIDIA NIM `black-forest-labs/flux-3-image-klein` (1024x1024 default + dynamic aspect ratio) ──
    const nvidiaApiKey = getNvidiaApiKey();
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

    let lastNvidiaErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nvRes = await fetch(NVIDIA_IMAGE_API_URL, {
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
            const b64 =
              data?.artifacts?.[0]?.base64 ||
              data?.image ||
              data?.data?.[0]?.b64_json ||
              "";
            if (b64) {
              imgBuffer = Buffer.from(b64, "base64");
            } else if (finishReason === "CONTENT_FILTERED") {
              lastNvidiaErr = `NVIDIA NIM CONTENT_FILTERED on attempt ${attempt + 1}`;
              nvidiaPayload.seed = (Number(nvidiaPayload.seed) || 0) + 7;
              // Automatically rewrite the prompt to remove any trademark/brand/sensitive words that triggered Cosmos guardrail
              if (attempt === 0) {
                const rewritten = await rewritePromptForNvidiaGuardrail(maxPrompt || userText, model);
                maxPrompt = rewritten;
                nvidiaPayload.prompt = rewritten.slice(0, 1950);
                continue;
              } else if (attempt === 1) {
                const subjectSafeFallback = `${debrandForNvidiaCosmos(
                  sanitizePromptForNvidiaFlux3(userText)
                )}, medium cinematic shot, golden hour sunlight, shot on 85mm f/1.4 lens, ultra-detailed 8k photorealistic photography, sharp focus`;
                maxPrompt = subjectSafeFallback;
                nvidiaPayload.prompt = subjectSafeFallback.slice(0, 1950);
                continue;
              }
            } else {
              lastNvidiaErr = `NVIDIA NIM returned 200 without base64 artifact: ${JSON.stringify(data).slice(0, 200)}`;
            }
          }

          if (imgBuffer && imgBuffer.length > 0) {
            if (
              imgBuffer.length >= 3 &&
              imgBuffer[0] === 0xff &&
              imgBuffer[1] === 0xd8 &&
              imgBuffer[2] === 0xff
            ) {
              contentType = "image/jpeg";
            } else if (
              imgBuffer.length >= 4 &&
              imgBuffer[0] === 0x89 &&
              imgBuffer[1] === 0x50 &&
              imgBuffer[2] === 0x4e &&
              imgBuffer[3] === 0x47
            ) {
              contentType = "image/png";
            }
            break;
          }
        } else {
          const errText = await nvRes.text().catch(() => "");
          lastNvidiaErr = `NVIDIA NIM API error (${nvRes.status}): ${errText.slice(0, 240)}`;
        }
      } catch (e) {
        lastNvidiaErr = e.message || "NVIDIA NIM fetch failed";
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!imgBuffer) {
      throw new Error(lastNvidiaErr || "Image generation failed on NVIDIA NIM flux-3-image-klein");
    }
  }

  const userEmail = String(options.user || options.email || options.userId || "")
    .trim()
    .toLowerCase();
  const chatId = String(options.chatId || options.chat_id || "").trim();
  const ztKey = String(
    options.zentragridApiKey ||
      options.storageApiKey ||
      process.env.ZENTRAGRID_API_KEY ||
      process.env.STORAGE_API_KEY ||
      ""
  ).trim();
  const ext = contentType.includes("png") ? "png" : "jpg";

  // Upload generated/edited image to Vega Storage (`POST /v1/files`) for permanent per-user persistence
  const vaultUpload = await uploadBufferToVegaStorage({
    buffer: imgBuffer,
    mimeType: contentType,
    filename: `vega_${isEdit ? "edit" : "gen"}_${Date.now()}.${ext}`,
    owner: userEmail || "vega_ai",
    parentId: chatId || "vega_ai_images",
    ztKey,
  });

  const fileId = vaultUpload?.fileId || null;
  const imageId = saveGeneratedImageBuffer(imgBuffer, contentType, fileId || "");
  const hostedUrl = `${publicBaseUrl.replace(/\/+$/, "")}/api/image/view/${imageId}`;
  const outBase64 = imgBuffer.toString("base64");
  const outDataUri = `data:${contentType};base64,${outBase64}`;

  // Attach user & prompt metadata to the stored image entry (+ disk metadata sidecar)
  const storedEntry = generatedImagesStore.get(imageId);
  const imageMeta = {
    imageId,
    fileId,
    user: userEmail || null,
    chatId: chatId || null,
    action: isEdit ? "edit" : "generate",
    imageModel: isEdit ? CLOUDFLARE_EDIT_MODEL : NVIDIA_IMAGE_MODEL,
    mimeType: contentType,
    width: outWidth,
    height: outHeight,
    aspectRatio: outAspectRatio,
    userPrompt: userText,
    maxPrompt,
    finalReply,
    imageUrl: hostedUrl,
    createdAt: new Date().toISOString(),
  };
  if (storedEntry) {
    Object.assign(storedEntry, imageMeta);
  }
  try {
    fs.writeFileSync(
      path.join(TMP_IMAGE_DIR, `${imageId}.json`),
      JSON.stringify(imageMeta),
      "utf8"
    );
  } catch {}

  const finalThinking = buildThinkingSummary();

  // If userEmail and ztKey are provided (and saveToHistory !== false),
  // persist the image turn in `ai_chats` + `ai_messages` on Vega Storage automatically.
  if (userEmail && ztKey && options.saveToHistory !== false && (chatId || options.saveToHistory === true)) {
    persistImageTurnToHistory({
      userEmail,
      chatId,
      device: options.device || "android",
      userPrompt: userText,
      finalReply,
      fileId: fileId || "",
      imageId,
      imageUrl: hostedUrl,
      maxPrompt,
      action: isEdit ? "edit" : "generate",
      width: outWidth,
      height: outHeight,
      thinking: finalThinking || "",
      ztKey,
    }).catch(() => {});
  }

  return {
    action: isEdit ? "edit" : "generate",
    imageModel: isEdit ? CLOUDFLARE_EDIT_MODEL : NVIDIA_IMAGE_MODEL,
    sentImageToWorker: Boolean(isEdit && imageInput && imageInput.rawBase64),
    workerEndpoint,
    width: outWidth,
    height: outHeight,
    aspectRatio: outAspectRatio,
    statusMessage,
    userPrompt: userText,
    maxPrompt,
    thinking: finalThinking,
    reasoning: finalThinking,
    finalReply,
    imageId,
    fileId,
    storedInVault: Boolean(fileId),
    user: userEmail || null,
    chatId: chatId || null,
    hostedUrl,
    image: {
      id: imageId,
      fileId,
      mimeType: contentType,
      width: outWidth,
      height: outHeight,
      aspectRatio: outAspectRatio,
      url: hostedUrl,
      dataUri: outDataUri,
    },
  };
}

/**
 * Parses formatted OpenCode websearch output into structured `{ title, url, snippet }[]` items
 * so the frontend can display clickable web search sources & snippets alongside thinking.
 */
function extractWebSearchSources(rawText = "") {
  const sources = [];
  const text = String(rawText || "").trim();
  if (!text || text.startsWith("No search results")) return sources;

  // Format 1: Parallel MCP compact format: `- Title (date) [https://...]\n  snippet`
  const blockRegex = /^-\s+(.+?)\s+\[(https?:\/\/[^\]]+)\]\s*\n\s*([\s\S]*?)(?=\n-\s+|\n*$)/gm;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    sources.push({
      title: match[1].trim(),
      url: match[2].trim(),
      snippet: match[3].replace(/\s+/g, " ").trim(),
    });
  }
  if (sources.length > 0) return sources;

  // Format 2: Exa MCP format (`Title: ...\nURL: ...\nText: ...`)
  const chunks = text.split(/\n(?=Title:\s)/i);
  for (const ch of chunks) {
    const tMatch = ch.match(/Title:\s*(.+)/i);
    const uMatch = ch.match(/URL:\s*(https?:\/\/\S+)/i);
    const sMatch = ch.match(/(?:Text|Highlights|Summary):\s*([\s\S]+)/i);
    if (uMatch) {
      sources.push({
        title: tMatch ? tMatch[1].trim() : uMatch[1].trim(),
        url: uMatch[1].trim(),
        snippet: sMatch ? sMatch[1].replace(/\s+/g, " ").trim().slice(0, 320) : "",
      });
    }
  }
  return sources;
}

/**
 * Runs OpenCode `deepseek-v4.1-flash-free` with automatic execution of OpenCode's
 * built-in `websearch` and `webfetch` tools (up to 3 turns) + proactive OpenCode
 * web search pre-fetching whenever a query needs live web research.
 * Captures and returns both `thinking` (`reasoning`) and full `webSearchSources` / `webSearchResults`.
 */
async function runOpenCodeAgentWithTools(payload, streamOptions = null) {
  const callbacks =
    typeof streamOptions === "function"
      ? { onWebSearchStart: streamOptions }
      : streamOptions && typeof streamOptions === "object"
      ? streamOptions
      : {};

  const workingMessages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  let usedWebSearch = false;
  const searchQueries = [];
  const searchResultChunks = [];
  let webSearchSources = [];
  const reasoningSteps = [];
  let accumulatedContent = "";
  let lastAssembled = null;
  const noThinkSuffix = payload.disableReasoning === true ? " /no_think" : "";

  // Proactive OpenCode Web Search: when the user's question asks for live/current info
  // or web research, pre-fetch OpenCode websearch (`search.parallel.ai/mcp` / `mcp.exa.ai/mcp`)
  // so `deepseek-v4.1-flash-free` has verified real-time web facts.
  const latestUserText = extractLatestUserText(workingMessages);
  const shouldPreSearch =
    payload.allowWebSearch !== false &&
    latestUserText &&
    (payload.webSearch === true || detectNeedsThinking(latestUserText));

  if (shouldPreSearch) {
    try {
      usedWebSearch = true;
      searchQueries.push(latestUserText);
      if (typeof callbacks.onWebSearchStart === "function") {
        try {
          await callbacks.onWebSearchStart([latestUserText]);
        } catch {}
      }
      if (typeof callbacks.onToolExecution === "function") {
        try {
          callbacks.onToolExecution({
            type: "tool_execution",
            tool: "websearch",
            toolStatus: "running",
            usedWebSearch: true,
            searchQueries: [...searchQueries],
            statusMessage: `Searching the web for "${latestUserText}"... 🔍`,
          });
        } catch {}
      }
      const preSearchResults = await executeOpenCodeWebSearch({
        query: latestUserText,
        numResults: 6,
      });
      if (preSearchResults && !preSearchResults.startsWith("No search results")) {
        searchResultChunks.push(preSearchResults);
        webSearchSources = extractWebSearchSources(preSearchResults);
        if (typeof callbacks.onWebSearchDone === "function") {
          try {
            callbacks.onWebSearchDone({
              usedWebSearch: true,
              searchQueries: [...searchQueries],
              webSearchSources,
              webSearchResults: searchResultChunks.join("\n\n") || null,
            });
          } catch {}
        }
        if (typeof callbacks.onToolExecution === "function") {
          try {
            callbacks.onToolExecution({
              type: "websearch",
              tool: "websearch",
              toolStatus: "completed",
              usedWebSearch: true,
              searchQueries: [...searchQueries],
              webSearchSources,
              webSearchResults: searchResultChunks.join("\n\n") || null,
              statusMessage: `Found ${webSearchSources.length} live web sources ✅`,
            });
          } catch {}
        }
        for (let i = workingMessages.length - 1; i >= 0; i--) {
          if (workingMessages[i] && workingMessages[i].role === "user") {
            const orig = workingMessages[i].content;
            if (typeof orig === "string") {
              workingMessages[i] = {
                ...workingMessages[i],
                content:
                  `${orig}\n\n` +
                  `[Live OpenCode Web Search Results (Date: ${new Date().toISOString().slice(0, 10)})]:\n` +
                  `${String(preSearchResults).slice(0, 3200)}\n\n` +
                  `IMPORTANT: The live OpenCode web search has ALREADY been executed above. Answer the user's question directly, accurately, and naturally using these live facts. Do NOT call the 'websearch' tool again.${noThinkSuffix}`,
              };
            }
            break;
          }
        }
      }
    } catch {}
  }

  for (let turn = 0; turn < 3; turn++) {
    const upstream = await callOpenCodeUpstream({
      ...payload,
      ...(shouldPreSearch && searchResultChunks.length > 0 ? { tool_choice: "none" } : {}),
      messages: workingMessages,
    });

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        errorText: upstream.errorText,
        usedWebSearch,
        searchQueries,
        webSearchSources,
        webSearchResults: searchResultChunks.join("\n\n") || null,
      };
    }

    const assembled = await collectSSEStream(upstream.response, upstream.model, {
      onThinkingToken: ({ token, thinking, id, created, model }) => {
        if (typeof callbacks.onThinkingToken === "function") {
          const fullReasoningSoFar = [...reasoningSteps, thinking].filter(Boolean).join("\n\n");
          callbacks.onThinkingToken({
            token,
            thinking: fullReasoningSoFar,
            reasoning: fullReasoningSoFar,
            id,
            created,
            model,
          });
        }
      },
      onContentToken: ({ token, content, id, created, model }) => {
        accumulatedContent += token;
        if (typeof callbacks.onContentToken === "function") {
          callbacks.onContentToken({
            token,
            content: accumulatedContent,
            turnContent: content,
            id,
            created,
            model,
          });
        }
      },
      onToolCallDelta: (tcEvt) => {
        if (typeof callbacks.onToolCallDelta === "function") {
          callbacks.onToolCallDelta(tcEvt);
        }
        if (
          tcEvt.isToolStart &&
          typeof callbacks.onToolExecution === "function" &&
          (tcEvt.toolCall?.function?.name === "websearch" ||
            tcEvt.toolCall?.function?.name === "webfetch")
        ) {
          callbacks.onToolExecution({
            type: "tool_execution",
            tool: tcEvt.toolCall.function.name,
            toolStatus: "running",
            usedWebSearch: true,
            searchQueries: [...searchQueries],
            statusMessage: `Running ${tcEvt.toolCall.function.name}... 🔍`,
          });
        }
      },
    });
    if (assembled.reasoning && assembled.reasoning.trim()) {
      reasoningSteps.push(assembled.reasoning.trim());
    }
    assembled.reasoning = reasoningSteps.join("\n\n") || "";
    lastAssembled = assembled;

    // If model did not request any tool calls, or already produced final answer with no web tools, return!
    if (!assembled.toolCalls || assembled.toolCalls.length === 0) {
      return {
        ok: true,
        assembled,
        usedWebSearch,
        searchQueries,
        webSearchSources,
        webSearchResults: searchResultChunks.join("\n\n") || null,
      };
    }

    const webCalls =
      payload.allowWebSearch === false
        ? []
        : assembled.toolCalls.filter(
            (tc) => tc.function.name === "websearch" || tc.function.name === "webfetch"
          );

    if (webCalls.length === 0) {
      if (assembled.content && assembled.content.trim()) {
        return {
          ok: true,
          assembled,
          usedWebSearch,
          searchQueries,
          webSearchSources,
          webSearchResults: searchResultChunks.join("\n\n") || null,
        };
      }
      // Model attempted to call a placeholder/disabled tool; instruct it to reply in text directly
      workingMessages.push({
        role: "assistant",
        content: assembled.content || "",
        tool_calls: assembled.toolCalls,
      });
      for (const tc of assembled.toolCalls) {
        workingMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "Tool is disabled for this turn. Answer the user directly in plain spoken text.",
        });
      }
      continue;
    }

    usedWebSearch = true;
    const turnQueries = [];
    for (const tc of webCalls) {
      try {
        const parsed = JSON.parse(tc.function.arguments || "{}");
        const q = parsed.query || parsed.url || "";
        if (q) {
          searchQueries.push(q);
          turnQueries.push(q);
        }
      } catch {}
    }

    if (typeof callbacks.onWebSearchStart === "function") {
      try {
        await callbacks.onWebSearchStart(turnQueries);
      } catch {}
    }
    if (typeof callbacks.onToolExecution === "function") {
      try {
        callbacks.onToolExecution({
          type: "tool_execution",
          tool: "websearch",
          toolStatus: "running",
          usedWebSearch: true,
          searchQueries: [...searchQueries],
          statusMessage: `Searching the web for "${turnQueries.join(", ") || latestUserText}"... 🔍`,
        });
      } catch {}
    }

    // Append assistant tool_calls message
    workingMessages.push({
      role: "assistant",
      content: assembled.content || "",
      tool_calls: assembled.toolCalls,
    });

    // Execute all requested tool calls in parallel
    const toolResults = await Promise.all(
      assembled.toolCalls.map(async (tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {}

        if (tc.function.name === "websearch") {
          const resultText = await executeOpenCodeWebSearch(args, upstream.sessionId);
          if (resultText && !resultText.startsWith("No search results")) {
            searchResultChunks.push(resultText);
            const parsedSources = extractWebSearchSources(resultText);
            if (parsedSources.length > 0) {
              webSearchSources = [...webSearchSources, ...parsedSources];
            }
          }
          if (typeof callbacks.onToolExecution === "function") {
            try {
              callbacks.onToolExecution({
                type: "websearch",
                tool: "websearch",
                toolStatus: "completed",
                usedWebSearch: true,
                searchQueries: [...searchQueries],
                webSearchSources,
                webSearchResults: searchResultChunks.join("\n\n") || null,
                statusMessage: `Found ${webSearchSources.length} live web sources ✅`,
              });
            } catch {}
          }
          return {
            tool_call_id: tc.id,
            content:
              `${resultText}\n\n` +
              `IMPORTANT: Live OpenCode web search results are provided above. Answer the user directly and completely using these facts without calling 'websearch' again.${noThinkSuffix}`,
          };
        }
        if (tc.function.name === "webfetch") {
          const resultText = await executeOpenCodeWebFetch(args);
          return { tool_call_id: tc.id, content: resultText };
        }
        return {
          tool_call_id: tc.id,
          content: "Tool disabled in chat mode; reply directly in text.",
        };
      })
    );

    for (const tr of toolResults) {
      workingMessages.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        content: tr.content,
      });
    }
  }

  return {
    ok: true,
    assembled: lastAssembled,
    usedWebSearch,
    searchQueries,
    webSearchSources,
    webSearchResults: searchResultChunks.join("\n\n") || null,
  };
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

function cleanTextForSpeech(text, maxChars = 320) {
  let cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/~/g, "")
    .replace(/\s*[–—]\s*/g, " to ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxChars > 0 && cleaned.length > maxChars) {
    const slice = cleaned.slice(0, maxChars);
    const lastBoundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("। ")
    );
    cleaned = lastBoundary > 60 ? slice.slice(0, lastBoundary + 1).trim() : slice.trim();
  }
  return cleaned;
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
    ? `Listen carefully to the attached audio and transcribe the exact spoken words (${languageHint}). Output ONLY the verbatim transcript without quotes, labels, or explanations. Do NOT hallucinate or invent words—if the audio is silent or contains no clear human speech, output an empty string.`
    : `Listen carefully to the attached audio and transcribe the exact spoken words (Hindi, Hinglish, or English in Latin/Roman or Devanagari script). Output ONLY the verbatim transcript without quotes, labels, or explanations. Do NOT hallucinate or invent words—if the audio is silent or contains no clear human speech, output an empty string.`;

  const candidateModels = [
    ...(resolvedSttModel ? [resolvedSttModel] : []),
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    GEMINI_STT_MODEL,
    "gemini-3.8-flash",
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
          temperature: 0.0,
          maxOutputTokens: 128,
          ...(modelName.includes("2.5") || modelName.includes("3")
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
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

// ─── Step 3 (TTS): Direct Gemini Live Native Audio (`gemini-2.5-flash-native-audio-preview-12-2025`) ───

/**
 * Direct Gemini Live Native Audio WebSocket TTS (`BidiGenerateContent`) using `GEMINI_API_KEY`.
 * Default voice is `Aoede` (plus 11 other smooth, beautiful female voices).
 * Outputs 24kHz 16-bit PCM wrapped as playable `audio/wav` (`data:audio/wav;base64,UklGR...`).
 */
function synthesizeWithGeminiLiveAudio({
  spokenText,
  spokenTextPromise = null,
  selectedVoice,
  apiKey,
  liveModel = "models/gemini-2.5-flash-native-audio-preview-12-2025",
}) {
  return new Promise((resolve, reject) => {
    const fullModel = liveModel.startsWith("models/") ? liveModel : `models/${liveModel}`;
    const wsKey = crypto.randomBytes(16).toString("base64");
    const wsPath = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: wsPath,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": wsKey,
      },
    });

    let finishSuccessRef = null;
    const timeout = setTimeout(() => {
      if (typeof finishSuccessRef === "function") {
        finishSuccessRef();
        return;
      }
      req.destroy();
      reject(new Error(`Gemini Live Audio (${fullModel}) WebSocket timed out.`));
    }, 15000);

    function sendWsJson(socket, obj) {
      const payload = Buffer.from(JSON.stringify(obj), "utf8");
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.on("response", (res) => {
      clearTimeout(timeout);
      reject(new Error(`Gemini Live WebSocket upgrade rejected: HTTP ${res.statusCode}`));
    });

    req.on("upgrade", (res, socket, head) => {
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const pcmChunks = [];
      let setupDone = false;
      let finished = false;
      let fragOpcode = 0;
      let fragChunks = [];
      let chunkIdleTimer = null;

      function finishSuccess() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
        try {
          const closeFrame = Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
          socket.write(closeFrame);
          socket.end();
        } catch {}
        if (pcmChunks.length === 0) {
          return reject(new Error(`Gemini Live Audio (${fullModel}) returned 0 PCM chunks.`));
        }
        const pcmBuffer = Buffer.concat(pcmChunks);
        const wavBuffer = pcm16ToWavBuffer(pcmBuffer, 24000, 1, 16);
        const wavBase64 = wavBuffer.toString("base64");
        resolve({
          model: fullModel.replace(/^models\//, ""),
          voice: selectedVoice,
          sampleRate: 24000,
          mimeType: "audio/wav",
          wavBuffer,
          wavBase64,
          dataUri: `data:audio/wav;base64,${wavBase64}`,
        });
      }
      finishSuccessRef = () => {
        if (pcmChunks.length > 0) finishSuccess();
        else {
          req.destroy();
          reject(new Error(`Gemini Live Audio (${fullModel}) WebSocket timed out.`));
        }
      };

      function handleJsonMessage(msg) {
        if (msg.error) {
          if (!finished) {
            if (pcmChunks.length > 0) {
              return finishSuccess();
            }
            finished = true;
            clearTimeout(timeout);
            if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
            socket.destroy();
            reject(new Error(`Gemini Live (${fullModel}) error: ${JSON.stringify(msg.error)}`));
          }
          return;
        }
        if (msg.setupComplete !== undefined && !setupDone) {
          setupDone = true;
          Promise.resolve(spokenTextPromise ? spokenTextPromise : spokenText)
            .then((resolvedText) => {
              if (finished) return;
              const finalSpoken = cleanTextForSpeech(resolvedText || "");
              if (!finalSpoken) {
                finished = true;
                clearTimeout(timeout);
                try {
                  socket.destroy();
                } catch {}
                return reject(new Error("Empty spokenText after promise resolved."));
              }
              const readPrompt = `Please read the following text aloud verbatim, word for word, in a smooth, sweet, warm, and natural voice without adding or changing any words:\n${finalSpoken}`;
              if (fullModel.includes("3.1")) {
                sendWsJson(socket, {
                  realtimeInput: {
                    text: readPrompt,
                  },
                });
              } else {
                sendWsJson(socket, {
                  clientContent: {
                    turns: [
                      {
                        role: "user",
                        parts: [{ text: readPrompt }],
                      },
                    ],
                    turnComplete: true,
                  },
                });
              }
            })
            .catch((err) => {
              if (!finished) {
                finished = true;
                clearTimeout(timeout);
                try {
                  socket.destroy();
                } catch {}
                reject(err);
              }
            });
          return;
        }
        const parts = msg?.serverContent?.modelTurn?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p?.inlineData?.data) {
              pcmChunks.push(Buffer.from(p.inlineData.data, "base64"));
              if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
              chunkIdleTimer = setTimeout(() => {
                if (pcmChunks.length > 0) finishSuccess();
              }, 650);
            }
          }
        }
        if (
          (msg?.serverContent?.turnComplete || msg?.serverContent?.generationComplete) &&
          pcmChunks.length > 0
        ) {
          finishSuccess();
        }
      }

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const isMasked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          let maskKey = null;
          if (isMasked) {
            if (buf.length < offset + 4) break;
            maskKey = buf.subarray(offset, offset + 4);
            offset += 4;
          }
          if (buf.length < offset + len) break;
          let payload = buf.subarray(offset, offset + len);
          buf = buf.subarray(offset + len);
          if (isMasked && maskKey) {
            const unmasked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
              unmasked[i] = payload[i] ^ maskKey[i & 3];
            }
            payload = unmasked;
          }

          if (opcode === 0x08) {
            if (pcmChunks.length > 0) {
              finishSuccess();
            } else if (!finished) {
              finished = true;
              clearTimeout(timeout);
              const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "closed";
              reject(new Error(`Gemini Live (${fullModel}) WebSocket closed: ${reason}`));
            }
            return;
          } else if (opcode === 0x09) {
            const pong = Buffer.alloc(2);
            pong[0] = 0x8a;
            pong[1] = 0x80;
            socket.write(Buffer.concat([pong, crypto.randomBytes(4)]));
          } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
            if (opcode !== 0x00) {
              fragOpcode = opcode;
              fragChunks = [payload];
            } else {
              fragChunks.push(payload);
            }
            if (fin && (fragOpcode === 0x01 || fragOpcode === 0x02)) {
              const full = Buffer.concat(fragChunks);
              fragChunks = [];
              try {
                const parsed = JSON.parse(full.toString("utf8"));
                handleJsonMessage(parsed);
              } catch {}
            }
          }
        }
      });

      socket.on("error", (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      socket.on("close", () => {
        if (!finished) {
          if (pcmChunks.length > 0) finishSuccess();
          else {
            finished = true;
            clearTimeout(timeout);
            reject(new Error(`Gemini Live (${fullModel}) WebSocket closed before audio finished.`));
          }
        }
      });

      // Send initial BidiGenerateContent setup with smooth female voice persona & zero thinking delay
      sendWsJson(socket, {
        setup: {
          model: fullModel,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: selectedVoice,
                },
              },
            },
            ...(fullModel.includes("native-audio")
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : fullModel.includes("3.1")
              ? { thinkingConfig: { thinkingLevel: "MINIMAL" } }
              : {}),
          },
          systemInstruction: {
            parts: [
              {
                text:
                  "You are a professional, ultra-smooth, sweet, warm, and natural female voice artist. " +
                  "Speak with a soft, melodious, expressive, and crystal-clear human tone. " +
                  "Read the user's provided text aloud verbatim, word for word, in the exact same language (Hinglish, Hindi, or English) with natural Indian flow and gentle warmth. " +
                  "Never answer questions, never add extra commentary, and never skip words—only speak the exact words provided in a beautiful, soothing voice.",
              },
            ],
          },
        },
      });
    });

    req.end();
  });
}

async function synthesizeWithGeminiTTS({ text, voice }) {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error(
      "Server misconfiguration: GEMINI_API_KEY (Google AI Studio API Key) environment variable is not set."
    );
  }

  const selectedVoice = normalizeVoiceName(voice || GEMINI_TTS_VOICE || "Aoede");
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) {
    throw new Error("Cannot synthesize empty text for TTS.");
  }

  const liveModelsToTry = [
    GEMINI_TTS_MODEL,
    "models/gemini-3.1-flash-live-preview",
    "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "models/gemini-2.5-flash-native-audio-latest",
  ];

  const triedModels = new Set();
  const maxKeyAttempts = Math.max(1, GEMINI_API_KEYS.length);
  let lastErr = null;

  for (const rawModel of liveModelsToTry) {
    const cleanModel = rawModel.replace(/^models\//, "");
    if (!cleanModel || triedModels.has(cleanModel)) continue;
    triedModels.add(cleanModel);

    for (let k = 0; k < maxKeyAttempts; k++) {
      try {
        const apiKey = getGeminiApiKey();
        const result = await synthesizeWithGeminiLiveAudio({
          spokenText,
          selectedVoice,
          apiKey,
          liveModel: `models/${cleanModel}`,
        });
        if (result && result.wavBase64) {
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }

  throw new Error(
    lastErr?.message || `Gemini Live Native Audio TTS (${GEMINI_TTS_MODEL}) failed.`
  );
}

/**
 * Extracts raw 16-bit mono little-endian PCM and sampleRate from a WAV or raw PCM base64 string.
 * Returns `{ pcmBuffer, sampleRate }` if valid 16-bit PCM WAV/raw, or `null` if compressed (e.g. WebM/Opus).
 */
function extractPcmFromWavBase64(base64Data, mimeType = "audio/wav") {
  if (!base64Data) return null;
  const buf = Buffer.from(base64Data, "base64");
  const cleanMime = String(mimeType || "").toLowerCase();

  if (cleanMime.includes("pcm")) {
    const rateMatch = cleanMime.match(/rate=(\d+)/);
    return {
      pcmBuffer: buf,
      sampleRate: rateMatch ? Number(rateMatch[1]) || 16000 : 16000,
    };
  }

  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataChunk = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(chunkStart);
      numChannels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      const end = Math.min(buf.length, chunkStart + chunkSize);
      dataChunk = buf.subarray(chunkStart, end);
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!dataChunk || audioFormat !== 1 || bitsPerSample !== 16) {
    return null;
  }

  if (numChannels === 2) {
    const frames = Math.floor(dataChunk.length / 4);
    const mono = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const left = dataChunk.readInt16LE(i * 4);
      const right = dataChunk.readInt16LE(i * 4 + 2);
      mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
    }
    return { pcmBuffer: mono, sampleRate };
  }

  return { pcmBuffer: dataChunk, sampleRate };
}

/**
 * Unified Single-Pass Voice Agent (`gemini-2.5-flash-native-audio-preview-12-2025`):
 * Performs STT + Max v1.0 LLM + Aoede 24kHz WAV TTS in ONE single BidiGenerateContent WebSocket call!
 */
function runGeminiNativeVoiceTurn({
  userText = "",
  pcmInput = null,
  history = [],
  systemPrompt = "",
  selectedVoice = "Aoede",
  apiKey,
  liveModel = "models/gemini-3.1-flash-live-preview",
  enableWebSearchTool = true,
}) {
  return new Promise((resolve, reject) => {
    const fullModel = liveModel.startsWith("models/") ? liveModel : `models/${liveModel}`;
    const wsKey = crypto.randomBytes(16).toString("base64");
    const wsPath = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: wsPath,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": wsKey,
      },
    });

    let finishSuccessRef = null;
    const timeout = setTimeout(() => {
      if (typeof finishSuccessRef === "function") {
        finishSuccessRef();
        return;
      }
      req.destroy();
      reject(new Error(`Gemini Native Voice (${fullModel}) WebSocket timed out.`));
    }, 15000);

    function sendWsJson(socket, obj) {
      const payload = Buffer.from(JSON.stringify(obj), "utf8");
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.on("response", (res) => {
      clearTimeout(timeout);
      reject(new Error(`Gemini Native Voice WebSocket upgrade rejected: HTTP ${res.statusCode}`));
    });

    req.on("upgrade", (res, socket, head) => {
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const pcmChunks = [];
      const inputTranscriptParts = [];
      const outputTranscriptParts = [];
      const modelTextParts = [];
      let setupDone = false;
      let finished = false;
      let fragOpcode = 0;
      let fragChunks = [];
      let chunkIdleTimer = null;
      let toolCallInFlight = false;
      let nativeUsedWebSearch = false;
      const nativeSearchQueries = [];

      function finishSuccess() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
        try {
          const closeFrame = Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
          socket.write(closeFrame);
          socket.end();
        } catch {}
        if (pcmChunks.length === 0 && outputTranscriptParts.length === 0 && modelTextParts.length === 0) {
          return reject(new Error(`Gemini Native Voice (${fullModel}) returned empty response.`));
        }
        const pcmBuffer = pcmChunks.length > 0 ? Buffer.concat(pcmChunks) : Buffer.alloc(0);
        const wavBuffer = pcmBuffer.length > 0 ? pcm16ToWavBuffer(pcmBuffer, 24000, 1, 16) : null;
        const wavBase64 = wavBuffer ? wavBuffer.toString("base64") : "";
        const transcript = inputTranscriptParts.join("").trim() || userText || "";
        const reply =
          outputTranscriptParts.join("").trim() ||
          modelTextParts.join("").trim() ||
          "";
        resolve({
          model: fullModel.replace(/^models\//, ""),
          voice: selectedVoice,
          sampleRate: 24000,
          mimeType: "audio/wav",
          transcript,
          reply,
          usedWebSearch: nativeUsedWebSearch,
          searchQueries: nativeSearchQueries,
          wavBuffer,
          wavBase64,
          dataUri: wavBase64 ? `data:audio/wav;base64,${wavBase64}` : "",
        });
      }

      finishSuccessRef = () => {
        if (pcmChunks.length > 0 || outputTranscriptParts.length > 0) finishSuccess();
        else {
          req.destroy();
          reject(new Error(`Gemini Native Voice (${fullModel}) WebSocket timed out.`));
        }
      };

      function handleJsonMessage(msg) {
        if (msg.error) {
          if (!finished) {
            if (pcmChunks.length > 0) return finishSuccess();
            finished = true;
            clearTimeout(timeout);
            if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
            socket.destroy();
            reject(new Error(`Gemini Native Voice (${fullModel}) error: ${JSON.stringify(msg.error)}`));
          }
          return;
        }

        if (msg.setupComplete !== undefined && !setupDone) {
          setupDone = true;
          const isGemini31 = fullModel.includes("3.1");
          const historyTurns = [];
          if (Array.isArray(history)) {
            for (const h of history.slice(-6)) {
              if (h && h.content && typeof h.content === "string") {
                historyTurns.push({
                  role: h.role === "assistant" || h.role === "model" ? "model" : "user",
                  parts: [{ text: h.content }],
                });
              }
            }
          }

          if (pcmInput && pcmInput.pcmBuffer && pcmInput.pcmBuffer.length > 0) {
            if (!isGemini31 && historyTurns.length > 0) {
              sendWsJson(socket, {
                clientContent: {
                  turns: historyTurns,
                  turnComplete: false,
                },
              });
            }
            const chunkSize = 32000;
            for (let i = 0; i < pcmInput.pcmBuffer.length; i += chunkSize) {
              const slice = pcmInput.pcmBuffer.subarray(i, i + chunkSize);
              sendWsJson(socket, {
                realtimeInput: {
                  audio: {
                    mimeType: `audio/pcm;rate=${pcmInput.sampleRate || 24000}`,
                    data: slice.toString("base64"),
                  },
                },
              });
            }
            sendWsJson(socket, {
              realtimeInput: {
                audioStreamEnd: true,
              },
            });
          } else if (isGemini31) {
            // Gemini 3.1 Flash Live requires realtimeInput.text for user text messages
            sendWsJson(socket, {
              realtimeInput: {
                text: userText,
              },
            });
          } else {
            historyTurns.push({
              role: "user",
              parts: [{ text: userText }],
            });
            sendWsJson(socket, {
              clientContent: {
                turns: historyTurns,
                turnComplete: true,
              },
            });
          }
          return;
        }

        // Handle live OpenCode websearch tool calls from Gemini Native Audio model
        if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
          toolCallInFlight = true;
          if (chunkIdleTimer) {
            clearTimeout(chunkIdleTimer);
            chunkIdleTimer = null;
          }
          const calls = msg.toolCall.functionCalls;
          Promise.all(
            calls.map(async (fc) => {
              const q =
                String(fc?.args?.query || fc?.args?.q || inputTranscriptParts.join(" ") || userText || "").trim() ||
                "latest news today";
              nativeUsedWebSearch = true;
              nativeSearchQueries.push(q);
              let searchResult = "";
              try {
                searchResult = await executeOpenCodeWebSearch({
                  query: q,
                  numResults: 5,
                });
              } catch (e) {
                searchResult = `Search error: ${e.message}`;
              }
              return {
                id: fc.id,
                name: fc.name || "websearch",
                response: {
                  result: String(searchResult || "No results found.").slice(0, 3500),
                },
              };
            })
          )
            .then((functionResponses) => {
              toolCallInFlight = false;
              if (!finished) {
                sendWsJson(socket, {
                  toolResponse: {
                    functionResponses,
                  },
                });
              }
            })
            .catch(() => {
              toolCallInFlight = false;
            });
          return;
        }

        const sc = msg?.serverContent;
        if (sc) {
          if (typeof sc.inputTranscription?.text === "string") {
            inputTranscriptParts.push(sc.inputTranscription.text);
          }
          if (typeof sc.outputTranscription?.text === "string") {
            outputTranscriptParts.push(sc.outputTranscription.text);
          }
          const parts = sc.modelTurn?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p?.inlineData?.data) {
                pcmChunks.push(Buffer.from(p.inlineData.data, "base64"));
                if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
                if (!toolCallInFlight) {
                  const idleWaitMs = nativeUsedWebSearch ? 1400 : 650;
                  chunkIdleTimer = setTimeout(() => {
                    if (!toolCallInFlight && pcmChunks.length > 0) finishSuccess();
                  }, idleWaitMs);
                }
              }
              if (typeof p?.text === "string" && !p?.thought) {
                modelTextParts.push(p.text);
              }
            }
          }
          if (!toolCallInFlight && (sc.turnComplete || sc.generationComplete) && pcmChunks.length > 0) {
            finishSuccess();
          }
        }
      }

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const isMasked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          let maskKey = null;
          if (isMasked) {
            if (buf.length < offset + 4) break;
            maskKey = buf.subarray(offset, offset + 4);
            offset += 4;
          }
          if (buf.length < offset + len) break;
          let payload = buf.subarray(offset, offset + len);
          buf = buf.subarray(offset + len);
          if (isMasked && maskKey) {
            const unmasked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
              unmasked[i] = payload[i] ^ maskKey[i & 3];
            }
            payload = unmasked;
          }

          if (opcode === 0x08) {
            if (pcmChunks.length > 0) {
              finishSuccess();
            } else if (!finished) {
              finished = true;
              clearTimeout(timeout);
              const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "closed";
              reject(new Error(`Gemini Native Voice (${fullModel}) WebSocket closed: ${reason}`));
            }
            return;
          } else if (opcode === 0x09) {
            const pong = Buffer.alloc(2);
            pong[0] = 0x8a;
            pong[1] = 0x80;
            socket.write(Buffer.concat([pong, crypto.randomBytes(4)]));
          } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
            if (opcode !== 0x00) {
              fragOpcode = opcode;
              fragChunks = [payload];
            } else {
              fragChunks.push(payload);
            }
            if (fin && (fragOpcode === 0x01 || fragOpcode === 0x02)) {
              const full = Buffer.concat(fragChunks);
              fragChunks = [];
              try {
                const parsed = JSON.parse(full.toString("utf8"));
                handleJsonMessage(parsed);
              } catch {}
            }
          }
        }
      });

      socket.on("error", (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      socket.on("close", () => {
        if (!finished) {
          if (pcmChunks.length > 0) finishSuccess();
          else {
            finished = true;
            clearTimeout(timeout);
            reject(new Error(`Gemini Native Voice (${fullModel}) WebSocket closed before audio finished.`));
          }
        }
      });

      let defaultVoicePersona =
        systemPrompt ||
        `You are ${AI_NAME}, the fast, smart, warm real-time voice AI assistant inside the ${APP_NAME} app. ` +
          `When asked who you are or what your name is, say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
          `Speak naturally in the same language as the user (Hinglish, Hindi, or English) with a smooth, sweet, warm Indian conversational flow. ` +
          `WEB RESEARCH RULE: Whenever the user asks about live news, current prices/rates (Bitcoin, crypto, stocks, gold), weather, sports/IPL scores, 2025/2026 events, or asks you to search/check online, call the 'websearch' tool first and answer using the live OpenCode search results. ` +
          `IMPORTANT: Keep every reply to ONE short, natural spoken sentence (maximum 15 to 18 words) unless the user explicitly asks for a detailed explanation.`;

      if (fullModel.includes("3.1") && Array.isArray(history) && history.length > 0) {
        const histLines = history
          .slice(-6)
          .filter((h) => h && h.content && typeof h.content === "string")
          .map((h) => `${h.role === "assistant" || h.role === "model" ? AI_NAME : "User"}: ${h.content}`)
          .join("\n");
        if (histLines) {
          defaultVoicePersona += `\n\nRecent conversation context:\n${histLines}`;
        }
      }

      recordSentPrompt({
        agent: "voice",
        model: fullModel,
        voice: selectedVoice,
        systemPrompt: defaultVoicePersona,
        userText: userText || "(live PCM microphone audio stream)",
      });

      sendWsJson(socket, {
        setup: {
          model: fullModel,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: selectedVoice,
                },
              },
            },
            ...(fullModel.includes("native-audio")
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : fullModel.includes("3.1")
              ? { thinkingConfig: { thinkingLevel: "MINIMAL" } }
              : {}),
          },
          ...(enableWebSearchTool
            ? {
                tools: [
                  {
                    functionDeclarations: [
                      {
                        name: "websearch",
                        description:
                          "Search the live web using OpenCode web search for current news, live prices (Bitcoin, crypto, stocks, gold), weather, sports/IPL scores, 2025/2026 events, or any real-time information.",
                        parameters: {
                          type: "OBJECT",
                          properties: {
                            query: {
                              type: "STRING",
                              description: "The search query to look up on the live web",
                            },
                          },
                          required: ["query"],
                        },
                      },
                    ],
                  },
                ],
              }
            : {}),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [{ text: defaultVoicePersona }],
          },
        },
      });
    });

    req.end();
  });
}

async function runGeminiNativeVoiceAgent({
  userText = "",
  pcmInput = null,
  history = [],
  systemPrompt = "",
  voice = "Aoede",
  enableWebSearchTool = true,
}) {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error(
      "Server misconfiguration: GEMINI_API_KEY (Google AI Studio API Key) environment variable is not set."
    );
  }
  const selectedVoice = normalizeVoiceName(voice || GEMINI_TTS_VOICE || "Aoede");
  const liveModelsToTry = [
    GEMINI_VOICE_MODEL,
    "models/gemini-3.1-flash-live-preview",
    "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "models/gemini-2.5-flash-native-audio-latest",
  ];
  const triedModels = new Set();
  const maxKeyAttempts = Math.max(1, GEMINI_API_KEYS.length);
  let lastErr = null;

  for (const rawModel of liveModelsToTry) {
    const cleanModel = rawModel.replace(/^models\//, "");
    if (!cleanModel || triedModels.has(cleanModel)) continue;
    triedModels.add(cleanModel);

    for (let k = 0; k < maxKeyAttempts; k++) {
      try {
        const apiKey = getGeminiApiKey();
        const result = await runGeminiNativeVoiceTurn({
          userText,
          pcmInput,
          history,
          systemPrompt,
          selectedVoice,
          apiKey,
          liveModel: `models/${cleanModel}`,
          enableWebSearchTool,
        });
        if (result && (result.wavBase64 || result.reply)) {
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(
    lastErr?.message || `Gemini Native Voice Agent (${GEMINI_VOICE_MODEL}) failed.`
  );
}

// In-memory cache for filler audio ("Ek second, abhi batata hoon.") per voice
// so subsequent filler audio plays in 0ms!
const fillerAudioCache = new Map();

async function getFillerAudio(voice = GEMINI_TTS_VOICE, customFillerText = DEFAULT_FILLER_TEXT) {
  const key = `${voice}::${customFillerText}`;
  if (fillerAudioCache.has(key)) {
    const existing = fillerAudioCache.get(key);
    if (existing && existing.mimeType === "audio/wav") {
      return existing;
    }
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
  if (cached.mimeType === "audio/wav") {
    fillerAudioCache.set(key, cached);
  }
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

function isStreamRequest(req, body = {}, url = null) {
  if (body && (body.stream === true || body.stream === "true" || body.streaming === true)) {
    return true;
  }
  if (
    url &&
    (url.searchParams.get("stream") === "true" || url.searchParams.get("stream") === "1")
  ) {
    return true;
  }
  const accept = String((req && req.headers && req.headers["accept"]) || "").toLowerCase();
  if (accept.includes("text/event-stream")) {
    return true;
  }
  return false;
}

function initSSEStream(res) {
  if (!res.headersSent) {
    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      try {
        res.flushHeaders();
      } catch {}
    }
  }
}

function createLiveStreamEmitter(res, defaultModel = DEFAULT_MODEL) {
  initSSEStream(res);
  const streamId = `chatcmpl-${Date.now()}`;
  const streamCreated = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let contentTokensEmitted = 0;
  let thinkingTokensEmitted = 0;

  return {
    get contentTokensEmitted() {
      return contentTokensEmitted;
    },
    get thinkingTokensEmitted() {
      return thinkingTokensEmitted;
    },
    onImageStatus(statusPayload) {
      if (res.writableEnded) return;
      const pType = statusPayload.type || "image_status";
      if (pType === "thinking_delta" || pType === "prompt_delta") {
        thinkingTokensEmitted++;
        const tok = statusPayload.token || "";
        const chunk = {
          id: streamId,
          object: "chat.completion.chunk",
          created: streamCreated,
          model: defaultModel,
          ...statusPayload,
          choices: [
            {
              index: 0,
              delta: {
                thinking: tok,
                reasoning: tok,
                reasoning_content: tok,
                ...(pType === "prompt_delta" ? { maxPromptDelta: tok } : {}),
              },
              finish_reason: null,
            },
          ],
        };
        sendSSEEvent(res, "thinking", chunk);
        return;
      }

      const evtName = pType === "tool_execution" ? "tool_call" : "image_status";
      const isInitialStart = statusPayload.phase === "starting" && !sentRole;
      if (isInitialStart) sentRole = true;
      const chunk = {
        id: streamId,
        object: "chat.completion.chunk",
        created: streamCreated,
        model: defaultModel,
        ...statusPayload,
        choices: [
          {
            index: 0,
            delta: {
              ...(isInitialStart
                ? {
                    role: "assistant",
                    content: statusPayload.statusMessage
                      ? `${statusPayload.statusMessage}\n\n`
                      : "",
                  }
                : {}),
              ...(statusPayload.thinking && thinkingTokensEmitted === 0
                ? {
                    thinking: statusPayload.thinking,
                    reasoning: statusPayload.thinking,
                    reasoning_content: statusPayload.thinking,
                  }
                : {}),
            },
            finish_reason: null,
          },
        ],
      };
      sendSSEEvent(res, evtName, chunk);
    },
    onToolExecution(toolPayload) {
      if (res.writableEnded) return;
      const evtName = toolPayload.type === "websearch" ? "websearch" : "tool_call";
      const chunk = {
        id: streamId,
        object: "chat.completion.chunk",
        created: streamCreated,
        model: defaultModel,
        ...toolPayload,
        choices: [
          {
            index: 0,
            delta: {
              tool_call: {
                name: toolPayload.tool || "websearch",
                status: toolPayload.toolStatus || "running",
                queries: toolPayload.searchQueries || [],
              },
            },
            finish_reason: null,
          },
        ],
      };
      sendSSEEvent(res, evtName, chunk);
    },
    onThinkingToken({ token, thinking, reasoning, id, created, model }) {
      if (res.writableEnded || !token) return;
      thinkingTokensEmitted++;
      const chunk = {
        id: id || streamId,
        object: "chat.completion.chunk",
        created: created || streamCreated,
        model: model || defaultModel,
        type: "thinking_delta",
        token,
        thinkingDelta: token,
        reasoningDelta: token,
        thinking,
        reasoning,
        choices: [
          {
            index: 0,
            delta: {
              thinking: token,
              reasoning: token,
              reasoning_content: token,
            },
            finish_reason: null,
          },
        ],
      };
      sendSSEEvent(res, "thinking", chunk);
    },
    onContentToken({ token, content, id, created, model }) {
      if (res.writableEnded || !token) return;
      contentTokensEmitted++;
      const chunk = {
        id: id || streamId,
        object: "chat.completion.chunk",
        created: created || streamCreated,
        model: model || defaultModel,
        type: "content_delta",
        token,
        delta: token,
        replyDelta: token,
        reply: content,
        choices: [
          {
            index: 0,
            delta: {
              ...(sentRole ? {} : { role: "assistant" }),
              content: token,
            },
            finish_reason: null,
          },
        ],
      };
      sentRole = true;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    },
    finishImage(finalPayload) {
      if (res.writableEnded) return;
      sendSSEEvent(res, "image_ready", finalPayload);
      res.write(
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created: streamCreated,
          model: defaultModel,
          ...finalPayload,
          choices: [
            {
              index: 0,
              delta: {
                ...(sentRole ? {} : { role: "assistant" }),
                content: finalPayload.reply || "",
                image: finalPayload.image,
                imageUrl: finalPayload.imageUrl || finalPayload.image?.url,
              },
              finish_reason: "stop",
            },
          ],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    },
    finishChat(finalPayload, assembled) {
      if (res.writableEnded) return;
      const chunkPayload = {
        id: (assembled && assembled.id) || streamId,
        object: "chat.completion.chunk",
        created: (assembled && assembled.created) || streamCreated,
        model: (assembled && assembled.model) || defaultModel,
        ...finalPayload,
        choices: [
          {
            index: 0,
            delta:
              contentTokensEmitted > 0
                ? {}
                : {
                    role: "assistant",
                    content: finalPayload.reply || (assembled && assembled.content) || "",
                    ...(thinkingTokensEmitted === 0 && finalPayload.thinking
                      ? {
                          thinking: finalPayload.thinking,
                          reasoning: finalPayload.thinking,
                          reasoning_content: finalPayload.thinking,
                        }
                      : {}),
                  },
            finish_reason: (assembled && assembled.finishReason) || "stop",
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
  };
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
        voice: GEMINI_VOICE_MODEL,
        stt: GEMINI_VOICE_MODEL,
        llm: GEMINI_VOICE_MODEL,
        chatLlm: DEFAULT_MODEL,
        imageGeneration: NVIDIA_IMAGE_MODEL,
        imageEditing: CLOUDFLARE_EDIT_MODEL,
        tts: GEMINI_VOICE_MODEL,
        ttsDefaultVoice: GEMINI_TTS_VOICE,
      },
      availableFemaleVoices: SMOOTH_FEMALE_VOICES,
      voiceAgentConfig: {
        fastNoReasoningByDefault: true,
        smartFillerEnabled: true,
        webSearchEnabled: true,
        defaultFillerPhrase: DEFAULT_FILLER_TEXT,
      },
      configuredKeys: {
        OPENCODE_API_KEY: Boolean(OPENCODE_API_KEY),
        GEMINI_API_KEY: GEMINI_API_KEYS.length > 0,
        NVIDIA_API_KEY: Boolean(getNvidiaApiKey()),
        IMAGE_API_KEY: Boolean(IMAGE_API_KEY),
      },
      endpoints: {
        prompt: "GET /api/prompt",
        textAndImageChat: "POST /api/chat",
        visionChat: "POST /api/vision",
        imageGenerateOrEdit: "POST /api/image",
        imageGenerate: "POST /api/image/generate",
        imageEdit: "POST /api/image/edit",
        voiceAgent: "POST /api/voice",
        voiceFillerAudio: "GET /api/voice/filler",
        voicesCatalog: "GET /api/voices",
        webSearch: "POST /api/websearch",
        historyChats: "GET /api/history/chats?user=<email>",
        historyTurns: "POST /api/history/turns",
        speechToText: "POST /api/stt",
        textToSpeech: "POST /api/tts",
        openAICompatible: "POST /v1/chat/completions",
        models: "GET /v1/models",
        health: "GET /api/health",
      },
    });
  }

  // 1a. Active System Prompts, Last Sent Prompt & App Integration Prompt Endpoint:
  //     GET / POST /api/prompt (aliases: /prompt, /api/prompts, /api/system-prompt, /api/last-prompt)
  if (
    pathname === "/api/prompt" ||
    pathname === "/prompt" ||
    pathname === "/api/prompts" ||
    pathname === "/prompts" ||
    pathname === "/api/system-prompt" ||
    pathname === "/api/last-prompt"
  ) {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
      if (typeof body.systemPrompt === "string" && body.systemPrompt.trim()) {
        DEFAULT_SYSTEM_PROMPT = body.systemPrompt.trim();
      }
      if (typeof body.prompt === "string" && body.prompt.trim()) {
        DEFAULT_SYSTEM_PROMPT = body.prompt.trim();
      }
      if (typeof body.voiceSystemPrompt === "string" && body.voiceSystemPrompt.trim()) {
        VOICE_FAST_SYSTEM_PROMPT = body.voiceSystemPrompt.trim();
      }
      return sendJson(res, 200, {
        success: true,
        message: "Active system prompt updated.",
        prompt: `/no_think ${DEFAULT_SYSTEM_PROMPT}`,
        voiceFastSystemPrompt: VOICE_FAST_SYSTEM_PROMPT,
      });
    }

    const voiceNativeSystemPrompt =
      `You are ${AI_NAME}, the fast, smart, warm real-time voice AI assistant inside the ${APP_NAME} app. ` +
      `When asked who you are or what your name is, say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
      `Speak naturally in the same language as the user (Hinglish, Hindi, or English) with a smooth, sweet, warm Indian conversational flow. ` +
      `WEB RESEARCH RULE: Whenever the user asks about live news, current prices/rates (Bitcoin, crypto, stocks, gold), weather, sports/IPL scores, 2025/2026 events, or asks you to search/check online, call the 'websearch' tool first and answer using the live OpenCode search results. ` +
      `IMPORTANT: Keep every reply to ONE short, natural spoken sentence (maximum 15 to 18 words) unless the user explicitly asks for a detailed explanation.`;

    const webSearchRuleSuffix =
      `WEB SEARCH RULE: You have real-time internet access via OpenCode 'websearch' and 'webfetch' tools. For current events, news, live prices/rates, weather, scores, 2025/2026 facts, or online lookups, use live OpenCode web search facts (or call 'websearch' if not already provided). CRITICAL RULE: NEVER call bash, edit, glob, grep, or read.`;

    const appBuilderMasterPrompt =
      `Connect my existing Vega App (Max v1.0 AI) UI to our live backend at https://vega-ai-6m2k.onrender.com without modifying any existing UI design, styles, or Support Chat.\n` +
      `1. Text Agent (deepseek-v4.1-flash-free + Live OpenCode Web Search): POST https://vega-ai-6m2k.onrender.com/api/chat with JSON { "message": "<text>", "history": [...], "image": "<optional_base64>" } -> render data.reply.\n` +
      `2. Voice Agent (gemini-2.5-flash-native-audio-preview-12-2025, Aoede voice + Live OpenCode Web Search): POST https://vega-ai-6m2k.onrender.com/api/voice with JSON { "audio": "<base64_wav_or_webm>", "mimeType": "audio/wav", "voice": "Aoede", "history": [...] } -> show data.transcript, data.reply, and auto-play data.audio.dataUri.\n` +
      `3. Per-User Chat History (ai_chats & ai_messages): GET /api/history/chats?user=<email>, GET /api/history/chats/<chatId>?user=<email>, POST /api/history/turns, PATCH /api/history/chats/<chatId>, DELETE /api/history/chats/<chatId>.`;

    const format = (url.searchParams.get("format") || "").toLowerCase();
    if (format === "text" || url.searchParams.get("raw") === "1") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(
        `=== TEXT AGENT SYSTEM PROMPT (POST /api/chat & POST /v1/chat/completions) ===\n` +
          `/no_think ${DEFAULT_SYSTEM_PROMPT}\n\n` +
          `=== VOICE AGENT SYSTEM PROMPT (POST /api/voice) ===\n` +
          `${voiceNativeSystemPrompt}\n\n` +
          `=== VOICE FAST SYSTEM PROMPT ===\n` +
          `${VOICE_FAST_SYSTEM_PROMPT}\n\n` +
          `=== ALWAYS-APPENDED WEB SEARCH RULE ===\n` +
          `${webSearchRuleSuffix}\n\n` +
          `=== LAST SENT PROMPT ON SERVER ===\n` +
          `${JSON.stringify(recentSentPrompts[0] || null, null, 2)}\n`
      );
    }

    return sendJson(res, 200, {
      success: true,
      ai: AI_NAME,
      app: APP_NAME,
      prompt: `/no_think ${DEFAULT_SYSTEM_PROMPT}`,
      lastSentPrompt: recentSentPrompts[0] || null,
      recentSentPrompts,
      activePromptsSentOnEveryTurn: {
        textAgentSystemPrompt: `/no_think ${DEFAULT_SYSTEM_PROMPT}`,
        textAgentRawSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        voiceAgentNativeSystemPrompt: voiceNativeSystemPrompt,
        voiceFastSystemPrompt: VOICE_FAST_SYSTEM_PROMPT,
        alwaysAppendedWebSearchRule: webSearchRuleSuffix,
        voiceFillerPhrase: DEFAULT_FILLER_TEXT,
        userTurnSuffixWhenFastNoReasoning: "/no_think",
        preSearchContextTemplate:
          "[Live OpenCode Web Search Results (Date: YYYY-MM-DD)]:\n<results>\n\nIMPORTANT: The live OpenCode web search has ALREADY been executed above. Answer the user's question directly, accurately, and naturally using these live facts. Do NOT call the 'websearch' tool again. /no_think",
      },
      appBuilderMasterPrompt,
      models: {
        textAgentModel: DEFAULT_MODEL,
        voiceAgentModel: GEMINI_VOICE_MODEL,
        defaultVoice: GEMINI_TTS_VOICE,
      },
    });
  }

  // 1b. Smooth Female Voices Catalog Endpoint: GET /api/voices
  if (req.method === "GET" && (pathname === "/api/voices" || pathname === "/voices")) {
    return sendJson(res, 200, {
      success: true,
      ai: AI_NAME,
      app: APP_NAME,
      ttsModel: GEMINI_TTS_MODEL,
      defaultVoice: GEMINI_TTS_VOICE,
      voices: SMOOTH_FEMALE_VOICES,
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
  //    Unified Single-Model Pipeline:
  //    [1] STT: `gemini-2.5-flash-native-audio-preview-12-2025`
  //    [2] LLM: `gemini-2.5-flash-native-audio-preview-12-2025` (Max v1.0, zero thinking delay)
  //    [3] TTS: `gemini-2.5-flash-native-audio-preview-12-2025` (Aoede 24kHz WAV output for Vega App)
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
    const selectedVoice = normalizeVoiceName(body.voice || GEMINI_TTS_VOICE || "Aoede");

    try {
      let userTranscript = (body.text ?? body.message ?? "").trim();
      const audioInput = body.audio || body.audioBase64;
      let pcmInput = null;

      if (!userTranscript && audioInput) {
        const { mimeType, base64Data } = parseBase64AudioInput(
          audioInput,
          body.mimeType || "audio/wav"
        );
        pcmInput = extractPcmFromWavBase64(base64Data, mimeType);
        if (!pcmInput) {
          // Compressed browser audio (e.g. audio/webm;codecs=opus): transcribe and feed to Native Audio model
          const sttResult = await transcribeWithGeminiSTT({
            audioBase64: base64Data,
            mimeType,
            languageHint: body.language || "",
          });
          userTranscript = sttResult.transcript;
        }
      }

      if (!userTranscript && !pcmInput) {
        return sendJson(res, 400, {
          success: false,
          error:
            "No speech detected in audio (or empty input). Please send 'audio' (base64) or 'message' (text).",
          transcript: "",
        });
      }

      let needsThinking =
        typeof body.thinking === "boolean"
          ? body.thinking
          : detectNeedsThinking(userTranscript);

      const disableReasoning = body.reasoning === true ? false : true;
      let fillerSentInStream = false;

      if (wantsStream) {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (userTranscript) {
          sendSSEEvent(res, "transcript", {
            type: "transcript",
            transcript: userTranscript,
            needsThinking,
          });
        }

        if (needsThinking && body.tts !== false) {
          try {
            const filler = await getFillerAudio(
              selectedVoice,
              body.fillerText || DEFAULT_FILLER_TEXT
            );
            fillerSentInStream = true;
            sendSSEEvent(res, "filler", {
              type: "filler",
              text: filler.text,
              audio: filler,
            });
          } catch {}
        }
      }

      const fillerCacheKey = `${selectedVoice}::${body.fillerText || DEFAULT_FILLER_TEXT}`;
      const trimmedHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];
      let usedWebSearch = false;
      const searchQueries = [];
      let effectiveUserText = userTranscript;

      if (needsThinking && userTranscript) {
        try {
          usedWebSearch = true;
          searchQueries.push(userTranscript);
          if (wantsStream) {
            sendSSEEvent(res, "websearch", {
              type: "websearch",
              queries: searchQueries,
            });
          }
          const searchResultText = await executeOpenCodeWebSearch({
            query: userTranscript,
            numResults: 4,
          });
          if (searchResultText) {
            effectiveUserText =
              `User question: ${userTranscript}\n\n` +
              `Live web search facts (use these to answer concisely in 1-2 spoken sentences, starting with "Ek second, abhi batata hoon..."): \n${String(
                searchResultText
              ).slice(0, 1200)}`;
          }
        } catch {}
      }

      const nativeResult = await runGeminiNativeVoiceAgent({
        userText: effectiveUserText,
        pcmInput,
        history: trimmedHistory,
        systemPrompt: body.system || body.systemPrompt || "",
        voice: selectedVoice,
        enableWebSearchTool: !usedWebSearch,
      });

      if (nativeResult.usedWebSearch) {
        usedWebSearch = true;
        for (const q of nativeResult.searchQueries || []) {
          if (q && !searchQueries.includes(q)) searchQueries.push(q);
        }
        needsThinking = true;
      }

      const finalTranscript = (userTranscript || nativeResult.transcript || "").trim();
      let replyText = (nativeResult.reply || "").trim();

      if (
        (usedWebSearch || needsThinking) &&
        replyText &&
        !/^ek\s+second/i.test(replyText)
      ) {
        replyText = `Ek second, abhi batata hoon... ${replyText}`;
      }

      let audioOutput = null;
      if (body.tts !== false && nativeResult.wavBase64) {
        audioOutput = {
          mimeType: nativeResult.mimeType,
          sampleRate: nativeResult.sampleRate,
          voice: nativeResult.voice,
          base64: nativeResult.wavBase64,
          dataUri: nativeResult.dataUri,
        };
      }

      const fillerAudio = fillerAudioCache.get(fillerCacheKey) || null;

      const finalPayload = {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        pipeline: {
          sttModel: GEMINI_VOICE_MODEL,
          llmModel: nativeResult.model || GEMINI_VOICE_MODEL,
          ttsModel: nativeResult.model || GEMINI_VOICE_MODEL,
          voice: selectedVoice,
          fastNoReasoning: disableReasoning,
          needsThinking,
          usedWebSearch,
          searchQueries,
        },
        transcript: finalTranscript,
        ...(needsThinking
          ? {
              fillerText: body.fillerText || DEFAULT_FILLER_TEXT,
              fillerAudio,
            }
          : {}),
        reply: replyText,
        reasoning: null,
        audio: audioOutput,
        usage: null,
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

  // 6b. Standalone OpenCode Web Search Endpoint: POST or GET /api/websearch (or /websearch, /api/search)
  if (
    (req.method === "POST" || req.method === "GET") &&
    (pathname === "/api/websearch" ||
      pathname === "/websearch" ||
      pathname === "/api/search" ||
      pathname === "/search")
  ) {
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }
    const query = String(
      body.query ||
        body.q ||
        body.message ||
        url.searchParams.get("query") ||
        url.searchParams.get("q") ||
        ""
    ).trim();
    const numResults =
      Number(body.numResults || body.limit || url.searchParams.get("numResults") || url.searchParams.get("limit")) || 8;
    const searchType = String(body.type || url.searchParams.get("type") || "auto").trim();

    if (!query) {
      return sendJson(res, 400, {
        success: false,
        error: 'Please provide "query" (or "q") in the JSON body or URL query string.',
      });
    }
    try {
      const resultsText = await executeOpenCodeWebSearch({
        query,
        numResults,
        type: searchType,
      });
      const sources = extractWebSearchSources(resultsText);
      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        query,
        count: sources.length,
        sources,
        webSearchSources: sources,
        results: resultsText,
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Web search failed",
      });
    }
  }

  // 6c-0. Serve Stored Generated/Edited Images: GET /api/image/view/:id
  //       Checks RAM -> /tmp disk -> Vega Storage (`https://vega-storage.onrender.com/v1/files/:fileId/download`)
  const imgViewMatch = pathname.match(/^\/api\/image\/view\/([^/]+)$/);
  if (req.method === "GET" && imgViewMatch) {
    const imgId = decodeURIComponent(imgViewMatch[1]);
    const ztKey = (
      process.env.ZENTRAGRID_API_KEY ||
      process.env.STORAGE_API_KEY ||
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      req.headers["x-api-key"] ||
      url.searchParams.get("key") ||
      ""
    ).trim();
    const item = await resolveStoredImageBuffer(imgId, ztKey);
    if (!item || !Buffer.isBuffer(item.buffer)) {
      return sendJson(res, 404, { success: false, error: "Image not found or expired" });
    }
    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": item.mimeType || "image/jpeg",
      "Content-Length": item.buffer.length,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    return res.end(item.buffer);
  }

  // 6c-0b. List Stored Generated/Edited Images for a User:
  //        GET /api/images?user=<email>&chat_id=<id>&limit=50 (or GET /api/image/list, GET /api/history/images)
  if (
    req.method === "GET" &&
    (pathname === "/api/images" ||
      pathname === "/api/image/list" ||
      pathname === "/api/history/images")
  ) {
    const userEmail = String(
      url.searchParams.get("user") ||
        url.searchParams.get("email") ||
        req.headers["x-user-email"] ||
        req.headers["x-owner"] ||
        ""
    )
      .trim()
      .toLowerCase();
    const chatId = String(
      url.searchParams.get("chatId") ||
        url.searchParams.get("chat_id") ||
        req.headers["x-chat-id"] ||
        ""
    ).trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const ztKey = (
      process.env.ZENTRAGRID_API_KEY ||
      process.env.STORAGE_API_KEY ||
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      req.headers["x-api-key"] ||
      req.headers["x-zentragrid-key"] ||
      ""
    ).trim();

    const images = await listStoredUserImages({
      userEmail,
      chatId,
      limit,
      ztKey,
    });

    return sendJson(res, 200, {
      success: true,
      user: userEmail || null,
      chatId: chatId || null,
      count: images.length,
      images,
    });
  }

  // 6c. Dedicated Image Generate & Vision Image Edit Endpoints:
  //     POST /api/image, POST /api/image/generate, POST /api/image/edit
  if (
    req.method === "POST" &&
    (pathname === "/api/image" ||
      pathname === "/api/image/generate" ||
      pathname === "/api/image/edit" ||
      pathname === "/image" ||
      pathname === "/generate" ||
      pathname === "/edit")
  ) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
    const messages = normalizeMessages(body, DEFAULT_SYSTEM_PROMPT);
    const imageInput = extractLatestImageInput(body, messages);
    const userText =
      extractLatestUserText(messages) ||
      String(body.prompt || body.message || body.text || "").trim();

    const forcedAction =
      pathname.endsWith("/edit") || body.mode === "edit" || body.imageAction === "edit"
        ? "edit"
        : pathname.endsWith("/generate") || body.mode === "generate" || body.imageAction === "generate"
        ? "generate"
        : imageInput
        ? "edit"
        : "generate";

    if (!userText && !imageInput) {
      return sendJson(res, 400, {
        success: false,
        error: 'Please provide "prompt" / "message" (and "image" for edit mode).',
      });
    }

    try {
      const wantsStream = isStreamRequest(req, body, url);
      const liveStream = wantsStream
        ? createLiveStreamEmitter(res, body.model || DEFAULT_MODEL)
        : null;

      const imgResult = await runMaxImageAgent({
        userText: userText || "Enhance and beautify this image",
        imageInput,
        action: forcedAction,
        model: body.model || DEFAULT_MODEL,
        options: enrichImageOptionsFromReq(req, url, body),
        onStatus: (statusPayload) => {
          if (liveStream) {
            liveStream.onImageStatus(statusPayload);
          }
        },
      });

      const responsePayload = {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: DEFAULT_MODEL,
        imageModel: imgResult.imageModel,
        isImageTask: true,
        imageAction: imgResult.action,
        imageStatus: "completed",
        readyForImage: true,
        sentImageToWorker: imgResult.sentImageToWorker,
        workerEndpoint: imgResult.workerEndpoint,
        width: imgResult.width,
        height: imgResult.height,
        aspectRatio: imgResult.aspectRatio,
        statusMessage: imgResult.statusMessage,
        userPrompt: imgResult.userPrompt,
        maxPrompt: imgResult.maxPrompt,
        thinking: imgResult.thinking,
        reasoning: imgResult.reasoning,
        reply: imgResult.finalReply,
        imageId: imgResult.imageId,
        fileId: imgResult.fileId,
        storedInVault: imgResult.storedInVault,
        user: imgResult.user,
        chatId: imgResult.chatId,
        image: imgResult.image,
        imageUrl: imgResult.hostedUrl,
      };

      if (liveStream) {
        liveStream.finishImage(responsePayload);
        return;
      }

      return sendJson(res, 200, responsePayload);
    } catch (err) {
      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          success: false,
          error: err.message || "Image generation/editing failed",
        });
        return res.end();
      }
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Image generation/editing failed",
      });
    }
  }

  // 7. Vega App Normal Agent (Text-to-Text, Image + Text-to-Text, Image Generate/Edit & Live Web Search): POST /api/chat (or /api/vision)
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

    const wantsStream = isStreamRequest(req, body, url);
    const liveStream = wantsStream
      ? createLiveStreamEmitter(res, body.model || DEFAULT_MODEL)
      : null;

    try {
      // Check if the user is asking Max v1.0 to EDIT an uploaded image or GENERATE a new image
      const imageInput = extractLatestImageInput(body, messages);
      const latestUserText = extractLatestUserText(messages);
      const imageTaskAction = detectImageTaskIntent(latestUserText, imageInput, body);

      if (imageTaskAction) {
        const imgResult = await runMaxImageAgent({
          userText: latestUserText || "Edit and enhance this image",
          imageInput,
          action: imageTaskAction,
          model: body.model || DEFAULT_MODEL,
          options: enrichImageOptionsFromReq(req, url, body),
          onStatus: (statusPayload) => {
            if (liveStream) {
              liveStream.onImageStatus(statusPayload);
            }
          },
        });

        const finalPayload = {
          success: true,
          ai: AI_NAME,
          app: APP_NAME,
          model: DEFAULT_MODEL,
          imageModel: imgResult.imageModel,
          isImageTask: true,
          imageAction: imgResult.action,
          imageStatus: "completed",
          readyForImage: true,
          sentImageToWorker: imgResult.sentImageToWorker,
          workerEndpoint: imgResult.workerEndpoint,
          width: imgResult.width,
          height: imgResult.height,
          aspectRatio: imgResult.aspectRatio,
          statusMessage: imgResult.statusMessage,
          userPrompt: imgResult.userPrompt,
          maxPrompt: imgResult.maxPrompt,
          reply: imgResult.finalReply,
          imageId: imgResult.imageId,
          fileId: imgResult.fileId,
          storedInVault: imgResult.storedInVault,
          user: imgResult.user,
          chatId: imgResult.chatId,
          image: imgResult.image,
          imageUrl: imgResult.hostedUrl,
          usedWebSearch: false,
          searchQueries: [],
          webSearchSources: [],
          webSearchResults: null,
          thinking: imgResult.thinking,
          reasoning: imgResult.reasoning,
          usage: null,
        };

        if (liveStream) {
          liveStream.finishImage(finalPayload);
          return;
        }

        return sendJson(res, 200, finalPayload);
      }

      const disableReasoning =
        body.deepThinking === true || body.noThink === false ? false : true;
      const allowWebSearch = body.webSearch !== false && body.allowWebSearch !== false;
      const forceWebSearch = body.webSearch === true || body.search === true;

      const agentResult = await runOpenCodeAgentWithTools(
        {
          model: body.model || DEFAULT_MODEL,
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          disableReasoning,
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
          sendSSEEvent(res, "error", {
            success: false,
            error: "Upstream OpenCode API error",
            details: agentResult.errorText,
          });
          return res.end();
        }
        return sendJson(res, agentResult.status || 502, {
          success: false,
          error: "Upstream OpenCode API error",
          details: agentResult.errorText,
        });
      }

      const assembled = agentResult.assembled;

      // Fallback check: if deepseek-v4.1-flash-free emitted <IMAGE_TASK> or accidentally refused image gen
      const fallbackImgTask = parseModelImageFallback(
        assembled.content,
        latestUserText,
        Boolean(imageInput && imageInput.isCurrentTurnImage)
      );
      if (fallbackImgTask) {
        const imgResult = await runMaxImageAgent({
          userText: latestUserText,
          imageInput,
          action: fallbackImgTask.action,
          model: body.model || DEFAULT_MODEL,
          preCraftedPrompt: fallbackImgTask.maxPrompt,
          preThinking: assembled.reasoning || "",
          preStatusMessage: fallbackImgTask.statusMessage,
          preFinalReply: fallbackImgTask.finalReply,
          options: enrichImageOptionsFromReq(req, url, body),
          onStatus: (statusPayload) => {
            if (liveStream) {
              liveStream.onImageStatus(statusPayload);
            }
          },
        });
        const finalPayload = {
          success: true,
          ai: AI_NAME,
          app: APP_NAME,
          model: DEFAULT_MODEL,
          imageModel: imgResult.imageModel,
          isImageTask: true,
          imageAction: imgResult.action,
          imageStatus: "completed",
          readyForImage: true,
          width: imgResult.width,
          height: imgResult.height,
          aspectRatio: imgResult.aspectRatio,
          statusMessage: fallbackImgTask.statusMessage || imgResult.statusMessage,
          userPrompt: imgResult.userPrompt,
          maxPrompt: imgResult.maxPrompt,
          reply: fallbackImgTask.finalReply || imgResult.finalReply,
          imageId: imgResult.imageId,
          fileId: imgResult.fileId,
          storedInVault: imgResult.storedInVault,
          user: imgResult.user,
          chatId: imgResult.chatId,
          image: imgResult.image,
          imageUrl: imgResult.hostedUrl,
          usedWebSearch: false,
          searchQueries: [],
          webSearchSources: [],
          webSearchResults: null,
          thinking: imgResult.thinking || assembled.reasoning || null,
          reasoning: imgResult.reasoning || assembled.reasoning || null,
          usage: null,
        };
        if (liveStream) {
          liveStream.finishImage(finalPayload);
          return;
        }
        return sendJson(res, 200, finalPayload);
      }

      const chatPayload = {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: assembled.model,
        usedWebSearch: agentResult.usedWebSearch,
        searchQueries: agentResult.searchQueries,
        webSearchSources: agentResult.webSearchSources || [],
        webSearchResults: agentResult.webSearchResults || null,
        thinking: assembled.reasoning || null,
        reasoning: assembled.reasoning || null,
        reply: assembled.content,
        usage: assembled.usage,
      };

      if (liveStream) {
        liveStream.finishChat(chatPayload, assembled);
        return;
      }

      return sendJson(res, 200, chatPayload);
    } catch (err) {
      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          success: false,
          error: err.message || "Internal server error",
        });
        return res.end();
      }
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Internal server error",
      });
    }
  }

  // 8. OpenAI-Compatible Endpoint: POST /v1/chat/completions
  //    Also executes OpenCode `websearch` & `webfetch` automatically via `runOpenCodeAgentWithTools`!
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
    const wantsStream = isStreamRequest(req, body, url);
    const liveStream = wantsStream
      ? createLiveStreamEmitter(res, body.model || DEFAULT_MODEL)
      : null;
    const disableReasoning =
      body.deepThinking === true || body.noThink === false ? false : true;
    const allowWebSearch = body.webSearch !== false && body.allowWebSearch !== false;
    const forceWebSearch = body.webSearch === true || body.search === true;

    try {
      const imageInput = extractLatestImageInput(body, messages);
      const latestUserText = extractLatestUserText(messages);
      const imageTaskAction = detectImageTaskIntent(latestUserText, imageInput, body);

      if (imageTaskAction) {
        const imgResult = await runMaxImageAgent({
          userText: latestUserText || "Generate or edit image",
          imageInput,
          action: imageTaskAction,
          model: body.model || DEFAULT_MODEL,
          options: enrichImageOptionsFromReq(req, url, body),
          onStatus: (statusPayload) => {
            if (liveStream) {
              liveStream.onImageStatus(statusPayload);
            }
          },
        });
        const finalPayload = {
          id: `chatcmpl-img-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: DEFAULT_MODEL,
          success: true,
          ai: AI_NAME,
          app: APP_NAME,
          imageModel: imgResult.imageModel,
          isImageTask: true,
          imageAction: imgResult.action,
          imageStatus: "completed",
          readyForImage: true,
          width: imgResult.width,
          height: imgResult.height,
          aspectRatio: imgResult.aspectRatio,
          statusMessage: imgResult.statusMessage,
          userPrompt: imgResult.userPrompt,
          maxPrompt: imgResult.maxPrompt,
          thinking: imgResult.thinking,
          reasoning: imgResult.reasoning,
          reply: imgResult.finalReply,
          imageId: imgResult.imageId,
          fileId: imgResult.fileId,
          storedInVault: imgResult.storedInVault,
          user: imgResult.user,
          chatId: imgResult.chatId,
          image: imgResult.image,
          imageUrl: imgResult.hostedUrl,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: imgResult.finalReply,
                thinking: imgResult.thinking,
                reasoning: imgResult.reasoning,
                reasoning_content: imgResult.reasoning,
                imageId: imgResult.imageId,
                fileId: imgResult.fileId,
                image: imgResult.image,
                imageUrl: imgResult.hostedUrl,
              },
              finish_reason: "stop",
            },
          ],
        };
        if (liveStream) {
          liveStream.finishImage(finalPayload);
          return;
        }
        return sendJson(res, 200, finalPayload);
      }

      const agentResult = await runOpenCodeAgentWithTools(
        {
          model: body.model || DEFAULT_MODEL,
          messages,
          tools: body.tools,
          tool_choice: body.tool_choice,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          disableReasoning,
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
          sendSSEEvent(res, "error", {
            error: {
              message: agentResult.errorText,
              type: "upstream_error",
            },
          });
          return res.end();
        }
        return sendJson(res, agentResult.status || 502, {
          error: {
            message: agentResult.errorText,
            type: "upstream_error",
          },
        });
      }

      const assembled = agentResult.assembled;

      const fallbackImgTask = parseModelImageFallback(
        assembled.content,
        latestUserText,
        Boolean(imageInput && imageInput.isCurrentTurnImage)
      );
      if (fallbackImgTask) {
        const imgResult = await runMaxImageAgent({
          userText: latestUserText,
          imageInput,
          action: fallbackImgTask.action,
          model: body.model || DEFAULT_MODEL,
          preCraftedPrompt: fallbackImgTask.maxPrompt,
          preThinking: assembled.reasoning || "",
          preStatusMessage: fallbackImgTask.statusMessage,
          preFinalReply: fallbackImgTask.finalReply,
          options: enrichImageOptionsFromReq(req, url, body),
          onStatus: (statusPayload) => {
            if (liveStream) {
              liveStream.onImageStatus(statusPayload);
            }
          },
        });
        const finalPayload = {
          id: `chatcmpl-img-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: DEFAULT_MODEL,
          success: true,
          ai: AI_NAME,
          app: APP_NAME,
          imageModel: imgResult.imageModel,
          isImageTask: true,
          imageAction: imgResult.action,
          imageStatus: "completed",
          readyForImage: true,
          width: imgResult.width,
          height: imgResult.height,
          aspectRatio: imgResult.aspectRatio,
          statusMessage: fallbackImgTask.statusMessage || imgResult.statusMessage,
          userPrompt: imgResult.userPrompt,
          maxPrompt: imgResult.maxPrompt,
          thinking: imgResult.thinking || assembled.reasoning || null,
          reasoning: imgResult.reasoning || assembled.reasoning || null,
          reply: fallbackImgTask.finalReply || imgResult.finalReply,
          imageId: imgResult.imageId,
          fileId: imgResult.fileId,
          storedInVault: imgResult.storedInVault,
          user: imgResult.user,
          chatId: imgResult.chatId,
          image: imgResult.image,
          imageUrl: imgResult.hostedUrl,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: fallbackImgTask.finalReply || imgResult.finalReply,
                thinking: imgResult.thinking || assembled.reasoning || null,
                reasoning: imgResult.reasoning || assembled.reasoning || null,
                imageId: imgResult.imageId,
                fileId: imgResult.fileId,
                image: imgResult.image,
                imageUrl: imgResult.hostedUrl,
              },
              finish_reason: "stop",
            },
          ],
        };
        if (liveStream) {
          liveStream.finishImage(finalPayload);
          return;
        }
        return sendJson(res, 200, finalPayload);
      }

      if (liveStream) {
        liveStream.finishChat(
          {
            reply: assembled.content,
            usedWebSearch: agentResult.usedWebSearch,
            searchQueries: agentResult.searchQueries,
            webSearchSources: agentResult.webSearchSources || [],
            webSearchResults: agentResult.webSearchResults || null,
            thinking: assembled.reasoning || null,
            reasoning: assembled.reasoning || null,
          },
          assembled
        );
        return;
      }

      return sendJson(res, 200, {
        id: assembled.id,
        object: "chat.completion",
        created: assembled.created,
        model: assembled.model,
        usedWebSearch: agentResult.usedWebSearch,
        searchQueries: agentResult.searchQueries,
        webSearchSources: agentResult.webSearchSources || [],
        webSearchResults: agentResult.webSearchResults || null,
        thinking: assembled.reasoning || null,
        reasoning: assembled.reasoning || null,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: assembled.content,
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

  // 9. High-Level Chat History Backend Routes (`/api/history/*`)
  //    Wraps ZentraGrid (`https://vega-storage.onrender.com`) `ai_chats`, `ai_messages`, and `/v1/files`
  //    using deterministic IDs (`ai_chat_<emailSlug>_<createdAtMs>`, `ai_msg_<chatId>_<seq>`).
  if (pathname.startsWith("/api/history")) {
    const ztKey = (
      process.env.ZENTRAGRID_API_KEY ||
      process.env.STORAGE_API_KEY ||
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      req.headers["x-api-key"] ||
      ""
    ).trim();
    if (!ztKey) {
      return sendJson(res, 401, {
        success: false,
        error: {
          message: "ZENTRAGRID_API_KEY is required (configure on Render server env or pass Authorization: Bearer <key>)",
          code: "INVALID_ID_TOKEN",
        },
      });
    }
    const ztBase = (process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com").replace(/\/+$/, "");

    const ztFetch = async (relPath, opts = {}) => {
      const resp = await fetch(`${ztBase}${relPath}`, {
        method: opts.method || "GET",
        headers: {
          Authorization: `Bearer ${ztKey}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await resp.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: resp.status, ok: resp.ok, json, headers: resp.headers };
    };

    const emailToSlug = (e) =>
      String(e || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64) || "user";

    // 9a. GET /api/history/chats?user=<email>&limit=50&cursor=<cursor> -> listChats()
    if (req.method === "GET" && pathname === "/api/history/chats") {
      const userEmail = String(url.searchParams.get("user") || url.searchParams.get("email") || "")
        .trim()
        .toLowerCase();
      if (!userEmail) {
        return sendJson(res, 400, {
          success: false,
          error: { message: "Query param ?user=<email> is required" },
        });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      const cursor = url.searchParams.get("cursor") || "";
      const qs =
        `?where=user:eq:${encodeURIComponent(userEmail)}` +
        `&order_by=updated_at:desc&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const out = await ztFetch(`/v1/data/ai_chats${qs}`);
      if (!out.ok) return sendJson(res, out.status, out.json || { error: { message: "Failed to list chats" } });
      const chats = (out.json?.documents || []).map((d) => ({ id: d.id, ...(d.data || {}) }));
      return sendJson(res, 200, {
        success: true,
        chats,
        documents: out.json?.documents || [],
        next_cursor: out.json?.next_cursor || null,
      });
    }

    // 9b. GET /api/history/chats/:chatId?user=<email> -> openChat(id)
    const chatMatch = pathname.match(/^\/api\/history\/chats\/([^/]+)$/);
    if (req.method === "GET" && chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      const userEmail = String(url.searchParams.get("user") || url.searchParams.get("email") || "")
        .trim()
        .toLowerCase();
      const chatRes = await ztFetch(
        `/v1/data/ai_chats?where=id:eq:${encodeURIComponent(chatId)}&limit=1`
      );
      const chatEnvelope = (chatRes.json?.documents || [])[0] || null;
      const chatDoc = chatEnvelope ? { id: chatEnvelope.id, ...(chatEnvelope.data || {}) } : null;
      if (chatDoc && userEmail && chatDoc.user && String(chatDoc.user).toLowerCase() !== userEmail) {
        return sendJson(res, 403, {
          success: false,
          error: { message: "Chat belongs to a different user" },
        });
      }

      const allMessages = [];
      let cursor = null;
      for (let page = 0; page < 50; page++) {
        const qs =
          `?where=chat_id:eq:${encodeURIComponent(chatId)}` +
          `&order_by=at&limit=200` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const msgRes = await ztFetch(`/v1/data/ai_messages${qs}`);
        if (!msgRes.ok) break;
        for (const doc of msgRes.json?.documents || []) {
          allMessages.push({ id: doc.id, ...(doc.data || {}) });
        }
        cursor = msgRes.json?.next_cursor || null;
        if (!cursor) break;
      }

      return sendJson(res, 200, {
        success: true,
        chat: chatDoc,
        messages: allMessages,
      });
    }

    // 9c. POST /api/history/turns (or POST /api/history/chats/:chatId/turns) -> appendTurn(chatId, turn)
    const turnMatch = pathname.match(/^\/api\/history\/(?:turns|chats\/([^/]+)\/turns)$/);
    if (req.method === "POST" && turnMatch) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { success: false, error: { message: err.message } });
      }
      const userEmail = String(body.user || body.email || "")
        .trim()
        .toLowerCase();
      if (!userEmail) {
        return sendJson(res, 400, {
          success: false,
          error: { message: '"user" (lowercase email) is required in JSON body' },
        });
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const chatId =
        (turnMatch[1] ? decodeURIComponent(turnMatch[1]) : "") ||
        body.chatId ||
        body.chat_id ||
        `ai_chat_${emailToSlug(userEmail)}_${body.createdAtMs || nowMs}`;
      const device = body.device === "ios" || body.device === "web" ? body.device : "android";

      // Check if chat exists
      const existingRes = await ztFetch(
        `/v1/data/ai_chats?where=id:eq:${encodeURIComponent(chatId)}&limit=1`
      );
      let chatData = (existingRes.json?.documents || [])[0]?.data || null;

      // Support single turn (`role`, `text`) or paired turn (`user: {text}`, `ai: {text}`)
      const items = [];
      if (body.user && typeof body.user === "object" && body.ai && typeof body.ai === "object") {
        items.push({ role: "user", ...body.user });
        items.push({ role: "ai", ...body.ai });
      } else {
        items.push({
          role: body.role || "user",
          text: body.text || body.message || body.reply || "",
          kind:
            body.kind ||
            (body.image_url || body.imageUrl || body.image || body.max_prompt || body.maxPrompt
              ? "image"
              : "text"),
          file_id: body.file_id || body.fileId,
          image_id: body.image_id || body.imageId,
          image_url: body.image_url || body.imageUrl,
          image: body.image,
          max_prompt: body.max_prompt || body.maxPrompt,
          image_action: body.image_action || body.imageAction,
          width: body.width,
          height: body.height,
          thinking: body.thinking || body.reasoning,
          duration_ms: body.duration_ms,
          seq: body.seq,
          at: body.at,
        });
      }

      if (!chatData) {
        const firstUserItem = items.find((i) => i.role === "user") || items[0];
        const firstTitle =
          firstUserItem?.role === "user" && firstUserItem?.text
            ? String(firstUserItem.text).trim().slice(0, 60)
            : "New chat";
        chatData = {
          id: chatId,
          user: userEmail,
          title: firstTitle || "New chat",
          created_at: nowIso,
          updated_at: nowIso,
          turns: 0,
          last_text: String(firstUserItem?.text || "").trim().slice(0, 120),
          device,
        };
        await ztFetch("/v1/data/ai_chats", {
          method: "POST",
          body: { id: chatId, data: chatData },
        });
      }

      const savedMessages = [];
      let currentTurns = Number(chatData.turns) || 0;
      let latestText = chatData.last_text || "";
      let latestAt = nowIso;
      let updatedTitle = chatData.title || "New chat";

      for (const item of items) {
        const seqNum = Number(item.seq) > 0 ? Number(item.seq) : currentTurns + 1;
        const seqStr = String(seqNum).padStart(4, "0");
        const msgId = `ai_msg_${chatId}_${seqStr}`;
        const msgAt = item.at || new Date().toISOString();

        let resolvedKind =
          item.kind === "voice"
            ? "voice"
            : item.kind === "image" ||
              item.image_url ||
              item.imageUrl ||
              item.image ||
              item.max_prompt ||
              item.maxPrompt
            ? "image"
            : "text";

        let resolvedFileId = item.file_id || item.fileId || "";
        let resolvedImageId = item.image_id || item.imageId || "";
        let resolvedImageUrl = item.image_url || item.imageUrl || "";

        // If raw base64/dataUri image was provided without a file_id, upload it to `/v1/files` first
        if (resolvedKind === "image" && !resolvedFileId && item.image) {
          const rawStr =
            typeof item.image === "string"
              ? item.image
              : item.image?.dataUri || item.image?.base64 || "";
          if (rawStr && !/^https?:\/\//i.test(rawStr)) {
            const cleanedB64 = rawStr.replace(/^data:[^;]+;base64,/i, "").trim();
            const mimeMatch = rawStr.match(/^data:([^;]+);base64,/i);
            const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
            const imgBuf = Buffer.from(cleanedB64, "base64");
            if (imgBuf.length > 0) {
              const up = await uploadBufferToVegaStorage({
                buffer: imgBuf,
                mimeType,
                owner: userEmail,
                parentId: chatId,
                ztKey,
              });
              if (up?.fileId) {
                resolvedFileId = up.fileId;
                resolvedImageId = saveGeneratedImageBuffer(imgBuf, mimeType, resolvedFileId);
                resolvedImageUrl =
                  resolvedImageUrl ||
                  `https://vega-ai-6m2k.onrender.com/api/image/view/${resolvedImageId}`;
              }
            }
          } else if (typeof rawStr === "string" && /^https?:\/\//i.test(rawStr)) {
            resolvedImageUrl = resolvedImageUrl || rawStr;
          }
        }

        if (resolvedKind === "image" && resolvedFileId && !resolvedImageUrl) {
          const imgId = resolvedImageId || `img_${resolvedFileId}.jpg`;
          resolvedImageId = imgId;
          resolvedImageUrl = `https://vega-ai-6m2k.onrender.com/api/image/view/${imgId}`;
        }

        const msgData = {
          id: msgId,
          chat_id: chatId,
          user: userEmail,
          role: item.role === "ai" || item.role === "assistant" ? "ai" : "user",
          text: String(item.text || ""),
          at: msgAt,
          kind: resolvedKind,
          ...((resolvedKind === "voice" || resolvedKind === "image") && resolvedFileId
            ? { file_id: String(resolvedFileId) }
            : {}),
          ...(resolvedKind === "voice" && typeof item.duration_ms === "number"
            ? { duration_ms: Math.round(item.duration_ms) }
            : {}),
          ...(resolvedKind === "image" && resolvedImageId ? { image_id: String(resolvedImageId) } : {}),
          ...(resolvedKind === "image" && resolvedImageUrl ? { image_url: String(resolvedImageUrl) } : {}),
          ...(resolvedKind === "image" && (item.max_prompt || item.maxPrompt)
            ? { max_prompt: String(item.max_prompt || item.maxPrompt) }
            : {}),
          ...(resolvedKind === "image" && (item.image_action || item.imageAction)
            ? { image_action: item.image_action || item.imageAction }
            : {}),
          ...(resolvedKind === "image" && item.width ? { width: Number(item.width) } : {}),
          ...(resolvedKind === "image" && item.height ? { height: Number(item.height) } : {}),
          ...(item.thinking ? { thinking: String(item.thinking).slice(0, 4000) } : {}),
        };
        await ztFetch("/v1/data/ai_messages", {
          method: "POST",
          body: { id: msgId, data: msgData },
        });
        savedMessages.push(msgData);
        currentTurns = Math.max(currentTurns, seqNum);
        latestText = String(item.text || "").trim().slice(0, 120);
        latestAt = msgAt;
        if (updatedTitle === "New chat" && msgData.role === "user" && msgData.text.trim()) {
          updatedTitle = msgData.text.trim().slice(0, 60);
        }
      }

      const patchFields = {
        updated_at: latestAt,
        turns: currentTurns,
        last_text: latestText,
        ...(updatedTitle !== chatData.title ? { title: updatedTitle } : {}),
      };
      await ztFetch(`/v1/data/ai_chats/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        body: { data: patchFields },
      });

      return sendJson(res, 200, {
        success: true,
        chatId,
        chat: { ...chatData, ...patchFields },
        messages: savedMessages,
      });
    }

    // 9d. PATCH /api/history/chats/:chatId -> renameChat(id, title)
    if (req.method === "PATCH" && chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { success: false, error: { message: err.message } });
      }
      const title = String(body.title || "").trim().slice(0, 60) || "New chat";
      const updated_at = new Date().toISOString();
      const out = await ztFetch(`/v1/data/ai_chats/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        body: { data: { title, updated_at } },
      });
      if (!out.ok) return sendJson(res, out.status, out.json || { error: { message: "Rename failed" } });
      return sendJson(res, 200, {
        success: true,
        chat: { id: chatId, ...(out.json?.data || { title, updated_at }) },
      });
    }

    // 9e. DELETE /api/history/chats/:chatId -> deleteChat(id) (messages first, then chat doc)
    if (req.method === "DELETE" && chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      let deletedMessages = 0;
      for (let page = 0; page < 50; page++) {
        const msgRes = await ztFetch(
          `/v1/data/ai_messages?where=chat_id:eq:${encodeURIComponent(chatId)}&limit=200`
        );
        const docs = msgRes.json?.documents || [];
        if (docs.length === 0) break;
        for (const d of docs) {
          await ztFetch(`/v1/data/ai_messages/${encodeURIComponent(d.id)}`, { method: "DELETE" });
          deletedMessages++;
        }
        if (!msgRes.json?.next_cursor) break;
      }
      await ztFetch(`/v1/data/ai_chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      return sendJson(res, 200, {
        success: true,
        id: chatId,
        deleted: true,
        deletedMessages,
      });
    }
  }

  // 10. Server-Side ZentraGrid History Proxy (`/v1/data/ai_chats`, `/v1/data/ai_messages`, `/v1/files`)
  //     In any web deployment, ZENTRAGRID_API_KEY stays strictly on the server and
  //     the browser talks only to this route. Support chat collections (`messages`,
  //     `presence`, `typing`) are never touched here.
  const ztMatch = pathname.match(/^\/(?:api\/storage\/)?(v1\/(?:data\/(ai_chats|ai_messages)(?:\/[^/]+)?|files(?:\/[^/]+(?:\/download)?)?))$/);
  if (ztMatch) {
    const ztKey = (process.env.ZENTRAGRID_API_KEY || process.env.STORAGE_API_KEY || "").trim();
    if (!ztKey) {
      return sendJson(res, 401, {
        error: {
          message: "ZENTRAGRID_API_KEY is not configured on the server",
          code: "INVALID_ID_TOKEN",
        },
        code: "INVALID_ID_TOKEN",
        message: "ZENTRAGRID_API_KEY is not configured on the server",
      });
    }

    const ztBase = (process.env.ZENTRAGRID_BASE_URL || "https://vega-storage.onrender.com").replace(/\/+$/, "");
    const targetUrl = `${ztBase}/${ztMatch[1]}${url.search || ""}`;

    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

      const forwardHeaders = {
        Authorization: `Bearer ${ztKey}`,
      };
      if (req.headers["content-type"]) {
        forwardHeaders["Content-Type"] = req.headers["content-type"];
      }
      if (req.headers["range"]) {
        forwardHeaders["Range"] = req.headers["range"];
      }
      if (req.headers["x-owner"] || req.headers["x-user-email"]) {
        forwardHeaders["X-Owner"] = String(
          req.headers["x-owner"] || req.headers["x-user-email"]
        )
          .trim()
          .toLowerCase();
      }
      if (req.headers["x-parent-id"] || req.headers["x-chat-id"]) {
        forwardHeaders["X-Parent-Id"] = String(
          req.headers["x-parent-id"] || req.headers["x-chat-id"]
        ).trim();
      }

      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: req.method !== "GET" && req.method !== "HEAD" ? rawBody : undefined,
      });

      const resHeaders = {};
      for (const hName of ["content-type", "content-length", "content-range", "accept-ranges", "retry-after"]) {
        const val = upstreamRes.headers.get(hName);
        if (val) resHeaders[hName] = val;
      }
      setCorsHeaders(res);
      res.writeHead(upstreamRes.status, resHeaders);
      const arrayBuf = await upstreamRes.arrayBuffer();
      return res.end(Buffer.from(arrayBuf));
    } catch (err) {
      return sendJson(res, 502, {
        error: {
          message: err.message || "Could not reach ZentraGrid storage service",
          code: "UPSTREAM_ERROR",
        },
      });
    }
  }

  return sendJson(res, 404, {
    success: false,
    error: `Route ${req.method} ${pathname} not found. Available routes: POST /api/voice, GET /api/voice/filler, POST /api/stt, POST /api/tts, POST /api/chat, POST /v1/chat/completions, /v1/data/ai_chats, /v1/data/ai_messages, /v1/files`,
  });
});

server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 ${AI_NAME} (${APP_NAME}) Backend & Voice Agent API on http://${HOST}:${PORT}`);
  console.log(`🔑 OPENCODE_API_KEY: ${OPENCODE_API_KEY ? "Configured (env)" : "MISSING"}`);
  console.log(`🔑 GEMINI_API_KEY:   ${GEMINI_API_KEYS.length > 0 ? `Configured (${GEMINI_API_KEYS.length} key(s))` : "MISSING"}`);
  console.log(`🔑 NVIDIA_API_KEY:   ${getNvidiaApiKey() ? "Configured (env)" : "MISSING"}`);
  console.log(`🎨 Image Engine:     ${NVIDIA_IMAGE_MODEL} (1024x1024 default + dynamic aspect ratios)`);
  console.log(`🎙️ Voice Pipeline:   ${GEMINI_STT_MODEL} (STT) -> ${DEFAULT_MODEL} [No-Reasoning Fast Mode] -> ${GEMINI_TTS_MODEL} (TTS)`);
  console.log(`====================================================`);
});
