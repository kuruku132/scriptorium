import { describe, expect, it } from "vitest";
import { parse, splitArgs, tokenize } from "../src/modules/cbs/parser";

describe("tokenize", () => {
  it("splits text and tag runs", () => {
    const tokens = tokenize("a{{b}}c");
    expect(tokens).toEqual([
      { type: "text", value: "a" },
      { type: "tag", inner: "b" },
      { type: "text", value: "c" }
    ]);
  });

  it("handles unclosed tag as text", () => {
    const tokens = tokenize("a{{b");
    expect(tokens).toEqual([
      { type: "text", value: "a" },
      { type: "text", value: "{{b" }
    ]);
  });
});

describe("parse", () => {
  it("parses a placeholder", () => {
    const nodes = parse("{{char}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "placeholder", name: "char" });
  });

  it("parses a when/else block", () => {
    const nodes = parse("{{#when var::A}}Y{{:else}}N{{/when}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("block");
    const block = nodes[0];
    if (block?.type === "block") {
      expect(block.directive).toBe("when");
      expect(block.body).toHaveLength(1);
      expect(block.elseBody).toHaveLength(1);
    }
  });

  it("normalizes #if to when (legacy mode)", () => {
    const nodes = parse("{{#if var::A}}Y{{/if}}");
    const block = nodes[0];
    expect(block?.type).toBe("block");
    if (block?.type === "block") {
      expect(block.directive).toBe("when");
      expect(block.whitespaceMode).toBe("legacy");
    }
  });

  it("normalizes #if_pure to when (keep mode)", () => {
    const nodes = parse("{{#if_pure var::A}}Y{{/if_pure}}");
    const block = nodes[0];
    if (block?.type === "block") {
      expect(block.directive).toBe("when");
      expect(block.whitespaceMode).toBe("keep");
    }
  });

  it("normalizes #pure/#pure_display to puredisplay", () => {
    for (const d of ["pure", "pure_display"]) {
      const nodes = parse(`{{#${d}}}raw{{/}}`);
      const block = nodes[0];
      if (block?.type === "block") expect(block.directive).toBe("puredisplay");
    }
  });

  it("stores rawBody for puredisplay without interpreting nested CBS", () => {
    const nodes = parse("{{#puredisplay}}{{char}}{{/}}");
    const block = nodes[0];
    if (block?.type === "block") {
      expect(block.rawBody).toBe("{{char}}");
      expect(block.body).toEqual([]);
    }
  });

  it("captures nested depth for raw body blocks", () => {
    const nodes = parse("{{#code}}{{#when var::A}}X{{/when}}{{/}}");
    const block = nodes[0];
    if (block?.type === "block") {
      expect(block.rawBody).toBe("{{#when var::A}}X{{/when}}");
    }
  });

  it("parses math placeholder as name='?'", () => {
    const nodes = parse("{{? 1+2}}");
    const node = nodes[0];
    expect(node).toMatchObject({ type: "placeholder", name: "?", args: ["1+2"] });
  });

  it("strips comment tags", () => {
    const nodes = parse("{{// note}}text");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("text");
  });

  it("handles {{/}} close form", () => {
    const nodes = parse("{{#each [1,2,3] n}}{{slot::n}}{{/}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("block");
  });
});

describe("tokenize — nested placeholders", () => {
  it("matches the outer closing }} accounting for nested {{ }}", () => {
    const tokens = tokenize("{{equal::{{getglobalvar::toggle_example}}::1}}");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: "tag",
      inner: "equal::{{getglobalvar::toggle_example}}::1"
    });
  });

  it("preserves surrounding text around a nested placeholder", () => {
    const tokens = tokenize("a{{contains::{{slot::item}}::hello}}b");
    expect(tokens).toEqual([
      { type: "text", value: "a" },
      { type: "tag", inner: "contains::{{slot::item}}::hello" },
      { type: "text", value: "b" }
    ]);
  });

  it("handles two levels of nesting", () => {
    const tokens = tokenize("{{contains::{{previous_chat_log::{{slot::item}}}}::hello}}");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: "tag",
      inner: "contains::{{previous_chat_log::{{slot::item}}}}::hello"
    });
  });
});

describe("splitArgs — depth-aware argument splitting", () => {
  it("splits top-level :: only", () => {
    expect(splitArgs("equal::a::b")).toEqual(["equal", "a", "b"]);
  });

  it("does not split :: inside nested {{ }}", () => {
    expect(splitArgs("equal::{{getglobalvar::toggle_example}}::1")).toEqual([
      "equal",
      "{{getglobalvar::toggle_example}}",
      "1"
    ]);
  });

  it("does not split :: inside two levels of nesting", () => {
    expect(splitArgs("contains::{{previous_chat_log::{{slot::item}}}}::hello")).toEqual([
      "contains",
      "{{previous_chat_log::{{slot::item}}}}",
      "hello"
    ]);
  });

  it("returns the whole string when there is no separator", () => {
    expect(splitArgs("char")).toEqual(["char"]);
  });
});

describe("parse — nested placeholder arguments", () => {
  it("parses equal with a nested getglobalvar as one placeholder with two args", () => {
    const nodes = parse("{{equal::{{getglobalvar::toggle_example}}::1}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "placeholder",
      name: "equal",
      args: ["{{getglobalvar::toggle_example}}", "1"]
    });
  });

  it("parses contains with a nested previous_chat_log", () => {
    const nodes = parse("{{contains::{{previous_chat_log::{{slot::item}}}}::hello}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "placeholder",
      name: "contains",
      args: ["{{previous_chat_log::{{slot::item}}}}", "hello"]
    });
  });
});