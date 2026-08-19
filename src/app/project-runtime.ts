import {
  App,
  TAbstractFile,
  TFile
} from "obsidian";
import {
  findProjectForPath,
  listSourceFiles,
  translationPathFor
} from "../modules/project";
import {
  adoptManualTranslations,
  createInitialFileCache
} from "../modules/translation/cache";
import {
  planFileChanges,
  reconcileChangeSelections
} from "../modules/translation/planner";
import { parseMarkdown, renderMarkdown } from "../shared/markdown";
import type {
  FileChangePlan,
  ProjectCache,
  ProjectChangePlan,
  ProjectConfig,
  ScriptoriumSettings
} from "../shared/types";

/**
 * 활성 프로젝트 추적, 변경 계획 계산, vault 검사 스케줄링, 이름 변경 가드,
 * 선택 변경 등 프로젝트 런타임 상태와 검사 수명주기를 담당한다.
 * ScriptoriumPlugin 객체 전체를 주입받지 않고 필요한 의존성만 받는다.
 */
export interface ProjectRuntimeDeps {
  app: App;
  getSettings(): ScriptoriumSettings;
  getProjectCache(project: ProjectConfig): ProjectCache;
  saveSettings(): Promise<void>;
  scheduleRelay(): void;
  resetRelayHash(): void;
  refreshDashboard(): void;
  cancelTranslation(): void;
  /** 캐시 항목이 실제로 존재해 삭제되었으면 true를 반환한다(debug용 hadCache). */
  invalidateDocumentProject(projectId: string): boolean;
  isVaultScanSuppressed(): boolean;
  debug(event: string, details?: Record<string, unknown>): void;
}

export class ProjectRuntime {
  private activeProject: ProjectConfig | null = null;
  private changePlan: ProjectChangePlan | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private scanAgain = false;
  private readonly renameGuardPaths = new Set<string>();

  constructor(private readonly deps: ProjectRuntimeDeps) {}

  getActiveProject(): ProjectConfig | null {
    return this.activeProject;
  }

  getChangePlan(): ProjectChangePlan | null {
    return this.changePlan;
  }

  /**
   * 활성 프로젝트를 해제한다. 등록 해제 등에서 외부에서 호출한다.
   * changePlan도 함께 비운다.
   */
  clearActive(): void {
    this.activeProject = null;
    this.changePlan = null;
  }

  async followFile(file: TFile): Promise<void> {
    const next = findProjectForPath(this.deps.getSettings().projects, file.path);
    const changed = next?.id !== this.activeProject?.id;
    if (changed) this.deps.cancelTranslation();
    this.activeProject = next;
    if (changed) {
      this.changePlan = null;
      this.deps.resetRelayHash();
    }
    await this.rescan();
    this.deps.scheduleRelay();
  }

  notifyVaultChange(file: TAbstractFile): void {
    const changedProject = findProjectForPath(
      this.deps.getSettings().projects,
      file.path
    );
    if (changedProject) {
      const hadCache = this.deps.invalidateDocumentProject(changedProject.id);
      this.deps.debug("cache.invalidate.vault", {
        projectId: changedProject.id,
        path: file.path,
        type: file.constructor.name,
        hadCache,
        suppressedScan: this.deps.isVaultScanSuppressed()
      });
    }
    if (this.deps.isVaultScanSuppressed()) return;
    const project = this.activeProject;
    if (!project || !(file instanceof TFile) || file.extension !== "md") return;
    if (
      file.path === project.root ||
      file.path.startsWith(`${project.root}/`)
    ) {
      this.scheduleScan();
    }
  }

  async handleRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (this.renameGuardPaths.has(file.path) || !(file instanceof TFile)) return;
    const settings = this.deps.getSettings();
    const previousProject = findProjectForPath(settings.projects, oldPath);
    const renamedProject = findProjectForPath(settings.projects, file.path);
    if (previousProject) this.deps.invalidateDocumentProject(previousProject.id);
    if (renamedProject) this.deps.invalidateDocumentProject(renamedProject.id);
    this.deps.debug("cache.invalidate.rename", {
      oldPath,
      newPath: file.path,
      previousProjectId: previousProject?.id ?? "",
      renamedProjectId: renamedProject?.id ?? ""
    });
    const project =
      findProjectForPath(settings.projects, oldPath) ??
      findProjectForPath(settings.projects, file.path);
    if (!project || oldPath.includes(`${project.root}/translate/`)) {
      this.scheduleScan();
      return;
    }

    const cache = this.deps.getProjectCache(project);
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
      const translationFile = this.deps.app.vault.getFileByPath(oldTranslation);
      if (
        translationFile &&
        !this.deps.app.vault.getAbstractFileByPath(newTranslation)
      ) {
        this.renameGuardPaths.add(newTranslation);
        try {
          await this.deps.app.fileManager.renameFile(
            translationFile,
            newTranslation
          );
        } finally {
          this.renameGuardPaths.delete(newTranslation);
        }
      }
    }
    await this.deps.saveSettings();
    const active = this.deps.app.workspace.getActiveFile();
    if (active?.path === file.path) await this.followFile(active);
    else this.scheduleScan();
  }

  scheduleScan(): void {
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
      this.deps.refreshDashboard();
      this.deps.scheduleRelay();
      return;
    }

    const projectCache = this.deps.getProjectCache(project);
    const sourceFiles = await listSourceFiles(this.deps.app, project);
    const filePlans: FileChangePlan[] = [];
    let dataChanged = false;

    for (const sourceFile of sourceFiles) {
      const source = parseMarkdown(await this.deps.app.vault.cachedRead(sourceFile));
      const translationPath = translationPathFor(project, sourceFile.path);
      const translationFile = this.deps.app.vault.getFileByPath(translationPath);
      const translation = translationFile
        ? parseMarkdown(await this.deps.app.vault.cachedRead(translationFile))
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
    if (dataChanged) await this.deps.saveSettings();
    this.deps.refreshDashboard();
    this.deps.scheduleRelay();
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
    const cache = this.deps.getProjectCache(project);
    const selections = new Set(cache.selectedChangeIds);
    for (const changeId of changeIds) {
      if (selected) selections.add(changeId);
      else selections.delete(changeId);
    }
    cache.selectedChangeIds = [...selections];
    await this.deps.saveSettings();
    await this.rescan();
  }

  async selectAll(selected: boolean): Promise<void> {
    const project = this.activeProject;
    const plan = this.changePlan;
    if (!project || !plan) return;
    this.deps.getProjectCache(project).selectedChangeIds = selected
      ? plan.files.flatMap((file) =>
          file.changes
            .filter((change) => change.state !== "conflict")
            .map((change) => change.id)
        )
      : [];
    await this.deps.saveSettings();
    await this.rescan();
  }

  dispose(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
  }
}