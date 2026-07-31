import {
  Notice,
  Platform,
  requestUrl
} from "obsidian";
import type { Server } from "node:http";
import { snapshotHttpResponse } from "./lorebook";
import type {
  LocalServerSettings,
  LorebookSnapshot,
  RelaySettings
} from "../shared/types";

export interface SyncStatus {
  local: "off" | "starting" | "on" | "error";
  relay: "off" | "syncing" | "on" | "error";
  localMessage: string;
  relayMessage: string;
}

export class LocalSnapshotServer {
  private server: Server | null = null;
  private currentPort: number | null = null;

  constructor(
    private readonly getSnapshot: () => Promise<LorebookSnapshot>,
    private readonly onStatus: (message: string, error?: boolean) => void
  ) {}

  async configure(settings: LocalServerSettings): Promise<void> {
    if (!settings.enabled || !Platform.isDesktopApp) {
      await this.stop();
      return;
    }
    if (this.server?.listening && this.currentPort === settings.port) return;
    await this.stop();
    await this.start(settings.port);
  }

  private async start(port: number): Promise<void> {
    this.onStatus("시작 중");
    const { createServer } = await import("node:http");
    this.server = createServer(async (request, response) => {
      try {
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Authorization, If-None-Match, Content-Type",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
          });
          response.end();
          return;
        }
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "127.0.0.1"}`
        );
        if (request.method !== "GET" || url.pathname !== "/v1/snapshot") {
          response.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8"
          });
          response.end(JSON.stringify({ error: "not-found" }));
          return;
        }
        const snapshot = await this.getSnapshot();
        const result = snapshotHttpResponse(
          snapshot,
          request.headers["if-none-match"]
        );
        response.writeHead(result.status, result.headers);
        response.end(result.body ?? undefined);
      } catch (error) {
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
    this.onStatus(`127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.currentPort = null;
    if (!server) {
      this.onStatus("꺼짐");
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
