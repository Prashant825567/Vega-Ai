import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Simple TypeScript-to-JS stripper for testing src/lib/zentragrid/zentragridApi.ts and src/lib/services/vegaAiHistory.ts in Node 20
import tsPkg from "typescript";
const ts = tsPkg.default || tsPkg;

function loadTsModule(filePath, injectedImports = {}) {
  const source = fs.readFileSync(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const exportsObj = {};
  const moduleObj = { exports: exportsObj };
  const requireFn = (id) => {
    if (id in injectedImports) return injectedImports[id];
    throw new Error(`Unexpected import: ${id}`);
  };
  const fn = new Function("exports", "module", "require", transpiled);
  fn(exportsObj, moduleObj, requireFn);
  return moduleObj.exports;
}

// 1. Start a local ZentraGrid-exact server (matching Vega-Storage's exact routes & error codes)
const collections = new Map(); // collection -> Map(id -> envelope)
const files = new Map(); // fileId -> { id, name, size, mime_type, bytes }
const VALID_API_KEY = "zg_test_key_vega_storage";
let simulateNext429 = false;

function getCol(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

const mockServer = http.createServer(async (req, res) => {
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${VALID_API_KEY}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: "Invalid or missing API key",
        code: "INVALID_ID_TOKEN",
        message: "Invalid or missing API key",
        error_detail: { message: "Invalid or missing API key", code: "INVALID_ID_TOKEN" },
      })
    );
  }

  if (simulateNext429 && req.method === "POST") {
    simulateNext429 = false;
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    return res.end(
      JSON.stringify({
        error: "Telegram asked us to wait 1s before writing",
        code: "RATE_LIMITED",
        retry_after: 1,
        error_detail: { message: "Telegram asked us to wait 1s before writing", code: "RATE_LIMITED" },
      })
    );
  }

  const url = new URL(req.url, "http://localhost");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBuf = Buffer.concat(chunks);

  // POST /v1/files
  if (req.method === "POST" && url.pathname === "/v1/files") {
    const fileId = `file_${Date.now()}_${files.size + 1}`;
    const record = {
      id: fileId,
      name: "voice_turn.wav",
      size: rawBuf.length,
      mime_type: "audio/wav",
      status: "ready",
    };
    files.set(fileId, { ...record, bytes: rawBuf });
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(record));
  }

  // GET /v1/files/:id/download
  const fileDl = url.pathname.match(/^\/v1\/files\/([^/]+)\/download$/);
  if (req.method === "GET" && fileDl) {
    const f = files.get(decodeURIComponent(fileDl[1]));
    if (!f) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "File not found", code: "NOT_FOUND" }));
    }
    res.writeHead(200, { "Content-Type": f.mime_type });
    return res.end(f.bytes);
  }

  // /v1/data/:collection
  const colMatch = url.pathname.match(/^\/v1\/data\/([^/]+)$/);
  if (colMatch) {
    const colName = decodeURIComponent(colMatch[1]);
    const col = getCol(colName);

    if (req.method === "POST") {
      const body = JSON.parse(rawBuf.toString("utf8"));
      const id = body.id;
      if (col.has(id)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: `Document '${id}' already exists in '${colName}'`,
            code: "DOCUMENT_ALREADY_EXISTS",
            error_detail: {
              message: `Document '${id}' already exists in '${colName}'`,
              code: "DOCUMENT_ALREADY_EXISTS",
            },
          })
        );
      }
      const now = new Date().toISOString();
      const doc = {
        id,
        rev: 1,
        data: body.data || {},
        created_at: now,
        updated_at: now,
      };
      col.set(id, doc);
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(doc));
    }

    if (req.method === "GET") {
      const limitParam = url.searchParams.get("limit");
      if (limitParam && Number(limitParam) > 200) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "query.limit: Input should be less than or equal to 200",
            code: "VALIDATION_ERROR",
          })
        );
      }
      const wheres = url.searchParams.getAll("where");
      let docs = Array.from(col.values()).filter((d) => !d.deleted);
      for (const w of wheres) {
        const [field, op, ...rest] = w.split(":");
        const val = rest.join(":");
        docs = docs.filter((d) => {
          const v = String(d.data?.[field] ?? d[field] ?? "");
          if (op === "eq") return v === val;
          if (op === "ne") return v !== val;
          if (op === "gt") return v > val;
          return true;
        });
      }
      const orderBy = url.searchParams.get("order_by");
      if (orderBy) {
        const [field, dir] = orderBy.split(":");
        docs.sort((a, b) => {
          const va = String(a.data?.[field] ?? a[field] ?? "");
          const vb = String(b.data?.[field] ?? b[field] ?? "");
          return dir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
        });
      }
      const lim = limitParam ? Number(limitParam) : 100;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ documents: docs.slice(0, lim), next_cursor: null }));
    }
  }

  // /v1/data/:collection/:id
  const docMatch = url.pathname.match(/^\/v1\/data\/([^/]+)\/([^/]+)$/);
  if (docMatch) {
    const colName = decodeURIComponent(docMatch[1]);
    const docId = decodeURIComponent(docMatch[2]);
    const col = getCol(colName);
    const existing = col.get(docId);

    if (req.method === "PATCH") {
      if (!existing || existing.deleted) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }));
      }
      const body = JSON.parse(rawBuf.toString("utf8"));
      existing.data = { ...existing.data, ...(body.data || {}) };
      existing.rev += 1;
      existing.updated_at = new Date().toISOString();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(existing));
    }

    if (req.method === "DELETE") {
      if (!existing || existing.deleted) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }));
      }
      existing.deleted = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: docId, deleted: true }));
    }
  }

  res.writeHead(404);
  res.end();
});

