import { describe, expect, it } from "vitest";
import {
  compileLorebookDocuments,
  createNoProjectSnapshot,
  createReadySnapshot,
  snapshotHttpResponse
} from "../src/modules/lorebook-core";
import { parseMarkdown } from "../src/shared/markdown";
import type { SourceDocument } from "../src/shared/types";

function document(source: string, translation: string | null): SourceDocument {
  return {
    path: "project/hero.md",
    basename: "hero",
    source: parseMarkdown(source),
    translation: translation ? parseMarkdown(translation) : null,
    cache: translation
      ? {
          sourcePath: "project/hero.md",
          translationPath: "project/translate/hero.md",
          blocks: [],
          sourceFrontmatterHash: "",
          sourceKeys: ["hero"],
          translatedKeys: ["translated-hero"],
          lastSuccessfulTranslation: translation,
          initialized: true
        }
      : null
  };
}

describe("Risu compiler", () => {
  it("infers metadata and merges translated keys", () => {
    const doc = document(
      "---\ntitle: Hero\nkeys: [hero, champion]\n---\nOriginal",
      "Translated"
    );
    const original = compileLorebookDocuments([doc], "original");
    expect(original.data[0]).toEqual({
      id: "scriptorium-entry-aa804ac6521ec9de",
      key: "hero, champion",
      secondkey: "",
      comment: "Hero",
      content: "Original",
      insertorder: 100,
      mode: "normal",
      alwaysActive: false,
      selective: false
    });
    const translated = compileLorebookDocuments([doc], "translated");
    expect(translated.data[0]?.key).toBe(
      "hero, champion, translated-hero"
    );
    expect(translated.data[0]?.content).toBe("Translated");
  });

  it("normalizes explicit Risu metadata to exported field types", () => {
    const doc = document(
      [
        "---",
        "keys: [hero, champion]",
        "secondkey: [warrior, savior]",
        "insertorder: 42",
        "mode: constant",
        "alwaysActive: true",
        "selective: true",
        "---",
        "Original"
      ].join("\n"),
      null
    );

    expect(compileLorebookDocuments([doc], "original").data[0]).toMatchObject({
      key: "hero, champion",
      secondkey: "warrior, savior",
      insertorder: 42,
      mode: "constant",
      alwaysActive: true,
      selective: true
    });
  });

  it("omits never-translated documents in translated mode", () => {
    expect(
      compileLorebookDocuments([document("Original", null)], "translated").data
    ).toEqual([]);
  });

  it("creates stable nested folder entries when enabled", () => {
    const nested = {
      ...document("Body", null),
      path: "project/people/heroes/hero.md"
    };
    const lorebook = compileLorebookDocuments([nested], "original", {
      projectRoot: "project",
      includeFolderEntries: true
    });
    expect(lorebook.data.map((entry) => entry.mode)).toEqual([
      "folder",
      "folder",
      "normal"
    ]);
    expect(lorebook.data[1]?.folder).toBe(lorebook.data[0]?.key);
    expect(lorebook.data[2]?.folder).toBe(lorebook.data[1]?.key);
    expect(
      compileLorebookDocuments([nested], "original", {
        projectRoot: "project",
        includeFolderEntries: true
      }).data
    ).toEqual(lorebook.data);
  });
});

describe("snapshot HTTP contract", () => {
  const project = {
    id: "p1",
    name: "Project",
    root: "project",
    syncMode: "original" as const,
    excludeGlobs: [],
    includeFolderEntries: true,
    translationPrompt: "",
    translationGlossary: ""
  };
  const snapshot = createReadySnapshot(project, {
    type: "risu",
    ver: 1,
    data: []
  });

  it("returns 200 with ETag and 304 for a matching hash", () => {
    const fresh = snapshotHttpResponse(snapshot);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.ETag).toBe(`"${snapshot.hash}"`);
    expect(snapshotHttpResponse(snapshot, `"${snapshot.hash}"`).status).toBe(
      304
    );
  });

  it("represents no active project and optional authentication", () => {
    const none = createNoProjectSnapshot();
    expect(none.status).toBe("no-active-project");
    expect(snapshotHttpResponse(none, undefined, false).status).toBe(401);
  });
});
