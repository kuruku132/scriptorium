// CBS 적용 결과를 Obsidian 리딩뷰처럼 렌더링하는 분할 프리뷰 뷰.
// 에디터 원문 → CBS 평가 → 마크다운 렌더. 토글/변수/편집 실시간 반영.
// RisuAI 전송 content는 변경하지 않는다(이 뷰는 읽기 전용 프리뷰).
import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import { evaluate, makeEvalContext, type MockMeta } from "../modules/cbs/evaluator";
import { parseMarkdown } from "../shared/markdown";
import type { CbsPanelHost } from "./cbs-panel";
import type { CbsTestValues } from "../shared/types";

export const CBS_PREVIEW_VIEW_TYPE = "scriptorium-cbs-preview";

export class CbsPreviewView extends ItemView {
  private lastSeenText = "";
  private lastSeenValuesKey = "";
  private watchedPath: string | null = null;
  private pollTimer: number | null = null;
  private rendering = false;
  private pending = false;
  private renderComponent: Component | null = null;

  private headerEl!: HTMLDivElement;
  private pathEl!: HTMLSpanElement;
  private bodyEl!: HTMLDivElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CbsPanelHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CBS_PREVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "CBS 프리뷰";
  }

  getIcon(): string {
    return "eye";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.onLeafChange())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.onLeafChange())
    );
    // 에디터 편집 폴링(400ms). 텍스트/테스트 값이 바뀐 경우에만 재렌더.
    this.pollTimer = window.setInterval(() => {
      void this.maybeRefresh();
    }, 400);
    this.registerInterval(this.pollTimer);
    await this.maybeRefresh(true);
  }

  async onClose(): Promise<void> {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.renderComponent?.unload();
    this.renderComponent = null;
  }

  refresh(): void {
    void this.maybeRefresh(true);
  }

  private renderShell(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scriptorium-cbs-preview-view");
    this.headerEl = contentEl.createDiv({ cls: "scriptorium-cbs-header" });
    this.pathEl = this.headerEl.createEl("span", {
      cls: "scriptorium-cbs-path"
    });
    this.headerEl.createEl("span", {
      cls: "scriptorium-cbs-limit",
      text: "RisuAI와 다를 수 있습니다. RisuAI 내에서 다시 확인하세요."
    });
    this.bodyEl = contentEl.createDiv({
      cls: "scriptorium-cbs-preview-body markdown-rendered"
    });
  }

  private onLeafChange(): void {
    const path = this.host.getActiveFilePath();
    if (path !== this.watchedPath) {
      void this.maybeRefresh(true);
    }
  }

  private async maybeRefresh(force = false): Promise<void> {
    const path = this.host.getActiveFilePath();
    const text = this.host.getActiveEditorText();
    const values = path ? this.host.getCbsTestValues(path) : null;
    const valuesKey = values ? JSON.stringify(values) : "";
    if (
      !force &&
      path === this.watchedPath &&
      text === this.lastSeenText &&
      valuesKey === this.lastSeenValuesKey
    ) {
      return;
    }

    if (text === null) {
      this.renderComponent?.unload();
      this.renderComponent = null;
      this.bodyEl.empty();
      this.pathEl.setText(path ?? "(활성 Markdown 파일 없음)");
      this.bodyEl.createEl("p", {
        cls: "scriptorium-cbs-empty",
        text: "Markdown 파일을 열면 CBS 적용 프리뷰를 표시합니다."
      });
      this.watchedPath = path;
      this.lastSeenText = "";
      this.lastSeenValuesKey = "";
      return;
    }

    this.watchedPath = path;
    this.pathEl.setText(path ?? "");
    this.lastSeenText = text;
    this.lastSeenValuesKey = valuesKey;

    // 렌더 중첩 방지: 진행 중이면 최신 한 번만 다시 예약.
    if (this.rendering) {
      this.pending = true;
      return;
    }
    this.rendering = true;
    try {
      const result = this.evalPreview(
        text,
        values ?? { chatVars: {}, toggles: {} }
      );
      // 리딩뷰 렌더 전 frontmatter 분리(본문만 마크다운 렌더).
      const body = parseMarkdown(result.value).body;
      this.renderComponent?.unload();
      this.renderComponent = new Component();
      this.renderComponent.load();
      this.bodyEl.empty();
      if (body.trim() === "") {
        this.bodyEl.createEl("p", {
          cls: "scriptorium-cbs-empty",
          text: "(본문이 비어 있습니다)"
        });
      } else {
        await MarkdownRenderer.render(
          this.app,
          body,
          this.bodyEl,
          path ?? "",
          this.renderComponent
        );
      }
      this.renderErrors(result.errors);
    } finally {
      this.rendering = false;
      if (this.pending) {
        this.pending = false;
        void this.maybeRefresh(true);
      }
    }
  }

  private renderErrors(errors: string[]): void {
    this.bodyEl.querySelector(".scriptorium-cbs-errors")?.remove();
    if (errors.length === 0) return;
    const errBox = this.bodyEl.createEl("div", { cls: "scriptorium-cbs-errors" });
    errBox.createEl("h5", { text: "평가 경고" });
    for (const err of errors.slice(0, 20)) {
      errBox.createEl("div", { cls: "scriptorium-cbs-error-line", text: err });
    }
  }

  private evalPreview(
    text: string,
    values: CbsTestValues
  ): { value: string; errors: string[] } {
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