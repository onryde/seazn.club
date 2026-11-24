// Add stage after groups: the refusals raised AT SAVE read their own copy (`seeding.<CODE>.<phase>`), not the draw-time copy - which
// says "Results are in, so the format can't be changed. Delete the stage ..." and is not true yet at save. Each says what WOULD work
// (the counts it names are the ones `groupTakeRefusal` computed), or says nothing can, never an impossible remedy (RB5-D4's lesson).
// The vars are the REAL refusals' (`groupTakeRefusal`), not hand-typed. Four locales; anti-vacuity counts every cell.
import { describe, expect, it } from "vitest";
import { groupsKoTake } from "@/lib/format-templates";
import { groupTakeRefusal, type GroupTakeRefusal } from "@/lib/group-take-refusal";
import { LOCALES } from "@/lib/i18n-constants";
import { seedingErrorMessage } from "@/lib/seeding-error";

// "can": the refusals a shape CAN draw (the form's reading). The save door's own default ("always") refuses only what every outcome
// refuses, which the builder's space never reaches for a separation (see group-take-refusal.test.ts); the copy is the same text either way.
const ask = (destKind: string, pools: number, q: number, take = groupsKoTake(q, pools)) => groupTakeRefusal({ destKind, placement: "rank_order", pools, take }, "can")!;

/** One real refusal of each save variant: separation with options, separation with none, too large (counts), too large (groups),
 *  page playoff, too few. */
function refusals(): { name: string; r: GroupTakeRefusal }[] {
  return [
    { name: "separation + options", r: ask("knockout", 4, 5) },
    { name: "too large (qualifiers)", r: ask("knockout", 4, 33) },
    { name: "too large (groups)", r: ask("knockout", 9, 9) },
    { name: "page playoff", r: ask("page_playoff", 4, 8) },
    { name: "too few", r: ask("knockout", 4, 0, [{ kind: "bestNth", nth: 1, count: 1 }]) },
    // A refusal with no count to pick: a field of one offers no count at all (the real call; the server's cut check answers a field this
    // small first, so this is the predicate's own empty case).
    { name: "separation, nothing to pick", r: groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: groupsKoTake(5, 4), entrants: 1 }, "can")! },
  ];
}

describe("the save copy of the cross-pool refusals", () => {
  it("premise: the refusals are the codes and phases the copy is keyed by (else the sweep below is vacuous)", () => {
    expect(refusals().map((x) => `${x.r.code}/${x.r.vars.phase ?? "-"}`)).toEqual([
      "SEEDING_POOL_SEPARATION_IMPOSSIBLE/save",
      "SEEDING_CROSS_POOL_DRAW_TOO_LARGE/save",
      "SEEDING_CROSS_POOL_DRAW_TOO_LARGE/saveGroups",
      "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR/save",
      "SEEDING_QUALIFY_TOO_FEW/-",
      "SEEDING_POOL_SEPARATION_IMPOSSIBLE/saveNone",
    ]);
  });

  it("every locale x refusal: its own copy (not the draw-time one), every slot filled, the numbers it names present", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const { name, r } of refusals()) {
        const out = seedingErrorMessage(locale, r.code, "SHOULD_NOT_SEE_FALLBACK", r.vars);
        const label = `${locale} ${name}`;
        expect(out, label).not.toBe("SHOULD_NOT_SEE_FALLBACK");
        expect(out.startsWith("seeding."), `${label}: a missing key reads back as its own name`).toBe(false);
        expect(out, `${label}: every slot filled`).not.toMatch(/\{\w+\}/);
        if (r.vars.phase !== undefined) {
          const drawTime = seedingErrorMessage(locale, r.code, "x", { ...r.vars, phase: undefined as never });
          expect(out, `${label}: not the draw-time copy`).not.toBe(drawTime);
        }
        if (typeof r.vars.options === "string" && r.vars.options !== "") expect(out, `${label}: names the counts that would work`).toContain(r.vars.options);
        if (r.vars.phase === "save" && r.code === "SEEDING_CROSS_POOL_DRAW_TOO_LARGE") expect(out, `${label}: names the most to pick`).toContain(String(r.vars.maxEntrants));
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 6 refusals").toBe(24);
  });

  it("english: a refusal at save never says results are in or tells the organiser to delete a stage that does not exist yet", () => {
    let checked = 0;
    for (const { name, r } of refusals()) {
      const out = seedingErrorMessage("en", r.code, "x", r.vars);
      expect(out, name).not.toMatch(/results are in|delete the|format can't be changed/i);
      expect(out, name).toMatch(/nothing was saved/i);
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("a refusal that has nothing to pick says so instead of inviting a pick", () => {
    const none = refusals().find((x) => x.name === "separation, nothing to pick")!;
    const groups = refusals().find((x) => x.name === "too large (groups)")!;
    for (const x of [none, groups]) expect(seedingErrorMessage("en", x.r.code, "x", x.r.vars), x.name).not.toMatch(/pick/i);
    expect(seedingErrorMessage("en", refusals()[0]!.r.code, "x", refusals()[0]!.r.vars), "the one with options does").toMatch(/pick/i);
  });
});
