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

// getvar 계열 키워드. getglobalvar/setglobalvar은 toggle_ 접두 전역 변수를
// 토글로 매핑하므로 아래 GLOBAL_VAR_RE 에서 별도 처리하고 여기서는 제외한다.
// LB 경계가 각 키워드 앞에 붙으므로 getvar가 getglobalvar 안에 중복 매칭되지 않는다.
const VAR_FUNCS =
  "getvar|setvar|setdefaultvar|addvar|tempvar|gettempvar|settempvar|declare";

// 전역 변수 참조 키워드. toggle::NAME 은 RisuAI에서 전역 변수 toggle_NAME 으로
// 구현되므로, getglobalvar::toggle_NAME / setglobalvar::toggle_NAME 은
// 패널의 토글 NAME 참조로 취급한다.
const GLOBAL_VAR_FUNCS = "getglobalvar|setglobalvar";

// 단일 정규식으로 모든 참조 폼을 한 번에 스윕(이름 기반 그룹).
// 매칭된 가지만 해당 그룹이 정의된다.
//   var       → var::NAME (chat var)
//   toggle    → toggle::NAME (toggle)
//   gtoggle   → getglobalvar::toggle_NAME / setglobalvar::toggle_NAME (toggle NAME)
//   gvar      → getglobalvar::NAME / setglobalvar::NAME (chat var, 전역 변수명 그대로)
//   getvar    → getvar 계열 (chat var)
//   visL/visR → A::vis::B / A::visnot::B (양쪽 chat var)
//   tisL/tisR → A::tis::B / A::tisnot::B (양쪽 toggle)
const REF_RE = new RegExp(
  [
    `${LB}var::(?<var>${NAME})`,
    `${LB}toggle::(?<toggle>${NAME})`,
    `${LB}(?:${GLOBAL_VAR_FUNCS})::toggle_(?<gtoggle>${NAME})`,
    `${LB}(?:${GLOBAL_VAR_FUNCS})::(?<gvar>${NAME})`,
    `${LB}(?:${VAR_FUNCS})::(?<getvar>${NAME})`,
    `${LB}(?<visL>${NAME})::(?:vis|visnot)::(?<visR>${NAME})`,
    `${LB}(?<tisL>${NAME})::(?:tis|tisnot)::(?<tisR>${NAME})`
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
    const g = match.groups ?? {};
    if (g.var) chat.add(g.var); // var::
    else if (g.toggle) toggles.add(g.toggle); // toggle::
    else if (g.gtoggle) toggles.add(g.gtoggle); // getglobalvar::toggle_NAME → 토글 NAME
    else if (g.gvar) chat.add(g.gvar); // getglobalvar::G → 전역 변수명 그대로
    else if (g.getvar) chat.add(g.getvar); // getvar 계열
    else if (g.visL && g.visR) {
      // vis / visnot → 양쪽 모두 채팅 변수
      chat.add(g.visL);
      chat.add(g.visR);
    } else if (g.tisL && g.tisR) {
      // tis / tisnot → 양쪽 모두 토글
      toggles.add(g.tisL);
      toggles.add(g.tisR);
    }
  }

  return { chatVars: collectUnique([...chat]), toggles: collectUnique([...toggles]) };
}