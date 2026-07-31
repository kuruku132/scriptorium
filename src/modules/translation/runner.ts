import type {
  ApiSettings,
  TranslationBatch,
  TranslationBatchResult,
  TranslationProgress
} from "../../shared/types";

const PROTOCOL_PROMPT = `You are part of the Scriptorium fixed translation protocol.
Return only one JSON object in this shape:
{"blocks":[{"id":"the supplied block id","text":"translated Markdown"}],"keys":["translated key"]}
Preserve every supplied block id exactly. Do not translate context fields; they are read-only context.
Do not add prose or Markdown fences outside the JSON object.`;

class StreamingUnsupportedError extends Error {}
class RequestTimeoutError extends Error {}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
  }
}

export interface TranslationRunnerOptions {
  api: ApiSettings;
  apiKey: string;
  globalPrompt: string;
  onProgress: (progress: TranslationProgress) => void;
  onBatchResult: (
    batch: TranslationBatch,
    result: TranslationBatchResult
  ) => Promise<void>;
}

function cleanJsonCandidate(content: string): string {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

export function parseTranslationResponse(
  content: string,
  expectedBlockIds: string[],
  expectKeys = false
): TranslationBatchResult {
  const value = JSON.parse(cleanJsonCandidate(content)) as {
    blocks?: unknown;
    keys?: unknown;
  };
  if (!Array.isArray(value.blocks)) {
    throw new Error("응답에 blocks 배열이 없습니다.");
  }
  const blocks = value.blocks.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { id?: unknown }).id !== "string" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      throw new Error("응답 블록의 id 또는 text 형식이 올바르지 않습니다.");
    }
    return {
      id: (item as { id: string }).id,
      text: (item as { text: string }).text
    };
  });
  const returned = new Set(blocks.map((block) => block.id));
  const missing = expectedBlockIds.filter((id) => !returned.has(id));
  if (missing.length > 0) {
    throw new Error(`응답에서 블록 ID가 누락되었습니다: ${missing.join(", ")}`);
  }
  const result: TranslationBatchResult = { blocks };
  if (Array.isArray(value.keys)) {
    result.keys = value.keys.map(String).filter(Boolean);
  }
  if (expectKeys && !result.keys) {
    throw new Error("응답에 번역된 keys 배열이 없습니다.");
  }
  return result;
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function requestRoute(api: ApiSettings): {
  url: string;
  headers: Record<string, string>;
} {
  const target = endpoint(api.baseUrl);
  const proxy = api.proxyUrl.trim();
  return {
    url: proxy || target,
    headers: proxy ? { "X-Target-URL": target } : {}
  };
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RequestTimeoutError || error instanceof TypeError) {
    return true;
  }
  return (
    error instanceof HttpError &&
    (error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500)
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestMessages(
  globalPrompt: string,
  batch: TranslationBatch
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: globalPrompt },
    { role: "system", content: PROTOCOL_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        file: batch.filePath,
        blocks: batch.blocks.map((block) => ({
          id: block.id,
          kind: block.kind,
          headingPath: block.headingPath,
          source: block.source,
          contextBefore: block.contextBefore,
          contextAfter: block.contextAfter
        })),
        keys: batch.translateKeys
      })
    }
  ];
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}

async function streamingCompletion(options: {
  api: ApiSettings;
  apiKey: string;
  messages: ReturnType<typeof requestMessages>;
  signal: AbortSignal;
  onDelta: (content: string) => void;
}): Promise<string> {
  const route = requestRoute(options.api);
  const response = await fetch(route.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...route.headers
    },
    body: JSON.stringify({
      model: options.api.model,
      messages: options.messages,
      stream: true
    }),
    signal: options.signal
  });
  if (!response.ok) {
    const error = await readError(response);
    if ([400, 404, 405, 415, 422].includes(response.status)) {
      throw new StreamingUnsupportedError(error);
    }
    throw new HttpError(
      response.status,
      `번역 API HTTP ${response.status}: ${error}`,
      retryAfterMs(response)
    );
  }
  if (!response.body) {
    throw new StreamingUnsupportedError("스트리밍 본문이 없습니다.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = event.choices?.[0]?.delta?.content ?? "";
      content += delta;
      options.onDelta(delta);
    }
    if (done) break;
  }
  return content;
}

async function regularCompletion(options: {
  api: ApiSettings;
  apiKey: string;
  messages: ReturnType<typeof requestMessages>;
  signal: AbortSignal;
}): Promise<string> {
  const route = requestRoute(options.api);
  const response = await fetch(route.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...route.headers
    },
    body: JSON.stringify({
      model: options.api.model,
      messages: options.messages,
      stream: false
    }),
    signal: options.signal
  });
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `번역 API HTTP ${response.status}: ${await readError(response)}`,
      retryAfterMs(response)
    );
  }
  const value = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = value.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("번역 API 응답에 message.content가 없습니다.");
  }
  return content;
}

