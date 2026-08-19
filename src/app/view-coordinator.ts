import { App } from "obsidian";
import {
  DASHBOARD_VIEW_TYPE,
  ScriptoriumDashboard
} from "../ui/dashboard";

/**
 * 대시보드 뷰 수명주기와 번역 진행률 갱신 throttle을 담당한다.
 * 대시보드 리프 탐색/생성, 전체 refresh, 진행률 경량 refresh
 * (150ms coalesce), 소스 파일 열기를 이 코디네이터가 소유한다.
 * ScriptoriumPlugin 객체 전체가 아닌 App만 주입받는다.
 */
export class ViewCoordinator {
  private progressRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private progressRefreshPending = false;

  constructor(private readonly app: App) {}

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

  refreshDashboard(): void {
    this.progressRefreshPending = false;
    if (this.progressRefreshTimer) {
      clearTimeout(this.progressRefreshTimer);
      this.progressRefreshTimer = null;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(
      DASHBOARD_VIEW_TYPE
    )) {
      const view = leaf.view;
      if (view instanceof ScriptoriumDashboard) void view.refresh();
    }
  }

  /**
   * 번역 진행률/스트리밍 갱신을 throttle/coalesce 한다.
   * 스트리밍 delta마다 전체 대시보드 refresh를 유발하지 않고,
   * 최신 progress 상태만 보관한 뒤 약 150ms 단위로 경량 refreshProgress()를 실행한다.
   * immediate=true(작업 완료/오류/취소)인 경우에는 즉시 반영한다.
   */
  scheduleProgressRefresh(immediate: boolean): void {
    this.progressRefreshPending = true;
    if (immediate) {
      if (this.progressRefreshTimer) {
        clearTimeout(this.progressRefreshTimer);
        this.progressRefreshTimer = null;
      }
      this.flushProgressRefresh();
      return;
    }
    if (this.progressRefreshTimer) return;
    this.progressRefreshTimer = setTimeout(() => {
      this.progressRefreshTimer = null;
      this.flushProgressRefresh();
    }, 150);
  }

  private flushProgressRefresh(): void {
    if (!this.progressRefreshPending) return;
    this.progressRefreshPending = false;
    for (const leaf of this.app.workspace.getLeavesOfType(
      DASHBOARD_VIEW_TYPE
    )) {
      const view = leaf.view;
      if (view instanceof ScriptoriumDashboard) view.refreshProgress();
    }
  }

  async openSource(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  dispose(): void {
    if (this.progressRefreshTimer) clearTimeout(this.progressRefreshTimer);
  }
}