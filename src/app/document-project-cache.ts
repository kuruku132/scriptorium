import { App } from "obsidian";
import { compileDocumentProject } from "../modules/lorebook";
import type {
  LorebookDocumentProject,
  ProjectCache,
  ProjectConfig,
  ScriptoriumSettings
} from "../shared/types";

/**
 * 프로젝트별 로어북 문서 컴파일 결과(Promise)를 캐싱한다.
 *
 * 동일 프로젝트에 대한 동시 요청이 컴파일을 중복 실행하지 않도록 진행 중인
 * Promise를 공유하고, 컴파일이 거부되면 캐시에서 제거해 다음 요청이 재시도
 * 가능하도록 한다. 영속화 루트(data.caches)는 플러그인이 소유하므로
 * getProjectCache 접근자로 파일 캐시를 받아 사용한다.
 */
export interface DocumentProjectCacheDeps {
  app: App;
  getSettings(): ScriptoriumSettings;
  getProjectCache(project: ProjectConfig): ProjectCache;
  debug(event: string, details?: Record<string, unknown>): void;
}

export class DocumentProjectCache {
  private readonly entries = new Map<
    string,
    Promise<LorebookDocumentProject>
  >();

  constructor(private readonly deps: DocumentProjectCacheDeps) {}

  /**
   * projectId에 대한 컴파일된 로어북 문서 Promise를 반환한다.
   * 캐시가 있으면 공유 Promise를 반환하고, 없으면 컴파일을 시작해 캐싱한다.
   * 프로젝트를 찾지 못하면 null Promise를, 컴파일이 거부되면 캐시에서
   * 제거한 뒤 에러를 다시 던진다.
   */
  get(projectId: string): Promise<LorebookDocumentProject | null> {
    const project = this.deps
      .getSettings()
      .projects.find((entry) => entry.id === projectId);
    if (!project) {
      this.deps.debug("document-project.not-found", { projectId });
      return Promise.resolve(null);
    }
    const cached = this.entries.get(project.id);
    if (cached) {
      this.deps.debug("document-project.cache-hit", { projectId });
      return cached;
    }
    const startedAt = Date.now();
    this.deps.debug("document-project.compile.begin", {
      projectId,
      name: project.name,
      mode: project.syncMode
    });
    const compiled = compileDocumentProject(
      this.deps.app,
      project,
      this.deps.getProjectCache(project).files
    ).catch((error) => {
      this.entries.delete(project.id);
      this.deps.debug("document-project.compile.error", {
        projectId,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt
      });
      throw error;
    });
    this.entries.set(project.id, compiled);
    void compiled.then(
      (result) => {
        this.deps.debug("document-project.compile.done", {
          projectId,
          revision: result.revision,
          documentCount: result.documents.length,
          elapsedMs: Date.now() - startedAt
        });
      },
      () => undefined
    );
    return compiled;
  }

  /**
   * projectId 캐시 항목을 제거한다. 항목이 실제로 존재해 삭제되었으면
   * true를 반환한다(debug용 hadCache, ProjectRuntime이 사용).
   */
  invalidate(projectId: string): boolean {
    return this.entries.delete(projectId);
  }

  clear(): void {
    this.entries.clear();
  }
}