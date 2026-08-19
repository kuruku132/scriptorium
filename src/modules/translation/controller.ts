import { App, Notice } from "obsidian";
import { writeVaultFile } from "../project";
import { deduplicateKoreanParentheses } from "../project-tools";
import { createTranslationBatches } from "./planner";
import { TranslationRunner } from "./runner";
import {
  extractKeys,
  normalizeKeys,
  renderMarkdown,
  stableHash,
  withFrontmatterKeys
} from "../../shared/markdown";
import type {
  CachedBlock,
  ChangeGroup,
  FileCache,
  FileChangePlan,
  ProjectCache,
  ProjectChangePlan,
  ProjectConfig,
  ScriptoriumSettings,
  TranslationBatch,
  TranslationBatchResult,
  TranslationProgress
} from "../../shared/types";

const EMPTY_PROGRESS: TranslationProgress = {
  running: false,
  currentFile: null,
  currentChangeId: null,
  completed: 0,
  failed: 0,
  total: 0,
  streamText: "",
  message: "대기"
};

/**
 * 번역 실행 워크플로와 번역 상태 변경을 담당한다.
 * 현재 실행 중인 TranslationRunner, 번역 진행률, 로컬 변경 적용, 배치 결과 반영,
 * 번역 캐시/파일 상태 기록, 충돌 해결을 이 컨트롤러가 소유한다.
 * ScriptoriumPlugin 객체 전체를 주입받지 않고 필요한 의존성만 받는다.
 */
export interface TranslationControllerDeps {
  app: App;
  getSettings(): ScriptoriumSettings;
  getActiveProject(): ProjectConfig | null;
  getChangePlan(): ProjectChangePlan | null;
  getProjectCache(project: ProjectConfig): ProjectCache;
  saveSettings(): Promise<void>;
  rescan(): Promise<void>;
  scheduleRelay(): void;
  withVaultScanSuppressed<T>(action: () => Promise<T>): Promise<T>;
  /**
   * 번역 진행률이 갱신될 때 호출된다.
   * becameRunning은 대기 상태에서 실행 상태로 전환된 시점이며,
   * 호스트는 이때 헤더(실행/중지 버튼)까지 포함한 전체 refresh를 수행한다.
   * 그 외에는 진행률 영역만 갱신하면 된다.
   */
  onProgress(
    progress: TranslationProgress,
    becameRunning: boolean
  ): void;
}

export class TranslationController {
  private runner: TranslationRunner | null = null;
  private progress: TranslationProgress = { ...EMPTY_PROGRESS };

  constructor(private readonly deps: TranslationControllerDeps) {}

  getProgress(): TranslationProgress {
    return { ...this.progress };
  }

  /**
   * 번역을 실행한다. 이미 실행 중이면 거부하고, 활성 프로젝트/변경 계획/API 키가
   * 없으면 안내 후 종료한다. 로컬 delete/move 변경을 먼저 적용한 뒤 배치를 만들어
   * TranslationRunner로 실행한다. 완료/실패/취소 여부와 관계없이 finally에서
   * runner를 비우고 rescan한다.
   */
  async run(): Promise<void> {
    if (this.runner) {
      new Notice("번역 작업이 이미 실행 중입니다.");
      return;
    }
    const project = this.deps.getActiveProject();
    const plan = this.deps.getChangePlan();
    if (!project || !plan) {
      new Notice("활성 프로젝트가 없습니다.");
      return;
    }
    const eligible = this.eligibleChanges(plan);
    if (eligible.length === 0) {
      new Notice("번역할 변경 사항이 없습니다.");
      return;
    }
    await this.applyLocalChanges(plan, eligible);
    const batches = createTranslationBatches(plan.files);
    if (batches.length === 0) {
      await this.deps.rescan();
      new Notice("로컬 변경 사항을 적용했습니다.");
      return;
    }
    const settings = this.deps.getSettings();
    const apiKey = settings.api.secretName
      ? this.deps.app.secretStorage.getSecret(settings.api.secretName)
      : null;
    if (!apiKey) {
      await this.deps.rescan();
      new Notice("설정에서 번역 API 키 비밀값을 선택해 주세요.");
      return;
    }

    this.runner = new TranslationRunner({
      api: settings.api,
      apiKey,
      globalPrompt:
        project.translationPrompt.trim() ||
        settings.translationPrompt,
      glossary:
        project.translationGlossary.trim() ||
        settings.translationGlossary,
      maxParallel:
        settings.advanced.maxParallelTranslations,
      onProgress: (progress) => this.onRunnerProgress(progress),
      onBatchResult: (batch, result) =>
        this.applyBatchResult(plan, batch, result)
    });
    try {
      const progress = await this.runner.run(batches);
      const summary = `번역 완료: 성공 ${progress.completed}, 실패 ${progress.failed}`;
      new Notice(summary);
    } finally {
      this.runner = null;
      await this.deps.rescan();
    }
  }

