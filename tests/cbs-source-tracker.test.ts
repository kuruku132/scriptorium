import { describe, expect, it } from "vitest";
import { CbsSourceTracker } from "../src/ui/cbs-source-tracker";

// CBS 분할 프리뷰/테스트 패널 안정화 회귀: "현재 CBS 소스는 어떤 Markdown
// 파일인가?" 결정이 리프 포커스 변화(사이드바/플러그인/CBS 프리뷰 리프)에
// 영향받지 않도록 한다. 추적기는 순수 로직이므로 직접 단위 테스트한다.
describe("CbsSourceTracker — preview source pinning", () => {
  it("selects a Markdown file as the source", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    expect(t.resolve()).toBe("A.md");
  });

  it("plugin leaf focused (non-Markdown active leaf) → source still A", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    // 활성 리프가 Markdown 에디터가 아니면 onActiveLeafChange 에 null 전달.
    t.onActiveLeafChange(null);
    expect(t.resolve()).toBe("A.md");
  });

  it("CBS preview leaf focused (non-Markdown) → source still A", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onActiveLeafChange(null); // CBS 프리뷰 리프는 Markdown 에디터 아님
    expect(t.resolve()).toBe("A.md");
  });

  it("sidebar leaf focused (non-Markdown) → source still A", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onActiveLeafChange(null);
    expect(t.resolve()).toBe("A.md");
  });

  it("Markdown B selected afterwards → source becomes B", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onActiveLeafChange("B.md"); // 다른 Markdown 에디터 활성화
    expect(t.resolve()).toBe("B.md");
    // file-open 으로 B 가 열린 경우도 B 로 갱신.
    t.onFileOpen("B.md", true);
    expect(t.resolve()).toBe("B.md");
  });

  it("focus leaves Markdown B → source remains B", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("B.md");
    t.onActiveLeafChange(null); // 비-Markdown 리프로 포커스 이동
    expect(t.resolve()).toBe("B.md");
  });

  it("non-Markdown file open (image) does not clear remembered Markdown", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onFileOpen("pic.png", false);
    expect(t.resolve()).toBe("A.md");
  });

  it("file-open of null (all tabs closed) keeps remembered Markdown", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onFileOpen(null, false);
    expect(t.resolve()).toBe("A.md");
  });

  it("active-leaf-change to a Markdown editor updates source when different", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onActiveLeafChange("C.md");
    expect(t.resolve()).toBe("C.md");
  });

  it("active-leaf-change to same Markdown editor keeps source", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onActiveLeafChange("A.md");
    expect(t.resolve()).toBe("A.md");
  });

  it("rename updates the remembered path", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onRename("A.md", "A_renamed.md");
    expect(t.resolve()).toBe("A_renamed.md");
  });

  it("rename of an unrelated file does not change source", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onRename("other.md", "other2.md");
    expect(t.resolve()).toBe("A.md");
  });

  it("delete of remembered file clears source", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onDelete("A.md");
    expect(t.resolve()).toBeNull();
  });

  it("delete of an unrelated file does not clear source", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("A.md");
    t.onDelete("other.md");
    expect(t.resolve()).toBe("A.md");
  });

  it("selectMarkdown ignores non-markdown paths", () => {
    const t = new CbsSourceTracker();
    t.selectMarkdown("pic.png", false);
    expect(t.resolve()).toBeNull();
  });

  it("end-to-end scenario: A → focus away → B → focus away → delete B", () => {
    const t = new CbsSourceTracker();
    t.onFileOpen("A.md", true);
    expect(t.resolve()).toBe("A.md");
    t.onActiveLeafChange(null); // 사이드바 클릭
    expect(t.resolve()).toBe("A.md");
    t.onFileOpen("B.md", true); // Markdown B 열기
    expect(t.resolve()).toBe("B.md");
    t.onActiveLeafChange(null); // CBS 프리뷰 클릭
    expect(t.resolve()).toBe("B.md");
    t.onDelete("B.md");
    expect(t.resolve()).toBeNull();
  });
});