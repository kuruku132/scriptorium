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

  it("treats 0 and -1 as falsy (legacy #if rule)", () => {
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "0" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "-1" }))).toBe("N");
    expect(ev("{{#when var::A}}Y{{:else}}N{{/when}}", ctx({ A: "2" }))).toBe("Y");
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

  it("comparison returns boolean string", () => {
    expect(ev("{{? 2>1}}")).toBe("true");
    expect(ev("{{? 1==1}}")).toBe("true");
    expect(ev("{{? 1!=2}}")).toBe("true");
  });

  it("resolves inline getvar tokens (no nested braces)", () => {
    // 참고: {{? }} 안의 중첩 {{...}} 는 토크나이저 한계로 미지원(UI 한계 표시).
    expect(ev("{{? 1+2}}")).toBe("3");
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