  cancel(): void {
    if (!this.runner) {
      new Notice("실행 중인 작업이 없습니다.");
      return;
    }
    this.runner.cancel();
  }

  dispose(): void {
    this.runner?.cancel();
  }

  private onRunnerProgress(progress: TranslationProgress): void {
    const wasRunning = this.progress.running;
    this.progress = progress;
    this.deps.onProgress(progress, !wasRunning && progress.running);
  }

  private eligibleChanges(plan: ProjectChangePlan): ChangeGroup[] {
    return plan.files
      .flatMap((file) => file.changes)
      .filter(
        (change) => change.state !== "conflict" && change.selected
      );
  }

  private translationMap(
    filePlan: FileChangePlan,
    cache: FileCache,
    includePending = true
  ): Record<string, string> {
    const result = { ...filePlan.currentTranslations };
    for (const block of cache.blocks) {
      if (
        result[block.id] === undefined &&
        block.lastGenerated !== null
      ) {
        result[block.id] = block.lastGenerated;
      }
    }
    if (!includePending) {
      for (const id of Object.keys(cache.pendingTranslations ?? {})) {
        delete result[id];
      }
    }
    return result;
  }

  private reorderCache(
    cache: FileCache,
    filePlan: FileChangePlan
  ): void {
    const byId = new Map(cache.blocks.map((block) => [block.id, block]));
    const currentIds = new Set(filePlan.source.blocks.map((block) => block.id));
    const ordered = filePlan.source.blocks
      .map((block) => byId.get(block.id))
      .filter((block): block is CachedBlock => Boolean(block));
    const pendingDeleted = cache.blocks.filter(
      (block) => !currentIds.has(block.id)
    );
    cache.blocks = [...ordered, ...pendingDeleted];
  }

  private async writeTranslationState(
    filePlan: FileChangePlan,
    cache: FileCache,
    translations: Record<string, string>
  ): Promise<void> {
    const translatedBlocks = filePlan.source.blocks.flatMap((sourceBlock) => {
      const text = translations[sourceBlock.id];
      return text === undefined ? [] : [{ ...sourceBlock, text }];
    });
    if (
      translatedBlocks.length === 0 &&
      !this.deps.app.vault.getFileByPath(filePlan.translationPath)
    ) {
      return;
    }
    // 번역 파일의 frontmatter는 기존 번역본이 있으면 그것을 기준으로,
    // 없으면 원문 frontmatter를 가져와 keys를 번역된 키로 교체한다.
    // 이렇게 하지 않으면 첫 번역 시 원문 frontmatter가 통째로 사라진다.
    const baseFrontmatter =
      filePlan.translation?.frontmatter ?? filePlan.source.frontmatter ?? null;
    // base frontmatter가 없으면 keys를 위해 frontmatter를 새로 만들지 않는다.
    // 원문에 frontmatter가 없는데 번역 파일에 keys만 있는 frontmatter가
    // 생기는 것을 방지한다.
    const frontmatter =
      baseFrontmatter && cache.translatedKeys.length > 0
        ? withFrontmatterKeys(baseFrontmatter, cache.translatedKeys)
        : baseFrontmatter;
    const content = renderMarkdown(frontmatter, translatedBlocks);
    await this.deps.withVaultScanSuppressed(() =>
      writeVaultFile(this.deps.app, filePlan.translationPath, content)
    );
    cache.lastSuccessfulTranslation = content;
  }

