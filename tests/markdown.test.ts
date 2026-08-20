import { describe, expect, it } from "vitest";
import {
  extractKeys,
  frontmatterNeedsSync,
  keysFromFrontmatter,
  matchesGlob,
  normalizeKeys,
  parseMarkdown,
  replaceFrontmatterKeys,
  syncFrontmatterFromSource,
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

  it("treats an unclosed code fence as plain text instead of swallowing to EOF", () => {
    const parsed = parseMarkdown("intro\n```\n# Heading\n- item\n");
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
      "heading",
      "list"
    ]);
    // 여는 펜스 줄 자체는 일반 문단으로 남는다.
    expect(parsed.blocks[1]?.text).toBe("```");
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

describe("frontmatter metadata sync", () => {
  const source = parseMarkdown(
    "---\ntitle: Hero\ninsertorder: 42\nkeys:\n  - Sword\n---\nBody"
  ).frontmatter!;

  it("detects drift in non-key fields between source and translation", () => {
    const matched = parseMarkdown(
      "---\ntitle: Hero\ninsertorder: 42\nkeys:\n  - 검\n---\n본문"
    ).frontmatter!;
    // keys만 다를 때는 동기화 불필요.
    expect(frontmatterNeedsSync(source, matched)).toBe(false);

    const drifted = parseMarkdown(
      "---\ntitle: Hero(번역)\ninsertorder: 42\nkeys:\n  - 검\n---\n본문"
    ).frontmatter!;
    // 비-키 필드(title)가 다르면 동기화 필요.
    expect(frontmatterNeedsSync(source, drifted)).toBe(true);

    // 번역본에 frontmatter가 없어도 원문 비-키 필드가 있으면 동기화 필요.
    expect(frontmatterNeedsSync(source, null)).toBe(true);
    // 원문에 frontmatter가 없으면 동기화 불필요.
    expect(frontmatterNeedsSync(null, matched)).toBe(false);
  });

  it("syncs non-key fields from source while keeping translation keys", () => {
    const translation = parseMarkdown(
      "---\ntitle: Hero(번역)\ninsertorder: 7\nkeys:\n  - 검\n---\n본문"
    ).frontmatter!;
    const synced = syncFrontmatterFromSource(source, translation);
    // 비-키 필드는 원문 기준.
    expect(synced.values.title).toBe("Hero");
    expect(synced.values.insertorder).toBe(42);
    // keys는 번역본의 번역된 키.
    expect(synced.values.keys).toEqual(["검"]);
  });

  it("drops keys when the translation has no keys", () => {
    const translation = parseMarkdown(
      "---\ntitle: Hero(번역)\ninsertorder: 7\n---\n본문"
    ).frontmatter!;
    const synced = syncFrontmatterFromSource(source, translation);
    expect(synced.values.title).toBe("Hero");
    expect("keys" in synced.values).toBe(false);
  });

  it("keysFromFrontmatter reads only keys without basename fallback", () => {
    const translation = parseMarkdown(
      "---\ntitle: Hero\nkeys:\n  - 검\n---\n본문"
    ).frontmatter!;
    expect(keysFromFrontmatter(translation)).toEqual(["검"]);
    expect(keysFromFrontmatter(null)).toEqual([]);
    const inline = parseMarkdown("---\nkeys: a, b\n---\nx").frontmatter!;
    expect(keysFromFrontmatter(inline)).toEqual(["a", "b"]);
  });
});
