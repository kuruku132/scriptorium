import { describe, expect, it } from "vitest";
import {
  extractKeys,
  matchesGlob,
  normalizeKeys,
  parseMarkdown,
  replaceFrontmatterKeys,
  withFrontmatterKeys
} from "../src/shared/markdown";

describe("parseMarkdown", () => {
  it("separates frontmatter and structural blocks", () => {
    const parsed = parseMarkdown(`---
title: Example
keys:
  - alpha
  - beta
scriptorium: true
---
# Heading

Paragraph
continues.

- one
- two

| A | B |
|---|---|
| 1 | 2 |

> quote
> continued

\`\`\`ts
const value = 1;
\`\`\`
`);

    expect(parsed.frontmatter?.values).toMatchObject({
      title: "Example",
      keys: ["alpha", "beta"],
      scriptorium: true
    });
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "table",
      "quote",
      "code"
    ]);
    expect(parsed.blocks[0]?.headingPath).toEqual(["Heading"]);
    expect(parsed.blocks[1]?.headingPath).toEqual(["Heading"]);
    expect(extractKeys(parsed, "fallback")).toEqual(["alpha", "beta"]);
  });

  it("keeps each heading independent even without a blank line", () => {
    const parsed = parseMarkdown("# A\nText\n## B\nMore");
    expect(parsed.blocks.map((block) => block.text)).toEqual([
      "# A",
      "Text",
      "## B",
      "More"
    ]);
    expect(parsed.blocks[3]?.headingPath).toEqual(["A", "B"]);
  });

  it("parses an empty frontmatter block", () => {
    const parsed = parseMarkdown("---\n---\nBody");
    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.frontmatter?.values).toEqual({});
    expect(parsed.body).toBe("Body");
    expect(parsed.blocks.map((block) => block.text)).toEqual(["Body"]);
  });

  it("supports project glob matching", () => {
    expect(matchesGlob("nested/private/a.md", "**/private/**")).toBe(true);
    expect(matchesGlob("private/a.md", "**/private/**")).toBe(true);
    expect(matchesGlob("notes/a.md", "notes/*.md")).toBe(true);
    expect(matchesGlob("notes/deep/a.md", "notes/*.md")).toBe(false);
  });
});

describe("normalizeKeys", () => {
  it("passes through clean keys", () => {
    expect(normalizeKeys(["검", "마나"])).toEqual(["검", "마나"]);
  });

  it("splits YAML-list-style newlines and strips list markers", () => {
    expect(normalizeKeys(["- a\n- b", "-c"])).toEqual(["a", "b", "c"]);
    expect(normalizeKeys(["1. foo\n2. bar"])).toEqual(["foo", "bar"]);
  });

  it("splits comma-separated keys inside a single element", () => {
    expect(normalizeKeys(["a, b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("strips parentheses and treats the inner content as separate keys", () => {
    expect(normalizeKeys(["한국어(영어)"])).toEqual(["한국어", "영어"]);
    expect(normalizeKeys(["a(b, c)d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("removes duplicates and surrounding quotes", () => {
    expect(normalizeKeys(['"검"', "검", "`마나`"])).toEqual(["검", "마나"]);
  });
});

describe("replaceFrontmatterKeys", () => {
  it("replaces an inline keys field with a block list", () => {
    const raw = "title: Example\nkeys: alpha, beta\nscriptorium: true";
    expect(replaceFrontmatterKeys(raw, ["검", "마나"])).toBe(
      "title: Example\nkeys:\n  - 검\n  - 마나\nscriptorium: true"
    );
  });

  it("replaces a block-list keys field", () => {
    const raw = "title: Example\nkeys:\n  - alpha\n  - beta\nscriptorium: true";
    expect(replaceFrontmatterKeys(raw, ["검", "마나"])).toBe(
      "title: Example\nkeys:\n  - 검\n  - 마나\nscriptorium: true"
    );
  });

  it("appends a keys field when none exists", () => {
    const raw = "title: Example";
    expect(replaceFrontmatterKeys(raw, ["검"])).toBe(
      "title: Example\nkeys:\n  - 검"
    );
  });

  it("removes the keys field when given an empty list", () => {
    const raw = "title: Example\nkeys:\n  - alpha\nscriptorium: true";
    expect(replaceFrontmatterKeys(raw, [])).toBe(
      "title: Example\nscriptorium: true"
    );
  });

  it("quotes keys that contain reserved characters", () => {
    const raw = "keys: a";
    expect(replaceFrontmatterKeys(raw, ["a:b", "normal"])).toBe(
      'keys:\n  - "a:b"\n  - normal'
    );
  });
});

describe("withFrontmatterKeys", () => {
  it("creates a keys-only frontmatter when none existed", () => {
    expect(withFrontmatterKeys(null, ["검"])).toEqual({
      raw: "keys:\n  - 검",
      values: { keys: ["검"] }
    });
  });

  it("returns null when there is no frontmatter and no keys", () => {
    expect(withFrontmatterKeys(null, [])).toBeNull();
  });
});
