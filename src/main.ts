import {
  MarkdownView,
  Notice,
  Plugin,
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
  migrateRuntimeData,
  parseIgnoreRules
} from "./modules/project";
import { runOneTimeLegacyVaultMigration } from "./modules/migration";
import {
  createLorebookBase,
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
import { TranslationController } from "./modules/translation/controller";
import {
  DEFAULT_SETTINGS,
  emptyProjectCache,
  type ChangeGroup,
  type CbsMockMeta,
  type CbsTestValues,
  type LorebookDocumentProject,
  type ProjectCache,
  type ProjectChangePlan,
  type ProjectConfig,
  type RuntimeData,
  type ScriptoriumSettings,
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
import { ProjectFolderModal } from "./ui/modals/project-folder-modal";
import { JsonFileModal } from "./ui/modals/json-file-modal";
import {
  CBS_PANEL_VIEW_TYPE,
  CbsPanelView,
  type CbsPanelHost
} from "./ui/cbs-panel";
import {
  CBS_PREVIEW_VIEW_TYPE,
  CbsPreviewView
} from "./ui/cbs-preview";
import { CbsSnippetModal } from "./ui/snippet-modal";
import { VaultScanGuard } from "./app/vault-scan-guard";
import { ProjectRuntime } from "./app/project-runtime";
import { DocumentProjectCache } from "./app/document-project-cache";
import { ViewCoordinator } from "./app/view-coordinator";

const DEBUG = false;

export default class ScriptoriumPlugin
  extends Plugin
  implements DashboardHost, SettingsHost, CbsPanelHost
{
  settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  private data: RuntimeData = {
    settings: this.settings,
    caches: {}
  };
  private runtime!: ProjectRuntime;
  private translation!: TranslationController;
  private view!: ViewCoordinator;
  private readonly vaultScan = new VaultScanGuard();
  private localServer!: LocalSnapshotServer;
  private documentProjects!: DocumentProjectCache;
  private relay!: RelaySynchronizer;
  private syncStatus: SyncStatus = {
    local: "off",
    relay: "off",
    localMessage: "꺼짐",
    relayMessage: "꺼짐"
  };
  private cbsSaveTimer: ReturnType<typeof setTimeout> | null = null;

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

    this.view = new ViewCoordinator(this.app);

    this.documentProjects = new DocumentProjectCache({
      app: this.app,
      getSettings: () => this.settings,
      getProjectCache: (project) => this.getProjectCache(project),
      debug: (event, details) => this.debug(event, details)
    });

    this.localServer = new LocalSnapshotServer(
      (projectId) => this.getSnapshot(projectId),
      () =>
        this.settings.projects.map((project) => ({
          id: project.id,
          name: project.name,
          mode: project.syncMode
        })),
      (projectId) => this.getDocumentProject(projectId),
      (event, details) => this.debug(event, details),
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

    this.runtime = new ProjectRuntime({
      app: this.app,
      getSettings: () => this.settings,
      getProjectCache: (project) => this.getProjectCache(project),
      saveSettings: () => this.saveSettings(),
      scheduleRelay: () => this.relay.schedule(this.settings.relay),
      resetRelayHash: () => this.relay.resetHash(),
      refreshDashboard: () => this.refreshDashboard(),
      cancelTranslation: () => this.translation.cancel(),
      invalidateDocumentProject: (projectId) =>
        this.documentProjects.invalidate(projectId),
      isVaultScanSuppressed: () => this.vaultScan.isSuppressed(),
      withVaultScanSuppressed: (action) => this.vaultScan.withSuppressed(action),
      debug: (event, details) => this.debug(event, details)
    });

    this.translation = new TranslationController({
      app: this.app,
      getSettings: () => this.settings,
      getActiveProject: () => this.runtime.getActiveProject(),
      getChangePlan: () => this.runtime.getChangePlan(),
      getProjectCache: (project) => this.getProjectCache(project),
      saveSettings: () => this.saveSettings(),
      rescan: () => this.runtime.rescan(),
      scheduleRelay: () => this.relay.schedule(this.settings.relay),
      withVaultScanSuppressed: (action) =>
        this.vaultScan.withSuppressed(action),
      onProgress: (progress, becameRunning) => {
        if (becameRunning) {
          // 번역 시작 시 헤더의 실행 버튼을 중지 버튼으로 교체하기 위해
          // 헤더까지 포함한 전체 refresh를 수행한다.
          this.refreshDashboard();
        } else {
          this.scheduleProgressRefresh(!progress.running);
        }
      }
    });

    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new ScriptoriumDashboard(leaf, this)
    );
    this.registerView(
      CBS_PANEL_VIEW_TYPE,
      (leaf) => new CbsPanelView(leaf, this)
    );
    this.registerView(
      CBS_PREVIEW_VIEW_TYPE,
      (leaf) => new CbsPreviewView(leaf, this)
    );
    this.addRibbonIcon("book-open-text", "Scriptorium 대시보드", () => {
      void this.openDashboard();
    });
    this.addRibbonIcon("flask-conical", "CBS 테스트", () => {
      void this.openCbsPanel();
    });
    this.addSettingTab(new ScriptoriumSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();

    this.app.workspace.onLayoutReady(() => {
      const current = this.app.workspace.getActiveFile();
      if (current) void this.runtime.followFile(current);
      void this.refreshRuntimeSettings();
    });
  }

  onunload(): void {
    this.runtime.dispose();
    this.view.dispose();
    this.translation.dispose();
    this.relay.cancelScheduled();
    if (this.cbsSaveTimer) clearTimeout(this.cbsSaveTimer);
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
    this.addCommand({
      id: "open-cbs-panel",
      name: "CBS 테스트 패널 열기",
      callback: () => void this.openCbsPanel()
    });
    this.addCommand({
      id: "open-cbs-preview",
      name: "CBS 프리뷰 열기",
      callback: () => void this.openCbsPreview()
    });
    this.addCommand({
      id: "insert-cbs-snippet",
      name: "CBS 스니펫 삽입",
      callback: () => new CbsSnippetModal(this.app).open()
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

    await this.vaultScan.withSuppressed(async () => {
      const summary = await runOneTimeLegacyVaultMigration(
        this.app,
        projects,
        legacyIgnorePatterns
      );
      new Notice(
        `마이그레이션 완료: 검사 ${summary.scanned}, 변경 ${summary.changed}, 제외 변환 ${summary.ignored}`
      );
    });
    await this.rescan();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) void this.runtime.followFile(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.runtime.notifyVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.runtime.notifyVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.runtime.notifyVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.runtime.handleRename(file, oldPath);
      })
    );
  }

  /**
   * 프로젝트 캐시 저장소(data.caches)에 대한 접근자. 영속화 루트는
   * 플러그인이 소유하며, ProjectRuntime/TranslationController/플러그인 모두
   * 이 접근자로 ProjectCache 참조를 얻는다.
   */
  private getProjectCache(project: ProjectConfig): ProjectCache {
    const existing = this.data.caches[project.id];
    if (existing) return existing;
    const created = emptyProjectCache();
    this.data.caches[project.id] = created;
    return created;
  }

  async rescan(): Promise<void> {
    await this.runtime.rescan();
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
      if (current) await this.runtime.followFile(current);
      await this.openDashboard();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async openDashboard(): Promise<void> {
    await this.view.openDashboard();
  }

  private refreshDashboard(): void {
    this.view.refreshDashboard();
  }

  private scheduleProgressRefresh(immediate: boolean): void {
    this.view.scheduleProgressRefresh(immediate);
  }

  getActiveProject(): ProjectConfig | null {
    return this.runtime.getActiveProject();
  }

  getGlobalTranslationPrompt(): string {
    return this.settings.translationPrompt;
  }

  getGlobalTranslationGlossary(): string {
    return this.settings.translationGlossary;
  }

  // ── CbsPanelHost ───────────────────────────────────────────────
  // CBS 테스트 패널/프리뷰가 활성 Markdown 에디터 원문을 읽고 테스트 값을
  // 영속화할 수 있도록 플러그인이 제공하는 호스트 인터페이스.

  getActiveEditorText(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.editor.getValue() : null;
  }

  getActiveFilePath(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file.path : null;
  }

  getCbsTestValues(path: string): CbsTestValues {
    return (
      this.settings.cbsTestValues[path] ?? {
        chatVars: {},
        toggles: {}
      }
    );
  }

  getCbsMockMeta(): CbsMockMeta {
    return this.settings.cbsMockMeta;
  }

  setCbsChatVar(path: string, name: string, value: string): void {
    const values = this.ensureCbsTestValues(path);
    values.chatVars[name] = value;
    this.scheduleCbsSave();
  }

  setCbsToggle(path: string, name: string, value: boolean): void {
    const values = this.ensureCbsTestValues(path);
    values.toggles[name] = value;
    this.scheduleCbsSave();
  }

  resetCbsTestValues(path: string): void {
    delete this.settings.cbsTestValues[path];
    this.saveCbsSettings();
  }

  saveCbsSettings(): void {
    void this.saveSettings();
  }

  async openCbsPanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CBS_PANEL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false) ?? undefined;
      await leaf?.setViewState({
        type: CBS_PANEL_VIEW_TYPE,
        active: true
      });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  async openCbsPreview(): Promise<void> {
    // 프리뷰는 리본 사이드바(좌/우 리프)가 아니라 메인 에디터 영역의
    // 일반 마크다운 문서 탭처럼, 에디터 옆 50/50 수직 분할로 띄운다.
    const existing = this.app.workspace.getLeavesOfType(CBS_PREVIEW_VIEW_TYPE)[0];
    let leaf: WorkspaceLeaf | undefined = existing;
    // 기존 인스턴스가 좁은 사이드바에 있다면 메인 영역 분할로 옮긴다.
    if (existing) {
      const root = existing.getRoot();
      if (
        root === this.app.workspace.leftSplit ||
        root === this.app.workspace.rightSplit
      ) {
        existing.detach();
        leaf = undefined;
      }
    }
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({
        type: CBS_PREVIEW_VIEW_TYPE,
        active: true
      });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  private ensureCbsTestValues(path: string): CbsTestValues {
    const existing = this.settings.cbsTestValues[path];
    if (existing) return existing;
    const created: CbsTestValues = { chatVars: {}, toggles: {} };
    this.settings.cbsTestValues[path] = created;
    return created;
  }

  // CBS 테스트 값은 입력마다 갱신되므로 저장을 가볍게 디바운스(400ms).
  private scheduleCbsSave(): void {
    if (this.cbsSaveTimer) clearTimeout(this.cbsSaveTimer);
    this.cbsSaveTimer = setTimeout(() => {
      this.cbsSaveTimer = null;
      void this.saveSettings();
    }, 400);
  }

  async getProjectDocumentSettings(): Promise<ProjectDocumentSetting[]> {
    const project = this.runtime.getActiveProject();
    return project ? readProjectDocumentSettings(this.app, project) : [];
  }

  async updateActiveProjectSettings(value: {
    projectId: string;
    name: string;
    syncMode: "original" | "translated";
    translationPrompt: string;
    translationGlossary: string;
  }): Promise<void> {
    const project = this.settings.projects.find(
      (entry) => entry.id === value.projectId
    );
    if (!project) return;
    const nextName = value.name.trim() || project.name;
    if (
      project.name === nextName &&
      project.syncMode === value.syncMode &&
      project.translationPrompt === value.translationPrompt &&
      project.translationGlossary === value.translationGlossary
    ) {
      return;
    }
    project.name = nextName;
    project.syncMode = value.syncMode;
    project.translationPrompt = value.translationPrompt;
    project.translationGlossary = value.translationGlossary;
    this.documentProjects.invalidate(project.id);
    this.debug("cache.invalidate.project-settings", {
      projectId: project.id,
      name: project.name,
      mode: project.syncMode
    });
    await this.saveSettings();
    this.relay.resetHash();
    if (this.runtime.getActiveProject()?.id === project.id) await this.rescan();
    else this.refreshDashboard();
    new Notice(`프로젝트 설정을 저장했습니다: ${project.name}`);
  }

  async setProjectDocumentIncluded(
    path: string,
    included: boolean
  ): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project || !path.startsWith(`${project.root}/`)) return;
    await this.vaultScan.withSuppressed(() =>
      writeProjectDocumentIncluded(this.app, path, included)
    );
    await this.rescan();
  }

  getChangePlan(): ProjectChangePlan | null {
    return this.runtime.getChangePlan();
  }

  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  isRelayEnabled(): boolean {
    return this.settings.relay.enabled;
  }

  getTranslationProgress(): TranslationProgress {
    return this.translation.getProgress();
  }

  async toggleSelection(changeId: string, selected: boolean): Promise<void> {
    await this.runtime.toggleSelection(changeId, selected);
  }

  async setSelections(
    changeIds: string[],
    selected: boolean
  ): Promise<void> {
    await this.runtime.setSelections(changeIds, selected);
  }

  async selectAll(selected: boolean): Promise<void> {
    await this.runtime.selectAll(selected);
  }

  async openSource(path: string): Promise<void> {
    await this.view.openSource(path);
  }

  async runTranslation(): Promise<void> {
    await this.translation.run();
  }

  cancelTranslation(): void {
    this.translation.cancel();
  }

  async exportJson(): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project) {
      new Notice("활성 프로젝트가 없습니다.");
      return;
    }
    const path = await exportLorebookJson(
      this.app,
      project,
      this.getProjectCache(project).files
    );
    new Notice(`로어북을 내보냈습니다: ${path}`);
  }

  async importJson(): Promise<void> {
    const project = this.runtime.getActiveProject();
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
    await this.vaultScan.withSuppressed(async () => {
      const summary = await importRisuLorebook(
        this.app,
        project,
        lorebook
      );
      new Notice(
        `로어북 가져오기 완료: 생성 ${summary.created}, 덮어쓰기 ${summary.overwritten}, 건너뜀 ${summary.skipped}`
      );
    });
    await this.rescan();
  }

  async updateMetadata(mode: MetadataUpdateMode): Promise<void> {
    const project = this.runtime.getActiveProject();
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
    await this.vaultScan.withSuppressed(async () => {
      const summary = await updateProjectMetadata(this.app, project, mode);
      new Notice(
        `메타데이터 ${mode}: 변경 ${summary.changed}, 건너뜀 ${summary.skipped}`
      );
    });
    await this.rescan();
  }

  async openMetadataBase(): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project) return;
    const path = await createLorebookBase(this.app, project);
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async mergeMarkdown(): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project) return;
    await this.vaultScan.withSuppressed(async () => {
      const result = await mergeProjectMarkdown(this.app, project);
      new Notice(`병합 문서 생성 완료: ${result.count}개 → ${result.path}`);
    });
  }

  async syncRelay(): Promise<void> {
    try {
      await this.relay.push(this.settings.relay, true);
      new Notice("릴레이에 현재 스냅샷을 전송했습니다.");
    } catch (error) {
      this.relay.noticeError(error);
    }
  }

  private async getSnapshot(projectId?: string) {
    const project = projectId
      ? this.settings.projects.find((entry) => entry.id === projectId) ?? null
      : this.runtime.getActiveProject();
    const files = project ? this.getProjectCache(project).files : {};
    return compileSnapshot(this.app, project, files);
  }

  private getDocumentProject(
    projectId: string
  ): Promise<LorebookDocumentProject | null> {
    return this.documentProjects.get(projectId);
  }

  private debug(event: string, details: Record<string, unknown> = {}): void {
    if (!DEBUG) return;
    console.debug(
      `[Scriptorium DEBUG ${new Date().toISOString()}] ${event}`,
      details
    );
  }

  async rebuildCache(): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project) return;
    if (!window.confirm("활성 프로젝트의 내부 문단 캐시를 재구축할까요?")) return;
    this.getProjectCache(project).files = {};
    await this.saveSettings();
    await this.rescan();
    new Notice("캐시를 재구축했습니다.");
  }

  async adoptExistingTranslations(): Promise<void> {
    const project = this.runtime.getActiveProject();
    if (!project) return;
    const projectCache = this.getProjectCache(project);
    projectCache.files = {};
    projectCache.selectedChangeIds = [];
    projectCache.knownChangeIds = [];
    await this.saveSettings();
    await this.rescan();
    new Notice("현재 번역본을 새 기준으로 채택했습니다.");
  }

  async unregisterActiveProject(): Promise<void> {
    const project = this.runtime.getActiveProject();
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
    this.documentProjects.invalidate(project.id);
    this.runtime.clearActive();
    await this.saveSettings();
    this.relay.resetHash();
    this.relay.schedule(this.settings.relay);
    this.refreshDashboard();
  }

  async resolveConflict(
    change: ChangeGroup,
    resolution: "manual" | "ai"
  ): Promise<void> {
    await this.translation.resolveConflict(change, resolution);
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
      this.refreshDashboard();
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
