// W5 app PR B, Task 7 (X-ADJ-1, X-ADJ-3, X-ADJ-4; C5, C7): the footnote's ledger fold and its words, pinned against the ENGINE -
// the notes the footnote prints must be the notes the engine writes on the pool (`PoolTable.notes`), unit included, for every sport
// in the registry; the stage gate must refuse exactly what C5 names.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { adjustmentUnitOf, completeTableStage, type TableStage } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import fr from "@/dictionaries/fr/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import {
  POINTS_ADJUSTMENT_ROW,
  POINTS_ADJUSTMENT_VOIDED_ROW,
  activePointsAdjustments,
  adjustmentNoteText,
  adjustmentNotesFor,
  withCarriedAdjustments,
  type AdjustmentCarry,
  type AdjustmentLedgerRow,
} from "@/lib/points-adjustment-note";
import { adjustRefusalCode, pointsAdjustmentOffered } from "@/lib/points-adjustment-offer";
import { REAL_TABLE_KINDS } from "@/server/usecases/stages/types";

const S = "stage-1";
const row = (seq: number, payload: Record<string, unknown>, type = POINTS_ADJUSTMENT_ROW): AdjustmentLedgerRow => ({
  seq,
  type,
  payload,
  at: `2026-11-${String(10 + seq).padStart(2, "0")}T12:00:00.000Z`,
});
const adj = (seq: number, entrant: string, delta: number, reason = "Fielded an ineligible player") =>
  row(seq, { stage_id: S, entrant_id: entrant, delta, reason, unit: "points", points_unit: "whole" });

describe("activePointsAdjustments (the ledger fold both readers share)", () => {
  it("the empty case: no rows, no adjustment", () => {
    expect(activePointsAdjustments([])).toEqual([]);
  });

  it("two adjustments of one entrant STACK; a void takes exactly the row it names; ledger order whatever the read order", () => {
    const ledger = [adj(3, "a", -1), adj(1, "a", -3), adj(2, "b", 2), row(4, { voids_seq: 2 }, POINTS_ADJUSTMENT_VOIDED_ROW)];
    const out = activePointsAdjustments(ledger);
    expect(out.map((r) => [r.seq, r.entrant_id, r.delta])).toEqual([
      [1, "a", -3],
      [3, "a", -1],
    ]);
    expect(out[0]!.at).toBe(ledger[1]!.at);
  });

  it("a row the engine would refuse is never read (zero, non-finite, reasonless, no unit): it must not brick the fold", () => {
    const bad = [
      adj(1, "a", 0),
      row(2, { stage_id: S, entrant_id: "a", delta: Number.NaN, reason: "x", unit: "points", points_unit: "whole" }),
      adj(3, "a", -1, "   "),
      row(4, { stage_id: S, entrant_id: "a", delta: -1, reason: "x", points_unit: "whole" }),
      row(5, { stage_id: S, delta: -1, reason: "x", unit: "points", points_unit: "whole" }),
    ];
    expect(activePointsAdjustments(bad)).toEqual([]);
    expect(bad).toHaveLength(5);
  });
});

