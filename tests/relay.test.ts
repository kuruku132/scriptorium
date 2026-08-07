import { afterEach, describe, expect, it } from "vitest";
import {
  handleRequest,
  createRelayServer,
  MemoryStore
} from "../relay/relay.mjs";
import type { Server } from "node:http";

const snapshot = {
  schema: 1,
  status: "no-active-project",
  hash: "abc"
};

const url = (channel = "demo") =>
  `https://relay.test/v1/channels/${encodeURIComponent(channel)}/snapshot`;

describe("relay handleRequest", () => {
  it("reports a missing store binding", async () => {
    const response = await handleRequest(new Request(url()), {});
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "missing-store" });
  });

  it("stores, serves, and validates ETags", async () => {
    const env = { store: new MemoryStore(), bearerToken: "" };
    const put = await handleRequest(
      new Request(url(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      }),
      env
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ ok: true, hash: "abc" });

    const get = await handleRequest(new Request(url()), env);
    expect(get.status).toBe(200);
    expect(get.headers.get("ETag")).toBe('"abc"');
    await expect(get.json()).resolves.toEqual(snapshot);

    const cached = await handleRequest(
      new Request(url(), { headers: { "If-None-Match": '"abc"' } }),
      env
    );
    expect(cached.status).toBe(304);
  });

  it("rejects an invalid snapshot shape", async () => {
    const env = { store: new MemoryStore(), bearerToken: "" };
    const response = await handleRequest(
      new Request(url(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: 1, status: "ready" })
      }),
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid-snapshot"
    });
  });

  it("keeps channels independent", async () => {
    const env = { store: new MemoryStore(), bearerToken: "" };
    await handleRequest(
      new Request(url("a"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: 1, status: "no-active-project", hash: "a" })
      }),
      env
    );
    const other = await handleRequest(new Request(url("b")), env);
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toEqual({ error: "channel-empty" });
  });

  it("requires the same optional bearer token for push and pull", async () => {
    const env = { store: new MemoryStore(), bearerToken: "secret" };
    expect(
      (
        await handleRequest(
          new Request(url(), { method: "PUT", body: JSON.stringify(snapshot) }),
          env
        )
      ).status
    ).toBe(401);
    expect(
      (
        await handleRequest(
          new Request(url(), { headers: { Authorization: "Bearer secret" } }),
          env
        )
      ).status
    ).toBe(404);
  });
});

describe("relay HTTP server", () => {
  let server: Server | null = null;
  let baseUrl = "";

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  async function start(bearerToken = ""): Promise<void> {
    server = createRelayServer({
      store: new MemoryStore(),
      bearerToken,
      host: "127.0.0.1",
      port: 0
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server!.address();
    if (!address || typeof address === "string") {
      throw new Error("릴레이 테스트 서버가 TCP 포트에 바인딩되지 않았습니다");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  it("round-trips a snapshot over HTTP with CORS headers", async () => {
    await start();
    const put = await fetch(`${baseUrl}/v1/channels/demo/snapshot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot)
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("access-control-allow-origin")).toBe("*");

    const get = await fetch(`${baseUrl}/v1/channels/demo/snapshot`);
    expect(get.status).toBe(200);
    expect(get.headers.get("etag")).toBe('"abc"');
    await expect(get.json()).resolves.toEqual(snapshot);
  });

  it("answers CORS preflight requests", async () => {
    await start();
    const response = await fetch(`${baseUrl}/v1/channels/demo/snapshot`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://risuai.net",
        "Access-Control-Request-Method": "GET"
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "GET"
    );
  });

  it("enforces the bearer token over HTTP", async () => {
    await start("secret");
    const unauthorized = await fetch(`${baseUrl}/v1/channels/demo/snapshot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot)
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/v1/channels/demo/snapshot`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret"
      },
      body: JSON.stringify(snapshot)
    });
    expect(authorized.status).toBe(200);
  });
});