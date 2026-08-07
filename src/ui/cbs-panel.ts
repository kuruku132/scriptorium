// CBS 테스트 패널 뷰 — 활성 문서의 CBS 변수/토글 자동 검출 + 라이브 프리뷰.
// 대시보드 패턴 준용(src/ui/dashboard.ts 참고). 좌측 리프 도킹.
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md
import { ItemView, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { scanCbsVariables, type CbsScanResult } from "../modules/cbs/scanner";
import { evaluate, makeEvalContext, type MockMeta } from "../modules/cbs/evaluator";
import type { CbsMockMeta, CbsTestValues } from "../shared/types";

export const CBS_PANEL_VIEW_TYPE = "scriptorium-cbs-panel";

export interface CbsPanelHost {
  getActiveEditorText(): string | null;
  getActiveFilePath(): string | null;
  getCbsTestValues(path: string): CbsTestValues;
  getCbsMockMeta(): CbsMockMeta;
  setCbsChatVar(path: string, name: string, value: string): void;
  setCbsToggle(path: string, name: string, value: boolean): void;
  resetCbsTestValues(path: string): void;
  saveCbsSettings(): void;
  openCbsPreview(): void;
}

export class CbsPanelView extends ItemView {
  private lastSeenText = "";
  private watchedPath: string | null = null;
  private lastScan: CbsScanResult | null = null;
  private focusedDescriptor: {
    name: string;
    kind: string;
    selStart: number;
    selEnd: number;
  } | null = null;
  private pollTimer: number | null = null;
  private modifyTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CbsPanelHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CBS_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "CBS 테스트";
  }

  getIcon(): string {
    return "flask-conical";
  }

  async onOpen(): Promise<void> {
    this.render();
    // 활성 리프/파일 전환 감지. 파일이 바뀐 경우에만 전체 재렌더.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) =>
        this.onActiveLeafChange(leaf)
      )
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.onFileOpen())
    );
    // 파일 저장(디스크 기록) 시 자동 새로고침 — 새 변수도 목록에 반영.
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultModify(file))
    );
    // 패널 입력창이 포커스 받을 때 어떤 변수인지 기억 — 리프 활성화 후
    // Obsidian이 포커스를 빼앗는 경우 다시 복원하기 위함.
    this.contentEl.addEventListener("focusin", (ev) => {
      const target = ev.target;
      if (
        target instanceof HTMLInputElement &&
        target.dataset.varName
      ) {
        this.focusedDescriptor = {
          name: target.dataset.varName,
          kind: target.dataset.varKind ?? "",
          selStart: target.selectionStart ?? target.value.length,
          selEnd: target.selectionEnd ?? target.value.length
        };
      }
    });
    // 에디터 편집 폴링(400ms). 텍스트 변화를 잡아 프리뷰/변수 목록 갱신.
    this.pollTimer = window.setInterval(() => {
      if (!this.watchedPath) return;
      this.syncFromEditor();
    }, 400);
    this.registerInterval(this.pollTimer);
  }

  private onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    const path = this.host.getActiveFilePath();
    if (path !== this.watchedPath) {
      this.render();
      return;
    }
    // 패널 자신이 활성화된 직후 Obsidian이 입력 포커스를 빼앗으면 복원.
    // 에디터 등 다른 리프로 갈 땐 복원하지 않는다(에디터 포커스 침해 방지).
    if (leaf === this.leaf) {
      this.refocusInput();
    }
  }

  private onFileOpen(): void {
    const path = this.host.getActiveFilePath();
    if (path !== this.watchedPath) {
      this.render();
    }
  }

  // 리프 활성화 직후 입력 포커스 복원(다음 tick — Obsidian 처리 이후).
  private refocusInput(): void {
    const desc = this.focusedDescriptor;
    if (!desc) return;
    window.setTimeout(() => {
      const el = this.contentEl.querySelector(
        `input[data-var-name="${desc.name}"][data-var-kind="${desc.kind}"]`
      );
      if (el instanceof HTMLInputElement) {
        el.focus();
        try {
          el.setSelectionRange(desc.selStart, desc.selEnd);
        } catch {
          // checkbox 등 setSelectionRange 미지원 — 무시.
        }
      }
    }, 0);
  }

  // 전체 재렌더 전에 포커스된 입력을 기억, 이후 복원.
  private captureFocus(): {
    name: string;
    kind: string;
    selStart: number;
    selEnd: number;
  } | null {
    const el = document.activeElement;
    if (
      el instanceof HTMLInputElement &&
      el.closest(".scriptorium-cbs-panel")
    ) {
      const name = el.dataset.varName ?? "";
      const kind = el.dataset.varKind ?? "";
      if (name && kind) {
        return {
          name,
          kind,
          selStart: el.selectionStart ?? el.value.length,
          selEnd: el.selectionEnd ?? el.value.length
        };
      }
    }
    return null;
  }

  private restoreFocus(f: {
    name: string;
    kind: string;
    selStart: number;
    selEnd: number;
  }): void {
    const el = this.contentEl.querySelector(
      `input[data-var-name="${f.name}"][data-var-kind="${f.kind}"]`
    );
    if (el instanceof HTMLInputElement) {
      el.focus();
      try {
        el.setSelectionRange(f.selStart, f.selEnd);
      } catch {
        // 미지원 입력 — 무시.
      }
    }
  }

  private onVaultModify(file: TAbstractFile): void {
    if (!this.watchedPath) return;
    if (!(file instanceof TFile) || file.path !== this.watchedPath) return;
    // 연속 자동저장 중엔 한 번만 — 300ms 디바운스.
    if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
    this.modifyTimer = window.setTimeout(() => {
      this.modifyTimer = null;
      this.syncFromEditor();
    }, 300);
  }

  // 에디터 원문 변화를 프리뷰/변수 목록에 반영.
  // 변수 구성이 바뀐 경우에만 전체 재렌더(포커스는 보존), 그 외엔 프리뷰만 갱신.
  private syncFromEditor(): void {
    const path = this.host.getActiveFilePath();
    const text = this.host.getActiveEditorText();
    if (!path || text === null) {
      if (path !== this.watchedPath) this.render();
      return;
    }
    if (path !== this.watchedPath) {
      this.render();
      return;
    }
    if (text === this.lastSeenText) return;
    this.lastSeenText = text;
    const scan = scanCbsVariables(text);
    const varsChanged =
      JSON.stringify(this.lastScan) !== JSON.stringify(scan);
    this.lastScan = scan;
    if (varsChanged) {
      this.render();
    } else {
      this.refreshPreviewOnly(path);
    }
  }

  async onClose(): Promise<void> {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const focus = this.captureFocus();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scriptorium-cbs-panel");

    const path = this.host.getActiveFilePath();
    const text = this.host.getActiveEditorText();
    this.lastSeenText = text ?? "";
    this.watchedPath = path;

    // 헤더: 경로 + 새로고침 + 프리뷰 분할 + 한계 표시
    const header = contentEl.createDiv({ cls: "scriptorium-cbs-header" });
    header.createEl("span", {
      cls: "scriptorium-cbs-path",
      text: path ?? "(활성 Markdown 파일 없음)"
    });
    const refreshBtn = header.createEl("button", { text: "새로고침" });
    refreshBtn.addEventListener("click", () => {
      this.lastSeenText = "";
      this.render();
    });
    const previewBtn = header.createEl("button", { text: "프리뷰 분할" });
    previewBtn.addEventListener("click", () => {
      this.host.openCbsPreview();
    });

    if (!path || text === null) {
      contentEl.createEl("p", {
        cls: "scriptorium-cbs-empty",
        text: "Markdown 파일을 열면 CBS 변수를 검출해 여기에 표시합니다."
      });
      return;
    }

    contentEl.createEl("p", {
      cls: "scriptorium-cbs-limit",
      text: "RisuAI와 다를 수 있습니다. RisuAI 내에서 다시 확인하세요."
    });

    const scan = scanCbsVariables(text);
    this.lastScan = scan;
    const values = this.host.getCbsTestValues(path);

    // 변수 섹션
    const varsSection = contentEl.createDiv({ cls: "scriptorium-cbs-vars" });
    if (scan.chatVars.length === 0 && scan.toggles.length === 0) {
      varsSection.createEl("p", {
        cls: "scriptorium-cbs-empty",
        text: "검출된 CBS 변수/토글이 없습니다."
      });
    } else {
      if (scan.chatVars.length > 0) {
        varsSection.createEl("h4", { text: "채팅 변수 (var::)" });
        for (const name of scan.chatVars) {
          this.renderChatVarRow(varsSection, path, name, values.chatVars[name] ?? "");
        }
      }
      if (scan.toggles.length > 0) {
        varsSection.createEl("h4", { text: "글로벌 토글 (toggle::)" });
        for (const name of scan.toggles) {
          this.renderToggleRow(varsSection, path, name, values.toggles[name] ?? false);
        }
      }
    }

    const resetBtn = contentEl.createEl("button", {
      text: "이 파일의 테스트 값 초기화",
      cls: "scriptorium-cbs-reset"
    });
    resetBtn.addEventListener("click", () => {
      this.host.resetCbsTestValues(path);
      this.render();
    });

    // 프리뷰
    contentEl.createEl("h4", { text: "프리뷰" });
    const preview = contentEl.createEl("pre", {
      cls: "scriptorium-cbs-preview scriptorium-stream"
    });
    const result = this.evalPreview(text, values);
    preview.setText(result.value);
    if (result.errors.length > 0) {
      const errBox = contentEl.createEl("div", { cls: "scriptorium-cbs-errors" });
      errBox.createEl("h5", { text: "평가 경고" });
      for (const err of result.errors.slice(0, 20)) {
        errBox.createEl("div", { cls: "scriptorium-cbs-error-line", text: err });
      }
    }
    if (focus) this.restoreFocus(focus);
  }

  private renderChatVarRow(
    parent: HTMLElement,
    path: string,
    name: string,
    value: string
  ): void {
    const row = parent.createDiv({ cls: "scriptorium-cbs-var-row" });
    row.createEl("code", { text: name, cls: "scriptorium-cbs-var-name" });
    const input = row.createEl("input", {
      type: "text",
      value,
      attr: { placeholder: '값 (빈칸/0/-1 = falsy)' }
    });
    input.dataset.varName = name;
    input.dataset.varKind = "chat";
    input.addEventListener("input", () => {
      this.focusedDescriptor = {
        name,
        kind: "chat",
        selStart: input.selectionStart ?? input.value.length,
        selEnd: input.selectionEnd ?? input.value.length
      };
      this.host.setCbsChatVar(path, name, input.value);
      this.refreshPreviewOnly(path);
    });
  }

  private renderToggleRow(
    parent: HTMLElement,
    path: string,
    name: string,
    value: boolean
  ): void {
    const row = parent.createDiv({ cls: "scriptorium-cbs-var-row" });
    const label = row.createEl("label", { cls: "scriptorium-cbs-toggle" });
    const input = label.createEl("input", { type: "checkbox" });
    input.checked = value;
    input.dataset.varName = name;
    input.dataset.varKind = "toggle";
    label.createEl("code", { text: name, cls: "scriptorium-cbs-var-name" });
    input.addEventListener("change", () => {
      this.focusedDescriptor = { name, kind: "toggle", selStart: 0, selEnd: 0 };
      this.host.setCbsToggle(path, name, input.checked);
      this.refreshPreviewOnly(path);
    });
  }

  // 값 입력 시 프리뷰만 갱신(전체 재렌더 없이).
  private refreshPreviewOnly(path: string): void {
    const text = this.host.getActiveEditorText();
    if (text === null) return;
    const values = this.host.getCbsTestValues(path);
    const result = this.evalPreview(text, values);
    const preview = this.contentEl.querySelector(".scriptorium-cbs-preview");
    if (preview instanceof HTMLPreElement) {
      preview.setText(result.value);
    }
    // 경고 박스 갱신
    let errBox = this.contentEl.querySelector(".scriptorium-cbs-errors");
    if (result.errors.length > 0) {
      if (!errBox) {
        errBox = this.contentEl.createEl("div", { cls: "scriptorium-cbs-errors" });
        errBox.createEl("h5", { text: "평가 경고" });
      } else {
        errBox.empty();
        errBox.createEl("h5", { text: "평가 경고" });
      }
      for (const err of result.errors.slice(0, 20)) {
        errBox.createEl("div", { cls: "scriptorium-cbs-error-line", text: err });
      }
    } else if (errBox) {
      errBox.remove();
    }
  }

  private evalPreview(text: string, values: CbsTestValues): { value: string; errors: string[] } {
    const mockMeta = this.host.getCbsMockMeta();
    const meta: MockMeta = {
      char: mockMeta.char,
      user: mockMeta.user,
      persona: mockMeta.persona,
      model: mockMeta.model,
      now: new Date(),
      maxcontext: mockMeta.maxcontext
    };
    const evalCtx = makeEvalContext(values.chatVars, values.toggles, meta);
    return evaluate(text, evalCtx);
  }
}