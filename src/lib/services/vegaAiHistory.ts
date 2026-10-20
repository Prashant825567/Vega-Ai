/**
 * Per-user chat history data layer for Vega AI (`ai_chats` & `ai_messages`).
 *
 * Talks to the project's ZentraGrid-compatible storage backend
 * (`https://vega-storage.onrender.com`) via `src/lib/zentragrid/zentragridApi.ts`.
 *
 * Strictly uses ONLY `ai_chats`, `ai_messages`, and `/v1/files`.
 * Never touches support chat collections (`messages`, `presence`, `typing`).
 */

import {
  MAX_ZENTRAGRID_LIMIT,
  ZentraGridError,
  ZtAudioUploadInput,
  ZtDocument,
  ZtFileRecord,
  zentragridMediaSource,
  ztCreateDocument,
  ztDeleteDocument,
  ztListFiles,
  ztPatchDocument,
  ztQueryDocuments,
  ztUploadFile,
} from '../zentragrid/zentragridApi';

export {zentragridMediaSource};

export const AI_CHATS_COLLECTION = 'ai_chats';
export const AI_MESSAGES_COLLECTION = 'ai_messages';

export type DevicePlatform = 'android' | 'ios' | 'web';
export type AiMessageRole = 'user' | 'ai';
export type AiMessageKind = 'text' | 'voice' | 'image';

/**
 * Exact `ai_chats` document shape (§2).
 */
export type AiChatRecord = {
  /** Deterministic: `ai_chat_<emailSlug>_<createdAtMs>` */
  id: string;
  /** Signed-in email, LOWERCASE */
  user: string;
  /** First user message trimmed to ~60 chars ("New chat" until it exists) */
  title: string;
  /** ISO 8601 UTC */
  created_at: string;
  /** ISO 8601 UTC; the list sorts by `updated_at` desc */
  updated_at: string;
  /** Total messages in the chat (both roles) — also the seq counter (§3) */
  turns: number;
  /** Preview of the last message, <= 120 chars */
  last_text: string;
  /** `android` / `ios` / `web` */
  device: DevicePlatform;
};

/**
 * Exact `ai_messages` document shape (§2).
 */
export type AiMessageRecord = {
  /** Deterministic: `ai_msg_<chatId>_<seq>` (seq = zero-padded 4-digit 0001...) */
  id: string;
  /** The chat document's id */
  chat_id: string;
  /** Same lowercase email */
  user: string;
  /** `user` or `ai` */
  role: AiMessageRole;
  /** The transcript (what was said / what the AI spoke) */
  text: string;
  /** ISO 8601 UTC — ascending IS the chat order */
  at: string;
  /** `text`, `voice`, or `image` */
  kind: AiMessageKind;
  /** Voice or Image: ZentraGrid file id (`/v1/files/{file_id}/download`) */
  file_id?: string;
  /** Voice only: length of the clip in milliseconds */
  duration_ms?: number;
  /** Image only: deterministic/hosted image ID (`img_<fileId>.jpg`) */
  image_id?: string;
  /** Image only: permanent view URL (`https://vega-ai-6m2k.onrender.com/api/image/view/img_<fileId>.jpg`) */
  image_url?: string;
  /** Image only: enhanced visual director prompt crafted by DeepSeek */
  max_prompt?: string;
  /** Image only: `generate` or `edit` */
  image_action?: 'generate' | 'edit';
  /** Image only: width in pixels */
  width?: number;
  /** Image only: height in pixels */
  height?: number;
  /** Optional LLM reasoning/thinking trace */
  thinking?: string;
};

export type SingleTurnInput = {
  role: AiMessageRole;
  text: string;
  kind?: AiMessageKind;
  at?: string | number;
  file_id?: string;
  duration_ms?: number;
  /** Optional raw audio to upload to `/v1/files` before saving the turn */
  audio?: ZtAudioUploadInput;
  audioFilename?: string;
  audioMimeType?: string;
  /** Optional generated/edited image fields or raw image to upload to `/v1/files` */
  image?: ZtAudioUploadInput;
  imageFilename?: string;
  imageMimeType?: string;
  image_id?: string;
  image_url?: string;
  max_prompt?: string;
  image_action?: 'generate' | 'edit';
  width?: number;
  height?: number;
  thinking?: string;
  /**
   * Optional explicit sequence number (1-based) or idempotency key so a
   * double-tap send or retried call maps to the exact same deterministic ID.
   */
  seq?: number;
  dedupeKey?: string;
};

export type PairedTurnInput = {
  user: Omit<SingleTurnInput, 'role'> & {role?: 'user'};
  ai:
    | (Omit<SingleTurnInput, 'role'> & {role?: 'ai'})
    | Promise<Omit<SingleTurnInput, 'role'> & {role?: 'ai'}>;
  createdAtMs?: number;
};

export type AppendTurnInput = SingleTurnInput | PairedTurnInput;

export type AppendTurnResult = {
  chatId: string;
  chat: AiChatRecord;
  userMessage?: AiMessageRecord;
  aiMessage?: AiMessageRecord;
  message?: AiMessageRecord;
};

export type ListChatsOptions = {
  limit?: number;
  cursor?: string | null;
  /** Called immediately with cached rows before the network finishes (§6) */
  onCached?: (cachedChats: AiChatRecord[]) => void;
};

export type ListChatsResult = {
  chats: AiChatRecord[];
  nextCursor: string | null;
  fromCache: boolean;
};

export type OpenChatOptions = {
  limit?: number;
  cursor?: string | null;
  /** Called immediately with cached turns before the network finishes (§6) */
  onCached?: (cached: {
    chat: AiChatRecord | null;
    messages: AiMessageRecord[];
  }) => void;
};

export type OpenChatResult = {
  chat: AiChatRecord;
  messages: AiMessageRecord[];
  nextCursor: string | null;
  fromCache: boolean;
};

// ─── Pluggable Local Storage Adapter (MMKV / AsyncStorage / localStorage) ───

export interface KeyValueStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

const memoryStorage = new Map<string, string>();

let storageAdapter: KeyValueStorageAdapter = {
  getItem(key: string): string | null {
    if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      globalThis.localStorage
    ) {
      try {
        return globalThis.localStorage.getItem(key);
      } catch {}
    }
    return memoryStorage.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memoryStorage.set(key, value);
    if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      globalThis.localStorage
    ) {
      try {
        globalThis.localStorage.setItem(key, value);
      } catch {}
    }
  },
  removeItem(key: string): void {
    memoryStorage.delete(key);
    if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      globalThis.localStorage
    ) {
      try {
        globalThis.localStorage.removeItem(key);
      } catch {}
    }
  },
};

export function configureHistoryStorageAdapter(
  adapter: KeyValueStorageAdapter,
): void {
  storageAdapter = adapter;
}

// ─── Identity & Deterministic ID Helpers (§2, §3) ────────────────────────────