  private async applyLocalChanges(
    plan: ProjectChangePlan,
    changes: ChangeGroup[]
  ): Promise<void> {
    const projectCache = this.deps.getProjectCache(plan.project);
    const local = changes.filter(
      (change) => change.kind === "delete" || change.kind === "move"
    );
    const byFile = new Map<string, ChangeGroup[]>();
    for (const change of local) {
      const list = byFile.get(change.filePath) ?? [];
      list.push(change);
      byFile.set(change.filePath, list);
    }

    for (const [filePath, fileChanges] of byFile) {
      const filePlan = plan.files.find((file) => file.sourcePath === filePath);
      const cache = projectCache.files[filePath];
      if (!filePlan || !cache) continue;
      const translations = this.translationMap(filePlan, cache);
      for (const change of fileChanges) {
        if (change.kind === "delete") {
          const removed = new Set(change.oldBlocks.map((block) => block.id));
          cache.blocks = cache.blocks.filter((block) => !removed.has(block.id));
          for (const id of removed) {
            delete translations[id];
            if (cache.pendingTranslations) {
              delete cache.pendingTranslations[id];
            }
          }
        }
        if (change.kind === "move") {
          for (const block of change.newBlocks) {
            const cached = cache.blocks.find((entry) => entry.id === block.id);
            if (cached) {
              cached.lastSource = block.text;
              cached.headingPath = [...block.headingPath];
            }
          }
        }
        projectCache.selectedChangeIds =
          projectCache.selectedChangeIds.filter((id) => id !== change.id);
      }
      this.reorderCache(cache, filePlan);
      await this.writeTranslationState(filePlan, cache, translations);
    }
    if (local.length > 0) await this.deps.saveSettings();
  }

  private deduplicateTranslationState(
    filePlan: FileChangePlan,
    cache: FileCache,
    translations: Record<string, string>
  ): void {
    if (!this.deps.getSettings().advanced.deduplicateKoreanParentheses) return;
    const seen = new Set<string>();
    cache.pendingTranslations ??= {};
    for (const source of filePlan.source.blocks) {
      const current = translations[source.id];
      if (current === undefined) continue;
      const processed = deduplicateKoreanParentheses(current, seen);
      translations[source.id] = processed;
      if (filePlan.currentTranslations[source.id] !== undefined) {
        filePlan.currentTranslations[source.id] = processed;
      }
      if (cache.pendingTranslations[source.id] !== undefined) {
        cache.pendingTranslations[source.id] = processed;
      }
      const cached = cache.blocks.find((block) => block.id === source.id);
      if (cached?.lastGenerated !== null && cached?.lastGenerated !== undefined) {
        cached.lastGenerated = processed;
      }
    }
  }

  private async applyBatchResult(
    plan: ProjectChangePlan,
    batch: TranslationBatch,
    result: TranslationBatchResult
  ): Promise<void> {
    const filePlan = plan.files.find(
      (file) => file.sourcePath === batch.filePath
    );
    const projectCache = this.deps.getProjectCache(plan.project);
    const cache = projectCache.files[batch.filePath];
    if (!filePlan || !cache) {
      throw new Error(`번역 결과를 적용할 파일을 찾지 못했습니다: ${batch.filePath}`);
    }
    const translations = this.translationMap(filePlan, cache);
    const translatedById = Object.fromEntries(
      result.blocks.map((block) => [block.id, block.text])
    );
    cache.pendingTranslations ??= {};
    Object.assign(cache.pendingTranslations, translatedById);
    Object.assign(translations, translatedById);
    Object.assign(filePlan.currentTranslations, translatedById);
    this.deduplicateTranslationState(filePlan, cache, translations);
    let wroteCompletedChange = false;

    for (const changeId of batch.changeIds) {
      const change = filePlan.changes.find((entry) => entry.id === changeId);
      if (!change) continue;
      const newIds = new Set(change.newBlocks.map((block) => block.id));
      const oldIds = new Set(change.oldBlocks.map((block) => block.id));
      const complete =
        change.kind === "metadata"
          ? result.keys !== undefined
          : change.newBlocks.every(
              (block) => translations[block.id] !== undefined
            );
      if (complete) {
        if (change.kind !== "metadata") wroteCompletedChange = true;
        cache.blocks = cache.blocks.filter(
          (block) => !oldIds.has(block.id) || newIds.has(block.id)
        );
        for (const block of change.newBlocks) {
          const translated = translations[block.id];
          if (translated === undefined) continue;
          const cached = cache.blocks.find((entry) => entry.id === block.id);
          if (cached) {
            cached.kind = block.kind;
            cached.lastSource = block.text;
            cached.lastGenerated = translated;
            cached.headingPath = [...block.headingPath];
          } else {
            cache.blocks.push({
              id: block.id,
              kind: block.kind,
              lastSource: block.text,
              lastGenerated: translated,
              headingPath: [...block.headingPath]
            });
          }
          delete cache.pendingTranslations[block.id];
        }
        projectCache.selectedChangeIds =
          projectCache.selectedChangeIds.filter((id) => id !== change.id);
      }
    }

    // 키 번역은 실제로 키를 요청한 배치(batch.translateKeys가 비어 있지 않은
    // 메타데이터 배치, 또는 키와 본문이 함께 담긴 배치)의 결과만 반영한다.
    // 본문 전용 배치가 keys를 거짓으로 반환해 메타데이터 배치가 번역한 키를
    // 덮어쓰는 일(특히 메타데이터 배치가 먼저 끝난 첫 번역 시나리오)을 막는다.
    const translatedKeysUpdated =
      Array.isArray(result.keys) &&
      result.keys.length > 0 &&
      batch.translateKeys.length > 0;
    if (translatedKeysUpdated) {
      cache.translatedKeys = normalizeKeys(result.keys ?? []);
      cache.sourceKeys = extractKeys(
        filePlan.source,
        filePlan.sourcePath
          .split("/")
          .pop()
          ?.replace(/\.md$/i, "") ?? ""
      );
    }
    this.reorderCache(cache, filePlan);
    // 메타데이터(키) 변경은 본문 블록이 없더라도 frontmatter의 keys를
    // 갱신하기 위해 번역 파일을 다시 작성해야 한다.
    if (wroteCompletedChange || translatedKeysUpdated) {
      await this.writeTranslationState(
        filePlan,
        cache,
        this.translationMap(filePlan, cache, false)
      );
    }
    await this.deps.saveSettings();
    this.deps.scheduleRelay();
  }

