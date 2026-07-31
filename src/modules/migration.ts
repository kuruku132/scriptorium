import type { App } from "obsidian";
import {
  isPathInside,
  matchesGlob,
  normalizeVaultPath
} from "../shared/markdown";
import type { ProjectConfig } from "../shared/types";

const LEGACY_TO_CURRENT: Record<string, string> = {
  secondary_keys: "secondkey",
  always_active: "alwaysActive",
  insertion_order: "insertorder",
  enabled: "scriptorium"
};

const LOREBOOK_KEYS = new Set([
  "id",
  "title",
  "keys",
  "secondary_keys",
  "secondkey",
  "selective",
  "always_active",
  "alwaysActive",
  "insertion_order",
  "insertorder",
  "enabled",
  "scriptorium",
  "mode"
]);

interface YamlBlock {
  key: string;
  start: number;
  end: number;
  lines: string[];
}

export interface LegacyContentMigration {
  content: string;
  changed: boolean;
}

export interface LegacyVaultMigrationSummary {
  scanned: number;
  changed: number;
  ignored: number;
}

function frontmatterParts(content: string): {
  raw: string;
  body: string;
} | null {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const close = normalized.indexOf("\n---", 4);
  if (close < 0) return null;
  const after = close + 4;
  if (after < normalized.length && normalized[after] !== "\n") return null;
  return {
    raw: normalized.slice(4, close),
    body: normalized.slice(normalized[after] === "\n" ? after + 1 : after)
  };
}

function yamlBlocks(lines: string[]): YamlBlock[] {
  const starts: Array<{ key: string; start: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(/^([A-Za-z0-9_-]+)\s*:/);
    if (match?.[1]) starts.push({ key: match[1], start: index });
  }
  return starts.map((entry, index) => {
    const end = starts[index + 1]?.start ?? lines.length;
    return {
      key: entry.key,
      start: entry.start,
      end,
      lines: lines.slice(entry.start, end)
    };
  });
}

function renamedBlock(block: YamlBlock, key: string): string[] {
  const [first = "", ...rest] = block.lines;
  return [first.replace(/^([A-Za-z0-9_-]+)(\s*:)/, `${key}$2`), ...rest];
}

function nestedLorebookBlocks(block: YamlBlock): YamlBlock[] {
  const nested = block.lines
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^ {2}/, ""));
  return yamlBlocks(nested).filter((entry) => LOREBOOK_KEYS.has(entry.key));
}

export function migrateLegacyFrontmatter(
  content: string
): LegacyContentMigration {
  const parts = frontmatterParts(content);
  if (!parts) return { content, changed: false };

  const lines = parts.raw.split("\n");
  const blocks = yamlBlocks(lines);
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const additions: string[][] = [];
  const removals = new Set<string>();

  for (const [legacyKey, currentKey] of Object.entries(LEGACY_TO_CURRENT)) {
    const legacy = byKey.get(legacyKey);
    if (!legacy) continue;
    removals.add(legacyKey);
    if (!byKey.has(currentKey)) {
      additions.push(renamedBlock(legacy, currentKey));
      byKey.set(currentKey, legacy);
    }
  }

  const lorebook = byKey.get("lorebook");
  if (lorebook) {
    for (const nested of nestedLorebookBlocks(lorebook)) {
      const currentKey = LEGACY_TO_CURRENT[nested.key] ?? nested.key;
      if (byKey.has(currentKey)) continue;
      additions.push(renamedBlock(nested, currentKey));
      byKey.set(currentKey, nested);
    }
    removals.add("lorebook");
  }

  if (removals.size === 0 && additions.length === 0) {
    return { content, changed: false };
  }

  const removedLines = new Set<number>();
  for (const block of blocks) {
    if (!removals.has(block.key)) continue;
    for (let index = block.start; index < block.end; index += 1) {
      removedLines.add(index);
    }
  }
  const kept = lines.filter((_, index) => !removedLines.has(index));
  while (kept.at(-1)?.trim() === "") kept.pop();
  for (const addition of additions) {
    if (kept.length > 0 && kept.at(-1)?.trim() !== "") kept.push("");
    kept.push(...addition);
  }
  const raw = kept.join("\n").trimEnd();
  const migrated = `---\n${raw}\n---\n${parts.body}`;
  return { content: migrated, changed: migrated !== content };
}

export function setScriptoriumIncluded(
  content: string,
  included: boolean
): LegacyContentMigration {
  const parts = frontmatterParts(content);
  if (!parts) {
    if (included) return { content, changed: false };
    const migrated = `---\nscriptorium: false\n---\n${content}`;
    return { content: migrated, changed: migrated !== content };
  }
  const lines = parts.raw.split("\n");
  const blocks = yamlBlocks(lines);
  const existing = blocks.find((block) => block.key === "scriptorium");
  if (!existing && included) return { content, changed: false };

  const removed = new Set<number>();
  if (existing) {
    for (let index = existing.start; index < existing.end; index += 1) {
      removed.add(index);
    }
  }
  const next = lines.filter((_, index) => !removed.has(index));
  while (next.at(-1)?.trim() === "") next.pop();
  if (!included) {
    if (next.length > 0 && next.at(-1)?.trim() !== "") next.push("");
    next.push("scriptorium: false");
  }
  const raw = next.join("\n").trimEnd();
  const prefix = raw ? `---\n${raw}\n---\n` : "";
  const migrated = `${prefix}${parts.body}`;
  return { content: migrated, changed: migrated !== content };
}

function ignoredByPattern(
  project: ProjectConfig,
  path: string,
  patterns: string[]
): boolean {
  const relative = normalizeVaultPath(path)
    .slice(normalizeVaultPath(project.root).length)
    .replace(/^\/+/, "");
  const basename = relative.split("/").at(-1) ?? relative;
  return patterns.some((raw) => {
    const pattern = raw.trim().replaceAll("\\", "/").replace(/^\/+/, "");
    if (!pattern) return false;
    if (
      matchesGlob(relative, pattern) ||
      matchesGlob(basename, pattern)
    ) {
      return true;
    }
    if (!pattern.endsWith("/")) return false;
    const folder = normalizeVaultPath(pattern);
    return relative === folder || relative.startsWith(`${folder}/`);
  });
}

export async function runOneTimeLegacyVaultMigration(
  app: App,
  projects: ProjectConfig[],
  legacyIgnorePatterns: Record<string, string[]> = {}
): Promise<LegacyVaultMigrationSummary> {
  const roots = projects.map((project) => project.root);
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => roots.some((root) => isPathInside(root, file.path)));
  let changed = 0;
  let ignored = 0;
  for (const file of files) {
    const current = await app.vault.cachedRead(file);
    let migrated = migrateLegacyFrontmatter(current);
    const project = projects.find((entry) =>
      isPathInside(entry.root, file.path)
    );
    const patterns = project
      ? legacyIgnorePatterns[project.root] ?? []
      : [];
    if (
      project &&
      !isPathInside(`${project.root}/translate`, file.path) &&
      ignoredByPattern(project, file.path, patterns)
    ) {
      migrated = setScriptoriumIncluded(migrated.content, false);
      ignored += 1;
    }
    if (!migrated.changed && migrated.content === current) continue;
    await app.vault.modify(file, migrated.content);
    changed += 1;
  }
  return { scanned: files.length, changed, ignored };
}
