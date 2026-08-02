import { describe, expect, it } from "vitest";
import {
  parseGlossary,
  parseTranslationResponse,
  relevantGlossaryEntries
} from "../src/modules/translation/runner";

describe("translation response protocol", () => {
  it("parses fenced JSON while preserving block IDs", () => {
    const result = parseTranslationResponse(
      '```json\n{"blocks":[{"id":"b1","text":"번역"}],"keys":["키"]}\n```',
      ["b1"]
    );
    expect(result).toEqual({
      blocks: [{ id: "b1", text: "번역" }],
      keys: ["키"]
    });
  });

  it("rejects omitted block IDs", () => {
    expect(() =>
      parseTranslationResponse('{"blocks":[]}', ["missing"])
    ).toThrow(/누락/);
  });

  it("requires translated keys when metadata was requested", () => {
    expect(() =>
      parseTranslationResponse('{"blocks":[]}', [], true)
    ).toThrow(/keys/);
  });

  it("rejects duplicate or unrequested block IDs", () => {
    expect(() =>
      parseTranslationResponse(
        '{"blocks":[{"id":"b1","text":"a"},{"id":"b1","text":"b"}]}',
        ["b1"]
      )
    ).toThrow(/중복/);
    expect(() =>
      parseTranslationResponse(
        '{"blocks":[{"id":"b1","text":"a"},{"id":"extra","text":"b"}]}',
        ["b1"]
      )
    ).toThrow(/요청하지 않은/);
  });

  it("rejects extra top-level output such as references", () => {
    expect(() =>
      parseTranslationResponse(
        '{"blocks":[{"id":"b1","text":"번역"}],"references":["x"]}',
        ["b1"]
      )
    ).toThrow(/허용되지 않은/);
  });
});

describe("translation glossary", () => {
  it("parses A = B lines and ignores comments or invalid lines", () => {
    expect(parseGlossary("Sword = 검\n# note\ninvalid\nMana=마나")).toEqual([
      { source: "Sword", translation: "검" },
      { source: "Mana", translation: "마나" }
    ]);
  });

  it("selects only entries whose source or translation occurs in a batch", () => {
    expect(
      relevantGlossaryEntries("Sword = 검\nMana = 마나\nShield = 방패", [
        "The SWORD uses 마나."
      ])
    ).toEqual([
      { source: "Sword", translation: "검" },
      { source: "Mana", translation: "마나" }
    ]);
  });
});