const GUEST_USER_KEY = '__guest__';

let currentSignedInEmail: string | null = null;
let currentDevice: DevicePlatform = detectDefaultDevice();
let activeOpenChatId: string | null = null;

function detectDefaultDevice(): DevicePlatform {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as {product?: string; userAgent?: string})
      : undefined;
  const ua = (nav?.userAgent || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) {
    return 'ios';
  }
  return 'web';
}

export function normalizeEmail(email: string | null | undefined): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/**
 * Deterministic email slug for `ai_chat_<emailSlug>_<createdAtMs>`.
 * Keeps only lowercase ASCII letters, digits, and single underscores so the id
 * satisfies ZentraGrid's `valid_doc_id` rule (`letters, digits and ._:@+-`, max 128 chars).
 */
export function emailToSlug(email: string): string {
  const lower = normalizeEmail(email) || 'guest';
  const slug = lower
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug || 'user';
}

/**
 * Zero-padded 4-digit turn sequence number (`0001`, `0002`, ...).
 */
export function formatTurnSeq(seq: number): string {
  const n = Math.max(1, Math.floor(Number(seq) || 1));
  return String(n).padStart(4, '0');
}

/**
 * Deterministic chat document ID: `ai_chat_<emailSlug>_<createdAtMs>` (§2, §3).
 */
export function buildAiChatId(email: string, createdAtMs: number): string {
  const ts = Math.floor(Number(createdAtMs) || Date.now());
  return `ai_chat_${emailToSlug(email)}_${ts}`;
}

/**
 * Deterministic message document ID: `ai_msg_<chatId>_<seq>` (§2, §3).
 */
export function buildAiMessageId(chatId: string, seq: number): string {
  return `ai_msg_${chatId}_${formatTurnSeq(seq)}`;
}

/**
 * Trims the first user message to ~60 chars for `ai_chats.title` (§2).
 */
export function formatChatTitle(firstUserText: string): string {
  const cleaned = String(firstUserText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New chat';
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57).trimEnd()}...`;
}

/**
 * Trims a message preview to <= 120 chars for `ai_chats.last_text` (§2).
 */
export function formatLastTextPreview(text: string): string {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117).trimEnd()}...`;
}

function toIsoUtc(input?: string | number): string {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return new Date(input).toISOString();
  }
  if (typeof input === 'string' && input.trim()) {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

// ─── Local Cache & Persistent Write Queue State (§5, §6) ─────────────────────

type QueuedWriteTask =
  | {
      opId: string;
      chatId: string;
      user: string;
      kind: 'create_chat';
      chat: AiChatRecord;
    }
  | {
      opId: string;
      chatId: string;
      user: string;
      kind: 'create_message';
      message: AiMessageRecord;
      pendingAudio?: {
        base64?: string;
        uri?: string;
        name?: string;
        mimeType?: string;
      };
      pendingImage?: {
        base64?: string;
        uri?: string;
        name?: string;
        mimeType?: string;
      };
    }
  | {
      opId: string;
      chatId: string;
      user: string;
      kind: 'patch_chat';
      patch: Partial<AiChatRecord>;
    }
  | {
      opId: string;
      chatId: string;
      user: string;
      kind: 'delete_chat';
      messageIds: string[];
    };

type UserCacheBucket = {
  chats: Record<string, AiChatRecord>;
  messagesByChat: Record<string, Record<string, AiMessageRecord>>;
  queueByChat: Record<string, QueuedWriteTask[]>;
  migratedToUser?: string | null;
};

const inMemoryBuckets = new Map<string, UserCacheBucket>();
const inFlightChatLoops = new Map<string, Promise<void>>();
const dedupeKeyToMessageId = new Map<string, string>();
let lastCreatedAtMs = 0;

function nextUniqueTimestampMs(preferredMs?: number): number {
  const now = typeof preferredMs === 'number' ? Math.floor(preferredMs) : Date.now();
  if (now <= lastCreatedAtMs) {
    lastCreatedAtMs += 1;
    return lastCreatedAtMs;
  }
  lastCreatedAtMs = now;
  return now;
}

function storageKeyForScope(scopeUser: string): string {
  return `vega_ai_history_v1::${scopeUser}`;
}

function currentScopeUser(): string {
  return currentSignedInEmail || GUEST_USER_KEY;
}

async function loadBucket(scopeUser: string): Promise<UserCacheBucket> {
  const existing = inMemoryBuckets.get(scopeUser);
  if (existing) return existing;

  const empty: UserCacheBucket = {
    chats: {},
    messagesByChat: {},
    queueByChat: {},
    migratedToUser: null,
  };

  try {
    const raw = await storageAdapter.getItem(storageKeyForScope(scopeUser));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserCacheBucket>;
      const hydrated: UserCacheBucket = {
        chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
        messagesByChat:
          parsed.messagesByChat && typeof parsed.messagesByChat === 'object'
            ? parsed.messagesByChat
            : {},
        queueByChat:
          parsed.queueByChat && typeof parsed.queueByChat === 'object'
            ? parsed.queueByChat
            : {},
        migratedToUser: parsed.migratedToUser ?? null,
      };
      inMemoryBuckets.set(scopeUser, hydrated);
      return hydrated;
    }
  } catch {
    // Fall back to empty in-memory bucket
  }

  inMemoryBuckets.set(scopeUser, empty);
  return empty;
}

async function saveBucket(scopeUser: string): Promise<void> {
  const bucket = inMemoryBuckets.get(scopeUser);
  if (!bucket) return;
  try {
    await storageAdapter.setItem(
      storageKeyForScope(scopeUser),
      JSON.stringify(bucket),
    );
  } catch {
    // Storage persistence errors must never block the chat
  }
}

