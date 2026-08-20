import { describe, expect, it } from "vitest";
import {
  defaultMockMeta,
  evaluate,
  makeEvalContext,
  MAX_CALL_DEPTH,
  type EvalContext
} from "../src/modules/cbs/evaluator";

function ctx(
  chatVars: Record<string, string> = {},
  toggles: Record<string, boolean> = {}
): EvalContext {
  return makeEvalContext(chatVars, toggles, defaultMockMeta());
}

function ev(source: string, c: EvalContext = ctx()): string {
  return evaluate(source, c).value;
}

describe("evaluate — conditions (#when)", () => {
  it("renders body when var is truthy", () => {
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "1" }))).toBe("Y");
  });

  it("renders else when var is falsy", () => {
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "" }))).toBe("N");
  });

  it("uses upstream strict truthiness (only 1/true render)", () => {
    // RisuAI parser.svelte blockStartMatcher: state === '1' || state === 'true' 만 참.
    // 빈 문자열·0·-1·2·false 모두 렌더하지 않는다(레거시 0/-1 규칙이 아님).
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "1" }))).toBe("Y");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "true" }))).toBe("Y");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "0" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "-1" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "2" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "false" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "" }))).toBe("N");
  });

  it("renders else branch when no else given and falsy", () => {
    expect(ev("{{#when var::A}}Y{{/when}}", ctx({ A: "" }))).toBe("");
  });

  it("supports space-separated condition form", () => {
    expect(ev("{{#when 1}}Y{{:else}}N{{/when}}")).toBe("Y");
    expect(ev("{{#when 0}}Y{{:else}}N{{/when}}")).toBe("N");
  });
});

describe("evaluate — #when operators", () => {
  it("not", () => {
    expect(ev("{{#when not var::A}}Y{{:else}}N{{/when}}", ctx({ A: "" }))).toBe("Y");
    expect(ev("{{#when not var::A}}Y{{:else}}N{{/when}}", ctx({ A: "1" }))).toBe("N");
  });

  it("and / or", () => {
    expect(ev("{{#when A::and::B}}Y{{:else}}N{{/when}}", ctx({ A: "1", B: "1" }))).toBe("Y");
    expect(ev("{{#when A::and::B}}Y{{:else}}N{{/when}}", ctx({ A: "1", B: "" }))).toBe("N");
    expect(ev("{{#when A::or::B}}Y{{:else}}N{{/when}}", ctx({ A: "", B: "1" }))).toBe("Y");
    expect(ev("{{#when A::or::B}}Y{{:else}}N{{/when}}", ctx({ A: "", B: "" }))).toBe("N");
  });

  it("is / isnot", () => {
    expect(ev("{{#when A::is::B}}Y{{:else}}N{{/when}}", ctx({ A: "x", B: "x" }))).toBe("Y");
    expect(ev("{{#when A::is::B}}Y{{:else}}N{{/when}}", ctx({ A: "x", B: "y" }))).toBe("N");
    expect(ev("{{#when A::isnot::B}}Y{{:else}}N{{/when}}", ctx({ A: "x", B: "y" }))).toBe("Y");
  });

  it("numeric comparisons > < >= <=", () => {
    expect(ev("{{#when A::>::B}}Y{{:else}}N{{/when}}", ctx({ A: "5", B: "3" }))).toBe("Y");
    expect(ev("{{#when A::<::B}}Y{{:else}}N{{/when}}", ctx({ A: "5", B: "3" }))).toBe("N");
    expect(ev("{{#when A::>=::B}}Y{{:else}}N{{/when}}", ctx({ A: "3", B: "3" }))).toBe("Y");
    expect(ev("{{#when A::<=::B}}Y{{:else}}N{{/when}}", ctx({ A: "3", B: "3" }))).toBe("Y");
  });

  it("toggle:: truthiness", () => {
    expect(ev("{{#when toggle::T}}Y{{:else}}N{{/when}}", ctx({}, { T: true }))).toBe("Y");
    expect(ev("{{#when toggle::T}}Y{{:else}}N{{/when}}", ctx({}, { T: false }))).toBe("N");
  });

  it("vis / visnot (chat var equality)", () => {
    expect(ev("{{#when A::vis::B}}Y{{:else}}N{{/when}}", ctx({ A: "x", B: "x" }))).toBe("Y");
    expect(ev("{{#when A::visnot::B}}Y{{:else}}N{{/when}}", ctx({ A: "x", B: "y" }))).toBe("Y");
  });

  it("tis / tisnot (toggle equality)", () => {
    expect(ev("{{#when A::tis::B}}Y{{:else}}N{{/when}}", ctx({}, { A: true, B: true }))).toBe("Y");
    expect(ev("{{#when A::tisnot::B}}Y{{:else}}N{{/when}}", ctx({}, { A: true, B: false }))).toBe("Y");
  });

  it("keep mode preserves body whitespace", () => {
    const out = ev("{{#when::keep var::A}}  Y  {{/when}}", ctx({ A: "1" }));
    expect(out).toBe("  Y  ");
  });

  it("legacy mode trims body", () => {
    const out = ev("{{#when var::A}}  Y  {{/when}}", ctx({ A: "1" }));
    expect(out).toBe("Y");
  });
});

