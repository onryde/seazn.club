// W2d Task 15 carry item I3 — `keptPinnedOf`, the read of PATCH /divisions/{id}'s `stagesKeptPinned` that division settings
// says back to the organiser ("{stage} keeps the order and points it started with"). The wire shape is the server's own
// schema (`KeptPinnedStageS`), parsed here so a drift in either moves this test. The line it feeds is the browser's
// (e2e/stage-tiebreaks-w2d.spec.ts): the list is state set after a save, which a static render never reaches.
import { describe, expect, it } from "vitest";
import { KeptPinnedStageS } from "@/server/api-v1/schemas";
import { keptPinnedOf } from "@/lib/rule-errors";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("keptPinnedOf", () => {
  it("reads the server's entries in its order (each one the server schema accepts)", () => {
    const wire = { id: "d", refused: [], stagesKeptPinned: [{ stageId: B, name: "Groups" }, { stageId: A, name: "League" }] };
    for (const e of wire.stagesKeptPinned) expect(KeptPinnedStageS.safeParse(e).success, "premise: a wire entry").toBe(true);
    expect(keptPinnedOf(wire)).toEqual([{ stageId: B, name: "Groups" }, { stageId: A, name: "League" }]);
  });

  it("the empty case: an empty list, an older server without the field, a non-object 200 — nothing to say", () => {
    expect(keptPinnedOf({ stagesKeptPinned: [] })).toEqual([]);
    expect(keptPinnedOf({ id: "d", refused: [] })).toEqual([]);
    for (const data of [null, undefined, "ok", 3, []]) expect(keptPinnedOf(data), String(data)).toEqual([]);
    expect(keptPinnedOf({ stagesKeptPinned: "League" }), "not a list").toEqual([]);
  });

  it("skips an entry it cannot say (no name, no id, not an object) and keeps the rest; a stage named twice is said once", () => {
    const data = {
      stagesKeptPinned: [{ stageId: A }, { name: "Nameless id" }, "League", null, { stageId: B, name: 7 }, { stageId: A, name: "League" }, { stageId: A, name: "League again" }],
    };
    expect(keptPinnedOf(data)).toEqual([{ stageId: A, name: "League" }]);
  });

  it("the sentence it feeds names the stage in every locale ({stage} placeholder kept)", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries({ en: enUi, es: esUi, fr: frUi, nl: nlUi }) as [string, Record<string, string>][]) {
      expect(d["divset.keptPinned"], locale).toContain("{stage}");
      checked++;
    }
    expect(checked, "locales").toBe(4);
  });
});