function sortChatsDesc(chats: AiChatRecord[]): AiChatRecord[] {
  return [...chats].sort((a, b) => {
    const cmp = String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    if (cmp !== 0) return cmp;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
}

function parseSeqFromMessageId(id: string): number {
  const m = String(id || '').match(/_(\d{4,})$/);
  return m ? Number(m[1]) : 0;
}

function sortMessagesAsc(messages: AiMessageRecord[]): AiMessageRecord[] {
  return [...messages].sort((a, b) => {
    const seqA = parseSeqFromMessageId(a.id);
    const seqB = parseSeqFromMessageId(b.id);
    const cmpAt = String(a.at || '').localeCompare(String(b.at || ''));
    if (cmpAt !== 0) return cmpAt;
    if (seqA !== seqB) return seqA - seqB;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// ─── Per-Chat Sequential Write Queue (§6: At most ONE write in flight per chat) ─

let networkPausedForTest = false;

/**
 * Helper for testing offline/airplane-mode behavior (§6, §7).
 */
export function setOfflineMode(offline: boolean): void {
  networkPausedForTest = offline;
  if (!offline && currentSignedInEmail) {
    void flushPendingWrites();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueueChatTasks(
  scopeUser: string,
  chatId: string,
  tasks: QueuedWriteTask[],
): Promise<void> {
  if (scopeUser === GUEST_USER_KEY) {
    // §5: Before sign-in, NOTHING goes to the server.
    return;
  }

  const bucket = await loadBucket(scopeUser);
  const list = bucket.queueByChat[chatId] || [];

  for (const task of tasks) {
    // Deduplicate identical opId in queue
    if (!list.some((existing) => existing.opId === task.opId)) {
      list.push(task);
    }
  }
  bucket.queueByChat[chatId] = list;
  await saveBucket(scopeUser);

  void processChatQueue(scopeUser, chatId);
}

async function executeSingleTask(task: QueuedWriteTask): Promise<void> {
  if (networkPausedForTest) {
    throw new ZentraGridError('Offline mode active', 502, 'OFFLINE');
  }

  if (task.kind === 'create_chat') {
    await ztCreateDocument(
      AI_CHATS_COLLECTION,
      task.chat.id,
      task.chat,
      true, // 409 DOCUMENT_ALREADY_EXISTS = success (§3)
    );
    return;
  }

  if (task.kind === 'create_message') {
    const msg: AiMessageRecord = {...task.message};

    // §2: Never store raw audio/image bytes inside a document: upload to /v1/files first and keep the id.
    if (msg.kind === 'voice' && !msg.file_id && task.pendingAudio) {
      const uploaded = await ztUploadFile(
        task.pendingAudio,
        task.pendingAudio.name || `${msg.id}.wav`,
        task.pendingAudio.mimeType || 'audio/wav',
        {owner: task.user, parentId: task.chatId},
      );
      msg.file_id = uploaded.id;
      task.message.file_id = uploaded.id;
      delete task.pendingAudio;

      // Update cached message with the resolved file_id
      const bucket = await loadBucket(task.user);
      if (bucket.messagesByChat[task.chatId]?.[msg.id]) {
        bucket.messagesByChat[task.chatId][msg.id].file_id = uploaded.id;
        await saveBucket(task.user);
      }
    }

    if (msg.kind === 'image' && !msg.file_id && task.pendingImage) {
      const uploaded = await ztUploadFile(
        task.pendingImage,
        task.pendingImage.name || `${msg.id}.jpg`,
        task.pendingImage.mimeType || 'image/jpeg',
        {owner: task.user, parentId: task.chatId},
      );
      msg.file_id = uploaded.id;
      msg.image_id = msg.image_id || `img_${uploaded.id}.jpg`;
      msg.image_url =
        msg.image_url ||
        `https://vega-ai-6m2k.onrender.com/api/image/view/${msg.image_id}`;
      task.message.file_id = uploaded.id;
      task.message.image_id = msg.image_id;
      task.message.image_url = msg.image_url;
      delete task.pendingImage;

      const bucket = await loadBucket(task.user);
      if (bucket.messagesByChat[task.chatId]?.[msg.id]) {
        bucket.messagesByChat[task.chatId][msg.id].file_id = uploaded.id;
        bucket.messagesByChat[task.chatId][msg.id].image_id = msg.image_id;
        bucket.messagesByChat[task.chatId][msg.id].image_url = msg.image_url;
        await saveBucket(task.user);
      }
    }

    const payload: Record<string, unknown> = {
      id: msg.id,
      chat_id: msg.chat_id,
      user: msg.user,
      role: msg.role,
      text: msg.text,
      at: msg.at,
      kind: msg.kind,
    };
    if (msg.kind === 'voice') {
      if (msg.file_id) payload.file_id = msg.file_id;
      if (typeof msg.duration_ms === 'number') {
        payload.duration_ms = msg.duration_ms;
      }
    }
    if (msg.kind === 'image') {
      if (msg.file_id) payload.file_id = msg.file_id;
      if (msg.image_id) payload.image_id = msg.image_id;
      if (msg.image_url) payload.image_url = msg.image_url;
      if (msg.max_prompt) payload.max_prompt = msg.max_prompt;
      if (msg.image_action) payload.image_action = msg.image_action;
      if (typeof msg.width === 'number') payload.width = msg.width;
      if (typeof msg.height === 'number') payload.height = msg.height;
    }
    if (msg.thinking) {
      payload.thinking = String(msg.thinking).slice(0, 4000);
    }

    await ztCreateDocument(
      AI_MESSAGES_COLLECTION,
      msg.id,
      payload,
      true, // 409 DOCUMENT_ALREADY_EXISTS = success (§3)
    );
    return;
  }

  if (task.kind === 'patch_chat') {
    try {
      await ztPatchDocument(AI_CHATS_COLLECTION, task.chatId, task.patch);
    } catch (err) {
      // If chat doc wasn't created yet due to out-of-band state, create it first
      if (err instanceof ZentraGridError && err.status === 404) {
        const bucket = await loadBucket(task.user);
        const cachedChat = bucket.chats[task.chatId];
        if (cachedChat) {
          await ztCreateDocument(
            AI_CHATS_COLLECTION,
            cachedChat.id,
            {...cachedChat, ...task.patch},
            true,
          );
          return;
        }
      }
      throw err;
    }
    return;
  }

  if (task.kind === 'delete_chat') {
    for (const msgId of task.messageIds) {
      await ztDeleteDocument(AI_MESSAGES_COLLECTION, msgId);
    }
    await ztDeleteDocument(AI_CHATS_COLLECTION, task.chatId);
  }
}

function processChatQueue(scopeUser: string, chatId: string): Promise<void> {
  const lockKey = `${scopeUser}::${chatId}`;
  const existingLoop = inFlightChatLoops.get(lockKey);
  if (existingLoop) {
    return existingLoop;
  }

  const loopPromise = (async () => {
    const bucket = await loadBucket(scopeUser);
    let attempt = 0;

    while ((bucket.queueByChat[chatId]?.length || 0) > 0) {
      if (networkPausedForTest) break;

      const headTask = bucket.queueByChat[chatId][0];
      try {
        await executeSingleTask(headTask);
        // Success: pop from queue and persist
        bucket.queueByChat[chatId].shift();
        if (bucket.queueByChat[chatId].length === 0) {
          delete bucket.queueByChat[chatId];
        }
        attempt = 0;
        await saveBucket(scopeUser);
      } catch (err) {
        attempt += 1;
        // Do not infinitely retry permanent 4xx errors (except 409/404/429)
        if (
          err instanceof ZentraGridError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 429 &&
          err.status !== 409 &&
          err.status !== 404
        ) {
          // Keep in queue if 401 so key fix can flush later, otherwise pause loop
          break;
        }

        // §6: 429 -> wait what it says (Retry-After), then retry the SAME id
        let waitMs = Math.min(8_000, 250 * Math.pow(2, Math.min(attempt, 5)));
        if (
          err instanceof ZentraGridError &&
          err.status === 429 &&
          err.retryAfterMs
        ) {
          waitMs = err.retryAfterMs;
        }

        if (networkPausedForTest || attempt >= 4) {
          // Leave in persistent queue for next flush / online recovery
          break;
        }
        await sleep(waitMs);
      }
    }
  })().finally(() => {
    inFlightChatLoops.delete(lockKey);
  });

  inFlightChatLoops.set(lockKey, loopPromise);
  return loopPromise;
}

/**
 * Waits for all queued writes (for one chat or all chats of the current user)
 * to finish syncing with the storage backend.
 */
export async function flushPendingWrites(chatId?: string): Promise<void> {
  const scopeUser = currentScopeUser();
  if (scopeUser === GUEST_USER_KEY) return;

  const bucket = await loadBucket(scopeUser);
  const chatIds = chatId ? [chatId] : Object.keys(bucket.queueByChat);

  for (const id of chatIds) {
    if ((bucket.queueByChat[id]?.length || 0) > 0) {
      await processChatQueue(scopeUser, id);
    }
  }
}

// ─── §5: Guests, Sign-In, and One-Time Idempotent Migration ──────────────────

export function getSignedInUser(): string | null {
  return currentSignedInEmail;
}

export function getActiveOpenChatId(): string | null {
  return activeOpenChatId;
}

/**
 * Sets the currently signed-in user email (lowercase) or `null` when signed out.
 * When transitioning from guest to a signed-in email, automatically triggers
 * the one-time guest history migration (§5).
 */
export async function setSignedInUser(
  email: string | null,
  device?: DevicePlatform,
): Promise<void> {
  if (device) {
    currentDevice = device;
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    currentSignedInEmail = null;
    activeOpenChatId = null;
    return;
  }

  currentSignedInEmail = normalized;
  await migrateGuestHistoryOnSignIn(normalized);
}

/**
 * §5: The moment the user signs in, upload the local guest chats once:
 * create every chat + message with the SAME deterministic ids derived for the
 * user. A 409 means the store already has it — skip it. Then mark the local
 * copy as migrated. Safe to run twice (idempotent).
 */
export async function migrateGuestHistoryOnSignIn(
  email: string,
): Promise<{migratedChats: number; migratedMessages: number}> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('migrateGuestHistoryOnSignIn requires a valid user email');
  }

  currentSignedInEmail = normalizedEmail;
  const guestBucket = await loadBucket(GUEST_USER_KEY);
  const userBucket = await loadBucket(normalizedEmail);

  const guestChats = Object.values(guestBucket.chats);
  if (guestChats.length === 0) {
    guestBucket.migratedToUser = normalizedEmail;
    await saveBucket(GUEST_USER_KEY);
    return {migratedChats: 0, migratedMessages: 0};
  }

  let migratedChats = 0;
  let migratedMessages = 0;

  for (const guestChat of guestChats) {
    // Extract deterministic creation timestamp from guest chat id or created_at
    const tsMatch = String(guestChat.id).match(/_(\d{10,})$/);
    const createdAtMs = tsMatch
      ? Number(tsMatch[1])
      : Date.parse(guestChat.created_at) || Date.now();

    const deterministicChatId = buildAiChatId(normalizedEmail, createdAtMs);
    const guestMsgsMap = guestBucket.messagesByChat[guestChat.id] || {};
    const sortedGuestMsgs = sortMessagesAsc(Object.values(guestMsgsMap));

    const migratedChatRecord: AiChatRecord = {
      ...guestChat,
      id: deterministicChatId,
      user: normalizedEmail,
      turns: sortedGuestMsgs.length || guestChat.turns,
      device: guestChat.device || currentDevice,
    };

    userBucket.chats[deterministicChatId] = migratedChatRecord;
    if (!userBucket.messagesByChat[deterministicChatId]) {
      userBucket.messagesByChat[deterministicChatId] = {};
    }

    const tasks: QueuedWriteTask[] = [
      {
        opId: `mig_chat_${deterministicChatId}`,
        chatId: deterministicChatId,
        user: normalizedEmail,
        kind: 'create_chat',
        chat: migratedChatRecord,
      },
    ];

    sortedGuestMsgs.forEach((gMsg, idx) => {
      const seq = parseSeqFromMessageId(gMsg.id) || idx + 1;
      const deterministicMsgId = buildAiMessageId(deterministicChatId, seq);
      const migratedMsg: AiMessageRecord = {
        ...gMsg,
        id: deterministicMsgId,
        chat_id: deterministicChatId,
        user: normalizedEmail,
      };
      userBucket.messagesByChat[deterministicChatId][deterministicMsgId] =
        migratedMsg;

      tasks.push({
        opId: `mig_msg_${deterministicMsgId}`,
        chatId: deterministicChatId,
        user: normalizedEmail,
        kind: 'create_message',
        message: migratedMsg,
      });
      migratedMessages += 1;
    });

    if (activeOpenChatId === guestChat.id) {
      activeOpenChatId = deterministicChatId;
    }

    migratedChats += 1;
    await enqueueChatTasks(normalizedEmail, deterministicChatId, tasks);
  }

  await saveBucket(normalizedEmail);
  await flushPendingWrites();

  // Mark guest bucket as migrated and clear guest rows so re-running migration is a no-op
  guestBucket.chats = {};
  guestBucket.messagesByChat = {};
  guestBucket.queueByChat = {};
  guestBucket.migratedToUser = normalizedEmail;
  await saveBucket(GUEST_USER_KEY);

  return {migratedChats, migratedMessages};
}

// ─── §0 & §4: Core Public Data Layer Functions ───────────────────────────────

function assertAccountScope(recordUser: string): void {
  if (!currentSignedInEmail) return;
  if (normalizeEmail(recordUser) !== currentSignedInEmail) {
    throw new Error(
      'Access denied: chat/message belongs to a different account session.',
    );
  }
}

/**
 * 1) `listChats(options?)`
 *
 * - Paints from local cache first (`options.onCached`),
 * - For signed-in users, queries:
 *   `GET /v1/data/ai_chats?where=user:eq:<lower email>&order_by=updated_at:desc&limit=50`
 *   (or pages with `cursor`),
 * - Reconciles server rows with local cache and returns sorted chats.
 */
export async function listChats(
  options: ListChatsOptions = {},
): Promise<ListChatsResult> {
  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);

  const cachedList = sortChatsDesc(
    Object.values(bucket.chats).filter((c) => c.user === scopeUser),
  );

  if (typeof options.onCached === 'function') {
    try {
      options.onCached(cachedList);
    } catch {}
  }

  // §5: Guest mode never calls the server
  if (scopeUser === GUEST_USER_KEY || networkPausedForTest) {
    return {
      chats: cachedList,
      nextCursor: null,
      fromCache: true,
    };
  }

  const pageLimit = Math.min(
    MAX_ZENTRAGRID_LIMIT,
    Math.max(1, options.limit ?? 50),
  );

  try {
    const page = await ztQueryDocuments<AiChatRecord>(AI_CHATS_COLLECTION, {
      where: [['user', 'eq', scopeUser]],
      orderBy: 'updated_at:desc',
      limit: pageLimit,
      cursor: options.cursor || undefined,
    });

    const serverChats: AiChatRecord[] = [];
    for (const doc of page.documents) {
      const chatData = doc.data || ({} as AiChatRecord);
      if (normalizeEmail(chatData.user) !== scopeUser) continue;

      const normalized: AiChatRecord = {
        id: doc.id || chatData.id,
        user: normalizeEmail(chatData.user),
        title: chatData.title || 'New chat',
        created_at: chatData.created_at || doc.created_at || toIsoUtc(),
        updated_at: chatData.updated_at || doc.updated_at || toIsoUtc(),
        turns: Number(chatData.turns) || 0,
        last_text: chatData.last_text || '',
        device: chatData.device || 'web',
      };

      // If we have in-flight queued writes for this chat with a higher turn count, preserve local state
      const localExisting = bucket.chats[normalized.id];
      const hasPendingQueue = (bucket.queueByChat[normalized.id]?.length || 0) > 0;
      if (
        hasPendingQueue &&
        localExisting &&
        localExisting.turns >= normalized.turns
      ) {
        serverChats.push(localExisting);
      } else {
        bucket.chats[normalized.id] = normalized;
        serverChats.push(normalized);
      }
    }

    // Include any newly created local chats that are still queued for their first write
    if (!options.cursor) {
      for (const localChat of Object.values(bucket.chats)) {
        if (
          localChat.user === scopeUser &&
          (bucket.queueByChat[localChat.id]?.length || 0) > 0 &&
          !serverChats.some((s) => s.id === localChat.id)
        ) {
          serverChats.push(localChat);
        }
      }
    }

    await saveBucket(scopeUser);

    return {
      chats: sortChatsDesc(serverChats),
      nextCursor: page.nextCursor,
      fromCache: false,
    };
  } catch {
    // §6: Offline / network failure falls back to local cache seamlessly
    return {
      chats: cachedList,
      nextCursor: null,
      fromCache: true,
    };
  }
}

/**
 * 2) `openChat(id, options?)`
 *
 * - Paints from local cache first (`options.onCached`),
 * - Queries `GET /v1/data/ai_messages?where=chat_id:eq:<id>&order_by=at&limit=200`
 *   (pages older/additional messages with `cursor`),
 * - Renders ascending (`at` ascending),
 * - Keeps `id` as the active open chat so the next turn appends to the SAME chat
 *   with the next `seq` (§4).
 */
export async function openChat(
  id: string,
  options: OpenChatOptions = {},
): Promise<OpenChatResult> {
  const cleanChatId = String(id || '').trim();
  if (!cleanChatId) {
    throw new Error('openChat requires a non-empty chat id');
  }

  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);

  const cachedChat = bucket.chats[cleanChatId] || null;
  if (cachedChat) {
    assertAccountScope(cachedChat.user);
  }

  const cachedMessages = sortMessagesAsc(
    Object.values(bucket.messagesByChat[cleanChatId] || {}).filter(
      (m) => m.user === scopeUser,
    ),
  );

  if (typeof options.onCached === 'function') {
    try {
      options.onCached({chat: cachedChat, messages: cachedMessages});
    } catch {}
  }

  activeOpenChatId = cleanChatId;

  if (scopeUser === GUEST_USER_KEY || networkPausedForTest) {
    if (!cachedChat) {
      throw new Error(`Chat ${cleanChatId} not found in local cache`);
    }
    return {
      chat: cachedChat,
      messages: cachedMessages,
      nextCursor: null,
      fromCache: true,
    };
  }

  try {
    // Ensure we also have the latest chat metadata from the server
    let resolvedChat = cachedChat;
    const chatPage = await ztQueryDocuments<AiChatRecord>(AI_CHATS_COLLECTION, {
      where: [['user', 'eq', scopeUser]],
      orderBy: 'updated_at:desc',
      limit: MAX_ZENTRAGRID_LIMIT,
    });
    const matchingDoc = chatPage.documents.find((d) => d.id === cleanChatId);
    if (matchingDoc && matchingDoc.data) {
      assertAccountScope(matchingDoc.data.user);
      resolvedChat = {
        id: matchingDoc.id,
        user: normalizeEmail(matchingDoc.data.user),
        title: matchingDoc.data.title || 'New chat',
        created_at:
          matchingDoc.data.created_at || matchingDoc.created_at || toIsoUtc(),
        updated_at:
          matchingDoc.data.updated_at || matchingDoc.updated_at || toIsoUtc(),
        turns: Number(matchingDoc.data.turns) || 0,
        last_text: matchingDoc.data.last_text || '',
        device: matchingDoc.data.device || 'web',
      };
    }

    if (!resolvedChat) {
      throw new ZentraGridError(
        `Chat ${cleanChatId} not found for user ${scopeUser}`,
        404,
        'NOT_FOUND',
      );
    }

    assertAccountScope(resolvedChat.user);

    const pageLimit = Math.min(
      MAX_ZENTRAGRID_LIMIT,
      Math.max(1, options.limit ?? MAX_ZENTRAGRID_LIMIT),
    );

    const msgPage = await ztQueryDocuments<AiMessageRecord>(
      AI_MESSAGES_COLLECTION,
      {
        where: [
          ['chat_id', 'eq', cleanChatId],
          ['user', 'eq', scopeUser],
        ],
        orderBy: 'at',
        limit: pageLimit,
        cursor: options.cursor || undefined,
      },
    );

    if (!bucket.messagesByChat[cleanChatId]) {
      bucket.messagesByChat[cleanChatId] = {};
    }

    for (const doc of msgPage.documents) {
      const mData = doc.data || ({} as AiMessageRecord);
      if (normalizeEmail(mData.user) !== scopeUser) continue;
      const resolvedKind: AiMessageKind =
        mData.kind === 'voice'
          ? 'voice'
          : mData.kind === 'image' ||
            Boolean(mData.image_url) ||
            Boolean(mData.max_prompt)
          ? 'image'
          : 'text';
      const msgRecord: AiMessageRecord = {
        id: doc.id || mData.id,
        chat_id: mData.chat_id || cleanChatId,
        user: normalizeEmail(mData.user),
        role: mData.role === 'ai' ? 'ai' : 'user',
        text: String(mData.text ?? ''),
        at: mData.at || doc.created_at || toIsoUtc(),
        kind: resolvedKind,
        ...(mData.file_id ? {file_id: mData.file_id} : {}),
        ...(typeof mData.duration_ms === 'number'
          ? {duration_ms: mData.duration_ms}
          : {}),
        ...(mData.image_id ? {image_id: mData.image_id} : {}),
        ...(mData.image_url
          ? {image_url: mData.image_url}
          : resolvedKind === 'image' && mData.file_id
          ? {
              image_url: `https://vega-ai-6m2k.onrender.com/api/image/view/img_${mData.file_id}.jpg`,
            }
          : {}),
        ...(mData.max_prompt ? {max_prompt: mData.max_prompt} : {}),
        ...(mData.image_action ? {image_action: mData.image_action} : {}),
        ...(typeof mData.width === 'number' ? {width: mData.width} : {}),
        ...(typeof mData.height === 'number' ? {height: mData.height} : {}),
        ...(mData.thinking ? {thinking: mData.thinking} : {}),
      };
      bucket.messagesByChat[cleanChatId][msgRecord.id] = msgRecord;
    }

    const allMessages = sortMessagesAsc(
      Object.values(bucket.messagesByChat[cleanChatId]).filter(
        (m) => m.user === scopeUser,
      ),
    );

    // Reconcile turns counter so resumed chat always increments from true max seq
    const maxSeq = allMessages.reduce(
      (max, m) => Math.max(max, parseSeqFromMessageId(m.id)),
      0,
    );
    if (maxSeq > resolvedChat.turns) {
      resolvedChat = {...resolvedChat, turns: maxSeq};
    }

    bucket.chats[cleanChatId] = resolvedChat;
    await saveBucket(scopeUser);

    return {
      chat: resolvedChat,
      messages: allMessages,
      nextCursor: msgPage.nextCursor,
      fromCache: false,
    };
  } catch (err) {
    if (err instanceof ZentraGridError && err.status === 404 && !cachedChat) {
      throw err;
    }
    if (cachedChat) {
      return {
        chat: cachedChat,
        messages: cachedMessages,
        nextCursor: null,
        fromCache: true,
      };
    }
    throw err;
  }
}

function isPairedTurn(input: AppendTurnInput): input is PairedTurnInput {
  return (
    Boolean(input) &&
    typeof input === 'object' &&
    'user' in input &&
    'ai' in input
  );
}

function extractPendingAudio(input: SingleTurnInput):
  | {
      base64?: string;
      uri?: string;
      name?: string;
      mimeType?: string;
    }
  | undefined {
  if (!input.audio) return undefined;
  if (
    typeof input.audio === 'object' &&
    !(input.audio instanceof Uint8Array) &&
    !(input.audio instanceof ArrayBuffer) &&
    !(typeof Blob !== 'undefined' && input.audio instanceof Blob)
  ) {
    return {
      base64: input.audio.base64,
      uri: input.audio.uri,
      name: input.audio.name || input.audioFilename,
      mimeType: input.audio.mimeType || input.audioMimeType,
    };
  }
  if (input.audio instanceof Uint8Array || input.audio instanceof ArrayBuffer) {
    const bytes =
      input.audio instanceof Uint8Array
        ? input.audio
        : new Uint8Array(input.audio);
    const b64 =
      typeof Buffer !== 'undefined'
        ? Buffer.from(bytes).toString('base64')
        : btoa(String.fromCharCode(...bytes));
    return {
      base64: b64,
      name: input.audioFilename || 'voice.wav',
      mimeType: input.audioMimeType || 'audio/wav',
    };
  }
  return undefined;
}

function extractPendingImage(input: SingleTurnInput):
  | {
      base64?: string;
      uri?: string;
      name?: string;
      mimeType?: string;
    }
  | undefined {
  if (!input.image) return undefined;
  if (
    typeof input.image === 'object' &&
    !(input.image instanceof Uint8Array) &&
    !(input.image instanceof ArrayBuffer) &&
    !(typeof Blob !== 'undefined' && input.image instanceof Blob)
  ) {
    return {
      base64: input.image.base64,
      uri: input.image.uri,
      name: input.image.name || input.imageFilename || 'generated_image.jpg',
      mimeType: input.image.mimeType || input.imageMimeType || 'image/jpeg',
    };
  }
  if (input.image instanceof Uint8Array || input.image instanceof ArrayBuffer) {
    const bytes =
      input.image instanceof Uint8Array
        ? input.image
        : new Uint8Array(input.image);
    const b64 =
      typeof Buffer !== 'undefined'
        ? Buffer.from(bytes).toString('base64')
        : btoa(String.fromCharCode(...bytes));
    return {
      base64: b64,
      name: input.imageFilename || 'generated_image.jpg',
      mimeType: input.imageMimeType || 'image/jpeg',
    };
  }
  return undefined;
}

/**
 * 3) `appendTurn(chatId, turn)`
 *
 * Supports both:
 * - Single-message turns (`{ role: 'user' | 'ai', text, kind, ... }`) so the caller
 *   can POST the user message immediately before waiting for the AI, and then call
 *   `appendTurn(chatId, { role: 'ai', ... })` when the AI reply completes; AND
 * - Paired turns (`{ user: {...}, ai: {...} | Promise<{...}> }`) which POST the
 *   user message immediately, await the AI reply, POST the AI message, and PATCH
 *   the chat document once per turn (§4).
 *
 * Pass `chatId = null` (or `""`) on the first user turn of a new conversation:
 * the chat document is created deterministically on the FIRST user turn — never
 * as an empty ghost row when the screen opens (§4).
 */
export async function appendTurn(
  chatId: string | null | undefined,
  turn: AppendTurnInput,
): Promise<AppendTurnResult> {
  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);

  if (isPairedTurn(turn)) {
    const userRes = await appendSingleMessageInternal(
      scopeUser,
      bucket,
      chatId,
      {
        ...turn.user,
        role: 'user',
      },
      {deferChatPatch: true, preferredCreatedAtMs: turn.createdAtMs},
    );

    const resolvedAiInput = await Promise.resolve(turn.ai);
    const aiRes = await appendSingleMessageInternal(
      scopeUser,
      bucket,
      userRes.chatId,
      {
        ...resolvedAiInput,
        role: 'ai',
      },
      {deferChatPatch: false},
    );

    return {
      chatId: aiRes.chatId,
      chat: aiRes.chat,
      userMessage: userRes.message,
      aiMessage: aiRes.message,
      message: aiRes.message,
    };
  }

  return await appendSingleMessageInternal(scopeUser, bucket, chatId, turn, {
    deferChatPatch: false,
  });
}

async function appendSingleMessageInternal(
  scopeUser: string,
  bucket: UserCacheBucket,
  chatIdInput: string | null | undefined,
  turn: SingleTurnInput,
  opts: {deferChatPatch: boolean; preferredCreatedAtMs?: number},
): Promise<AppendTurnResult> {
  let targetChatId = String(chatIdInput || '').trim();
  const isNewChat = !targetChatId || !bucket.chats[targetChatId];

  // Check dedupeKey for double-tap / retry protection (§3, §7)
  if (turn.dedupeKey && targetChatId) {
    const existingMsgId = dedupeKeyToMessageId.get(
      `${scopeUser}::${targetChatId}::${turn.dedupeKey}`,
    );
    if (existingMsgId && bucket.messagesByChat[targetChatId]?.[existingMsgId]) {
      const existingMsg = bucket.messagesByChat[targetChatId][existingMsgId];
      const existingChat = bucket.chats[targetChatId];
      await enqueueChatTasks(scopeUser, targetChatId, [
        {
          opId: `msg_${existingMsg.id}`,
          chatId: targetChatId,
          user: scopeUser,
          kind: 'create_message',
          message: existingMsg,
        },
      ]);
      return {
        chatId: targetChatId,
        chat: existingChat,
        message: existingMsg,
        ...(turn.role === 'user'
          ? {userMessage: existingMsg}
          : {aiMessage: existingMsg}),
      };
    }
  }

  let chatRecord: AiChatRecord;
  const tasksToQueue: QueuedWriteTask[] = [];

  if (isNewChat) {
    const createdAtMs = nextUniqueTimestampMs(opts.preferredCreatedAtMs);
    if (!targetChatId) {
      targetChatId = buildAiChatId(scopeUser, createdAtMs);
    }
    const createdIso = toIsoUtc(createdAtMs);
    const initialTitle =
      turn.role === 'user' ? formatChatTitle(turn.text) : 'New chat';

    chatRecord = {
      id: targetChatId,
      user: scopeUser,
      title: initialTitle,
      created_at: createdIso,
      updated_at: createdIso,
      turns: 0,
      last_text: formatLastTextPreview(turn.text),
      device: currentDevice,
    };
    bucket.chats[targetChatId] = chatRecord;
    bucket.messagesByChat[targetChatId] =
      bucket.messagesByChat[targetChatId] || {};

    tasksToQueue.push({
      opId: `chat_create_${targetChatId}`,
      chatId: targetChatId,
      user: scopeUser,
      kind: 'create_chat',
      chat: {...chatRecord, turns: 1},
    });
  } else {
    chatRecord = bucket.chats[targetChatId];
    assertAccountScope(chatRecord.user);
  }

  activeOpenChatId = targetChatId;

  // Determine deterministic 4-digit sequence number (`0001`, `0002`, ...)
  const existingMsgs = bucket.messagesByChat[targetChatId] || {};
  let seq: number;
  if (typeof turn.seq === 'number' && turn.seq > 0) {
    seq = Math.floor(turn.seq);
  } else {
    seq = chatRecord.turns + 1;
  }

  const msgId = buildAiMessageId(targetChatId, seq);
  const existingSameSeq = existingMsgs[msgId];

  // §3: Retried POST of the exact same seq must NEVER increment `turns` twice or create a second copy!
  const msgAtIso = toIsoUtc(turn.at);
  const messageKind: AiMessageKind =
    turn.kind === 'image' ||
    Boolean(turn.image) ||
    Boolean(turn.image_url) ||
    Boolean(turn.image_id) ||
    Boolean(turn.max_prompt)
      ? 'image'
      : turn.kind === 'voice' || Boolean(turn.file_id) || Boolean(turn.audio)
      ? 'voice'
      : 'text';

  const messageRecord: AiMessageRecord = existingSameSeq || {
    id: msgId,
    chat_id: targetChatId,
    user: scopeUser,
    role: turn.role,
    text: String(turn.text ?? ''),
    at: msgAtIso,
    kind: messageKind,
    ...(turn.file_id ? {file_id: turn.file_id} : {}),
    ...(typeof turn.duration_ms === 'number'
      ? {duration_ms: turn.duration_ms}
      : {}),
    ...(turn.image_id ? {image_id: turn.image_id} : {}),
    ...(turn.image_url
      ? {image_url: turn.image_url}
      : messageKind === 'image' && turn.file_id
      ? {
          image_url: `https://vega-ai-6m2k.onrender.com/api/image/view/img_${turn.file_id}.jpg`,
        }
      : {}),
    ...(turn.max_prompt ? {max_prompt: turn.max_prompt} : {}),
    ...(turn.image_action ? {image_action: turn.image_action} : {}),
    ...(typeof turn.width === 'number' ? {width: turn.width} : {}),
    ...(typeof turn.height === 'number' ? {height: turn.height} : {}),
    ...(turn.thinking ? {thinking: turn.thinking} : {}),
  };

  if (!bucket.messagesByChat[targetChatId]) {
    bucket.messagesByChat[targetChatId] = {};
  }
  bucket.messagesByChat[targetChatId][msgId] = messageRecord;

  if (turn.dedupeKey) {
    dedupeKeyToMessageId.set(
      `${scopeUser}::${targetChatId}::${turn.dedupeKey}`,
      msgId,
    );
  }

  const newTurnsCount = Math.max(chatRecord.turns, seq);
  const updatedTitle =
    chatRecord.title === 'New chat' && turn.role === 'user' && turn.text.trim()
      ? formatChatTitle(turn.text)
      : chatRecord.title;
  const updatedLastText = formatLastTextPreview(turn.text);
  const updatedIso =
    msgAtIso > chatRecord.updated_at ? msgAtIso : new Date().toISOString();

  chatRecord = {
    ...chatRecord,
    title: updatedTitle,
    updated_at: updatedIso,
    turns: newTurnsCount,
    last_text: updatedLastText,
  };
  bucket.chats[targetChatId] = chatRecord;

  tasksToQueue.push({
    opId: `msg_${msgId}`,
    chatId: targetChatId,
    user: scopeUser,
    kind: 'create_message',
    message: messageRecord,
    pendingAudio: extractPendingAudio(turn),
    pendingImage: extractPendingImage(turn),
  });

  if (!opts.deferChatPatch && !(isNewChat && seq === 1)) {
    const patchPayload: Partial<AiChatRecord> = {
      updated_at: chatRecord.updated_at,
      turns: chatRecord.turns,
      last_text: chatRecord.last_text,
      title: chatRecord.title,
    };
    tasksToQueue.push({
      opId: `chat_patch_${targetChatId}_${seq}_${Date.now()}`,
      chatId: targetChatId,
      user: scopeUser,
      kind: 'patch_chat',
      patch: patchPayload,
    });
  }

  await saveBucket(scopeUser);
  await enqueueChatTasks(scopeUser, targetChatId, tasksToQueue);

  return {
    chatId: targetChatId,
    chat: chatRecord,
    message: messageRecord,
    ...(turn.role === 'user'
      ? {userMessage: messageRecord}
      : {aiMessage: messageRecord}),
  };
}

/**
 * 4) `renameChat(id, title)`
 *
 * Updates local cache immediately and PATCHes `ai_chats/{id}` with the new title.
 */
export async function renameChat(
  id: string,
  title: string,
): Promise<AiChatRecord> {
  const cleanId = String(id || '').trim();
  const cleanTitle = formatChatTitle(title);
  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);

  const existing = bucket.chats[cleanId];
  if (existing) {
    assertAccountScope(existing.user);
  }

  const nowIso = toIsoUtc();
  const updated: AiChatRecord = existing
    ? {
        ...existing,
        title: cleanTitle,
        updated_at: nowIso,
      }
    : {
        id: cleanId,
        user: scopeUser,
        title: cleanTitle,
        created_at: nowIso,
        updated_at: nowIso,
        turns: 0,
        last_text: '',
        device: currentDevice,
      };

  bucket.chats[cleanId] = updated;
  await saveBucket(scopeUser);

  await enqueueChatTasks(scopeUser, cleanId, [
    {
      opId: `rename_${cleanId}_${Date.now()}`,
      chatId: cleanId,
      user: scopeUser,
      kind: 'patch_chat',
      patch: {title: cleanTitle, updated_at: nowIso},
    },
  ]);

  return updated;
}

/**
 * 5) `deleteChat(id)`
 *
 * §4: Walk the chat's messages (`limit=200` + `cursor`) and DELETE each, then
 * DELETE the chat document. A repeat delete is harmless — treat 404 as done.
 */
export async function deleteChat(
  id: string,
): Promise<{id: string; deleted: boolean; deletedMessages: number}> {
  const cleanId = String(id || '').trim();
  if (!cleanId) {
    throw new Error('deleteChat requires a non-empty chat id');
  }

  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);

  const existing = bucket.chats[cleanId];
  if (existing) {
    assertAccountScope(existing.user);
  }

  const localMsgIds = Object.keys(bucket.messagesByChat[cleanId] || {});
  delete bucket.chats[cleanId];
  delete bucket.messagesByChat[cleanId];
  delete bucket.queueByChat[cleanId];
  if (activeOpenChatId === cleanId) {
    activeOpenChatId = null;
  }
  await saveBucket(scopeUser);

  if (scopeUser === GUEST_USER_KEY) {
    return {
      id: cleanId,
      deleted: true,
      deletedMessages: localMsgIds.length,
    };
  }

  if (networkPausedForTest) {
    await enqueueChatTasks(scopeUser, cleanId, [
      {
        opId: `del_${cleanId}`,
        chatId: cleanId,
        user: scopeUser,
        kind: 'delete_chat',
        messageIds: localMsgIds,
      },
    ]);
    return {
      id: cleanId,
      deleted: true,
      deletedMessages: localMsgIds.length,
    };
  }

  // Walk all pages of messages for this chat (limit 200 + cursor) and delete each
  const allMsgIds = new Set<string>(localMsgIds);
  let cursor: string | null = null;
  for (let pageIdx = 0; pageIdx < 50; pageIdx += 1) {
    const page = await ztQueryDocuments<AiMessageRecord>(
      AI_MESSAGES_COLLECTION,
      {
        where: [
          ['chat_id', 'eq', cleanId],
          ['user', 'eq', scopeUser],
        ],
        limit: MAX_ZENTRAGRID_LIMIT,
        cursor,
      },
    );
    for (const doc of page.documents) {
      if (doc.id) allMsgIds.add(doc.id);
    }
    if (!page.nextCursor || page.documents.length === 0) break;
    cursor = page.nextCursor;
  }

  let deletedMessages = 0;
  for (const msgId of allMsgIds) {
    await ztDeleteDocument(AI_MESSAGES_COLLECTION, msgId);
    deletedMessages += 1;
  }

  await ztDeleteDocument(AI_CHATS_COLLECTION, cleanId);

  return {
    id: cleanId,
    deleted: true,
    deletedMessages,
  };
}

