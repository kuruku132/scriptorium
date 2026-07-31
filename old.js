const {
  Notice,
  Plugin,
  PluginSettingTab,
  MarkdownView,
  Modal,
  FuzzySuggestModal,
  Setting,
  normalizePath
} = require("obsidian");

const RISU_IGNORE_FILE = "risuignore.md";
const LEGACY_IGNORE_FILES = [".translateignore", "translateignore", ".risuignore"];
const PROMPT_FILE = "prompt.md";
const TRANSLATION_CACHE_FILE = "translation_cache.json";
const TRANSLATED_FOLDER = "translate";
const ORIGINAL_LOREBOOK_FILE = "risu_lorebook.json";
const TRANSLATED_LOREBOOK_FILE = "risu_lorebook_translated.json";
const MERGED_CONTEXT_FILE = "all_docs_combined.md";
const LOREBOOK_BASE_FILE = "lorebook_meta.base";
const LOREBOOK_NAMESPACE = "6eb3996e-69e1-48f4-9b29-6ee9b95088f6";
const FOLDER_KEY_PREFIX = "folder:";
const LOREBOOK_META_KEYS = new Set([
  "title",
  "keys",
  "secondary_keys",
  "selective",
  "always_active",
  "insertion_order"
]);
const LIST_META_KEYS = new Set(["keys", "secondary_keys"]);

const DEFAULT_WORKSPACE_DIRECTORY = "Lorebook";
const DEFAULT_WORKSPACE_OPTIONS = {
  includeFolderEntries: true,
  initTranslatedFiles: true,
  translateChangedOnly: true
};

const DEFAULT_SETTINGS = {
  activeWorkspaceId: workspaceIdForDirectory(DEFAULT_WORKSPACE_DIRECTORY),
  workspaces: [workspaceFromDirectory(DEFAULT_WORKSPACE_DIRECTORY)],
  includeFolderEntries: DEFAULT_WORKSPACE_OPTIONS.includeFolderEntries,
  initTranslatedFiles: DEFAULT_WORKSPACE_OPTIONS.initTranslatedFiles,
  translateChangedOnly: DEFAULT_WORKSPACE_OPTIONS.translateChangedOnly,
  openaiCompatibleApiUrl: "https://api.openai.com/v1/chat/completions",
  openaiCompatibleModel: "gpt-4.1-mini",
  openaiCompatibleApiKey: "",
  proxyUrl: "",
  maxRetries: 6,
  initialBackoffSeconds: 2,
  requestTimeoutSeconds: 180,
  risuSyncEnabled: false,
  risuSyncPort: 27182,
  risuSyncMode: "translated",
  relayEnabled: false,          // 릴레이 모드 활성화 여부
  relayUrl: "",                 // 릴레이 서버 URL (예: https://my-relay.workers.dev)
  relayToken: "",               // 인증 토큰
  relayAutoPushOnBuild: true,   // 로어북 빌드 완료 후 자동 푸시
  deduplicateParenthesesOnTranslate: true,
  autoBuildEnabled: false
};

