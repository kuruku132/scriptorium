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

// RisuAI 조건문 진리 규칙: 평가된 상태가 "1" 또는 "true" 일 때만 참.
// parser.svelte 의 blockStartMatcher (#if/#if_pure/#when) 가
// `state === 'true' || state === '1'` 으로 판정하는 것과 일치.
// 빈 문자열·"0"·"false"·그 외 모든 값은 거짓이다(레거시 0/-1 규칙이 아님).
export function isTruthy(value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return value === "1" || value === "true";
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

// 인자/수식 내의 중첩 {{...}} 플레이스홀더를 재귀 평가해 값으로 치환.
// parse() 가 깊이 인지 토큰화를 하므로 중첩 CBS 도 정확히 치환한다.
// 텍스트 노드는 evalText 변환(<user> 등) 없이 원문 그대로 둔다(인자 리터럴 보존).
function resolveNested(arg: string, ctx: EvalContext): string {
  if (!arg || !arg.includes("{{")) return arg;
  let out = "";
  for (const node of parse(arg)) {
    if (node.type === "text") {
      out += node.value;
    } else if (node.type === "placeholder") {
      out += evalPlaceholder(node.name, node.args, node.raw, ctx);
    } else {
      out += evalBlock(node, ctx);
    }
  }
  return out;
}

function mathEval(expr: string, ctx: EvalContext): string {
  // 중첩 CBS 를 먼저 값으로 치환한 뒤 수식 평가. {{? {{getglobalvar::X}}>=1}} 같은
  // 표현식이 안쪽부터 해석되도록 한다(resolveNested 는 깊이 인지 파서 사용).
  // {{length::{{getglobalvar::tags}}}} 처럼 중첩된 CBS 도 깊이 인지 파서가
  // 정확히 치환하므로 수식 평가 시점에 리터럴 { / {{ / }} 가 남지 않는다.
  const resolved = resolveNested(expr, ctx);
  // 미해결 중첩 {{...}} 가 남아 있다면 런타임 의존 패스스루 자리(예:
  // {{previous_chat_log::...}})이다. 리터럴 { } 가 수식 평가기에 들어가
  // 평가가 꼬이는 것을 막기 위해 원문을 그대로 반환한다(RisuAI 런타임이 채울 자리).
  // Scriptorium 에서 로컬로 재현할 수 없는 값만 이 경로를 탄다.
  if (resolved.includes("{{")) {
    return `{{?${expr}}}`;
  }
  // RisuAI calcString 호환 평가. 빈 수식·빈 피연산자는 0 으로 강제되며
  // 괄호 불일치·미지원 토큰은 오류가 아닌 강제 처리된다. 따라서 유효한
  // RisuAI 수식(빈 런타임 값을 가진 경우 포함)에 대해
  // "Unexpected math token" / "Unclosed parenthesis" /
  // "수식에 허용되지 않은 문자" 오류를 내지 않는다.
  const result = calcString(resolved, ctx);
  return String(result);
}

// === RisuAI calcString 호환 포트 ==========================================
// upstream RisuAI src/ts/process/infunctions.ts 의 calcString / toRPN /
// calculateRPN / executeRPNCalculation 을 충실히 포팅. RisuAI 의 수식 문법은
// 빈 피연산자를 0 으로 끼워 넣고(=1 → 0=1, >0 → 0>0), 미지원 토큰을 조용히
// 버리며, 괄호 불일치를 오류가 아닌 강제 처리로 다룬다. Scriptorium 의 기존
// 재귀 하강 파서가 계속 RisuAI 동작에서 벗어나던 것을 원본 알고리즘으로 대체.

// RisuAI toRPN 의 연산자 집합(정규화 후 단일 문자). precedence/associativity
// 도 원본과 동일. 단일 '=' 은 동등, 단일 '&'/'|' 은 논리 AND/OR.
const RPN_OPERATORS: Record<string, { precedence: number; associativity: "Left" | "Right" }> = {
  "+": { precedence: 2, associativity: "Left" },
  "-": { precedence: 2, associativity: "Left" },
  "*": { precedence: 3, associativity: "Left" },
  "/": { precedence: 3, associativity: "Left" },
  "^": { precedence: 4, associativity: "Left" },
  "%": { precedence: 3, associativity: "Left" },
  "<": { precedence: 1, associativity: "Left" },
  ">": { precedence: 1, associativity: "Left" },
  "|": { precedence: 1, associativity: "Left" },
  "&": { precedence: 1, associativity: "Left" },
  "≤": { precedence: 1, associativity: "Left" },
  "≥": { precedence: 1, associativity: "Left" },
  "=": { precedence: 1, associativity: "Left" },
  "≠": { precedence: 1, associativity: "Left" },
  "!": { precedence: 5, associativity: "Right" }
};
const RPN_OP_KEYS = Object.keys(RPN_OPERATORS);

// RisuAI toRPN: 중위식 → RPN(shunting-yard). 핵심 호환 동작은 연산자 앞에
// 피연산자가 없으면(lastToken === '') '0' 을 끼워 넣는 것으로, 빈 런타임 값이
// 만든 "=1" / ">0" / "()=1" 같은 식을 "0=1" / "0>0" 으로 정규화한다.
// 숫자가 아닌 토큰은 아래 forEach 의 parseFloat 판정에서 outputQueue 에 들어가지
// 않고 연산자도 아니므로 조용히 무시된다(calculateRPN 과 동일).
function toRPN(expression: string): string {
  const s = expression.replace(/\s+/g, "");
  const expression2: string[] = [];
  let lastToken = "";
  for (let i = 0; i < s.length; i++) {
    const char = s.charAt(i);
    // 단항 마이너스: 식 시작·연산자·'(' 직후에는 lastToken 에 부호로 누적.
    if (char === "-" && (i === 0 || RPN_OP_KEYS.includes(s.charAt(i - 1)) || s.charAt(i - 1) === "(")) {
      lastToken += char;
    } else if (RPN_OP_KEYS.includes(char)) {
      // 빈 피연산자 자리 강제: 연산자 앞에 값이 없으면 0 을 끼워 넣는다.
      expression2.push(lastToken !== "" ? lastToken : "0");
      lastToken = "";
      expression2.push(char);
    } else {
      lastToken += char;
    }
  }
  // 식 끝에 피연산자가 없어도 0 으로 채운다(후행 연산자 보정).
  expression2.push(lastToken !== "" ? lastToken : "0");

  let outputQueue = "";
  const operatorStack: string[] = [];
  for (const token of expression2) {
    if (parseFloat(token) || token === "0") {
      outputQueue += token + " ";
    } else if (RPN_OP_KEYS.includes(token)) {
      const tokOp = RPN_OPERATORS[token]!;
      while (operatorStack.length > 0) {
        const topOp = RPN_OPERATORS[operatorStack[operatorStack.length - 1] as string]!;
        const leftAssoc = tokOp.associativity === "Left" && tokOp.precedence <= topOp.precedence;
        const rightAssoc = tokOp.associativity === "Right" && tokOp.precedence < topOp.precedence;
        if (!leftAssoc && !rightAssoc) break;
        outputQueue += (operatorStack.pop() as string) + " ";
      }
      operatorStack.push(token);
    }
    // 그 외 토큰(숫자 아닌 식별자 등)은 RisuAI 처럼 조용히 무시.
  }
  while (operatorStack.length > 0) {
    outputQueue += (operatorStack.pop() as string) + " ";
  }
  return outputQueue.trim();
}

// RisuAI calculateRPN: RPN 식을 스택으로 평가. 비교·동등·논리 연산은 1/0(또는
// JS 단축 평가의 실숫값)을 반환한다. 피연산자 부족 시 undefined 가 되어도
// RisuAI 원본과 동일하게 동작(산술 → NaN, 비교 → false → 0).
function calculateRPN(expression: string): number {
  const stack: number[] = [];
  for (const token of expression.split(" ")) {
    if (parseFloat(token) || token === "0") {
      stack.push(parseFloat(token));
    } else {
      const b = stack.pop() as number | undefined;
      const a = stack.pop() as number | undefined;
      switch (token) {
        case "+": stack.push((a as number) + (b as number)); break;
        case "-": stack.push((a as number) - (b as number)); break;
        case "*": stack.push((a as number) * (b as number)); break;
        case "/": stack.push((a as number) / (b as number)); break;
        case "^": stack.push((a as number) ** (b as number)); break;
        case "%": stack.push((a as number) % (b as number)); break;
        case "<": stack.push((a as number) < (b as number) ? 1 : 0); break;
        case ">": stack.push((a as number) > (b as number) ? 1 : 0); break;
        case "|": stack.push((a as number) || (b as number)); break;
        case "&": stack.push((a as number) && (b as number)); break;
        case "≤": stack.push((a as number) <= (b as number) ? 1 : 0); break;
        case "≥": stack.push((a as number) >= (b as number) ? 1 : 0); break;
        case "=": stack.push((a as number) === (b as number) ? 1 : 0); break;
        case "≠": stack.push((a as number) !== (b as number) ? 1 : 0); break;
        case "!": stack.push(b ? 0 : 1); break;
        default: break; // 미지원 토큰은 RisuAI 처럼 조용히 무시
      }
    }
  }
  if (stack.length === 0) return 0;
  return stack.pop() as number;
}

// RisuAI executeRPNCalculation: $/@ 변수 치환 → 다중 문자 연산자 정규화 →
// null→0 → toRPN → calculateRPN. $name 은 getChatVar, @name 은 getGlobalChatVar
// 이며 Scriptorium 패널에서는 @toggle_NAME 을 토글 NAME 에 매핑한다.
// NaN 은 "0" 으로 강제한다.
function executeRPNCalculation(text: string, ctx: EvalContext): number {
  const substituted = text
    .replace(/\$([a-zA-Z0-9_]+)/g, (_, p1: string) => {
      const v = ctx.chatVars[p1] ?? "";
      const parsed = parseFloat(v);
      return isNaN(parsed) ? "0" : parsed.toString();
    })
    .replace(/@([a-zA-Z0-9_]+)/g, (_, p1: string) => {
      const raw = p1.startsWith("toggle_")
        ? ctx.toggles[p1.slice("toggle_".length)]
          ? "1"
          : "0"
        : ctx.chatVars[p1] ?? "";
      const parsed = parseFloat(raw);
      return isNaN(parsed) ? "0" : parsed.toString();
    })
    .replace(/&&/g, "&")
    .replace(/\|\|/g, "|")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/==/g, "=")
    .replace(/!=/g, "≠")
    .replace(/null/gi, "0");
  return calculateRPN(toRPN(substituted));
}

