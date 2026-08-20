import { describe, expect, it, vi } from "vitest";
import {
  ProjectRuntime,
  type ProjectRuntimeDeps
} from "../src/app/project-runtime";
import { DEFAULT_SETTINGS, emptyProjectCache } from "../src/shared/types";
import type {
  ProjectCache,
  ProjectConfig,
  ScriptoriumSettings
} from "../src/shared/types";

interface TFileStub {
  path: string;
  basename: string;
  extension: string;
  constructor: { name: string };
}

function makeFile(path: string): TFileStub {
  return {
    path,
    basename: path.split("/").pop()?.replace(/\.md$/i, "") ?? "",
    extension: "md",
    constructor: { name: "TFile" }
  };
}

function makeProject(): ProjectConfig {
  return {
    id: "p1",
    name: "P1",
    root: "project",
    syncMode: "translated",
    excludeGlobs: [],
    includeFolderEntries: true,
    translationPrompt: "",
    translationGlossary: ""
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface DepsHandle {
  deps: ProjectRuntimeDeps;
  reads: { promise: Promise<string>; resolve: (value: string) => void }[];
  refresh: ReturnType<typeof vi.fn>;
  getMarkdownFiles: ReturnType<typeof vi.fn>;
}

function makeDeps(): DepsHandle {
  const settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  settings.projects = [makeProject()];
  const file = makeFile("project/a.md");
  const getMarkdownFiles = vi.fn(() => [file]);
  const reads: DepsHandle["reads"] = [];
  const cachedRead = vi.fn(() => {
    const d = deferred<string>();
    reads.push(d);
    return d.promise;
  });
  const refresh = vi.fn();
  const cache: ProjectCache = emptyProjectCache();
  const deps: ProjectRuntimeDeps = {
    app: {
      vault: {
        getMarkdownFiles,
        cachedRead,
        getFileByPath: () => null,
        getAbstractFileByPath: () => null
      },
      workspace: { getActiveFile: () => null }
    } as unknown as ProjectRuntimeDeps["app"],
    getSettings: () => settings,
    getProjectCache: () => cache,
    saveSettings: async () => undefined,
    scheduleRelay: () => undefined,
    resetRelayHash: () => undefined,
    refreshDashboard: refresh,
    cancelTranslation: () => undefined,
    invalidateDocumentProject: () => false,
    isVaultScanSuppressed: () => false,
    withVaultScanSuppressed: async <T>(action: () => Promise<T>) => action(),
    debug: () => undefined
  };
  return { deps, reads, refresh, getMarkdownFiles };
}

// frontmatter that makes listSourceFiles exclude the file, so each scan
// performs exactly one gated cachedRead (inside listSourceFiles) and then
// completes. This keeps the serialization sequence legible.
const EXCLUDE = "---\nscriptorium: false\n---\n";

// macrotask tick: flushes all pending microtasks (and chained awaits) so the
// async scan loop settles between gated cachedRead releases.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ProjectRuntime scan serialization", () => {
  it("coalesces an overlapping rescan and re-runs exactly once afterward", async () => {
    const { deps, reads, refresh, getMarkdownFiles } = makeDeps();
    const runtime = new ProjectRuntime(deps);
    const file = makeFile("project/a.md");

    // followFile sets the active project and starts the first scan, which
    // pauses at the gated cachedRead inside listSourceFiles.
    const follow = runtime.followFile(
      file as unknown as Parameters<typeof runtime.followFile>[0]
    );
    expect(getMarkdownFiles).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(1);

    // 검사 중 두 번째 rescan은 병렬 검사를 시작하지 않고 scanAgain만 설정한다.
    const second = runtime.rescan();
    await tick();
    expect(getMarkdownFiles).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(1);
    // second는 곧바로 귀결한다(새 검사를 시작하지 않았으므로).
    await expect(second).resolves.toBeUndefined();

    // 첫 검사를 진행시키면 완료 직후 scanAgain에 의해 재검사가 한 번 더 돈다.
    reads[0]!.resolve(EXCLUDE);
    await tick();
    expect(getMarkdownFiles).toHaveBeenCalledTimes(2);
    expect(reads).toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(1);

    // 재검사까지 끝내면 follow가 귀결하고 refresh는 두 번 호출된다.
    reads[1]!.resolve(EXCLUDE);
    await tick();
    await expect(follow).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getMarkdownFiles).toHaveBeenCalledTimes(2);
  });

  it("refreshes and clears the change plan when there is no active project", async () => {
    const { deps, refresh } = makeDeps();
    const runtime = new ProjectRuntime(deps);
    await runtime.rescan();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(runtime.getChangePlan()).toBeNull();
  });

  it("debounces rapid scheduleScan calls into a single 250ms scan", async () => {
    vi.useFakeTimers();
    try {
      const { deps, refresh } = makeDeps();
      const runtime = new ProjectRuntime(deps);

      // 활성 프로젝트가 없으므로 수행되는 검사는 빠르게 early-return 한다.
      runtime.scheduleScan();
      runtime.scheduleScan();
      runtime.scheduleScan();

      // 250ms 직전에는 아직 검사가 돌지 않는다.
      vi.advanceTimersByTime(249);
      expect(refresh).not.toHaveBeenCalled();

      // 250ms가 지나면 단 한 번의 검사만 수행된다.
      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});