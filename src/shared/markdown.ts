import type {
  BlockKind,
  MarkdownBlock,
  MarkdownFrontmatter,
  ParsedMarkdown
} from "./types";

const FENCE_RE = /^\s*(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_RE = /^\s*(?:[-+*]|\d+[.)])\s+/;
const QUOTE_RE = /^\s*>\s?/;

export function normalizeVaultPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function isPathInside(root: string, path: string): boolean {
  const normalizedRoot = normalizeVaultPath(root);
  const normalizedPath = normalizeVaultPath(path);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === ""
      ? []
      : inner.split(",").map((item) => parseScalar(item.trim()));
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/^'(.*)'$/, "$1");
}

export function parseFrontmatter(raw: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let activeListKey: string | null = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (activeListKey && listMatch) {
      const current = values[activeListKey];
      if (Array.isArray(current)) current.push(parseScalar(listMatch[1] ?? ""));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      activeListKey = null;
      continue;
    }
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue.trim() === "") {
      values[key] = [];
      activeListKey = key;
    } else {
      values[key] = parseScalar(rawValue);
      activeListKey = null;
    }
  }
  return values;
}

function splitFrontmatter(content: string): {
  frontmatter: MarkdownFrontmatter | null;
  body: string;
  bodyStartLine: number;
} {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized, bodyStartLine: 0 };
  }

  const closeIndex = normalized.indexOf("\n---", 4);
  if (closeIndex < 0) {
    return { frontmatter: null, body: normalized, bodyStartLine: 0 };
  }
  const afterClose = closeIndex + 4;
  if (
    afterClose < normalized.length &&
    normalized[afterClose] !== "\n"
  ) {
    return { frontmatter: null, body: normalized, bodyStartLine: 0 };
  }

  const raw = normalized.slice(4, closeIndex);
  const body = normalized.slice(
    normalized[afterClose] === "\n" ? afterClose + 1 : afterClose
  );
  return {
    frontmatter: { raw, values: parseFrontmatter(raw) },
    body,
    bodyStartLine: raw.split("\n").length + 2
  };
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  const hasCells = line.includes("|");
  const divider = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
    next
  );
  return hasCells && divider;
}

function makeBlock(
  kind: BlockKind,
  text: string,
  headingPath: string[],
  startLine: number,
  endLine: number,
  occurrence: number
): MarkdownBlock {
  return {
    id: `b-${stableHash(`${kind}\0${text}`)}-${occurrence}`,
    kind,
    text,
    headingPath: [...headingPath],
    startLine,
    endLine
  };
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(content);
  const lines = body.split("\n");
  const blocks: MarkdownBlock[] = [];
  const headingPath: string[] = [];
  const occurrences = new Map<string, number>();
  let index = 0;

  const push = (
    kind: BlockKind,
    start: number,
    endExclusive: number,
    path = headingPath
  ) => {
    const text = lines.slice(start, endExclusive).join("\n").trimEnd();
    if (text.trim() === "") return;
    const key = `${kind}\0${text}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    blocks.push(
      makeBlock(
        kind,
        text,
        path,
        bodyStartLine + start,
        bodyStartLine + endExclusive - 1,
        occurrence
      )
    );
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      headingPath.splice(level - 1);
      headingPath[level - 1] = heading[2] ?? "";
      push("heading", index, index + 1, headingPath);
      index += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1]?.[0] ?? "`";
      const fenceLength = fence[1]?.length ?? 3;
      let end = index + 1;
      while (end < lines.length) {
        const closing = (lines[end] ?? "").trimStart();
        if (
          closing.startsWith(marker.repeat(fenceLength)) &&
          closing.replaceAll(marker, "").trim() === ""
        ) {
          end += 1;
          break;
        }
        end += 1;
      }
      push("code", index, end);
      index = end;
      continue;
    }

    if (isTableStart(lines, index)) {
      let end = index + 2;
      while (
        end < lines.length &&
        (lines[end] ?? "").trim() !== "" &&
        (lines[end] ?? "").includes("|")
      ) {
        end += 1;
      }
      push("table", index, end);
      index = end;
      continue;
    }

    if (LIST_RE.test(line)) {
      let end = index + 1;
      while (end < lines.length) {
        const candidate = lines[end] ?? "";
        if (candidate.trim() === "") {
          const next = lines[end + 1] ?? "";
          if (LIST_RE.test(next)) {
            end += 1;
            continue;
          }
          break;
        }
        if (
          LIST_RE.test(candidate) ||
          /^\s{2,}\S/.test(candidate) ||
          /^\s*\[[ xX]\]\s+/.test(candidate)
        ) {
          end += 1;
          continue;
        }
        break;
      }
      push("list", index, end);
      index = end;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      let end = index + 1;
      while (end < lines.length) {
        const candidate = lines[end] ?? "";
        if (QUOTE_RE.test(candidate) || candidate.trim() === "") {
          end += 1;
          continue;
        }
        break;
      }
      push("quote", index, end);
      index = end;
      continue;
    }

    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end] ?? "";
      if (
        candidate.trim() === "" ||
        HEADING_RE.test(candidate) ||
        FENCE_RE.test(candidate) ||
        LIST_RE.test(candidate) ||
        QUOTE_RE.test(candidate) ||
        isTableStart(lines, end)
      ) {
        break;
      }
      end += 1;
    }
    push("paragraph", index, end);
    index = end;
  }

  return { frontmatter, body, blocks };
}

export function frontmatterString(values: Record<string, unknown>): string {
  const scalar = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  };
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(item)}`);
    } else {
      lines.push(`${key}: ${scalar(value)}`);
    }
  }
  return lines.length === 0 ? "" : `---\n${lines.join("\n")}\n---\n`;
}

export function extractKeys(
  parsed: ParsedMarkdown,
  fallback: string
): string[] {
  const raw = parsed.frontmatter?.values.keys;
  const keys = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(",").map((key) => key.trim())
      : [fallback];
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

export function renderMarkdown(
  frontmatter: MarkdownFrontmatter | null,
  blocks: Array<Pick<MarkdownBlock, "text">>
): string {
  const prefix = frontmatter ? `---\n${frontmatter.raw}\n---\n` : "";
  const body = blocks.map((block) => block.text).join("\n\n");
  return `${prefix}${body}${body === "" ? "" : "\n"}`;
}

export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  let normalizedPattern = normalizeVaultPath(pattern);
  let optionalLeadingDirectories = false;
  if (normalizedPattern.startsWith("**/")) {
    optionalLeadingDirectories = true;
    normalizedPattern = normalizedPattern.slice(3);
  }
  let regex = "^";
  if (optionalLeadingDirectories) regex += "(?:.*/)?";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index] ?? "";
    const next = normalizedPattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(normalizedPath);
}
