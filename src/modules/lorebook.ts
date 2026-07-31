import type { App } from "obsidian";
import { parseMarkdown } from "../shared/markdown";
import {
  type FileCache,
  type LorebookSnapshot,
  type ProjectConfig,
  type SourceDocument
} from "../shared/types";
import {
  atomicWriteVaultFile,
  listSourceFiles,
  translationPathFor
} from "./project";
import {
  compileLorebookDocuments,
  createNoProjectSnapshot,
  createReadySnapshot
} from "./lorebook-core";

export {
  compileLorebookDocuments,
  createNoProjectSnapshot,
  createReadySnapshot,
  snapshotHttpResponse
} from "./lorebook-core";

export async function loadProjectDocuments(
  app: App,
  project: ProjectConfig,
  files: Record<string, FileCache>
): Promise<SourceDocument[]> {
  const sourceFiles = await listSourceFiles(app, project);
  const documents: SourceDocument[] = [];
  for (const sourceFile of sourceFiles) {
    const source = parseMarkdown(await app.vault.cachedRead(sourceFile));
    const translationPath = translationPathFor(project, sourceFile.path);
    const translationFile = app.vault.getFileByPath(translationPath);
    const translation = translationFile
      ? parseMarkdown(await app.vault.cachedRead(translationFile))
      : null;
    documents.push({
      path: sourceFile.path,
      basename: sourceFile.basename,
      source,
      translation,
      cache: files[sourceFile.path] ?? null
    });
  }
  return documents;
}

export async function compileSnapshot(
  app: App,
  project: ProjectConfig | null,
  files: Record<string, FileCache>
): Promise<LorebookSnapshot> {
  if (!project) return createNoProjectSnapshot();
  const documents = await loadProjectDocuments(app, project, files);
  return createReadySnapshot(
    project,
    compileLorebookDocuments(documents, project.syncMode, {
      projectRoot: project.root,
      includeFolderEntries: project.includeFolderEntries
    })
  );
}

export async function exportLorebookJson(
  app: App,
  project: ProjectConfig,
  files: Record<string, FileCache>
): Promise<string> {
  const documents = await loadProjectDocuments(app, project, files);
  const lorebook = compileLorebookDocuments(documents, project.syncMode, {
    projectRoot: project.root,
    includeFolderEntries: project.includeFolderEntries
  });
  const path = `${project.root}/risu_lorebook.json`;
  await atomicWriteVaultFile(
    app,
    path,
    `${JSON.stringify(lorebook, null, 2)}\n`
  );
  return path;
}
