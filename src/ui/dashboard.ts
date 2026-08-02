import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type {
  ChangeGroup,
  ProjectChangePlan,
  ProjectConfig,
  TranslationProgress
} from "../shared/types";
import type { SyncStatus } from "../modules/sync";
import type {
  MetadataUpdateMode,
  ProjectDocumentSetting
} from "../modules/project-tools";

export const DASHBOARD_VIEW_TYPE = "scriptorium-dashboard";

export interface DashboardHost {
  getActiveProject(): ProjectConfig | null;
  getGlobalTranslationPrompt(): string;
  getGlobalTranslationGlossary(): string;
  getProjectDocumentSettings(): Promise<ProjectDocumentSetting[]>;
  updateActiveProjectSettings(value: {
    name: string;
    syncMode: "original" | "translated";
    translationPrompt: string;
    translationGlossary: string;
  }): Promise<void>;
  setProjectDocumentIncluded(
    path: string,
    included: boolean
  ): Promise<void>;
  getChangePlan(): ProjectChangePlan | null;
  getSyncStatus(): SyncStatus;
  isRelayEnabled(): boolean;
  getTranslationProgress(): TranslationProgress;
  toggleSelection(changeId: string, selected: boolean): Promise<void>;
  setSelections(changeIds: string[], selected: boolean): Promise<void>;
  selectAll(selected: boolean): Promise<void>;
  openSource(path: string): Promise<void>;
  runTranslation(): Promise<void>;
  exportJson(): Promise<void>;
  importJson(): Promise<void>;
  updateMetadata(mode: MetadataUpdateMode): Promise<void>;
  openMetadataBase(): Promise<void>;
  mergeMarkdown(): Promise<void>;
  syncRelay(): Promise<void>;
  cancelTranslation(): void;
  rescan(): Promise<void>;
  rebuildCache(): Promise<void>;
  adoptExistingTranslations(): Promise<void>;
  unregisterActiveProject(): Promise<void>;
  resolveConflict(
    change: ChangeGroup,
    resolution: "manual" | "ai"
  ): Promise<void>;
}

function button(
  parent: HTMLElement,
  text: string,
  action: () => void | Promise<void>,
  icon?: string,
  tooltip?: string
): HTMLButtonElement {
  const element = parent.createEl("button", { text });
  if (tooltip) {
    element.setAttrs({
      "aria-label": tooltip,
      "data-tooltip-position": "bottom"
    });
  }
  if (icon) {
    element.empty();
    const iconElement = element.createSpan();
    setIcon(iconElement, icon);
    element.createSpan({ text });
  }
  element.addEventListener("click", () => {
    Promise.resolve(action()).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  });
  return element;
}

function projectRelativePath(
  project: ProjectConfig,
  path: string
): string {
  const root = project.root.replace(/^\/+|\/+$/g, "");
  const normalized = path.replace(/^\/+/, "");
  if (root === "") return normalized;
  const prefix = `${root}/`;
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
}

function statusPill(
  parent: HTMLElement,
  label: string,
  value: string,
  error = false
): void {
  parent.createSpan({
    cls: `scriptorium-status ${value === "꺼짐" ? "" : "is-on"} ${
      error ? "is-error" : ""
    }`,
    text: `${label}: ${value}`
  });
}

const CHANGE_LABELS: Record<ChangeGroup["kind"], string> = {
  insert: "추가됨",
  modify: "수정됨",
  delete: "삭제됨",
  move: "이동됨",
  split: "분할됨",
  merge: "병합됨",
  metadata: "키워드 변경"
};

function compactText(value: string, limit = 52): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") return "(없음)";
  return compact.length > limit
    ? `${compact.slice(0, limit - 1)}…`
    : compact;
}

function changePreview(change: ChangeGroup): string {
  const oldText = change.oldBlocks.map((block) => block.text).join("\n\n");
  const newText = change.newBlocks.map((block) => block.text).join("\n\n");
  if (change.kind === "insert") return `+ ${compactText(newText, 86)}`;
  if (change.kind === "delete") return `− ${compactText(oldText, 86)}`;
  if (change.kind === "move") {
    const oldPath = change.oldBlocks[0]?.headingPath.join(" › ");
    const newPath = change.newBlocks[0]?.headingPath.join(" › ");
    if (oldPath && newPath && oldPath !== newPath) {
      return `${oldPath} → ${newPath}`;
    }
    return `위치 이동 · ${compactText(newText || oldText, 70)}`;
  }
  if (change.kind === "metadata") {
    return change.message?.replace(/^keys:\s*/i, "키워드 · ") ??
      "문서 키워드가 변경되었습니다.";
  }
  return `${compactText(oldText)} → ${compactText(newText)}`;
}

