// W4 app-A Task 16 (SP-UI): the product's standalone-stage predicate. Expected values come from the rulebook, never the
// module: RB4-S6 (X-SP-6, ruling 269) — a stepladder and a page playoff are not offered standalone; RB4-S7 (X-SP-7) — both
// stay offered as final stages, i.e. WITH a progression. The kind list is the API's own (`api-v1/schemas/common.ts` StageKind),
// so a kind added there is swept here without an edit.
import { describe, expect, it } from "vitest";
import { StageKind } from "@/server/api-v1/schemas";
import { STANDALONE_REFUSED_KINDS, standaloneStageRefusal } from "@/lib/stage-standalone";
import { buildTemplateStages, STAGE_TEMPLATES } from "@/lib/format-templates";

// RB4-S6, typed here (not read back from the module under test): the two kinds that only seed from a table.
const RULEBOOK_TABLE_ONLY = { stepladder: "STEPLADDER_NEEDS_TABLE_SOURCE", page_playoff: "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE" } as const;
const PROGRESSION = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "on_complete" };

describe("standaloneStageRefusal (X-SP-6 / X-SP-7)", () => {
  it("X-SP-6 a standalone stepladder or page playoff is refused by name — null and absent progression alike, every other kind taken (counted over the API's kinds)", () => {
    let refused = 0;
    let taken = 0;
    for (const kind of StageKind.options) {
      const want = (RULEBOOK_TABLE_ONLY as Record<string, string>)[kind] ?? null;
      expect(standaloneStageRefusal({ kind, progression: null }), `${kind}, progression null`).toBe(want);
      expect(standaloneStageRefusal({ kind, progression: undefined }), `${kind}, no progression`).toBe(want);
      if (want === null) taken++;
      else refused++;
    }
    // Anti-vacuity: both arms reached, and the refused set is exactly the rulebook's two.
    expect(refused, "kinds refused standalone").toBe(2);
    expect(taken, "kinds taken standalone").toBe(StageKind.options.length - 2);
    expect(taken).toBeGreaterThan(0);
  });

  it("X-SP-7 with a progression neither kind is refused (the final-stage shape), and no other kind ever is", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      expect(standaloneStageRefusal({ kind, progression: PROGRESSION }), kind).toBeNull();
      checked++;
    }
    expect(checked, "kinds checked with a progression").toBe(StageKind.options.length);
  });

  it("X-SP-7 every builder template's stages pass: the final-stage stepladder and page playoff carry a progression (counted)", () => {
    let stages = 0;
    let finals = 0;
    for (const t of STAGE_TEMPLATES) {
      for (const s of buildTemplateStages(t.key, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 })) {
        expect(standaloneStageRefusal({ kind: s.kind, progression: s.progression ?? null }), `${t.key}: ${s.kind}`).toBeNull();
        stages++;
        if (s.kind in RULEBOOK_TABLE_ONLY) finals++;
      }
    }
    // group_stepladder, group_playoffs and swiss_playoff each hold one table-only final stage.
    expect(finals, "table-only final stages built by the builder").toBe(3);
    expect(stages).toBeGreaterThan(finals);
  });

  it("a prototype name or a near-miss spelling is no refused kind (own keys only)", () => {
    for (const kind of ["toString", "__proto__", "constructor", "hasOwnProperty", "Stepladder", "page-playoff", ""]) {
      expect(standaloneStageRefusal({ kind, progression: null }), kind).toBeNull();
    }
  });

  it("the table names exactly the rulebook's kinds and codes", () => {
    expect({ ...STANDALONE_REFUSED_KINDS }).toEqual(RULEBOOK_TABLE_ONLY);
  });
});