// RisuAI calcString: 괄호를 깊이 스택으로 처리. '(' → 새 컨텍스트 push,
// ')' (깊이>1) → 팝하여 executeRPNCalculation 결과를 상위 컨텍스트에 붙인다.
// 괄호 불일치는 오류가 아니다: 여는 '(' 가 남으면 깊이별 내용을 모두 합쳐
// 평가하고, 닫는 ')' 가 최상위에 남으면 리터럴 문자로 toRPN 에서 무시된다.
// 따라서 "({{getglobalvar::missing}})=1" → "()=1" 도 0=1 처럼 정상 평가된다.
function calcString(text: string, ctx: EvalContext): number {
  const depthText: string[] = [""];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(") {
      depthText.push("");
    } else if (ch === ")" && depthText.length > 1) {
      const result = executeRPNCalculation(depthText.pop() as string, ctx);
      const top = depthText.length - 1;
      depthText[top] = (depthText[top] ?? "") + result;
    } else {
      const top = depthText.length - 1;
      depthText[top] = (depthText[top] ?? "") + ch;
    }
  }
  return executeRPNCalculation(depthText.join(""), ctx);
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

// 런타임/프롬프트 템플릿 전용 자리: RisuAI CBS 함수로 등록되지 않았지만 실제
// 프롬프트 자료에 등장하며 Scriptorium 이 로컬에서 평가할 수 없는 자리들.
// 원문을 그대로 보존하며 "미지원 플레이스홀더" 경고로 취급하지 않는다.
// (오픈스트림 cbs.ts · parser.svelte 에 CBS 함수로 등록되어 있지 않음을 확인.)
const RUNTIME_PASSTHROUGH_PLACEHOLDERS = new Set([
  "chats",
  "cache_point",
  "cachepoint"
]);

