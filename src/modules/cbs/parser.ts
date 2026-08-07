// CBS 토크나이저 + 블록 파서.
// 원시 문서 문자열을 CbsNode AST로 변환한다. 평가는 evaluator.ts가 담당.
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md
// CBS 인자에는 # : { } 줄바꿈을 넣을 수 없으므로(사양 §5) {{ 다음 첫 }} 가 토큰 종료.

export interface TextNode {
  type: "text";
  value: string;
}
export interface PlaceholderNode {
  type: "placeholder";
  name: string;
  args: string[];
  raw: string;
}
export interface BlockNode {
  type: "block";
  directive: string; // when | each | func | puredisplay | code | escape (정규화됨)
  whitespaceMode: "keep" | "legacy" | null;
  headArgs: string;
  body: CbsNode[];
  elseBody: CbsNode[];
  // puredisplay/code/escape 는 내부 CBS를 평가하지 않고 원문을 다룬다.
  rawBody?: string;
}
export type CbsNode = TextNode | PlaceholderNode | BlockNode;

export interface RawTextToken {
  type: "text";
  value: string;
}
export interface RawTagToken {
  type: "tag";
  inner: string;
}
export type RawToken = RawTextToken | RawTagToken;

export class CbsParseError extends Error {}

// {{ ... }} 토큰과 텍스트 런으로 분리.
export function tokenize(source: string): RawToken[] {
  const tokens: RawToken[] = [];
  const length = source.length;
  let cursor = 0;
  let textStart = 0;

  while (cursor < length) {
    if (source.charAt(cursor) === "{" && source.charAt(cursor + 1) === "{") {
      if (cursor > textStart) {
        tokens.push({ type: "text", value: source.slice(textStart, cursor) });
      }
      const end = source.indexOf("}}", cursor + 2);
      if (end < 0) {
        tokens.push({ type: "text", value: source.slice(cursor) });
        return tokens;
      }
      tokens.push({ type: "tag", inner: source.slice(cursor + 2, end) });
      cursor = end + 2;
      textStart = cursor;
    } else {
      cursor += 1;
    }
  }
  if (textStart < length) {
    tokens.push({ type: "text", value: source.slice(textStart) });
  }
  return tokens;
}

type Tag =
  | { kind: "comment" }
  | { kind: "internal" }
  | { kind: "else" }
  | { kind: "close"; name: string }
  | {
      kind: "open";
      directive: string;
      whitespaceMode: "keep" | "legacy" | null;
      headArgs: string;
    }
  | { kind: "math"; expr: string }
  | { kind: "placeholder"; name: string; args: string[] };

// #if → when(legacy), #if_pure → when::keep, #pure/#pure_display → puredisplay 정규화.
function parseOpen(body: string): Tag {
  const match = body.match(/^([A-Za-z0-9_]+)/);
  let directive = match ? (match[1] as string) : "";
  let rest = match ? body.slice(directive.length) : body;
  let whitespaceMode: "keep" | "legacy" | null = null;
  // ::keep / ::legacy 모드 접두 소비
  const modeMatch = rest.match(/^::(keep|legacy)(?=\s|::|$)/);
  if (modeMatch) {
    whitespaceMode = modeMatch[1] === "keep" ? "keep" : "legacy";
    rest = rest.slice(modeMatch[0].length);
  }
  if (directive === "if") {
    directive = "when";
    if (whitespaceMode === null) whitespaceMode = "legacy";
  } else if (directive === "if_pure") {
    directive = "when";
    whitespaceMode = "keep";
  } else if (directive === "pure" || directive === "pure_display") {
    directive = "puredisplay";
  }
  return { kind: "open", directive, whitespaceMode, headArgs: rest.trim() };
}