describe("evaluate — #each loop", () => {
  it("iterates a JSON array literal with var name", () => {
    expect(ev("{{#each [1,2,3] n}}{{slot::n}}{{/}}")).toBe("123");
  });

  it("iterates with as keyword", () => {
    expect(ev('{{#each ["a","b","c"] as V}}{{slot::V}}{{/}}')).toBe("abc");
  });

  it("passes through non-array once", () => {
    expect(ev("{{#each A n}}{{slot::n}}{{/}}", ctx({ A: "x" }))).toBe("x");
  });
});

describe("evaluate — math {{? }}", () => {
  it("addition and multiplication precedence", () => {
    expect(ev("{{? 1+2*3}}")).toBe("7");
  });

  it("parentheses", () => {
    expect(ev("{{? (1+2)*3}}")).toBe("9");
  });

  it("power right-associative", () => {
    expect(ev("{{? 2^3}}")).toBe("8");
  });

  it("comparison/logical returns 1/0 (RisuAI calcString semantics)", () => {
    // RisuAI calcString(calculateRPN) 는 비교·논리 연산을 1/0 숫자로 반환한다.
    expect(ev("{{? 2>1}}")).toBe("1");
    expect(ev("{{? 1==1}}")).toBe("1");
    expect(ev("{{? 1!=2}}")).toBe("1");
    expect(ev("{{? 1>2}}")).toBe("0");
    expect(ev("{{? 1&&1}}")).toBe("1");
    expect(ev("{{? 1&&0}}")).toBe("0");
    expect(ev("{{? 0||1}}")).toBe("1");
    expect(ev("{{? !0}}")).toBe("1");
    expect(ev("{{? !1}}")).toBe("0");
  });

  it("resolves nested CBS inside {{? }} before math evaluation", () => {
    expect(ev("{{? 1+2}}")).toBe("3");
    expect(ev("{{? {{getglobalvar::toggle_trpgmode}}>=1}}", ctx({}, { trpgmode: true }))).toBe("1");
    expect(ev("{{? {{getglobalvar::toggle_trpgmode}}>=1}}", ctx({}, { trpgmode: false }))).toBe("0");
    expect(ev("{{? {{length::hello}}>0}}")).toBe("1");
    expect(ev("{{? {{length::{{getglobalvar::tags}}}}>0}}", ctx({ tags: "" }))).toBe("0");
    expect(ev("{{? {{length::{{getglobalvar::tags}}}}>0}}", ctx({ tags: "abc" }))).toBe("1");
  });

  it("resolves $var / @var math tokens", () => {
    expect(ev("{{? $A+1}}", ctx({ A: "5" }))).toBe("6");
    expect(ev("{{? @G*2}}", ctx({ G: "3" }))).toBe("6");
  });
});

