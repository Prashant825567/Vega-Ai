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
const https = require("node:https");
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
  process.env.OPENCODE_UPSTREAM_URL || "https://opencode.ai/inference/v1/chat/completions",
  "https://opencode.ai/zen/v1/chat/completions",
];

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "mimo-v2.6-flash-free";
const GEMINI_VOICE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_STT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_TTS_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

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

const DEFAULT_FILLER_TEXT =
  process.env.VOICE_FILLER_TEXT || "Ek second, abhi batata hoon.";

const DEFAULT_SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are ${AI_NAME}, a fast, smart, and helpful AI assistant built into the ${APP_NAME} app. ` +
    `When asked who you are or what your name/version is, always introduce yourself as ${AI_NAME} (the AI assistant of ${APP_NAME}). ` +
    `Reply clearly, naturally, and in the same language (English, Hindi, Hinglish, etc.) that the user uses. ` +
    `WEB SEARCH RULE: You have real-time internet access via the 'websearch' and 'webfetch' tools. Whenever the user asks about current events, latest news, live prices/rates (crypto, stocks, gold), weather, sports scores, recent releases, or asks you to search/check something online, call the 'websearch' tool first and answer using the live results. ` +
    `CRITICAL RULE: NEVER invoke or call local shell/file tools (bash, edit, glob, grep, or read)—they are unused gateway placeholders.`;

const VOICE_FAST_SYSTEM_PROMPT =
  process.env.VOICE_SYSTEM_PROMPT ||
  `/no_think You are ${AI_NAME}, the real-time voice AI agent inside the ${APP_NAME} app. ` +
    `When asked who you are, always say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
    `Reply directly in 1 to 2 short, natural spoken sentences in the user's language (Hinglish, Hindi, or English) with no markdown, asterisks, lists, or emojis. ` +
    `Do NOT call any tools for greetings, casual chat, or general knowledge—only call 'websearch' when the user asks for live/current news, prices, weather, scores, or web search. Never call bash, edit, glob, grep, or read.`;

// ─── Detect Whether a Query Needs Live OpenCode Web Search / Deep Research ───
function detectNeedsThinking(text) {
  const q = String(text || "").toLowerCase().trim();
  if (!q) return false;
  // Casual greetings / identity questions never need web search or deep thinking
  if (
    /^(hi|hello|hey|namaste|namaskar|kaise ho|kaisa hai|kaisi ho|kya haal|how are you|who are you|tum kaun ho|aap kaun ho|tera naam|tumhara naam|what is your name|good morning|good evening|good night|aur batao|sab badhiya|thank you|thanks|shukriya|ok|okay|accha|theek hai)[?!.\s]*$/i.test(
      q
    )
  ) {
    return false;
  }
  const thinkingPatterns = [
    /\b(research|analyze|analyse|compare|calculate|solve|explain in detail|deep dive|step by step|history of|difference between|write code|algorithm|debug)\b/i,
    /\b(search|web search|google|internet|online|latest|current|today|tonight|yesterday|recent|now|news|breaking|price|rate|weather|temperature|forecast|score|live|update|2024|2025|2026|2027|ipl|match|world cup|t20|cricket|football|stock|share|bitcoin|btc|eth|crypto|gold|silver|sensex|nifty|dollar|rupee|inr|usd)\b/i,
    /\b(who is|what is the current|who won|winner|prime minister|president|chief minister|ceo|founder|net worth|release date|launch date|upcoming|new movie|box office|specs|specification)\b/i,
    /\b(soch ke|soch kar|check karke|check karo|pata karke|pata karo|research karke|search karke|search karo|nikal ke|dhundh ke|detail me|detail mein|vistar se|samjhao|hisab laga|solve kar|aaj|abhi|kal|taza|khabar|mausam|bhav|keemat|kitna rate|kya rate|kaun hai|kon hai|kaun jeeta|kon jeeta|sona|chandi)\b/i,
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
const REQUIRED_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read"];
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
            "enum": ["text", "markdown", "html"],
            "description": "The format to return the content in (text, markdown, or html). Defaults to markdown.",
            "default": "markdown"
          },
          "timeout": {
            "type": "number",
            "description": "Optional timeout in seconds (max 120)"
          }
        },
        "required": ["url"]
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
            "enum": ["fallback", "preferred"],
            "description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
          },
          "type": {
            "type": "string",
            "enum": ["auto", "fast", "deep"],
            "description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
          },
          "contextMaxCharacters": {
            "type": "number",
            "description": "Maximum characters for context string optimized for LLMs (default: 10000)"
          }
        },
        "required": ["query"]
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