module.exports = class RisuLorebookToolsPlugin extends Plugin {
  async onload() {
    // console.log("[Risu] scriptorium onload — build import-lorebook-20260709");
    await this.loadSettings();
    this._lorebookCache = {}; // 워크스페이스×모드별 on-demand 증분 빌드 캐시 (RisuAI localManifest 방식)
    this.addSettingTab(new RisuLorebookToolsSettingTab(this.app, this));

    this.addRibbonIcon("book-open", "스크립토리움", () => {
      this.buildTranslatedLorebook();
    });

    this.addCommand({
      id: "switch-workspace",
      name: "Risu: 워크스페이스 전환",
      callback: () => new WorkspaceSwitcherModal(this.app, this).open()
    });

    this.addCommand({
      id: "init-missing-lorebook-metadata",
      name: "Risu: 누락된 로어북 메타데이터 추가",
      callback: () => this.initializeMetadata("add")
    });

    this.addCommand({
      id: "replace-lorebook-metadata",
      name: "Risu: 로어북 메타데이터 다시 만들기",
      callback: () => this.initializeMetadata("replace")
    });

    this.addCommand({
      id: "remove-lorebook-metadata",
      name: "Risu: 로어북 메타데이터 제거",
      callback: () => this.initializeMetadata("remove")
    });

    this.addCommand({
      id: "build-original-lorebook",
      name: "Risu: 원문 로어북 생성",
      callback: () => this.buildOriginalLorebook()
    });

    this.addCommand({
      id: "build-translated-lorebook",
      name: "Risu: 번역 로어북 생성",
      callback: () => this.buildTranslatedLorebook()
    });

    this.addCommand({
      id: "import-lorebook",
      name: "Risu: RisuAI 로어북 불러오기",
      callback: () => this.importLorebook()
    });

    this.addCommand({
      id: "initialize-workspace-files",
      name: "Risu: 워크스페이스 초기화",
      callback: () => this.initializeWorkspaceFiles()
    });

    this.addCommand({
      id: "merge-markdown-context",
      name: "Risu: Markdown 컨텍스트 병합",
      callback: () => this.mergeMarkdownContext()
    });

    this.addCommand({
      id: "translate-changed-markdown",
      name: "Risu: 변경된 Markdown 번역",
      callback: () => this.translateChangedMarkdown()
    });

    this.addCommand({
      id: "cancel-translation",
      name: "Risu: 번역 중지",
      callback: () => this.cancelTranslation()
    });

    this.addCommand({
      id: "clear-translation-cache",
      name: "Risu: 번역 캐시 비우기",
      callback: () => this.clearTranslationCache()
    });

    this.addCommand({
      id: "full-translated-pipeline",
      name: "Risu: 전체 번역 파이프라인 실행",
      callback: () => this.runFullTranslatedPipeline()
    });

    this.addCommand({
      id: "deduplicate-korean-parentheses",
      name: "Risu: 번역 중복 한국어 괄호 제거",
      callback: () => this.deduplicateKoreanParenthesesInTranslatedFiles()
    });

    this.addCommand({
      id: "restore-translated-frontmatter",
      name: "Risu: 번역 파일 프론트매터 복원",
      callback: () => this.restoreFrontmatterInTranslatedFiles()
    });

    this.addCommand({
      id: "open-meta-editor",
      name: "Risu: 로어북 메타 편집기 열기",
      callback: () => this.openMetaEditor()
    });

    this.addCommand({
      id: "push-to-relay",
      name: "Risu: 릴레이에 즉시 푸시",
      callback: async () => {
        try {
          new Notice("릴레이 푸시 시작...");
          const result = await this.pushToRelay();
          new Notice(`릴레이 푸시 완료: ${result.pushed}개 워크스페이스`);
        } catch (err) {
          new Notice(`릴레이 푸시 실패: ${err.message}`);
        }
      }
    });

    this.registerEditorActions();

    if (this.settings.risuSyncEnabled) {
      this.startSyncServer();
    }
    if (this.settings.autoBuildEnabled) {
      this.registerAutoBuild();
    }
  }

  onunload() {
    this.removeEditorActions();
    this.stopSyncServer();
    this.unregisterAutoBuild();
  }

  registerEditorActions() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshEditorActions())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshEditorActions())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshEditorActions())
    );
    if (this.app.workspace.onLayoutReady) {
      this.app.workspace.onLayoutReady(() => this.refreshEditorActions());
    } else {
      this.refreshEditorActions();
    }
  }

  refreshEditorActions() {
    this.removeEditorActions();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || !view.addAction) {
      return;
    }

    const workspace = this.workspaceForPath(view.file.path);
    if (!workspace) {
      return;
    }

    // 주의: 여기서 activeWorkspaceId를 바꾸지 않는다.
    // 과거에는 leaf 전환/파일 열기만으로 activeWorkspaceId를 덮어썼으나,
    // 이는 설정 드롭다운 선택을 조용히 무효화하고 동기화 폴백 대상을
    // 사용자 네비게이션에 따라 흔들리게 만드는 원인이 된다.
    // 실제 액션 클릭 시에만 해당 워크스페이스를 활성화한다(아래).
    this.editorActionEls = this.editorActionSpecs().map((action) => {
      const el = view.addAction(action.icon, `${action.title} (${workspaceLabel(workspace)})`, async () => {
        this.settings.activeWorkspaceId = workspace.id;
        await this.saveSettings();
        await action.run();
      });
      el.addClass("risu-lorebook-tools-view-action");
      return el;
    });
  }

  removeEditorActions() {
    if (this.editorActionEls) {
      for (const el of this.editorActionEls) {
        el.remove();
      }
      this.editorActionEls = [];
    }
    const root = this.app?.workspace?.containerEl || document;
    if (root) {
      root.querySelectorAll(".risu-lorebook-tools-view-action").forEach((el) => el.remove());
    }
  }

  editorActionSpecs() {
    return [
      { icon: "book-open", title: "Risu: 원문 로어북 생성", run: () => this.buildOriginalLorebook() },
      { icon: "languages", title: "Risu: 변경 파일 번역", run: () => this.translateChangedMarkdown() },
      { icon: "square", title: "Risu: 번역 중지", run: () => this.cancelTranslation() },
      { icon: "book-copy", title: "Risu: 번역 로어북 생성", run: () => this.buildTranslatedLorebook() },
      { icon: "merge", title: "Risu: Markdown 병합", run: () => this.mergeMarkdownContext() }
    ];
  }

  async loadSettings() {
    const raw = await this.loadData();
    this._legacyPrompt =
      raw && typeof raw === "object" && typeof raw.translationPrompt === "string"
        ? raw.translationPrompt
        : null;
    this.settings = normalizeLoadedSettings(raw);
    this.normalizeSettings();
  }

  async saveSettings() {
    this.normalizeSettings();
    await this.saveData(settingsForSave(this.settings));
    // 워크스페이스/경로/모드가 바뀔 수 있으므로 빌드 캐시 무효화 (다음 폴이 깨끗이 reconcile)
    this.invalidateLorebookCache();
  }

  normalizeSettings() {
    const s = this.settings;
    const activeWorkspaceBeforeNormalize = Array.isArray(s.workspaces)
      ? s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)
      : null;
    const activeDirectoryBeforeNormalize = activeWorkspaceBeforeNormalize
      ? workspaceDirectoryFromRaw(activeWorkspaceBeforeNormalize)
      : "";
    s.includeFolderEntries = booleanSetting(s.includeFolderEntries, DEFAULT_SETTINGS.includeFolderEntries);
    s.initTranslatedFiles = booleanSetting(s.initTranslatedFiles, DEFAULT_SETTINGS.initTranslatedFiles);
    s.translateChangedOnly = booleanSetting(s.translateChangedOnly, DEFAULT_SETTINGS.translateChangedOnly);
    s.workspaces = normalizeWorkspaceList(s);
    if (!s.workspaces.some((workspace) => workspace.id === s.activeWorkspaceId)) {
      const activeByDirectory = s.workspaces.find(
        (workspace) => workspace.directory === activeDirectoryBeforeNormalize
      );
      s.activeWorkspaceId = (activeByDirectory || s.workspaces[0]).id;
    }
    s.openaiCompatibleApiUrl = String(
      s.openaiCompatibleApiUrl || DEFAULT_SETTINGS.openaiCompatibleApiUrl
    ).trim();
    s.openaiCompatibleModel = String(
      s.openaiCompatibleModel || DEFAULT_SETTINGS.openaiCompatibleModel
    ).trim();
    s.proxyUrl = String(s.proxyUrl ?? "").trim();
    s.translationCaches =
      s.translationCaches && typeof s.translationCaches === "object" && !Array.isArray(s.translationCaches)
        ? s.translationCaches
        : {};
    s.maxRetries = positiveInteger(s.maxRetries, DEFAULT_SETTINGS.maxRetries);
    s.initialBackoffSeconds = positiveInteger(s.initialBackoffSeconds, DEFAULT_SETTINGS.initialBackoffSeconds);
    s.requestTimeoutSeconds = positiveInteger(s.requestTimeoutSeconds, DEFAULT_SETTINGS.requestTimeoutSeconds);
    s.risuSyncEnabled = booleanSetting(s.risuSyncEnabled, DEFAULT_SETTINGS.risuSyncEnabled);
    s.risuSyncPort = positiveInteger(s.risuSyncPort, DEFAULT_SETTINGS.risuSyncPort);
    s.risuSyncMode = s.risuSyncMode === "original" ? "original" : "translated";
    s.relayEnabled = booleanSetting(s.relayEnabled, DEFAULT_SETTINGS.relayEnabled);
    s.relayUrl = typeof s.relayUrl === "string" ? s.relayUrl.trim() : "";
    s.relayToken = typeof s.relayToken === "string" ? s.relayToken.trim() : "";
    s.relayAutoPushOnBuild = booleanSetting(s.relayAutoPushOnBuild, DEFAULT_SETTINGS.relayAutoPushOnBuild);
    s.deduplicateParenthesesOnTranslate = booleanSetting(s.deduplicateParenthesesOnTranslate, DEFAULT_SETTINGS.deduplicateParenthesesOnTranslate);
    s.autoBuildEnabled = booleanSetting(s.autoBuildEnabled, DEFAULT_SETTINGS.autoBuildEnabled);
  }

  getActiveWorkspace() {
    const workspaces = this.settings.workspaces || [];
    return workspaces.find((workspace) => workspace.id === this.settings.activeWorkspaceId) || workspaces[0];
  }

  workspaceForPath(path) {
    const normalizedPath = normalizeVaultPath(path);
    return (
      (this.settings.workspaces || [])
        .filter((workspace) => isWithinPath(normalizedPath, workspace.directory))
        .sort((a, b) => b.directory.length - a.directory.length)[0] || null
    );
  }

  updateWorkspaceDirectories(text) {
    const previousActive = this.getActiveWorkspace();
    const nextWorkspaces = parseWorkspaceDirectoryList(text).map(workspaceFromDirectory);
    this.settings.workspaces = nextWorkspaces.length
      ? nextWorkspaces
      : [workspaceFromDirectory(DEFAULT_WORKSPACE_DIRECTORY)];

    const nextActive =
      this.settings.workspaces.find((workspace) => workspace.directory === previousActive?.directory) ||
      this.settings.workspaces[0];
    this.settings.activeWorkspaceId = nextActive.id;
  }

  async initializeWorkspaceFiles() {
    try {
      const workspace = this.getActiveWorkspace();
      await this.ensureFolder(workspace.directory);
      await this.ensureFolder(workspace.translatedFolder);

      const files = [
        { path: workspace.ignorePath, text: defaultIgnoreMarkdown() },
        { path: workspace.promptPath, text: this._legacyPrompt || defaultPromptMarkdown() },
        { path: workspace.translationCachePath, text: renderCacheJson({}) }
      ];
      let created = 0;
      let skipped = 0;

      for (const file of files) {
        if (await this.pathExists(file.path)) {
          skipped += 1;
          continue;
        }
        await this.writeVaultText(file.path, file.text);
        created += 1;
      }

      new Notice(
        `Risu 워크스페이스 초기화 (${workspace.name}): 파일 ${created}개 생성, ${skipped}개 유지.`
      );
    } catch (error) {
      this.reportError("워크스페이스 초기화 실패", error);
    }
  }

  cancelTranslation() {
    if (!this.translationJob || this.translationJob.finished) {
      new Notice("Risu 번역: 진행 중인 번역 작업이 없습니다.");
      return;
    }
    this.translationJob.cancel();
    new Notice("Risu 번역 중지를 요청했습니다.");
  }

  async clearTranslationCache() {
    const workspace = this.getActiveWorkspace();
    if (
      this.translationJob &&
      !this.translationJob.finished &&
      this.translationJob.workspace.id === workspace.id
    ) {
      new Notice("Risu 번역 캐시: 번역 중에는 현재 워크스페이스 캐시를 비울 수 없습니다.");
      return;
    }

    const cache = await this.loadCache(workspace);
    const count = Object.keys(cache).length;
    await this.saveCache({}, workspace);
    new Notice(`Risu 번역 캐시 (${workspace.name}): ${count}개 항목을 비웠습니다.`);
  }

  startTranslationJob(workspace) {
    const abortController = new AbortController();
    const job = {
      workspace,
      cancelled: false,
      finished: false,
      abortController,
      cancel: () => {
        if (!job.cancelled) {
          job.cancelled = true;
          abortController.abort();
        }
      }
    };
    this.translationJob = job;
    return job;
  }

  async loadPrompt(workspace) {
    if (await this.pathExists(workspace.promptPath)) {
      return this.readVaultText(workspace.promptPath);
    }
    const prompt = this._legacyPrompt || defaultPromptMarkdown();
    await this.writeVaultText(workspace.promptPath, prompt);
    return prompt;
  }

  async initializeMetadata(mode) {
    try {
      const workspace = this.getActiveWorkspace();
      const sourceFolder = workspace.projectFolder;
      const includeTranslate = workspace.initTranslatedFiles;
      const files = await this.collectMarkdownFiles(sourceFolder, { includeTranslate, workspace });
      let changed = 0;
      let skipped = 0;

      for (const file of files) {
        const rel = relativePath(file.path, sourceFolder);
        const text = await this.readVaultText(file.path);

        const fm = parseFrontmatter(text);
        const hasMetadata = hasLorebookMetadata(fm);
        let nextText = text;

        if (mode === "remove") {
          if (!hasMetadata) {
            skipped += 1;
            continue;
          }
          nextText = renderDocumentWithoutMetadata(fm);
        } else {
          if (hasMetadata && mode !== "replace") {
            skipped += 1;
            continue;
          }
          const metadata = initMetadata(file.path, rel, fm.body);
          nextText = renderDocumentWithMetadata(fm, metadata);
        }

        if (nextText === text) {
          skipped += 1;
          continue;
        }

        await this.writeVaultText(file.path, nextText);
        changed += 1;
      }

      new Notice(
        `Risu 메타데이터 (${workspace.name}): 변경 ${changed}, 건너뜀 ${skipped}, 전체 ${files.length}.`
      );
    } catch (error) {
      this.reportError("메타데이터 초기화 실패", error);
    }
  }

  async buildOriginalLorebook() {
    const workspace = this.getActiveWorkspace();
    await this.buildLorebook({
      workspace,
      sourceFolder: workspace.projectFolder,
      metadataFolder: workspace.projectFolder,
      outputPath: workspace.originalOutputPath
    });
  }

  async buildTranslatedLorebook() {
    const workspace = this.getActiveWorkspace();
    await this.buildLorebook({
      workspace,
      sourceFolder: workspace.translatedFolder,
      metadataFolder: workspace.projectFolder,
      outputPath: workspace.translatedOutputPath
    });
  }

  async buildLorebook({ workspace = this.getActiveWorkspace(), sourceFolder, metadataFolder, outputPath }) {
    try {
      if (!(await this.pathExists(sourceFolder))) {
        throw new Error(`원문 폴더가 없습니다: ${sourceFolder}`);
      }

      // on-demand 증분 reconcile로 data를 생성(캐시 갱신)하고 디스크에 기록.
      // reconcile이 source/metadata 폴더를 workspace+mode에서 도출하므로 풀 리빌드 없이
      // 변경분만 재처리 → 캐시와 디스크 파일이 항상 일치한다.
      const mode = outputPath === workspace.translatedOutputPath ? "translated" : "original";
      const { data } = await this.reconcileLorebook(workspace, mode);

      await this.writeJson(outputPath, { type: "risu", ver: 1, data });
      new Notice(`Risu 로어북 생성 완료 (${workspace.name}): 항목 ${data.length}개.`);

      // 빌드 성공 후 릴레이 자동 푸시. 실패해도 빌드 결과에 영향을 주지 않는다.
      if (this.settings.relayEnabled && this.settings.relayAutoPushOnBuild && this.settings.relayUrl) {
        this.pushToRelay()
          .then((r) => {
            new Notice(`릴레이 자동 푸시 완료: ${r.pushed}개`);
          })
          .catch((err) => {
            new Notice(`릴레이 자동 푸시 실패: ${err.message}`);
          });
      }
    } catch (error) {
      this.reportError("로어북 생성 실패", error);
    }
  }

  async importLorebook() {
    // console.log("[Risu] importLorebook: 시작");
    try {
      const workspace = this.getActiveWorkspace();
      // console.log("[Risu] importLorebook: 워크스페이스 =", workspace && workspace.name, workspace && workspace.directory);
      const jsonFiles = this.app.vault
        .getFiles()
        .filter((file) => file.extension === "json")
        .sort((a, b) => a.path.localeCompare(b.path));
      // console.log("[Risu] importLorebook: JSON 파일 수 =", jsonFiles.length, jsonFiles.map((f) => f.path));

      if (!jsonFiles.length) {
        new Notice("Risu 로어북 불러오기: vault에 JSON 파일이 없습니다.");
        return;
      }

      const picked = await new JsonFilePickerModal(this.app, jsonFiles).pick();
      // console.log("[Risu] importLorebook: 선택됨 =", picked && picked.path);
      if (!picked) {
        // console.log("[Risu] importLorebook: 선택 취소됨, 종료");
        return;
      }

      const raw = await this.readVaultText(picked.path);
      let lorebook;
      try {
        lorebook = JSON.parse(raw);
      } catch {
        throw new Error(`JSON 파싱 실패: ${picked.path}`);
      }
      if (!lorebook || !Array.isArray(lorebook.data)) {
        throw new Error("유효하지 않은 RisuAI 로어북 형식 (data 배열 없음)");
      }

      const entries = lorebook.data;
      const contentEntries = entries.filter((entry) => entry && entry.mode !== "folder");
      // console.log("[Risu] importLorebook: 항목 수 =", entries.length, "콘텐츠 =", contentEntries.length);

      // 폴더 항목(key 기준)으로 디렉터리 구조 복원용 맵 구성
      const folderMap = new Map();
      for (const entry of entries) {
        if (entry && entry.mode === "folder" && entry.key) {
          folderMap.set(entry.key, {
            name: String(entry.comment || ""),
            parent: entry.folder || null
          });
        }
      }

      const projectFolder = workspace.projectFolder;

      let created = 0;
      let overwritten = 0;
      let skipped = 0;
      const usedRels = new Set();

      for (const entry of contentEntries) {
        const title = String(entry.comment || entry.id || "entry");
        const baseName = sanitizeLorebookFilename(title);
        if (!baseName) {
          skipped += 1;
          continue;
        }

        const folderRel = lorebookFolderRel(entry.folder || null, folderMap);
        let rel = folderRel ? `${folderRel}/${baseName}.md` : `${baseName}.md`;
        if (usedRels.has(rel)) {
          let n = 2;
          let candidate = folderRel ? `${folderRel}/${baseName} (${n}).md` : `${baseName} (${n}).md`;
          while (usedRels.has(candidate)) {
            n += 1;
            candidate = folderRel ? `${folderRel}/${baseName} (${n}).md` : `${baseName} (${n}).md`;
          }
          rel = candidate;
        }
        usedRels.add(rel);

        const outPath = joinVaultPath(projectFolder, rel);
        // console.log("[Risu] importLorebook: 작성 →", outPath, "(존재여부 확인 중)");
        const fmData = {
          title,
          keys: splitCommaList(entry.key),
          secondary_keys: splitCommaList(entry.secondkey),
          selective: Boolean(entry.selective),
          always_active: Boolean(entry.alwaysActive),
          insertion_order: Number.parseInt(entry.insertorder, 10) || 100
        };
        const body = String(entry.content || "").replace(/^\n+/, "");
        const text = dumpFrontmatter(fmData) + body + (body.endsWith("\n") ? "" : "\n");

        const existed = await this.pathExists(outPath);
        await this.writeVaultText(outPath, text);
        if (existed) {
          overwritten += 1;
        } else {
          created += 1;
        }
      }

      // console.log("[Risu] importLorebook: 완료 — 생성", created, "덮어쓰기", overwritten, "건너뜀", skipped);
      new Notice(
        `Risu 로어북 불러오기 (${workspace.name}): 항목 ${contentEntries.length}개 — 생성 ${created}, 덮어쓰기 ${overwritten}, 건너뜀 ${skipped}.`
      );
    } catch (error) {
      this.reportError("로어북 불러오기 실패", error);
    }
  }

  async risuEntryFromMarkdown(path, rel, metadataPath) {
    const text = await this.readVaultText(path);
    const fm = parseFrontmatter(text);
    let metaFm = fm;
    let metaPath = path;

    if (metadataPath && (await this.pathExists(metadataPath))) {
      metaPath = metadataPath;
      metaFm = parseFrontmatter(await this.readVaultText(metadataPath));
    }

    const meta = normalizeLorebookMetadata(metaPath, rel, metaFm);
    if (meta.enabled === false) {
      return null;
    }

    const entry = {
      id: meta.id,
      key: cleanList(meta.keys).join(", "),
      comment: meta.title || stem(path),
      content: fm.body.trim(),
      mode: meta.mode || "normal",
      insertorder: Number.parseInt(meta.insertion_order, 10) || 100,
      alwaysActive: Boolean(meta.always_active),
      secondkey: cleanList(meta.secondary_keys).join(", "),
      selective: Boolean(meta.selective)
    };

    return entry;
  }

  async mergeMarkdownContext() {
    try {
      const workspace = this.getActiveWorkspace();
      const sourceFolder = workspace.projectFolder;
      const outputPath = workspace.mergeOutputPath;
      const files = (
        await this.collectMarkdownFiles(sourceFolder, { includeTranslate: false, workspace })
      )
        .filter((file) => file.path !== outputPath)
        .sort((a, b) =>
          relativePath(a.path, sourceFolder).localeCompare(relativePath(b.path, sourceFolder))
        );

      if (!files.length) {
        new Notice("Risu 병합: Markdown 파일이 없습니다.");
        return;
      }

      const lines = [];
      lines.push("# 통합 프로젝트 문서 컨텍스트", "");
      lines.push("## 1. 디렉터리 구조", "```text");
      lines.push(
        renderProjectTree(sourceFolder, files.map((file) => relativePath(file.path, sourceFolder)))
      );
      lines.push("```", "");
      lines.push("## 2. 파일별 상세 내용");
      lines.push(`총 ${files.length}개의 파일을 포함했습니다.`, "");

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const rel = relativePath(file.path, sourceFolder);
        const content = await this.readVaultText(file.path);
        lines.push(`### [${index + 1}] 파일 경로: ${rel}`);
        lines.push(`<!-- START OF ${rel} -->`);
        lines.push("```markdown");
        lines.push(content.trim() ? content : "(비어 있음)");
        lines.push("```");
        lines.push(`<!-- END OF ${rel} -->`);
        lines.push("");
        lines.push("=".repeat(50));
        lines.push("");
      }

      await this.writeVaultText(outputPath, lines.join("\n"));
      new Notice(`Risu 병합 완료 (${workspace.name}): ${files.length}개 파일 -> ${outputPath}`);
    } catch (error) {
      this.reportError("병합 실패", error);
    }
  }

  async translateChangedMarkdown() {
    if (this.translationJob && !this.translationJob.finished) {
      new Notice("Risu 번역: 이미 진행 중인 번역 작업이 있습니다.");
      return;
    }

    if (!this.settings.openaiCompatibleApiKey.trim()) {
      new Notice("먼저 Risu 로어북 도구 설정에서 API 키를 입력하세요.");
      return;
    }

    let job = null;
    const modal = new StreamNotice();

    try {
      const workspace = this.getActiveWorkspace();
      job = this.startTranslationJob(workspace);

      const promptTemplate = await this.loadPrompt(workspace);
      if (!promptTemplate.includes("{text}")) {
        throw new Error(
          `번역 프롬프트에 {text}가 없습니다. ${workspace.promptPath} 를 확인하세요.`
        );
      }

      const cache = await this.loadCache(workspace);
      const files = await this.collectMarkdownFiles(workspace.projectFolder, {
        includeTranslate: false,
        workspace
      });

      const toTranslate = [];
      const skipped = [];

      for (const file of files) {
        throwIfTranslationCancelled(job);
        const rel = relativePath(file.path, workspace.projectFolder);
        const text = await this.readVaultText(file.path);
        const hash = sha1Hex(utf8Bytes(text));
        if (!workspace.translateChangedOnly || cache[rel] !== hash) {
          toTranslate.push({ file, rel, hash, text });
        } else {
          skipped.push(rel);
        }
      }

      if (!toTranslate.length) {
        modal.completed = true;
        modal.close();
        new Notice(`Risu 번역 (${workspace.name}): 모든 파일이 최신 상태입니다.`);
        return "completed";
      }

      new Notice(`Risu 번역 (${workspace.name}): ${toTranslate.length}개 파일 대기 중.`);
      modal.setProgress(0, toTranslate.length, 0, 0);

      const failed = [];
      const completed = [];

      for (let index = 0; index < toTranslate.length; index += 1) {
        throwIfTranslationCancelled(job);
        const item = toTranslate[index];
        modal.setFile(item.rel);
        modal.setProgress(index + 1, toTranslate.length, completed.length, failed.length);

        try {
          const userMessage = promptTemplate.split("{text}").join(item.text);
          const translated = await this.translateText(
            userMessage,
            job,
            (chunk) => modal.addChunk(chunk),
            (input, output) => modal.addTokens(input, output)
          );
          throwIfTranslationCancelled(job);
          const outPath = joinVaultPath(workspace.translatedFolder, item.rel);
          await this.writeVaultText(outPath, postprocessTranslatedMarkdown(translated, item.text, { deduplicateParentheses: this.settings.deduplicateParenthesesOnTranslate }));
          cache[item.rel] = item.hash;
          await this.saveCache(cache, workspace);
          completed.push(item.rel);
          modal.setProgress(index + 1, toTranslate.length, completed.length, failed.length);
          new Notice(`번역 완료 ${index + 1}/${toTranslate.length}: ${item.rel}`);
        } catch (error) {
          if (isTranslationCancelled(error)) throw error;
          failed.push(item.rel);
          console.error("[Risu Lorebook Tools] 번역 실패:", item.rel, error);
          modal.setProgress(index + 1, toTranslate.length, completed.length, failed.length);
        }
      }

      modal.completed = true;
      modal.close();

      if (failed.length) {
        new Notice(
          `Risu 번역 종료 (${workspace.name}): 성공 ${completed.length}개, 실패 ${failed.length}개.`
        );
        return "completed-with-failures";
      }
      new Notice(`Risu 번역 완료 (${workspace.name}): ${completed.length}개 파일.`);
      return "completed";
    } catch (error) {
      modal.completed = true;
      modal.close();
      if (job && isTranslationCancelled(error)) {
        new Notice(`Risu 번역 중지됨 (${job.workspace.name}).`);
        return "cancelled";
      }
      this.reportError("번역 실패", error);
      return "failed";
    } finally {
      if (job) job.finished = true;
      if (this.translationJob === job) this.translationJob = null;
    }
  }

  async executeStreamRequest(userMessage, job, onChunk, onUsage) {
    let timedOut = false;
    const controller = new AbortController();
    const timeoutMs = this.settings.requestTimeoutSeconds * 1000;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const jobSignal = job?.abortController?.signal;
    if (jobSignal) {
      if (jobSignal.aborted) {
        clearTimeout(timeoutId);
        throw translationCancelledError();
      }
      jobSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      throwIfTranslationCancelled(job);

      const proxy = this.settings.proxyUrl;
      const targetUrl = this.settings.openaiCompatibleApiUrl;
      const fetchUrl = proxy || targetUrl;
      const extraHeaders = proxy ? { "X-Target-URL": targetUrl } : {};
      console.log("[Risu] fetch 시작:", fetchUrl, proxy ? `(프록시→${targetUrl})` : "", "model:", this.settings.openaiCompatibleModel);

      const response = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.openaiCompatibleApiKey.trim()}`,
          "Content-Type": "application/json",
          ...extraHeaders
        },
        body: JSON.stringify({
          model: this.settings.openaiCompatibleModel,
          messages: [{ role: "user", content: userMessage }],
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      });

      console.log("[Risu] 응답 상태:", response.status, "ok:", response.ok);

      if (response.status === 429) {
        const err = new Error("Rate limit (429)");
        err.status = 429;
        throw err;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`API가 ${response.status}를 반환했습니다: ${body}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      let readCount = 0;
      let chunkCount = 0;

      while (true) {
        throwIfTranslationCancelled(job);
        const { done, value } = await reader.read();
        readCount++;
        console.log(`[Risu] read #${readCount} done=${done} bytes=${value?.length ?? 0}`);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const parsed = parseStreamLine(line);
          if (!parsed) continue;

          const chunk = extractChunkContent(parsed);
          if (chunk) {
            chunkCount++;
            fullContent += chunk;
            console.log(`[Risu] chunk #${chunkCount}: "${chunk}"`);
            onChunk?.(chunk);
          }

          const usage = extractUsage(parsed);
          if (usage) {
            console.log("[Risu] usage:", usage);
            onUsage?.(usage.input, usage.output);
          }
        }
      }

      console.log(`[Risu] 스트리밍 완료 reads=${readCount} chunks=${chunkCount} chars=${fullContent.length}`);

      if (!fullContent) {
        throw new Error("API 응답에서 내용을 받지 못했습니다.");
      }

      return fullContent;
    } catch (error) {
      if (job?.cancelled) throw translationCancelledError();
      if (timedOut) throw new Error(`API 요청 시간 초과 (${this.settings.requestTimeoutSeconds}초)`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async translateText(userMessage, job, onChunk, onUsage) {
    for (let attempt = 0; attempt < this.settings.maxRetries; attempt += 1) {
      throwIfTranslationCancelled(job);
      try {
        return await this.executeStreamRequest(userMessage, job, onChunk, onUsage);
      } catch (error) {
        if (isTranslationCancelled(error)) throw error;
        if (attempt >= this.settings.maxRetries - 1) throw error;
        const isRetryable = error.status === 429 || error.name === "TypeError";
        if (!isRetryable) throw error;
        const backoff = this.settings.initialBackoffSeconds * 1000 * 2 ** attempt;
        await sleep(backoff, job?.abortController?.signal);
      }
    }
    throw new Error("번역 재시도 한도를 초과했습니다.");
  }

  async runFullTranslatedPipeline() {
    await this.initializeMetadata("add");
    const translationResult = await this.translateChangedMarkdown();
    if (translationResult === "cancelled" || translationResult === "failed") {
      return;
    }
    await this.restoreFrontmatterInTranslatedFiles();
    await this.deduplicateKoreanParenthesesInTranslatedFiles();
    await this.buildTranslatedLorebook();
  }

  async openMetaEditor() {
    try {
      const workspace = this.getActiveWorkspace();
      const content = buildLorebookBaseContent(workspace.directory);
      await this.writeVaultText(workspace.basePath, content);
      const file = this.app.vault.getAbstractFileByPath(workspace.basePath);
      if (file) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
      new Notice(`Risu 메타 편집기 (${workspace.name}): Base 뷰를 열었습니다.`);
    } catch (error) {
      this.reportError("메타 편집기 열기 실패", error);
    }
  }

  async deduplicateKoreanParenthesesInTranslatedFiles() {
    try {
      const workspace = this.getActiveWorkspace();
      const translatedFiles = await this.collectMarkdownFiles(workspace.translatedFolder, {
        includeTranslate: true,
        workspace
      });

      if (!translatedFiles.length) {
        new Notice(`Risu 중복 괄호 제거 (${workspace.name}): 번역 파일이 없습니다.`);
        return;
      }

      // Step 1: 모든 번역 파일 + 원본 메타데이터 로드
      const entries = [];
      for (const file of translatedFiles) {
        const text = await this.readVaultText(file.path);
        const rel = relativePath(file.path, workspace.translatedFolder);
        const metadataPath = joinVaultPath(workspace.projectFolder, rel);
        const fm = parseFrontmatter(text);

        let meta;
        if (await this.pathExists(metadataPath)) {
          const metaFm = parseFrontmatter(await this.readVaultText(metadataPath));
          meta = normalizeLorebookMetadata(metadataPath, rel, metaFm);
        } else {
          meta = normalizeLorebookMetadata(file.path, rel, fm);
        }

        entries.push({
          path: file.path,
          text,
          body: fm.body,
          fmPrefix: fm.exists ? text.replace(/^﻿/, "").match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)?.[0] ?? "" : "",
          alwaysActive: Boolean(meta.always_active),
          insertorder: Number.parseInt(meta.insertion_order, 10) || 100
        });
      }

      // Step 2: 항상 활성화 로어 중 insertion_order 내림차순으로 각 괄호의 소유자 결정
      // 소유자 = 해당 괄호를 포함하는 항상 활성화 항목 중 insertorder가 가장 큰 것
      const owners = new Map(); // "(한국어)" -> entries 배열 index
      const koreanParenRe = /\(([^)]*[가-힣][^)]*)\)/g;

      const alwaysActiveByOrder = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.alwaysActive)
        .sort((a, b) => b.e.insertorder - a.e.insertorder);

      for (const { e, i } of alwaysActiveByOrder) {
        koreanParenRe.lastIndex = 0;
        let match;
        while ((match = koreanParenRe.exec(e.body)) !== null) {
          const key = match[0];
          if (!owners.has(key)) {
            owners.set(key, i);
          }
        }
      }

      // Step 3: 각 파일에 규칙 적용
      // - Case A (항상 활성화 소유자 있음): 소유자 파일은 첫 번째 등장만 유지, 나머지 파일은 전부 제거
      // - Case B (항상 활성화 소유자 없음): 각 파일에서 첫 번째 등장만 유지 (파일 간 중복 허용)
      let changed = 0;
      let skipped = 0;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const seen = new Set();

        const newBody = entry.body.replace(/( ?)\(([^)]*[가-힣][^)]*)\)/g, (match, space, inner) => {
          const key = `(${inner})`;

          if (owners.has(key)) {
            // Case A
            if (owners.get(key) !== i) return ""; // 소유자 아님 → 전부 제거
            if (seen.has(key)) return "";          // 소유자지만 중복 → 제거
            seen.add(key);
            return match;
          }

          // Case B
          if (seen.has(key)) return "";
          seen.add(key);
          return match;
        });

        const newText = entry.fmPrefix + newBody;
        if (newText === entry.text) {
          skipped++;
          continue;
        }
        await this.writeVaultText(entry.path, newText);
        changed++;
      }

      new Notice(
        `Risu 중복 괄호 제거 (${workspace.name}): 변경 ${changed}개, 건너뜀 ${skipped}개.`
      );
    } catch (error) {
      this.reportError("중복 괄호 제거 실패", error);
    }
  }

  async restoreFrontmatterInTranslatedFiles() {
    try {
      const workspace = this.getActiveWorkspace();
      const translatedFiles = await this.collectMarkdownFiles(workspace.translatedFolder, {
        includeTranslate: true,
        workspace
      });

      if (!translatedFiles.length) {
        new Notice(`Risu 프론트매터 복원 (${workspace.name}): 번역 파일이 없습니다.`);
        return;
      }

      let changed = 0;
      let skipped = 0;

      for (const file of translatedFiles) {
        const rel = relativePath(file.path, workspace.translatedFolder);
        const originalPath = joinVaultPath(workspace.projectFolder, rel);
        const translatedText = await this.readVaultText(file.path);
        const originalText = (await this.pathExists(originalPath))
          ? await this.readVaultText(originalPath)
          : null;

        const restored = postprocessTranslatedMarkdown(translatedText, originalText, { deduplicateParentheses: this.settings.deduplicateParenthesesOnTranslate });
        if (restored === translatedText) {
          skipped++;
          continue;
        }
        await this.writeVaultText(file.path, restored);
        changed++;
      }

      new Notice(
        `Risu 프론트매터 복원 (${workspace.name}): 변경 ${changed}개, 건너뜀 ${skipped}개.`
      );
    } catch (error) {
      this.reportError("프론트매터 복원 실패", error);
    }
  }

  async collectMarkdownFiles(sourceFolder, options = {}) {
    const workspace = options.workspace || this.getActiveWorkspace();
    const includeTranslate = Boolean(options.includeTranslate);
    const projectFolder = workspace.projectFolder;
    const ignorePatterns = await this.loadIgnorePatterns(workspace);
    const standardMarkdownFiles = new Set([PROMPT_FILE, RISU_IGNORE_FILE, MERGED_CONTEXT_FILE]);
    const effectivePatterns = includeTranslate
      ? ignorePatterns.filter((pattern) => {
          const normalized = normalizeVaultPath(pattern).replace(/\/$/, "");
          return ![TRANSLATED_FOLDER, "translated"].includes(normalized);
        })
      : ignorePatterns;

    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => isWithinPath(file.path, sourceFolder))
      .filter((file) => {
        const sourceRel = relativePath(file.path, sourceFolder);
        if (standardMarkdownFiles.has(sourceRel)) {
          return false;
        }
        const projectRel = isWithinPath(file.path, projectFolder)
          ? relativePath(file.path, projectFolder)
          : sourceRel;
        const projectHead = projectRel.split("/")[0];

        if (!includeTranslate && [TRANSLATED_FOLDER, "translated"].includes(projectHead)) {
          return false;
        }

        return !isIgnored(projectRel, effectivePatterns) && !isIgnored(sourceRel, effectivePatterns);
      })
      .sort((a, b) =>
        relativePath(a.path, sourceFolder).localeCompare(relativePath(b.path, sourceFolder))
      );
  }

  async loadIgnorePatterns(workspace = this.getActiveWorkspace()) {
    const ignorePath = await this.firstExistingPath([
      workspace.ignorePath,
      ...(workspace.legacyIgnorePaths || [])
    ]);
    if (!(await this.pathExists(ignorePath))) {
      return [];
    }
    const text = await this.readVaultText(ignorePath);
    return parseIgnorePatterns(text);
  }

  async loadCache(workspace = this.getActiveWorkspace()) {
    if (workspace.translationCachePath && (await this.pathExists(workspace.translationCachePath))) {
      try {
        return parseCacheMarkdown(await this.readVaultText(workspace.translationCachePath));
      } catch {
        return {};
      }
    }

    const cachePath = await this.firstExistingPath([...(workspace.legacyCachePaths || [])]);
    if (cachePath && (await this.pathExists(cachePath))) {
      try {
        return parseCacheMarkdown(await this.readVaultText(cachePath));
      } catch {
        return {};
      }
    }

    const pluginCache = this.settings.translationCaches?.[workspace.id];
    if (pluginCache && typeof pluginCache === "object" && !Array.isArray(pluginCache)) {
      const migratedCache = Object.assign({}, pluginCache);
      await this.saveCache(migratedCache, workspace);
      return migratedCache;
    }

    return {};
  }

  async saveCache(cache, workspace = this.getActiveWorkspace()) {
    await this.writeVaultText(workspace.translationCachePath, renderCacheJson(cache));
    if (this.settings.translationCaches?.[workspace.id]) {
      delete this.settings.translationCaches[workspace.id];
      await this.saveSettings();
    }
  }

  async readVaultText(path) {
    return this.app.vault.adapter.read(normalizeVaultPath(path));
  }

  async writeVaultText(path, text) {
    const normalized = normalizeVaultPath(path);
    const parent = dirname(normalized);
    if (parent) {
      await this.ensureFolder(parent);
    }
    await this.app.vault.adapter.write(normalized, text);
  }

  async writeJson(path, data) {
    await this.writeVaultText(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  async ensureFolder(folderPath) {
    const parts = normalizeVaultPath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.pathExists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async pathExists(path) {
    return this.app.vault.adapter.exists(normalizeVaultPath(path));
  }

  async firstExistingPath(paths) {
    for (const path of paths) {
      if (path && (await this.pathExists(path))) {
        return path;
      }
    }
    return paths[0];
  }

  reportError(label, error) {
    console.error(`[Risu Lorebook Tools] ${label}:`, error);
    new Notice(`Risu 오류 (${label}): ${error.message || error}`);
  }

  isMobile() {
    try {
      const { Platform } = require("obsidian");
      return Platform.isMobile === true;
    } catch {
      return false;
    }
  }

  // 모든 워크스페이스(또는 지정된 워크스페이스)의 로어북을 빌드해
  // 릴레이 서버에 PUT 으로 올린다. 모바일/원격 동기화용.
  // reconcileLorebook 결과(data/manifest/hash)를 그대로 올려 로컬 서버와
  // 릴레이 양쪽이 동일한 캐시에서 서빙하도록 한다.
  async pushToRelay(workspaceIds = null) {
    if (!this.settings.relayEnabled || !this.settings.relayUrl) {
      throw new Error("릴레이가 비활성화되어 있거나 URL이 설정되지 않았습니다.");
    }

    const allWorkspaces = this.settings.workspaces || [];
    const targetWorkspaces = workspaceIds
      ? allWorkspaces.filter((ws) => workspaceIds.includes(ws.id))
      : allWorkspaces;

    if (!targetWorkspaces.length) throw new Error("워크스페이스가 없습니다.");

    const mode = this.settings.risuSyncMode || "translated";
    const lorebooks = [];

    for (const ws of targetWorkspaces) {
      try {
        const { data, manifest, hash } = await this.reconcileLorebook(ws, mode);
        lorebooks.push({
          workspaceId: ws.id,
          workspace: ws.name,
          mode,
          hash,
          entries: manifest,
          data
        });
      } catch (err) {
        console.warn(`[Risu Relay] 워크스페이스 "${ws.name}" 빌드 실패:`, err);
      }
    }

    if (!lorebooks.length) throw new Error("빌드 성공한 워크스페이스가 없습니다.");

    const body = {
      workspaces: allWorkspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        directory: ws.directory
      })),
      activeWorkspaceId: this.settings.activeWorkspaceId,
      lorebooks
    };

    const url = this.settings.relayUrl.replace(/\/$/, "") + "/push";
    const headers = {
      "Content-Type": "application/json",
      ...(this.settings.relayToken
        ? { Authorization: `Bearer ${this.settings.relayToken}` }
        : {})
    };

    // 타임아웃/중단 처리. 릴레이 URL이 잘못되었거나 서버가 응답하지 않으면
    // 무한 대기로 버튼이 멈추는 것을 방지한다.
    const RELAY_PUSH_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_PUSH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`릴레이 푸시 시간 초과 (${RELAY_PUSH_TIMEOUT_MS / 1000}초) — URL/서버 상태 확인: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`릴레이 서버 오류 (${res.status}): ${text}`);
    }

    return await res.json(); // { ok: true, pushed: N }
  }

  startSyncServer() {
    if (this.isMobile()) {
      console.warn("[Risu Sync] 모바일 환경에서는 로컬 서버를 시작할 수 없습니다. 릴레이 모드를 사용하세요.");
      return;
    }
    this.stopSyncServer();
    try {
      const http = require("http");
      this._syncServer = http.createServer((req, res) => this.handleSyncRequest(req, res));
      this._syncServer.on("error", (err) => {
        console.error("[Risu Sync] 서버 오류:", err);
        new Notice(`Risu 동기화 서버 오류 (포트 ${this.settings.risuSyncPort}): ${err.message}`);
      });
      this._syncServer.listen(this.settings.risuSyncPort, "127.0.0.1", () => {
        new Notice(`Risu 동기화 서버 시작: localhost:${this.settings.risuSyncPort}`);
      });
    } catch (err) {
      console.error("[Risu Sync] 서버 시작 실패:", err);
      new Notice(`Risu 동기화 서버 시작 실패: ${err.message}`);
    }
  }

  stopSyncServer() {
    if (this._syncServer) {
      this._syncServer.close();
      this._syncServer = null;
    }
  }

  // ── On-demand 증분 로어북 캐시 (RisuAI localManifest 방식 이식) ─────────────────
  // RisuAI 측은 localManifest={id:hash}+lastHash로 변경 항목만 당겨온다.
  // Obsidian 서버도 폴링 시 이 캐시를 reconcile하여 변경 파일만 재처리하고
  // 매니페스트{ id:hash }와 전역 hash를 반환한다. 디스크 파일 의존 없이 최신 상태 서빙.
  _emptyCacheSlot() {
    return { fileEntries: new Map(), folderEntries: new Map(), data: [], manifest: {} };
  }

  _lorebookCacheSlot(workspaceId) {
    if (!this._lorebookCache) this._lorebookCache = {};
    if (!this._lorebookCache[workspaceId]) {
      this._lorebookCache[workspaceId] = { original: this._emptyCacheSlot(), translated: this._emptyCacheSlot() };
    }
    return this._lorebookCache[workspaceId];
  }

  invalidateLorebookCache(workspaceId = null, mode = null) {
    if (!this._lorebookCache) return;
    if (workspaceId == null) {
      this._lorebookCache = {};
      return;
    }
    const slot = this._lorebookCache[workspaceId];
    if (!slot) return;
    if (mode == null) {
      delete this._lorebookCache[workspaceId];
    } else if (slot[mode]) {
      slot[mode] = this._emptyCacheSlot();
    }
  }

  // 워크스페이스×모드에 대해 증분 reconcile. 반환: { data, manifest, hash }.
  // 변경된 파일만 risuEntryFromMarkdown로 재처리하고, 나머지는 캐시 엔트리 재사용.
  async reconcileLorebook(workspace, mode) {
    const effectiveMode = mode === "original" ? "original" : "translated";
    const slot = this._lorebookCacheSlot(workspace.id);
    const cache = slot[effectiveMode];

    // 동시 reconcile 합流 (폴링/빌드 경쟁 방지)
    if (cache._reconcilePromise) return cache._reconcilePromise;
    cache._reconcilePromise = (async () => {
      try {
        const sourceFolder = effectiveMode === "original"
          ? workspace.projectFolder
          : workspace.translatedFolder;
        const metadataFolder = workspace.projectFolder;

        if (!(await this.pathExists(sourceFolder))) {
          Object.assign(cache, this._emptyCacheSlot());
          return { data: [], manifest: {}, hash: "none" };
        }

        const files = await this.collectMarkdownFiles(sourceFolder, {
          includeTranslate: effectiveMode === "translated",
          workspace
        });

        // 1패스: 현재 rel 집합 + 파일 해시(콘텐츠 + 메타데이터 twin)
        const current = new Map();
        for (const file of files) {
          const rel = relativePath(file.path, sourceFolder);
          const contentText = await this.readVaultText(file.path);
          let metadataPath = undefined;
          let metadataText = null;
          if (effectiveMode === "translated") {
            metadataPath = joinVaultPath(metadataFolder, rel);
            if (await this.pathExists(metadataPath)) {
              metadataText = await this.readVaultText(metadataPath);
            }
          }
          const fileHash = sha1Hex(
            utf8Bytes(contentText + (metadataText != null ? "\u0000" + metadataText : ""))
          );
          current.set(rel, { file, metadataPath, fileHash });
        }

        // diff vs 캐시: 재처리/삭제 대상 산출
        const toReprocess = [];
        for (const [rel, info] of current) {
          const cached = cache.fileEntries.get(rel);
          if (!cached || cached.fileHash !== info.fileHash) toReprocess.push(rel);
        }
        for (const rel of [...cache.fileEntries.keys()]) {
          if (!current.has(rel)) cache.fileEntries.delete(rel);
        }
        for (const rel of toReprocess) {
          const info = current.get(rel);
          const entry = await this.risuEntryFromMarkdown(info.file.path, rel, info.metadataPath);
          if (!entry) {
            cache.fileEntries.delete(rel); // 비활성(enabled:false) → 제거
          } else {
            cache.fileEntries.set(rel, { fileHash: info.fileHash, entry });
          }
        }

        // 폴더 엔트리 재합성 + data 구성 (buildLorebook 루프와 동일 순서/키순서)
        const data = [];
        const seenFolders = new Set();
        const folderKeys = new Map();
        const includeFolderEntries = workspace.includeFolderEntries;
        for (const rel of [...current.keys()].sort()) {
          if (includeFolderEntries) {
            let cur = "";
            const parts = rel.split("/").slice(0, -1);
            for (const part of parts) {
              const parent = cur;
              cur = cur ? `${cur}/${part}` : part;
              if (!seenFolders.has(cur)) {
                const parentKey = parent ? folderKeys.get(parent) : undefined;
                const folderEntry = risuFolderEntry(cur, parentKey);
                data.push(folderEntry);
                seenFolders.add(cur);
                folderKeys.set(cur, folderEntry.key);
              }
            }
          }
          const cachedEntry = cache.fileEntries.get(rel);
          if (!cachedEntry) continue; // 비활성 항목
          const entry = cachedEntry.entry;
          const parentFolder = dirname(rel);
          // 캐시된 엔트리를 재사용하므로 folder 필드를 매번 fresh 빌드와 동일하게 정규화.
          // (상위 폴더 이동 / includeFolderEntries 토글 시 잔류하는 folder 제거 → 해시 동일)
          if (parentFolder && includeFolderEntries) {
            entry.folder = folderKeys.get(parentFolder);
          } else {
            delete entry.folder;
          }
          data.push(entry);
        }

        cache.data = data;
        const manifest = {};
        for (const entry of data) {
          if (entry.id) manifest[entry.id] = sha1Hex(utf8Bytes(JSON.stringify(entry)));
        }
        cache.manifest = manifest;
        const hash = sha1Hex(utf8Bytes(JSON.stringify(data)));
        return { data, manifest, hash };
      } finally {
        cache._reconcilePromise = null;
      }
    })();
    return cache._reconcilePromise;
  }

  handleSyncRequest(req, res) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      // Authorization 포함: 클라이언트가 relay 토큰을 로컬 서버에도 보낼 수 있도록 허용.
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const [pathname, queryStr] = (req.url || "/").split("?");
    const url = pathname;
    const queryParams = new URLSearchParams(queryStr || "");
    const workspaceId = queryParams.get("workspace") || null;

    const wrap = (fn) =>
      fn().catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { ...cors, "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: String(err.message || err) }));
      });

    if (url === "/lorebook" || url === "/lorebook/active") {
      wrap(() => this.serveLorebook(res, cors, null, workspaceId));
    } else if (url === "/lorebook/original") {
      wrap(() => this.serveLorebook(res, cors, "original", workspaceId));
    } else if (url === "/lorebook/translated") {
      wrap(() => this.serveLorebook(res, cors, "translated", workspaceId));
    } else if (url === "/lorebook/hash") {
      wrap(() => this.serveLorebookHash(res, cors, workspaceId));
    } else if (url === "/lorebook/entries") {
      const idsParam = queryParams.get("ids") || "";
      // 클라이언트가 encodeURIComponent 로 인코딩한 id를 복원한다.
      const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
      const ids = idsParam ? idsParam.split(",").map(safeDecode).filter(Boolean) : [];
      wrap(() => this.serveLorebookEntries(res, cors, ids, workspaceId));
    } else if (url === "/workspaces") {
      wrap(() => this.serveWorkspaceList(res, cors));
    } else {
      res.writeHead(404, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  async serveLorebook(res, cors, mode, workspaceId) {
    let workspace;
    if (workspaceId) {
      workspace = this.getWorkspaceById(workspaceId);
      if (!workspace) return this.respondWorkspaceNotFound(res, cors);
    } else {
      workspace = this.getActiveWorkspace();
    }
    const effectiveMode = mode || this.settings.risuSyncMode || "translated";

    // on-demand 증분 reconcile 결과를 캐시에서 서빙 (디스크 파일 불필요)
    const { data } = await this.reconcileLorebook(workspace, effectiveMode);
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ type: "risu", ver: 1, data }));
  }

  async serveLorebookHash(res, cors, workspaceId) {
    let workspace;
    if (workspaceId) {
      workspace = this.getWorkspaceById(workspaceId);
      if (!workspace) return this.respondWorkspaceNotFound(res, cors);
    } else {
      workspace = this.getActiveWorkspace();
    }
    const mode = this.settings.risuSyncMode || "translated";

    const { manifest, hash } = await this.reconcileLorebook(workspace, mode);
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      hash,
      mode,
      workspace: workspace.name,
      workspaceId: workspace.id,
      entries: manifest
    }));
  }

  async serveLorebookEntries(res, cors, ids, workspaceId) {
    let workspace;
    if (workspaceId) {
      workspace = this.getWorkspaceById(workspaceId);
      if (!workspace) return this.respondWorkspaceNotFound(res, cors);
    } else {
      workspace = this.getActiveWorkspace();
    }
    const mode = this.settings.risuSyncMode || "translated";

    if (!ids.length) {
      res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }

    // /hash가 방금 reconcile한 같은 캐시에서 필터 → 폴 내 일관성 유지
    const { data } = await this.reconcileLorebook(workspace, mode);
    const idSet = new Set(ids);
    const filtered = data.filter(e => e.id && idSet.has(e.id));
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ data: filtered }));
  }

  // 요청한 workspaceId를 찾을 수 없을 때 404로 응답.
  // 기존에는 active workspace로 조용히 폴백했으나, 이 경우 잘못된 로어북이
  // 클라이언트에 전달되므로 명시적으로 에러를 반환한다.
  respondWorkspaceNotFound(res, cors) {
    res.writeHead(404, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Workspace not found" }));
  }

  getWorkspaceById(id) {
    return (this.settings.workspaces || []).find(ws => ws.id === id) || null;
  }

  async serveWorkspaceList(res, cors) {
    const workspaces = (this.settings.workspaces || []).map(ws => ({
      id: ws.id,
      name: ws.name,
      directory: ws.directory
    }));
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      workspaces,
      activeWorkspaceId: this.settings.activeWorkspaceId
    }));
  }

  registerAutoBuild() {
    this.unregisterAutoBuild();
    this._autoBuildRef = this.app.vault.on("modify", (file) => {
      if (!file || file.extension !== "md") return;
      const workspace = this.workspaceForPath(file.path);
      if (!workspace) return;
      this.scheduleAutoBuild(workspace);
    });
  }

  unregisterAutoBuild() {
    if (this._autoBuildRef) {
      this.app.vault.offref(this._autoBuildRef);
      this._autoBuildRef = null;
    }
    // 워크스페이스별 디바운스 타이머를 모두 정리.
    if (this._autoBuildTimers) {
      for (const id of this._autoBuildTimers.keys()) {
        clearTimeout(this._autoBuildTimers.get(id));
        this._autoBuildTimers.delete(id);
      }
    }
  }

  scheduleAutoBuild(workspace) {
    // 워크스페이스별로 독립적인 디바운스 타이머를 운용한다.
    // 단일 타이머를 쓰면 2초 내 여러 워크스페이스가 변경되었을 때
    // 마지막 워크스페이스만 rebuild 되고 나머지는 stale 가 되므로 분리.
    if (!this._autoBuildTimers) this._autoBuildTimers = new Map();
    const key = workspace.id;
    const prev = this._autoBuildTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
      this._autoBuildTimers.delete(key);
      if (this.settings.risuSyncMode === "original") {
        await this.buildLorebook({
          workspace,
          sourceFolder: workspace.projectFolder,
          metadataFolder: workspace.projectFolder,
          outputPath: workspace.originalOutputPath
        });
      } else {
        await this.buildLorebook({
          workspace,
          sourceFolder: workspace.translatedFolder,
          metadataFolder: workspace.projectFolder,
          outputPath: workspace.translatedOutputPath
        });
      }
    }, 2000);
    this._autoBuildTimers.set(key, timer);
  }
};

// ── Notice: real-time translation progress ────────────────────────────────────

class StreamNotice {
  constructor() {
    this.completed = false;
    this._charCount = 0;
    this._rafPending = false;
    this._notice = new Notice("", 0);
    const el = this._notice.noticeEl;
    el.empty();
    el.addClass("risu-stream-notice");
    this._progressEl = el.createEl("div", { cls: "risu-notice-progress" });
    this._fileEl = el.createEl("div", { cls: "risu-notice-file" });
    this._tokenEl = el.createEl("div", { cls: "risu-notice-tokens" });
  }

  setProgress(current, total, completed, failed) {
    this._progressEl.setText(
      `[${current}/${total}]  완료 ${completed}  ·  실패 ${failed}`
    );
  }

  setFile(filename) {
    this._fileEl.setText(`번역 중: ${filename}`);
  }

  addChunk(chunk) {
    this._charCount += chunk.length;
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => {
        this._rafPending = false;
        this._tokenEl.setText(`출력 글자: ${this._charCount.toLocaleString()}`);
      });
    }
  }

  addTokens() {}

  close() {
    this._notice.hide();
  }
}

// ── Modal: workspace switcher ─────────────────────────────────────────────────

class WorkspaceSwitcherModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("워크스페이스 선택...");
  }

  getItems() {
    return this.plugin.settings.workspaces;
  }

  getItemText(workspace) {
    return workspaceLabel(workspace);
  }

  onChooseItem(workspace) {
    this.plugin.settings.activeWorkspaceId = workspace.id;
    this.plugin.saveSettings();
    this.plugin.refreshEditorActions();
    new Notice(`Risu 워크스페이스: ${workspaceLabel(workspace)}`);
  }
}

// ── Modal: JSON file picker (로어북 불러오기) ───────────────────────────────────

class JsonFilePickerModal extends FuzzySuggestModal {
  constructor(app, files) {
    super(app);
    this.files = files;
    this.setPlaceholder("불러올 RisuAI 로어북 JSON 파일 선택...");
    this._resolve = null;
    this._resolved = false;
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    // console.log("[Risu] JsonFilePickerModal: onChooseItem =", file && file.path);
    // 이 버전에서는 onClose가 onChooseItem보다 먼저 발생할 수 있어
    // 여기서는 값을 보관만 하고 확정은 onClose 이후 틱에서 한다.
    this._chosen = file || null;
  }

  onClose() {
    // console.log("[Risu] JsonFilePickerModal: onClose");
    // onChooseItem이 onClose 직후 같은 태스크에서 값을 채울 수 있으므로
    // 다음 틱으로 미뤄 보관된 값을 확정한다.
    setTimeout(() => {
      this._settle(this._chosen === undefined ? null : this._chosen);
    }, 0);
  }

  _settle(value) {
    if (this._resolved) return;
    this._resolved = true;
    if (this._resolve) this._resolve(value);
  }

  pick() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._chosen = undefined;
      // console.log("[Risu] JsonFilePickerModal: open (항목 수 =", this.files.length, ")");
      this.open();
    });
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class RisuLorebookToolsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const workspace = this.plugin.getActiveWorkspace();

    containerEl.createEl("h2", { text: "스크립토리움" });
    containerEl.createEl("p", {
      cls: "risu-lorebook-tools-setting-note",
      text: "명령은 활성 워크스페이스 디렉토리를 기준으로 실행됩니다. 경로는 모두 vault 기준 상대 경로입니다."
    });

    containerEl.createEl("h3", { text: "워크스페이스" });

    new Setting(containerEl)
      .setName("활성 워크스페이스")
      .setDesc("모든 Risu 명령이 사용할 워크스페이스 디렉토리입니다.")
      .addDropdown((dropdown) => {
        for (const item of this.plugin.settings.workspaces) {
          dropdown.addOption(item.id, workspaceLabel(item));
        }
        dropdown.setValue(workspace.id).onChange(async (value) => {
          this.plugin.settings.activeWorkspaceId = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    let workspaceListValue = workspaceDirectoryListText(this.plugin.settings.workspaces);
    new Setting(containerEl)
      .setName("워크스페이스 디렉토리 목록")
      .setDesc("한 줄에 하나씩 입력하세요.")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.addClass("risu-lorebook-tools-workspace-list");
        text.setValue(workspaceListValue);
        text.onChange((value) => {
          workspaceListValue = value;
        });
      })
      .addButton((button) =>
        button
          .setButtonText("적용")
          .setCta()
          .onClick(async () => {
            this.plugin.updateWorkspaceDirectories(workspaceListValue);
            await this.plugin.saveSettings();
            new Notice("Risu 워크스페이스 목록을 저장했습니다.");
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("표준 파일")
      .setDesc(
        `${workspace.directory} 안에서 ${RISU_IGNORE_FILE}, ${PROMPT_FILE}, ${TRANSLATION_CACHE_FILE}, ${TRANSLATED_FOLDER}/를 사용합니다.`
      );

    containerEl.createEl("h3", { text: "번역 프롬프트" });

    new Setting(containerEl)
      .setName(`${workspace.name} 프롬프트`)
      .setDesc(`파일: ${workspace.promptPath}  —  {text} 자리에 번역 대상이 삽입됩니다.`)
      .addTextArea((text) => {
        text.inputEl.rows = 15;
        text.inputEl.addClass("risu-lorebook-tools-prompt");
        text.onChange(async (value) => {
          await this.plugin.writeVaultText(workspace.promptPath, value);
        });
        (async () => {
          try {
            const exists = await this.plugin.pathExists(workspace.promptPath);
            const content = exists
              ? await this.plugin.readVaultText(workspace.promptPath)
              : this.plugin._legacyPrompt || defaultPromptMarkdown();
            text.setValue(content);
          } catch {
            text.setValue(defaultPromptMarkdown());
          }
        })();
      })
      .addButton((btn) =>
        btn.setButtonText("기본값으로 초기화").onClick(async () => {
          await this.plugin.writeVaultText(workspace.promptPath, defaultPromptMarkdown());
          this.display();
        })
      );

    containerEl.createEl("h3", { text: "동작 옵션" });

    new Setting(containerEl)
      .setName("Risu 폴더 항목 포함")
      .setDesc("Markdown 하위 폴더도 RisuAI 폴더 로어 항목으로 생성합니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeFolderEntries).onChange(async (value) => {
          this.plugin.settings.includeFolderEntries = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("번역 폴더 메타데이터도 초기화")
      .setDesc("메타데이터 초기화 명령이 translate 폴더 안의 파일도 함께 처리합니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.initTranslatedFiles).onChange(async (value) => {
          this.plugin.settings.initTranslatedFiles = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("변경된 파일만 번역")
      .setDesc("번역 캐시를 사용해 바뀌지 않은 파일은 건너뜁니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.translateChangedOnly).onChange(async (value) => {
          this.plugin.settings.translateChangedOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("번역 후 중복 한국어 괄호 제거")
      .setDesc("번역 후처리 시 같은 파일 내 중복 한국어 괄호 표현을 첫 번째만 남기고 제거합니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deduplicateParenthesesOnTranslate).onChange(async (value) => {
          this.plugin.settings.deduplicateParenthesesOnTranslate = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("파일 저장 시 자동 로어북 빌드")
      .setDesc("Markdown 파일 수정 시 디스크의 로어북 JSON을 갱신합니다(2초 디바운스). RisuAI 동기화 자체는 폴링 시 on-demand로 최신 상태를 서빙하므로 이 옵션 없이도 동작합니다. 디스크 파일을 항상 최신으로 유지할 때만 켜세요.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoBuildEnabled).onChange(async (value) => {
          this.plugin.settings.autoBuildEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.registerAutoBuild();
          } else {
            this.plugin.unregisterAutoBuild();
          }
        })
      );

    containerEl.createEl("h3", { text: "OpenAI compatible API" });

    new Setting(containerEl)
      .setName("API URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiCompatibleApiUrl).onChange(async (value) => {
          this.plugin.settings.openaiCompatibleApiUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("프록시 URL")
      .setDesc("설정 시 이 URL로 요청하고 X-Target-URL 헤더에 API URL을 담습니다. 비워두면 API URL로 직접 요청합니다.")
      .addText((text) => {
        text.setPlaceholder("https://my-proxy.example.com/v1/chat/completions");
        text.setValue(this.plugin.settings.proxyUrl).onChange(async (value) => {
          this.plugin.settings.proxyUrl = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("모델")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiCompatibleModel).onChange(async (value) => {
          this.plugin.settings.openaiCompatibleModel = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("API 키")
      .setDesc("플러그인 로컬 data.json에 저장됩니다.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("API 키 붙여넣기");
        text.setValue(this.plugin.settings.openaiCompatibleApiKey);
        text.onChange(async (value) => {
          this.plugin.settings.openaiCompatibleApiKey = value;
          await this.plugin.saveSettings();
        });
      });

    this.addNumberSetting("최대 재시도", "API 호출 재시도 횟수입니다.", "maxRetries");
    this.addNumberSetting(
      "초기 대기 시간(초)",
      "속도 제한이나 일시 오류 시 초기 대기 시간입니다.",
      "initialBackoffSeconds"
    );
    this.addNumberSetting(
      "요청 제한 시간(초)",
      "스트리밍 요청 하나에 적용할 제한 시간입니다.",
      "requestTimeoutSeconds"
    );

    containerEl.createEl("h3", { text: "RisuAI 동기화 서버" });
    containerEl.createEl("p", {
      cls: "risu-lorebook-tools-setting-note",
      text: "Obsidian이 로컬 HTTP 서버를 열고 RisuAI 플러그인이 폴링해 로어북을 가져갑니다. 요청이 들어올 때마다 Markdown 파일을 즉시 읽어 로어북을 만들어 응답하므로 별도의 빌드 단계가 필요 없습니다."
    });

    new Setting(containerEl)
      .setName("동기화 서버 활성화")
      .setDesc("활성화 시 즉시 서버가 시작됩니다. 비활성화 시 서버가 종료됩니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.risuSyncEnabled).onChange(async (value) => {
          this.plugin.settings.risuSyncEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.startSyncServer();
          } else {
            this.plugin.stopSyncServer();
          }
        })
      );

    new Setting(containerEl)
      .setName("서버 포트")
      .setDesc("RisuAI 플러그인이 접속할 로컬 포트 번호입니다. 변경 후 서버를 재시작하세요.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.risuSyncPort)).onChange(async (value) => {
          this.plugin.settings.risuSyncPort = positiveInteger(value, DEFAULT_SETTINGS.risuSyncPort);
          await this.plugin.saveSettings();
          if (this.plugin.settings.risuSyncEnabled) {
            this.plugin.startSyncServer();
          }
        })
      );

    new Setting(containerEl)
      .setName("푸시 모드")
      .setDesc("RisuAI에 원문(한국어) 로어북을 보낼지, 번역(영어) 로어북을 보낼지 선택합니다.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("translated", "번역본 (영어)")
          .addOption("original", "원문 (한국어)")
          .setValue(this.plugin.settings.risuSyncMode)
          .onChange(async (value) => {
            this.plugin.settings.risuSyncMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("서버 상태")
      .setDesc(
        this.plugin._syncServer
          ? `실행 중 — localhost:${this.plugin.settings.risuSyncPort}`
          : "중지됨"
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin._syncServer ? "재시작" : "시작")
          .onClick(async () => {
            if (this.plugin.settings.risuSyncEnabled) {
              this.plugin.startSyncServer();
              this.display();
            }
          })
      );

    containerEl.createEl("h3", { text: "릴레이 서버 (모바일 / 원격)" });
    containerEl.createEl("p", {
      cls: "risu-lorebook-tools-setting-note",
      text: "Obsidian이 클라우드 릴레이에 로어북을 푸시하면 RisuAI가 릴레이를 폴링합니다. 모바일 Obsidian에서는 이 모드만 사용 가능합니다."
    });

    new Setting(containerEl)
      .setName("릴레이 모드 활성화")
      .setDesc("활성화 시 로어북 빌드 후 릴레이 서버로 자동 푸시할 수 있습니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.relayEnabled).onChange(async (value) => {
          this.plugin.settings.relayEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("릴레이 URL")
      .setDesc("릴레이 서버 주소입니다. 예: https://my-relay.workers.dev")
      .addText((text) =>
        text
          .setPlaceholder("https://my-relay.workers.dev")
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            this.plugin.settings.relayUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("인증 토큰 (선택)")
      .setDesc("릴레이 서버의 AUTH_TOKEN. 비워두면 인증 없이 통신합니다(서버에서 AUTH_TOKEN을 설정하지 않은 경우). data.json에 저장됩니다.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("토큰 붙여넣기")
          .setValue(this.plugin.settings.relayToken)
          .onChange(async (value) => {
            this.plugin.settings.relayToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("빌드 후 자동 푸시")
      .setDesc("원문/번역 로어북 생성 완료 시 릴레이에 자동으로 업로드합니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.relayAutoPushOnBuild).onChange(async (value) => {
          this.plugin.settings.relayAutoPushOnBuild = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("즉시 푸시")
      .setDesc("현재 모든 워크스페이스의 로어북을 지금 즉시 릴레이에 업로드합니다.")
      .addButton((btn) =>
        btn.setButtonText("푸시").onClick(async () => {
          try {
            btn.setButtonText("푸시 중...");
            btn.setDisabled(true);
            const result = await this.plugin.pushToRelay();
            new Notice(`릴레이 푸시 완료: ${result.pushed}개 워크스페이스`);
          } catch (err) {
            new Notice(`릴레이 푸시 실패: ${err.message}`);
          } finally {
            btn.setButtonText("푸시");
            btn.setDisabled(false);
          }
        })
      );
  }

  addNumberSetting(name, desc, key) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
          this.plugin.settings[key] = positiveInteger(value, DEFAULT_SETTINGS[key]);
          await this.plugin.saveSettings();
        })
      );
  }
}

// ── Settings normalization ────────────────────────────────────────────────────

function normalizeLoadedSettings(data) {
  const raw = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    activeWorkspaceId: String(raw.activeWorkspaceId || DEFAULT_SETTINGS.activeWorkspaceId).trim(),
    workspaces:
      Array.isArray(raw.workspaces) && raw.workspaces.length
        ? raw.workspaces
        : [workspaceFromLegacySettings(raw)],
    includeFolderEntries: legacyBooleanOption(raw, "includeFolderEntries"),
    initTranslatedFiles: legacyBooleanOption(raw, "initTranslatedFiles"),
    translateChangedOnly: legacyBooleanOption(raw, "translateChangedOnly"),
    openaiCompatibleApiUrl:
      raw.openaiCompatibleApiUrl === undefined
        ? legacyApiSetting(raw, "ApiUrl", DEFAULT_SETTINGS.openaiCompatibleApiUrl)
        : raw.openaiCompatibleApiUrl,
    openaiCompatibleModel:
      raw.openaiCompatibleModel === undefined
        ? legacyApiSetting(raw, "Model", DEFAULT_SETTINGS.openaiCompatibleModel)
        : raw.openaiCompatibleModel,
    openaiCompatibleApiKey:
      raw.openaiCompatibleApiKey === undefined
        ? legacyApiSetting(raw, "ApiKey", DEFAULT_SETTINGS.openaiCompatibleApiKey)
        : raw.openaiCompatibleApiKey,
    translationCaches:
      raw.translationCaches && typeof raw.translationCaches === "object"
        ? raw.translationCaches
        : DEFAULT_SETTINGS.translationCaches || {},
    proxyUrl: raw.proxyUrl === undefined ? DEFAULT_SETTINGS.proxyUrl : raw.proxyUrl,
    maxRetries: raw.maxRetries === undefined ? DEFAULT_SETTINGS.maxRetries : raw.maxRetries,
    initialBackoffSeconds:
      raw.initialBackoffSeconds === undefined
        ? DEFAULT_SETTINGS.initialBackoffSeconds
        : raw.initialBackoffSeconds,
    requestTimeoutSeconds:
      raw.requestTimeoutSeconds === undefined
        ? DEFAULT_SETTINGS.requestTimeoutSeconds
        : raw.requestTimeoutSeconds,
    risuSyncEnabled:
      raw.risuSyncEnabled === undefined ? DEFAULT_SETTINGS.risuSyncEnabled : raw.risuSyncEnabled,
    risuSyncPort:
      raw.risuSyncPort === undefined ? DEFAULT_SETTINGS.risuSyncPort : raw.risuSyncPort,
    risuSyncMode:
      raw.risuSyncMode === undefined ? DEFAULT_SETTINGS.risuSyncMode : raw.risuSyncMode,
    relayEnabled:
      raw.relayEnabled === undefined ? DEFAULT_SETTINGS.relayEnabled : raw.relayEnabled,
    relayUrl:
      raw.relayUrl === undefined ? DEFAULT_SETTINGS.relayUrl : raw.relayUrl,
    relayToken:
      raw.relayToken === undefined ? DEFAULT_SETTINGS.relayToken : raw.relayToken,
    relayAutoPushOnBuild:
      raw.relayAutoPushOnBuild === undefined ? DEFAULT_SETTINGS.relayAutoPushOnBuild : raw.relayAutoPushOnBuild,
    deduplicateParenthesesOnTranslate:
      raw.deduplicateParenthesesOnTranslate === undefined ? DEFAULT_SETTINGS.deduplicateParenthesesOnTranslate : raw.deduplicateParenthesesOnTranslate,
    autoBuildEnabled:
      raw.autoBuildEnabled === undefined ? DEFAULT_SETTINGS.autoBuildEnabled : raw.autoBuildEnabled
  };
}

function settingsForSave(settings) {
  return {
    activeWorkspaceId: settings.activeWorkspaceId,
    workspaces: (settings.workspaces || []).map((workspace) => ({
      id: workspace.id,
      directory: workspace.directory
    })),
    includeFolderEntries: settings.includeFolderEntries,
    initTranslatedFiles: settings.initTranslatedFiles,
    translateChangedOnly: settings.translateChangedOnly,
    openaiCompatibleApiUrl: settings.openaiCompatibleApiUrl,
    openaiCompatibleModel: settings.openaiCompatibleModel,
    openaiCompatibleApiKey: settings.openaiCompatibleApiKey,
    maxRetries: settings.maxRetries,
    initialBackoffSeconds: settings.initialBackoffSeconds,
    requestTimeoutSeconds: settings.requestTimeoutSeconds,
    risuSyncEnabled: settings.risuSyncEnabled,
    risuSyncPort: settings.risuSyncPort,
    risuSyncMode: settings.risuSyncMode,
    relayEnabled: settings.relayEnabled,
    relayUrl: settings.relayUrl,
    relayToken: settings.relayToken,
    relayAutoPushOnBuild: settings.relayAutoPushOnBuild,
    deduplicateParenthesesOnTranslate: settings.deduplicateParenthesesOnTranslate,
    autoBuildEnabled: settings.autoBuildEnabled
  };
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

function workspaceFromLegacySettings(raw) {
  return workspaceFromDirectory(workspaceDirectoryFromRaw(raw));
}

function normalizeWorkspaceList(settings) {
  const source =
    Array.isArray(settings.workspaces) && settings.workspaces.length
      ? settings.workspaces
      : [workspaceFromLegacySettings(settings)];
  const directories = uniqueNormalizedPaths(source.map(workspaceDirectoryFromRaw));
  const workspaces = directories.map((directory) => workspaceFromDirectory(directory, settings));

  if (!workspaces.length) {
    workspaces.push(workspaceFromDirectory(DEFAULT_WORKSPACE_DIRECTORY, settings));
  }

  return workspaces;
}

function workspaceFromDirectory(directory, options = DEFAULT_WORKSPACE_OPTIONS) {
  const normalizedDirectory = normalizeVaultPath(directory) || DEFAULT_WORKSPACE_DIRECTORY;
  return {
    id: workspaceIdForDirectory(normalizedDirectory),
    name: basename(normalizedDirectory) || normalizedDirectory,
    directory: normalizedDirectory,
    projectFolder: normalizedDirectory,
    translatedFolder: joinVaultPath(normalizedDirectory, TRANSLATED_FOLDER),
    translationCachePath: joinVaultPath(normalizedDirectory, TRANSLATION_CACHE_FILE),
    promptPath: joinVaultPath(normalizedDirectory, PROMPT_FILE),
    legacyCachePaths: [
      joinVaultPath(normalizedDirectory, "risu_cache.md"),
      joinVaultPath(normalizedDirectory, ".translate_cache.json")
    ],
    ignorePath: joinVaultPath(normalizedDirectory, RISU_IGNORE_FILE),
    legacyIgnorePaths: LEGACY_IGNORE_FILES.map((file) => joinVaultPath(normalizedDirectory, file)),
    originalOutputPath: joinVaultPath(normalizedDirectory, ORIGINAL_LOREBOOK_FILE),
    translatedOutputPath: joinVaultPath(normalizedDirectory, TRANSLATED_LOREBOOK_FILE),
    mergeOutputPath: joinVaultPath(normalizedDirectory, MERGED_CONTEXT_FILE),
    basePath: joinVaultPath(normalizedDirectory, LOREBOOK_BASE_FILE),
    includeFolderEntries: booleanSetting(
      options.includeFolderEntries,
      DEFAULT_WORKSPACE_OPTIONS.includeFolderEntries
    ),
    initTranslatedFiles: booleanSetting(
      options.initTranslatedFiles,
      DEFAULT_WORKSPACE_OPTIONS.initTranslatedFiles
    ),
    translateChangedOnly: booleanSetting(
      options.translateChangedOnly,
      DEFAULT_WORKSPACE_OPTIONS.translateChangedOnly
    )
  };
}

function workspaceDirectoryFromRaw(raw) {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_WORKSPACE_DIRECTORY;
  }
  return normalizeVaultPath(raw.directory || raw.projectFolder || DEFAULT_WORKSPACE_DIRECTORY);
}

function workspaceIdForDirectory(directory) {
  const normalizedDirectory = normalizeVaultPath(directory) || DEFAULT_WORKSPACE_DIRECTORY;
  return `workspace-${sha1Hex(utf8Bytes(normalizedDirectory)).slice(0, 12)}`;
}

function workspaceLabel(workspace) {
  if (!workspace) return "";
  return workspace.name && workspace.name !== workspace.directory
    ? `${workspace.name} (${workspace.directory})`
    : workspace.directory;
}

function workspaceDirectoryListText(workspaces) {
  return (workspaces || []).map((workspace) => workspace.directory).join("\n");
}

function parseWorkspaceDirectoryList(text) {
  return uniqueNormalizedPaths(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map(stripMarkdownListMarker)
      .filter((line) => line && !line.startsWith("#"))
  );
}

function uniqueNormalizedPaths(paths) {
  const seen = new Set();
  const normalized = [];
  for (const path of paths) {
    const value = normalizeVaultPath(path);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function stripMarkdownListMarker(value) {
  return String(value || "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`(.+)`$/, "$1")
    .trim();
}

function legacyBooleanOption(raw, key) {
  if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
    return raw[key];
  }
  if (raw && Array.isArray(raw.workspaces)) {
    const workspace = raw.workspaces.find((item) =>
      Object.prototype.hasOwnProperty.call(item, key)
    );
    if (workspace) return workspace[key];
  }
  return DEFAULT_SETTINGS[key];
}

function legacyApiSetting(raw, suffix, fallback) {
  const legacyKey = `${"olla"}${"ma"}${suffix}`;
  if (raw && Object.prototype.hasOwnProperty.call(raw, legacyKey)) {
    return raw[legacyKey];
  }
  return fallback;
}

// ── Ignore patterns ───────────────────────────────────────────────────────────

function parseIgnorePatterns(text) {
  const patterns = [];
  let inFence = false;

  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;

    const pattern = inFence ? trimmed : stripMarkdownListMarker(trimmed);
    if (pattern && !pattern.startsWith("#")) {
      patterns.push(pattern);
    }
  }

  return patterns;
}

// ── Translation cache ─────────────────────────────────────────────────────────

function parseCacheMarkdown(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenced ? fenced[1] : raw).trim();
  if (!jsonText) return {};
  return JSON.parse(jsonText);
}

function renderCacheJson(cache) {
  return `${JSON.stringify(
    cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {},
    null,
    2
  )}\n`;
}

// ── Streaming helpers ─────────────────────────────────────────────────────────

function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let jsonStr = trimmed;
  if (trimmed.startsWith("data:")) {
    jsonStr = trimmed.slice(5).trim();
    if (jsonStr === "[DONE]") return null;
  }
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function extractChunkContent(parsed) {
  if (!parsed) return "";
  // OpenAI streaming delta
  const openai = parsed.choices?.[0]?.delta?.content;
  if (typeof openai === "string") return openai;
  // Ollama streaming (not done)
  if (!parsed.done && typeof parsed.message?.content === "string") return parsed.message.content;
  return "";
}

function extractUsage(parsed) {
  if (!parsed) return null;
  // OpenAI with stream_options.include_usage
  if (parsed.usage) {
    return { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 };
  }
  // Ollama done message
  if (parsed.done && (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined)) {
    return { input: parsed.prompt_eval_count || 0, output: parsed.eval_count || 0 };
  }
  return null;
}

// ── Default file contents ─────────────────────────────────────────────────────

function defaultPromptMarkdown() {
  return [
    "You are a precise document translator.",
    "",
    "## Scope",
    "- Translate ONLY content inside fenced code blocks (``` ```)",
    "- Leave all text outside code blocks completely untouched",
    "",
    "## Markdown Front Matter / Lorebook Metadata",
    "- If the document starts with YAML front matter (`---` ... `---`), preserve the structure exactly.",
    "- Do NOT translate the `title` value.",
    "- For `keys`, keep existing keys as-is and append target language equivalents after them.",
    "- Leave `secondary_keys`, `selective`, `always_active`, `insertion_order`, and `depth` unchanged.",
    "",
    "## Translation Rules",
    "- Preserve tone, register, and nuance exactly — do not soften, elaborate, or summarize",
    "- Preserve all markdown formatting inside code blocks as-is",
    "- Do not add, remove, or reorder any information",
    "- Output only the translated document; no commentary",
    "",
    "{text}",
    ""
  ].join("\n");
}

function buildLorebookBaseContent(directory) {
  const dir = normalizeVaultPath(directory);
  return [
    "filters:",
    "  and:",
    `    - file.inFolder("${dir}")`,
    "",
    "properties:",
    "  title:",
    "    displayName: 제목",
    "  keys:",
    "    displayName: 키",
    "  secondary_keys:",
    "    displayName: 보조 키",
    "  selective:",
    "    displayName: selective",
    "  always_active:",
    "    displayName: 항상 활성",
    "  insertion_order:",
    "    displayName: 삽입 순서",
    "  depth:",
    "    displayName: depth",
    "",
    "views:",
    "  - type: table",
    "    name: 로어북 메타 편집기",
    "    order:",
    "      - file.name",
    "      - title",
    "      - keys",
    "      - secondary_keys",
    "      - selective",
    "      - always_active",
    "      - insertion_order",
    "      - depth",
    ""
  ].join("\n");
}

function defaultIgnoreMarkdown() {
  return [
    "# Risu 제외 목록",
    "",
    "로어북 생성, 병합, 번역에서 제외할 경로 패턴을 적습니다.",
    "Markdown 목록이나 코드 블록 형태로 편집할 수 있습니다.",
    "",
    "- " + TRANSLATED_FOLDER + "/",
    "- " + MERGED_CONTEXT_FILE,
    "- " + PROMPT_FILE,
    "- " + RISU_IGNORE_FILE,
    ""
  ].join("\n");
}

// ── Translation cancellation ──────────────────────────────────────────────────

function translationCancelledError() {
  const error = new Error("번역이 중지되었습니다.");
  error.risuTranslationCancelled = true;
  return error;
}

function isTranslationCancelled(error) {
  return Boolean(error?.risuTranslationCancelled);
}

function throwIfTranslationCancelled(job) {
  if (job?.cancelled) {
    throw translationCancelledError();
  }
}

// ── Frontmatter / lorebook metadata ──────────────────────────────────────────

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === "[]") return [];
  if (["true", "True"].includes(value)) return true;
  if (["false", "False"].includes(value)) return false;
  if (["null", "None"].includes(value)) return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value.startsWith('"') || value.startsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function parseFrontmatter(text) {
  const normalized = text.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) {
    return { data: {}, body: text, exists: false };
  }
  return {
    data: parseSimpleYaml(match[1]),
    body: normalized.slice(match[0].length),
    exists: true
  };
}

function parseSimpleYaml(raw) {
  const data = {};
  let currentMap = null;
  let currentListKey = null;
  let currentListContainer = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const stripped = line.trim();
    if (stripped.startsWith("- ") && currentListKey && currentListContainer) {
      currentListContainer[currentListKey].push(parseScalar(stripped.slice(2)));
      continue;
    }

    const indent = line.match(/^\s*/)[0].length;
    const possibleKey = stripped.split(":")[0].trim();
    const looksTopLevel =
      indent === 0 || (currentMap === null && LOREBOOK_META_KEYS.has(possibleKey));

    if (looksTopLevel) {
      const [key, value] = splitYamlPair(stripped);
      if (value) {
        data[key] = parseScalar(value);
        currentMap = null;
        currentListKey = null;
        currentListContainer = null;
      } else if (LIST_META_KEYS.has(key)) {
        data[key] = [];
        currentMap = null;
        currentListKey = key;
        currentListContainer = data;
      } else {
        data[key] = {};
        currentMap = data[key];
        currentListKey = null;
        currentListContainer = null;
      }
      continue;
    }

    if (!currentMap) continue;
    const [key, value] = splitYamlPair(stripped);
    if (value) {
      currentMap[key] = parseScalar(value);
      currentListKey = null;
      currentListContainer = null;
    } else {
      currentMap[key] = [];
      currentListKey = key;
      currentListContainer = currentMap;
    }
  }

  return data;
}

function splitYamlPair(line) {
  const index = line.indexOf(":");
  if (index === -1) return [line.trim(), ""];
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function yamlQuote(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isInteger(value)) return String(value);
  if (value === null || value === undefined) return "null";
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dumpFrontmatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlQuote(item)}`);
      }
    } else if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (Array.isArray(childValue)) {
          lines.push(`  ${childKey}:`);
          for (const item of childValue) {
            lines.push(`    - ${yamlQuote(item)}`);
          }
        } else {
          lines.push(`  ${childKey}: ${yamlQuote(childValue)}`);
        }
      }
    } else {
      lines.push(`${key}: ${yamlQuote(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n`;
}

function keysFromFilename(path) {
  const title = stem(path);
  const keys = title
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return keys.length ? keys : [title];
}

function defaultMetadata(path, rel, _body, includeId = false) {
  const title = stem(path);
  const metadata = {
    title,
    keys: keysFromFilename(path),
    secondary_keys: [],
    selective: false,
    always_active: false,
    insertion_order: 100
  };
  if (includeId) {
    metadata.id = stableId("entry", rel);
  }
  return metadata;
}

function initMetadata(path, rel, body) {
  return defaultMetadata(path, rel, body, false);
}

function stripLorebookMetadata(data) {
  const stripped = {};
  for (const [key, value] of Object.entries(data)) {
    if (!LOREBOOK_META_KEYS.has(key) && key !== "lorebook") {
      stripped[key] = value;
    }
  }
  return stripped;
}

function metadataFromFrontmatter(fm) {
  if (fm.data.lorebook && typeof fm.data.lorebook === "object" && !Array.isArray(fm.data.lorebook)) {
    return Object.assign({}, fm.data.lorebook);
  }
  const found = {};
  for (const key of LOREBOOK_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fm.data, key)) {
      found[key] = fm.data[key];
    }
  }
  return found;
}

