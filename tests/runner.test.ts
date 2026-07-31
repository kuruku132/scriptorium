import { describe, expect, it } from "vitest";
import { parseTranslationResponse } from "../src/modules/translation/runner";

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
});