async function executeOpenCodeWebSearch(args = {}, sessionId = getSessionId()) {
  const query = String(args.query || args.objective || "").trim();
  if (!query) return "No search query provided.";

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
        return parsedText.slice(0, args.contextMaxCharacters || 14000);
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
            type: args.type || "auto",
            numResults: args.numResults || 8,
            livecrawl: args.livecrawl || "fallback",
            contextMaxCharacters: args.contextMaxCharacters || 10000,
          },
        },
      }),
    });

    if (exaRes.ok) {
      const raw = await exaRes.text();
      const parsedText = parseMcpWebSearchResponse(raw);
      if (parsedText) {
        return parsedText.slice(0, args.contextMaxCharacters || 14000);
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
    "User-Agent": "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
    "x-opencode-client": "cli",
    "x-opencode-project": "a070fc6ab60b2140452f8e06012ae52a1ed73781",
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
  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const existingNames = new Set(
    existingTools
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean)
  );
  const missingStubs = GATEWAY_STUB_TOOLS.filter(
    (s) => !existingNames.has(s.function.name)
  );

  const disableReasoning = payload.disableReasoning === true;
  const preparedMessages = Array.isArray(payload.messages)
    ? payload.messages.map((m, idx) => {
        if (
          disableReasoning &&
          idx === 0 &&
          m &&
          (m.role === "system" || m.role === "developer") &&
          typeof m.content === "string" &&
          !m.content.startsWith("/no_think")
        ) {
          return { ...m, content: `/no_think ${m.content}` };
        }
        return m;
      })
    : [];

  const upstreamBody = {
    model: resolveModel(payload.model),
    messages: preparedMessages,
    stream: true,
    tools: [...existingTools, ...missingStubs],
    tool_choice: payload.tool_choice && payload.tool_choice !== "none" ? payload.tool_choice : "auto",
  };

  if (typeof payload.temperature === "number") {
    upstreamBody.temperature = payload.temperature;
  }
  if (typeof payload.max_tokens === "number") {
    upstreamBody.max_tokens = payload.max_tokens;
  }

  const bodyJson = JSON.stringify(upstreamBody);

  let lastStatus = 502;
  let lastErrorText = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const sessionId = getSessionId(attempt > 0);
    // Attempt 0 & 1 use primary inference endpoint with cached vs fresh session; attempt 2 tries fallback endpoint
    const upstreamUrl = attempt < 2 ? UPSTREAM_URLS[0] : UPSTREAM_URLS[1 % UPSTREAM_URLS.length];

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
    if (response.status === 403 || response.status >= 500) {
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
  const toolCallsMap = new Map();

  let streamDone = false;
  while (!streamDone) {
    let readResult;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("SSE read idle timeout")), 12000)
        ),
      ]);
    } catch {
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
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};
          if (typeof delta.content === "string") {
            content += delta.content;
          }
          if (typeof delta.reasoning === "string") {
            reasoning += delta.reasoning;
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

  const toolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.function.name);
  content = stripLeakedReasoning(content);
  return { id, created, model, content, reasoning, finishReason, usage, toolCalls };
}

/**
 * Extracts plain text from the latest user message in a messages array.
 */
function extractLatestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content.trim();
      if (Array.isArray(m.content)) {
        const textPart = m.content.find((p) => p && p.type === "text" && typeof p.text === "string");
        if (textPart) return textPart.text.trim();
      }
    }
  }
  return "";
}

/**
 * Runs OpenCode `mimo-v2.6-flash-free` with automatic execution of OpenCode's
 * built-in `websearch` and `webfetch` tools (up to 3 turns) + proactive OpenCode
 * web search pre-fetching whenever a query needs live web research.
 */