function renderDocumentWithMetadata(fm, metadata) {
  const other = stripLorebookMetadata(fm.data);
  return dumpFrontmatter(Object.assign({}, other, metadata)) + fm.body.replace(/^\n+/, "");
}

function renderDocumentWithoutMetadata(fm) {
  const other = stripLorebookMetadata(fm.data);
  if (Object.keys(other).length) {
    return dumpFrontmatter(other) + fm.body.replace(/^\n+/, "");
  }
  return fm.body.replace(/^\n+/, "");
}

function hasLorebookMetadata(fm) {
  if (fm.data.lorebook && typeof fm.data.lorebook === "object") return true;
  return Array.from(LOREBOOK_META_KEYS).some((key) =>
    Object.prototype.hasOwnProperty.call(fm.data, key)
  );
}

function normalizeLorebookMetadata(path, rel, fm) {
  const metadata = Object.assign(defaultMetadata(path, rel, fm.body, true), metadataFromFrontmatter(fm));
  metadata.id = metadata.id || stableId("entry", rel);
  metadata.title = metadata.title || stem(path);
  metadata.keys = normalizeList(metadata.keys);
  metadata.secondary_keys = normalizeList(metadata.secondary_keys);
  if (!Object.prototype.hasOwnProperty.call(metadata, "selective")) metadata.selective = false;
  if (!Object.prototype.hasOwnProperty.call(metadata, "always_active")) metadata.always_active = false;
  if (!Object.prototype.hasOwnProperty.call(metadata, "insertion_order"))
    metadata.insertion_order = 100;
  if (!Object.prototype.hasOwnProperty.call(metadata, "enabled")) metadata.enabled = true;
  if (!Object.prototype.hasOwnProperty.call(metadata, "mode")) metadata.mode = "normal";
  return metadata;
}

