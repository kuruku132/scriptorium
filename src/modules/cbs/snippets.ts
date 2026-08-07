// CBS 스니펫 카탈로그 — 삽입 모달이 소비하는 데이터(순수 데이터, UI 아님).
// RisuAI CBS 문법 사양: docs/risuai-placeholder-syntax.md
// `insert` 의 `│` 는 커서 위치 마커. 모달이 삽입 후 캐럿을 이 위치로 옮긴다.

export type CbsCategory =
  | "조건문"
  | "루프"
  | "함수"
  | "변수·토글"
  | "출력·이스케이프"
  | "단일 플레이스홀더"
  | "수식·주석"
  | "@@ 데코레이터";

export interface CbsSnippet {
  category: CbsCategory;
  label: string;
  insert: string;
  description: string;
}

export const SNIPPET_CATALOG: CbsSnippet[] = [
  // === 조건문 ===
  {
    category: "조건문",
    label: "{{#when var::A}} … {{/when}}",
    insert: "{{#when var::A}}\n│\n{{/when}}",
    description: "채팅 변수 A 가 truthy 일 때 본문 출력. 권장 조건문."
  },
  {
    category: "조건문",
    label: "{{#when::keep var::A}} … {{/when}}",
    insert: "{{#when::keep var::A}}\n│\n{{/when}}",
    description: "공백을 보존하는 조건문(keep 모드)."
  },
  {
    category: "조건문",
    label: "{{#when A::and::B}} … {{/when}}",
    insert: "{{#when A::and::B}}\n│\n{{/when}}",
    description: "A 와 B 모두 truthy. 오른쪽→왼쪽 결합."
  },
  {
    category: "조건문",
    label: "{{#when A::or::B}} … {{/when}}",
    insert: "{{#when A::or::B}}\n│\n{{/when}}",
    description: "A 또는 B truthy. 복합 or 는 분리 권장(사양 경고)."
  },
  {
    category: "조건문",
    label: "{{#when not var::A}} … {{/when}}",
    insert: "{{#when not var::A}}\n│\n{{/when}}",
    description: "A 가 falsy 일 때 본문."
  },
  {
    category: "조건문",
    label: "{{#when toggle::T}} … {{/when}}",
    insert: "{{#when toggle::T}}\n│\n{{/when}}",
    description: "글로벌 토글 toggle_T 가 true 일 때."
  },
  {
    category: "조건문",
    label: "{{:else}}",
    insert: "{{:else}}",
    description: "#when / #each 내부 else 분기."
  },
  {
    category: "조건문",
    label: "{{#when A::is::B}} / A::isnot::B",
    insert: "{{#when A::is::B}}\n│\n{{/when}}",
    description: "A == B (is) / A != B (isnot) 문자열 비교."
  },
  {
    category: "조건문",
    label: "{{#when A::>::B}} / >= / < / <=",
    insert: "{{#when A::>::B}}\n│\n{{/when}}",
    description: "수치 비교 연산자."
  },
  {
    category: "조건문",
    label: "{{#if cond}} … {{/if}} (deprecated)",
    insert: "{{#if cond}}\n│\n{{/if}}",
    description: "레거시 조건문. #when 사용 권장."
  },

  // === 루프 ===
  {
    category: "루프",
    label: "{{#each [1,2,3] as V}} {{slot::V}} {{/}}",
    insert: "{{#each [1,2,3] as V}}\n{{slot::V}}\n{{/}}",
    description: "JSON 배열 순회. as 생략 가능."
  },
  {
    category: "루프",
    label: "{{#each::keep A as V}} … {{/}}",
    insert: "{{#each::keep A as V}}\n│\n{{/}}",
    description: "공백 보존 루프."
  },
  {
    category: "루프",
    label: "{{slot::V}}",
    insert: "{{slot::V}}",
    description: "#each 안에서 현재 요소 접근."
  },

  // === 함수 ===
  {
    category: "함수",
    label: "{{#func name args}} … {{/}}",
    insert: "{{#func name arg1}}\n│\n{{/}}",
    description: "함수 정의. 본문에서 {{arg::N}} 으로 인자 접근."
  },
  {
    category: "함수",
    label: "{{call::name::arg1}}",
    insert: "{{call::name::arg1}}",
    description: "정의한 함수 호출."
  },
  {
    category: "함수",
    label: "{{arg::N}}",
    insert: "{{arg::0}}",
    description: "함수 본문 내 N번째 호출 인자."
  },

  // === 변수·토글 ===
  {
    category: "변수·토글",
    label: "{{var::A}}",
    insert: "{{var::A}}",
    description: "채팅 변수 A 참조(#when 조건문용)."
  },
  {
    category: "변수·토글",
    label: "{{toggle::T}}",
    insert: "{{toggle::T}}",
    description: "글로벌 토글 toggle_T 참조."
  },
  {
    category: "변수·토글",
    label: "{{getvar::A}}",
    insert: "{{getvar::A}}",
    description: "채팅 변수 A 값 출력."
  },
  {
    category: "변수·토글",
    label: "{{setvar::A::value}}",
    insert: "{{setvar::A::│}}",
    description: "채팅 변수 A 에 값 저장(출력 없음)."
  },
  {
    category: "변수·토글",
    label: "{{setdefaultvar::A::value}}",
    insert: "{{setdefaultvar::A::│}}",
    description: "A 가 미정의일 때만 저장."
  },
  {
    category: "변수·토글",
    label: "{{addvar::A::1}}",
    insert: "{{addvar::A::1}}",
    description: "A 에 수치 가산."
  },
  {
    category: "변수·토글",
    label: "{{tempvar::A}} / settempvar",
    insert: "{{tempvar::A}}",
    description: "임시 변수 읽기. settempvar::A::value 로 설정."
  },
  {
    category: "변수·토글",
    label: "{{declare::A}}",
    insert: "{{declare::A}}",
    description: "변수 선언(noop 출력)."
  },
  {
    category: "변수·토글",
    label: "A::vis::B / A::visnot::B",
    insert: "A::vis::B",
    description: "채팅 변수 동등/부동등 비교."
  },
  {
    category: "변수·토글",
    label: "A::tis::B / A::tisnot::B",
    insert: "A::tis::B",
    description: "토글 동등/부동등 비교."
  },

  // === 출력·이스케이프 ===
  {
    category: "출력·이스케이프",
    label: "{{#puredisplay}} … {{/}}",
    insert: "{{#puredisplay}}│{{/}}",
    description: "내부 CBS 해석 없이 그대로 출력."
  },
  {
    category: "출력·이스케이프",
    label: "{{#code}} … {{/}}",
    insert: "{{#code}}│{{/}}",
    description: "개행/탭 제거 + 이스케이프 시퀀스 변환."
  },
  {
    category: "출력·이스케이프",
    label: "{{#escape}} … {{/}}",
    insert: "{{#escape}}│{{/}}",
    description: "중괄호/괄호 이스케이프 + trim."
  },
  {
    category: "출력·이스케이프",
    label: "{{#escape::keep}} … {{/}}",
    insert: "{{#escape::keep}}│{{/}}",
    description: "공백 보존 이스케이프."
  },
  {
    category: "출력·이스케이프",
    label: "{{br}} / {{cbr}}",
    insert: "{{br}}",
    description: "br → 실제 줄바꿈, cbr → 리터럴 \\n."
  },
  {
    category: "출력·이스케이프",
    label: "{{bo}} / {{bc}}",
    insert: "{{bo}}",
    description: "bo → {{, bc → }}."
  },
  {
    category: "출력·이스케이프",
    label: "{{decbo}} / {{decbc}}",
    insert: "{{decbo}}",
    description: "decbo → {, decbc → }."
  },
  {
    category: "출력·이스케이프",
    label: "{{debo}} / {{debc}} / {{dec}}",
    insert: "{{debo}}",
    description: "debo → (, debc → ), dec → :."
  },

  // === 단일 플레이스홀더 ===
  {
    category: "단일 플레이스홀더",
    label: "{{char}} / {{user}} / {{persona}}",
    insert: "{{char}}",
    description: "캐릭터/사용자/페르소나 메타."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{description}} / {{scenario}}",
    insert: "{{description}}",
    description: "캐릭터 설명/시나리오."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{mainprompt}} / {{globalnote}}",
    insert: "{{mainprompt}}",
    description: "시스템 프롬프트/글로벌 노트."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{history}}",
    insert: "{{history}}",
    description: "채팅 히스토리(RisuAI가 채움)."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{time}} / {{date}}",
    insert: "{{time}}",
    description: "현재 시간/날짜."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{model}} / {{maxcontext}}",
    insert: "{{model}}",
    description: "모델명/최대 컨텍스트."
  },
  {
    category: "단일 플레이스홀더",
    label: "{{messagetime}} / {{lastmessage}}",
    insert: "{{lastmessage}}",
    description: "메시지 시간/마지막 메시지."
  },

  // === 수식·주석 ===
  {
    category: "수식·주석",
    label: "{{? expression}}",
    insert: "{{? 1+2}}",
    description: "수식 평가. + - * / % ^, 비교, 괄호."
  },
  {
    category: "수식·주석",
    label: "{{// comment}}",
    insert: "{{// comment}}",
    description: "출력에서 제거되는 주석."
  },
  {
    category: "수식·주석",
    label: "{{comment::text}}",
    insert: "{{comment::│}}",
    description: "채팅에 표시되지만 모델 요청에서 제거."
  },

  // === @@ 데코레이터 ===
  {
    category: "@@ 데코레이터",
    label: "@@depth N",
    insert: "@@depth 4\n│",
    description: "삽입 깊이 지정."
  },
  {
    category: "@@ 데코레이터",
    label: "@@role system|user|assistant",
    insert: "@@role system\n│",
    description: "메시지 역할 지정."
  },
  {
    category: "@@ 데코레이터",
    label: "@@probability N",
    insert: "@@probability 50\n│",
    description: "발동 확률(0~100)."
  },
  {
    category: "@@ 데코레이터",
    label: "@@position name",
    insert: "@@position main\n│",
    description: "{{position::name}} 과 연동되는 삽입 위치."
  },
  {
    category: "@@ 데코레이터",
    label: "@@end / @@@end",
    insert: "@@end\n│",
    description: "블록 종료 표시."
  }
];