import { TFile, type App } from "obsidian";
import {
  frontmatterString,
  isPathInside,
  parseMarkdown
} from "../shared/markdown";
import type {
  ProjectConfig,
  RisuEntry,
  RisuLorebook
} from "../shared/types";
import {
  listProjectMarkdownFiles,
  listSourceFiles,
  relativeProjectPath,
  writeVaultFile
} from "./project";

const METADATA_KEYS = [
  "id",
  "title",
  "keys",
  "secondkey",
  "selective",
  "alwaysActive",
  "insertorder",
  "mode"
] as const;

export type MetadataUpdateMode = "add" | "replace" | "remove";

export interface ToolSummary {
  changed: number;
  skipped: number;
  total: number;
}

export interface ImportSummary {
  created: number;
  overwritten: number;
  skipped: number;
}

export interface ProjectDocumentSetting {
  path: string;
  included: boolean;
}

function documentContent(
  values: Record<string, unknown>,
  body: string
): string {
  const frontmatter = frontmatterString(values);
  const normalizedBody = body.replace(/^\n+/, "");
  return `${frontmatter}${normalizedBody}${
    normalizedBody === "" || normalizedBody.endsWith("\n") ? "" : "\n"
  }`;
}

function metadataDefaults(file: TFile): Record<string, unknown> {
  return {
    title: file.basename,
    keys: [file.basename],
    secondkey: [],
    selective: false,
    alwaysActive: false,
    insertorder: 100,
    mode: "normal"
  };
}

export function updateMetadataContent(
  content: string,
  file: TFile,
  mode: MetadataUpdateMode
): string {
  const parsed = parseMarkdown(content);
  const values = { ...(parsed.frontmatter?.values ?? {}) };
  const defaults = metadataDefaults(file);
  if (mode === "remove") {
    for (const key of METADATA_KEYS) delete values[key];
  } else if (mode === "replace") {
    for (const key of METADATA_KEYS) delete values[key];
    Object.assign(values, defaults);
  } else {
    for (const [key, value] of Object.entries(defaults)) {
      if (values[key] === undefined) values[key] = value;
    }
  }
  return documentContent(values, parsed.body);
}

export async function updateProjectMetadata(
  app: App,
  project: ProjectConfig,
  mode: MetadataUpdateMode
): Promise<ToolSummary> {
  const files = listProjectMarkdownFiles(app, project);
  let changed = 0;
  for (const file of files) {
    const parsed = parseMarkdown(await app.vault.cachedRead(file));
    const current = parsed.frontmatter?.values ?? {};
    const defaults = metadataDefaults(file);
    const hasMetadata = METADATA_KEYS.some(
      (key) => current[key] !== undefined
    );
    const shouldChange =
      mode === "remove"
        ? hasMetadata
        : mode === "replace" ||
          Object.keys(defaults).some((key) => current[key] === undefined);
    if (!shouldChange) continue;
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (mode === "remove" || mode === "replace") {
        for (const key of METADATA_KEYS) delete frontmatter[key];
      }
      if (mode !== "remove") {
        for (const [key, value] of Object.entries(defaults)) {
          if (mode === "replace" || frontmatter[key] === undefined) {
            frontmatter[key] = value;
          }
        }
      }
    });
    changed += 1;
  }
  return {
    changed,
    skipped: files.length - changed,
    total: files.length
  };
}

export async function readProjectDocumentSettings(
  app: App,
  project: ProjectConfig
): Promise<ProjectDocumentSetting[]> {
  const files = app.vault
    .getMarkdownFiles()
    .filter(
      (file) =>
        isPathInside(project.root, file.path) &&
        !isPathInside(`${project.root}/translate`, file.path) &&
        ![
          "prompt.md",
          "risuignore.md",
          "all_docs_combined.md"
        ].includes(relativeProjectPath(project, file.path))
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const result: ProjectDocumentSetting[] = [];
  for (const file of files) {
    const parsed = parseMarkdown(await app.vault.cachedRead(file));
    result.push({
      path: file.path,
      included: parsed.frontmatter?.values.scriptorium !== false
    });
  }
  return result;
}

export async function setProjectDocumentIncluded(
  app: App,
  path: string,
  included: boolean
): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`문서를 찾을 수 없습니다: ${path}`);
  const current = parseMarkdown(await app.vault.cachedRead(file))
    .frontmatter?.values.scriptorium;
  if ((current !== false) === included) return;
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (included) delete frontmatter.scriptorium;
    else frontmatter.scriptorium = false;
  });
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100);
}

function commaList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function folderPathFor(
  folderKey: string | undefined,
  folders: Map<string, { name: string; parent?: string }>
): string {
  if (!folderKey) return "";
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = folderKey;
  while (current && folders.has(current) && !seen.has(current)) {
    seen.add(current);
    const folder = folders.get(current);
    if (!folder) break;
    const name = sanitizeFilename(folder.name);
    if (name) parts.unshift(name);
    current = folder.parent;
  }
  return parts.join("/");
}

export function parseRisuLorebook(raw: string): RisuLorebook {
  const value = JSON.parse(raw) as Partial<RisuLorebook>;
  if (!value || value.type !== "risu" || !Array.isArray(value.data)) {
    throw new Error("유효한 RisuAI 로어북 JSON이 아닙니다.");
  }
  return { type: "risu", ver: 1, data: value.data as RisuEntry[] };
}