function risuFolderEntry(folderRel, parentFolderKey) {
  const folderId = stableId("folder", folderRel);
  const entry = {
    id: folderId,
    key: FOLDER_KEY_PREFIX + folderId,
    comment: basename(folderRel),
    content: "",
    mode: "folder",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false
  };
  if (parentFolderKey) {
    entry.folder = parentFolderKey;
  }
  return entry;
}

// ── Lorebook import helpers ────────────────────────────────────────────────────

function sanitizeLorebookFilename(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100);
}

function splitCommaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function lorebookFolderRel(folderKey, folderMap) {
  if (!folderKey || !folderMap.has(folderKey)) return "";
  const parts = [];
  let current = folderKey;
  const guard = new Set();
  while (current && folderMap.has(current) && !guard.has(current)) {
    guard.add(current);
    const node = folderMap.get(current);
    if (node.name) parts.unshift(node.name);
    current = node.parent || null;
  }
  return parts.join("/");
}

// ── Post-processing translated markdown ───────────────────────────────────────

function postprocessTranslatedMarkdown(text, originalText, options = {}) {
  const value = String(text || "").trim();
  if (!value) return "";

  let result;

  const split = splitYamlAndMarkdownFences(value);
  if (split) {
    result = ensureTrailingNewline(
      stripAllCodeBlocks(composeFrontmatterAndMarkdown(split.yaml, split.markdown)).trim()
    );
  } else {
    const singleFence = singleWholeFence(value);
    if (singleFence && isMarkdownFenceLanguage(singleFence.lang)) {
      result = ensureTrailingNewline(stripAllCodeBlocks(singleFence.content).trim());
    } else {
      result = ensureTrailingNewline(
        stripAllCodeBlocks(stripMarkdownFenceAfterFrontmatter(value)).trim()
      );
    }
  }

  if (originalText) {
    result = restoreFrontmatterExceptKeys(result, originalText);
  }

  const deduplicate = options.deduplicateParentheses !== false;
  return ensureTrailingNewline((deduplicate ? deduplicateKoreanParentheses(result.trim()) : result.trim()).trim());
}

