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
      cls: "scriptorium-cbs-preview-body markdown-rendered markdown-reading-view"
    });
  }

  private onLeafChange(): void {
    // 기억된 CBS 소스가 바뀐 경우(다른 Markdown 문서를 실제로 열었을 때)만
    // 강제 갱신. 비-Markdown 리프로 포커스가 옮겨간 경우 소스는 유지되므로
    // watchedPath 와 같아 갱신하지 않는다 → 프리뷰가 사라지지 않는다.
    const path = this.host.getCbsSourcePath();
    if (path !== this.watchedPath) {
      void this.maybeRefresh(true);
    }
  }

  private async maybeRefresh(force = false): Promise<void> {
    // 소스는 기억된 Markdown 문서(포커스 변화에 비워지지 않음).
    const path = this.host.getCbsSourcePath();
    // 에디터가 열려있으면 동기로 빠르게, 아니면 볼트에서 비동기로 읽는다.
    let text: string | null = path ? this.host.getCbsSourceTextSync(path) : null;
    if (text === null && path) {
      text = await this.host.getCbsSourceText(path);
    }
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

    // 빈 상태는 기억된 소스가 진짜 없거나(아무 Markdown 도 연 적 없거나 삭제됨)
    // 읽을 수 없을 때만. 비-Markdown 리프로 포커스가 옮겨간 것만으로는
    // 빈 상태로 가지 않는다.
    if (!path || text === null) {
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