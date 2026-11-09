// W4 app-A Task 19 (X-LE-1, X-LE-2, X-LE-3 UI half): is "Add to bracket" offered on this stage's rail? On a started
// ROOT knockout that has its bracket (fixtures), until the bracket is finished; never on a fed knockout, never before
// Start (the ordinary add applies then), never on a finished bracket (no round-1 slot left).
//
// The stages come from the product's own templates (`buildTemplateStages`, the builder's source of truth): X-LE-1's three
// root-knockout templates and X-LE-2's two fed ones — never rows typed to fit the predicate. The division statuses come
// from the wire enum (`DivisionStatus`).
//
// Single-sport by nature: the predicate reads a stage's kind, progression, config, seq and status, and the division's
// status — no sport field reaches it.
import { describe, expect, it } from "vitest";
import { knockoutLateEntryOffered, type EntryStage } from "@/lib/open-entry-stages";
import { buildTemplateStages } from "@/lib/format-templates";
import { DivisionStatus } from "@/server/api-v1/schemas";

type Row = EntryStage & { status: string };
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
const rowsOf = (key: string, status = "active"): Row[] =>
  buildTemplateStages(key, KNOBS).map((d, i) => ({ ...d, seq: i + 1, status }));
const STARTED = ["active", "completed"];

describe("knockoutLateEntryOffered (T19: the rail's Add to bracket)", () => {
  it("the empty case first: a started root knockout with nothing generated offers nothing", () => {
    const rows = rowsOf("knockout");
    expect(knockoutLateEntryOffered({ stage: rows[0]!, division: rows, divisionStatus: "active", generated: false })).toBe(false);
  });

  it("a table over the division statuses × the five knockout templates × every stage of each", () => {
    const ROOT = ["knockout", "ko_plate", "qualifying_main"];
    const FED = ["league_ko", "groups_ko"];
    let checked = 0;
    let offered = 0;
    for (const key of [...ROOT, ...FED]) {
      for (const divisionStatus of DivisionStatus.options) {
        const rows = rowsOf(key);
        rows.forEach((stage, i) => {
          const expected = ROOT.includes(key) && i === 0 && STARTED.includes(divisionStatus);
          expect(knockoutLateEntryOffered({ stage, division: rows, divisionStatus, generated: true }), `${key} stage ${i + 1} (${stage.kind}) in a ${divisionStatus} division`).toBe(expected);
          if (expected) offered++;
          checked++;
        });
      }
    }
    expect(checked, "anti-vacuity: rows read").toBeGreaterThan(20);
    // Both answers are in the table: 3 root templates × the two started statuses.
    expect(offered).toBe(3 * 2);
  });

  it("not on a finished bracket (no round-1 slot left), in a started division", () => {
    const rows = rowsOf("knockout", "complete");
    expect(knockoutLateEntryOffered({ stage: rows[0]!, division: rows, divisionStatus: "active", generated: true })).toBe(false);
  });

  it("not on a fed knockout even with no progression stored (the stg census shape): the entry stage decides", () => {
    // A league then a knockout carrying no progression: still fed (it is not the division's entry stage).
    const rows: Row[] = [
      { kind: "league", progression: null, config: {}, seq: 1, status: "complete" },
      { kind: "knockout", progression: null, config: {}, seq: 2, status: "active" },
    ];
    expect(knockoutLateEntryOffered({ stage: rows[1]!, division: rows, divisionStatus: "active", generated: true })).toBe(false);
  });

  it("not on a root Swiss or a double elimination (their own rules, or none)", () => {
    let checked = 0;
    for (const kind of ["swiss", "double_elim", "league"]) {
      const rows: Row[] = [{ kind, progression: null, config: {}, seq: 1, status: "active" }];
      expect(knockoutLateEntryOffered({ stage: rows[0]!, division: rows, divisionStatus: "active", generated: true }), kind).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a second read of the same facts says the same (no hidden state)", () => {
    const rows = rowsOf("knockout");
    const args = { stage: rows[0]!, division: rows, divisionStatus: "active", generated: true };
    expect([knockoutLateEntryOffered(args), knockoutLateEntryOffered(args)]).toEqual([true, true]);
  });
});
