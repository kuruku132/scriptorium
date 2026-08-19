// CBS 평가기 — 파싱된 AST + 평가 컨텍스트 → 출력 문자열.
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md
// 본 평가기는 저작 시점 프리뷰용 근사이며 RisuAI 런타임을 완전히 재현하지 않는다.
import { parse, type BlockNode, type CbsNode, type PlaceholderNode } from "./parser";

export interface MockMeta {
  char: string;
  user: string;
  persona: string;
  model: string;
  now: Date;
  maxcontext: number;
}

export interface EvalContext {
  chatVars: Record<string, string>;
  toggles: Record<string, boolean>;
  mockMeta: MockMeta;
  functions: Record<string, { body: CbsNode[]; params: string[] }>;
  tempVars: Record<string, string>;
  callStack: string[][];
  loopElement: string;
  options: { stripComments: boolean; stripDecorators: boolean };
  errors: string[];
}

export interface EvalResult {
  value: string;
  errors: string[];
}

export const MAX_CALL_DEPTH = 16;
export const MAX_EACH_ITERATIONS = 1000;

// 기본 목 메타. 패널에서 사용자가 편집한 값으로 덮어쓴다.
export function defaultMockMeta(): MockMeta {
  return {
    char: "Char",
    user: "User",
    persona: "Persona",
    model: "test-model",
    now: new Date(2025, 0, 1, 12, 0, 0),
    maxcontext: 8192
  };
}

export function makeEvalContext(
  chatVars: Record<string, string>,
  toggles: Record<string, boolean>,
  mockMeta: MockMeta,
  options?: Partial<EvalContext["options"]>
): EvalContext {
  return {
    chatVars: { ...chatVars },
    toggles: { ...toggles },
    mockMeta,
    functions: {},
    tempVars: {},
    callStack: [],
    loopElement: "",
    options: {
      stripComments: options?.stripComments ?? true,
      stripDecorators: options?.stripDecorators ?? true
    },
    errors: []
  };
}

// 레거시 #if 규칙: 빈 문자열·0·-1 = falsy, 나머지 truthy.
export function isTruthy(value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && value !== -1 && !Number.isNaN(value);
  const s = value as string;
  if (s === "") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s.trim())) {
    const n = Number(s);
    return n !== 0 && n !== -1;
  }
  return true;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// === 조건문 평가 ===========================================================

type CondNode =
  | { op: "not"; operand: CondNode }
  | { op: "var"; name: string }
  | { op: "toggle"; name: string }
  | { op: "and" | "or"; left: CondNode; right: CondNode }
  | {
      op: "is" | "isnot" | "vis" | "visnot" | "tis" | "tisnot" | ">" | "<" | ">=" | "<=";
      left: CondNode;
      right: CondNode;
    }
  | { op: "lit"; value: string };

const BINOPS = new Set([
  "and",
  "or",
  "is",
  "isnot",
  "vis",
  "visnot",
  "tis",
  "tisnot",
  ">",
  "<",
  ">=",
  "<="
]);