describe("the footnote is the engine's note (X-ADJ-1; RB5-T7, RB5-T15), every sport in the registry", () => {
  it("same entrants, order, delta, unit, reason and date as `PoolTable.notes`", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const cfg = m.configSchema.parse(Object.values(m.variants)[0]);
      const tiebreakers = (m.defaultTiebreakers as (k: "league", c: unknown) => TableStage["rules"]["tiebreakers"])("league", cfg);
      const unit = adjustmentUnitOf(tiebreakers);
      const ids = ["e1", "e2", "e3"];
      const ledger = [adj(1, "e1", -3), adj(2, "e2", 1, "Bonus for fair play"), adj(3, "e1", -1, "Late kick-off")].map((r) => ({
        ...r,
        payload: { ...(r.payload as object), unit },
      }));
      const records = activePointsAdjustments(ledger);
      const stage = {
        id: S,
        kind: "league",
        entrants: ids,
        rules: { points: m.tablePointsRule(cfg, "league"), tiebreakers },
        pools: new Map(ids.map((id) => [id, ""])),
        adjustments: records.map((r) => ({ entrantId: r.entrant_id, delta: r.delta, reason: r.reason, at: r.at })),
      } as unknown as TableStage;
      const pool = completeTableStage(stage, []).tables.pools[0]!;
      const engineNotes = (pool.notes ?? []).map((n) => [n.entrantId, n.delta, n.unit, n.reason, n.at]);
      const ours = adjustmentNotesFor(S, pool.rows.map((r) => r.entrantId), records, {}).map((n) => [n.entrantId, n.delta, n.unit, n.reason, n.at]);
      expect(ours, m.key).toEqual(engineNotes);
      expect(engineNotes, m.key).toHaveLength(3);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a table lists only its own entrants' notes; another stage's rows never appear", () => {
    const records = activePointsAdjustments([adj(1, "a", -3), adj(2, "z", -1), row(3, { ...(adj(3, "a", -2).payload as object), stage_id: "other" })]);
    expect(adjustmentNotesFor(S, ["a", "b"], records, { a: "Marsh Lane" }).map((n) => [n.name, n.delta])).toEqual([["Marsh Lane", -3]]);
    expect(adjustmentNotesFor(S, [], records, {})).toEqual([]);
  });
});

describe("the footnote's words (R24 pick 15 A; C7)", () => {
  const msgOf = (dict: unknown) => (key: TKey, vars?: Record<string, string | number>) => t(dict as Dict, key, vars);
  const dateOf = () => "16 Nov 2026";
  const note = (delta: number, unit: "points" | "wins", pointsUnit: "whole" | "half" = "whole") => ({
    seq: 1,
    entrantId: "a",
    name: "Marsh Lane",
    delta,
    unit,
    pointsUnit,
    reason: "fielded an ineligible player",
    at: "2026-11-16T10:00:00.000Z",
  });

  it("points, wins (a match's worth) and half points, singular and plural, signed with a true minus", () => {
    const en_ = msgOf(en);
    const line = (n: ReturnType<typeof note>) => {
      const x = adjustmentNoteText(n, en_, dateOf, "en");
      return `${x.lead} ${x.body}`;
    };
    expect(line(note(-3, "points"))).toBe("Marsh Lane: −3 points, fielded an ineligible player, 16 Nov 2026.");
    expect(line(note(1, "points"))).toBe("Marsh Lane: +1 point, fielded an ineligible player, 16 Nov 2026.");
    expect(line(note(-1, "wins"))).toBe("Marsh Lane: −1 win, fielded an ineligible player, 16 Nov 2026.");
    expect(line(note(-2, "wins"))).toBe("Marsh Lane: −2 wins, fielded an ineligible player, 16 Nov 2026.");
    // a half-point rule stores half-points: 2 stored is one point, 1 stored is half of one
    expect(line(note(-2, "points", "half"))).toBe("Marsh Lane: −1 point, fielded an ineligible player, 16 Nov 2026.");
    expect(line(note(-1, "points", "half"))).toBe("Marsh Lane: −½ points, fielded an ineligible player, 16 Nov 2026.");
  });

  it("another language picks its own plural (fr: 1 is singular)", () => {
    const x = adjustmentNoteText(note(-1, "points"), msgOf(fr), dateOf, "fr");
    expect(`${x.lead} ${x.body}`).toBe("Marsh Lane : −1 point, fielded an ineligible player, 16 Nov 2026.");
  });
});

