import { describe, expect, it, vi } from "vitest";
import {
  TranslationController,
  type TranslationControllerDeps
} from "../src/modules/translation/controller";
import { DEFAULT_SETTINGS, emptyProjectCache } from "../src/shared/types";
import type {
  ChangeGroup,
  ProjectChangePlan,
  ProjectConfig,
  ScriptoriumSettings
} from "../src/shared/types";

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

function makeDeps(overrides: Partial<TranslationControllerDeps> = {}): {
  deps: TranslationControllerDeps;
  calls: { rescan: number; saveSettings: number; scheduleRelay: number };
} {
  const calls = { rescan: 0, saveSettings: 0, scheduleRelay: 0 };
  const project = makeProject();
  const settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  const cache = emptyProjectCache();
  const deps: TranslationControllerDeps = {
    app: {
      secretStorage: { getSecret: () => "key" },
      vault: { getFileByPath: () => null }
    } as unknown as TranslationControllerDeps["app"],
    getSettings: () => settings,
    getActiveProject: () => project,
    getChangePlan: () => null,
    getProjectCache: () => cache,
    saveSettings: async () => {
      calls.saveSettings += 1;
    },
    rescan: async () => {
      calls.rescan += 1;
    },
    scheduleRelay: () => {
      calls.scheduleRelay += 1;
    },
    withVaultScanSuppressed: async <T>(action: () => Promise<T>) => action(),
    onProgress: () => undefined,
    ...overrides
  };
  return { deps, calls };
}

describe("TranslationController", () => {
  it("exposes a fresh progress copy that callers can mutate safely", () => {
    const { deps } = makeDeps();
    const controller = new TranslationController(deps);
    const progress = controller.getProgress();
    expect(progress.running).toBe(false);
    expect(progress.message).toBe("대기");
    progress.completed = 999;
    expect(controller.getProgress().completed).toBe(0);
  });

  it("does nothing when there is no active project", async () => {
    const { deps, calls } = makeDeps({ getActiveProject: () => null });
    const controller = new TranslationController(deps);
    await controller.run();
    expect(calls.rescan).toBe(0);
    expect(calls.saveSettings).toBe(0);
  });

  it("does nothing when there is no change plan", async () => {
    const { deps, calls } = makeDeps({
      getActiveProject: () => makeProject(),
      getChangePlan: () => null
    });
    const controller = new TranslationController(deps);
    await controller.run();
    expect(calls.rescan).toBe(0);
  });

  it("stops before running when there are no eligible changes", async () => {
    const project = makeProject();
    const conflict: ChangeGroup = {
      id: "chg-conflict",
      kind: "modify",
      filePath: "project/a.md",
      blockIds: [],
      oldBlocks: [],
      newBlocks: [],
      headingPath: [],
      contextBefore: null,
      contextAfter: null,
      selected: true,
      state: "conflict"
    };
    const plan: ProjectChangePlan = {
      project,
      files: [
        {
          sourcePath: "project/a.md",
          translationPath: "project/translate/a.md",
          source: { frontmatter: null, body: "", blocks: [] },
          translation: null,
          changes: [conflict],
          conflicts: [conflict],
          currentTranslations: {},
          pendingTranslationIds: [],
          metadataChanged: false
        }
      ],
      changeCount: 0,
      conflictCount: 1
    };
    const { deps, calls } = makeDeps({ getChangePlan: () => plan });
    const controller = new TranslationController(deps);
    await controller.run();
    // 충돌만 있으면 번역할 변경 사항이 없으므로 rescan/saveSettings 없이 종료한다.
    expect(calls.rescan).toBe(0);
    expect(calls.saveSettings).toBe(0);
  });

  it("cancel() and dispose() are safe when no runner is active", () => {
    const { deps } = makeDeps();
    const controller = new TranslationController(deps);
    expect(() => controller.cancel()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });

  it("reports progress transition to started via onProgress", () => {
    const onProgress = vi.fn();
    const { deps } = makeDeps({ onProgress });
    const controller = new TranslationController(deps);
    // Simulate the runner reporting a running-then-idle progression.
    // The controller owns progress; onProgress should fire with becameRunning
    // only on the false->true transition.
    (controller as unknown as { onRunnerProgress: (p: unknown) => void })
      .onRunnerProgress({
        running: true,
        currentFile: "a.md",
        currentChangeId: null,
        completed: 0,
        failed: 0,
        total: 1,
        streamText: "",
        message: "번역 준비 중"
      });
    (controller as unknown as { onRunnerProgress: (p: unknown) => void })
      .onRunnerProgress({
        running: true,
        currentFile: "a.md",
        currentChangeId: null,
        completed: 1,
        failed: 0,
        total: 1,
        streamText: "",
        message: "완료"
      });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]?.[1]).toBe(true);
    expect(onProgress.mock.calls[1]?.[1]).toBe(false);
  });
});