// 조건 문자열을 토큰 분리(:: 또는 공백).
function tokenizeCondition(cond: string): string[] {
  return cond
    .split(/::|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// 오른쪽→왼쪽 결합(사양 명시) 파서.
function parseCond(tokens: string[], start: number): { node: CondNode; next: number } {
  const left = parseCondOperand(tokens, start);
  let i = left.next;
  const op = tokens[i];
  if (op !== undefined && BINOPS.has(op)) {
    i += 1;
    const right = parseCond(tokens, i); // 우결합: 우측은 전체 식
    return { node: { op, left: left.node, right: right.node } as CondNode, next: right.next };
  }
  return { node: left.node, next: i };
}

function parseCondOperand(
  tokens: string[],
  start: number
): { node: CondNode; next: number } {
  const t = tokens[start];
  if (t === "not") {
    const inner = parseCondOperand(tokens, start + 1);
    return { node: { op: "not", operand: inner.node }, next: inner.next };
  }
  if (t === "var" || t === "toggle") {
    const name = tokens[start + 1] ?? "";
    return { node: { op: t, name }, next: start + 2 };
  }
  return { node: { op: "lit", value: t ?? "" }, next: start + 1 };
}

function operandName(node: CondNode): string | null {
  if (node.op === "lit") return node.value;
  if (node.op === "var" || node.op === "toggle") return node.name;
  return null;
}

function operandValue(node: CondNode, ctx: EvalContext): string {
  if (node.op === "lit") {
    const v = node.value;
    // 알려진 토글/채팅 변수면 값, 아니면 리터럴
    if (ctx.toggles[v] !== undefined) return String(ctx.toggles[v]);
    if (ctx.chatVars[v] !== undefined) return ctx.chatVars[v];
    return v;
  }
  if (node.op === "var") return ctx.chatVars[node.name] ?? "";
  if (node.op === "toggle") return String(ctx.toggles[node.name] ?? false);
  return "";
}

function toNumber(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function evalCondNode(node: CondNode, ctx: EvalContext): boolean {
  switch (node.op) {
    case "not":
      return !evalCondNode(node.operand, ctx);
    case "var":
      return isTruthy(ctx.chatVars[node.name] ?? "");
    case "toggle":
      return ctx.toggles[node.name] ?? false;
    case "and":
      return evalCondNode(node.left, ctx) && evalCondNode(node.right, ctx);
    case "or":
      return evalCondNode(node.left, ctx) || evalCondNode(node.right, ctx);
    case "is":
      return operandValue(node.left, ctx) === operandValue(node.right, ctx);
    case "isnot":
      return operandValue(node.left, ctx) !== operandValue(node.right, ctx);
    case "vis": {
      const l = operandName(node.left);
      const r = operandName(node.right);
      return (ctx.chatVars[l ?? ""] ?? "") === (ctx.chatVars[r ?? ""] ?? "");
    }
    case "visnot": {
      const l = operandName(node.left);
      const r = operandName(node.right);
      return (ctx.chatVars[l ?? ""] ?? "") !== (ctx.chatVars[r ?? ""] ?? "");
    }
    case "tis": {
      const l = operandName(node.left);
      const r = operandName(node.right);
      return (ctx.toggles[l ?? ""] ?? false) === (ctx.toggles[r ?? ""] ?? false);
    }
    case "tisnot": {
      const l = operandName(node.left);
      const r = operandName(node.right);
      return (ctx.toggles[l ?? ""] ?? false) !== (ctx.toggles[r ?? ""] ?? false);
    }
    case ">":
      return toNumber(operandValue(node.left, ctx)) > toNumber(operandValue(node.right, ctx));
    case "<":
      return toNumber(operandValue(node.left, ctx)) < toNumber(operandValue(node.right, ctx));
    case ">=":
      return toNumber(operandValue(node.left, ctx)) >= toNumber(operandValue(node.right, ctx));
    case "<=":
      return toNumber(operandValue(node.left, ctx)) <= toNumber(operandValue(node.right, ctx));
    case "lit": {
      const v = node.value;
      if (ctx.toggles[v] !== undefined) return ctx.toggles[v];
      if (ctx.chatVars[v] !== undefined) return isTruthy(ctx.chatVars[v]);
      return isTruthy(v);
    }
    default:
      return false;
  }
}

function evalCondition(cond: string, ctx: EvalContext): boolean {
  const tokens = tokenizeCondition(cond);
  if (tokens.length === 0) return false;
  // or/and 혼합 시 RisuAI와 평가 순서가 다를 수 있음 경고
  if (tokens.includes("or") && tokens.includes("and")) {
    ctx.errors.push("or·and 혼합 조건은 RisuAI와 평가 순서가 다를 수 있습니다");
  }
  const { node } = parseCond(tokens, 0);
  return evalCondNode(node, ctx);
}

// === 수식 평가 ============================================================

// 수식 내의 중첩 {{...}} 플레이스홀더를 값으로 치환한 뒤 안전하게 수식 파싱.
function resolveInline(expr: string, ctx: EvalContext): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    if (expr.charAt(i) === "{" && expr.charAt(i + 1) === "{") {
      const end = expr.indexOf("}}", i + 2);
      if (end < 0) {
        out += expr.slice(i);
        break;
      }
      const inner = expr.slice(i + 2, end).trim();
      out += evalPlaceholderName(inner, ctx);
      i = end + 2;
    } else {
      out += expr.charAt(i);
      i += 1;
    }
  }
  return out;
}

function mathEval(expr: string, ctx: EvalContext): string {
  const resolved = resolveInline(expr, ctx);
  try {
    const tokens = tokenizeMath(resolved);
    const { value, pos } = parseMath(tokens, 0);
    if (pos !== tokens.length) {
      ctx.errors.push(`수식 파싱 잔여: ${resolved}`);
      return resolved;
    }
    return value;
  } catch (error) {
    ctx.errors.push(error instanceof Error ? error.message : String(error));
    return resolved;
  }
}

interface MathToken {
  type: "num" | "op" | "lparen" | "rparen";
  value: string;
}

function tokenizeMath(s: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", value: c });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: c });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (i < s.length && /[0-9.]/.test(s.charAt(i))) {
        num += s.charAt(i);
        i += 1;
      }
      tokens.push({ type: "num", value: num });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%^<>".includes(c)) {
      tokens.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    throw new Error(`수식에 허용되지 않은 문자: ${c}`);
  }
  return tokens;
}

