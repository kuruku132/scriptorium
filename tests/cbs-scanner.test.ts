import { describe, expect, it } from "vitest";
import { scanCbsVariables } from "../src/modules/cbs/scanner";

describe("scanCbsVariables", () => {
  it("extracts var:: and toggle:: references", () => {
    const r = scanCbsVariables("{{#when var::A}}Y{{/when}} {{#when toggle::T}}Y{{/when}}");
    expect(r.chatVars).toEqual(["A"]);
    expect(r.toggles).toEqual(["T"]);
  });

  it("extracts getvar/setvar/setdefaultvar/addvar/tempvar/declare names as chat vars", () => {
    const r = scanCbsVariables(
      "{{getvar::A}}{{setvar::B::1}}{{setdefaultvar::C::1}}{{addvar::D::1}}{{tempvar::E}}{{declare::F}}"
    );
    expect(r.chatVars).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(r.toggles).toEqual([]);
  });

  it("extracts getglobalvar/setglobalvar names as chat vars", () => {
    const r = scanCbsVariables("{{getglobalvar::toggle_SFW}}{{setglobalvar::G::1}}");
    expect(r.chatVars).toEqual(["G", "toggle_SFW"]);
    expect(r.toggles).toEqual([]);
  });

  it("does not double-count var:: inside getglobalvar::", () => {
    // getglobalvar 안의 var:: 부분문자열은 이름 경계가 아니므로 var:: 그룹이 잡지 않는다.
    const r = scanCbsVariables("{{getglobalvar::toggle_model}}");
    expect(r.chatVars).toEqual(["toggle_model"]);
  });

  it("extracts both sides of vis/visnot as chat vars", () => {
    const r = scanCbsVariables("{{#when A::vis::B}}Y{{/when}} {{#when A::visnot::B}}Y{{/when}}");
    expect(r.chatVars).toEqual(["A", "B"]);
  });

  it("extracts both sides of tis/tisnot as toggles", () => {
    const r = scanCbsVariables("{{#when A::tis::B}}Y{{/when}} {{#when A::tisnot::B}}Y{{/when}}");
    expect(r.toggles).toEqual(["A", "B"]);
  });

  it("dedupes and sorts", () => {
    const r = scanCbsVariables("{{#when var::B}}Y{{/when}} {{#when var::A}}Y{{/when}} {{#when var::B}}Y{{/when}}");
    expect(r.chatVars).toEqual(["A", "B"]);
  });

  it("ignores fenced code blocks", () => {
    const r = scanCbsVariables(
      "```\n{{#when var::A}}Y{{/when}}\n```\n{{#when var::B}}Y{{/when}}"
    );
    expect(r.chatVars).toEqual(["B"]);
  });

  it("returns empty arrays for empty input", () => {
    expect(scanCbsVariables("")).toEqual({ chatVars: [], toggles: [] });
    expect(scanCbsVariables("plain text only")).toEqual({ chatVars: [], toggles: [] });
  });
});