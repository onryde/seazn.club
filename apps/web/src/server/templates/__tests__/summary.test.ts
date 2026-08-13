// Pure display helpers for the wizard gallery card + detail sheet — no DOM,
// no i18n resolution (names/descriptions are resolved by the caller via
// useMsg/t against template.i18n.*Key; these only summarise STRUCTURE).
import { describe, expect, it } from "vitest";
import { getTemplate } from "../catalog";
import { templateEntrantTotal, templateStageKinds } from "../summary";

describe("template summary helpers", () => {
  it("sums entrant counts across every division", () => {
    const wc32 = getTemplate("wc32")!;
    expect(templateEntrantTotal(wc32)).toBe(32);
  });

  it("lists every stage kind in catalog order, across every division", () => {
    const wc32 = getTemplate("wc32")!;
    expect(templateStageKinds(wc32)).toEqual(["group", "knockout"]);
    const slam128 = getTemplate("slam128")!;
    expect(templateStageKinds(slam128)).toEqual(["knockout"]);
  });
});
