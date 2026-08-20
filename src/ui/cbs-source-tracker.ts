// CBS 소스 문서 추적기 — "현재 CBS 소스는 어떤 Markdown 파일인가?" 결정을
// 프레임워크 독립적인 순수 로직으로 캡슐화. Obsidian 리프 포커스 변화와
// 분리해 분할 프리뷰/테스트 패널이 마지막으로 실제 선택된 Markdown 문서에
// 고정되도록 한다.
//
// 핵심 규칙: 기억된 Markdown 소스는 오직 (a) 실제 Markdown 문서가
// 열리고/선택되거나 (b) 리네임되거나 (c) 삭제될 때만 바뀐다. 사이드바·
// 플러그인 리프·CBS 프리뷰 리프 등 비-Markdown 리프로 포커스가
// 옮겨가는 것만으로는 소스를 비우지 않는다.

export interface CbsSourceEvent {
  /** 이벤트가 참조하는 파일 경로(있을 때). */
  path?: string | null;
  /** 해당 경로가 Markdown 문서인가(확장자 기반). */
  isMarkdown?: boolean;
  oldPath?: string;
}

export class CbsSourceTracker {
  private lastMarkdownPath: string | null = null;

  /** 실제 Markdown 문서가 열렸거나 선택됨(file-open / 활성 md 에디터). */
  selectMarkdown(path: string | null, isMarkdown = true): void {
    if (path && isMarkdown) this.lastMarkdownPath = path;
  }

  /**
   * active-leaf-change 처리.
   * - 활성 리프가 Markdown 에디터 → 해당 파일을 소스로 기억(변경 시 갱신).
   * - 비-Markdown 리프(사이드바/플러그인/CBS 프리뷰) → 기억된 소스 유지.
   */
  onActiveLeafChange(activeMarkdownPath: string | null): void {
    if (activeMarkdownPath) this.lastMarkdownPath = activeMarkdownPath;
  }

  /**
   * file-open 처리.
   * - Markdown 파일이 열림 → 소스 갱신.
   * - 비-Markdown 파일(이미지 등)이 열림 → 기억된 Markdown 소스 유지.
   * - file 이 null(모든 탭 닫힘 등) → 기억된 소스 유지.
   */
  onFileOpen(path: string | null, isMarkdown: boolean): void {
    if (path && isMarkdown) this.lastMarkdownPath = path;
  }

  /** 리네임: 기억된 소스가 리네임되면 새 경로로 갱신. */
  onRename(oldPath: string, newPath: string): void {
    if (oldPath === this.lastMarkdownPath) this.lastMarkdownPath = newPath;
  }

  /** 삭제: 기억된 소스가 삭제되면 정말 사용 불가능하므로 비운다. */
  onDelete(path: string): void {
    if (path === this.lastMarkdownPath) this.lastMarkdownPath = null;
  }

  /** 현재 CBS 소스 경로. 없으면 null. */
  resolve(): string | null {
    return this.lastMarkdownPath;
  }

  /** 테스트/초기화용. */
  clear(): void {
    this.lastMarkdownPath = null;
  }
}