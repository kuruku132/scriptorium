import {
  extractKeys,
  stableHash
} from "../../shared/markdown";
import type {
  CachedBlock,
  ChangeGroup,
  ChangeKind,
  FileCache,
  FileChangePlan,
  MarkdownBlock,
  ParsedMarkdown,
  TranslationBatch,
  TranslationRequestBlock
} from "../../shared/types";
import {
  alignTranslations,
  classifyThreeWay
} from "./cache";

interface MatchResult {
  current: MarkdownBlock[];
  lcsPairs: Array<[number, number]>;
  movePairs: Array<[number, number]>;
  matchedOld: Set<number>;
  matchedNew: Set<number>;
}

function signature(block: Pick<MarkdownBlock, "kind" | "text">): string {
  return `${block.kind}\0${block.text}`;
}

function previousBlocks(cache: FileCache): MarkdownBlock[] {
  return cache.blocks.map((block, index) => ({
    id: block.id,
    kind: block.kind,
    text: block.lastSource,
    headingPath: [...block.headingPath],
    startLine: index,
    endLine: index
  }));
}

function lcsExact(
  oldBlocks: MarkdownBlock[],
  newBlocks: MarkdownBlock[]
): Array<[number, number]> {
  const rows = oldBlocks.length + 1;
  const columns = newBlocks.length + 1;
  const table = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0)
  );

  for (let oldIndex = oldBlocks.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newBlocks.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] =
        signature(oldBlocks[oldIndex]!) === signature(newBlocks[newIndex]!)
          ? 1 + (table[oldIndex + 1]?.[newIndex + 1] ?? 0)
          : Math.max(
              table[oldIndex + 1]?.[newIndex] ?? 0,
              table[oldIndex]?.[newIndex + 1] ?? 0
            );
    }
  }

  const pairs: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldBlocks.length && newIndex < newBlocks.length) {
    if (signature(oldBlocks[oldIndex]!) === signature(newBlocks[newIndex]!)) {
      pairs.push([oldIndex, newIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (
      (table[oldIndex + 1]?.[newIndex] ?? 0) >=
      (table[oldIndex]?.[newIndex + 1] ?? 0)
    ) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }
  return pairs;
}

function matchBlocks(cache: FileCache, parsed: ParsedMarkdown): MatchResult {
  const oldBlocks = previousBlocks(cache);
  const current = parsed.blocks.map((block) => ({
    ...block,
    headingPath: [...block.headingPath]
  }));
  const lcsPairs = lcsExact(oldBlocks, current);
  const matchedOld = new Set(lcsPairs.map(([index]) => index));
  const matchedNew = new Set(lcsPairs.map(([, index]) => index));
  const movePairs: Array<[number, number]> = [];

  for (const [oldIndex, newIndex] of lcsPairs) {
    const oldBlock = oldBlocks[oldIndex];
    const newBlock = current[newIndex];
    if (oldBlock && newBlock) newBlock.id = oldBlock.id;
  }

  const availableBySignature = new Map<string, number[]>();
  for (let oldIndex = 0; oldIndex < oldBlocks.length; oldIndex += 1) {
    if (matchedOld.has(oldIndex)) continue;
    const key = signature(oldBlocks[oldIndex]!);
    const list = availableBySignature.get(key) ?? [];
    list.push(oldIndex);
    availableBySignature.set(key, list);
  }
  for (let newIndex = 0; newIndex < current.length; newIndex += 1) {
    if (matchedNew.has(newIndex)) continue;
    const list = availableBySignature.get(signature(current[newIndex]!));
    const oldIndex = list?.shift();
    if (oldIndex === undefined) continue;
    matchedOld.add(oldIndex);
    matchedNew.add(newIndex);
    movePairs.push([oldIndex, newIndex]);
    current[newIndex]!.id = oldBlocks[oldIndex]!.id;
  }

  return { current, lcsPairs, movePairs, matchedOld, matchedNew };
}

function changeKind(oldCount: number, newCount: number): ChangeKind {
  if (oldCount === 0) return "insert";
  if (newCount === 0) return "delete";
  if (oldCount === 1 && newCount > 1) return "split";
  if (oldCount > 1 && newCount === 1) return "merge";
  return "modify";
}

function buildChange(
  filePath: string,
  kind: ChangeKind,
  oldBlocks: MarkdownBlock[],
  newBlocks: MarkdownBlock[],
  contextBefore: MarkdownBlock | null,
  contextAfter: MarkdownBlock | null,
  selectedIds: Set<string>,
  state: ChangeGroup["state"],
  message?: string
): ChangeGroup {
  const seed = [
    filePath,
    kind,
    ...oldBlocks.map((block) => block.id),
    "=>",
    ...newBlocks.map((block) => block.id)
  ].join("\0");
  const id = `chg-${stableHash(seed)}`;
  const headingPath =
    newBlocks[0]?.headingPath ?? oldBlocks[0]?.headingPath ?? [];
  return {
    id,
    kind,
    filePath,
    blockIds: [
      ...new Set([
        ...oldBlocks.map((block) => block.id),
        ...newBlocks.map((block) => block.id)
      ])
    ],
    oldBlocks,
    newBlocks,
    headingPath,
    contextBefore,
    contextAfter,
    selected: selectedIds.has(id),
    state,
    ...(message === undefined ? {} : { message })
  };
}

function nearestMatchedBefore(
  current: MarkdownBlock[],
  matched: Set<number>,
  index: number
): MarkdownBlock | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (matched.has(cursor)) return current[cursor] ?? null;
  }
  return null;
}

