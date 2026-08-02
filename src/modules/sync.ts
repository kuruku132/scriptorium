import {
  Notice,
  Platform,
  requestUrl
} from "obsidian";
import type { Server } from "node:http";
import { snapshotHttpResponse } from "./lorebook";
import type {
  LocalServerSettings,
  LorebookDocumentProject,
  LorebookSnapshot,
  RelaySettings
} from "../shared/types";

export interface SyncStatus {
  local: "off" | "starting" | "on" | "error";
  relay: "off" | "syncing" | "on" | "error";
  localMessage: string;
  relayMessage: string;
}

export interface SnapshotProject {
  id: string;
  name: string;
  mode: "original" | "translated";
}

export class LocalSnapshotServer {
  private server: Server | null = null;
  private currentPort: number | null = null;

  constructor(
    private readonly getSnapshot: (
      projectId?: string
    ) => Promise<LorebookSnapshot>,
    private readonly getProjects: () => SnapshotProject[],
    private readonly getDocumentProject: (
      projectId: string
    ) => Promise<LorebookDocumentProject | null>,
    private readonly onDebug: (
      event: string,
      details?: Record<string, unknown>
    ) => void,
    private readonly onStatus: (message: string, error?: boolean) => void
  ) {}

  async configure(settings: LocalServerSettings): Promise<void> {
    this.onDebug("server.configure", { ...settings });
    if (!settings.enabled || !Platform.isDesktopApp) {
      await this.stop();
      return;
    }
    if (this.server?.listening && this.currentPort === settings.port) return;
    await this.stop();
    await this.start(settings.port);
  }

  private async start(port: number): Promise<void> {
    this.onDebug("server.start.begin", { port });
    this.onStatus("시작 중");
    // Obsidian loads desktop plugins as CommonJS. Keeping this as a dynamic
    // import makes Electron's renderer try to fetch the `node:http` specifier
    // as an ES module instead of resolving the Node built-in.
    const { createServer } = require("node:http") as typeof import(
      "node:http"
    );
    this.server = createServer(async (request, response) => {
      const startedAt = Date.now();
      try {
        this.onDebug("http.request", {
          method: request.method ?? "",
          url: request.url ?? "",
          ifNoneMatch: request.headers["if-none-match"] ?? ""
        });
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Authorization, If-None-Match, Content-Type",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
          });
          response.end();
          this.onDebug("http.response", { status: 204, elapsedMs: Date.now() - startedAt });
          return;
        }
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "127.0.0.1"}`
        );
        if (request.method === "GET" && url.pathname === "/v1/projects") {
          response.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Authorization, If-None-Match, Content-Type",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8"
          });
          response.end(
            JSON.stringify({ schema: 1, projects: this.getProjects() })
          );
          this.onDebug("http.projects", {
            status: 200,
            count: this.getProjects().length,
            elapsedMs: Date.now() - startedAt
          });
          return;
        }
        const route = url.pathname
          .split("/")
          .filter(Boolean)
          .map((segment) => decodeURIComponent(segment));
        if (
          request.method === "GET" &&
          route[0] === "v1" &&
          route[1] === "projects" &&
          route[2] &&
          (route[3] === "manifest" ||
            (route[3] === "documents" && route[4]))
        ) {
          const project = await this.getDocumentProject(route[2]);
          this.onDebug("http.document-project", {
            projectId: route[2],
            route: route.slice(3).join("/"),
            found: Boolean(project)
          });
          if (!project) {
            response.writeHead(404, {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json; charset=utf-8"
            });
            response.end(JSON.stringify({ error: "project-not-found" }));
            this.onDebug("http.response", { status: 404, error: "project-not-found" });
            return;
          }
          const document =
            route[3] === "documents"
              ? project.documents.find((entry) => entry.id === route[4])
              : null;
          if (route[3] === "documents" && !document) {
            response.writeHead(404, {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json; charset=utf-8"
            });
            response.end(JSON.stringify({ error: "document-not-found" }));
            this.onDebug("http.response", { status: 404, error: "document-not-found" });
            return;
          }
          const hash = document?.hash ?? project.revision;
          const headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Authorization, If-None-Match, Content-Type",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "no-store",
            ETag: `"${hash}"`,
            "Content-Type": "application/json; charset=utf-8"
          };
          const knownRevision = url.searchParams.get("known")?.trim() ?? "";
          if (
            route[3] === "manifest" &&
            knownRevision !== "" &&
            knownRevision === project.revision
          ) {
            response.writeHead(200, headers);
            response.end(
              JSON.stringify({
                schema: project.schema,
                status: "not-modified",
                project: project.project,
                mode: project.mode,
                revision: project.revision
              })
            );
            this.onDebug("http.response", {
              status: 200,
              kind: "manifest-not-modified",
              projectId: project.project.id,
              hash,
              elapsedMs: Date.now() - startedAt
            });
            return;
          }
          if (
            request.headers["if-none-match"]
              ?.replace(/^W\//, "")
              .replaceAll('"', "") === hash
          ) {
            response.writeHead(304, headers);
            response.end();
            this.onDebug("http.response", {
              status: 304,
              hash,
              elapsedMs: Date.now() - startedAt
            });
            return;
          }
          response.writeHead(200, headers);
          response.end(
            JSON.stringify(
              document
                ? {
                    schema: project.schema,
                    project: project.project,
                    mode: project.mode,
                    document
                  }
                : {
                    schema: project.schema,
                    project: project.project,
                    mode: project.mode,
                    revision: project.revision,
                    documents: project.documents.map(({ id, path, hash }) => ({
                      id,
                      path,
                      hash
                    }))
                  }
            )
          );
          this.onDebug("http.response", {
            status: 200,
            kind: document ? "document" : "manifest",
            projectId: project.project.id,
            documentId: document?.id ?? "",
            documentCount: project.documents.length,
            hash,
            elapsedMs: Date.now() - startedAt
          });
          return;
        }
        if (request.method !== "GET" || url.pathname !== "/v1/snapshot") {
          response.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8"
          });
          response.end(JSON.stringify({ error: "not-found" }));
          this.onDebug("http.response", { status: 404, error: "not-found" });
          return;
        }
        const projectId = url.searchParams.get("project")?.trim() || undefined;
        const snapshot = await this.getSnapshot(projectId);
        const result = snapshotHttpResponse(
          snapshot,
          request.headers["if-none-match"]
        );
        response.writeHead(result.status, result.headers);
        response.end(result.body ?? undefined);
        this.onDebug("http.snapshot", {
          status: result.status,
          projectId: projectId ?? "active",
          hash: snapshot.hash,
          elapsedMs: Date.now() - startedAt
        });
      } catch (error) {
        this.onDebug("http.error", {
          message: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt
        });
        response.writeHead(500, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json; charset=utf-8"
        });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("서버 생성에 실패했습니다."));
        return;
      }
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.currentPort = port;
    this.onDebug("server.start.ready", { port });
    this.onStatus(`127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    this.onDebug("server.stop.begin", {
      listening: Boolean(this.server?.listening),
      port: this.currentPort ?? 0
    });
    const server = this.server;
    this.server = null;
    this.currentPort = null;
    if (!server) {
      this.onStatus("꺼짐");
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.onDebug("server.stop.done");
    this.onStatus("꺼짐");
  }
}