// Shunting-yard 대신 재귀 하강(우선순위: 비교 < 덧셈 < 곱셈 < 거듭제곱 < 단항).
function parseMath(tokens: MathToken[], start: number): { value: string; pos: number } {
  let { value, pos } = parseMathCompare(tokens, start);
  return { value, pos };
}

function parseMathCompare(tokens: MathToken[], start: number): { value: string; pos: number } {
  let { value: left, pos } = parseMathAdd(tokens, start);
  while (tokens[pos]?.type === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(tokens[pos]?.value ?? "")) {
    const op = tokens[pos]?.value ?? "";
    pos += 1;
    const right = parseMathAdd(tokens, pos);
    left = applyMathOp(op, left, right.value);
    pos = right.pos;
  }
  return { value: left, pos };
}

function parseMathAdd(tokens: MathToken[], start: number): { value: string; pos: number } {
  let { value: left, pos } = parseMathMul(tokens, start);
  while (tokens[pos]?.type === "op" && (tokens[pos]?.value === "+" || tokens[pos]?.value === "-")) {
    const op = tokens[pos]?.value ?? "";
    pos += 1;
    const right = parseMathMul(tokens, pos);
    left = applyMathOp(op, left, right.value);
    pos = right.pos;
  }
  return { value: left, pos };
}

function parseMathMul(tokens: MathToken[], start: number): { value: string; pos: number } {
  let { value: left, pos } = parseMathPow(tokens, start);
  while (tokens[pos]?.type === "op" && (tokens[pos]?.value === "*" || tokens[pos]?.value === "/" || tokens[pos]?.value === "%")) {
    const op = tokens[pos]?.value ?? "";
    pos += 1;
    const right = parseMathPow(tokens, pos);
    left = applyMathOp(op, left, right.value);
    pos = right.pos;
  }
  return { value: left, pos };
}

function parseMathPow(tokens: MathToken[], start: number): { value: string; pos: number } {
  let { value: left, pos } = parseMathUnary(tokens, start);
  if (tokens[pos]?.type === "op" && tokens[pos]?.value === "^") {
    pos += 1;
    const right = parseMathPow(tokens, pos); // 우결합
    left = applyMathOp("^", left, right.value);
    pos = right.pos;
  }
  return { value: left, pos };
}

function parseMathUnary(tokens: MathToken[], start: number): { value: string; pos: number } {
  if (tokens[start]?.type === "op" && tokens[start]?.value === "-") {
    const inner = parseMathUnary(tokens, start + 1);
    return { value: String(-toNumber(inner.value)), pos: inner.pos };
  }
  return parseMathPrimary(tokens, start);
}