async function runOpenCodeAgentWithTools(payload, onWebSearchStart = null) {
  const workingMessages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  let usedWebSearch = false;
  const searchQueries = [];
  let lastAssembled = null;

  // Proactive OpenCode Web Search: when the user's question asks for live/current info
  // or web research, pre-fetch OpenCode websearch (`search.parallel.ai/mcp` / `mcp.exa.ai/mcp`)
  // so `mimo-v2.6-flash-free` has verified real-time web facts even when `/no_think` is active.
  const latestUserText = extractLatestUserText(workingMessages);
  const shouldPreSearch =
    payload.allowWebSearch !== false &&
    latestUserText &&
    (payload.webSearch === true || detectNeedsThinking(latestUserText));

  if (shouldPreSearch) {
    try {
      usedWebSearch = true;
      searchQueries.push(latestUserText);
      if (typeof onWebSearchStart === "function") {
        try {
          await onWebSearchStart([latestUserText]);
        } catch {}
      }
      const preSearchResults = await executeOpenCodeWebSearch({
        query: latestUserText,
        numResults: 6,
      });
      if (preSearchResults && !preSearchResults.startsWith("No search results")) {
        for (let i = workingMessages.length - 1; i >= 0; i--) {
          if (workingMessages[i] && workingMessages[i].role === "user") {
            const orig = workingMessages[i].content;
            if (typeof orig === "string") {
              workingMessages[i] = {
                ...workingMessages[i],
                content:
                  `${orig}\n\n` +
                  `[Live OpenCode Web Search Results (Date: ${new Date().toISOString().slice(0, 10)}) — use these real-time facts to answer accurately and naturally]:\n` +
                  `${String(preSearchResults).slice(0, 8000)}`,
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
      messages: workingMessages,
    });

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        errorText: upstream.errorText,
        usedWebSearch,
        searchQueries,
      };
    }

    const assembled = await collectSSEStream(upstream.response, upstream.model);
    lastAssembled = assembled;

    // If model did not request any tool calls, or already produced final answer with no web tools, return!
    if (!assembled.toolCalls || assembled.toolCalls.length === 0) {
      return {
        ok: true,
        assembled,
        usedWebSearch,
        searchQueries,
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

    if (typeof onWebSearchStart === "function") {
      try {
        await onWebSearchStart(turnQueries);
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
          return { tool_call_id: tc.id, content: resultText };
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
              sendWsJson(socket, {
                clientContent: {
                  turns: [
                    {
                      role: "user",
                      parts: [
                        {
                          text: `Please read the following text aloud verbatim, word for word, in a smooth, sweet, warm, and natural voice without adding or changing any words:\n${finalSpoken}`,
                        },
                      ],
                    },
                  ],
                  turnComplete: true,
                },
              });
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
    "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "models/gemini-2.5-flash-native-audio-latest",
    "models/gemini-3.1-flash-live-preview",
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
            if (historyTurns.length > 0) {
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

      const defaultVoicePersona =
        systemPrompt ||
        `You are ${AI_NAME}, the fast, smart, warm real-time voice AI assistant inside the ${APP_NAME} app. ` +
          `When asked who you are or what your name is, say you are ${AI_NAME}, the voice AI of ${APP_NAME}. ` +
          `Speak naturally in the same language as the user (Hinglish, Hindi, or English) with a smooth, sweet, warm Indian conversational flow. ` +
          `WEB RESEARCH RULE: Whenever the user asks about live news, current prices/rates (Bitcoin, crypto, stocks, gold), weather, sports/IPL scores, 2025/2026 events, or asks you to search/check online, call the 'websearch' tool first and answer using the live OpenCode search results. ` +
          `IMPORTANT: Keep every reply to ONE short, natural spoken sentence (maximum 15 to 18 words) unless the user explicitly asks for a detailed explanation.`;

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
              : {}),
          },
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
}) {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error(
      "Server misconfiguration: GEMINI_API_KEY (Google AI Studio API Key) environment variable is not set."
    );
  }
  const selectedVoice = normalizeVoiceName(voice || GEMINI_TTS_VOICE || "Aoede");
  const liveModelsToTry = [
    GEMINI_VOICE_MODEL,
    "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "models/gemini-2.5-flash-native-audio-latest",
    "models/gemini-3.1-flash-live-preview",
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
      },
      endpoints: {
        textAndImageChat: "POST /api/chat",
        visionChat: "POST /api/vision",
        voiceAgent: "POST /api/voice",
        voiceFillerAudio: "GET /api/voice/filler",
        voicesCatalog: "GET /api/voices",
        webSearch: "POST /api/websearch",
        speechToText: "POST /api/stt",
        textToSpeech: "POST /api/tts",
        openAICompatible: "POST /v1/chat/completions",
        models: "GET /v1/models",
        health: "GET /api/health",
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

  // 6b. Standalone OpenCode Web Search Endpoint: POST /api/websearch
  if (req.method === "POST" && (pathname === "/api/websearch" || pathname === "/websearch")) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
    const query = String(body.query || body.q || body.message || "").trim();
    if (!query) {
      return sendJson(res, 400, {
        success: false,
        error: 'Please provide "query" (string) in the JSON body.',
      });
    }
    try {
      const resultsText = await executeOpenCodeWebSearch({
        query,
        numResults: body.numResults || 8,
        type: body.type || "auto",
      });
      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        query,
        results: resultsText,
      });
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Web search failed",
      });
    }
  }

  // 7. Vega App Normal Agent (Text-to-Text, Image + Text-to-Text & Live Web Search): POST /api/chat (or /api/vision)
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
      const disableReasoning = body.reasoning === true ? false : true;
      const allowWebSearch = body.webSearch !== false && body.allowWebSearch !== false;
      const forceWebSearch = body.webSearch === true || body.search === true;

      const agentResult = await runOpenCodeAgentWithTools({
        model: body.model || DEFAULT_MODEL,
        messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        disableReasoning,
        allowWebSearch,
        webSearch: forceWebSearch,
      });

      if (!agentResult.ok) {
        return sendJson(res, agentResult.status || 502, {
          success: false,
          error: "Upstream OpenCode API error",
          details: agentResult.errorText,
        });
      }

      const assembled = agentResult.assembled;

      if (body.stream === true) {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (agentResult.usedWebSearch) {
          res.write(
            `event: websearch\ndata: ${JSON.stringify({
              type: "websearch",
              usedWebSearch: true,
              searchQueries: agentResult.searchQueries,
            })}\n\n`
          );
        }
        const chunkPayload = {
          id: assembled.id,
          object: "chat.completion.chunk",
          created: assembled.created,
          model: assembled.model,
          usedWebSearch: agentResult.usedWebSearch,
          searchQueries: agentResult.searchQueries,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: assembled.content,
              },
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return sendJson(res, 200, {
        success: true,
        ai: AI_NAME,
        app: APP_NAME,
        model: assembled.model,
        usedWebSearch: agentResult.usedWebSearch,
        searchQueries: agentResult.searchQueries,
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
    const wantsStream = body.stream === true;
    const disableReasoning = body.reasoning === true ? false : true;
    const allowWebSearch = body.webSearch !== false && body.allowWebSearch !== false;
    const forceWebSearch = body.webSearch === true || body.search === true;

    try {
      const agentResult = await runOpenCodeAgentWithTools({
        model: body.model || DEFAULT_MODEL,
        messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        disableReasoning,
        allowWebSearch,
        webSearch: forceWebSearch,
      });

      if (!agentResult.ok) {
        return sendJson(res, agentResult.status || 502, {
          error: {
            message: agentResult.errorText,
            type: "upstream_error",
          },
        });
      }

      const assembled = agentResult.assembled;

      if (wantsStream) {
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunkPayload = {
          id: assembled.id,
          object: "chat.completion.chunk",
          created: assembled.created,
          model: assembled.model,
          usedWebSearch: agentResult.usedWebSearch,
          searchQueries: agentResult.searchQueries,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: assembled.content,
              },
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return sendJson(res, 200, {
        id: assembled.id,
        object: "chat.completion",
        created: assembled.created,
        model: assembled.model,
        usedWebSearch: agentResult.usedWebSearch,
        searchQueries: agentResult.searchQueries,
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
          kind: body.kind || "text",
          file_id: body.file_id,
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
        const msgData = {
          id: msgId,
          chat_id: chatId,
          user: userEmail,
          role: item.role === "ai" ? "ai" : "user",
          text: String(item.text || ""),
          at: msgAt,
          kind: item.kind === "voice" ? "voice" : "text",
          ...(item.kind === "voice" && item.file_id ? { file_id: item.file_id } : {}),
          ...(item.kind === "voice" && typeof item.duration_ms === "number"
            ? { duration_ms: Math.round(item.duration_ms) }
            : {}),
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
  console.log(`🎙️ Voice Pipeline:   ${GEMINI_STT_MODEL} (STT) -> ${DEFAULT_MODEL} [No-Reasoning Fast Mode] -> ${GEMINI_TTS_MODEL} (TTS)`);
  console.log(`====================================================`);
});
