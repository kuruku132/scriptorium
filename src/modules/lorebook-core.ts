import {
  extractKeys,
  normalizeVaultPath,
  parseMarkdown,
  stableHash
} from "../shared/markdown";
import {
  SNAPSHOT_SCHEMA,
  type LorebookSnapshot,
  type LorebookDocumentUnit,
  type ProjectConfig,
  type RisuEntry,
  type RisuEntryMode,
  type RisuLorebook,
  type SnapshotResponse,
  type SourceDocument,
  type SyncMode
} from "../shared/types";

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function asDelimitedString(value: unknown): string {
  return asStringArray(value).join(", ");
}

function asRisuEntryMode(value: unknown): RisuEntryMode {
  switch (value) {
    case "multiple":
    case "constant":
    case "normal":
    case "child":
    case "folder":
      return value;
    default:
      return "normal";
  }
}

function translatedFrontmatterKeys(document: SourceDocument): string[] {
  const value = document.translation?.frontmatter?.values.keys;
  return asStringArray(value);
}

export interface LorebookCompileOptions {
  projectRoot?: string;
  includeFolderEntries?: boolean;
}

function relativeDocumentPath(path: string, root: string): string {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedRoot = normalizeVaultPath(root);
  return normalizedPath
    .slice(normalizedRoot.length)
    .replace(/^\/+/, "");
}

function stableEntryId(kind: "entry" | "folder", path: string): string {
  return `scriptorium-${kind}-${stableHash(`${kind}\0${path}`)}`;
}

export function compileLorebookDocuments(
  documents: SourceDocument[],
  mode: SyncMode,
  options: LorebookCompileOptions = {}
): RisuLorebook {
  return {
    type: "risu",
    ver: 1,
    data: compileLorebookDocumentUnits(documents, mode, options).flatMap(
      (document) => document.entries
    )
  };
}

export function compileLorebookDocumentUnits(
  documents: SourceDocument[],
  mode: SyncMode,
  options: LorebookCompileOptions = {}
): LorebookDocumentUnit[] {
  const units: LorebookDocumentUnit[] = [];
  const folderKeys = new Map<string, string>();
  const sorted = [...documents].sort((left, right) =>
    left.path.localeCompare(right.path)
  );

  for (const document of sorted) {
    const metadata = document.source.frontmatter?.values ?? {};
    if (metadata.scriptorium === false) continue;
    const originalKeys = extractKeys(document.source, document.basename);
    let content = document.source.body.trim();
    let keys = originalKeys;

    if (mode === "translated") {
      const successful =
        document.cache?.lastSuccessfulTranslation ??
        (document.translation
          ? `${document.translation.body.trim()}\n`
          : null);
      if (!successful) continue;
      content = parseMarkdown(successful).body.trim();
      keys = [
        ...new Set([
          ...originalKeys,
          ...(document.cache?.translatedKeys ?? []),
          ...translatedFrontmatterKeys(document)
        ])
      ];
    }

    const relativePath = relativeDocumentPath(
      document.path,
      options.projectRoot ?? ""
    );
    const folderPath = relativePath.split("/").slice(0, -1).join("/");
    if (options.includeFolderEntries && folderPath) {
      let current = "";
      for (const segment of folderPath.split("/")) {
        const parent = current;
        current = current ? `${current}/${segment}` : segment;
        if (folderKeys.has(current)) continue;
        const id = stableEntryId("folder", current);
        const key = `\uF000folder:${id}`;
        folderKeys.set(current, key);
        const folderEntry: RisuEntry = {
          id,
          key,
          secondkey: "",
          comment: segment,
          content: "",
          insertorder: 100,
          mode: "folder",
          alwaysActive: false,
          selective: false
        };
        const parentKey = parent ? folderKeys.get(parent) : undefined;
        if (parentKey) folderEntry.folder = parentKey;
        units.push({
          id: `folder:${id}`,
          path: current,
          hash: stableHash(JSON.stringify(folderEntry)),
          entries: [folderEntry]
        });
      }
    }

    const configuredId =
      typeof metadata.id === "string" && metadata.id.trim()
        ? metadata.id.trim()
        : stableEntryId("entry", relativePath);
    const entry: RisuEntry = {
      id: configuredId,
      key: keys.join(", "),
      secondkey: asDelimitedString(metadata.secondkey),
      comment:
        typeof metadata.title === "string"
          ? metadata.title
          : document.basename,
      content,
      insertorder: asNumber(metadata.insertorder, 100),
      mode: asRisuEntryMode(metadata.mode),
      alwaysActive: asBoolean(metadata.alwaysActive, false),
      selective: asBoolean(metadata.selective, false)
    };
    const folderKey =
      options.includeFolderEntries && folderPath
        ? folderKeys.get(folderPath)
        : undefined;
    if (folderKey) entry.folder = folderKey;
    units.push({
      id: `document:${stableHash(document.path)}`,
      path: document.path,
      hash: stableHash(JSON.stringify({ mode, entry })),
      entries: [entry]
    });
  }
  return units;
}

export function createReadySnapshot(
  project: ProjectConfig,
  lorebook: RisuLorebook
): LorebookSnapshot {
  const payload = JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    status: "ready",
    project: { id: project.id, name: project.name },
    mode: project.syncMode,
    lorebook
  });
  return {
    schema: SNAPSHOT_SCHEMA,
    status: "ready",
    project: { id: project.id, name: project.name },
    mode: project.syncMode,
    hash: stableHash(payload),
    lorebook
  };
}

export function createNoProjectSnapshot(): LorebookSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    status: "no-active-project",
    hash: stableHash("scriptorium:no-active-project:v1")
  };
}

export function snapshotHttpResponse(
  snapshot: LorebookSnapshot,
  ifNoneMatch?: string,
  allowed = true
): SnapshotResponse {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, If-None-Match, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
    ETag: `"${snapshot.hash}"`,
    "Content-Type": "application/json; charset=utf-8"
  };
  if (!allowed) {
    return {
      status: 401,
      headers,
      body: JSON.stringify({ error: "unauthorized" })
    };
  }
  if (ifNoneMatch?.replace(/^W\//, "").replaceAll('"', "") === snapshot.hash) {
    return { status: 304, headers, body: null };
  }
  return { status: 200, headers, body: JSON.stringify(snapshot) };
}