describe("evaluate — puredisplay/code/escape", () => {
  it("puredisplay outputs raw without interpreting CBS", () => {
    expect(ev("{{#puredisplay}}{{char}}{{/}}", ctx())).toBe("{{char}}");
  });

  it("code converts \\n/\\t escape sequences", () => {
    expect(ev("{{#code}}a\\nb\\tc{{/}}")).toBe("a\nb\tc");
    expect(ev("{{#code}}\\t{{/}}")).toBe("\t");
  });

  it("escape escapes braces and parens", () => {
    expect(ev("{{#escape}}{a}{{/}}")).toBe("\\{a\\}");
  });
});

describe("evaluate — single placeholders", () => {
  it("char / user / persona / model", () => {
    expect(ev("{{char}}")).toBe("Char");
    expect(ev("{{user}}")).toBe("User");
    expect(ev("{{persona}}")).toBe("Persona");
    expect(ev("{{model}}")).toBe("test-model");
  });

  it("getvar / setvar / addvar / setdefaultvar", () => {
    const c = ctx({ A: "5" });
    expect(ev("{{getvar::A}}", c)).toBe("5");
    expect(ev("{{setvar::B::hi}}{{getvar::B}}", c)).toBe("hi");
    expect(ev("{{addvar::A::2}}{{getvar::A}}", c)).toBe("7");
    // setdefaultvar 은 값이 이미 존재하면 덮지 않는다(addvar 로 A=7 이 됨).
    expect(ev("{{setdefaultvar::A::99}}{{getvar::A}}", c)).toBe("7");
  });

  it("br / cbr / bo / bc / decbo / decbc / debo / debc / dec", () => {
    expect(ev("{{br}}")).toBe("\n");
    expect(ev("{{cbr}}")).toBe("\\n");
    expect(ev("{{bo}}")).toBe("{{");
    expect(ev("{{bc}}")).toBe("}}");
    expect(ev("{{decbo}}")).toBe("{");
    expect(ev("{{decbc}}")).toBe("}");
    expect(ev("{{debo}}")).toBe("(");
    expect(ev("{{debc}}")).toBe(")");
    expect(ev("{{dec}}")).toBe(":");
  });

  it("legacy <user>/<char>/<bot> tokens", () => {
    expect(ev("<user>-<char>-<bot>")).toBe("User-Char-Char");
  });

  it("comments are stripped", () => {
    expect(ev("a{{// note}}b")).toBe("ab");
    expect(ev("a{{comment::note}}b")).toBe("ab");
  });

  it("passthrough placeholders preserved verbatim", () => {
    expect(ev("{{asset::x}}")).toBe("{{asset::x}}");
    expect(ev("{{history}}")).toBe("{{history}}");
  });
});

describe("evaluate — @@ decorators", () => {
  it("strips @@ decorator lines", () => {
    expect(ev("@@depth 4\nbody")).toBe("body");
  });
});

describe("evaluate — functions and call depth", () => {
  it("defines and calls a function with {{arg::N}}", () => {
    const src = "{{#func greet who}}Hi {{arg::0}}!{{/}}{{call::greet::World}}";
    expect(ev(src)).toBe("Hi World!");
  });

  it("limits call depth", () => {
    // 재귀 호출로 깊이 한도 도달 시 에러 마커 + 빈 출력
    const src = "{{#func loop n}}{{call::loop::x}}{{/}}{{call::loop::x}}";
    const c = ctx();
    const result = evaluate(src, c);
    expect(result.value).toBe("");
    expect(c.errors.length).toBeGreaterThan(0);
  });

  it("reports undefined function call as error", () => {
    const c = ctx();
    evaluate("{{call::nope::a}}", c);
    expect(c.errors.some((e) => e.includes("정의되지 않은"))).toBe(true);
  });
});

describe("evaluate — limits marker", () => {
  it("MAX_CALL_DEPTH is a sane constant", () => {
    expect(MAX_CALL_DEPTH).toBeGreaterThan(0);
  });
});

