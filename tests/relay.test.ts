import { describe, expect, it } from "vitest";
import { handleRequest } from "../relay/src/worker.mjs";

class MemoryKv {
  private values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
}

const snapshot = {
  schema: 1,
  status: "no-active-project",
  hash: "abc"
};

describe("relay Worker", () => {
  it("stores, serves, and validates ETags", async () => {
    const env = { SNAPSHOTS: new MemoryKv(), BEARER_TOKEN: "" };
    const url = "https://relay.test/v1/channels/demo/snapshot";
    const put = await handleRequest(
      new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      }),
      env
    );
    expect(put.status).toBe(200);

    const get = await handleRequest(new Request(url), env);
    expect(get.status).toBe(200);
    expect(get.headers.get("ETag")).toBe('"abc"');

    const cached = await handleRequest(
      new Request(url, { headers: { "If-None-Match": '"abc"' } }),
      env
    );
    expect(cached.status).toBe(304);
  });

  it("requires the same optional bearer token for push and pull", async () => {
    const env = { SNAPSHOTS: new MemoryKv(), BEARER_TOKEN: "secret" };
    const url = "https://relay.test/v1/channels/demo/snapshot";
    expect(
      (
        await handleRequest(
          new Request(url, {
            method: "PUT",
            body: JSON.stringify(snapshot)
          }),
          env
        )
      ).status
    ).toBe(401);
    expect(
      (
        await handleRequest(
          new Request(url, {
            headers: { Authorization: "Bearer secret" }
          }),
          env
        )
      ).status
    ).toBe(404);
  });
});