function parseMathPrimary(tokens: MathToken[], start: number): { value: string; pos: number } {
  const t = tokens[start];
  if (!t) throw new Error("수식이 예기치 않게 끝남");
  if (t.type === "num") return { value: t.value, pos: start + 1 };
  if (t.type === "lparen") {
    const inner = parseMathCompare(tokens, start + 1);
    if (tokens[inner.pos]?.type !== "rparen") throw new Error("괄호가 닫히지 않음");
    return { value: inner.value, pos: inner.pos + 1 };
  }
  throw new Error(`수식 예기치 않은 토큰: ${t.value}`);
}

function applyMathOp(op: string, a: string, b: string): string {
  if (op === "==") return String(toNumber(a) === toNumber(b));
  if (op === "!=") return String(toNumber(a) !== toNumber(b));
  if (op === ">") return String(toNumber(a) > toNumber(b));
  if (op === "<") return String(toNumber(a) < toNumber(b));
  if (op === ">=") return String(toNumber(a) >= toNumber(b));
  if (op === "<=") return String(toNumber(a) <= toNumber(b));
  const x = toNumber(a);
  const y = toNumber(b);
  switch (op) {
    case "+": return String(x + y);
    case "-": return String(x - y);
    case "*": return String(x * y);
    case "/": return String(y === 0 ? 0 : x / y);
    case "%": return String(y === 0 ? 0 : x % y);
    case "^": return String(Math.pow(x, y));
    default: return a;
  }
}

// === 단일 플레이스홀더 =====================================================

const PLACEHOLDER_ALIASES: Record<string, string> = {
  bot: "char",
  userpersona: "persona",
  charpersona: "personality",
  charmessages: "charhistory",
  char_history: "charhistory",
  usermessages: "userhistory",
  user_history: "userhistory",
  messages: "history",
  lastcharmessage: "previouscharchat",
  lastusermessage: "previoususerchat",
  previous_chat_log: "previouschatlog",
  chat_index: "chatindex",
  firstmessageindex: "firstmsgindex",
  first_msg_index: "firstmsgindex",
  isfirstmessage: "isfirstmsg",
  lastmessageindex: "lastmessageid",
  message_time: "messagetime",
  message_date: "messagedate",
  message_unixtime_array: "messageunixtimearray",
  message_idle_duration: "messageidleduration",
  idle_duration: "idleduration",
  datetimeformat: "date",
  newline: "br",
  cnl: "cbr",
  cnewline: "cbr",
  displayescapedcurlybracketopen: "decbo",
  displayescapedcurlybracketclose: "decbc",
  doubledisplayescapedcurlybracketopen: "bo",
  doubledisplayescapedcurlybracketclose: "bc",
  ddecbo: "bo",
  ddecbc: "bc",
  debo: "debo",
  debc: "debc",
  "(": "debo",
  ")": "debc",
  deabo: "deabo",
  deabc: "deabc",
  dec: "dec",
  displayescapedcolon: "dec",
  unicode_encode: "unicodeencode",
  unicode_decode: "unicodedecode",
  array: "makearray",
  a: "makearray",
  dict: "makedict",
  d: "makedict",
  makeobject: "makedict",
  object: "makedict",
  o: "makedict",
  ele: "element",
  objectelement: "dictelement",
  dictassert: "objectassert",
  object_assert: "objectassert",
  fixnumber: "fixnum",
  not_equal: "notequal",
  greater_equal: "greaterequal",
  less_equal: "lessequal",
  xorencrypt: "xor",
  xorencode: "xor",
  xore: "xor",
  xordecode: "xordecrypt",
  xord: "xordecrypt",
  crypto: "crypt",
  caesar: "crypt",
  encrypt: "crypt",
  decrypt: "crypt",
  module_enabled: "moduleenabled",
  module_assetlist: "moduleassetlist",
  raw: "path",
  furigana: "ruby",
  latex: "tex",
  katex: "tex",
  examplemessage: "exampledialogue",
  example_dialogue: "exampledialogue",
  systemprompt: "mainprompt",
  main_prompt: "mainprompt",
  jailbreak: "jb",
  systemnote: "globalnote",
  ujb: "globalnote",
  author_note: "authornote",
  worldinfo: "lorebook",
  gettempvar: "tempvar"
};

