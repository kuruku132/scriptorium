export const DATA_VERSION = 3 as const;
export const SNAPSHOT_SCHEMA = 1 as const;

export type SyncMode = "original" | "translated";
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "quote"
  | "code";
export type ChangeKind =
  | "insert"
  | "modify"
  | "delete"
  | "move"
  | "split"
  | "merge"
  | "metadata";
export type TranslationState =
  | "clean"
  | "pending"
  | "manual"
  | "conflict"
  | "orphan";

export interface ProjectConfig {
  id: string;
  name: string;
  root: string;
  syncMode: SyncMode;
  excludeGlobs: string[];
  includeFolderEntries: boolean;
  translationPrompt: string;
}

export interface ApiSettings {
  baseUrl: string;
  model: string;
  secretName: string;
  proxyUrl: string;
  maxRetries: number;
  initialBackoffSeconds: number;
  requestTimeoutSeconds: number;
}

export interface LocalServerSettings {
  enabled: boolean;
  port: number;
}

export interface RelaySettings {
  enabled: boolean;
  baseUrl: string;
  channel: string;
  secretName: string;
  autoPush: boolean;
}

export interface AdvancedSettings {
  deduplicateKoreanParentheses: boolean;
}

export interface ScriptoriumSettings {
  version: typeof DATA_VERSION;
  projects: ProjectConfig[];
  translationPrompt: string;
  api: ApiSettings;
  localServer: LocalServerSettings;
  relay: RelaySettings;
  advanced: AdvancedSettings;
  migrationWarnings: string[];
}

export interface MarkdownFrontmatter {
  raw: string;
  values: Record<string, unknown>;
}

export interface MarkdownBlock {
  id: string;
  kind: BlockKind;
  text: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

export interface ParsedMarkdown {
  frontmatter: MarkdownFrontmatter | null;
  body: string;
  blocks: MarkdownBlock[];
}

export interface CachedBlock {
  id: string;
  kind: BlockKind;
  lastSource: string;
  lastGenerated: string | null;
  headingPath: string[];
}

export interface FileCache {
  sourcePath: string;
  translationPath: string;
  blocks: CachedBlock[];
  sourceFrontmatterHash: string;
  sourceKeys: string[];
  translatedKeys: string[];
  pendingTranslations?: Record<string, string>;
  acceptedOrphanHash?: string;
  lastSuccessfulTranslation: string | null;
  initialized: boolean;
}

export interface ProjectCache {
  files: Record<string, FileCache>;
  selectedChangeIds: string[];
  knownChangeIds: string[];
}

export interface RuntimeData {
  settings: ScriptoriumSettings;
  caches: Record<string, ProjectCache>;
}

export interface ChangeGroup {
  id: string;
  kind: ChangeKind;
  filePath: string;
  blockIds: string[];
  oldBlocks: MarkdownBlock[];
  newBlocks: MarkdownBlock[];
  headingPath: string[];
  contextBefore: MarkdownBlock | null;
  contextAfter: MarkdownBlock | null;
  selected: boolean;
  state: TranslationState;
  message?: string;
}

export interface FileChangePlan {
  sourcePath: string;
  translationPath: string;
  source: ParsedMarkdown;
  translation: ParsedMarkdown | null;
  changes: ChangeGroup[];
  conflicts: ChangeGroup[];
  currentTranslations: Record<string, string>;
  pendingTranslationIds: string[];
  metadataChanged: boolean;
}

export interface ProjectChangePlan {
  project: ProjectConfig;
  files: FileChangePlan[];
  changeCount: number;
  conflictCount: number;
}

export interface TranslationRequestBlock {
  id: string;
  source: string;
  kind: BlockKind;
  headingPath: string[];
  contextBefore: string | null;
  contextAfter: string | null;
}

export interface TranslationBatch {
  filePath: string;
  changeIds: string[];
  blocks: TranslationRequestBlock[];
  translateKeys: string[];
}

export interface TranslationBatchResult {
  blocks: Array<{ id: string; text: string }>;
  keys?: string[];
}

export interface TranslationProgress {
  running: boolean;
  currentFile: string | null;
  currentChangeId: string | null;
  completed: number;
  failed: number;
  total: number;
  streamText: string;
  message: string;
}

export type RisuEntryMode =
  | "multiple"
  | "constant"
  | "normal"
  | "child"
  | "folder";

export interface RisuEntry {
  key: string;
  secondkey: string;
  comment: string;
  content: string;
  insertorder: number;
  mode: RisuEntryMode;
  alwaysActive: boolean;
  selective: boolean;
  extentions?: {
    risu_case_sensitive: boolean;
  };
  activationPercent?: number;
  loreCache?: {
    key: string;
    data: string[];
  };
  useRegex?: boolean;
  bookVersion?: number;
  id?: string;
  folder?: string;
}

export interface RisuLorebook {
  type: "risu";
  ver: 1;
  data: RisuEntry[];
}

export type LorebookSnapshot =
  | {
      schema: typeof SNAPSHOT_SCHEMA;
      status: "ready";
      project: { id: string; name: string };
      mode: SyncMode;
      hash: string;
      lorebook: RisuLorebook;
    }
  | {
      schema: typeof SNAPSHOT_SCHEMA;
      status: "no-active-project";
      hash: string;
    };

export interface SourceDocument {
  path: string;
  basename: string;
  source: ParsedMarkdown;
  translation: ParsedMarkdown | null;
  cache: FileCache | null;
}

export interface SnapshotResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export const DEFAULT_SETTINGS: ScriptoriumSettings = {
  version: DATA_VERSION,
  projects: [],
  translationPrompt:
    "Translate the supplied RisuAI lorebook Markdown faithfully. Preserve Markdown structure, names, tone, and formatting.",
  api: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    secretName: "",
    proxyUrl: "",
    maxRetries: 6,
    initialBackoffSeconds: 2,
    requestTimeoutSeconds: 180
  },
  localServer: {
    enabled: false,
    port: 27124
  },
  relay: {
    enabled: false,
    baseUrl: "",
    channel: "",
    secretName: "",
    autoPush: true
  },
  advanced: {
    deduplicateKoreanParentheses: false
  },
  migrationWarnings: []
};

export function emptyProjectCache(): ProjectCache {
  return { files: {}, selectedChangeIds: [], knownChangeIds: [] };
}
