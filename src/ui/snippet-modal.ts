// CBS 스니펫 삽입 모달 — 검색 + 카테고리별 <details> 그룹.
// 이 코드베이스 첫 raw Modal 서브클래스.
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md
import { App, MarkdownView, Modal } from "obsidian";
import { SNIPPET_CATALOG, type CbsCategory, type CbsSnippet } from "../modules/cbs/snippets";

const CATEGORY_ORDER: CbsCategory[] = [
  "조건문",
  "루프",
  "함수",
  "변수·토글",
  "출력·이스케이프",
  "단일 플레이스홀더",
  "수식·주석",
  "@@ 데코레이터"
];

export class CbsSnippetModal extends Modal {
  constructor(app: App) {
    super(app);
    this.setTitle("CBS 스니펫 삽입");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scriptorium-cbs-modal");

    contentEl.createEl("p", {
      cls: "scriptorium-cbs-modal-note",
      text: "클릭으로 삽입"
    });

    const search = contentEl.createEl("input", {
      type: "search",
      attr: { placeholder: "스니펫 검색 (예: when, each, toggle)" }
    });
    search.addClass("scriptorium-cbs-search");

    const listWrap = contentEl.createDiv({ cls: "scriptorium-cbs-list" });

    const render = (query: string): void => {
      listWrap.empty();
      const q = query.trim().toLowerCase();
      const filtered = q
        ? SNIPPET_CATALOG.filter(
            (s) =>
              s.label.toLowerCase().includes(q) ||
              s.insert.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q)
          )
        : SNIPPET_CATALOG;

      if (filtered.length === 0) {
        listWrap.createEl("p", {
          cls: "scriptorium-cbs-empty",
          text: "일치하는 스니펫이 없습니다."
        });
        return;
      }

      if (q) {
        for (const snippet of filtered) this.renderItem(listWrap, snippet);
        return;
      }

      for (const category of CATEGORY_ORDER) {
        const items = filtered.filter((s) => s.category === category);
        if (items.length === 0) continue;
        const details = listWrap.createEl("details", {
          attr: { open: category === "조건문" ? "open" : null }
        });
        details.createEl("summary", { text: category });
        const group = details.createDiv({ cls: "scriptorium-cbs-group" });
        for (const snippet of items) this.renderItem(group, snippet);
      }
    };

    search.addEventListener("input", () => render(search.value));
    render("");
    setTimeout(() => search.focus(), 0);
  }

  private renderItem(parent: HTMLElement, snippet: CbsSnippet): void {
    const row = parent.createEl("button", { cls: "scriptorium-cbs-item" });
    row.createEl("code", {
      text: snippet.label,
      cls: "scriptorium-cbs-item-label"
    });
    row.createEl("span", {
      text: snippet.description,
      cls: "scriptorium-cbs-item-desc"
    });
    row.addEventListener("click", () => {
      this.insert(snippet.insert);
      this.close();
    });
  }

  // │ 마커 위치로 캐럿을 옮긴다. 마커가 없으면 삽입 끝에 둔다.
  private insert(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const marker = text.indexOf("│");
    const insertText = marker >= 0 ? text.replace("│", "") : text;
    const from = editor.getCursor("from");
    editor.replaceSelection(insertText);
    if (marker < 0) return;
    const head = insertText.slice(0, marker);
    const lines = head.split("\n");
    const line = from.line + (lines.length - 1);
    const ch =
      lines.length === 1
        ? from.ch + (lines[0]?.length ?? 0)
        : (lines[lines.length - 1]?.length ?? 0);
    editor.setCursor({ line, ch });
  }
}