  async resolveConflict(
    change: ChangeGroup,
    resolution: "manual" | "ai"
  ): Promise<void> {
    const project = this.deps.getActiveProject();
    const plan = this.deps.getChangePlan();
    if (!project || !plan) return;
    const filePlan = plan.files.find(
      (file) => file.sourcePath === change.filePath
    );
    const cache = this.deps.getProjectCache(project).files[change.filePath];
    if (!filePlan || !cache) return;
    const translations = this.translationMap(filePlan, cache);
    const orphanConflict =
      change.newBlocks.length === 0 &&
      change.message?.includes("고아 문단") === true;

    if (resolution === "manual") {
      if (orphanConflict) {
        cache.acceptedOrphanHash = this.hashOrphanBlocks(change);
        if (filePlan.translation) {
          cache.lastSuccessfulTranslation = renderMarkdown(
            filePlan.translation.frontmatter,
            filePlan.translation.blocks
          );
        }
        await this.deps.saveSettings();
        await this.deps.rescan();
        return;
      }
      for (const source of change.newBlocks) {
        const translated = translations[source.id];
        const cached = cache.blocks.find((block) => block.id === source.id);
        if (translated !== undefined && cached) {
          cached.lastSource = source.text;
          cached.lastGenerated = translated;
          cached.headingPath = [...source.headingPath];
        }
      }
      const projectCache = this.deps.getProjectCache(project);
      projectCache.selectedChangeIds = projectCache.selectedChangeIds.filter(
        (id) => id !== change.id
      );
      await this.writeTranslationState(filePlan, cache, translations);
      await this.deps.saveSettings();
      await this.deps.rescan();
      return;
    }

    if (orphanConflict) {
      cache.acceptedOrphanHash = this.hashOrphanBlocks(change);
      const projectCache = this.deps.getProjectCache(project);
      const selections = projectCache.selectedChangeIds;
      projectCache.selectedChangeIds = [
        ...new Set([
          ...selections.filter((id) => id !== change.id),
          ...filePlan.changes
            .filter(
              (entry) =>
                entry.id !== change.id && entry.state !== "conflict"
            )
            .map((entry) => entry.id)
        ])
      ];
      await this.deps.saveSettings();
      await this.deps.rescan();
      await this.run();
      return;
    }

    for (const old of change.oldBlocks) {
      const cached = cache.blocks.find((block) => block.id === old.id);
      if (cached?.lastGenerated !== null && cached?.lastGenerated !== undefined) {
        translations[old.id] = cached.lastGenerated;
      }
    }
    await this.writeTranslationState(filePlan, cache, translations);
    const projectCache = this.deps.getProjectCache(project);
    projectCache.selectedChangeIds = [
      ...new Set([...projectCache.selectedChangeIds, change.id])
    ];
    await this.deps.saveSettings();
    await this.deps.rescan();
    await this.run();
  }

  private hashOrphanBlocks(change: ChangeGroup): string {
    return stableHash(change.oldBlocks.map((block) => block.text).join("\0"));
  }
}