// 미지원/패스스루 플레이스홀더: 원문을 그대로 반환(RisuAI가 채울 자리 표시).
const PASSTHROUGH_PLACEHOLDERS = new Set([
  "asset",
  "emotion",
  "audio",
  "bg",
  "bgm",
  "video",
  "video-img",
  "image",
  "img",
  "path",
  "inlay",
  "inlayed",
  "inlayeddata",
  "tex",
  "ruby",
  "codeblock",
  "emotionlist",
  "assetlist",
  "chardisplayasset",
  "button",
  "risu",
  "file",
  "hiddenkey",
  "screenwidth",
  "screenheight",
  "source",
  "history",
  "userhistory",
  "charhistory",
  "previouscharchat",
  "previoususerchat",
  "previouschatlog",
  "chatindex",
  "firstmsgindex",
  "isfirstmsg",
  "lastmessage",
  "lastmessageid",
  "trigger_id",
  "messagetime",
  "messagedate",
  "messageunixtimearray",
  "messageidleduration",
  "idleduration",
  "jbtoggled",
  "moduleenabled",
  "moduleassetlist",
  "personality",
  "description",
  "chardesc",
  "scenario",
  "exampledialogue",
  "mainprompt",
  "jb",
  "globalnote",
  "authornote",
  "lorebook",
  "hash",
  "unicodeencode",
  "unicodedecode",
  "u",
  "ue",
  "xor",
  "xordecrypt",
  "crypt",
  "iserror"
]);

function evalPlaceholderName(inner: string, ctx: EvalContext): string {
  const trimmed = inner.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return ""; // 주석
  if (trimmed.startsWith("__")) return ""; // 내부 전용
  if (trimmed.startsWith("?")) return mathEval(trimmed.slice(1).trim(), ctx);
  const parts = trimmed.split("::");
  return evalPlaceholder(parts[0] ?? "", parts.slice(1), trimmed, ctx);
}