function restoreFrontmatterExceptKeys(processedText, originalText) {
  const origFm = parseFrontmatter(String(originalText || ""));
  if (!origFm.exists) return processedText;

  const procFm = parseFrontmatter(processedText);

  const merged = Object.assign({}, origFm.data);
  if (procFm.exists && procFm.data.keys !== undefined) {
    merged.keys = procFm.data.keys;
  }

  const body = (procFm.exists ? procFm.body : processedText).trim();
  return body
    ? dumpFrontmatter(merged) + body + "\n"
    : `${dumpFrontmatter(merged).trimEnd()}\n`;
}

function deduplicateKoreanParentheses(text) {
  const seen = new Set();
  return text.replace(/( ?)\(([^)]*[가-힣][^)]*)\)/g, (match, space, inner) => {
    const key = `(${inner})`;
    if (seen.has(key)) return "";
    seen.add(key);
    return match;
  });
}

function splitYamlAndMarkdownFences(text) {
  const blocks = parseWholeFenceSequence(text);
  if (!blocks || blocks.length !== 2) return null;

  const [first, second] = blocks;
  if (!isYamlFenceLanguage(first.lang) || !isMarkdownFenceLanguage(second.lang)) {
    return null;
  }

  return { yaml: first.content, markdown: second.content };
}

