import { afterEach, describe, expect, it } from "vitest";
import { LocalSnapshotServer } from "../src/modules/sync";

describe("local snapshot server", () => {
  let server: LocalSnapshotServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function startServer(): Promise<string> {
    server = new LocalSnapshotServer(
      async () => ({
        schema: 1,
        status: "no-active-project",
        hash: "empty"
      }),
      () => [{ id: "project-one", name: "Project One", mode: "original" }],
      async () => null,
      () => undefined,
      () => undefined
    );
    await server.configure({ enabled: true, port: 0 });
    const address = (server as unknown as { server: import("node:http").Server })
      .server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local test server did not bind to a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("serves the project list without API-key authorization", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/v1/projects`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      schema: 1,
      projects: [
        { id: "project-one", name: "Project One", mode: "original" }
      ]
    });
  });

  it("accepts browser CORS preflight requests", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/v1/projects`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://risuai.net",
        "Access-Control-Request-Method": "GET"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "GET"
    );
  });
});