function evalPlaceholder(
  rawName: string,
  args: string[],
  raw: string,
  ctx: EvalContext
): string {
  if (rawName === "?") return mathEval(args[0] ?? "", ctx);
  const name = PLACEHOLDER_ALIASES[rawName] ?? rawName;

  // 변수 조작
  if (name === "getvar") return ctx.chatVars[args[0] ?? ""] ?? "";
  if (name === "setvar") {
    if (args[0] !== undefined) ctx.chatVars[args[0]] = args.slice(1).join("::");
    return "";
  }
  if (name === "setdefaultvar") {
    if (args[0] !== undefined && ctx.chatVars[args[0]] === undefined) {
      ctx.chatVars[args[0]] = args.slice(1).join("::");
    }
    return "";
  }
  if (name === "addvar") {
    if (args[0] !== undefined) {
      const cur = toNumber(ctx.chatVars[args[0]] ?? "0");
      ctx.chatVars[args[0]] = String(cur + toNumber(args[1] ?? "0"));
    }
    return "";
  }
  if (name === "tempvar") return ctx.tempVars[args[0] ?? ""] ?? "";
  if (name === "settempvar") {
    if (args[0] !== undefined) ctx.tempVars[args[0]] = args.slice(1).join("::");
    return "";
  }
  if (name === "declare") return "";
  if (name === "return") return args.join("::");

  // 루프 / 함수 인자
  if (name === "slot") {
    if (args[0]) return ctx.tempVars[args[0]] ?? "";
    return ctx.loopElement;
  }
  if (name === "arg") {
    const frame = ctx.callStack[ctx.callStack.length - 1];
    const idx = toNumber(args[0] ?? "0");
    return frame ? frame[idx] ?? "" : "";
  }
  if (name === "call") return evalCall(args, ctx);

  // 캐릭터/프롬프트 메타(목 값)
  if (name === "char") return ctx.mockMeta.char;
  if (name === "user") return ctx.mockMeta.user;
  if (name === "persona") return ctx.mockMeta.persona;
  if (name === "model") return ctx.mockMeta.model;
  if (name === "role") return "assistant";
  if (name === "maxcontext") return String(ctx.mockMeta.maxcontext);

  // 시간
  const now = ctx.mockMeta.now;
  if (name === "unixtime") return String(Math.floor(now.getTime() / 1000));
  if (name === "time") return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (name === "date")
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (name === "isotime") return now.toISOString();
  if (name === "isodate") return now.toISOString().slice(0, 10);

  // 이스케이프 토큰
  if (name === "br") return "\n";
  if (name === "cbr") return "\\n";
  if (name === "bo") return "{{";
  if (name === "bc") return "}}";
  if (name === "decbo") return "{";
  if (name === "decbc") return "}";
  if (name === "debo") return "(";
  if (name === "debc") return ")";
  if (name === "deabo") return "<";
  if (name === "deabc") return ">";
  if (name === "dec") return ":";
  if (name === "displayescapedsemicolon") return ";";

  // 주석/빈 출력
  if (name === "comment") return "";
  if (name === "blank" || name === "none") return "";
  if (name === "position") return "";
  if (name === "prefillsupported" || name === "prefill_supported" || name === "prefill")
    return "true";
  if (name === "metadata") return "";
  if (name === "calc") return mathEval(args.join("::"), ctx);

  // 패스스루: 원문 그대로(RisuAI가 채울 자리)
  if (PASSTHROUGH_PLACEHOLDERS.has(name)) {
    return `{{${raw}}}`;
  }

  // 알려진 단일 연산(문자열/수학/배열 등)은 지원 범위 밖 → 원문 보존
  ctx.errors.push(`미지원 플레이스홀더: {{${raw}}}`);
  return `{{${raw}}}`;
}

function evalCall(args: string[], ctx: EvalContext): string {
  const name = args[0] ?? "";
  const fn = ctx.functions[name];
  if (!fn) {
    ctx.errors.push(`정의되지 않은 함수 호출: ${name}`);
    return "";
  }
  if (ctx.callStack.length >= MAX_CALL_DEPTH) {
    ctx.errors.push(`함수 호출 깊이 한도 초과(${name})`);
    return "";
  }
  ctx.callStack.push(args.slice(1));
  const savedLoop = ctx.loopElement;
  const value = evaluateNodes(fn.body, ctx);
  ctx.loopElement = savedLoop;
  ctx.callStack.pop();
  return value;
}

// === 블록 평가 ============================================================

function applyWhitespace(mode: "keep" | "legacy" | null | undefined, text: string): string {
  if (mode === "keep") return text;
  return text.trim();
}

function parseEachHead(head: string): { arrayExpr: string; varName: string } {
  const s = head.trim();
  const asMatch = s.match(/^(.+?)\s+as\s+(\S+)$/i);
  if (asMatch) return { arrayExpr: (asMatch[1] ?? "").trim(), varName: asMatch[2] ?? "" };
  const arrMatch = s.match(/^(\[[\s\S]*?\])\s*(\S*)$/);
  if (arrMatch) return { arrayExpr: (arrMatch[1] ?? "").trim(), varName: (arrMatch[2] ?? "").trim() };
  const twoMatch = s.match(/^(\S+)\s+(\S+)$/);
  if (twoMatch) return { arrayExpr: twoMatch[1] ?? "", varName: twoMatch[2] ?? "" };
  return { arrayExpr: s, varName: "" };
}