describe("evaluate — comparison / string-check functions", () => {
  it("equal returns 1/0 for exact string equality", () => {
    expect(ev("{{equal::abc::abc}}")).toBe("1");
    expect(ev("{{equal::abc::abcd}}")).toBe("0");
    expect(ev("{{equal::1::1}}")).toBe("1");
  });

  it("notequal returns 1/0", () => {
    expect(ev("{{notequal::a::b}}")).toBe("1");
    expect(ev("{{notequal::a::a}}")).toBe("0");
  });

  it("not_equal alias maps to notequal", () => {
    expect(ev("{{not_equal::a::b}}")).toBe("1");
  });

  it("contains is case-sensitive substring match", () => {
    expect(ev("{{contains::hello world::world}}")).toBe("1");
    expect(ev("{{contains::hello world::World}}")).toBe("0");
    expect(ev("{{contains::abc::d}}")).toBe("0");
  });

  it("startswith / endswith", () => {
    expect(ev("{{startswith::hello::he}}")).toBe("1");
    expect(ev("{{startswith::hello::lo}}")).toBe("0");
    expect(ev("{{endswith::hello::lo}}")).toBe("1");
    expect(ev("{{endswith::hello::he}}")).toBe("0");
  });
});

describe("evaluate — getglobalvar toggle mapping", () => {
  it("getglobalvar::toggle_NAME reads the panel toggle NAME", () => {
    expect(ev("{{getglobalvar::toggle_test}}", ctx({}, { test: true }))).toBe("1");
    expect(ev("{{getglobalvar::toggle_test}}", ctx({}, { test: false }))).toBe("0");
  });

  it("getglobalvar::NAME (non-toggle) reads chat vars", () => {
    expect(ev("{{getglobalvar::G}}", ctx({ G: "v" }))).toBe("v");
  });

  it("setglobalvar::toggle_NAME writes the panel toggle", () => {
    const c = ctx();
    ev("{{setglobalvar::toggle_test::1}}", c);
    expect(c.toggles.test).toBe(true);
    ev("{{setglobalvar::toggle_test::0}}", c);
    expect(c.toggles.test).toBe(false);
  });
});

describe("evaluate — nested placeholders", () => {
  it("equal with nested getglobalvar toggle on → 1", () => {
    const src = "{{equal::{{getglobalvar::toggle_test}}::1}}";
    expect(ev(src, ctx({}, { test: true }))).toBe("1");
  });

  it("equal with nested getglobalvar toggle off → 0", () => {
    const src = "{{equal::{{getglobalvar::toggle_test}}::1}}";
    expect(ev(src, ctx({}, { test: false }))).toBe("0");
  });

  it("contains with nested previous_chat_log preserves passthrough (no warning)", () => {
    // previous_chat_log 는 런타임 의존 자리로 원문 보존. contains 는 그 보존된
    // 문자열에 대해 평가하되 구문 오류/경고로 취급하지 않는다.
    const c = ctx();
    const result = evaluate("{{contains::{{previous_chat_log::{{slot::item}}}}::hello}}", c);
    expect(result.value).toBe("0");
    expect(c.errors).toEqual([]);
  });

  it("nested placeholders produce no false warnings", () => {
    const c = ctx({}, { test: true });
    evaluate(
      "{{equal::{{getglobalvar::toggle_test}}::1}}{{contains::{{previous_chat_log::{{slot::item}}}}::hello}}",
      c
    );
    expect(c.errors).toEqual([]);
  });
});

// === 2차 호환성 패스: upstream RisuAI cbs.ts 함수 + 중첩 CBS 회귀 =============

