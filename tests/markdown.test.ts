import { describe, expect, it } from "vitest";
import {
  extractKeys,
  matchesGlob,
  parseMarkdown
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

  it("supports project glob matching", () => {
    expect(matchesGlob("nested/private/a.md", "**/private/**")).toBe(true);
    expect(matchesGlob("private/a.md", "**/private/**")).toBe(true);
    expect(matchesGlob("notes/a.md", "notes/*.md")).toBe(true);
    expect(matchesGlob("notes/deep/a.md", "notes/*.md")).toBe(false);
  });
});
