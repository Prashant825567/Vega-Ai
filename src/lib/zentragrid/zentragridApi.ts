/**
 * ZentraGrid client for Vega (`https://vega-storage.onrender.com`).
 *
 * Follows the exact wire contract of the project's storage service:
 * - POST   /v1/data/{collection}        body {"id"?: "<chosen>", "data": {...}} -> 201 {id, rev, data, ...}
 *                                       existing id -> 409 DOCUMENT_ALREADY_EXISTS
 * - GET    /v1/data/{collection}?where=&order_by=&limit=&cursor= -> {documents: [...], next_cursor}
 *                                       where is field:operator:value (repeatable, ANDed; eq, ne, gt).
 *                                       Field and operator stay literal; only VALUE is percent-encoded.
 *                                       limit > 200 returns 400.
 * - PATCH  /v1/data/{collection}/{id}   body {"data": {partial}} -> 200 {id, rev, data, ...}
 * - DELETE /v1/data/{collection}/{id}   -> 200 {id, deleted: true}
 * - POST   /v1/files                    multipart, field name "file" -> 201 {id, name, size, mime_type, ...}
 * - GET    /v1/files/{id}/download      -> raw bytes (Bearer-authenticated)
 */

export const ZENTRAGRID_BASE_URL =
  (typeof process !== 'undefined' &&
    (process.env?.ZENTRAGRID_BASE_URL ||
      process.env?.EXPO_PUBLIC_ZENTRAGRID_BASE_URL ||
      process.env?.NEXT_PUBLIC_ZENTRAGRID_PROXY_URL)) ||
  'https://vega-storage.onrender.com';

export const MAX_ZENTRAGRID_LIMIT = 200;

export type ZtDocument<T = Record<string, unknown>> = {
  id: string;
  rev?: number;
  created_at?: string;
  updated_at?: string;
  data: T;
};

export type ZtWhereClause = [
  field: string,
  operator: 'eq' | 'ne' | 'gt',
  value: string | number | boolean,
];

export type ZtQueryOptions = {
  where?: ZtWhereClause[];
  orderBy?: string;
  limit?: number;
  cursor?: string | null;
};

export type ZtFileRecord = {
  id: string;
  name?: string;
  size?: number;
  mime?: string;
  mime_type?: string;
  owner?: string | null;
  parent_id?: string | null;
  created_at?: string;
  status?: string;
};

export class ZentraGridError extends Error {
  status: number;
  code: string;
  retryAfterMs: number | null;

