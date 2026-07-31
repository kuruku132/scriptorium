import { describe, expect, it } from "vitest";
import {
  extractKeys,
  parseMarkdown,
  stableHash
} from "../src/shared/markdown";
import {
  adoptManualTranslations,
  createInitialFileCache,
  classifyThreeWay
} from "../src/modules/translation/cache";
import {
  createTranslationBatches,
  planFileChanges,
  reconcileChangeSelections
} from "../src/modules/translation/planner";

function plan(
  previousSource: string,
  translation: string | null,
  currentSource: string,
  selected: string[] = []
) {
  const previous = parseMarkdown(previousSource);
  const translated = translation ? parseMarkdown(translation) : null;
  const cache = createInitialFileCache(
    "project/file.md",
    "project/translate/file.md",
    previous,
    translated,
    "file"
  );
  cache.sourceKeys = extractKeys(previous, "file");
  return planFileChanges({
    sourcePath: "project/file.md",
    translationPath: "project/translate/file.md",
    basename: "file",
    source: parseMarkdown(currentSource),
    translation: translated,
    cache,
    selectedChangeIds: new Set(selected)
  });
}

describe("paragraph diff", () => {
  it("detects a one-to-one modification", () => {
    const result = plan("One\n\nTwo", "하나\n\n둘", "One changed\n\nTwo");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.kind).toBe("modify");
    expect(result.changes[0]?.oldBlocks[0]?.text).toBe("One");
    expect(result.changes[0]?.newBlocks[0]?.text).toBe("One changed");
  });

  it("detects insertions and deletions", () => {
    const inserted = plan("One\n\nTwo", "하나\n\n둘", "One\n\nNew\n\nTwo");
    expect(inserted.changes.map((change) => change.kind)).toContain("insert");

    const deleted = plan("One\n\nTwo", "하나\n\n둘", "One");
    expect(deleted.changes.map((change) => change.kind)).toContain("delete");
  });

  it("detects an exact-content move without retranslation", () => {
    const result = plan(
      "One\n\nTwo\n\nThree",
      "하나\n\n둘\n\n셋",
      "Three\n\nOne\n\nTwo"
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.kind).toBe("move");
    expect(result.changes[0]?.state).toBe("clean");
  });

  it("groups split and merge regions", () => {
    const split = plan("Combined text", "합친 글", "First\n\nSecond");
    expect(split.changes[0]?.kind).toBe("split");

    const merge = plan("First\n\nSecond", "첫째\n\n둘째", "Combined text");
    expect(merge.changes[0]?.kind).toBe("merge");
  });

  it("only batches explicitly selected changes", () => {
    const file = plan(
      "One\n\nMiddle\n\nTwo",
      "하나\n\n가운데\n\n둘",
      "One changed\n\nMiddle\n\nTwo changed"
    );
    expect(file.changes).toHaveLength(2);
    file.changes[0]!.selected = true;
    const selectedBatches = createTranslationBatches([file]);
    expect(selectedBatches.flatMap((batch) => batch.changeIds)).toEqual([
      file.changes[0]!.id
    ]);

    file.changes[0]!.selected = false;
    expect(createTranslationBatches([file])).toEqual([]);
  });

  it("selects new changes by default and preserves explicit deselection", () => {
    const file = plan(
      "One\n\nMiddle\n\nTwo",
      "하나\n\n가운데\n\n둘",
      "One changed\n\nMiddle\n\nTwo changed"
    );
    const initial = reconcileChangeSelections([file], [], []);
    expect(initial.selectedChangeIds).toEqual(
      file.changes.map((change) => change.id)
    );
    expect(file.changes.every((change) => change.selected)).toBe(true);

    const deselectedId = file.changes[0]!.id;
    const rescanned = reconcileChangeSelections(
      [file],
      initial.selectedChangeIds.filter((id) => id !== deselectedId),
      initial.knownChangeIds
    );
    expect(rescanned.selectedChangeIds).not.toContain(deselectedId);
    expect(file.changes[0]!.selected).toBe(false);
  });

  it("splits requests before the character limit without cutting a block", () => {
    const file = plan(
      "Anchor",
      "기준",
      `${"A".repeat(7_000)}\n\n${"B".repeat(7_000)}`
    );
    reconcileChangeSelections([file], [], []);
    const batches = createTranslationBatches([file], 12_000);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.blocks).toHaveLength(1);
    expect(batches[0]?.blocks[0]?.source).toHaveLength(7_000);
    expect(batches[1]?.blocks).toHaveLength(1);
  });

  it("does not re-request a completed block from a partial change group", () => {
    const previous = parseMarkdown("Combined");
    const translated = parseMarkdown("합침");
    const cache = createInitialFileCache(
      "project/file.md",
      "project/translate/file.md",
      previous,
      translated,
      "file"
    );
    const currentText = `${"A".repeat(7_000)}\n\n${"B".repeat(7_000)}`;
    const firstPlan = planFileChanges({
      sourcePath: "project/file.md",
      translationPath: "project/translate/file.md",
      basename: "file",
      source: parseMarkdown(currentText),
      translation: translated,
      cache,
      selectedChangeIds: new Set()
    });
    const completedId = firstPlan.source.blocks[0]!.id;
    cache.pendingTranslations = { [completedId]: "완료됨" };
    const resumedPlan = planFileChanges({
      sourcePath: "project/file.md",
      translationPath: "project/translate/file.md",
      basename: "file",
      source: parseMarkdown(currentText),
      translation: translated,
      cache,
      selectedChangeIds: new Set()
    });
    reconcileChangeSelections([resumedPlan], [], []);
    const batches = createTranslationBatches([resumedPlan], 12_000);
    expect(batches.flatMap((batch) => batch.blocks).map((block) => block.id))
      .not.toContain(completedId);
  });

  it("can explicitly accept an unmatched legacy translation", () => {
    const source = parseMarkdown("First\n\nSecond");
    const translated = parseMarkdown("기존 번역 하나");
    const cache = createInitialFileCache(
      "project/file.md",
      "project/translate/file.md",
      source,
      translated,
      "file"
    );
    const initial = planFileChanges({
      sourcePath: "project/file.md",
      translationPath: "project/translate/file.md",
      basename: "file",
      source: parseMarkdown("First\n\nSecond"),
      translation: translated,
      cache,
      selectedChangeIds: new Set()
    });
    expect(initial.conflicts).toHaveLength(1);
    cache.acceptedOrphanHash = stableHash("기존 번역 하나");
    const accepted = planFileChanges({
      sourcePath: "project/file.md",
      translationPath: "project/translate/file.md",
      basename: "file",
      source: parseMarkdown("First\n\nSecond"),
      translation: translated,
      cache,
      selectedChangeIds: new Set()
    });
    expect(accepted.conflicts).toHaveLength(0);
  });
});

describe("three-way state", () => {
  const cached = {
    id: "block",
    kind: "paragraph" as const,
    lastSource: "source",
    lastGenerated: "translation",
    headingPath: []
  };

  it("adopts translation-only edits and blocks simultaneous edits", () => {
    expect(classifyThreeWay(cached, "source", "manual")).toBe("manual");
    expect(classifyThreeWay(cached, "changed", "translation")).toBe("pending");
    expect(classifyThreeWay(cached, "changed", "manual")).toBe("conflict");
  });

  it("adopts a translation-only deletion without changing the source baseline", () => {
    const cache = {
      sourcePath: "project/file.md",
      translationPath: "project/translate/file.md",
      blocks: [{ ...cached }],
      sourceFrontmatterHash: "",
      sourceKeys: ["file"],
      translatedKeys: [],
      lastSuccessfulTranslation: "translation",
      initialized: true
    };
    expect(
      adoptManualTranslations(cache, {}, { block: "source" })
    ).toBe(true);
    expect(cache.blocks[0]?.lastGenerated).toBeNull();
    expect(cache.blocks[0]?.lastSource).toBe("source");
  });
});