function evalPlaceholder(
  rawName: string,
  args: string[],
  raw: string,
  ctx: EvalContext
): string {
  if (rawName === "?") return mathEval(args[0] ?? "", ctx);
  const name = PLACEHOLDER_ALIASES[rawName] ?? rawName;

  // 패스스루: 원문 그대로(RisuAI가 채울 자리).
  // 런타임 의존 자리(previous_chat_log 등)는 Scriptorium에서 흉내 낼 수 없으므로
  // 중첩 CBS 평가 없이 원문을 보존해 경고/구문 오류로 취급하지 않는다.
  if (PASSTHROUGH_PLACEHOLDERS.has(name) || RUNTIME_PASSTHROUGH_PLACEHOLDERS.has(name)) {
    return `{{${raw}}}`;
  }

  // 중첩 CBS 인자 재귀 평가. {{equal::{{getvar::X}}::1}} 같은 인자가
  // 바깥 플레이스홀더 평가 전에 먼저 값으로 치환되도록 한다.
  const a = args.map((x) => resolveNested(x, ctx));

  // 변수 조작
  // getglobalvar/setglobalvar은 전역 변수 공간이지만 CBS 테스트 패널에서는
  // 로컬 채팅 변수와 같은 값 저장소를 사용한다.
  // 단, RisuAI의 toggle::NAME 은 전역 변수 toggle_NAME 으로 구현되므로
  // getglobalvar::toggle_NAME / setglobalvar::toggle_NAME 은
  // 패널의 토글 NAME 에 매핑한다.
  if (name === "getglobalvar") {
    const key = a[0] ?? "";
    if (key.startsWith("toggle_")) {
      return ctx.toggles[key.slice("toggle_".length)] ? "1" : "0";
    }
    return ctx.chatVars[key] ?? "";
  }
  if (name === "setglobalvar") {
    const key = a[0];
    if (key !== undefined) {
      if (key.startsWith("toggle_")) {
        ctx.toggles[key.slice("toggle_".length)] = isTruthy(a.slice(1).join("::"));
      } else {
        ctx.chatVars[key] = a.slice(1).join("::");
      }
    }
    return "";
  }
  if (name === "getvar") return ctx.chatVars[a[0] ?? ""] ?? "";
  if (name === "setvar") {
    if (a[0] !== undefined) ctx.chatVars[a[0]] = a.slice(1).join("::");
    return "";
  }
  if (name === "setdefaultvar") {
    if (a[0] !== undefined && ctx.chatVars[a[0]] === undefined) {
      ctx.chatVars[a[0]] = a.slice(1).join("::");
    }
    return "";
  }
  if (name === "addvar") {
    if (a[0] !== undefined) {
      const cur = toNumber(ctx.chatVars[a[0]] ?? "0");
      ctx.chatVars[a[0]] = String(cur + toNumber(a[1] ?? "0"));
    }
    return "";
  }
  if (name === "tempvar") return ctx.tempVars[a[0] ?? ""] ?? "";
  if (name === "settempvar") {
    if (a[0] !== undefined) ctx.tempVars[a[0]] = a.slice(1).join("::");
    return "";
  }
  if (name === "declare") return "";
  if (name === "return") return a.join("::");

  // 루프 / 함수 인자
  if (name === "slot") {
    if (a[0]) return ctx.tempVars[a[0]] ?? "";
    return ctx.loopElement;
  }
  if (name === "arg") {
    const frame = ctx.callStack[ctx.callStack.length - 1];
    const idx = toNumber(a[0] ?? "0");
    return frame ? frame[idx] ?? "" : "";
  }
  if (name === "call") return evalCall(a, ctx);

  // 논리 / 비교 / 문자열 검사(RisuAI cbs.ts 호환: 참="1", 거짓="0").
  // and/or/not/all/any 는 문자열 "1" 만을 참으로 취급한다.
  if (name === "equal") return (a[0] ?? "") === (a[1] ?? "") ? "1" : "0";
  if (name === "notequal") return (a[0] ?? "") !== (a[1] ?? "") ? "1" : "0";
  if (name === "greater") return Number(a[0] ?? "") > Number(a[1] ?? "") ? "1" : "0";
  if (name === "less") return Number(a[0] ?? "") < Number(a[1] ?? "") ? "1" : "0";
  if (name === "greaterequal") return Number(a[0] ?? "") >= Number(a[1] ?? "") ? "1" : "0";
  if (name === "lessequal") return Number(a[0] ?? "") <= Number(a[1] ?? "") ? "1" : "0";
  if (name === "and") return a[0] === "1" && a[1] === "1" ? "1" : "0";
  if (name === "or") return a[0] === "1" || a[1] === "1" ? "1" : "0";
  if (name === "not") return a[0] === "1" ? "0" : "1";
  if (name === "all") {
    const arr = a.length > 1 ? a : parseArrayString(a[0] ?? "");
    return arr.every((f) => String(f) === "1") ? "1" : "0";
  }
  if (name === "any") {
    const arr = a.length > 1 ? a : parseArrayString(a[0] ?? "");
    return arr.some((f) => String(f) === "1") ? "1" : "0";
  }
  if (name === "contains") {
    const haystack = a[0] ?? "";
    const needle = a[1] ?? "";
    return haystack.includes(needle) ? "1" : "0";
  }
  if (name === "startswith") {
    return (a[0] ?? "").startsWith(a[1] ?? "") ? "1" : "0";
  }
  if (name === "endswith") {
    return (a[0] ?? "").endsWith(a[1] ?? "") ? "1" : "0";
  }

  // 문자열 / 배열(RisuAI cbs.ts: trim·length·makearray)
  if (name === "trim") return (a[0] ?? "").trim();
  if (name === "length") return String((a[0] ?? "").length);
  if (name === "makearray") return JSON.stringify(a);
  if (name === "arraylength") return String(parseArrayString(a[0] ?? "").length);
  if (name === "random" || name === "pick") return evalRandom(a);

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
  if (name === "calc") return mathEval(a.join("::"), ctx);

  // 알려진 단일 연산(문자열/수학/배열 등)은 지원 범위 밖 → 원문 보존
  ctx.errors.push(`미지원 플레이스홀더: {{${raw}}}`);
  return `{{${raw}}`;
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

// RisuAI parseArray: JSON 배열 문자열을 파싱, 실패 시 빈 배열.
// cbs.ts 의 defaultCBSRegisterArg.parseArray 와 동일 동작.
function parseArrayString(s: string): unknown[] {
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// RisuAI randomPickImpl 호환. Scriptorium 은 저작 시점 프리뷰이므로
// RisuAI 의 tokenizeAccurate 모드처럼 결정적으로 첫 원소(인덱스 0)를 선택한다.
// - 인자 없음: 0~1 난수 자리 → "0"(결정적 근사)
// - 인자 1개: [..] JSON 배열이면 파싱, 아니면 : 또는 , 로 분리(\\, 이스케이프 지원)
// - 인자 2개 이상: 인자 그대로 후보
function evalRandom(args: string[]): string {
  if (args.length === 0) return "0";
  let arr: unknown[];
  if (args.length === 1) {
    const s = args[0] ?? "";
    if (s.startsWith("[") && s.endsWith("]")) {
      arr = parseArrayString(s);
    } else {
      arr = s.replace(/\\,/g, "§X").split(/:|,/g).map((x) => x.replace(/§X/g, ","));
    }
  } else {
    arr = args;
  }
  if (arr.length === 0) return "";
  const element = arr[0];
  return typeof element === "string" ? element : JSON.stringify(element) ?? "";
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

// #if/#if_pure/#when 헤더: 중첩 CBS 를 먼저 평가한 뒤 조건 판정.
// {{#if_pure {{equal::A::A}}}} → 헤더가 "1" 로 치환된 뒤 #if_pure 1 판정.
function evalWhen(node: BlockNode, ctx: EvalContext): string {
  const resolvedHead = resolveNested(node.headArgs, ctx);
  const cond = evalCondition(resolvedHead, ctx);
  const branch = cond ? node.body : node.elseBody;
  return applyWhitespace(node.whitespaceMode, evaluateNodes(branch, ctx));
}

// #each: 헤더 전체의 중첩 CBS 를 먼저 평가한다.
// {{#each {{array::A::B}} v}} → 헤더가 ["A","B"] v 로 치환된 뒤 배열 순회.
// 중첩 루프 변수(tempVars[varName]·loopElement)는 진입 전 값을 저장·복원한다.
function evalEach(node: BlockNode, ctx: EvalContext): string {
  const resolvedHead = resolveNested(node.headArgs, ctx);
  const { arrayExpr, varName } = parseEachHead(resolvedHead);
  const arr = resolveArray(arrayExpr, ctx);
  const savedVar = varName ? ctx.tempVars[varName] : undefined;
  const savedLoop = ctx.loopElement;
  const restore = () => {
    if (varName) {
      if (savedVar === undefined) delete ctx.tempVars[varName];
      else ctx.tempVars[varName] = savedVar;
    }
    ctx.loopElement = savedLoop;
  };
  if (!Array.isArray(arr)) {
    // 비배열은 본문 1회 통과
    if (varName) ctx.tempVars[varName] = String(arr ?? "");
    ctx.loopElement = String(arr ?? "");
    const out = applyWhitespace(node.whitespaceMode, evaluateNodes(node.body, ctx));
    restore();
    return out;
  }
  if (arr.length > MAX_EACH_ITERATIONS) {
    ctx.errors.push(`#each 반복 한도 초과(${arr.length})`);
    restore();
    return "";
  }
  let out = "";
  for (const item of arr) {
    if (varName) ctx.tempVars[varName] = String(item);
    ctx.loopElement = String(item);
    out += applyWhitespace(node.whitespaceMode, evaluateNodes(node.body, ctx));
  }
  restore();
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