const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, If-None-Match, Content-Type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS"
};

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

function isSnapshot(value) {
  if (!value || typeof value !== "object") return false;
  if (value.schema !== 1 || typeof value.hash !== "string") return false;
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

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const channel = channelFrom(url);
  if (!channel) return json({ error: "not-found" }, 404);
  if (!authorized(request, env?.BEARER_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env?.SNAPSHOTS) {
    return json({ error: "missing-kv-binding", binding: "SNAPSHOTS" }, 500);
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
    await env.SNAPSHOTS.put(key, JSON.stringify(snapshot));
    return json({ ok: true, hash: snapshot.hash }, 200, {
      ETag: `"${snapshot.hash}"`
    });
  }

  if (request.method === "GET") {
    const stored = await env.SNAPSHOTS.get(key);
    if (!stored) return json({ error: "channel-empty" }, 404);
    const snapshot = JSON.parse(stored);
    const etag = `"${snapshot.hash}"`;
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

export default {
  fetch: handleRequest
};