function nearestMatchedAfter(
  current: MarkdownBlock[],
  matched: Set<number>,
  index: number
): MarkdownBlock | null {
  for (let cursor = index; cursor < current.length; cursor += 1) {
    if (matched.has(cursor)) return current[cursor] ?? null;
  }
  return null;
}

export function planFileChanges(options: {
  sourcePath: string;
  translationPath: string;
  basename: string;
  source: ParsedMarkdown;
  translation: ParsedMarkdown | null;
  cache: FileCache;
  selectedChangeIds: Set<string>;
}): FileChangePlan {
  const {
    sourcePath,
    translationPath,
    basename,
    source,
    translation,
    cache,
    selectedChangeIds
  } = options;
  const oldBlocks = previousBlocks(cache);
  const matched = matchBlocks(cache, source);
  source.blocks = matched.current;
  const alignment = alignTranslations(cache.blocks, translation);
  const oldIndexById = new Map(
    oldBlocks.map((block, index) => [block.id, index] as const)
  );
  const stateById = new Map<string, ChangeGroup["state"]>();

  for (const block of source.blocks) {
    const oldIndex = oldIndexById.get(block.id);
    if (oldIndex === undefined) {
      stateById.set(block.id, "pending");
      continue;
    }
    const cachedBlock = cache.blocks[oldIndex];
    if (!cachedBlock) continue;
    stateById.set(
      block.id,
      classifyThreeWay(
        cachedBlock,
        block.text,
        alignment.byBlockId[block.id] ?? null
      )
    );
  }

  const changes: ChangeGroup[] = [];
  const boundaries: Array<[number, number]> = [
    [-1, -1],
    ...matched.lcsPairs,
    [oldBlocks.length, source.blocks.length]
  ];
  for (let boundary = 0; boundary < boundaries.length - 1; boundary += 1) {
    const left = boundaries[boundary]!;
    const right = boundaries[boundary + 1]!;
    const oldIndices: number[] = [];
    const newIndices: number[] = [];
    for (let index = left[0] + 1; index < right[0]; index += 1) {
      if (!matched.matchedOld.has(index)) oldIndices.push(index);
    }
    for (let index = left[1] + 1; index < right[1]; index += 1) {
      if (!matched.matchedNew.has(index)) newIndices.push(index);
    }
    if (oldIndices.length === 0 && newIndices.length === 0) continue;

    const beforeIndex = left[1] + 1;
    const afterIndex = right[1];
    const oldChangeBlocks = oldIndices
      .map((index) => oldBlocks[index])
      .filter((block): block is MarkdownBlock => block !== undefined);
    const newChangeBlocks = newIndices
      .map((index) => source.blocks[index])
      .filter((block): block is MarkdownBlock => block !== undefined);

    if (oldChangeBlocks.length === 1 && newChangeBlocks.length === 1) {
      newChangeBlocks[0]!.id = oldChangeBlocks[0]!.id;
      stateById.set(
        newChangeBlocks[0]!.id,
        classifyThreeWay(
          cache.blocks[oldIndices[0]!]!,
          newChangeBlocks[0]!.text,
          alignment.byBlockId[newChangeBlocks[0]!.id] ?? null
        )
      );
    }
    const states = [
      ...oldChangeBlocks.map((block) => stateById.get(block.id)),
      ...newChangeBlocks.map((block) => stateById.get(block.id))
    ];
    const state = states.includes("conflict") ? "conflict" : "pending";
    changes.push(
      buildChange(
        sourcePath,
        changeKind(oldChangeBlocks.length, newChangeBlocks.length),
        oldChangeBlocks,
        newChangeBlocks,
        nearestMatchedBefore(source.blocks, matched.matchedNew, beforeIndex),
        nearestMatchedAfter(source.blocks, matched.matchedNew, afterIndex),
        selectedChangeIds,
        state
      )
    );
  }

  for (const [oldIndex, newIndex] of matched.movePairs) {
    const oldBlock = oldBlocks[oldIndex];
    const newBlock = source.blocks[newIndex];
    if (!oldBlock || !newBlock) continue;
    changes.push(
      buildChange(
        sourcePath,
        "move",
        [oldBlock],
        [newBlock],
        nearestMatchedBefore(source.blocks, matched.matchedNew, newIndex),
        nearestMatchedAfter(source.blocks, matched.matchedNew, newIndex + 1),
        selectedChangeIds,
        stateById.get(newBlock.id) ?? "clean",
        "내용이 같은 이동은 기존 번역을 재사용합니다."
      )
    );
  }

  const currentKeys = extractKeys(source, basename);
  const metadataChanged =
    JSON.stringify(currentKeys) !== JSON.stringify(cache.sourceKeys);
  if (metadataChanged) {
    changes.push(
      buildChange(
        sourcePath,
        "metadata",
        [],
        [],
        null,
        null,
        selectedChangeIds,
        "pending",
        `keys: ${currentKeys.join(", ")}`
      )
    );
  }

  const orphanHash =
    alignment.orphanTexts.length > 0
      ? stableHash(alignment.orphanTexts.join("\0"))
      : null;
  if (
    orphanHash &&
    orphanHash !== cache.acceptedOrphanHash
  ) {
    changes.push(
      buildChange(
        sourcePath,
        "modify",
        alignment.orphanTexts.map((text, index) => ({
          id: `orphan-${stableHash(`${sourcePath}\0${index}\0${text}`)}`,
          kind: "paragraph",
          text,
          headingPath: [],
          startLine: index,
          endLine: index
        })),
        [],
        null,
        null,
        selectedChangeIds,
        "conflict",
        "기존 번역본에 대응되지 않는 고아 문단이 있습니다."
      )
    );
  }

  changes.sort((left, right) => {
    const leftLine = left.newBlocks[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.newBlocks[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
    return leftLine - rightLine;
  });

  return {
    sourcePath,
    translationPath,
    source,
    translation,
    changes,
    conflicts: changes.filter((change) => change.state === "conflict"),
    currentTranslations: {
      ...alignment.byBlockId,
      ...(cache.pendingTranslations ?? {})
    },
    pendingTranslationIds: Object.keys(cache.pendingTranslations ?? {}),
    metadataChanged
  };
}

function toRequestBlock(
  change: ChangeGroup,
  block: MarkdownBlock
): TranslationRequestBlock {
  return {
    id: block.id,
    source: block.text,
    kind: block.kind,
    headingPath: [...block.headingPath],
    contextBefore: change.contextBefore?.text ?? null,
    contextAfter: change.contextAfter?.text ?? null
  };
}

export function createTranslationBatches(
  plans: FileChangePlan[],
  maxCharacters = 12_000
): TranslationBatch[] {
  const batches: TranslationBatch[] = [];

  for (const file of plans) {
    const eligible = file.changes.filter(
      (change) =>
        change.state !== "conflict" &&
        change.kind !== "move" &&
        change.selected
    );
    let active: TranslationBatch | null = null;
    let activeCharacters = 0;

    const flush = () => {
      if (active) batches.push(active);
      active = null;
      activeCharacters = 0;
    };

    for (const change of eligible) {
      const pendingIds = new Set(file.pendingTranslationIds);
      const blocks = change.newBlocks
        .filter((block) => !pendingIds.has(block.id))
        .map((block) => toRequestBlock(change, block));
      const keys =
        change.kind === "metadata"
          ? extractKeys(
              file.source,
              file.sourcePath
                .split("/")
                .pop()
                ?.replace(/\.md$/i, "") ?? ""
            )
          : [];
      const pieces: Array<{
        block: TranslationRequestBlock | null;
        characters: number;
      }> =
        blocks.length > 0
          ? blocks.map((block) => ({
              block,
              characters:
                block.source.length +
                (block.contextBefore?.length ?? 0) +
                (block.contextAfter?.length ?? 0)
            }))
          : [{ block: null, characters: keys.join("").length }];

      for (const piece of pieces) {
        if (
          active &&
          activeCharacters > 0 &&
          activeCharacters + piece.characters > maxCharacters
        ) {
          flush();
        }
        if (!active) {
          active = {
            filePath: file.sourcePath,
            changeIds: [],
            blocks: [],
            translateKeys: []
          };
        }
        if (!active.changeIds.includes(change.id)) {
          active.changeIds.push(change.id);
        }
        if (piece.block) active.blocks.push(piece.block);
        active.translateKeys.push(...keys);
        active.translateKeys = [...new Set(active.translateKeys)];
        activeCharacters += piece.characters;
      }
    }
    flush();
  }
  return batches;
}

export function reconcileChangeSelections(
  plans: FileChangePlan[],
  selectedChangeIds: Iterable<string>,
  knownChangeIds: Iterable<string>
): { selectedChangeIds: string[]; knownChangeIds: string[] } {
  const current = plans
    .flatMap((file) => file.changes)
    .filter((change) => change.state !== "conflict");
  const currentIds = new Set(current.map((change) => change.id));
  const known = new Set(knownChangeIds);
  const selected = new Set(
    [...selectedChangeIds].filter((id) => currentIds.has(id))
  );

  for (const change of current) {
    if (!known.has(change.id)) selected.add(change.id);
    change.selected = selected.has(change.id);
  }

  return {
    selectedChangeIds: [...selected],
    knownChangeIds: [...currentIds]
  };
}

export function updateCacheAfterSuccess(options: {
  cache: FileCache;
  source: ParsedMarkdown;
  translations: Record<string, string>;
  translatedKeys?: string[];
  renderedTranslation: string;
}): void {
  const { cache, source, translations, translatedKeys, renderedTranslation } =
    options;
  const previous = new Map(cache.blocks.map((block) => [block.id, block]));
  cache.blocks = source.blocks.map((block): CachedBlock => {
    const old = previous.get(block.id);
    return {
      id: block.id,
      kind: block.kind,
      lastSource: block.text,
      lastGenerated:
        translations[block.id] ?? old?.lastGenerated ?? null,
      headingPath: [...block.headingPath]
    };
  });
  cache.sourceFrontmatterHash = stableHash(source.frontmatter?.raw ?? "");
  cache.sourceKeys = extractKeys(
    source,
    cache.sourcePath.split("/").pop()?.replace(/\.md$/i, "") ?? ""
  );
  if (translatedKeys) cache.translatedKeys = [...new Set(translatedKeys)];
  cache.lastSuccessfulTranslation = renderedTranslation;
}
