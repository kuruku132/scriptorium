// CBS 변수/토글 자동 추출기.
// 문서 본문에서 조건문·변수 참조에 쓰이는 채팅 변수(var::)와 글로벌 토글(toggle::)을
// 정규식 스윕으로 수집한다. 평가와 무관한 펜스 코드 블록은 스캔 전 제거한다.
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md

export interface CbsScanResult {
  chatVars: string[];
  toggles: string[];
}

// CBS 이름 문자: ASCII 영숫자/밑줄 + 유니코드 문자/숫자(한글 등).
const NAME = "[A-Za-z0-9_\\p{L}\\p{N}]+";
// 이름 경계: 이름 문자가 아닌 직전 위치에서만 매칭(setvar 안의 var 등 중복 방지).
const LB = "(?<![A-Za-z0-9_\\p{L}\\p{N}])";

// 단일 정규식으로 모든 참조 폼을 한 번에 스윕.
// 그룹: 1=var::, 2=toggle::, 3=getvar 계열, 4/5=vis·visnot 양변, 6/7=tis·tisnot 양변.
const REF_RE = new RegExp(
  [
    `${LB}var::(${NAME})`,
    `${LB}toggle::(${NAME})`,
    `${LB}(?:getvar|setvar|setdefaultvar|addvar|tempvar|gettempvar|settempvar|declare)::(${NAME})`,
    `${LB}(${NAME})::(?:vis|visnot)::(${NAME})`,
    `${LB}(${NAME})::(?:tis|tisnot)::(${NAME})`
  ].join("|"),
  "gu"
);

// 펜스 코드 블록(```...``` / ~~~...~~~)을 본문에서 제거.
// CBS는 펜스 바깥 본문 기준으로 처리되므로 예시 코드의 {{}} 가 노이즈가 되지 않게 한다.
function stripFencedCode(text: string): string {
  return text.replace(
    /^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?\1[ \t]*$/gm,
    ""
  );
}

function collectUnique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))].sort();
}

export function scanCbsVariables(text: string): CbsScanResult {
  if (!text) return { chatVars: [], toggles: [] };
  const stripped = stripFencedCode(text);
  const chat = new Set<string>();
  const toggles = new Set<string>();

  for (const match of stripped.matchAll(REF_RE)) {
    const g = match.slice(1);
    if (g[0] !== undefined) chat.add(g[0] as string); // var::
    else if (g[1] !== undefined) toggles.add(g[1] as string); // toggle::
    else if (g[2] !== undefined) chat.add(g[2] as string); // getvar 계열
    else if (g[3] !== undefined && g[4] !== undefined) {
      // vis / visnot → 양쪽 모두 채팅 변수
      chat.add(g[3] as string);
      chat.add(g[4] as string);
    } else if (g[5] !== undefined && g[6] !== undefined) {
      // tis / tisnot → 양쪽 모두 토글
      toggles.add(g[5] as string);
      toggles.add(g[6] as string);
    }
  }

  return { chatVars: collectUnique([...chat]), toggles: collectUnique([...toggles]) };
}