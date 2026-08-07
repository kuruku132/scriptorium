import { describe, expect, it } from "vitest";
import { parse, tokenize } from "../src/modules/cbs/parser";

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