function parseWholeFenceSequence(text) {
  const blocks = [];
  let index = 0;

  while (index < text.length) {
    const whitespace = text.slice(index).match(/^\s*/)[0].length;
    index += whitespace;
    if (index >= text.length) break;
    if (!text.startsWith("```", index)) return null;

    const openerEnd = text.indexOf("\n", index);
    if (openerEnd === -1) return null;
    const opener = text.slice(index + 3, openerEnd).trim();
    const lang = opener.split(/\s+/)[0].toLowerCase();
    const contentStart = openerEnd + 1;
    const closerMatch = text.slice(contentStart).match(/\r?\n```[ \t]*(?=\r?\n|$)/);
    if (!closerMatch || closerMatch.index === undefined) return null;

    const contentEnd = contentStart + closerMatch.index;
    const closerEnd = contentEnd + closerMatch[0].length;
    blocks.push({ lang, content: text.slice(contentStart, contentEnd) });
    index = closerEnd;
  }

  return blocks.length ? blocks : null;
}

function singleWholeFence(text) {
  const blocks = parseWholeFenceSequence(text);
  return blocks && blocks.length === 1 ? blocks[0] : null;
}

function composeFrontmatterAndMarkdown(yaml, markdown) {
  const frontmatter = normalizeYamlFrontmatter(yaml);
  const body = String(markdown || "").trim();
  return ensureTrailingNewline([frontmatter, body].filter(Boolean).join("\n\n"));
}

function normalizeYamlFrontmatter(yaml) {
  const content = String(yaml || "")
    .trim()
    .replace(/^---[ \t]*(?:\r?\n|$)/, "")
    .replace(/\r?\n---[ \t]*$/, "")
    .trim();

  if (!content) return "";
  return `---\n${content}\n---`;
}

function stripMarkdownFenceAfterFrontmatter(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return text;

  const head = match[0].trimEnd();
  const body = text.slice(match[0].length).trim();
  const bodyFence = singleWholeFence(body);
  if (!bodyFence || !isMarkdownFenceLanguage(bodyFence.lang)) {
    return text;
  }
  return [head, bodyFence.content.trim()].filter(Boolean).join("\n\n");
}

function isYamlFenceLanguage(lang) {
  return lang === "yaml" || lang === "yml";
}

function isMarkdownFenceLanguage(lang) {
  return lang === "" || lang === "markdown" || lang === "md";
}

function stripAllCodeBlocks(text) {
  let result = text;
  let prev;
  do {
    prev = result;
    result = result.replace(/```[\w+-]*\r?\n?([\s\S]*?)```/g, "$1");
  } while (result !== prev);
  return result;
}

function ensureTrailingNewline(text) {
  return `${String(text || "").replace(/\s+$/, "")}\n`;
}

// ── Project tree ──────────────────────────────────────────────────────────────

function renderProjectTree(sourceFolder, relFiles) {
  const root = basename(sourceFolder) || sourceFolder;
  const rootNode = { dirs: new Map(), files: [] };
  for (const rel of relFiles) {
    const parts = rel.split("/");
    let current = rootNode;
    for (const part of parts.slice(0, -1)) {
      if (!current.dirs.has(part)) {
        current.dirs.set(part, { dirs: new Map(), files: [] });
      }
      current = current.dirs.get(part);
    }
    current.files.push(parts[parts.length - 1]);
  }

  const lines = [`${root}/`];
  const visit = (node, depth) => {
    const indent = " ".repeat(depth * 4);
    for (const dir of Array.from(node.dirs.keys()).sort((a, b) => a.localeCompare(b))) {
      lines.push(`${indent}${dir}/`);
      visit(node.dirs.get(dir), depth + 1);
    }
    for (const file of node.files.sort((a, b) => a.localeCompare(b))) {
      lines.push(`${indent}${file}`);
    }
  };
  visit(rootNode, 1);
  return lines.join("\n");
}

// ── List / path utilities ─────────────────────────────────────────────────────

function cleanList(value) {
  return normalizeList(value).filter((item) => item.trim());
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value ? [value] : [];
  return [String(value)];
}

function normalizeVaultPath(value) {
  return normalizePath(String(value || "").replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
}

function joinVaultPath(...parts) {
  return normalizeVaultPath(
    parts.filter((part) => part !== undefined && part !== null && String(part)).join("/")
  );
}

function dirname(path) {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(path) {
  const normalized = normalizeVaultPath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function stem(path) {
  return basename(path).replace(/\.[^.]+$/, "");
}

function relativePath(path, base) {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedBase = normalizeVaultPath(base);
  if (normalizedPath === normalizedBase) return "";
  return normalizedPath.startsWith(`${normalizedBase}/`)
    ? normalizedPath.slice(normalizedBase.length + 1)
    : normalizedPath;
}

function isWithinPath(path, folder) {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedFolder = normalizeVaultPath(folder);
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

function isIgnored(relPath, patterns) {
  const rel = normalizeVaultPath(relPath);
  const name = basename(rel);
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!pattern) continue;
    if (matchesGlob(rel, pattern) || matchesGlob(name, pattern)) return true;
    if (pattern.endsWith("/")) {
      const dirName = pattern.replace(/\/+$/, "");
      if (rel === dirName || rel.startsWith(`${dirName}/`) || rel.split("/").includes(dirName)) {
        return true;
      }
    }
  }
  return false;
}

function matchesGlob(value, pattern) {
  const regex = new RegExp(`^${globToRegex(pattern)}$`);
  return regex.test(value);
}

function globToRegex(pattern) {
  let out = "";
  for (const char of pattern) {
    if (char === "*") out += ".*";
    else if (char === "?") out += ".";
    else out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return out;
}

// ── Misc utilities ────────────────────────────────────────────────────────────

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanSetting(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(id);
        reject(translationCancelledError());
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          reject(translationCancelledError());
        },
        { once: true }
      );
    }
  });
}

// ── UUID / SHA-1 ──────────────────────────────────────────────────────────────

function stableId(...parts) {
  const namespace = uuidToBytes(LOREBOOK_NAMESPACE);
  const name = utf8Bytes(parts.join("::"));
  const hash = sha1Bytes(namespace.concat(name)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return uuidFromBytes(hash);
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function uuidFromBytes(bytes) {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

function sha1Hex(bytes) {
  return sha1Bytes(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sha1Bytes(inputBytes) {
  const bytes = inputBytes.slice();
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let i = 3; i >= 0; i -= 1) bytes.push((high >>> (i * 8)) & 0xff);
  for (let i = 3; i >= 0; i -= 1) bytes.push((low >>> (i * 8)) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(80);
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      words[i] =
        ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].flatMap((word) => [
    (word >>> 24) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 8) & 0xff,
    word & 0xff
  ]);
}

function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}