describe("evaluate — upstream CBS functions (2nd-pass)", () => {
  it("random: multiple args → first (deterministic preview, RisuAI tokenizeAccurate)", () => {
    expect(ev("{{random::a::b::c}}")).toBe("a");
    expect(ev("{{random::1::1::2::3}}")).toBe("1");
  });

  it("random: trailing empty arg is a valid pool element (no warning)", () => {
    const c = ctx();
    const r = evaluate("{{random::special ability::special item::power awakening::romance::item enhancement::}}", c);
    expect(r.value).toBe("special ability");
    expect(c.errors).toEqual([]);
  });

  it("random: single comma/colon string is split into a pool", () => {
    expect(ev("{{random::a,b,c}}")).toBe("a");
    expect(ev("{{random::a:b:c}}")).toBe("a");
  });

  it("random: zero args returns a deterministic number placeholder", () => {
    expect(ev("{{random}}")).toBe("0");
  });

  it("trim removes surrounding whitespace", () => {
    expect(ev("{{trim::  hello  }}")).toBe("hello");
    expect(ev("{{trim::\thello\n}}")).toBe("hello");
  });

  it("length returns character count", () => {
    expect(ev("{{length::hello}}")).toBe("5");
    expect(ev("{{length::}}")).toBe("0");
  });

  it("makearray / array / a aliases produce a JSON array", () => {
    expect(ev("{{array::a::b::c}}")).toBe('["a","b","c"]');
    expect(ev("{{makearray::1::2}}")).toBe('["1","2"]');
    expect(ev("{{a::x}}")).toBe('["x"]');
  });

  it("and / or / not use strict '1' truthiness", () => {
    expect(ev("{{and::1::1}}")).toBe("1");
    expect(ev("{{and::1::0}}")).toBe("0");
    expect(ev("{{and::true::1}}")).toBe("0"); // "true" is not "1"
    expect(ev("{{or::0::1}}")).toBe("1");
    expect(ev("{{or::0::0}}")).toBe("0");
    expect(ev("{{not::1}}")).toBe("0");
    expect(ev("{{not::0}}")).toBe("1");
  });

  it("all / any over multiple args or a JSON array", () => {
    expect(ev("{{all::1::1::1}}")).toBe("1");
    expect(ev("{{all::1::0::1}}")).toBe("0");
    expect(ev("{{any::0::1::0}}")).toBe("1");
    expect(ev("{{any::0::0::0}}")).toBe("0");
    expect(ev('{{all::[1,1,1]}}')).toBe("1");
    expect(ev('{{any::[0,0,1]}}')).toBe("1");
  });

  it("greater / less / greaterequal / lessequal numeric compare (1/0)", () => {
    expect(ev("{{greater::10::5}}")).toBe("1");
    expect(ev("{{greater::5::10}}")).toBe("0");
    expect(ev("{{less::5::10}}")).toBe("1");
    expect(ev("{{greaterequal::10::10}}")).toBe("1");
    expect(ev("{{lessequal::5::5}}")).toBe("1");
    expect(ev("{{less_equal::5::5}}")).toBe("1");
    expect(ev("{{greater_equal::10::5}}")).toBe("1");
  });
});

describe("evaluate — nested CBS in block headers", () => {
  it("#if_pure evaluates nested equal then renders on 1", () => {
    expect(ev("{{#if_pure {{equal::A::A}}}}YES{{/if}}")).toBe("YES");
  });

  it("#if_pure evaluates nested equal then skips on 0", () => {
    expect(ev("{{#if_pure {{equal::1::0}}}}YES{{/if}}")).toBe("");
  });

  it("#if_pure with nested {{? }} comparison", () => {
    expect(ev("{{#if_pure {{? 2>1}}}}YES{{/if}}")).toBe("YES");
    expect(ev("{{#if_pure {{? 1>2}}}}YES{{/if}}")).toBe("");
  });

  it("#if_pure with nested and/not_equal/{{?}} compound (upstream pattern)", () => {
    const c = ctx({ tags: '["x"]' });
    const src =
      "{{#if_pure {{and::{{not_equal::{{getglobalvar::tags}}::null}}::{{? {{length::{{getglobalvar::tags}}}}>0}}}}}}YES{{/if}}";
    expect(ev(src, c)).toBe("YES");
  });

  it("#if_pure with nested any of {{?}} comparisons (deus pattern)", () => {
    // toggle_deus → Scriptorium 토글 'deus'; getglobalvar::toggle_deus → "1"/"0".
    // RisuAI calcString 은 '=' 를 지원하지만 Scriptorium 은 '==' 를 노출한다.
    const src =
      "{{#if_pure {{any::{{? {{getglobalvar::toggle_deus}}==1}}::{{? {{getglobalvar::toggle_deus}}==2}}}}}}YES{{/if}}";
    expect(ev(src, ctx({}, { deus: true }))).toBe("YES");
    expect(ev(src, ctx({}, { deus: false }))).toBe("");
  });

  it("#when with nested CBS in header", () => {
    expect(ev("{{#when {{equal::1::1}}}}Y{{:else}}N{{/when}}")).toBe("Y");
    expect(ev("{{#when {{equal::1::0}}}}Y{{:else}}N{{/when}}")).toBe("N");
  });
});

