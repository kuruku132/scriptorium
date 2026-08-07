import {
  App,
  FileSystemAdapter,
  TFile,
  TFolder,
  normalizePath
} from "obsidian";
import {
  isPathInside,
  matchesGlob,
  normalizeVaultPath,
  parseMarkdown
} from "../shared/markdown";
import {
  DATA_VERSION,
  DEFAULT_SETTINGS,
  emptyProjectCache,
  type CbsMockMeta,
  type CbsTestValues,
  type ProjectCache,
  type ProjectConfig,
  type RuntimeData,
  type ScriptoriumSettings
} from "../shared/types";
import { runOneTimeLegacyVaultMigration } from "./migration";

export const DEFAULT_EXCLUDE_GLOBS = [
  "prompt.md",
  "risuignore.md",
  "translation_cache.json",
  "risu_lorebook.json",
  "all_docs_combined.md"
];

function cloneDefaults(): ScriptoriumSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function projectName(root: string): string {
  const parts = normalizeVaultPath(root).split("/");
  return parts.at(-1) || "Vault";
}

export function createProject(
  root: string,
  existing: ProjectConfig[]
): ProjectConfig {
  const normalizedRoot = normalizeVaultPath(root);
  if (normalizedRoot === "") {
    throw new Error("Vault 루트는 프로젝트로 등록할 수 없습니다.");
  }
  const overlap = existing.find(
    (project) =>
      isPathInside(project.root, normalizedRoot) ||
      isPathInside(normalizedRoot, project.root)
  );
  if (overlap) {
    throw new Error(
      `"${overlap.name}" 프로젝트와 경로가 겹치거나 중첩됩니다.`
    );
  }
  return {
    id: `project-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    name: projectName(normalizedRoot),
    root: normalizedRoot,
    syncMode: "translated",
    excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
    includeFolderEntries: true,
    translationPrompt: "",
    translationGlossary: ""
  };
}

export function parseIgnoreRules(value: string): string[] {
  const patterns: string[] = [];
  let inFence = false;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const pattern = inFence
      ? trimmed
      : trimmed
          .replace(/^[-*+]\s+/, "")
          .replace(/^\d+[.)]\s+/, "")
          .replace(/^`(.+)`$/, "$1")
          .trim();
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

export function findProjectForPath(
  projects: ProjectConfig[],
  path: string | null
): ProjectConfig | null {
  if (!path) return null;
  return (
    projects.find((project) => isPathInside(project.root, path)) ?? null
  );
}

export function relativeProjectPath(
  project: ProjectConfig,
  path: string
): string {
  const normalizedPath = normalizeVaultPath(path);
  return normalizedPath.slice(project.root.length).replace(/^\/+/, "");
}

export function translationPathFor(
  project: ProjectConfig,
  sourcePath: string
): string {
  return normalizePath(
    `${project.root}/translate/${relativeProjectPath(project, sourcePath)}`
  );
}

export function isExcludedPath(
  project: ProjectConfig,
  sourcePath: string
): boolean {
  const relative = relativeProjectPath(project, sourcePath);
  const basename = relative.split("/").at(-1) ?? relative;
  return project.excludeGlobs.some((rawPattern) => {
    const pattern = rawPattern.trim().replaceAll("\\", "/").replace(/^\/+/, "");
    if (pattern === "") return false;
    if (
      matchesGlob(relative, pattern) ||
      matchesGlob(sourcePath, pattern) ||
      matchesGlob(basename, pattern)
    ) {
      return true;
    }
    if (!pattern.endsWith("/")) return false;
    const directory = normalizeVaultPath(pattern);
    return (
      relative === directory ||
      relative.startsWith(`${directory}/`) ||
      relative.split("/").includes(directory)
    );
  });
}

export function listProjectMarkdownFiles(
  app: App,
  project: ProjectConfig
): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter(
      (file) =>
        isPathInside(project.root, file.path) &&
        !isPathInside(`${project.root}/translate`, file.path) &&
        !isExcludedPath(project, file.path)
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function listSourceFiles(
  app: App,
  project: ProjectConfig
): Promise<TFile[]> {
  const files = listProjectMarkdownFiles(app, project);
  const included: TFile[] = [];
  for (const file of files) {
    const parsed = parseMarkdown(await app.vault.cachedRead(file));
    if (parsed.frontmatter?.values.scriptorium === false) continue;
    included.push(file);
  }
  return included;
}

export async function ensureParentFolders(
  app: App,
  filePath: string
): Promise<void> {
  const parts = normalizeVaultPath(filePath).split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current === "" ? part : `${current}/${part}`;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

export async function writeVaultFile(
  app: App,
  path: string,
  content: string
): Promise<TFile> {
  await ensureParentFolders(app, path);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  if (existing) throw new Error(`${path}에 파일이 아닌 항목이 있습니다.`);
  return app.vault.create(path, content);
}

export async function atomicWriteVaultFile(
  app: App,
  path: string,
  content: string
): Promise<void> {
  await ensureParentFolders(app, path);
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    // This branch only runs on desktop. Use CommonJS resolution so Electron
    // does not hand a dynamic `node:` import to the renderer module loader.
    const { writeFile, rename, rm } = require(
      "node:fs/promises"
    ) as typeof import("node:fs/promises");
    const fullPath = adapter.getFullPath(path);
    const temporaryPath = `${fullPath}.scriptorium-${Date.now()}.tmp`;
    await writeFile(temporaryPath, content, "utf8");
    try {
      await rename(temporaryPath, fullPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return;
  }

  const temporaryPath = `${path}.scriptorium-${Date.now()}.tmp`;
  await adapter.write(temporaryPath, content);
  if (await adapter.exists(path)) await adapter.remove(path);
  await adapter.rename(temporaryPath, path);
}

function legacyWorkspaceRoots(raw: Record<string, unknown>): string[] {
  const value = raw.workspaces ?? raw.workspacePaths ?? raw.projects;
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item === "string") paths.push(item);
    else if (item && typeof item === "object") {
      const candidate =
        (item as Record<string, unknown>).directory ??
        (item as Record<string, unknown>).path ??
        (item as Record<string, unknown>).root;
      if (typeof candidate === "string") paths.push(candidate);
    }
  }
  return [...new Set(paths.map(normalizeVaultPath).filter(Boolean))];
}

async function readOptional(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? app.vault.cachedRead(file) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeProject(raw: unknown): ProjectConfig | null {
  const value = record(raw);
  const rootValue = value.root ?? value.directory ?? value.path;
  if (typeof rootValue !== "string") return null;
  const root = normalizeVaultPath(rootValue);
  if (!root) return null;
  const fallback = createProject(root, []);
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id
        : fallback.id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : projectName(root),
    root,
    syncMode: value.syncMode === "original" ? "original" : "translated",
    excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
    includeFolderEntries:
      typeof value.includeFolderEntries === "boolean"
        ? value.includeFolderEntries
        : true,
    translationPrompt:
      typeof value.translationPrompt === "string"
        ? value.translationPrompt
        : "",
    translationGlossary:
      typeof value.translationGlossary === "string"
        ? value.translationGlossary
        : ""
  };
}

function legacyProjectIgnorePatterns(
  rawSettings: Record<string, unknown>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(rawSettings.projects)) return result;
  for (const rawProject of rawSettings.projects) {
    const project = record(rawProject);
    const rootValue = project.root ?? project.directory ?? project.path;
    if (typeof rootValue !== "string" || !Array.isArray(project.excludeGlobs)) {
      continue;
    }
    const root = normalizeVaultPath(rootValue);
    result[root] = project.excludeGlobs
      .map(String)
      .map((item) => item.trim())
      .filter(
        (item) => item !== "" && !DEFAULT_EXCLUDE_GLOBS.includes(item)
      );
  }
  return result;
}

function normalizeCaches(raw: unknown): Record<string, ProjectCache> {
  return Object.fromEntries(
    Object.entries(record(raw)).map(([id, cacheValue]) => {
      const cache = record(cacheValue) as unknown as ProjectCache;
      return [
        id,
        {
          ...cache,
          files: cache.files ?? {},
          selectedChangeIds: cache.selectedChangeIds ?? [],
          knownChangeIds: cache.knownChangeIds ?? []
        }
      ];
    })
  );
}

function normalizeModernSettings(raw: unknown): ScriptoriumSettings {
  const value = record(raw);
  const api = record(value.api);
  const localServer = record(value.localServer);
  const relay = record(value.relay);
  const advanced = record(value.advanced);
  const cbsMockMetaRaw = record(value.cbsMockMeta);
  const mockMeta: CbsMockMeta = {
    char: typeof cbsMockMetaRaw.char === "string" ? cbsMockMetaRaw.char : DEFAULT_SETTINGS.cbsMockMeta.char,
    user: typeof cbsMockMetaRaw.user === "string" ? cbsMockMetaRaw.user : DEFAULT_SETTINGS.cbsMockMeta.user,
    persona: typeof cbsMockMetaRaw.persona === "string" ? cbsMockMetaRaw.persona : DEFAULT_SETTINGS.cbsMockMeta.persona,
    model: typeof cbsMockMetaRaw.model === "string" ? cbsMockMetaRaw.model : DEFAULT_SETTINGS.cbsMockMeta.model,
    maxcontext: positiveInteger(cbsMockMetaRaw.maxcontext, DEFAULT_SETTINGS.cbsMockMeta.maxcontext)
  };
  return {
    version: DATA_VERSION,
    projects: Array.isArray(value.projects)
      ? value.projects
          .map(normalizeProject)
          .filter((project): project is ProjectConfig => project !== null)
      : [],
    translationPrompt:
      typeof value.translationPrompt === "string"
        ? value.translationPrompt
        : DEFAULT_SETTINGS.translationPrompt,
    translationGlossary:
      typeof value.translationGlossary === "string"
        ? value.translationGlossary
        : DEFAULT_SETTINGS.translationGlossary,
    api: {
      baseUrl:
        typeof api.baseUrl === "string"
          ? api.baseUrl
          : DEFAULT_SETTINGS.api.baseUrl,
      model:
        typeof api.model === "string"
          ? api.model
          : DEFAULT_SETTINGS.api.model,
      secretName:
        typeof api.secretName === "string"
          ? api.secretName
          : DEFAULT_SETTINGS.api.secretName,
      proxyUrl:
        typeof api.proxyUrl === "string"
          ? api.proxyUrl
          : DEFAULT_SETTINGS.api.proxyUrl,
      maxRetries: positiveInteger(
        api.maxRetries,
        DEFAULT_SETTINGS.api.maxRetries
      ),
      initialBackoffSeconds: positiveInteger(
        api.initialBackoffSeconds,
        DEFAULT_SETTINGS.api.initialBackoffSeconds
      ),
      requestTimeoutSeconds: positiveInteger(
        api.requestTimeoutSeconds,
        DEFAULT_SETTINGS.api.requestTimeoutSeconds
      )
    },
    localServer: {
      enabled:
        typeof localServer.enabled === "boolean"
          ? localServer.enabled
          : DEFAULT_SETTINGS.localServer.enabled,
      port: positiveInteger(
        localServer.port,
        DEFAULT_SETTINGS.localServer.port
      )
    },
    relay: {
      enabled:
        typeof relay.enabled === "boolean"
          ? relay.enabled
          : DEFAULT_SETTINGS.relay.enabled,
      baseUrl:
        typeof relay.baseUrl === "string"
          ? relay.baseUrl
          : DEFAULT_SETTINGS.relay.baseUrl,
      channel:
        typeof relay.channel === "string"
          ? relay.channel
          : DEFAULT_SETTINGS.relay.channel,
      secretName:
        typeof relay.secretName === "string"
          ? relay.secretName
          : DEFAULT_SETTINGS.relay.secretName,
      autoPush:
        typeof relay.autoPush === "boolean"
          ? relay.autoPush
          : DEFAULT_SETTINGS.relay.autoPush
    },
    advanced: {
      deduplicateKoreanParentheses:
        typeof advanced.deduplicateKoreanParentheses === "boolean"
          ? advanced.deduplicateKoreanParentheses
          : false,
      maxParallelTranslations: Math.min(
        8,
        positiveInteger(
          advanced.maxParallelTranslations,
          DEFAULT_SETTINGS.advanced.maxParallelTranslations
        )
      )
    },
    migrationWarnings: Array.isArray(value.migrationWarnings)
      ? value.migrationWarnings.map(String)
      : [],
    cbsTestValues: normalizeCbsTestValues(value.cbsTestValues),
    cbsMockMeta: mockMeta
  };
}

// CBS 테스트 값 코어션: 경로별 {chatVars, toggles} 를 안전 타입으로 변환.
function normalizeCbsTestValues(raw: unknown): Record<string, CbsTestValues> {
  const value = record(raw);
  const out: Record<string, CbsTestValues> = {};
  for (const key of Object.keys(value)) {
    const entry = record(value[key]);
    const chatVarsRaw = record(entry.chatVars);
    const togglesRaw = record(entry.toggles);
    const chatVars: Record<string, string> = {};
    for (const k of Object.keys(chatVarsRaw)) {
      chatVars[k] = String(chatVarsRaw[k] ?? "");
    }
    const toggles: Record<string, boolean> = {};
    for (const k of Object.keys(togglesRaw)) {
      toggles[k] = togglesRaw[k] === true;
    }
    out[key] = { chatVars, toggles };
  }
  return out;
}

export async function migrateRuntimeData(
  app: App,
  raw: unknown,
  _activePath: string | null
): Promise<RuntimeData> {
  const rawRecord = record(raw);
  const wrappedSettings = record(rawRecord.settings);
  const wrappedVersion = Number(wrappedSettings.version);
  const directVersion = Number(rawRecord.version);
  if (wrappedVersion === DATA_VERSION) {
    return {
      settings: normalizeModernSettings(wrappedSettings),
      caches: normalizeCaches(rawRecord.caches)
    };
  }
  if (directVersion === DATA_VERSION) {
    return {
      settings: normalizeModernSettings(rawRecord),
      caches: {}
    };
  }

  // v3 → v4: 순수 스키마 확장(cbsTestValues/cbsMockMeta 추가). 캐시 보존.
  if (wrappedVersion === 3 || directVersion === 3) {
    const source = wrappedVersion === 3 ? wrappedSettings : rawRecord;
    return {
      settings: normalizeModernSettings(source),
      caches: wrappedVersion === 3 ? normalizeCaches(rawRecord.caches) : {}
    };
  }

  if (wrappedVersion === 2 || directVersion === 2) {
    const source = wrappedVersion === 2 ? wrappedSettings : rawRecord;
    const settings = normalizeModernSettings(source);
    const legacyIgnores = legacyProjectIgnorePatterns(source);
    const summary = await runOneTimeLegacyVaultMigration(
      app,
      settings.projects,
      legacyIgnores
    );
    if (summary.changed > 0) {
      settings.migrationWarnings.push(
        `일회성 마이그레이션으로 legacy frontmatter ${summary.changed}개를 현재 형식으로 변환했습니다.`
      );
    }
    if (summary.ignored > 0) {
      settings.migrationWarnings.push(
        `legacy ignore 규칙을 문서 ${summary.ignored}개의 scriptorium: false frontmatter로 변환했습니다.`
      );
    }
    return {
      settings,
      caches:
        wrappedVersion === 2 ? normalizeCaches(rawRecord.caches) : {}
    };
  }

  const legacy = rawRecord;
  const settings = cloneDefaults();
  const caches: Record<string, ProjectCache> = {};
  const legacyIgnores: Record<string, string[]> = {};
  const roots = legacyWorkspaceRoots(legacy);
  for (const root of roots) {
    try {
      const project = createProject(root, settings.projects);
      settings.projects.push(project);
      caches[project.id] = emptyProjectCache();
      const ignore = await readOptional(app, `${root}/risuignore.md`);
      if (ignore) {
        legacyIgnores[root] = parseIgnoreRules(ignore);
      }
    } catch (error) {
      settings.migrationWarnings.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  if (typeof legacy.translationPrompt === "string") {
    settings.translationPrompt = legacy.translationPrompt;
  }
  for (const project of settings.projects) {
    const prompt = await readOptional(app, `${project.root}/prompt.md`);
    if (prompt?.trim()) project.translationPrompt = prompt.trim();
  }

  const syncMode = legacy.risuSyncMode === "original" ? "original" : "translated";
  for (const project of settings.projects) {
    project.syncMode = syncMode;
    if (typeof legacy.includeFolderEntries === "boolean") {
      project.includeFolderEntries = legacy.includeFolderEntries;
    }
  }
  if (typeof legacy.openaiCompatibleApiUrl === "string") {
    settings.api.baseUrl = legacy.openaiCompatibleApiUrl;
  }
  if (typeof legacy.openaiCompatibleModel === "string") {
    settings.api.model = legacy.openaiCompatibleModel;
  }
  if (typeof legacy.proxyUrl === "string") {
    settings.api.proxyUrl = legacy.proxyUrl;
  }
  settings.api.maxRetries = positiveInteger(
    legacy.maxRetries,
    settings.api.maxRetries
  );
  settings.api.initialBackoffSeconds = positiveInteger(
    legacy.initialBackoffSeconds,
    settings.api.initialBackoffSeconds
  );
  settings.api.requestTimeoutSeconds = positiveInteger(
    legacy.requestTimeoutSeconds,
    settings.api.requestTimeoutSeconds
  );
  if (
    typeof legacy.openaiCompatibleApiKey === "string" &&
    legacy.openaiCompatibleApiKey.trim()
  ) {
    settings.migrationWarnings.push(
      "기존 API 키는 보안을 위해 옮기지 않았습니다. SecretStorage에서 다시 선택해 주세요."
    );
  }
  if (typeof legacy.risuSyncEnabled === "boolean") {
    settings.localServer.enabled = legacy.risuSyncEnabled;
  }
  settings.localServer.port = positiveInteger(
    legacy.risuSyncPort,
    settings.localServer.port
  );
  if (typeof legacy.relayUrl === "string" && legacy.relayUrl.trim()) {
    settings.relay.baseUrl = legacy.relayUrl.trim();
    settings.relay.enabled = false;
    settings.migrationWarnings.push(
      "구형 릴레이 주소는 보존했지만 새 스냅샷 채널이 필요해 비활성화했습니다."
    );
  }

  const summary = await runOneTimeLegacyVaultMigration(
    app,
    settings.projects,
    legacyIgnores
  );
  if (summary.changed > 0) {
    settings.migrationWarnings.push(
      `일회성 마이그레이션으로 legacy frontmatter ${summary.changed}개를 현재 형식으로 변환했습니다.`
    );
  }
  if (summary.ignored > 0) {
    settings.migrationWarnings.push(
      `legacy ignore 규칙을 문서 ${summary.ignored}개의 scriptorium: false frontmatter로 변환했습니다.`
    );
  }
  return { settings, caches };
}

export function isFolder(value: unknown): value is TFolder {
  return value instanceof TFolder;
}