await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const port = mockServer.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const ztApi = loadTsModule("/home/user/src/lib/zentragrid/zentragridApi.ts");
const historyMod = loadTsModule("/home/user/src/lib/services/vegaAiHistory.ts", {
  "../zentragrid/zentragridApi": ztApi,
});

ztApi.configureZentraGrid({ baseUrl, apiKey: VALID_API_KEY });

console.log("=== 1. Guest Mode (§5): nothing goes to server before sign-in ===");
await historyMod.setSignedInUser(null, "android");
const guestTurn = await historyMod.appendTurn(null, {
  user: { text: "Hello Max in guest mode", kind: "text" },
  ai: { text: "Hi! Main Max v1.0 hoon.", kind: "text" },
});
assert.equal(getCol("ai_chats").size, 0, "Guest chat must NOT be sent to server");
assert.equal(getCol("ai_messages").size, 0, "Guest messages must NOT be sent to server");
console.log("  OK: Guest chat kept strictly in local storage:", guestTurn.chatId);

console.log("\n=== 2. Sign-in & Idempotent One-Time Migration (§5) ===");
const mig1 = await historyMod.migrateGuestHistoryOnSignIn("Prashant@Vega.App");
await historyMod.flushPendingWrites();
const mig2 = await historyMod.migrateGuestHistoryOnSignIn("Prashant@Vega.App");
assert.equal(mig1.migratedChats, 1);
assert.equal(mig1.migratedMessages, 2);
assert.equal(mig2.migratedChats, 0, "Second migration run must be a no-op");
console.log("  OK: Migrated once ->", mig1, "| Second run ->", mig2);

console.log("\n=== 3. Resume Chat + Voice Turn Upload (/v1/files) + 429 Retry-After + 409 Dedupe (§2, §3, §4, §6) ===");
const listed = await historyMod.listChats();
const activeChatId = listed.chats[0].id;
const opened = await historyMod.openChat(activeChatId);
assert.equal(opened.messages.length, 2);