describe("evaluate — #each with nested array expressions", () => {
  it("iterates a nested {{array::...}} expression", () => {
    expect(ev("{{#each {{array::A::B}} item}}{{slot::item}}{{/each}}")).toBe("AB");
  });

  it("iterates a nested array with as keyword", () => {
    expect(ev('{{#each {{array::A::B::C}} as V}}{{slot::V}}{{/each}}')).toBe("ABC");
  });

  it("slot resolves inside nested placeholders (getglobalvar::{{slot::v}})", () => {
    // toggle_ 접두가 없는 전역 변수 이름을 써야 getglobalvar 이 채팅 변수에서 읽는다.
    const c = ctx({ var_a: "1", var_b: "2" });
    expect(ev("{{#each {{array::var_a::var_b}} v}}{{getglobalvar::{{slot::v}}}}{{/each}}", c)).toBe("12");
  });

  it("#if_pure inside #each uses the loop variable via nested slot", () => {
    // toggle_genre1 은 Scriptorium 에서 토글 'genre1' 로 매핑된다.
    const c = ctx({}, { genre1: true, genre2: false, genre3: true });
    const src =
      "{{#each {{array::toggle_genre1::toggle_genre2::toggle_genre3}} genreVar}}{{#if_pure {{equal::{{getglobalvar::{{slot::genreVar}}}}::1}}}}ON{{/if}}|{{/each}}";
    expect(ev(src, c)).toBe("ON||ON|");
  });

  it("preserves outer loop variable across nested #each", () => {
    const c = ctx();
    const src =
      "{{#each {{array::X::Y}} outer}}{{slot::outer}}:{{#each {{array::1::2}} inner}}{{slot::outer}}{{slot::inner}}{{/each}},{{/each}}";
    expect(ev(src, c)).toBe("X:X1X2,Y:Y1Y2,");
  });
});

describe("evaluate — runtime passthrough placeholders (no warning)", () => {
  it("chats and cache_point preserved verbatim without warnings", () => {
    const c = ctx();
    const r = evaluate("{{chats}}-{{cache_point}}", c);
    expect(r.value).toBe("{{chats}}-{{cache_point}}");
    expect(c.errors).toEqual([]);
  });
});

describe("evaluate — full nested trim/#if_pure/#each pattern (2nd-pass regression)", () => {
  it("evaluates the composite upstream pattern end-to-end", () => {
    const c = ctx(
      {
        // tags: 비-토글 전역 변수(getglobalvar::tags 가 채팅 변수에서 읽도록).
        tags: '["drama","romance"]'
      },
      // toggle_genre1/2/3 과 toggle_deus 는 Scriptorium 토글로 매핑된다.
      { genre1: true, genre2: false, genre3: true, deus: true }
    );
    const src = [
      "{{trim::",
      "  {{#if_pure {{and::{{not_equal::{{getglobalvar::tags}}::null}}::{{? {{length::{{getglobalvar::tags}}}}>0}}}}}}",
      "    {{#each {{array::toggle_genre1::toggle_genre2::toggle_genre3}} genreVar}}",
      "      {{#if_pure {{equal::{{getglobalvar::{{slot::genreVar}}}}::1}}}}[{{slot::genreVar}}]{{/if}}",
      "    {{/each}}",
      "    {{#if_pure {{any::{{? {{getglobalvar::toggle_deus}}==1}}::{{? {{getglobalvar::toggle_deus}}==2}}}}}}DEUS{{/if}}",
      "  {{/if}}",
      "}}"
    ].join("\n");
    const r = evaluate(src, c);
    // outer trim strips the surrounding newline whitespace; inner keep-mode bodies
    // collapse via legacy trim. Result contains the two active genres and DEUS.
    expect(r.value).toContain("[toggle_genre1]");
    expect(r.value).toContain("[toggle_genre3]");
    expect(r.value).not.toContain("[toggle_genre2]");
    expect(r.value).toContain("DEUS");
    expect(c.errors).toEqual([]);
  });
});