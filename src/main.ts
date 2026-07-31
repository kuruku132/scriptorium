import {
  FuzzySuggestModal,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";
import {
  compileSnapshot,
  exportLorebookJson
} from "./modules/lorebook";
import {
  createProject,
  findProjectForPath,
  listSourceFiles,
  migrateRuntimeData,
  parseIgnoreRules,
  translationPathFor,
  writeVaultFile
} from "./modules/project";
import { runOneTimeLegacyVaultMigration } from "./modules/migration";
import {
  createLorebookBase,
  deduplicateKoreanParentheses,
  importRisuLorebook,
  mergeProjectMarkdown,
  parseRisuLorebook,
  readProjectDocumentSettings,
  setProjectDocumentIncluded as writeProjectDocumentIncluded,
  updateProjectMetadata,
  type MetadataUpdateMode,
  type ProjectDocumentSetting
} from "./modules/project-tools";
import {
  LocalSnapshotServer,
  RelaySynchronizer,
  type SyncStatus
} from "./modules/sync";
import {
  adoptManualTranslations,
  createInitialFileCache
} from "./modules/translation/cache";
import {
  createTranslationBatches,
  planFileChanges,
  reconcileChangeSelections
} from "./modules/translation/planner";
import { TranslationRunner } from "./modules/translation/runner";
import {
  extractKeys,
  parseMarkdown,
  renderMarkdown,
  stableHash
} from "./shared/markdown";
import {
  DEFAULT_SETTINGS,
  emptyProjectCache,
  type CachedBlock,
  type ChangeGroup,
  type FileCache,
  type FileChangePlan,
  type ProjectCache,
  type ProjectChangePlan,
  type ProjectConfig,
  type RuntimeData,
  type ScriptoriumSettings,
  type TranslationBatch,
  type TranslationBatchResult,
  type TranslationProgress
} from "./shared/types";
import {
  DASHBOARD_VIEW_TYPE,
  ScriptoriumDashboard,
  type DashboardHost
} from "./ui/dashboard";
import {
  ScriptoriumSettingTab,
  type SettingsHost
} from "./ui/settings";

class ProjectFolderModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: ScriptoriumPlugin["app"],
    private readonly choose: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("프로젝트 루트 폴더를 선택하세요");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path !== "/");
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.choose(folder);
  }
}

class JsonFileModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: ScriptoriumPlugin["app"],
    private readonly choose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("가져올 RisuAI 로어북 JSON을 선택하세요");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension === "json")
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

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