export type StoredUserImageRecord = {
  imageId: string;
  fileId: string | null;
  user: string;
  chatId: string | null;
  imageUrl: string;
  maxPrompt?: string;
  reply?: string;
  imageAction?: 'generate' | 'edit';
  width?: number;
  height?: number;
  createdAt: string;
};

/**
 * 6) `listUserImages(options?)`
 *
 * Returns all generated/edited images stored for the current signed-in user
 * across local cache, `ai_messages` (`kind === 'image'`), and `/v1/files?owner=<email>`.
 */
export async function listUserImages(options: {
  chatId?: string;
  limit?: number;
} = {}): Promise<StoredUserImageRecord[]> {
  const scopeUser = currentScopeUser();
  const bucket = await loadBucket(scopeUser);
  const byKey = new Map<string, StoredUserImageRecord>();
  const filterChatId = options.chatId ? String(options.chatId).trim() : '';

  // 1) Local cache messages (`kind === 'image'`)
  for (const [cId, msgMap] of Object.entries(bucket.messagesByChat)) {
    if (filterChatId && cId !== filterChatId) continue;
    for (const m of Object.values(msgMap)) {
      if (m.user !== scopeUser) continue;
      if (m.kind !== 'image' && !m.image_url && !m.file_id) continue;
      if (m.role !== 'ai') continue;
      const key = m.file_id || m.image_id || m.id;
      const imgId = m.image_id || (m.file_id ? `img_${m.file_id}.jpg` : m.id);
      byKey.set(key, {
        imageId: imgId,
        fileId: m.file_id || null,
        user: scopeUser,
        chatId: m.chat_id || cId,
        imageUrl:
          m.image_url ||
          `https://vega-ai-6m2k.onrender.com/api/image/view/${imgId}`,
        maxPrompt: m.max_prompt,
        reply: m.text,
        imageAction: m.image_action || 'generate',
        width: m.width || 1024,
        height: m.height || 1024,
        createdAt: m.at,
      });
    }
  }

  // 2) Server `/v1/files?owner=<scopeUser>` when signed in and online
  if (scopeUser !== GUEST_USER_KEY && !networkPausedForTest) {
    try {
      const files: ZtFileRecord[] = await ztListFiles({
        owner: scopeUser,
        parentId: filterChatId || undefined,
      });
      for (const f of files) {
        const mime = String(f.mime || f.mime_type || '');
        if (
          !mime.startsWith('image/') &&
          !/\.(jpg|jpeg|png|webp)$/i.test(String(f.name || ''))
        ) {
          continue;
        }
        const fId = String(f.id || '');
        if (!fId) continue;
        const ext = mime.includes('png') ? 'png' : 'jpg';
        const imgId = `img_${fId}.${ext}`;
        if (!byKey.has(fId)) {
          byKey.set(fId, {
            imageId: imgId,
            fileId: fId,
            user: scopeUser,
            chatId:
              f.parent_id && f.parent_id !== 'vega_ai_images'
                ? f.parent_id
                : null,
            imageUrl: `https://vega-ai-6m2k.onrender.com/api/image/view/${imgId}`,
            imageAction: String(f.name || '').includes('_edit_')
              ? 'edit'
              : 'generate',
            createdAt: f.created_at || toIsoUtc(),
          });
        }
      }
    } catch {}
  }

  const out = Array.from(byKey.values()).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const maxItems = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  return out.slice(0, maxItems);
}