  constructor(
    message: string,
    status = 502,
    code = 'UNKNOWN',
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ZentraGridError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

let configuredBaseUrl: string = ZENTRAGRID_BASE_URL;
let configuredApiKey: string =
  (typeof process !== 'undefined' &&
    (process.env?.ZENTRAGRID_API_KEY ||
      process.env?.STORAGE_API_KEY ||
      process.env?.EXPO_PUBLIC_ZENTRAGRID_API_KEY ||
      '')) ||
  '';

/**
 * Configure the ZentraGrid client at runtime (or point a web client at its own
 * server-side proxy route so the key never leaves the server).
 */
export function configureZentraGrid(options: {
  baseUrl?: string;
  apiKey?: string;
}): void {
  if (typeof options.baseUrl === 'string' && options.baseUrl.trim()) {
    configuredBaseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof options.apiKey === 'string') {
    configuredApiKey = options.apiKey.trim();
  }
}

export function getZentraGridBaseUrl(): string {
  return configuredBaseUrl.replace(/\/+$/, '');
}

function getAuthHeaders(): Record<string, string> {
  const key = configuredApiKey.trim();
  if (!key) {
    return {};
  }
  return {
    Authorization: `Bearer ${key}`,
  };
}

/**
 * Returns the authenticated media source descriptor that React Native `<Video>` /
 * `Audio.Sound` and web audio players use to stream a stored voice turn from
 * `/v1/files/{fileId}/download`. Never puts the API key in the URL query string.
 */
export function zentragridMediaSource(fileId: string): {
  uri: string;
  headers: Record<string, string>;
} {
  const cleanId = encodeURIComponent((fileId || '').trim());
  return {
    uri: `${getZentraGridBaseUrl()}/v1/files/${cleanId}/download`,
    headers: getAuthHeaders(),
  };
}

/**
 * Builds the exact query string expected by `/v1/data/{collection}`:
 * - `where=field:operator:<percent-encoded-value>` (field and operator stay literal)
 * - `order_by=field` or `field:desc`
 * - `limit` clamped to [1, 200] (since limit > 200 returns HTTP 400)
 * - `cursor=<next_cursor>`
 */
export function buildZentraGridQueryString(query: ZtQueryOptions = {}): string {
  const parts: string[] = [];

  if (Array.isArray(query.where)) {
    for (const [field, operator, value] of query.where) {
      parts.push(
        `where=${field}:${operator}:${encodeURIComponent(String(value))}`,
      );
    }
  }

  if (query.orderBy) {
    // Keep field or field:desc intact
    const [f, dir] = query.orderBy.split(':');
    parts.push(
      dir
        ? `order_by=${encodeURIComponent(f)}:${encodeURIComponent(dir)}`
        : `order_by=${encodeURIComponent(query.orderBy)}`,
    );
  }

  if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
    const clamped = Math.max(
      1,
      Math.min(MAX_ZENTRAGRID_LIMIT, Math.floor(query.limit)),
    );
    parts.push(`limit=${clamped}`);
  }

  if (query.cursor) {
    parts.push(`cursor=${encodeURIComponent(query.cursor)}`);
  }

  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function parseErrorResponse(res: Response): Promise<ZentraGridError> {
  let message = '';
  let code = '';
  let retryAfterSec: number | null = null;

  const headerRetry = res.headers?.get?.('retry-after');
  if (headerRetry) {
    const parsed = Number(headerRetry);
    if (Number.isFinite(parsed) && parsed > 0) {
      retryAfterSec = parsed;
    }
  }

  try {
    const body = (await res.json()) as {
      error?: string | {message?: string; code?: string};
      error_detail?: {message?: string; code?: string};
      message?: string;
      code?: string;
      retry_after?: number;
    };

    if (typeof body?.error === 'object' && body.error !== null) {
      message = body.error.message || '';
      code = body.error.code || '';
    } else if (typeof body?.error === 'string') {
      message = body.error;
    }
    if (!message && body?.error_detail?.message) {
      message = body.error_detail.message;
    }
    if (!message && typeof body?.message === 'string') {
      message = body.message;
    }
    if (!code) {
      code = body?.error_detail?.code || body?.code || '';
    }
    if (
      retryAfterSec === null &&
      typeof body?.retry_after === 'number' &&
      body.retry_after > 0
    ) {
      retryAfterSec = body.retry_after;
    }
  } catch {
    // Ignore non-JSON error body
  }

  if (!code) {
    if (res.status === 401) code = 'INVALID_ID_TOKEN';
    else if (res.status === 404) code = 'NOT_FOUND';
    else if (res.status === 409) code = 'DOCUMENT_ALREADY_EXISTS';
    else if (res.status === 429) code = 'RATE_LIMITED';
    else code = `HTTP_${res.status}`;
  }

  if (!message) {
    message = `HTTP ${res.status} (${code})`;
  }

  return new ZentraGridError(
    message,
    res.status,
    code,
    retryAfterSec !== null ? Math.ceil(retryAfterSec * 1000) : null,
  );
}

async function ztFetch(
  path: string,
  init: RequestInit & {timeoutMs?: number; isJson?: boolean} = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      ...getAuthHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.isJson) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${getZentraGridBaseUrl()}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw await parseErrorResponse(res);
    }

