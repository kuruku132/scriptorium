import { describe, expect, it, vi } from "vitest";
import {
  DocumentProjectCache,
  type DocumentProjectCacheDeps
} from "../src/app/document-project-cache";
import { DEFAULT_SETTINGS, emptyProjectCache } from "../src/shared/types";
import type { ProjectConfig, ScriptoriumSettings } from "../src/shared/types";

function makeProject(): ProjectConfig {
  return {
    id: "project-one",
    name: "Project One",
    root: "project",
    syncMode: "translated",
    excludeGlobs: [],
    includeFolderEntries: true,
    translationPrompt: "",
    translationGlossary: ""
  };
}

interface AppStub {
  vault: {
    getMarkdownFiles: () => unknown[];
  };
}

function makeDeps(overrides: {
  markdownFiles?: () => unknown[];
  projects?: ProjectConfig[];
} = {}): { deps: DocumentProjectCacheDeps; app: AppStub } {
  const settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  settings.projects = overrides.projects ?? [makeProject()];
  const app: AppStub = {
    vault: {
      // 호출 횟수를 검증하기 위해 기본값도 vi.fn으로 만든다.
      // 호출자가 직접 vi.fn을 넘기면 그대로 사용한다(mockImplementationOnce 호환).
      getMarkdownFiles:
        overrides.markdownFiles ?? vi.fn((): unknown[] => [])
    }
  };
  const deps: DocumentProjectCacheDeps = {
    app: app as unknown as DocumentProjectCacheDeps["app"],
    getSettings: () => settings,
    getProjectCache: () => emptyProjectCache(),
    debug: () => undefined
  };
  return { deps, app };
}

describe("DocumentProjectCache", () => {
  it("returns null when the project is not found", async () => {
    const { deps } = makeDeps({ projects: [] });
    const cache = new DocumentProjectCache(deps);
    const result = await cache.get("missing");
    expect(result).toBeNull();
  });

  it("shares a single in-flight Promise across concurrent gets", async () => {
    const { deps, app } = makeDeps();
    const cache = new DocumentProjectCache(deps);
    // 빈 vault면 compileDocumentProject는 빈 문서 목록으로 이행한다.
    const first = cache.get("project-one");
    const second = cache.get("project-one");
    expect(first).toBe(second);
    const result = await first;
    expect(result).not.toBeNull();
    expect(result!.project.id).toBe("project-one");
    expect(result!.documents).toEqual([]);
    // 두 번째 호출도 동일한 결과로 이행한다.
    await expect(second).resolves.toBe(result);
    // getMarkdownFiles는 캐시 적중 경로를 타므로 한 번만 호출된다.
    expect(app.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached Promise on a subsequent get (cache hit)", async () => {
    const { deps, app } = makeDeps();
    const cache = new DocumentProjectCache(deps);
    await cache.get("project-one");
    const before = app.vault.getMarkdownFiles as unknown as {
      mock: { calls: unknown[] };
    };
    const callsAfterFirst = before.mock.calls.length;
    const second = await cache.get("project-one");
    expect(second).not.toBeNull();
    expect(second!.project.id).toBe("project-one");
    expect(before.mock.calls.length).toBe(callsAfterFirst);
  });

  it("invalidate removes the entry and returns whether it existed", async () => {
    const { deps } = makeDeps();
    const cache = new DocumentProjectCache(deps);
    expect(cache.invalidate("project-one")).toBe(false);
    await cache.get("project-one");
    expect(cache.invalidate("project-one")).toBe(true);
    expect(cache.invalidate("project-one")).toBe(false);
  });

  it("recompiles after invalidate", async () => {
    const { deps, app } = makeDeps();
    const cache = new DocumentProjectCache(deps);
    await cache.get("project-one");
    const getMarkdownFiles = app.vault.getMarkdownFiles as unknown as {
      mock: { calls: unknown[] };
    };
    const callsBefore = getMarkdownFiles.mock.calls.length;
    cache.invalidate("project-one");
    await cache.get("project-one");
    expect(getMarkdownFiles.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("removes the entry when compilation rejects so the next get retries", async () => {
    const markdownFiles = vi.fn((): unknown[] => []);
    const { deps } = makeDeps({ markdownFiles });
    const cache = new DocumentProjectCache(deps);
    // 첫 호출에서 컴파일이 거부되도록 vault 읽기를 실패시킨다.
    markdownFiles.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(cache.get("project-one")).rejects.toThrow("boom");
    // 거부된 항목은 캐시에서 제거되었으므로 다음 호출은 재시도한다.
    const recovered = await cache.get("project-one");
    expect(recovered).not.toBeNull();
    expect(recovered!.project.id).toBe("project-one");
  });

  it("clear removes all entries", async () => {
    const { deps, app } = makeDeps();
    const cache = new DocumentProjectCache(deps);
    await cache.get("project-one");
    // 항목이 캐시에 존재한다.
    expect(cache.invalidate("project-one")).toBe(true);
    // 다시 채운 뒤 clear로 전부 비운다.
    await cache.get("project-one");
    cache.clear();
    expect(cache.invalidate("project-one")).toBe(false);
    // clear 이후에는 다시 컴파일이 일어난다.
    const getMarkdownFiles = app.vault.getMarkdownFiles as unknown as {
      mock: { calls: unknown[] };
    };
    const callsBefore = getMarkdownFiles.mock.calls.length;
    await cache.get("project-one");
    expect(getMarkdownFiles.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});