describe("B3 ruling 3: a carried table names the adjustment it carries", () => {
  const msgOf = (dict: unknown) => (key: TKey, vars?: Record<string, string | number>) => t(dict as Dict, key, vars);
  const dateOf = () => "16 Nov 2026";
  // stage-1's ledger: a points adjustment on a, a wins adjustment on b, a points adjustment on c (c is not carried)
  const records = activePointsAdjustments([
    adj(1, "a", -3),
    row(2, { stage_id: S, entrant_id: "b", delta: -1, reason: "Late kick-off", unit: "wins", points_unit: "whole" }),
    adj(3, "c", -2),
  ]);
  const carry = (mode: "points" | "full"): AdjustmentCarry => ({ into: "stage-2", from: S, fromName: "Group stage", mode, entrants: ["a", "b"] });

  it("the empty case: no carry, the records unchanged", () => {
    expect(records).toHaveLength(3);
    expect(withCarriedAdjustments(records, [])).toEqual(records);
  });

  it("a points carry takes a points adjustment of a carried entrant - never a wins one (it carries points only), never an uncarried entrant's", () => {
    const out = withCarriedAdjustments(records, [carry("points")]);
    const carried = out.filter((r) => r.stage_id === "stage-2");
    expect(carried.map((r) => [r.seq, r.entrant_id, r.carried_from])).toEqual([[1, "a", { stage_id: S, stage_name: "Group stage" }]]);
    expect(out.filter((r) => r.stage_id === S), "the source table keeps its own three").toHaveLength(3);
  });

  it("a full carry takes both units", () => {
    const carried = withCarriedAdjustments(records, [carry("full")]).filter((r) => r.stage_id === "stage-2");
    expect(carried.map((r) => r.entrant_id)).toEqual(["a", "b"]);
  });

  it("the destination's footnote says where it came from; the source's does not (4 locales carry the key)", () => {
    const out = withCarriedAdjustments(records, [carry("full")]);
    const names = { a: "Marsh Lane", b: "Hill Park", c: "Dale" };
    const [dest] = adjustmentNotesFor("stage-2", ["a"], out, names);
    const [source] = adjustmentNotesFor(S, ["a"], out, names);
    const line = (n: typeof dest, dict: unknown, locale: string) => {
      const x = adjustmentNoteText(n!, msgOf(dict), dateOf, locale);
      return `${x.lead} ${x.body}`;
    };
    expect(line(dest, en, "en")).toBe("Marsh Lane: −3 points carried from Group stage, Fielded an ineligible player, 16 Nov 2026.");
    expect(line(source, en, "en")).toBe("Marsh Lane: −3 points, Fielded an ineligible player, 16 Nov 2026.");
    const wins = adjustmentNotesFor("stage-2", ["b"], out, names)[0]!;
    expect(line(wins, en, "en")).toBe("Hill Park: −1 win carried from Group stage, Late kick-off, 16 Nov 2026.");
    expect(line(dest, fr, "fr")).toContain("Group stage");
  });
});

describe("C5: the one gate the write and the desk's offer read", () => {
  const KINDS = ["league", "group", "swiss", "americano", "ladder", "knockout", "double_elim", "stepladder", "page_playoff"];
  it("offered on a started, not-complete league, group or Swiss table only - every kind × stage status × division status", () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const status of ["pending", "active", "complete"]) {
        for (const division of ["setup", "scheduled", "active", "completed"]) {
          const code = adjustRefusalCode({ kind, status }, division);
          const expected =
            !REAL_TABLE_KINDS.has(kind) ? "RR_ADJUST_NOT_TABLE" : status === "complete" ? "RR_ADJUST_STAGE_COMPLETE" : status === "active" && division === "active" ? null : "RR_ADJUST_NOT_STARTED";
          expect(code, `${kind}/${status}/${division}`).toBe(expected);
          expect(pointsAdjustmentOffered({ kind, status }, division)).toBe(expected === null);
          checked++;
        }
      }
    }
    expect(checked).toBe(KINDS.length * 12);
    expect(pointsAdjustmentOffered({ kind: "league", status: "active" }, undefined), "no division facts: never offered").toBe(false);
  });
});
