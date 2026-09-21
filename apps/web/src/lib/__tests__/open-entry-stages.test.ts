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
  entrantListLocked,
  startClosesEntrantList,
} from "@/lib/open-entry-stages";

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
    expect(startClosesEntrantList(["ladder"])).toBe(false);
    expect(startClosesEntrantList(["americano"])).toBe(false);
    expect(startClosesEntrantList(["knockout", "ladder"])).toBe(false);
    expect(startClosesEntrantList(["league", "knockout"])).toBe(true);
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
      expect(entrantListLocked(status, ["league"]), status).toBe(false);
    }
  });

  it("is locked on a started division whose stages are all closed-field", () => {
    for (const status of ENTRANT_LIST_LOCKED_STATUSES) {
      expect(entrantListLocked(status, ["swiss"]), status).toBe(true);
      expect(entrantListLocked(status, ["league", "knockout"]), status).toBe(true);
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
        expect(entrantListLocked(status, [kind]), `${status}/${kind}`).toBe(false);
        expect(entrantListLocked(status, ["knockout", kind]), `${status}/${kind}+ko`).toBe(false);
      }
    }
  });
});
