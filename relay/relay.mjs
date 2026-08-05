#!/usr/bin/env node
// Scriptorium local relay.
//
// Obsidian 플러그인이 스냅샷을 PUT으로 올리고 RisuAI 플러그인이 GET으로
// 가져가는 로컬 브로커입니다. 과거의 Cloudflare Worker 릴레이를 대체하며
// 동일한 /v1/channels/{channel}/snapshot API를 그대로 제공합니다. 별도 빌드
// 없이 `node relay/relay.mjs`로 바로 실행할 수 있습니다.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, If-None-Match, Content-Type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS"
};

const SNAPSHOT_SCHEMA = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27125;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function authorized(request, token) {
  if (!token) return true;
  return request.headers.get("Authorization") === `Bearer ${token}`;
}

function channelFrom(url) {
  const match = url.pathname.match(/^\/v1\/channels\/([^/]+)\/snapshot$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function isSnapshot(value) {
  if (!value || typeof value !== "object") return false;
  if (value.schema !== SNAPSHOT_SCHEMA || typeof value.hash !== "string") return false;
  if (value.status === "no-active-project") return true;
  return (
    value.status === "ready" &&
    value.project &&
    typeof value.project.id === "string" &&
    (value.mode === "original" || value.mode === "translated") &&
    value.lorebook?.type === "risu" &&
    value.lorebook?.ver === 1 &&
    Array.isArray(value.lorebook?.data)
  );
}

// 메모리 저장소. 디스크 저장이 필요 없는 경우와 테스트에서 사용합니다.
export class MemoryStore {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async set(key, value) {
    this.values.set(key, value);
  }
}

// 파일 기반 저장소. 시작 시 한 번 읽고 PUT 때마다 디스크에 반영합니다.
export class FileStore {
  constructor(path) {
    this.path = path;
    this.values = new Map();
  }
  async load() {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          this.values.set(key, value);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async set(key, value) {
    this.values.set(key, value);
    await this.persist();
  }
  async persist() {
    const serialized = JSON.stringify(Object.fromEntries(this.values), null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, serialized, "utf8");
  }
}

// 네트워크에서 분리된 순수 요청 처리기. 테스트에서 직접 호출합니다.
// env = { store, bearerToken }, store는 async get(key)/set(key, value) 를 갖습니다.
export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const channel = channelFrom(url);
  if (!channel) return json({ error: "not-found" }, 404);
  if (!authorized(request, env?.bearerToken)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env?.store) {
    return json({ error: "missing-store" }, 500);
  }

  const key = `channel:${channel}`;
  if (request.method === "PUT") {
    let snapshot;
    try {
      snapshot = await request.json();
    } catch {
      return json({ error: "invalid-json" }, 400);
    }
    if (!isSnapshot(snapshot)) {
      return json({ error: "invalid-snapshot" }, 400);
    }
    const serialized = JSON.stringify(snapshot);
    await env.store.set(key, serialized);
    return json({ ok: true, hash: snapshot.hash }, 200, {
      ETag: `"${snapshot.hash}"`
    });
  }

  if (request.method === "GET") {
    const stored = await env.store.get(key);
    if (!stored) return json({ error: "channel-empty" }, 404);
    const snapshotHash = JSON.parse(stored).hash;
    const etag = `"${snapshotHash}"`;
    if (request.headers.get("If-None-Match")?.replace(/^W\//, "") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ...CORS_HEADERS, ETag: etag, "Cache-Control": "no-store" }
      });
    }
    return new Response(stored, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ETag: etag
      }
    });
  }

  return json({ error: "method-not-allowed" }, 405);
}

// Node http 서버를 Request/Response 세계로 연결하는 얇은 어댑터입니다.
function toWebRequest(req, host, port, body) {
  const base = `http://${req.headers.host ?? `${host}:${port}`}`;
  const init = { method: req.method, headers: new Headers(req.headers) };
  if (body !== undefined) init.body = body;
  return new Request(new URL(req.url ?? "/", base), init);
}

async function readBody(req) {
  if (req.method !== "PUT" && req.method !== "POST") return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

export function createRelayServer({
  store,
  bearerToken = "",
  host = DEFAULT_HOST,
  port = DEFAULT_PORT
}) {
  return createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const request = toWebRequest(req, host, port, body);
      const response = await handleRequest(request, { store, bearerToken });
      const headers = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      res.writeHead(response.status, headers);
      res.end(response.body ? await response.text() : "");
    } catch (error) {
      res.writeHead(500, {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({ error: error?.message ?? String(error) }));
    }
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const host = process.env.RELAY_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.RELAY_PORT ?? DEFAULT_PORT);
  const bearerToken = process.env.RELAY_TOKEN ?? "";
  const storePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    process.env.RELAY_STORE ?? "store.json"
  );
  const store = new FileStore(storePath);
  await store.load();
  const server = createRelayServer({ store, bearerToken, host, port });
  server.listen(port, host, () => {
    console.log(`Scriptorium 릴레이: http://${host}:${port}`);
    console.log(
      bearerToken
        ? "인증: Bearer 토큰 활성화됨 (RELAY_TOKEN)"
        : "인증: 없음 — 누구나 읽고 쓸 수 있습니다"
    );
    console.log(`저장소: ${storePath}`);
  });
}