function resolveArray(expr: string, ctx: EvalContext): unknown {
  const trimmed = expr.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  const v = ctx.tempVars[trimmed] ?? ctx.chatVars[trimmed];
  if (v === undefined) return trimmed;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function evalBlock(node: BlockNode, ctx: EvalContext): string {
  switch (node.directive) {
    case "when":
      return evalWhen(node, ctx);
    case "each":
      return evalEach(node, ctx);
    case "func":
      return evalFunc(node, ctx);
    case "puredisplay":
      return node.rawBody ?? "";
    case "code":
      return evalCode(node);
    case "escape":
      return evalEscape(node);
    default:
      ctx.errors.push(`지원하지 않는 블록: #${node.directive}`);
      return "";
  }
}

function evalWhen(node: BlockNode, ctx: EvalContext): string {
  const cond = evalCondition(node.headArgs, ctx);
  const branch = cond ? node.body : node.elseBody;
  return applyWhitespace(node.whitespaceMode, evaluateNodes(branch, ctx));
}

function evalEach(node: BlockNode, ctx: EvalContext): string {
  const { arrayExpr, varName } = parseEachHead(node.headArgs);
  const arr = resolveArray(arrayExpr, ctx);
  if (!Array.isArray(arr)) {
    // 비배열은 본문 1회 통과
    const saved = varName ? ctx.tempVars[varName] : undefined;
    const savedLoop = ctx.loopElement;
    if (varName) ctx.tempVars[varName] = String(arr ?? "");
    ctx.loopElement = String(arr ?? "");
    const out = applyWhitespace(node.whitespaceMode, evaluateNodes(node.body, ctx));
    if (varName) {
      if (saved === undefined) delete ctx.tempVars[varName];
      else ctx.tempVars[varName] = saved;
    }
    ctx.loopElement = savedLoop;
    return out;
  }
  if (arr.length > MAX_EACH_ITERATIONS) {
    ctx.errors.push(`#each 반복 한도 초과(${arr.length})`);
    return "";
  }
  const savedLoop = ctx.loopElement;
  let out = "";
  for (const item of arr) {
    if (varName) ctx.tempVars[varName] = String(item);
    ctx.loopElement = String(item);
    out += applyWhitespace(node.whitespaceMode, evaluateNodes(node.body, ctx));
  }
  ctx.loopElement = savedLoop;
  return out;
}

function evalFunc(node: BlockNode, ctx: EvalContext): string {
  const parts = node.headArgs.split(/\s+/).filter(Boolean);
  const name = parts[0] ?? "";
  if (name) ctx.functions[name] = { body: node.body, params: parts.slice(1) };
  return "";
}

function evalCode(node: BlockNode): string {
  const raw = node.rawBody ?? "";
  // 개행/탭 제거 후 이스케이프 시퀀스 변환
  const collapsed = raw.replace(/[\n\t]/g, "");
  return collapsed
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\v/g, "\v")
    .replace(/\\a/g, "\x07");
}

function evalEscape(node: BlockNode): string {
  let raw = node.rawBody ?? "";
  if (node.whitespaceMode !== "keep") raw = raw.trim();
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

// === 텍스트 처리 ===========================================================

function evalText(value: string, ctx: EvalContext): string {
  let s = value;
  if (ctx.options.stripDecorators) {
    s = s.replace(/^[ \t]*@@[^\n]*\n?/gm, "");
  }
  s = s
    .replace(/<user>/g, ctx.mockMeta.user)
    .replace(/<char>/g, ctx.mockMeta.char)
    .replace(/<bot>/g, ctx.mockMeta.char);
  return s;
}

// === 최상위 평가 ===========================================================

export function evaluateNodes(nodes: CbsNode[], ctx: EvalContext): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += evalText(node.value, ctx);
    } else if (node.type === "placeholder") {
      out += evalPlaceholder(node.name, node.args, node.raw, ctx);
    } else {
      out += evalBlock(node, ctx);
    }
  }
  return out;
}

export function evaluate(source: string, ctx: EvalContext): EvalResult {
  const nodes = parse(source);
  const value = evaluateNodes(nodes, ctx);
  return { value, errors: [...ctx.errors] };
}