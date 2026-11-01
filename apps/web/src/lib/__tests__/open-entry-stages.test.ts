// The Start-tournament dialog says "Entrant list closes" — and must not say it
// when the server would not close the list. The server's rule lives in one SQL
// literal in `usecases/entrants.ts`; this file is the only thing keeping the
// client mirror honest, so it reads that literal rather than restating it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENTRANT_LIST_LOCKED_STATUSES,
  OPEN_ENTRY_STAGE_KINDS,
  divisionTakesSwissLateEntry,
  entrantListLocked,
  isRootSwissStage,
  startClosesEntrantList,
  startEntrantsLine,
  type EntryStage,
} from "@/lib/open-entry-stages";

/** A stage row as the page holds it: kind, progression and config are what the guard reads. */
const st = (kind: string, extra: Partial<EntryStage> = {}): EntryStage => ({
  kind,
  progression: null,
  config: {},
  ...extra,
});
const stages = (...kinds: string[]) => kinds.map((k) => st(k));

describe("open-entry stage kinds", () => {
  it("matches the kinds `enrollEntrants` actually exempts", () => {
    const source = readFileSync(
      join(process.cwd(), "src/server/usecases/entrants.ts"),
      "utf8",
    );
    // The guard: `where division_id = ${divisionId} and kind in ('ladder', 'americano')`.
    const clause = /and kind in \(([^)]*)\)/.exec(source);
    expect(clause, "the open-format exemption clause is no longer in entrants.ts").not.toBeNull();
    const kinds = [...clause![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual([...OPEN_ENTRY_STAGE_KINDS].sort());
  });

  it("ONE open-format stage exempts the whole division, not all of them", () => {
    // The server tests `exists(... kind in (...))`, so a mixed division is
    // exempt too. A dialog that only stayed quiet for an all-ladder division
    // would tell a ladder+knockout organiser their list had closed when it
    // had not.
    expect(startClosesEntrantList(stages("ladder"))).toBe(false);
    expect(startClosesEntrantList(stages("americano"))).toBe(false);
    expect(startClosesEntrantList(stages("knockout", "ladder"))).toBe(false);
    expect(startClosesEntrantList(stages("league", "knockout"))).toBe(true);
    // No stages at all: `exists` is false, so the list closes.
    expect(startClosesEntrantList([])).toBe(true);
  });
});

// `entrantListLocked` answers the OTHER question — not "will starting close the
// list" but "is it closed right now" — and it exists because the console
// rendered the whole Add-entrant form on a started tournament, where pressing
// Add produced a 422 and nothing else (driven 2026-09-20).
describe("whether the entrant list is closed right now", () => {
  const source = readFileSync(join(process.cwd(), "src/server/usecases/entrants.ts"), "utf8");

  it("locks in exactly the statuses `createEntrants` refuses in", () => {
    // Derived from the guard, not typed in: a new forward status (or a rename)
    // moves this test with it instead of leaving it asserting yesterday's list.
    const clause = /if \(\s*division\.status === ([^)]*?)\)\s*\{/.exec(source);
    expect(clause, "the status half of the entrant-list guard has changed shape").not.toBeNull();
    const statuses = [...clause![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(statuses.length).toBeGreaterThan(0);
    expect([...statuses].sort()).toEqual([...ENTRANT_LIST_LOCKED_STATUSES].sort());
  });

  it("is open in every status the server does not refuse in", () => {
    // The positive pair for the row below: `setup` and `scheduled` are the two
    // states in which the form is the organiser's ordinary tool, and hiding it
    // there would be the worse defect of the two.
    for (const status of ["setup", "scheduled"]) {
      expect(entrantListLocked(status, stages("league")), status).toBe(false);
    }
  });

  it("is locked on a started division whose stages are all closed-field", () => {
    for (const status of ENTRANT_LIST_LOCKED_STATUSES) {
      expect(entrantListLocked(status, stages("league")), status).toBe(true);
      expect(entrantListLocked(status, stages("league", "knockout")), status).toBe(true);
      // A Swiss fed by an earlier stage has a fixed qualified field: nobody joins it late, so it exempts nothing.
      expect(entrantListLocked(status, [st("league"), st("swiss", { progression: { from: "s1", top: 4 } })]), status).toBe(true);
      expect(entrantListLocked(status, [st("swiss", { config: { qualified: ["e1", "e2"] } })]), status).toBe(true);
      // No stages: `exists` is false server-side, so the list is locked.
      expect(entrantListLocked(status, []), status).toBe(true);
    }
  });

  it("is OPEN on a started division with one open-format stage", () => {
    // Both halves of the guard have to be mirrored or this hides a live
    // control: a ladder takes late joiners by design, and hiding its form on a
    // running ladder would break the format's whole point. One such stage
    // exempts the division, mixed or not.
    for (const status of ENTRANT_LIST_LOCKED_STATUSES) {
      for (const kind of OPEN_ENTRY_STAGE_KINDS) {
        expect(entrantListLocked(status, stages(kind)), `${status}/${kind}`).toBe(false);
        expect(entrantListLocked(status, stages("knockout", kind)), `${status}/${kind}+ko`).toBe(false);
      }
    }
  });
});

// W3 T9 (ruling 250): a running ROOT Swiss takes a late player, so the Start lock exempts it too —
// `hasRootSwissStage` (usecases/swiss-late-entry.ts) asks `isRootSwissStage` itself, the one predicate both sides read.
describe("a running root Swiss keeps the entrant list open", () => {
  const ROOT_CASES: { name: string; stage: EntryStage; root: boolean }[] = [
    { name: "a plain Swiss", stage: st("swiss"), root: true },
    { name: "a Swiss with its rounds set", stage: st("swiss", { config: { rounds: 5, chess: true } }), root: true },
    { name: "a Swiss fed by an earlier stage", stage: st("swiss", { progression: { from: "s1", top: 8 } }), root: false },
    { name: "a Swiss holding a qualified field", stage: st("swiss", { config: { qualified: [] } }), root: false },
    { name: "a league", stage: st("league"), root: false },
    { name: "a knockout", stage: st("knockout"), root: false },
    { name: "a ladder", stage: st("ladder"), root: false },
  ];

  it("isRootSwissStage answers for each stage shape", () => {
    let checked = 0;
    for (const c of ROOT_CASES) {
      expect(isRootSwissStage(c.stage), c.name).toBe(c.root);
      checked++;
    }
    expect(checked, "anti-vacuity: every shape checked").toBe(ROOT_CASES.length);
    expect(ROOT_CASES.filter((c) => c.root).length, "both answers are in the table").toBeGreaterThan(0);
    expect(ROOT_CASES.filter((c) => !c.root).length).toBeGreaterThan(0);
  });

  it("is OPEN after Start on a division with a root Swiss, alone or beside a closed stage", () => {
    let checked = 0;
    for (const status of ENTRANT_LIST_LOCKED_STATUSES) {
      expect(entrantListLocked(status, stages("swiss")), `${status}/swiss`).toBe(false);
      expect(entrantListLocked(status, stages("swiss", "knockout")), `${status}/swiss+ko`).toBe(false);
      checked += 2;
    }
    expect(checked).toBe(ENTRANT_LIST_LOCKED_STATUSES.length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  it("the Start dialog says the list closes, stays open for the Swiss, or says nothing", () => {
    expect(startEntrantsLine(stages("league", "knockout"))).toBe("closes");
    expect(startEntrantsLine([])).toBe("closes");
    expect(startEntrantsLine(stages("swiss"))).toBe("swiss_late");
    expect(startEntrantsLine(stages("swiss", "knockout"))).toBe("swiss_late");
    expect(startEntrantsLine([st("swiss", { progression: { from: "s1", top: 4 } })])).toBe("closes");
    expect(startEntrantsLine(stages("ladder"))).toBeNull();
    expect(startEntrantsLine(stages("americano", "knockout"))).toBeNull();
    // Both exemptions at once: the list stays open, and the Swiss line is true of it.
    expect(startEntrantsLine(stages("ladder", "swiss"))).toBe("swiss_late");
    expect(startClosesEntrantList(stages("swiss"))).toBe(false);
  });

  it("the server's Start lock and its admission ask this predicate, not a SQL copy of it", () => {
    const lateEntry = readFileSync(join(process.cwd(), "src/server/usecases/swiss-late-entry.ts"), "utf8");
    expect(lateEntry).toMatch(/import \{[^}]*\bisRootSwissStage\b[^}]*\} from "@\/lib\/open-entry-stages"/);
    // The old SQL restatement is gone: a second copy is a second thing to drift.
    expect(lateEntry).not.toMatch(/progression is null/);
    expect(lateEntry).not.toMatch(/config \? 'qualified'/);
    const calls = [...lateEntry.matchAll(/\.filter\(isRootSwissStage\)/g)].length;
    expect(calls, "both reads (the Start-lock exemption and the stage admitted into) filter through it").toBeGreaterThanOrEqual(1);
  });
});

// W3 T10: the Entrants tab's add is a LATE add while a started division holds a root Swiss still running. The form
// says so then (and reads the add's `late_entry` back), never before Start nor once every root Swiss is finished.
describe("divisionTakesSwissLateEntry", () => {
  const live = (status: string) => ({ ...st("swiss"), status });
  const ROWS: { name: string; status: string; stages: (EntryStage & { status: string })[]; late: boolean }[] = [
    { name: "active, a running root Swiss", status: "active", stages: [live("active")], late: true },
    { name: "active, a pending root Swiss beside a league", status: "active", stages: [{ ...st("league"), status: "complete" }, live("pending")], late: true },
    { name: "completed division, the Swiss still open", status: "completed", stages: [live("active")], late: true },
    { name: "before Start", status: "scheduled", stages: [live("pending")], late: false },
    { name: "setup", status: "setup", stages: [live("pending")], late: false },
    { name: "the only root Swiss is finished", status: "active", stages: [live("complete")], late: false },
    { name: "a fed Swiss only", status: "active", stages: [{ ...st("swiss", { progression: { from: "s1", top: 4 } }), status: "active" }], late: false },
    { name: "a ladder only", status: "active", stages: [{ ...st("ladder"), status: "active" }], late: false },
    { name: "no stages", status: "active", stages: [], late: false },
  ];
  it("answers for each division shape", () => {
    let checked = 0;
    for (const r of ROWS) {
      expect(divisionTakesSwissLateEntry(r.status, r.stages), r.name).toBe(r.late);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect(ROWS.some((r) => r.late) && ROWS.some((r) => !r.late)).toBe(true);
  });
});