export async function importRisuLorebook(
  app: App,
  project: ProjectConfig,
  lorebook: RisuLorebook
): Promise<ImportSummary> {
  const folders = new Map<string, { name: string; parent?: string }>();
  for (const entry of lorebook.data) {
    if (entry.mode !== "folder" || !entry.key) continue;
    folders.set(entry.key, {
      name: entry.comment || "folder",
      ...(entry.folder ? { parent: entry.folder } : {})
    });
  }

  let created = 0;
  let overwritten = 0;
  let skipped = 0;
  const used = new Set<string>();
  for (const entry of lorebook.data) {
    if (!entry || entry.mode === "folder") continue;
    const title = String(entry.comment || entry.id || "entry");
    const basename = sanitizeFilename(title);
    if (!basename) {
      skipped += 1;
      continue;
    }
    const folder = folderPathFor(entry.folder, folders);
    let relative = folder ? `${folder}/${basename}.md` : `${basename}.md`;
    let suffix = 2;
    while (used.has(relative)) {
      relative = folder
        ? `${folder}/${basename} (${suffix}).md`
        : `${basename} (${suffix}).md`;
      suffix += 1;
    }
    used.add(relative);
    const path = `${project.root}/${relative}`;
    const values: Record<string, unknown> = {
      ...(entry.id ? { id: entry.id } : {}),
      title,
      keys: commaList(entry.key),
      secondkey: commaList(entry.secondkey),
      selective: Boolean(entry.selective),
      alwaysActive: Boolean(entry.alwaysActive),
      insertorder: Number.isFinite(Number(entry.insertorder))
        ? Number(entry.insertorder)
        : 100,
      mode: entry.mode || "normal"
    };
    const body = String(entry.content ?? "").replace(/^\n+/, "");
    const existed = app.vault.getAbstractFileByPath(path) !== null;
    await writeVaultFile(app, path, documentContent(values, body));
    if (existed) overwritten += 1;
    else created += 1;
  }
  return { created, overwritten, skipped };
}

export async function mergeProjectMarkdown(
  app: App,
  project: ProjectConfig
): Promise<{ path: string; count: number }> {
  const outputPath = `${project.root}/all_docs_combined.md`;
  const files = (await listSourceFiles(app, project)).filter(
    (file) => file.path !== outputPath
  );
  const lines = ["# 통합 문서", ""];
  for (const file of files) {
    const relative = relativeProjectPath(project, file.path);
    const content = await app.vault.cachedRead(file);
    lines.push(
      `## ${relative}`,
      "",
      content.trim() || "(비어 있음)",
      ""
    );
  }
  await writeVaultFile(app, outputPath, `${lines.join("\n").trimEnd()}\n`);
  return { path: outputPath, count: files.length };
}

export async function createLorebookBase(
  app: App,
  project: ProjectConfig
): Promise<string> {
  const path = `${project.root}/lorebook_meta.base`;
  const root = project.root.replaceAll('"', '\\"');
  const content = [
    "filters:",
    "  and:",
    `    - file.inFolder(\"${root}\")`,
    "",
    "properties:",
    "  title:",
    "    displayName: 제목",
    "  keys:",
    "    displayName: 키",
    "  secondkey:",
    "    displayName: 보조 키",
    "  selective:",
    "    displayName: 선택 활성화",
    "  alwaysActive:",
    "    displayName: 항상 활성화",
    "  insertorder:",
    "    displayName: 삽입 순서",
    "  mode:",
    "    displayName: 모드",
    "  scriptorium:",
    "    displayName: Scriptorium 포함",
    "",
    "views:",
    "  - type: table",
    "    name: 로어북 메타데이터",
    "    order:",
    "      - file.name",
    "      - title",
    "      - keys",
    "      - secondkey",
    "      - selective",
    "      - alwaysActive",
    "      - insertorder",
    "      - mode",
    "      - scriptorium",
    ""
  ].join("\n");
  await writeVaultFile(app, path, content);
  return path;
}

export function deduplicateKoreanParentheses(
  text: string,
  seen = new Set<string>()
): string {
  return text.replace(
    /( ?)\(([^)]*[가-힣][^)]*)\)/g,
    (match, _space: string, inner: string) => {
      const key = `(${inner})`;
      if (seen.has(key)) return "";
      seen.add(key);
      return match;
    }
  );
}

export async function deduplicateTranslatedFiles(
  app: App,
  project: ProjectConfig
): Promise<ToolSummary> {
  const root = `${project.root}/translate`;
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => isPathInside(root, file.path));
  let changed = 0;
  for (const file of files) {
    const current = await app.vault.cachedRead(file);
    const parsed = parseMarkdown(current);
    const body = deduplicateKoreanParentheses(parsed.body);
    const next = parsed.frontmatter
      ? `---\n${parsed.frontmatter.raw}\n---\n${body}`
      : body;
    if (next === current) continue;
    await app.vault.modify(file, next);
    changed += 1;
  }
  return {
    changed,
    skipped: files.length - changed,
    total: files.length
  };
}