export class RelaySynchronizer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPushedHash: string | null = null;

  constructor(
    private readonly getSnapshot: () => Promise<LorebookSnapshot>,
    private readonly getToken: (name: string) => string | null,
    private readonly onStatus: (message: string, error?: boolean) => void
  ) {}

  schedule(settings: RelaySettings): void {
    if (!settings.enabled || !settings.autoPush) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push(settings).catch((error) => {
        this.onStatus(
          error instanceof Error ? error.message : String(error),
          true
        );
      });
    }, 1_000);
  }

  async push(settings: RelaySettings, force = false): Promise<void> {
    if (!settings.enabled && !force) return;
    const baseUrl = settings.baseUrl.replace(/\/+$/, "");
    const channel = settings.channel.trim();
    if (!baseUrl || !channel) {
      throw new Error("릴레이 주소와 채널을 설정해 주세요.");
    }
    const snapshot = await this.getSnapshot();
    if (!force && snapshot.hash === this.lastPushedHash) return;
    this.onStatus("동기화 중");
    const token = settings.secretName
      ? this.getToken(settings.secretName)
      : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await requestUrl({
      url: `${baseUrl}/v1/channels/${encodeURIComponent(channel)}/snapshot`,
      method: "PUT",
      headers,
      body: JSON.stringify(snapshot),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`릴레이가 HTTP ${response.status}를 반환했습니다.`);
    }
    this.lastPushedHash = snapshot.hash;
    this.onStatus(`동기화됨 · ${snapshot.hash.slice(0, 8)}`);
  }

  cancelScheduled(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resetHash(): void {
    this.lastPushedHash = null;
  }

  noticeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.onStatus(message, true);
    new Notice(`Scriptorium 릴레이: ${message}`);
  }
}