function changeCountSummary(changes: ChangeGroup[]): string {
  const order: ChangeGroup["kind"][] = [
    "insert",
    "modify",
    "delete",
    "move",
    "split",
    "merge",
    "metadata"
  ];
  const counts = new Map<ChangeGroup["kind"], number>();
  for (const change of changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => `${CHANGE_LABELS[kind].replace(/됨$/, "")} ${counts.get(kind)}`)
    .join(" · ");
}

function renderDiffContent(
  parent: HTMLElement,
  change: ChangeGroup
): void {
  const oldText = change.oldBlocks.map((block) => block.text).join("\n\n");
  const newText = change.newBlocks.map((block) => block.text).join("\n\n");
  parent.createEl("pre", {
    cls: "scriptorium-diff-old",
    text: oldText === "" ? "(없음)" : `- ${oldText}`
  });
  parent.createEl("pre", {
    cls: "scriptorium-diff-new",
    text: newText === "" ? "(없음)" : `+ ${newText}`
  });
}

function renderDiff(parent: HTMLElement, change: ChangeGroup): void {
  const details = parent.createEl("details");
  details.createEl("summary", { text: "이전/현재 원문" });
  renderDiffContent(details, change);
}

export class ScriptoriumDashboard extends ItemView {
  private readonly expandedDocuments = new Set<string>();
  private readonly expandedChanges = new Set<string>();
  private projectSettingsOpen = false;
  private documentSettingsOpen = false;
  private advancedToolsOpen = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: DashboardHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Scriptorium";
  }

  getIcon(): string {
    return "book-open-text";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  private renderHeader(
    container: HTMLElement,
    project: ProjectConfig,
    plan: ProjectChangePlan | null
  ): void {
    const header = container.createDiv("scriptorium-header");
    header.createEl("h2", { text: project.name });
    header.createDiv({
      text: `${project.root} · ${
        project.syncMode === "original" ? "원문" : "번역"
      } 모드`
    });
    const stats = header.createDiv("scriptorium-status-row");
    statusPill(stats, "변경", String(plan?.changeCount ?? 0));
    statusPill(stats, "충돌", String(plan?.conflictCount ?? 0), Boolean(plan?.conflictCount));
    const sync = this.host.getSyncStatus();
    statusPill(stats, "로컬", sync.localMessage, sync.local === "error");
    statusPill(stats, "릴레이", sync.relayMessage, sync.relay === "error");
    const actions = header.createDiv("scriptorium-actions");
    button(
      actions,
      "번역 실행",
      () => this.host.runTranslation(),
      "languages",
      "선택한 변경 사항의 번역을 실행합니다."
    );
    button(
      actions,
      "JSON",
      () => this.host.exportJson(),
      "file-json",
      "현재 프로젝트를 RisuAI 로어북 JSON으로 내보냅니다."
    );
    if (this.host.isRelayEnabled()) {
      button(
        actions,
        "릴레이 갱신",
        () => this.host.syncRelay(),
        "refresh-cw",
        "현재 스냅샷을 릴레이에 즉시 전송합니다."
      );
    }
  }

  private renderChange(
    parent: HTMLElement,
    change: ChangeGroup,
    conflict = false
  ): void {
    const row = parent.createDiv(
      `scriptorium-change ${conflict ? "scriptorium-conflict" : ""}`
    );
    const head = row.createDiv("scriptorium-change-head");
    const checkbox = head.createEl("input", { type: "checkbox" });
    checkbox.addClass("scriptorium-change-select");
    checkbox.checked = change.selected;
    checkbox.disabled = conflict;
    checkbox.addEventListener("change", () => {
      void this.host.toggleSelection(change.id, checkbox.checked);
    });
    head.createSpan({
      cls: `scriptorium-change-kind is-${change.kind}`,
      text: CHANGE_LABELS[change.kind]
    });
    head.createEl("strong", {
      text: change.headingPath.join(" › ") || "문서 루트"
    });
    if (change.message) row.createDiv({ text: change.message });
    renderDiff(row, change);
    if (conflict) {
      const actions = row.createDiv("scriptorium-actions");
      button(actions, "수동 번역 유지", () =>
        this.host.resolveConflict(change, "manual")
      );
      button(actions, "AI 번역으로 교체", () =>
        this.host.resolveConflict(change, "ai")
      );
      button(actions, "문서 열기", () => this.host.openSource(change.filePath));
    }
  }

  private renderSelectionOption(
    parent: HTMLElement,
    change: ChangeGroup
  ): void {
    const option = parent.createEl("details", {
      cls: `scriptorium-selection-option is-${change.kind}`,
      attr: this.expandedChanges.has(change.id) ? { open: "" } : {}
    });
    const summary = option.createEl("summary");
    const expander = summary.createSpan("scriptorium-change-expander");
    setIcon(expander, "chevron-right");
    const checkbox = summary.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": `${CHANGE_LABELS[change.kind]} 선택` }
    });
    checkbox.checked = change.selected;
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    checkbox.addEventListener("change", () => {
      void this.host.toggleSelection(change.id, checkbox.checked);
    });
    const content = summary.createSpan("scriptorium-selection-content");
    const title = content.createSpan("scriptorium-selection-title");
    title.createSpan({
      cls: `scriptorium-change-kind is-${change.kind}`,
      text: CHANGE_LABELS[change.kind]
    });
    title.createSpan({
      cls: "scriptorium-change-location",
      text: change.headingPath.join(" › ") || "문서 루트"
    });
    content.createSpan({
      cls: "scriptorium-change-preview",
      text: changePreview(change)
    });
    const diff = option.createDiv("scriptorium-selection-diff");
    renderDiffContent(diff, change);
    option.addEventListener("toggle", () => {
      if (option.open) this.expandedChanges.add(change.id);
      else this.expandedChanges.delete(change.id);
    });
  }

  private renderChanges(
    container: HTMLElement,
    plan: ProjectChangePlan
  ): void {
    const changedFiles = plan.files.filter(
      (file) => file.changes.length > 0
    );
    const selectable = plan.files.flatMap((file) =>
      file.changes.filter((change) => change.state !== "conflict")
    );
    const selected = selectable.filter((change) => change.selected);
    const panel = container.createEl("details", {
      cls: "scriptorium-panel",
      attr: { open: "" }
    });
    panel.createEl("summary", {
      text: `변경된 문서 (${changedFiles.length})`
    });
    const body = panel.createDiv("scriptorium-panel-body");
    const toolbarDock = body.createDiv("scriptorium-toolbar-dock");
    const selectAll = toolbarDock.createEl("label", {
      cls: "scriptorium-select-all"
    });
    const selectAllCheckbox = selectAll.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": "모든 변경 사항 선택 또는 해제" }
    });
    selectAllCheckbox.checked =
      selectable.length > 0 && selected.length === selectable.length;
    selectAllCheckbox.indeterminate =
      selected.length > 0 && selected.length < selectable.length;
    selectAllCheckbox.disabled = selectable.length === 0;
    selectAllCheckbox.addEventListener("change", () => {
      void this.host.selectAll(selectAllCheckbox.checked);
    });
    selectAll.createSpan({ text: "모두 선택" });
    selectAll.createSpan({
      cls: "scriptorium-select-all-count",
      text: `${selected.length}/${selectable.length}`
    });
    const rescan = button(
      toolbarDock,
      "다시 검사",
      () => this.host.rescan(),
      "refresh-cw",
      "프로젝트 문서를 다시 읽어 변경 목록을 갱신합니다."
    );
    rescan.addClass("scriptorium-compact-action");

    if (changedFiles.length === 0) {
      body.createDiv({
        cls: "scriptorium-empty",
        text: "변경된 문서가 없습니다."
      });
    }
    for (const file of changedFiles) {
      const displayPath = projectRelativePath(
        plan.project,
        file.sourcePath
      );
      const document = body.createEl("details", {
        cls: "scriptorium-document",
        attr: this.expandedDocuments.has(file.sourcePath)
          ? { open: "" }
          : {}
      });
      const row = document.createEl("summary", {
        cls: "scriptorium-document-row",
        attr: { title: "세부 변경 보기" }
      });
      const documentChanges = file.changes.filter(
        (change) => change.state !== "conflict"
      );
      const expander = row.createSpan("scriptorium-document-expander");
      setIcon(expander, "chevron-right");
      const selectedCount = documentChanges.filter(
        (change) => change.selected
      ).length;
      const checkbox = row.createEl("input", {
        type: "checkbox",
        attr: {
          "aria-label": `${displayPath} 변경 사항 전체 선택`,
          title: "이 문서의 변경 사항 전체 선택/해제"
        }
      });
      checkbox.checked =
        documentChanges.length > 0 &&
        selectedCount === documentChanges.length;
      checkbox.indeterminate =
        selectedCount > 0 && selectedCount < documentChanges.length;
      checkbox.disabled = documentChanges.length === 0;
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("change", () => {
        void this.host.setSelections(
          documentChanges.map((change) => change.id),
          checkbox.checked
        );
      });
      const icon = row.createSpan("scriptorium-document-icon");
      setIcon(icon, "file-text");
      const link = row.createEl("a", { text: displayPath });
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.host.openSource(file.sourcePath);
      });
      row.createSpan({
        cls: "scriptorium-document-count",
        text: changeCountSummary(file.changes)
      });
      if (file.conflicts.length > 0) {
        row.createSpan({
          cls: "scriptorium-document-conflicts",
          text: `충돌 ${file.conflicts.length}`
        });
      }
      if (documentChanges.length > 0) {
        const changes = document.createDiv(
          "scriptorium-document-changes"
        );
        for (const change of documentChanges) {
          this.renderSelectionOption(changes, change);
        }
      }
      document.addEventListener("toggle", () => {
        if (document.open) {
          this.expandedDocuments.add(file.sourcePath);
        } else {
          this.expandedDocuments.delete(file.sourcePath);
        }
      });
    }

    const staged = container.createEl("details", {
      cls: "scriptorium-panel scriptorium-compact-panel"
    });
    staged.createEl("summary", { text: `대기 중 · ${selected.length}건` });
    const stagedBody = staged.createDiv("scriptorium-panel-body");
    if (selected.length === 0) {
      stagedBody.createDiv({
        cls: "scriptorium-empty",
        text: "선택된 변경 사항이 없습니다."
      });
    } else {
      for (const file of plan.files) {
        const count = file.changes.filter((change) => change.selected).length;
        if (count === 0) continue;
        stagedBody.createDiv({
          cls: "scriptorium-pending-file",
          text: `${projectRelativePath(plan.project, file.sourcePath)} · ${count}건`
        });
      }
    }

    if (plan.conflictCount > 0) {
      const conflicts = container.createEl("details", {
        cls: "scriptorium-panel",
        attr: { open: "" }
      });
      conflicts.createEl("summary", {
        text: `충돌 (${plan.conflictCount})`
      });
      const conflictBody = conflicts.createDiv("scriptorium-panel-body");
      for (const file of plan.files) {
        for (const conflict of file.conflicts) {
          this.renderChange(conflictBody, conflict, true);
        }
      }
    }
  }

  private renderProjectSettings(
    container: HTMLElement,
    project: ProjectConfig,
    documents: ProjectDocumentSetting[]
  ): void {
    const panel = container.createEl("details", {
      cls: "scriptorium-panel scriptorium-project-settings",
      attr: this.projectSettingsOpen ? { open: "" } : {}
    });
    panel.createEl("summary", { text: "프로젝트 설정" });
    panel.addEventListener("toggle", () => {
      this.projectSettingsOpen = panel.open;
    });
    const body = panel.createDiv("scriptorium-panel-body");

    const grid = body.createDiv("scriptorium-config-grid");
    const nameField = grid.createDiv("scriptorium-config-field");
    nameField.createEl("label", { text: "프로젝트 이름" });
    const name = nameField.createEl("input", { type: "text" });
    name.value = project.name;

    const modeField = grid.createDiv("scriptorium-config-field");
    modeField.createEl("label", { text: "동기화 모드" });
    const mode = modeField.createEl("select");
    mode.createEl("option", { text: "원문", value: "original" });
    mode.createEl("option", { text: "번역", value: "translated" });
    mode.value = project.syncMode;

    const promptField = body.createDiv("scriptorium-config-field");
    promptField.createEl("label", { text: "프로젝트 번역 프롬프트" });
    promptField.createDiv({
      cls: "scriptorium-config-help",
      text: "비워두면 공용 프롬프트를 사용합니다."
    });
    const prompt = promptField.createEl("textarea");
    prompt.rows = 7;
    prompt.value = project.translationPrompt;
    prompt.placeholder = this.host.getGlobalTranslationPrompt();

    const glossaryField = body.createDiv("scriptorium-config-field");
    glossaryField.createEl("label", { text: "프로젝트 번역 어휘 사전" });
    glossaryField.createDiv({
      cls: "scriptorium-config-help",
      text: "한 줄에 '원문 = 번역어'로 입력합니다. 비워두면 공용 사전을 사용하며, 요청 내용과 관련된 항목만 전달합니다."
    });
    const glossary = glossaryField.createEl("textarea");
    glossary.rows = 7;
    glossary.value = project.translationGlossary;
    glossary.placeholder =
      this.host.getGlobalTranslationGlossary() || "Sword = 검\nMana = 마나";

    button(
      body,
      "프로젝트 설정 저장",
      () =>
        this.host.updateActiveProjectSettings({
          name: name.value,
          syncMode:
            mode.value === "original" ? "original" : "translated",
          translationPrompt: prompt.value,
          translationGlossary: glossary.value
        }),
      "save"
    );

    const ignore = body.createEl("details", {
      cls: "scriptorium-document-settings",
      attr: this.documentSettingsOpen ? { open: "" } : {}
    });
    ignore.addEventListener("toggle", () => {
      this.documentSettingsOpen = ignore.open;
    });
    ignore.createEl("summary", {
      text: `문서 포함/제외 · ${documents.filter((item) => item.included).length}/${documents.length}`
    });
    ignore.createDiv({
      cls: "scriptorium-config-help",
      text: "체크를 끄면 해당 문서 frontmatter에 scriptorium: false를 기록합니다."
    });
    const list = ignore.createDiv("scriptorium-document-settings-list");
    for (const document of documents) {
      const row = list.createEl("label", {
        cls: "scriptorium-document-setting"
      });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = document.included;
      row.createSpan({
        text: projectRelativePath(project, document.path)
      });
      checkbox.addEventListener("change", () => {
        void this.host.setProjectDocumentIncluded(
          document.path,
          checkbox.checked
        );
      });
    }
  }

  private renderProgress(
    container: HTMLElement,
    project: ProjectConfig
  ): void {
    const progress = this.host.getTranslationProgress();
    if (!progress.running && progress.total === 0) {
      container.createDiv({
        cls: "scriptorium-job-status",
        text: "번역 작업 · 대기"
      });
      return;
    }
    const panel = container.createEl("details", {
      cls: `scriptorium-panel ${
        progress.running ? "" : "scriptorium-compact-panel"
      }`,
      attr: progress.running ? { open: "" } : {}
    });
    panel.createEl("summary", {
      text: progress.running
        ? `번역 중 · ${progress.completed + progress.failed}/${progress.total}`
        : `${progress.message || "작업 완료"} · 성공 ${progress.completed} · 실패 ${progress.failed}`
    });
    const body = panel.createDiv("scriptorium-panel-body");
    if (progress.total > 0) {
      const bar = body.createEl("progress", {
        cls: "scriptorium-progress"
      });
      bar.max = progress.total;
      bar.value = progress.completed + progress.failed;
    }
    body.createDiv({
      text: `${
        progress.currentFile
          ? projectRelativePath(project, progress.currentFile)
          : "파일 없음"
      } · 성공 ${progress.completed} · 실패 ${progress.failed}`
    });
    body.createEl("pre", {
      cls: "scriptorium-stream",
      text: progress.streamText || "(스트리밍 출력 없음)"
    });
    const cancel = button(body, "작업 취소", () =>
      this.host.cancelTranslation()
    );
    cancel.disabled = !progress.running;
  }

  private renderAdvanced(container: HTMLElement): void {
    const panel = container.createEl("details", {
      cls: "scriptorium-panel scriptorium-advanced-tools",
      attr: this.advancedToolsOpen ? { open: "" } : {}
    });
    const summary = panel.createEl("summary", {
      attr: { "aria-label": "고급 도구 패널 열기 또는 닫기" }
    });
    summary.createSpan({ text: "고급 도구" });
    const chevron = summary.createSpan("scriptorium-advanced-chevron");
    setIcon(chevron, "chevron-up");
    panel.addEventListener("toggle", () => {
      this.advancedToolsOpen = panel.open;
    });
    const body = panel.createDiv("scriptorium-panel-body");
    body.createEl("h4", { text: "로어북 도구" });
    const lorebookActions = body.createDiv("scriptorium-actions");
    button(
      lorebookActions,
      "JSON 가져오기",
      () => this.host.importJson(),
      undefined,
      "RisuAI 로어북 JSON을 현재 프로젝트의 Markdown 문서로 가져옵니다."
    ).addClass("scriptorium-danger-action");
    button(
      lorebookActions,
      "메타데이터 추가",
      () => this.host.updateMetadata("add"),
      undefined,
      "메타데이터가 없는 프로젝트 문서에 기본 로어북 메타데이터를 추가합니다."
    );
    button(
      lorebookActions,
      "메타데이터 교체",
      () => this.host.updateMetadata("replace"),
      undefined,
      "모든 프로젝트 문서의 로어북 메타데이터를 기본값으로 교체합니다."
    ).addClass("scriptorium-danger-action");
    button(
      lorebookActions,
      "메타데이터 제거",
      () => this.host.updateMetadata("remove"),
      undefined,
      "모든 프로젝트 문서에서 로어북 메타데이터만 제거합니다."
    ).addClass("scriptorium-danger-action");
    button(
      lorebookActions,
      "표 편집기",
      () => this.host.openMetadataBase(),
      undefined,
      "프로젝트 메타데이터를 표 형식으로 편집하는 화면을 생성하거나 엽니다."
    );
    button(
      lorebookActions,
      "병합 문서 생성",
      () => this.host.mergeMarkdown(),
      undefined,
      "포함된 프로젝트 Markdown을 하나의 병합 문서로 생성합니다."
    );
    body.createEl("h4", { text: "유지보수" });
    const actions = body.createDiv("scriptorium-actions");
    button(
      actions,
      "캐시 재구축",
      () => this.host.rebuildCache(),
      undefined,
      "현재 원문과 번역본을 다시 읽어 프로젝트 캐시를 처음부터 구성합니다."
    ).addClass("scriptorium-danger-action");
    button(
      actions,
      "기존 번역본 다시 채택",
      () => this.host.adoptExistingTranslations(),
      undefined,
      "현재 translate 폴더의 번역본을 기준 상태로 다시 채택합니다."
    ).addClass("scriptorium-danger-action");
    button(
      actions,
      "프로젝트 등록 해제",
      () => this.host.unregisterActiveProject(),
      undefined,
      "현재 폴더와 문서는 그대로 두고 Scriptorium 프로젝트 등록만 해제합니다."
    ).addClass("scriptorium-danger-action");
  }

  async refresh(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("scriptorium-dashboard");
    const project = this.host.getActiveProject();
    if (!project) {
      container.createEl("h2", { text: "Scriptorium" });
      container.createDiv({
        cls: "scriptorium-empty",
        text: "프로젝트 없음 · 등록된 프로젝트 안의 문서를 여세요."
      });
      const sync = this.host.getSyncStatus();
      const statuses = container.createDiv("scriptorium-status-row");
      statusPill(statuses, "로컬", sync.localMessage, sync.local === "error");
      statusPill(statuses, "릴레이", sync.relayMessage, sync.relay === "error");
      return;
    }
    const plan = this.host.getChangePlan();
    const documents = await this.host.getProjectDocumentSettings();
    this.renderHeader(container, project, plan);
    this.renderProjectSettings(container, project, documents);
    if (plan) this.renderChanges(container, plan);
    this.renderProgress(container, project);
    this.renderAdvanced(container);
  }
}
