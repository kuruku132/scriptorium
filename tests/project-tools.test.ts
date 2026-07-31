import { describe, expect, it } from "vitest";
import {
  deduplicateKoreanParentheses,
  parseRisuLorebook,
  updateMetadataContent
} from "../src/modules/project-tools";
import { TFile } from "./obsidian-stub";

describe("project tools", () => {
  it("adds, replaces, and removes current metadata fields", () => {
    const file = new TFile("project/Hero.md");
    const added = updateMetadataContent(
      "---\ncategory: person\n---\nBody",
      file as never,
      "add"
    );
    expect(added).toContain('category: "person"');
    expect(added).toContain('title: "Hero"');
    expect(added).toContain("alwaysActive: false");
    const removed = updateMetadataContent(added, file as never, "remove");
    expect(removed).toContain('category: "person"');
    expect(removed).not.toContain("alwaysActive:");
  });

  it("validates Risu JSON and removes repeated Korean parentheses", () => {
    expect(
      parseRisuLorebook('{"type":"risu","ver":1,"data":[]}')
    ).toEqual({ type: "risu", ver: 1, data: [] });
    expect(() => parseRisuLorebook('{"data":[]}')).toThrow(/RisuAI/);
    expect(
      deduplicateKoreanParentheses(
        "첫 문장 (용사)\n둘째 문장 (용사)\n셋째 (마법사)"
      )
    ).toBe("첫 문장 (용사)\n둘째 문장\n셋째 (마법사)");
  });
});