async function recoverMalformed(options: {
  api: ApiSettings;
  apiKey: string;
  globalPrompt: string;
  batch: TranslationBatch;
  malformed: string;
  signal: AbortSignal;
}): Promise<string> {
  const messages = requestMessages(options.globalPrompt, options.batch);
  messages.push({
    role: "user",
    content:
      "The previous response was malformed or omitted block IDs. Return a corrected JSON object only.\nPREVIOUS RESPONSE:\n" +
      options.malformed
  });
  return regularCompletion({
    api: options.api,
    apiKey: options.apiKey,
    messages,
    signal: options.signal
  });
}

export class TranslationRunner {
  private controller: AbortController | null = null;
  private progress: TranslationProgress = {
    running: false,
    currentFile: null,
    currentChangeId: null,
    completed: 0,
    failed: 0,
    total: 0,
    streamText: "",
    message: ""
  };

  constructor(private readonly options: TranslationRunnerOptions) {}

  getProgress(): TranslationProgress {
    return { ...this.progress };
  }

  cancel(): void {
    this.controller?.abort();
  }

  private update(patch: Partial<TranslationProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.options.onProgress(this.getProgress());
  }

  private async runBatchAttempt(
    batch: TranslationBatch,
    parentSignal: AbortSignal
  ): Promise<TranslationBatchResult> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.api.requestTimeoutSeconds * 1_000);

    try {
      const messages = requestMessages(this.options.globalPrompt, batch);
      let raw: string;
      try {
        raw = await streamingCompletion({
          api: this.options.api,
          apiKey: this.options.apiKey,
          messages,
          signal: controller.signal,
          onDelta: (delta) =>
            this.update({
              streamText: this.progress.streamText + delta
            })
        });
      } catch (error) {
        if (!(error instanceof StreamingUnsupportedError)) throw error;
        this.update({ message: "스트리밍 미지원 · 일반 응답 재시도" });
        raw = await regularCompletion({
          api: this.options.api,
          apiKey: this.options.apiKey,
          messages,
          signal: controller.signal
        });
        this.update({ streamText: raw });
      }

      const expected = batch.blocks.map((block) => block.id);
      try {
        return parseTranslationResponse(
          raw,
          expected,
          batch.translateKeys.length > 0
        );
      } catch {
        const repaired = await recoverMalformed({
          api: this.options.api,
          apiKey: this.options.apiKey,
          globalPrompt: this.options.globalPrompt,
          batch,
          malformed: raw,
          signal: controller.signal
        });
        this.update({ streamText: repaired });
        return parseTranslationResponse(
          repaired,
          expected,
          batch.translateKeys.length > 0
        );
      }
    } catch (error) {
      if (timedOut && !parentSignal.aborted) {
        throw new RequestTimeoutError(
          `API 요청 시간 초과 (${this.options.api.requestTimeoutSeconds}초)`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }

  private async runBatch(
    batch: TranslationBatch,
    signal: AbortSignal
  ): Promise<TranslationBatchResult> {
    const attempts = Math.max(1, this.options.api.maxRetries);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.runBatchAttempt(batch, signal);
      } catch (error) {
        if (signal.aborted || attempt >= attempts - 1 || !isRetryable(error)) {
          throw error;
        }
        const retryAfter =
          error instanceof HttpError ? error.retryAfterMs : null;
        const exponential =
          this.options.api.initialBackoffSeconds * 1_000 * 2 ** attempt;
        const jittered = Math.round(exponential * (0.85 + Math.random() * 0.3));
        const delay = retryAfter ?? jittered;
        this.update({
          message: `일시적 오류 · ${Math.ceil(delay / 1_000)}초 후 재시도 ${attempt + 2}/${attempts}`
        });
        await wait(delay, signal);
      }
    }
    throw new Error("번역 API 재시도 횟수를 초과했습니다.");
  }

  async run(batches: TranslationBatch[]): Promise<TranslationProgress> {
    if (this.progress.running) throw new Error("번역 작업이 이미 실행 중입니다.");
    this.controller = new AbortController();
    this.progress = {
      running: true,
      currentFile: null,
      currentChangeId: null,
      completed: 0,
      failed: 0,
      total: batches.length,
      streamText: "",
      message: "번역 준비 중"
    };
    this.options.onProgress(this.getProgress());

    for (const batch of batches) {
      if (this.controller.signal.aborted) break;
      this.update({
        currentFile: batch.filePath,
        currentChangeId: batch.changeIds[0] ?? null,
        streamText: "",
        message: "번역 중"
      });
      try {
        const result = await this.runBatch(batch, this.controller.signal);
        await this.options.onBatchResult(batch, result);
        this.update({
          completed: this.progress.completed + 1,
          message: "완료"
        });
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.update({
          failed: this.progress.failed + 1,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const cancelled = this.controller.signal.aborted;
    this.controller = null;
    this.update({
      running: false,
      currentFile: null,
      currentChangeId: null,
      message: cancelled ? "취소됨" : "작업 완료"
    });
    return this.getProgress();
  }
}
