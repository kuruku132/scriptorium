import { describe, expect, it } from "vitest";
import {
  migrateLegacyFrontmatter,
  setScriptoriumIncluded
} from "../src/modules/migration";

describe("one-time legacy frontmatter migration", () => {
  it("renames top-level snake_case metadata", () => {
    const source = [
      "---",
      "title: Hero",
      "secondary_keys:",
      "  - warrior",
      "always_active: true",
      "insertion_order: 42",
      "enabled: false",
      "---",
      "Body"
    ].join("\n");
    const result = migrateLegacyFrontmatter(source);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("secondkey:");
    expect(result.content).toContain("alwaysActive: true");
    expect(result.content).toContain("insertorder: 42");
    expect(result.content).toContain("scriptorium: false");
    expect(result.content).not.toContain("secondary_keys:");
    expect(migrateLegacyFrontmatter(result.content).changed).toBe(false);
  });

  it("flattens the supported nested lorebook block", () => {
    const source = [
      "---",
      "category: character",
      "lorebook:",
      "  keys:",
      "    - hero",
      "  always_active: true",
      "---",
      "Body"
    ].join("\n");
    const result = migrateLegacyFrontmatter(source);
    expect(result.content).toContain("category: character");
    expect(result.content).toContain("keys:");
    expect(result.content).toContain("alwaysActive: true");
    expect(result.content).not.toContain("lorebook:");
  });

  it("writes and removes the document inclusion flag", () => {
    const excluded = setScriptoriumIncluded("Body", false);
    expect(excluded.content).toContain("scriptorium: false");
    const included = setScriptoriumIncluded(excluded.content, true);
    expect(included.content).toBe("Body");
  });
});
