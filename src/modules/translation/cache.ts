import {
  extractKeys,
  renderMarkdown,
  stableHash
} from "../../shared/markdown";
import type {
  CachedBlock,
  FileCache,
  MarkdownBlock,
  ParsedMarkdown,
  TranslationState
} from "../../shared/types";

export interface TranslationAlignment {
  byBlockId: Record<string, string>;
  states: Record<string, TranslationState>;
  orphanTexts: string[];
}

function exactPairs(
  expected: Array<{ id: string; text: string }>,
  current: MarkdownBlock[]
): Map<number, number> {
  const pairs = new Map<number, number>();
  const used = new Set<number>();

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const expectedText = expected[expectedIndex]?.text;
    for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
      if (used.has(currentIndex)) continue;
      if (current[currentIndex]?.text === expectedText) {
        pairs.set(expectedIndex, currentIndex);
        used.add(currentIndex);
        break;
      }
    }
  }
  return pairs;
}

export function alignTranslations(
  cached: CachedBlock[],
  translation: ParsedMarkdown | null
): TranslationAlignment {
  const translatable = cached.filter((block) => block.lastGenerated !== null);
  const current = translation?.blocks ?? [];
  const pairs = exactPairs(
    translatable.map((block) => ({
      id: block.id,
      text: block.lastGenerated ?? ""
    })),
    current
  );
  const usedCurrent = new Set(pairs.values());
  const remainingExpected = translatable
    .map((_, index) => index)
    .filter((index) => !pairs.has(index));
  const remainingCurrent = current
    .map((_, index) => index)
    .filter((index) => !usedCurrent.has(index));

  if (remainingExpected.length === remainingCurrent.length) {
    for (let index = 0; index < remainingExpected.length; index += 1) {
      const expectedIndex = remainingExpected[index];
      const currentIndex = remainingCurrent[index];
      if (expectedIndex !== undefined && currentIndex !== undefined) {
        pairs.set(expectedIndex, currentIndex);
        usedCurrent.add(currentIndex);
      }
    }
  }

  const byBlockId: Record<string, string> = {};
  const states: Record<string, TranslationState> = {};
  for (let index = 0; index < translatable.length; index += 1) {
    const cachedBlock = translatable[index];
    if (!cachedBlock) continue;
    const currentIndex = pairs.get(index);
    const currentText =
      currentIndex === undefined ? undefined : current[currentIndex]?.text;
    if (currentText === undefined) {
      states[cachedBlock.id] = "manual";
      continue;
    }
    byBlockId[cachedBlock.id] = currentText;
    states[cachedBlock.id] =
      currentText === cachedBlock.lastGenerated ? "clean" : "manual";
  }

  const orphanTexts = current
    .filter((_, index) => !usedCurrent.has(index))
    .map((block) => block.text);
  return { byBlockId, states, orphanTexts };
}

export function createInitialFileCache(
  sourcePath: string,
  translationPath: string,
  source: ParsedMarkdown,
  translation: ParsedMarkdown | null,
  basename: string
): FileCache {
  const sourceBlocks = source.blocks;
  const translationBlocks = translation?.blocks ?? [];
  const sameShape =
    translation !== null && sourceBlocks.length === translationBlocks.length;
  const rawTranslatedKeys = translation?.frontmatter?.values.keys;
  const translatedKeys = Array.isArray(rawTranslatedKeys)
    ? rawTranslatedKeys.map(String)
    : typeof rawTranslatedKeys === "string"
      ? rawTranslatedKeys.split(",").map((key) => key.trim()).filter(Boolean)
      : [];
  const blocks: CachedBlock[] = sameShape
    ? sourceBlocks.map((block, index) => ({
        id: block.id,
        kind: block.kind,
        lastSource: block.text,
        lastGenerated: translationBlocks[index]?.text ?? null,
        headingPath: [...block.headingPath]
      }))
    : [];

  return {
    sourcePath,
    translationPath,
    blocks,
    sourceFrontmatterHash: stableHash(source.frontmatter?.raw ?? ""),
    sourceKeys:
      sameShape && translatedKeys.length > 0
        ? extractKeys(source, basename)
        : [],
    translatedKeys,
    pendingTranslations: {},
    lastSuccessfulTranslation: translation
      ? renderMarkdown(translation.frontmatter, translation.blocks)
      : null,
    initialized: true
  };
}

export function classifyThreeWay(
  cached: CachedBlock,
  currentSource: string | null,
  currentTranslation: string | null
): TranslationState {
  const sourceChanged = currentSource !== cached.lastSource;
  const translationChanged =
    cached.lastGenerated !== null &&
    currentTranslation !== cached.lastGenerated;
  if (sourceChanged && translationChanged) return "conflict";
  if (sourceChanged) return "pending";
  if (translationChanged) return "manual";
  return "clean";
}

export function adoptManualTranslations(
  cache: FileCache,
  current: Record<string, string>,
  currentSources: Record<string, string>
): boolean {
  let changed = false;
  for (const block of cache.blocks) {
    const source = currentSources[block.id];
    const translation = current[block.id];
    if (source !== block.lastSource || block.lastGenerated === null) continue;
    if (translation === undefined) {
      block.lastGenerated = null;
      changed = true;
    } else if (translation !== block.lastGenerated) {
      block.lastGenerated = translation;
      changed = true;
    }
  }
  return changed;
}