export default class ScriptoriumPlugin
  extends Plugin
  implements DashboardHost, SettingsHost
{
  settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  private data: RuntimeData = {
    settings: this.settings,
    caches: {}
  };
  private activeProject: ProjectConfig | null = null;
  private changePlan: ProjectChangePlan | null = null;
  private translationProgress: TranslationProgress = { ...EMPTY_PROGRESS };
  private runner: TranslationRunner | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private scanAgain = false;
  private renameGuard = false;
  private suppressVaultScan = 0;
  private localServer!: LocalSnapshotServer;
  private relay!: RelaySynchronizer;
  private syncStatus: SyncStatus = {
    local: "off",
    relay: "off",
    localMessage: "꺼짐",
    relayMessage: "꺼짐"
  };

  async onload(): Promise<void> {
    const raw = (await this.loadData()) as unknown;
    const activeFile = this.app.workspace.getActiveFile();
    this.data = await migrateRuntimeData(
      this.app,
      raw,
      activeFile?.path ?? null
    );
    this.settings = this.data.settings;
    await this.saveSettings();

    this.localServer = new LocalSnapshotServer(
      () => this.getSnapshot(),
      (message, error) => {
        this.syncStatus.local = error
          ? "error"
          : message === "꺼짐"
            ? "off"
            : "on";
        this.syncStatus.localMessage = message;
        this.refreshDashboard();
      }
    );
    this.relay = new RelaySynchronizer(
      () => this.getSnapshot(),
      (name) => this.app.secretStorage.getSecret(name),
      (message, error) => {
        this.syncStatus.relay = error
          ? "error"
          : message === "동기화 중"
            ? "syncing"
            : "on";
        this.syncStatus.relayMessage = message;
        this.refreshDashboard();
      }
    );

    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new ScriptoriumDashboard(leaf, this)
    );
    this.addRibbonIcon("book-open-text", "Scriptorium 대시보드", () => {
      void this.openDashboard();
    });
    this.addSettingTab(new ScriptoriumSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();

    this.app.workspace.onLayoutReady(() => {
      const current = this.app.workspace.getActiveFile();
      if (current) void this.followFile(current);
      void this.refreshRuntimeSettings();
    });
  }

  onunload(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.runner?.cancel();
    this.relay.cancelScheduled();
    void this.localServer.stop();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-dashboard",
      name: "대시보드 열기",
      callback: () => void this.openDashboard()
    });
    this.addCommand({
      id: "register-project",
      name: "프로젝트 등록",
      callback: () => this.openProjectRegistration()
    });
    this.addCommand({
      id: "run-translation",
      name: "번역 실행",
      callback: () => void this.runTranslation()
    });
    this.addCommand({
      id: "export-json",
      name: "JSON 내보내기",
      callback: () => void this.exportJson()
    });
    this.addCommand({
      id: "sync-relay-now",
      name: "릴레이에 지금 동기화",
      callback: () => void this.syncRelay()
    });
    this.addCommand({
      id: "cancel-work",
      name: "작업 취소",
      callback: () => this.cancelTranslation()
    });
    this.addCommand({
      id: "run-legacy-migration",
      name: "레거시 데이터 마이그레이션 실행",
      callback: () => void this.runLegacyMigration()
    });
  }

  private async runLegacyMigration(): Promise<void> {
    const projects = this.settings.projects;
    if (projects.length === 0) {
      new Notice("등록된 프로젝트가 없습니다.");
      return;
    }
    if (
      !window.confirm(
        `등록된 프로젝트 ${projects.length}개의 레거시 frontmatter와 risuignore.md 규칙을 현재 형식으로 마이그레이션할까요?`
      )
    ) {
      return;
    }

    const legacyIgnorePatterns: Record<string, string[]> = {};
    for (const project of projects) {
      const ignoreFile = this.app.vault.getFileByPath(
        `${project.root}/risuignore.md`
      );
      if (!ignoreFile) continue;
      const patterns = parseIgnoreRules(
        await this.app.vault.cachedRead(ignoreFile)
      );
      if (patterns.length > 0) {
        legacyIgnorePatterns[project.root] = patterns;
      }
    }

    this.suppressVaultScan += 1;
    try {
      const summary = await runOneTimeLegacyVaultMigration(
        this.app,
        projects,
        legacyIgnorePatterns
      );
      new Notice(
        `마이그레이션 완료: 검사 ${summary.scanned}, 변경 ${summary.changed}, 제외 변환 ${summary.ignored}`
      );
    } finally {
      this.suppressVaultScan -= 1;
    }
    await this.rescan();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) void this.followFile(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.onRename(file, oldPath);
      })
    );
  }

  private onVaultChange(file: TAbstractFile): void {
    if (this.suppressVaultScan > 0) return;
    const project = this.activeProject;
    if (!project || !(file instanceof TFile) || file.extension !== "md") return;
    if (
      file.path === project.root ||
      file.path.startsWith(`${project.root}/`)
    ) {
      this.scheduleScan();
    }
  }

  private async onRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (this.renameGuard || !(file instanceof TFile)) return;
    const project =
      findProjectForPath(this.settings.projects, oldPath) ??
      findProjectForPath(this.settings.projects, file.path);
    if (!project || oldPath.includes(`${project.root}/translate/`)) {
      this.scheduleScan();
      return;
    }

    const cache = this.projectCache(project);
    const cached = cache.files[oldPath];
    if (cached) {
      delete cache.files[oldPath];
      cached.sourcePath = file.path;
      cached.translationPath = translationPathFor(project, file.path);
      cache.files[file.path] = cached;
    }
    if (findProjectForPath([project], file.path)) {
      const oldTranslation = translationPathFor(project, oldPath);
      const newTranslation = translationPathFor(project, file.path);
      const translationFile = this.app.vault.getFileByPath(oldTranslation);
      if (
        translationFile &&
        !this.app.vault.getAbstractFileByPath(newTranslation)
      ) {
        this.renameGuard = true;
        try {
          await this.app.fileManager.renameFile(translationFile, newTranslation);
        } finally {
          this.renameGuard = false;
        }
      }
    }
    await this.saveSettings();
    const active = this.app.workspace.getActiveFile();
    if (active?.path === file.path) await this.followFile(active);
    else this.scheduleScan();
  }

  private async followFile(file: TFile): Promise<void> {
    const next = findProjectForPath(this.settings.projects, file.path);
    const changed = next?.id !== this.activeProject?.id;
    if (changed) this.runner?.cancel();
    this.activeProject = next;
    if (changed) {
      this.changePlan = null;
      this.relay.resetHash();
    }
    await this.rescan();
    this.relay.schedule(this.settings.relay);
  }

  private projectCache(project: ProjectConfig): ProjectCache {
    const existing = this.data.caches[project.id];
    if (existing) return existing;
    const created = emptyProjectCache();
    this.data.caches[project.id] = created;
    return created;
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.rescan();
    }, 250);
  }

  async rescan(): Promise<void> {
    if (this.scanning) {
      this.scanAgain = true;
      return;
    }
    this.scanning = true;
    try {
      await this.performScan();
    } finally {
      this.scanning = false;
      if (this.scanAgain) {
        this.scanAgain = false;
        await this.rescan();
      }
    }
  }

  private async performScan(): Promise<void> {
    const project = this.activeProject;
    if (!project) {
      this.changePlan = null;
      this.refreshDashboard();
      this.relay.schedule(this.settings.relay);
      return;
    }

    const projectCache = this.projectCache(project);
    const sourceFiles = await listSourceFiles(this.app, project);
    const filePlans: FileChangePlan[] = [];
    let dataChanged = false;

    for (const sourceFile of sourceFiles) {
      const source = parseMarkdown(await this.app.vault.cachedRead(sourceFile));
      const translationPath = translationPathFor(project, sourceFile.path);
      const translationFile = this.app.vault.getFileByPath(translationPath);
      const translation = translationFile
        ? parseMarkdown(await this.app.vault.cachedRead(translationFile))
        : null;
      let cache = projectCache.files[sourceFile.path];
      if (!cache) {
        cache = createInitialFileCache(
          sourceFile.path,
          translationPath,
          source,
          translation,
          sourceFile.basename
        );
        projectCache.files[sourceFile.path] = cache;
        dataChanged = true;
      }

      let plan = planFileChanges({
        sourcePath: sourceFile.path,
        translationPath,
        basename: sourceFile.basename,
        source,
        translation,
        cache,
        selectedChangeIds: new Set(projectCache.selectedChangeIds)
      });
      const currentSources = Object.fromEntries(
        plan.source.blocks.map((block) => [block.id, block.text])
      );
      const renderedTranslation = translation
        ? renderMarkdown(
          translation.frontmatter,
          translation.blocks
        )
        : null;
      if (
        translation &&
        plan.conflicts.length === 0 &&
        adoptManualTranslations(
          cache,
          plan.currentTranslations,
          currentSources
        )
      ) {
        cache.lastSuccessfulTranslation = renderedTranslation;
        dataChanged = true;
        plan = planFileChanges({
          sourcePath: sourceFile.path,
          translationPath,
          basename: sourceFile.basename,
          source: plan.source,
          translation,
          cache,
          selectedChangeIds: new Set(projectCache.selectedChangeIds)
        });
      }
      if (
        renderedTranslation !== null &&
        plan.conflicts.length === 0 &&
        renderedTranslation !== cache.lastSuccessfulTranslation
      ) {
        cache.lastSuccessfulTranslation = renderedTranslation;
        dataChanged = true;
      }
      filePlans.push(plan);
    }

    const nextSelection = reconcileChangeSelections(
      filePlans,
      projectCache.selectedChangeIds,
      projectCache.knownChangeIds ?? []
    );
    if (
      JSON.stringify(nextSelection.selectedChangeIds) !==
        JSON.stringify(projectCache.selectedChangeIds) ||
      JSON.stringify(nextSelection.knownChangeIds) !==
        JSON.stringify(projectCache.knownChangeIds ?? [])
    ) {
      projectCache.selectedChangeIds = nextSelection.selectedChangeIds;
      projectCache.knownChangeIds = nextSelection.knownChangeIds;
      dataChanged = true;
    }
    this.changePlan = {
      project,
      files: filePlans,
      changeCount: filePlans.reduce(
        (total, file) => total + file.changes.length,
        0
      ),
      conflictCount: filePlans.reduce(
        (total, file) => total + file.conflicts.length,
        0
      )
    };
    if (dataChanged) await this.saveSettings();
    this.refreshDashboard();
    this.relay.schedule(this.settings.relay);
  }

  private openProjectRegistration(): void {
    new ProjectFolderModal(this.app, (folder) => {
      void this.registerProject(folder);
    }).open();
  }

  private async registerProject(folder: TFolder): Promise<void> {
    try {
      const project = createProject(folder.path, this.settings.projects);
      this.settings.projects.push(project);
      this.data.caches[project.id] = emptyProjectCache();
      await this.saveSettings();
      new Notice(`Scriptorium 프로젝트를 등록했습니다: ${project.name}`);
      const current = this.app.workspace.getActiveFile();
      if (current) await this.followFile(current);
      await this.openDashboard();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async openDashboard(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      await leaf?.setViewState({
        type: DASHBOARD_VIEW_TYPE,
        active: true
      });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  private refreshDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      DASHBOARD_VIEW_TYPE
    )) {
      const view = leaf.view;
      if (view instanceof ScriptoriumDashboard) void view.refresh();
    }
  }

  getActiveProject(): ProjectConfig | null {
    return this.activeProject;
  }

  getGlobalTranslationPrompt(): string {
    return this.settings.translationPrompt;
  }

  async getProjectDocumentSettings(): Promise<ProjectDocumentSetting[]> {
    return this.activeProject
      ? readProjectDocumentSettings(this.app, this.activeProject)
      : [];
  }

  async updateActiveProjectSettings(value: {
    name: string;
    syncMode: "original" | "translated";
    translationPrompt: string;
  }): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    project.name = value.name.trim() || project.name;
    project.syncMode = value.syncMode;
    project.translationPrompt = value.translationPrompt;
    await this.saveSettings();
    this.relay.resetHash();
    await this.rescan();
  }

  async setProjectDocumentIncluded(
    path: string,
    included: boolean
  ): Promise<void> {
    const project = this.activeProject;
    if (!project || !path.startsWith(`${project.root}/`)) return;
    this.suppressVaultScan += 1;
    try {
      await writeProjectDocumentIncluded(this.app, path, included);
    } finally {
      this.suppressVaultScan -= 1;
    }
    await this.rescan();
  }

  getChangePlan(): ProjectChangePlan | null {
    return this.changePlan;
  }

  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  isRelayEnabled(): boolean {
    return this.settings.relay.enabled;
  }

  getTranslationProgress(): TranslationProgress {
    return { ...this.translationProgress };
  }

  async toggleSelection(changeId: string, selected: boolean): Promise<void> {
    await this.setSelections([changeId], selected);
  }

  async setSelections(
    changeIds: string[],
    selected: boolean
  ): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    const cache = this.projectCache(project);
    const selections = new Set(cache.selectedChangeIds);
    for (const changeId of changeIds) {
      if (selected) selections.add(changeId);
      else selections.delete(changeId);
    }
    cache.selectedChangeIds = [...selections];
    await this.saveSettings();
    await this.rescan();
  }

  async selectAll(selected: boolean): Promise<void> {
    const project = this.activeProject;
    const plan = this.changePlan;
    if (!project || !plan) return;
    this.projectCache(project).selectedChangeIds = selected
      ? plan.files.flatMap((file) =>
          file.changes
            .filter((change) => change.state !== "conflict")
            .map((change) => change.id)
        )
      : [];
    await this.saveSettings();
    await this.rescan();
  }

  async openSource(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
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
      !this.app.vault.getFileByPath(filePlan.translationPath)
    ) {
      return;
    }
    const content = renderMarkdown(
      filePlan.translation?.frontmatter ?? null,
      translatedBlocks
    );
    this.suppressVaultScan += 1;
    try {
      await writeVaultFile(this.app, filePlan.translationPath, content);
    } finally {
      this.suppressVaultScan -= 1;
    }
    cache.lastSuccessfulTranslation = content;
  }

  private async applyLocalChanges(
    plan: ProjectChangePlan,
    changes: ChangeGroup[]
  ): Promise<void> {
    const projectCache = this.projectCache(plan.project);
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
    if (local.length > 0) await this.saveSettings();
  }

  private deduplicateTranslationState(
    filePlan: FileChangePlan,
    cache: FileCache,
    translations: Record<string, string>
  ): void {
    if (!this.settings.advanced.deduplicateKoreanParentheses) return;
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
    const projectCache = this.projectCache(plan.project);
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

    if (result.keys) {
      cache.translatedKeys = [...new Set(result.keys)];
      cache.sourceKeys = extractKeys(
        filePlan.source,
        filePlan.sourcePath
          .split("/")
          .pop()
          ?.replace(/\.md$/i, "") ?? ""
      );
    }
    this.reorderCache(cache, filePlan);
    if (wroteCompletedChange) {
      await this.writeTranslationState(
        filePlan,
        cache,
        this.translationMap(filePlan, cache, false)
      );
    }
    await this.saveSettings();
    this.relay.schedule(this.settings.relay);
  }

  async runTranslation(): Promise<void> {
    if (this.runner) {
      new Notice("번역 작업이 이미 실행 중입니다.");
      return;
    }
    const project = this.activeProject;
    const plan = this.changePlan;
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
      await this.rescan();
      new Notice("로컬 변경 사항을 적용했습니다.");
      return;
    }
    const apiKey = this.settings.api.secretName
      ? this.app.secretStorage.getSecret(this.settings.api.secretName)
      : null;
    if (!apiKey) {
      await this.rescan();
      new Notice("설정에서 번역 API 키 비밀값을 선택해 주세요.");
      return;
    }

    this.runner = new TranslationRunner({
      api: this.settings.api,
      apiKey,
      globalPrompt:
        project.translationPrompt.trim() ||
        this.settings.translationPrompt,
      onProgress: (progress) => {
        this.translationProgress = progress;
        this.refreshDashboard();
      },
      onBatchResult: (batch, result) =>
        this.applyBatchResult(plan, batch, result)
    });
    try {
      const progress = await this.runner.run(batches);
      const summary = `번역 완료: 성공 ${progress.completed}, 실패 ${progress.failed}`;
      new Notice(summary);
    } finally {
      this.runner = null;
      await this.rescan();
    }
  }

  cancelTranslation(): void {
    if (!this.runner) {
      new Notice("실행 중인 작업이 없습니다.");
      return;
    }
    this.runner.cancel();
  }

  async exportJson(): Promise<void> {
    const project = this.activeProject;
    if (!project) {
      new Notice("활성 프로젝트가 없습니다.");
      return;
    }
    const path = await exportLorebookJson(
      this.app,
      project,
      this.projectCache(project).files
    );
    new Notice(`로어북을 내보냈습니다: ${path}`);
  }

  async importJson(): Promise<void> {
    const project = this.activeProject;
    if (!project) {
      new Notice("활성 프로젝트가 없습니다.");
      return;
    }
    new JsonFileModal(this.app, (file) => {
      void this.importJsonFile(project, file);
    }).open();
  }

  private async importJsonFile(
    project: ProjectConfig,
    file: TFile
  ): Promise<void> {
    if (
      !window.confirm(
        `"${file.path}"의 로어북을 "${project.name}"에 가져올까요? 같은 경로의 Markdown은 덮어씁니다.`
      )
    ) {
      return;
    }
    const lorebook = parseRisuLorebook(await this.app.vault.cachedRead(file));
    this.suppressVaultScan += 1;
    try {
      const summary = await importRisuLorebook(
        this.app,
        project,
        lorebook
      );
      new Notice(
        `로어북 가져오기 완료: 생성 ${summary.created}, 덮어쓰기 ${summary.overwritten}, 건너뜀 ${summary.skipped}`
      );
    } finally {
      this.suppressVaultScan -= 1;
    }
    await this.rescan();
  }

  async updateMetadata(mode: MetadataUpdateMode): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    if (
      mode !== "add" &&
      !window.confirm(
        mode === "replace"
          ? "모든 프로젝트 문서의 로어북 메타데이터를 기본값으로 교체할까요?"
          : "모든 프로젝트 문서에서 로어북 메타데이터를 제거할까요?"
      )
    ) {
      return;
    }
    this.suppressVaultScan += 1;
    try {
      const summary = await updateProjectMetadata(this.app, project, mode);
      new Notice(
        `메타데이터 ${mode}: 변경 ${summary.changed}, 건너뜀 ${summary.skipped}`
      );
    } finally {
      this.suppressVaultScan -= 1;
    }
    await this.rescan();
  }

  async openMetadataBase(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    const path = await createLorebookBase(this.app, project);
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async mergeMarkdown(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    this.suppressVaultScan += 1;
    try {
      const result = await mergeProjectMarkdown(this.app, project);
      new Notice(`병합 문서 생성 완료: ${result.count}개 → ${result.path}`);
    } finally {
      this.suppressVaultScan -= 1;
    }
  }

  async syncRelay(): Promise<void> {
    try {
      await this.relay.push(this.settings.relay, true);
      new Notice("릴레이에 현재 스냅샷을 전송했습니다.");
    } catch (error) {
      this.relay.noticeError(error);
    }
  }

  private async getSnapshot() {
    const project = this.activeProject;
    const files = project ? this.projectCache(project).files : {};
    return compileSnapshot(this.app, project, files);
  }

  async rebuildCache(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    if (!window.confirm("활성 프로젝트의 내부 문단 캐시를 재구축할까요?")) return;
    this.projectCache(project).files = {};
    await this.saveSettings();
    await this.rescan();
    new Notice("캐시를 재구축했습니다.");
  }

  async adoptExistingTranslations(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    const projectCache = this.projectCache(project);
    projectCache.files = {};
    projectCache.selectedChangeIds = [];
    projectCache.knownChangeIds = [];
    await this.saveSettings();
    await this.rescan();
    new Notice("현재 번역본을 새 기준으로 채택했습니다.");
  }

  async unregisterActiveProject(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    if (
      !window.confirm(
        `"${project.name}" 등록을 해제할까요? 프로젝트 파일은 삭제하지 않습니다.`
      )
    ) {
      return;
    }
    this.settings.projects = this.settings.projects.filter(
      (entry) => entry.id !== project.id
    );
    delete this.data.caches[project.id];
    this.activeProject = null;
    this.changePlan = null;
    await this.saveSettings();
    this.relay.resetHash();
    this.relay.schedule(this.settings.relay);
    this.refreshDashboard();
  }

  async resolveConflict(
    change: ChangeGroup,
    resolution: "manual" | "ai"
  ): Promise<void> {
    const project = this.activeProject;
    const plan = this.changePlan;
    if (!project || !plan) return;
    const filePlan = plan.files.find(
      (file) => file.sourcePath === change.filePath
    );
    const cache = this.projectCache(project).files[change.filePath];
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
        await this.saveSettings();
        await this.rescan();
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
      this.projectCache(project).selectedChangeIds =
        this.projectCache(project).selectedChangeIds.filter(
          (id) => id !== change.id
        );
      await this.writeTranslationState(filePlan, cache, translations);
      await this.saveSettings();
      await this.rescan();
      return;
    }

    if (orphanConflict) {
      cache.acceptedOrphanHash = this.hashOrphanBlocks(change);
      const selections = this.projectCache(project).selectedChangeIds;
      this.projectCache(project).selectedChangeIds = [
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
      await this.saveSettings();
      await this.rescan();
      await this.runTranslation();
      return;
    }

    for (const old of change.oldBlocks) {
      const cached = cache.blocks.find((block) => block.id === old.id);
      if (cached?.lastGenerated !== null && cached?.lastGenerated !== undefined) {
        translations[old.id] = cached.lastGenerated;
      }
    }
    await this.writeTranslationState(filePlan, cache, translations);
    this.projectCache(project).selectedChangeIds = [
      ...new Set([
        ...this.projectCache(project).selectedChangeIds,
        change.id
      ])
    ];
    await this.saveSettings();
    await this.rescan();
    await this.runTranslation();
  }

  private hashOrphanBlocks(change: ChangeGroup): string {
    return stableHash(change.oldBlocks.map((block) => block.text).join("\0"));
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  async refreshRuntimeSettings(): Promise<void> {
    try {
      await this.localServer.configure(this.settings.localServer);
    } catch (error) {
      this.syncStatus.local = "error";
      this.syncStatus.localMessage =
        error instanceof Error ? error.message : String(error);
    }
    if (!this.settings.relay.enabled) {
      this.syncStatus.relay = "off";
      this.syncStatus.relayMessage = "꺼짐";
      this.relay.cancelScheduled();
    } else {
      this.relay.schedule(this.settings.relay);
    }
    await this.rescan();
  }

}
