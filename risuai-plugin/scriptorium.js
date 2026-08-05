//@name scriptoriumsync
//@display-name 스크립토리움
//@api 3.0
//@version 2.0.0
//@update-url https://raw.githubusercontent.com/kuruku132/scriptorium/main/risuai-plugin/scriptorium.js
//@arg host string 로컬 서버 호스트 (기본값: 127.0.0.1)
//@arg port int 로컬 서버 포트 (기본값: 27124)
//@arg interval int 폴링 주기(초) (기본값: 3)
//@arg desc_entry string description으로 넣을 로어북 항목 이름 (비워두면 비활성화)
//@arg bot_projects string 봇-프로젝트 JSON 매핑 (GUI로 관리)
//@arg enabled string 동기화 활성화 (true/false, 기본값: true)
//@arg relay_url string 릴레이 주소 (설정 시 로컬 서버 대신 사용)
//@arg relay_channel string 릴레이 채널
//@arg relay_token string 릴레이 인증 토큰

(async () => {
  const SNAPSHOT_SCHEMA = 1;
  const DEBUG = false;
  const DEFAULT_PORT = 27124;
  const DEFAULT_INTERVAL = 3;
  const REQUEST_TIMEOUT_MS = 12_000;
  const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const normalizeActivationKeys = (value) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
          .join(",")
      : value;

  const withTimeout = (promise, label, timeoutMs = REQUEST_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
        () => reject(new Error(`${label} 제한 시간 초과`)),
        timeoutMs
      );
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      );
    });

  const nativeFetch = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      debug("nativeFetch.begin", {
        url,
        method: options.method || "GET",
        timeoutMs: REQUEST_TIMEOUT_MS
      });
      const response = await withTimeout(
        risuai.nativeFetch(url, {
          ...options,
          signal: controller.signal,
        }),
        `네트워크 요청: ${url}`
      );
      debug("nativeFetch.done", {
        url,
        status: response.status,
        elapsedMs: Date.now() - startedAt
      });
      return response;
    } catch (error) {
      debug("nativeFetch.error", {
        url,
        aborted: controller.signal.aborted,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt
      });
      if (controller.signal.aborted) {
        throw new Error(`네트워크 요청 제한 시간 초과: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const parseProjectMappings = (raw) => {
    let value;
    try {
      value = JSON.parse(String(raw || "{}"));
    } catch {
      return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    const mappings = {};
    for (const [bot, project] of Object.entries(value)) {
      if (!bot || !project) continue;
      if (typeof project === "string") {
        mappings[bot] = { id: project, name: project };
      } else if (
        typeof project === "object" &&
        typeof project.id === "string" &&
        project.id
      ) {
        mappings[bot] = {
          id: project.id,
          name:
            typeof project.name === "string" && project.name
              ? project.name
              : project.id,
        };
      }
    }
    return mappings;
  };

  const loadSettings = async () => {
    const [
      host,
      port,
      interval,
      descEntry,
      botProjects,
      enabled,
      relayUrl,
      relayChannel,
      relayToken,
    ] = await Promise.all([
      risuai.getArgument("host"),
      risuai.getArgument("port"),
      risuai.getArgument("interval"),
      risuai.getArgument("desc_entry"),
      risuai.getArgument("bot_projects"),
      risuai.getArgument("enabled"),
      risuai.getArgument("relay_url"),
      risuai.getArgument("relay_channel"),
      risuai.getArgument("relay_token"),
    ]);

    const parsedPort = Number.parseInt(String(port), 10);
    const parsedInterval = Number.parseInt(String(interval), 10);
    return {
      host: String(host || "").trim() || "127.0.0.1",
      port:
        Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
          ? parsedPort
          : DEFAULT_PORT,
      pollMs:
        (Number.isInteger(parsedInterval) && parsedInterval > 0
          ? parsedInterval
          : DEFAULT_INTERVAL) * 1000,
      descEntry: String(descEntry || "").trim(),
      botProjects: parseProjectMappings(botProjects),
      enabled: String(enabled || "").trim() !== "false",
      relayUrl: String(relayUrl || "").trim(),
      relayChannel: String(relayChannel || "").trim(),
      relayToken: String(relayToken || "").trim(),
    };
  };

  const endpointFor = (settings, projectId = "") => {
    if (settings.relayUrl) {
      if (!settings.relayChannel) {
        throw new Error("릴레이 채널을 입력해 주세요");
      }
      return `${settings.relayUrl.replace(/\/+$/, "")}/v1/channels/${encodeURIComponent(
        settings.relayChannel
      )}/snapshot`;
    }
    const query = projectId
      ? `?project=${encodeURIComponent(projectId)}`
      : "";
    return `http://${settings.host}:${settings.port}/v1/snapshot${query}`;
  };

  const projectsEndpointFor = (settings) =>
    settings.relayUrl
      ? ""
      : `http://${settings.host}:${settings.port}/v1/projects`;

  const manifestEndpointFor = (settings, projectId) =>
    `http://${settings.host}:${settings.port}/v1/projects/${encodeURIComponent(
      projectId
    )}/manifest`;

  const documentEndpointFor = (settings, projectId, documentId) =>
    `http://${settings.host}:${settings.port}/v1/projects/${encodeURIComponent(
      projectId
    )}/documents/${encodeURIComponent(documentId)}`;

  const responseHeader = (response, name) => {
    if (!response || !response.headers) return "";
    if (typeof response.headers.get === "function") {
      return response.headers.get(name) || "";
    }
    return (
      response.headers[name] ||
      response.headers[name.toLowerCase()] ||
      ""
    );
  };

  const validateSnapshot = (snapshot) => {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      snapshot.schema !== SNAPSHOT_SCHEMA ||
      typeof snapshot.hash !== "string"
    ) {
      throw new Error("지원하지 않는 스냅샷 형식입니다");
    }
    if (snapshot.status === "no-active-project") return snapshot;
    if (
      snapshot.status !== "ready" ||
      !snapshot.project ||
      typeof snapshot.project.id !== "string" ||
      typeof snapshot.project.name !== "string" ||
      (snapshot.mode !== "original" && snapshot.mode !== "translated") ||
      snapshot.lorebook?.type !== "risu" ||
      snapshot.lorebook?.ver !== 1 ||
      !Array.isArray(snapshot.lorebook?.data)
    ) {
      throw new Error("유효하지 않은 Risu 로어북 스냅샷입니다");
    }
    return snapshot;
  };

  let cfg = await loadSettings();
  let etag = "";
  let etagEndpoint = "";
  let isSyncing = false;
  let timerId = null;
  let pollTick = 0;
  const documentCaches = new Map();

  const state = {
    connected: false,
    skipped: false,
    skipReason: "",
    lastSyncTime: null,
    lastCheckTime: null,
    lastAttemptTime: null,
    lastSyncCount: null,
    lastMode: null,
    lastProject: null,
    currentBotName: "",
    remoteProject: null,
    availableProjects: [],
    selectedProjectId: "",
    logs: [],
  };

  let guiReady = false;
  let els = {};

  const fmt = (date) => {
    if (!date) return "—";
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds()
    )}`;
  };

  const esc = (value) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const shortId = (value) =>
    value && value.length > 18 ? `${value.slice(0, 18)}…` : value || "—";

  const renderGUI = () => {
    if (!guiReady) return;

    els.btnToggle.classList.toggle("on", cfg.enabled);
    if (!cfg.enabled) {
      els.dot.className = "dot off";
      els.statusTxt.textContent = "비활성화됨";
    } else if (!state.connected) {
      els.dot.className = "dot err";
      try {
        els.statusTxt.textContent = `연결 실패 — ${endpointFor(cfg)}`;
      } catch (error) {
        els.statusTxt.textContent =
          error instanceof Error ? error.message : String(error);
      }
    } else if (state.skipped) {
      els.dot.className = "dot skip";
      els.statusTxt.textContent = `대기 — ${state.skipReason}`;
    } else {
      els.dot.className = "dot ok";
      try {
        els.statusTxt.textContent = `연결됨 — ${endpointFor(cfg)}`;
      } catch (error) {
        els.statusTxt.textContent =
          error instanceof Error ? error.message : String(error);
      }
    }

    els.pollBadge.textContent = `${cfg.pollMs / 1000}초 폴링${
      DEBUG ? " · DEBUG" : ""
    }`;
    els.infoAttempt.textContent = fmt(state.lastAttemptTime);
    els.infoCheck.textContent = fmt(state.lastCheckTime);
    els.infoTime.textContent = fmt(state.lastSyncTime);
    els.infoCount.textContent =
      state.lastSyncCount === null ? "—" : `${state.lastSyncCount}개`;
    els.infoMode.textContent = state.lastMode || "—";
    els.infoProject.textContent = state.lastProject || "—";

    if (state.logs.length === 0) {
      els.logBox.innerHTML = '<div class="log-empty">로그 없음</div>';
    } else {
      els.logBox.innerHTML = state.logs
        .map(
          (log) => `<div class="log-row">
            <span class="log-t">${fmt(log.time)}</span>
            <span class="log-m ${esc(log.type)}">${esc(log.msg)}</span>
          </div>`
        )
        .join("");
    }

    els.botName.textContent = state.currentBotName || "—";
    els.remoteProject.textContent = state.remoteProject
      ? state.remoteProject.name
      : "감지되지 않음";

    const mapping = state.currentBotName
      ? cfg.botProjects[state.currentBotName]
      : null;
    if (mapping) {
      els.botProjectLabel.textContent = mapping.name;
      els.botProjectLabel.className = "sync-badge active";
    } else {
      els.botProjectLabel.textContent = "연결 없음";
      els.botProjectLabel.className = "sync-badge";
    }

    const selectableProjects = [...state.availableProjects];
    const knownProjects = [mapping, state.remoteProject].filter(Boolean);
    for (const project of knownProjects) {
      if (!selectableProjects.some((entry) => entry.id === project.id)) {
        selectableProjects.push(project);
      }
    }
    const previousSelection =
      state.selectedProjectId || mapping?.id || state.remoteProject?.id || "";
    els.projectSelect.innerHTML = selectableProjects.length
      ? selectableProjects
          .map(
            (project) =>
              `<option value="${esc(project.id)}">${esc(project.name)}${
                project.mode ? ` · ${esc(project.mode)}` : ""
              }</option>`
          )
          .join("")
      : '<option value="">프로젝트를 불러오지 못했습니다</option>';
    if (selectableProjects.some((project) => project.id === previousSelection)) {
      els.projectSelect.value = previousSelection;
      state.selectedProjectId = previousSelection;
    } else {
      state.selectedProjectId = els.projectSelect.value || "";
    }

    els.btnMap.disabled = !state.currentBotName || !state.selectedProjectId;
    els.btnUnmap.disabled = !state.currentBotName || !mapping;

    const mappings = Object.entries(cfg.botProjects);
    if (mappings.length === 0) {
      els.mapList.innerHTML =
        '<div class="map-empty">연결된 캐릭터 없음</div>';
    } else {
      els.mapList.innerHTML = mappings
        .map(
          ([bot, project]) => `<div class="map-item">
            <span class="map-bot" title="${esc(bot)}">${esc(bot)}</span>
            <span class="map-arrow">→</span>
            <span class="map-project" title="${esc(project.id)}">${esc(
              project.name || shortId(project.id)
            )}</span>
            <button class="map-del" data-bot="${esc(
              bot
            )}" title="연결 해제">✕</button>
          </div>`
        )
        .join("");
    }
  };

  const pushLog = (type, message) => {
    state.logs.unshift({ time: new Date(), type, msg: message });
    const limit = DEBUG ? 200 : 30;
    if (state.logs.length > limit) state.logs.length = limit;
    renderGUI();
  };

  const debug = (event, details = {}) => {
    if (!DEBUG) return;
    let detailText = "";
    try {
      detailText = Object.keys(details).length
        ? ` ${JSON.stringify(details)}`
        : "";
    } catch {
      detailText = " [details serialization failed]";
    }
    const message = `[${INSTANCE_ID}] ${event}${detailText}`;
    console.debug(
      `[Scriptorium DEBUG ${new Date().toISOString()} ${INSTANCE_ID}]`,
      event,
      details
    );
    pushLog("debug", message);
  };

  const resetRequestCache = () => {
    debug("etag.reset", { previous: etag, endpoint: etagEndpoint });
    etag = "";
    etagEndpoint = "";
  };

  const fetchProjectList = async () => {
    const endpoint = projectsEndpointFor(cfg);
    if (!endpoint) {
      debug("projects.skip", { reason: "relay-mode" });
      return;
    }
    debug("projects.request", { endpoint });
    const response = await nativeFetch(endpoint, { method: "GET" });
    debug("projects.response", { status: response.status, ok: response.ok });
    if (!response.ok) throw new Error(`프로젝트 목록 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.schema !== SNAPSHOT_SCHEMA || !Array.isArray(payload.projects)) {
      throw new Error("유효하지 않은 프로젝트 목록입니다");
    }
    state.availableProjects = payload.projects.filter(
      (project) =>
        project &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        (project.mode === "original" || project.mode === "translated")
    );
    debug("projects.parsed", {
      count: state.availableProjects.length,
      projects: state.availableProjects.map(({ id, name, mode }) => ({ id, name, mode }))
    });
  };

  const fetchSnapshot = async (force, projectId = "") => {
    const endpoint = endpointFor(cfg, projectId);
    if (etagEndpoint !== endpoint) resetRequestCache();
    const headers = {};
    // RisuAI's nativeFetch bridge cannot deserialize a 304 Response safely.
    // Relay requests therefore use ordinary 200 responses.
    if (cfg.relayUrl && cfg.relayToken) {
      headers.Authorization = `Bearer ${cfg.relayToken}`;
    }

    debug("snapshot.request", {
      endpoint,
      force,
      conditionalRequest: false
    });

    const response = await nativeFetch(endpoint, {
      method: "GET",
      headers,
    });
    debug("snapshot.response", { status: response.status, ok: response.ok });
    if (response.status === 304) {
      debug("snapshot.not-modified");
      return null;
    }
    if (!response.ok) {
      const hints = {
        401: " (릴레이 토큰을 확인해 주세요)",
        404: cfg.relayUrl
          ? " (채널에 스냅샷이 없거나 URL/채널이 잘못되었습니다)"
          : "",
      };
      throw new Error(`HTTP ${response.status}${hints[response.status] || ""}`);
    }

    const snapshot = validateSnapshot(await response.json());
    etag =
      responseHeader(response, "ETag") ||
      (snapshot.hash ? `"${snapshot.hash}"` : "");
    etagEndpoint = endpoint;
    debug("snapshot.parsed", {
      status: snapshot.status,
      hash: snapshot.hash,
      projectId: snapshot.project?.id || "",
      mode: snapshot.mode || ""
    });
    return snapshot;
  };

  const fetchDocumentSnapshot = async (projectId, force) => {
    const endpoint = manifestEndpointFor(cfg, projectId);
    const cached = documentCaches.get(endpoint);
    const knownRevision = !force ? cached?.revision || "" : "";
    const requestEndpoint = knownRevision
      ? `${endpoint}?known=${encodeURIComponent(knownRevision)}`
      : endpoint;
    debug("manifest.request", {
      endpoint: requestEndpoint,
      projectId,
      force,
      cachedRevision: cached?.revision || "",
      protocol: knownRevision ? "known-revision" : "full-manifest"
    });
    const response = await nativeFetch(requestEndpoint, { method: "GET" });
    debug("manifest.response", { status: response.status, ok: response.ok });
    if (!response.ok) throw new Error(`문서 목록 HTTP ${response.status}`);
    const manifest = await response.json();
    if (
      manifest?.schema === SNAPSHOT_SCHEMA &&
      manifest?.status === "not-modified" &&
      manifest?.project?.id === projectId &&
      manifest?.revision === cached?.revision
    ) {
      debug("manifest.not-modified", {
        projectId,
        revision: manifest.revision,
        transportStatus: response.status
      });
      return null;
    }
    if (
      manifest?.schema !== SNAPSHOT_SCHEMA ||
      manifest?.project?.id !== projectId ||
      typeof manifest.project.name !== "string" ||
      (manifest.mode !== "original" && manifest.mode !== "translated") ||
      typeof manifest.revision !== "string" ||
      !Array.isArray(manifest.documents)
    ) {
      throw new Error("유효하지 않은 문서 목록입니다");
    }

    const descriptors = manifest.documents.filter(
      (document) =>
        document &&
        typeof document.id === "string" &&
        typeof document.path === "string" &&
        typeof document.hash === "string"
    );
    if (descriptors.length !== manifest.documents.length) {
      throw new Error("문서 목록에 잘못된 항목이 있습니다");
    }

    const nextDocuments = {};
    const changed = descriptors.filter((descriptor) => {
      const previous = cached?.documents?.[descriptor.id];
      if (previous?.hash === descriptor.hash) {
        nextDocuments[descriptor.id] = previous;
        return false;
      }
      return true;
    });
    const deletedIds = Object.keys(cached?.documents || {}).filter(
      (id) => !descriptors.some((descriptor) => descriptor.id === id)
    );
    debug("manifest.diff", {
      projectId,
      revision: manifest.revision,
      total: descriptors.length,
      changed: changed.map(({ id, path, hash }) => ({ id, path, hash })),
      deletedIds
    });
    const fetched = await Promise.all(
      changed.map(async (descriptor) => {
        const documentEndpoint = documentEndpointFor(
          cfg,
          projectId,
          descriptor.id
        );
        debug("document.request", {
          projectId,
          documentId: descriptor.id,
          path: descriptor.path,
          endpoint: documentEndpoint
        });
        const documentResponse = await nativeFetch(
          documentEndpoint,
          { method: "GET" }
        );
        debug("document.response", {
          projectId,
          documentId: descriptor.id,
          path: descriptor.path,
          status: documentResponse.status,
          ok: documentResponse.ok
        });
        if (!documentResponse.ok) {
          throw new Error(
            `문서 요청 HTTP ${documentResponse.status}: ${descriptor.path}`
          );
        }
        const payload = await documentResponse.json();
        const document = payload?.document;
        if (
          payload?.schema !== SNAPSHOT_SCHEMA ||
          payload?.project?.id !== projectId ||
          document?.id !== descriptor.id ||
          document?.hash !== descriptor.hash ||
          !Array.isArray(document.entries)
        ) {
          throw new Error(`유효하지 않은 문서 응답입니다: ${descriptor.path}`);
        }
        return document;
      })
    );
    for (const document of fetched) nextDocuments[document.id] = document;

    documentCaches.set(endpoint, {
      revision: manifest.revision,
      documents: nextDocuments,
    });
    debug("manifest.cache-commit", {
      projectId,
      revision: manifest.revision,
      documentCount: Object.keys(nextDocuments).length
    });
    return {
      schema: SNAPSHOT_SCHEMA,
      status: "ready",
      project: manifest.project,
      mode: manifest.mode,
      hash: manifest.revision,
      lorebook: {
        type: "risu",
        ver: 1,
        data: descriptors.flatMap(
          (descriptor) => nextDocuments[descriptor.id]?.entries || []
        ),
      },
      changedDocuments: changed.length,
      totalDocuments: descriptors.length,
    };
  };

  const syncLorebook = async (force = false) => {
    debug("sync.invoked", { force, enabled: cfg.enabled, isSyncing });
    if (!cfg.enabled || isSyncing) {
      debug("sync.skipped", {
        force,
        reason: !cfg.enabled ? "disabled" : "already-running"
      });
      return;
    }
    isSyncing = true;
    const syncStartedAt = Date.now();
    state.lastAttemptTime = new Date();
    renderGUI();
    try {
      debug("character.read.begin");
      const char = await withTimeout(
        risuai.getCharacter(),
        "캐릭터 읽기"
      );
      debug("character.read.done", {
        found: Boolean(char),
        name: char?.name || char?.charaName || ""
      });
      if (!char) throw new Error("현재 선택된 캐릭터가 없습니다");

      const botName = String(char.name || char.charaName || "").trim();
      if (!botName) throw new Error("현재 캐릭터 이름을 알 수 없습니다");
      if (state.currentBotName && state.currentBotName !== botName) {
        resetRequestCache();
        state.selectedProjectId = cfg.botProjects[botName]?.id || "";
      }
      state.currentBotName = botName;

      if (force) await fetchProjectList();
      const mapping = cfg.botProjects[botName];
      debug("sync.mapping", {
        botName,
        mapping: mapping || null,
        selectedProjectId: state.selectedProjectId,
        relay: Boolean(cfg.relayUrl)
      });
      if (!state.selectedProjectId) {
        state.selectedProjectId = mapping?.id || "";
      }

      const requestedProjectId = mapping?.id || "";
      if (!mapping && !cfg.relayUrl) {
        state.connected = true;
        state.remoteProject = null;
        state.skipped = true;
        state.skipReason = `"${botName}"에 연결된 프로젝트가 없습니다`;
        debug("sync.waiting", { reason: "no-project-mapping", botName });
        return;
      }
      const requestEndpoint = cfg.relayUrl
        ? endpointFor(cfg)
        : manifestEndpointFor(cfg, requestedProjectId);
      const snapshot = cfg.relayUrl
        ? await fetchSnapshot(force)
        : await fetchDocumentSnapshot(requestedProjectId, force);
      const currentEndpoint = cfg.relayUrl
        ? endpointFor(cfg)
        : manifestEndpointFor(cfg, requestedProjectId);
      if (!cfg.enabled || currentEndpoint !== requestEndpoint) return;
      state.connected = true;
      state.lastCheckTime = new Date();
      debug("sync.checked", {
        endpoint: requestEndpoint,
        changed: snapshot !== null,
        elapsedMs: Date.now() - syncStartedAt
      });
      if (snapshot === null) return;

      if (snapshot.status === "no-active-project") {
        state.remoteProject = null;
        state.skipped = true;
        state.skipReason = requestedProjectId
          ? "연결된 프로젝트를 Obsidian에서 찾을 수 없습니다"
          : "Obsidian 활성 문서가 등록된 프로젝트 밖에 있습니다";
        return;
      }

      state.remoteProject = {
        id: snapshot.project.id,
        name: snapshot.project.name,
      };
      if (!mapping) {
        state.skipped = true;
        state.skipReason = `"${botName}"에 연결된 프로젝트가 없습니다`;
        return;
      }
      if (mapping.id !== snapshot.project.id) {
        state.skipped = true;
        state.skipReason = `"${snapshot.project.name}"은(는) 현재 캐릭터에 연결된 프로젝트가 아닙니다`;
        return;
      }

      let loreEntries = snapshot.lorebook.data.map((entry) => ({
        ...entry,
        key: normalizeActivationKeys(entry.key),
        secondkey: normalizeActivationKeys(entry.secondkey)
      }));
      let descriptionSet = false;
      if (cfg.descEntry) {
        const descriptionIndex = loreEntries.findIndex(
          (entry) => entry && entry.comment === cfg.descEntry
        );
        if (descriptionIndex !== -1) {
          char.desc = loreEntries[descriptionIndex].content;
          loreEntries.splice(descriptionIndex, 1);
          descriptionSet = true;
        }
      }

      char.globalLore = loreEntries;
      debug("character.write.begin", {
        botName,
        projectId: snapshot.project.id,
        mode: snapshot.mode,
        loreEntryCount: loreEntries.length,
        descriptionSet
      });
      await withTimeout(risuai.setCharacter(char), "캐릭터 저장");
      debug("character.write.done", {
        botName,
        elapsedMs: Date.now() - syncStartedAt
      });

      state.skipped = false;
      state.skipReason = "";
      state.lastSyncTime = new Date();
      state.lastSyncCount = loreEntries.length;
      state.lastMode = snapshot.mode;
      state.lastProject = snapshot.project.name;
      const descriptionNote = descriptionSet
        ? ` | description: "${cfg.descEntry}"`
        : "";
      pushLog(
        "ok",
        `${loreEntries.length}개 | ${snapshot.mode} | ${snapshot.project.name}${
          snapshot.changedDocuments === undefined
            ? ""
            : ` | 변경 문서 ${snapshot.changedDocuments}/${snapshot.totalDocuments}`
        }${descriptionNote}`
      );
    } catch (error) {
      state.connected = false;
      debug("sync.error", {
        force,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - syncStartedAt
      });
      pushLog(
        "err",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      isSyncing = false;
      debug("sync.finally", {
        force,
        elapsedMs: Date.now() - syncStartedAt,
        nextTickExpectedMs: cfg.pollMs
      });
      renderGUI();
    }
  };

  const stopPolling = () => {
    debug("poll.stop", { timerId: timerId === null ? null : String(timerId) });
    if (timerId) clearInterval(timerId);
    timerId = null;
  };

  const startPolling = () => {
    debug("poll.start.requested", {
      enabled: cfg.enabled,
      pollMs: cfg.pollMs,
      existingTimerId: timerId === null ? null : String(timerId)
    });
    stopPolling();
    if (!cfg.enabled) {
      debug("poll.start.skipped", { reason: "disabled" });
      return;
    }
    void syncLorebook(true);
    timerId = setInterval(() => {
      pollTick += 1;
      debug("poll.tick", {
        tick: pollTick,
        timerId: timerId === null ? null : String(timerId),
        pollMs: cfg.pollMs,
        isSyncing
      });
      void syncLorebook(false);
    }, cfg.pollMs);
    debug("poll.started", {
      timerId: String(timerId),
      pollMs: cfg.pollMs
    });
  };

  const persistMappings = async () => {
    await risuai.setArgument(
      "bot_projects",
      JSON.stringify(cfg.botProjects)
    );
  };

  const syncCfgInputs = () => {
    if (!guiReady) return;
    els.cfgHost.value = cfg.host;
    els.cfgPort.value = cfg.port;
    els.cfgInterval.value = cfg.pollMs / 1000;
    els.cfgDescEntry.value = cfg.descEntry;
    els.cfgRelayUrl.value = cfg.relayUrl;
    els.cfgRelayChannel.value = cfg.relayChannel;
    els.cfgRelayToken.value = cfg.relayToken;
  };

  const buildGUI = () => {
    if (guiReady) return;
    guiReady = true;

    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0; min-height: 100%; background: rgba(0,0,0,.72);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #dde; font-size: 14px;
      }
      body { display: flex; align-items: center; justify-content: center; padding: 20px; }
      .panel {
        width: 520px; max-width: 100%; max-height: 92vh; overflow-y: auto;
        padding: 24px; border: 1px solid #1e2d4a; border-radius: 14px;
        background: #141926; box-shadow: 0 12px 48px rgba(0,0,0,.7);
      }
      .hdr, .hdr-actions, .status-bar, .bot-bar, .map-item, .btn-row {
        display: flex; align-items: center;
      }
      .hdr { justify-content: space-between; margin-bottom: 22px; }
      .hdr-title { color: #c074f9; font-size: 17px; font-weight: 700; }
      .hdr-actions { gap: 8px; }
      .hdr-close, .map-del {
        border: 1px solid #2a3550; background: none; color: #778; cursor: pointer;
      }
      .hdr-close { width: 30px; height: 30px; border-radius: 7px; }
      .hdr-close:hover, .map-del:hover { border-color: #f07080; color: #f07080; }
      .toggle-pill {
        position: relative; width: 44px; height: 24px; padding: 0;
        border: 1px solid #2a3550; border-radius: 999px; background: #0d1320; cursor: pointer;
      }
      .toggle-pill .thumb {
        position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
        border-radius: 50%; background: #667; transition: transform .15s, background .15s;
      }
      .toggle-pill.on { border-color: #337454; background: #173c2b; }
      .toggle-pill.on .thumb { transform: translateX(20px); background: #fff; }
      .sec { margin-bottom: 18px; }
      .sec-label {
        margin-bottom: 8px; color: #66728f; font-size: 11px;
        font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
      }
      .status-bar, .bot-bar {
        gap: 9px; min-height: 42px; padding: 10px 12px;
        border: 1px solid #1e2d4a; border-radius: 9px; background: #0d1320;
      }
      .dot { width: 8px; height: 8px; flex: none; border-radius: 50%; }
      .dot.ok { background: #4cde89; box-shadow: 0 0 8px #4cde8966; }
      .dot.err { background: #f07080; }
      .dot.skip { background: #eebd63; }
      .dot.off { background: #556; }
      .status-text {
        min-width: 0; flex: 1; overflow: hidden; color: #aab;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .sync-badge {
        max-width: 160px; overflow: hidden; padding: 2px 7px;
        border: 1px solid #2a3550; border-radius: 99px; color: #778;
        font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
      }
      .sync-badge.active { border-color: #2a5040; color: #4cde89; }
      .info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .card { padding: 10px 12px; border-radius: 8px; background: #0d1320; }
      .card-lbl { margin-bottom: 4px; color: #556; font-size: 10px; }
      .card-val {
        overflow: hidden; color: #bcc4da; font-size: 13px;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .log-box {
        max-height: 112px; overflow-y: auto; padding: 7px 10px;
        border-radius: 8px; background: #0d1320; font-size: 11px;
      }
      .log-row { display: flex; gap: 8px; padding: 3px 0; }
      .log-t { flex: none; color: #445; }
      .log-m { min-width: 0; overflow-wrap: anywhere; color: #778; }
      .log-m.ok { color: #69c993; }
      .log-m.err { color: #e27785; }
      .log-m.debug { color: #7eb6ff; }
      .log-empty, .map-empty { padding: 7px 0; color: #445; text-align: center; }
      .bot-bar { margin-bottom: 8px; }
      .bot-bar-lbl { color: #556; font-size: 11px; }
      .bot-bar-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
      .project-now {
        display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px;
        padding: 8px 11px; border: 1px solid #1e2d4a; border-radius: 8px;
        color: #778; font-size: 12px;
      }
      .project-now strong {
        overflow: hidden; color: #b7bed2; text-overflow: ellipsis; white-space: nowrap;
      }
      .project-picker { display: flex; gap: 8px; margin-bottom: 8px; }
      .project-picker select {
        min-width: 0; flex: 1; padding: 8px 10px; border: 1px solid #1e2d4a;
        border-radius: 7px; outline: none; background: #0d1320; color: #dde;
      }
      .project-picker .btn { flex: none; padding-inline: 12px; }
      .map-list { margin-top: 8px; }
      .map-item { gap: 7px; padding: 6px 3px; border-bottom: 1px solid #1b2235; font-size: 11px; }
      .map-bot, .map-project { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .map-bot { flex: 1; color: #aab; }
      .map-project { flex: 1; color: #7485ac; }
      .map-arrow { color: #445; }
      .map-del { flex: none; border-radius: 4px; font-size: 11px; }
      .cfg-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; }
      .cfg-grid + .cfg-full, .cfg-full + .cfg-full { margin-top: 9px; }
      .field label { display: block; margin-bottom: 4px; color: #66728f; font-size: 11px; }
      .field input {
        width: 100%; padding: 8px 10px; border: 1px solid #1e2d4a;
        border-radius: 7px; outline: none; background: #0d1320; color: #dde;
      }
      .field input:focus { border-color: #c074f9; }
      .btn-row { gap: 8px; margin-top: 10px; }
      .btn {
        flex: 1; padding: 9px; border: none; border-radius: 8px;
        cursor: pointer; color: #fff; font-weight: 600;
      }
      .btn:disabled { cursor: not-allowed; opacity: .38; }
      .btn-ghost { border: 1px solid #2a3550; background: #0d1320; color: #8892aa; }
      .btn-primary { background: #c074f9; }
      .btn-sync { background: #2a8fef; }
    `;
    document.head.appendChild(style);

    document.body.innerHTML = `
      <div class="panel">
        <div class="hdr">
          <span class="hdr-title">✒️ 스크립토리움 2.0</span>
          <div class="hdr-actions">
            <button class="toggle-pill" id="btnToggle" title="동기화 켜기/끄기"><span class="thumb"></span></button>
            <button class="hdr-close" id="btnClose" title="닫기">✕</button>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">스냅샷 연결</div>
          <div class="status-bar">
            <div class="dot err" id="dot"></div>
            <div class="status-text" id="statusTxt">확인 중…</div>
            <div class="sync-badge" id="pollBadge">—</div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">폴링 상태</div>
          <div class="info-grid">
            <div class="card"><div class="card-lbl">마지막 시도</div><div class="card-val" id="infoAttempt">—</div></div>
            <div class="card"><div class="card-lbl">마지막 확인</div><div class="card-val" id="infoCheck">—</div></div>
            <div class="card"><div class="card-lbl">마지막 반영</div><div class="card-val" id="infoTime">—</div></div>
            <div class="card"><div class="card-lbl">항목 수</div><div class="card-val" id="infoCount">—</div></div>
            <div class="card"><div class="card-lbl">모드</div><div class="card-val" id="infoMode">—</div></div>
            <div class="card"><div class="card-lbl">프로젝트</div><div class="card-val" id="infoProject">—</div></div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">캐릭터-프로젝트 연결</div>
          <div class="bot-bar">
            <span class="bot-bar-lbl">현재 캐릭터</span>
            <span class="bot-bar-name" id="botName">—</span>
            <span class="sync-badge" id="botProjectLabel">연결 없음</span>
          </div>
          <div class="project-now">
            <span>서버 스냅샷 프로젝트</span>
            <strong id="remoteProject">감지되지 않음</strong>
          </div>
          <div class="project-picker">
            <select id="projectSelect" aria-label="연결할 프로젝트"></select>
            <button class="btn btn-ghost" id="btnRefreshProjects">새로고침</button>
          </div>
          <div class="btn-row">
            <button class="btn btn-sync" id="btnMap">선택 프로젝트 연결</button>
            <button class="btn btn-ghost" id="btnUnmap">연결 해제</button>
          </div>
          <div class="map-list" id="mapList"></div>
        </div>

        <div class="sec">
          <div class="sec-label">최근 로그</div>
          <div class="log-box" id="logBox"><div class="log-empty">로그 없음</div></div>
        </div>

        <div class="sec">
          <div class="sec-label">설정</div>
          <div class="cfg-full">
            <div class="field">
              <label>릴레이 주소 (비워두면 로컬 서버)</label>
              <input id="cfgRelayUrl" type="text" placeholder="http://127.0.0.1:27125" />
            </div>
          </div>
          <div class="cfg-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="field">
              <label>릴레이 채널</label>
              <input id="cfgRelayChannel" type="text" placeholder="my-channel" />
            </div>
            <div class="field">
              <label>릴레이 토큰</label>
              <input id="cfgRelayToken" type="password" placeholder="선택 사항" />
            </div>
          </div>
          <div class="cfg-grid" style="margin-top: 9px;">
            <div class="field"><label>로컬 호스트</label><input id="cfgHost" type="text" placeholder="127.0.0.1" /></div>
            <div class="field"><label>포트</label><input id="cfgPort" type="number" min="1" max="65535" /></div>
            <div class="field"><label>폴링(초)</label><input id="cfgInterval" type="number" min="1" /></div>
          </div>
          <div class="cfg-full">
            <div class="field">
              <label>Description으로 옮길 항목 이름</label>
              <input id="cfgDescEntry" type="text" placeholder="비워두면 모든 항목을 로어북에 유지" />
            </div>
          </div>
          <div class="btn-row">
            <button class="btn btn-ghost" id="btnClose2">닫기</button>
            <button class="btn btn-sync" id="btnSync">즉시 동기화</button>
            <button class="btn btn-primary" id="btnSave">저장 & 재시작</button>
          </div>
        </div>
      </div>
    `;

    els = {
      dot: document.getElementById("dot"),
      statusTxt: document.getElementById("statusTxt"),
      pollBadge: document.getElementById("pollBadge"),
      infoAttempt: document.getElementById("infoAttempt"),
      infoCheck: document.getElementById("infoCheck"),
      infoTime: document.getElementById("infoTime"),
      infoCount: document.getElementById("infoCount"),
      infoMode: document.getElementById("infoMode"),
      infoProject: document.getElementById("infoProject"),
      botName: document.getElementById("botName"),
      botProjectLabel: document.getElementById("botProjectLabel"),
      remoteProject: document.getElementById("remoteProject"),
      projectSelect: document.getElementById("projectSelect"),
      mapList: document.getElementById("mapList"),
      logBox: document.getElementById("logBox"),
      btnToggle: document.getElementById("btnToggle"),
      btnMap: document.getElementById("btnMap"),
      btnUnmap: document.getElementById("btnUnmap"),
      cfgHost: document.getElementById("cfgHost"),
      cfgPort: document.getElementById("cfgPort"),
      cfgInterval: document.getElementById("cfgInterval"),
      cfgDescEntry: document.getElementById("cfgDescEntry"),
      cfgRelayUrl: document.getElementById("cfgRelayUrl"),
      cfgRelayChannel: document.getElementById("cfgRelayChannel"),
      cfgRelayToken: document.getElementById("cfgRelayToken"),
    };

    const close = () => {
      debug("ui.close");
      return risuai.hideContainer();
    };
    document.getElementById("btnClose").addEventListener("click", close);
    document.getElementById("btnClose2").addEventListener("click", close);

    els.btnToggle.addEventListener("click", async () => {
      cfg.enabled = !cfg.enabled;
      await risuai.setArgument("enabled", cfg.enabled ? "true" : "false");
      if (cfg.enabled) {
        pushLog("ok", "동기화를 켰습니다");
        startPolling();
      } else {
        stopPolling();
        pushLog("ok", "동기화를 껐습니다");
      }
      renderGUI();
    });

    document.getElementById("btnSync").addEventListener("click", () => {
      debug("ui.sync-now");
      resetRequestCache();
      void syncLorebook(true);
    });

    els.projectSelect.addEventListener("change", () => {
      state.selectedProjectId = els.projectSelect.value;
      debug("ui.project-selected", { projectId: state.selectedProjectId });
      renderGUI();
    });

    document
      .getElementById("btnRefreshProjects")
      .addEventListener("click", async () => {
        try {
          await fetchProjectList();
          pushLog("ok", `${state.availableProjects.length}개 프로젝트를 불러왔습니다`);
        } catch (error) {
          pushLog("err", error instanceof Error ? error.message : String(error));
        }
        renderGUI();
      });

    els.btnMap.addEventListener("click", async () => {
      if (!state.currentBotName || !state.selectedProjectId) return;
      const project = state.availableProjects.find(
        (entry) => entry.id === state.selectedProjectId
      ) ||
        (state.remoteProject?.id === state.selectedProjectId
          ? state.remoteProject
          : null);
      if (!project) return;
      cfg.botProjects[state.currentBotName] = {
        id: project.id,
        name: project.name,
      };
      await persistMappings();
      pushLog(
        "ok",
        `"${state.currentBotName}" → "${project.name}" 연결됨`
      );
      resetRequestCache();
      renderGUI();
      void syncLorebook(true);
    });

    els.btnUnmap.addEventListener("click", async () => {
      if (!state.currentBotName) return;
      delete cfg.botProjects[state.currentBotName];
      await persistMappings();
      pushLog("ok", `"${state.currentBotName}" 연결 해제됨`);
      renderGUI();
    });

    els.mapList.addEventListener("click", async (event) => {
      const button = event.target.closest(".map-del");
      if (!button) return;
      const bot = button.dataset.bot;
      if (!bot) return;
      delete cfg.botProjects[bot];
      await persistMappings();
      pushLog("ok", `"${bot}" 연결 해제됨`);
      renderGUI();
    });

    document.getElementById("btnSave").addEventListener("click", async () => {
      const newHost = els.cfgHost.value.trim() || "127.0.0.1";
      const parsedPort = Number.parseInt(els.cfgPort.value, 10);
      const parsedInterval = Number.parseInt(els.cfgInterval.value, 10);
      const newPort =
        parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;
      const newInterval =
        parsedInterval > 0 ? parsedInterval : DEFAULT_INTERVAL;

      const next = {
        host: newHost,
        port: newPort,
        pollMs: newInterval * 1000,
        descEntry: els.cfgDescEntry.value.trim(),
        relayUrl: els.cfgRelayUrl.value.trim(),
        relayChannel: els.cfgRelayChannel.value.trim(),
        relayToken: els.cfgRelayToken.value.trim(),
      };
      await Promise.all([
        risuai.setArgument("host", next.host),
        risuai.setArgument("port", next.port),
        risuai.setArgument("interval", newInterval),
        risuai.setArgument("desc_entry", next.descEntry),
        risuai.setArgument("relay_url", next.relayUrl),
        risuai.setArgument("relay_channel", next.relayChannel),
        risuai.setArgument("relay_token", next.relayToken),
      ]);
      Object.assign(cfg, next);
      resetRequestCache();
      pushLog(
        "ok",
        `설정 저장됨: ${cfg.relayUrl ? "릴레이" : "로컬"}, ${newInterval}초 폴링`
      );
      startPolling();
      syncCfgInputs();
      renderGUI();
    });

    syncCfgInputs();
    renderGUI();
  };

  await risuai.registerButton(
    {
      name: "스크립토리움",
      icon: "✒️",
      iconType: "html",
      location: "chat",
      id: "scriptorium-sync-panel",
    },
    async () => {
      const previousEndpoint = (() => {
        try {
          return endpointFor(cfg);
        } catch {
          return "";
        }
      })();
      cfg = await loadSettings();
      const nextEndpoint = (() => {
        try {
          return endpointFor(cfg);
        } catch {
          return "";
        }
      })();
      if (previousEndpoint !== nextEndpoint) resetRequestCache();

      buildGUI();
      debug("ui.open", { previousEndpoint, nextEndpoint });
      syncCfgInputs();
      renderGUI();
      startPolling();
      await risuai.showContainer("fullscreen");
    }
  );

  debug("plugin.initialized", {
    instanceId: INSTANCE_ID,
    enabled: cfg.enabled,
    pollMs: cfg.pollMs,
    relay: Boolean(cfg.relayUrl),
    mappingCount: Object.keys(cfg.botProjects).length
  });
  startPolling();

  await risuai.onUnload(() => {
    debug("plugin.unload");
    stopPolling();
  });
})();
