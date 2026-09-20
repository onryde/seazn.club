// The Start-tournament dialog says "Entrant list closes" — and must not say it
// when the server would not close the list. The server's rule lives in one SQL
// literal in `usecases/entrants.ts`; this file is the only thing keeping the
// client mirror honest, so it reads that literal rather than restating it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPEN_ENTRY_STAGE_KINDS, startClosesEntrantList } from "@/lib/open-entry-stages";

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