    return res;
  } catch (err) {
    if (err instanceof ZentraGridError) {
      throw err;
    }
    if ((err as {name?: string})?.name === 'AbortError') {
      throw new ZentraGridError('Request timed out', 504, 'TIMEOUT');
    }
    throw new ZentraGridError(
      (err as {message?: string})?.message || 'Network request failed',
      502,
      'UNREACHABLE',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /v1/data/{collection}
 *
 * When `treat409AsSuccess` is true (default for deterministic IDs in §3), a
 * `409 DOCUMENT_ALREADY_EXISTS` response is treated as success and returns
 * `{ id, data, alreadyExisted: true }`.
 */
export async function ztCreateDocument<T extends Record<string, unknown>>(
  collection: string,
  id: string,
  data: T,
  treat409AsSuccess = true,
): Promise<ZtDocument<T> & {alreadyExisted?: boolean}> {
  try {
    const res = await ztFetch(`/v1/data/${encodeURIComponent(collection)}`, {
      method: 'POST',
      isJson: true,
      body: JSON.stringify({id, data}),
    });
    return (await res.json()) as ZtDocument<T>;
  } catch (err) {
    if (
      treat409AsSuccess &&
      err instanceof ZentraGridError &&
      err.status === 409 &&
      (err.code === 'DOCUMENT_ALREADY_EXISTS' ||
        /already exists/i.test(err.message))
    ) {
      return {
        id,
        data,
        alreadyExisted: true,
      };
    }
    throw err;
  }
}

/**
 * GET /v1/data/{collection}?where=&order_by=&limit=&cursor=
 */
export async function ztQueryDocuments<T = Record<string, unknown>>(
  collection: string,
  query: ZtQueryOptions = {},
): Promise<{documents: ZtDocument<T>[]; nextCursor: string | null}> {
  const qs = buildZentraGridQueryString(query);
  const res = await ztFetch(`/v1/data/${encodeURIComponent(collection)}${qs}`, {
    method: 'GET',
  });
  const body = (await res.json()) as {
    documents?: ZtDocument<T>[];
    next_cursor?: string | null;
  };
  return {
    documents: Array.isArray(body?.documents) ? body.documents : [],
    nextCursor: body?.next_cursor || null,
  };
}

/**
 * PATCH /v1/data/{collection}/{id}
 */
export async function ztPatchDocument<T extends Record<string, unknown>>(
  collection: string,
  id: string,
  partialData: Partial<T>,
): Promise<ZtDocument<T>> {
  const res = await ztFetch(
    `/v1/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      isJson: true,
      body: JSON.stringify({data: partialData}),
    },
  );
  return (await res.json()) as ZtDocument<T>;
}

/**
 * DELETE /v1/data/{collection}/{id}
 *
 * A repeat delete is harmless (§4): `404 NOT_FOUND` is treated as done.
 */
export async function ztDeleteDocument(
  collection: string,
  id: string,
): Promise<{id: string; deleted: boolean}> {
  try {
    const res = await ztFetch(
      `/v1/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    );
    return (await res.json()) as {id: string; deleted: boolean};
  } catch (err) {
    if (err instanceof ZentraGridError && err.status === 404) {
      return {id, deleted: true};
    }
    throw err;
  }
}

export type ZtAudioUploadInput =
  | Blob
  | Uint8Array
  | ArrayBuffer
  | {
      /** Raw base64 or `data:audio/wav;base64,...` data URI */
      base64?: string;
      /** React Native local file URI (`file:///...`) */
      uri?: string;
      name?: string;
      mimeType?: string;
    };

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * POST /v1/files (multipart/form-data, field name "file")
 * Accepts optional `metadata.owner` (`X-Owner: <email>`) and `metadata.parentId` (`X-Parent-Id: <chatId>`).
 */
export async function ztUploadFile(
  input: ZtAudioUploadInput,
  filename = 'voice_turn.wav',
  mimeType = 'audio/wav',
  metadata?: {owner?: string; parentId?: string},
): Promise<ZtFileRecord> {
  const form = new FormData();

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    form.append('file', input, filename);
  } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const blob = new Blob([bytes], {type: mimeType});
    form.append('file', blob, filename);
  } else if (input && typeof input === 'object') {
    const finalName = input.name || filename;
    const finalMime = input.mimeType || mimeType;
    if (typeof input.base64 === 'string' && input.base64.length > 0) {
      const bytes = base64ToUint8Array(input.base64);
      const blob = new Blob([bytes], {type: finalMime});
      form.append('file', blob, finalName);
    } else if (typeof input.uri === 'string' && input.uri.length > 0) {
      // React Native FormData file descriptor shape
      form.append('file', {
        uri: input.uri,
        name: finalName,
        type: finalMime,
      } as unknown as Blob);
    } else {
      throw new ZentraGridError(
        'Invalid file input for /v1/files upload',
        400,
        'VALIDATION_ERROR',
      );
    }
  } else {
    throw new ZentraGridError(
      'Invalid file input for /v1/files upload',
      400,
      'VALIDATION_ERROR',
    );
  }

  const extraHeaders: Record<string, string> = {};
  if (metadata?.owner) {
    extraHeaders['X-Owner'] = metadata.owner.trim().toLowerCase();
  }
  if (metadata?.parentId) {
    extraHeaders['X-Parent-Id'] = metadata.parentId.trim();
  }

  const res = await ztFetch('/v1/files', {
    method: 'POST',
    headers: extraHeaders,
    body: form,
    timeoutMs: 60_000,
  });

  const json = (await res.json()) as {data?: ZtFileRecord} & ZtFileRecord;
  return (json.data || json) as ZtFileRecord;
}

/**
 * GET /v1/files?owner=<email>&parent_id=<parentId>
 * Lists files uploaded to Vega Vault for a given owner/chat.
 */
export async function ztListFiles(options: {
  owner?: string;
  parentId?: string;
} = {}): Promise<ZtFileRecord[]> {
  const qs = new URLSearchParams();
  if (options.owner) {
    qs.set('owner', options.owner.trim().toLowerCase());
  }
  if (options.parentId) {
    qs.set('parent_id', options.parentId.trim());
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await ztFetch(`/v1/files${suffix}`, {
    method: 'GET',
  });
  const json = (await res.json()) as {
    files?: ZtFileRecord[];
    data?: {files?: ZtFileRecord[]};
  };
  return json.files || json.data?.files || [];
}

/**
 * GET /v1/files/{id}/download -> raw bytes
 */
export async function ztDownloadFile(fileId: string): Promise<ArrayBuffer> {
  const res = await ztFetch(
    `/v1/files/${encodeURIComponent(fileId)}/download`,
    {
      method: 'GET',
      timeoutMs: 60_000,
    },
  );
  return await res.arrayBuffer();
}