function classifyTag(inner: string): Tag {
  const trimmed = inner.trim();
  if (!trimmed) return { kind: "placeholder", name: "", args: [] };
  if (trimmed.startsWith("//")) return { kind: "comment" };
  if (trimmed.startsWith("__")) return { kind: "internal" };
  if (trimmed === ":else" || trimmed.startsWith(":else ")) {
    return { kind: "else" };
  }
  if (trimmed.startsWith(":")) return parseOpen(trimmed.slice(1)); // :each 같은 블록 별칭
  if (trimmed.startsWith("#")) return parseOpen(trimmed.slice(1));
  if (trimmed.startsWith("/")) {
    return { kind: "close", name: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith("?")) return { kind: "math", expr: trimmed.slice(1).trim() };
  const parts = trimmed.split("::");
  return { kind: "placeholder", name: parts[0] ?? "", args: parts.slice(1) };
}

interface StackEntry {
  node: BlockNode;
  inElse: boolean;
}

// puredisplay/code/escape: 내부 CBS를 해석하지 않고 닫는 태그까지 원문을 캡처.
// 중첩 {{#...}}/{{/...}} 깊이를 세어 진짜 닫는 태그를 찾는다.
const RAW_BODY_DIRECTIVES = new Set(["puredisplay", "code", "escape"]);

function collectRawBody(
  tokens: RawToken[],
  start: number
): { raw: string; next: number } {
  let depth = 1;
  let raw = "";
  let i = start;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) break;
    if (token.type === "text") {
      raw += token.value;
      continue;
    }
    const tag = classifyTag(token.inner);
    if (tag.kind === "open") {
      depth += 1;
      raw += `{{${token.inner}}}`;
    } else if (tag.kind === "close") {
      depth -= 1;
      if (depth === 0) return { raw, next: i + 1 };
      raw += `{{${token.inner}}}`;
    } else {
      raw += `{{${token.inner}}}`;
    }
  }
  return { raw, next: i }; // 닫히지 않음: EOF까지 원문
}

// 토큰 스트림 → 중첩 AST. 닫히지 않은 블록은 EOF까지 본문으로 간주(관대 처리).
export function parse(source: string): CbsNode[] {
  const tokens = tokenize(source);
  const root: CbsNode[] = [];
  const stack: StackEntry[] = [];
  let index = 0;

  const target = (): CbsNode[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.node.elseBody : top.node.body;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token.type === "text") {
      target().push({ type: "text", value: token.value });
      index += 1;
      continue;
    }
    const tag = classifyTag(token.inner);
    switch (tag.kind) {
      case "comment":
      case "internal":
        index += 1;
        break; // 프리뷰에서 제거
      case "else": {
        const top = stack[stack.length - 1];
        if (top) top.inElse = true;
        index += 1;
        break;
      }
      case "close": {
        if (stack.length) {
          if (!tag.name) {
            stack.pop();
          } else {
            let idx = stack.length - 1;
            while (idx >= 0 && stack[idx]?.node.directive !== tag.name) idx -= 1;
            if (idx < 0) stack.pop(); // 일치 없으면 최상단 팝(관대)
            else stack.length = idx;
          }
        }
        index += 1;
        break;
      }
      case "open": {
        if (RAW_BODY_DIRECTIVES.has(tag.directive)) {
          const { raw, next } = collectRawBody(tokens, index + 1);
          target().push({
            type: "block",
            directive: tag.directive,
            whitespaceMode: tag.whitespaceMode,
            headArgs: tag.headArgs,
            body: [],
            elseBody: [],
            rawBody: raw
          });
          index = next;
          break;
        }
        const node: BlockNode = {
          type: "block",
          directive: tag.directive,
          whitespaceMode: tag.whitespaceMode,
          headArgs: tag.headArgs,
          body: [],
          elseBody: []
        };
        target().push(node);
        stack.push({ node, inElse: false });
        index += 1;
        break;
      }
      case "math": {
        target().push({
          type: "placeholder",
          name: "?",
          args: [tag.expr],
          raw: `?${tag.expr}`
        });
        index += 1;
        break;
      }
      case "placeholder": {
        target().push({
          type: "placeholder",
          name: tag.name,
          args: tag.args,
          raw: token.inner.trim()
        });
        index += 1;
        break;
      }
    }
  }
  return root;
}