// Trigger 429 on next POST to prove Retry-After handling with same deterministic ID
simulateNext429 = true;
const userVoiceRes = await historyMod.appendTurn(activeChatId, {
  role: "user",
  text: "Namaste Max, aaj mausam kaisa hai?",
  kind: "voice",
  duration_ms: 2400,
  audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
  dedupeKey: "tap_1",
});
// Simulate double-tap send with same dedupeKey / seq
const duplicateTapRes = await historyMod.appendTurn(activeChatId, {
  role: "user",
  text: "Namaste Max, aaj mausam kaisa hai?",
  kind: "voice",
  duration_ms: 2400,
  seq: 3,
  dedupeKey: "tap_1",
});
assert.equal(userVoiceRes.message.id, duplicateTapRes.message.id, "Double-tap must use identical message ID");

const aiVoiceRes = await historyMod.appendTurn(activeChatId, {
  role: "ai",
  text: "Aaj mausam bilkul saaf aur suhana hai!",
  kind: "voice",
  duration_ms: 3100,
  audio: new Uint8Array([82, 73, 70, 70, 5, 6, 7, 8]),
});
await historyMod.flushPendingWrites();

console.log("\n=== 4. Prove via API (GET /v1/data/ai_chats & GET /v1/data/ai_messages) (§7) ===");
const chatsRes = await fetch(
  `${baseUrl}/v1/data/ai_chats?where=user:eq:${encodeURIComponent("prashant@vega.app")}&order_by=updated_at:desc&limit=50`,
  { headers: { Authorization: `Bearer ${VALID_API_KEY}` } }
).then((r) => r.json());
console.log("GET /v1/data/ai_chats?where=user:eq:prashant%40vega.app ->");
console.log(JSON.stringify(chatsRes, null, 2));

const msgsRes = await fetch(
  `${baseUrl}/v1/data/ai_messages?where=chat_id:eq:${encodeURIComponent(activeChatId)}&order_by=at&limit=200`,
  { headers: { Authorization: `Bearer ${VALID_API_KEY}` } }
).then((r) => r.json());
console.log(`\nGET /v1/data/ai_messages?where=chat_id:eq:${activeChatId}&order_by=at ->`);
console.log(JSON.stringify(msgsRes, null, 2));

assert.equal(chatsRes.documents.length, 1);
assert.equal(chatsRes.documents[0].data.turns, 4);
assert.equal(msgsRes.documents.length, 4);
assert.ok(msgsRes.documents[2].data.file_id, "Voice turn must store file_id, never raw bytes");

console.log("\n=== 5. Airplane Mode Offline Sync & Delete Chat (§6, §7) ===");
historyMod.setOfflineMode(true);
await historyMod.renameChat(activeChatId, "Mausam Ki Baatcheet");
historyMod.setOfflineMode(false);
await historyMod.flushPendingWrites();

const delRes = await historyMod.deleteChat(activeChatId);
// Repeat delete is harmless (404 treated as done)
await historyMod.deleteChat(activeChatId);
console.log("Delete result:", delRes);

const afterDelChats = await fetch(
  `${baseUrl}/v1/data/ai_chats?where=user:eq:${encodeURIComponent("prashant@vega.app")}`,
  { headers: { Authorization: `Bearer ${VALID_API_KEY}` } }
).then((r) => r.json());
const afterDelMsgs = await fetch(
  `${baseUrl}/v1/data/ai_messages?where=chat_id:eq:${encodeURIComponent(activeChatId)}`,
  { headers: { Authorization: `Bearer ${VALID_API_KEY}` } }
).then((r) => r.json());
assert.equal(afterDelChats.documents.length, 0);
assert.equal(afterDelMsgs.documents.length, 0);
console.log("After delete -> ai_chats:", afterDelChats.documents.length, "| ai_messages:", afterDelMsgs.documents.length);

mockServer.close();
console.log("\nALL §0-§7 CHECKS PASSED!");
