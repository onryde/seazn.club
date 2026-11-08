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
  isRootKnockoutStage,
  isRootSwissStage,
  isRunningRootKnockout,
  swissLateEntryOffered,
  startClosesEntrantList,
  startEntrantsLine,
  type EntryStage,
} from "@/lib/open-entry-stages";
import { STAGE_TEMPLATES, buildTemplateStages } from "@/lib/format-templates";

/** A stage row as the page holds it: kind, progression, config and status are what the guards read. A stage is
 *  running (`active`) unless a row says otherwise. */
type Row = EntryStage & { status: string };
const st = (kind: string, extra: Partial<Row> = {}): Row => ({
  kind,
  progression: null,
  config: {},
  status: "active",
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
    // The one read filters through it, and BOTH callers go through that read (review m7: a count of the filter alone
    // could not witness "both").
    expect([...lateEntry.matchAll(/\.filter\(isRootSwissStage\)/g)].length, "rootSwissStages filters through it").toBe(1);
    const body = (name: string) => {
      const start = lateEntry.indexOf(`async function ${name}(`);
      expect(start, `${name} is no longer in swiss-late-entry.ts`).toBeGreaterThanOrEqual(0);
      return lateEntry.slice(start, lateEntry.indexOf("\n}\n", start));
    };
    expect(body("rootSwissStages"), "the read filters its rows").toContain(".filter(isRootSwissStage)");
    expect(body("hasRootSwissStage"), "the Start-lock exemption reads rootSwissStages").toContain("await rootSwissStages(");
    expect(lateEntry, "the admission's stage is rootSwissStages' first row").toMatch(/const \[stage\] = await rootSwissStages\(/);
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

// Review I1 (2026-11-01): a FINISHED root Swiss takes nobody (the admission refuses SWISS_OVER), so the list is
// closed again once it is complete: a completed Swiss division, and the whole playoff phase of swiss_playoff /
// swiss_knockout. Before this the form and Import CSV rendered there and every add came back 422.
describe("a finished root Swiss closes the list again", () => {
  const ROWS: { name: string; status: string; stages: Row[]; locked: boolean }[] = [
    { name: "completed division, its Swiss complete", status: "completed", stages: [st("swiss", { status: "complete" })], locked: true },
    {
      name: "playoff phase: the Swiss complete, the knockout running",
      status: "active",
      stages: [st("swiss", { status: "complete" }), st("knockout", { status: "active" })],
      locked: true,
    },
    { name: "the Swiss still running", status: "active", stages: [st("swiss", { status: "active" })], locked: false },
    { name: "the Swiss paired, nothing started", status: "active", stages: [st("swiss", { status: "pending" })], locked: false },
    {
      name: "a finished Swiss beside a ladder (the ladder still exempts)",
      status: "active",
      stages: [st("swiss", { status: "complete" }), st("ladder", { status: "active" })],
      locked: false,
    },
  ];
  it("locks once every root Swiss is complete; stays open while one runs", () => {
    let checked = 0;
    for (const r of ROWS) {
      expect(entrantListLocked(r.status, r.stages), r.name).toBe(r.locked);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect(ROWS.some((r) => r.locked) && ROWS.some((r) => !r.locked), "both directions").toBe(true);
  });

  it("one rule answers the list lock, the late-add note and the rail's More, across every Swiss shape", () => {
    // Without an open-format stage, "the list is open after Start" IS "this add is a late add", and the rail offers
    // More on exactly the running root Swiss stages (given a seated round).
    const SHAPES: Row[] = [
      st("swiss", { status: "active" }),
      st("swiss", { status: "pending" }),
      st("swiss", { status: "complete" }),
      st("swiss", { status: "active", progression: { from: "s1", top: 4 } }),
      st("swiss", { status: "active", config: { qualified: [] } }),
      st("knockout", { status: "active" }),
    ];
    let checked = 0;
    for (const divisionStatus of ENTRANT_LIST_LOCKED_STATUSES) {
      for (const a of SHAPES) {
        for (const b of [null, st("knockout", { status: "pending" })]) {
          const rows = b ? [a, b] : [a];
          const late = divisionTakesSwissLateEntry(divisionStatus, rows);
          // W4 T9: a ROOT knockout (the lone knockout row, the division's entry stage) takes a late player too — into
          // its round 1 — so for it "the list is open" is a knockout late add, not a Swiss one, and the Swiss rail's
          // More is still not offered.
          const knockoutLate = rows.some((stage) => isRunningRootKnockout(stage, rows));
          expect(!entrantListLocked(divisionStatus, rows), JSON.stringify(rows)).toBe(late || knockoutLate);
          expect(late && knockoutLate, "premise: no shape holds both a root Swiss and a root knockout").toBe(false);
          const offered = rows.some((stage) => swissLateEntryOffered({ stage, divisionStatus, roundSeated: true }));
          expect(offered, JSON.stringify(rows)).toBe(late);
          checked++;
        }
      }
    }
    expect(checked).toBe(ENTRANT_LIST_LOCKED_STATUSES.length * SHAPES.length * 2);
  });
});

// W4 T9 (X-LE-1, X-LE-2, X-LE-8; ruling 263, pre-flight C11): a ROOT knockout — the division's entry stage, drawn from
// the live roster — keeps the list open after Start; a knockout fed by an earlier stage never takes a late player.
//
// Expected values are the rulebook's (rules/cross-sport.md X-LE-1: "the entry stage is the root knockout; under
// ko_plate it is the main bracket, under qualifying_main it is the qualifying bracket"; X-LE-2: "fed knockouts — under
// league_ko, groups_ko, swiss_knockout — never take a late entrant"), typed here, never derived from the predicate.
describe("W4 T9: a root knockout keeps the entrant list open after Start", () => {
  const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
  /** A template's stages as the page holds them: `seq` from 1 in build order, every stage running. */
  const rowsOf = (key: string): (Row & { name: string })[] =>
    buildTemplateStages(key, KNOBS).map((d, i) => ({ ...d, seq: i + 1, status: "active" }));
  /** X-LE-1's three templates, by name. */
  const ROOT_KNOCKOUT_TEMPLATES = ["knockout", "ko_plate", "qualifying_main"];
  /** X-LE-2's fed-knockout templates whose entry stage takes nobody late (swiss_knockout's Swiss does: W3). */
  const FED_ONLY = ["league_ko", "groups_ko"];

  it("X-LE-1 the templates whose entry stage is a knockout are exactly the rulebook's three", () => {
    const opening = STAGE_TEMPLATES.filter((t) => {
      const [first] = buildTemplateStages(t.key, KNOBS);
      return first?.kind === "knockout" && first.progression === null;
    }).map((t) => t.key);
    expect([...opening].sort()).toEqual([...ROOT_KNOCKOUT_TEMPLATES].sort());
  });

  it("X-LE-1 a root knockout keeps the list open after Start, and the Start dialog says so", () => {
    let checked = 0;
    for (const key of ROOT_KNOCKOUT_TEMPLATES) {
      const rows = rowsOf(key);
      for (const status of ENTRANT_LIST_LOCKED_STATUSES) {
        expect(entrantListLocked(status, rows), `${key} / ${status}`).toBe(false);
        checked++;
      }
      expect(startEntrantsLine(rows), key).toBe("knockout_late");
      expect(startClosesEntrantList(rows), key).toBe(false);
      // The entry stage is the root one — under ko_plate the main bracket, under qualifying_main the qualifying one —
      // and a stage it feeds is not.
      expect(isRootKnockoutStage(rows[0]!, rows), `${key}: its first stage`).toBe(true);
      for (const fed of rows.slice(1)) expect(isRootKnockoutStage(fed, rows), `${key}: ${fed.name}`).toBe(false);
    }
    expect(checked).toBe(ROOT_KNOCKOUT_TEMPLATES.length * ENTRANT_LIST_LOCKED_STATUSES.length);
  });

  it("X-LE-2 a fed knockout keeps it closed; swiss_knockout's Swiss says the Swiss line, not the knockout one", () => {
    let checked = 0;
    for (const key of FED_ONLY) {
      const rows = rowsOf(key);
      expect(rows.some((r) => r.kind === "knockout"), `premise: ${key} holds a knockout`).toBe(true);
      expect(entrantListLocked("active", rows), key).toBe(true);
      expect(startEntrantsLine(rows), key).toBe("closes");
      for (const r of rows) expect(isRootKnockoutStage(r, rows), `${key}: ${r.name}`).toBe(false);
      checked++;
    }
    const swissKo = rowsOf("swiss_knockout");
    expect(startEntrantsLine(swissKo)).toBe("swiss_late");
    expect(swissKo.filter((r) => isRootKnockoutStage(r, swissKo))).toEqual([]);
    // The playoff phase: the Swiss complete, its knockout running — fed, so the list is closed.
    swissKo[0]!.status = "complete";
    expect(entrantListLocked("active", swissKo)).toBe(true);
    checked++;
    expect(checked).toBe(FED_ONLY.length + 1);
  });

  it("every template answers the lock its rulebook row names", () => {
    // Open after Start: the root knockouts (X-LE-1), the root Swiss templates (W3, X-SW-12), the open formats (Jul3/08).
    const OPEN = new Set([...ROOT_KNOCKOUT_TEMPLATES, "swiss", "swiss_playoff", "swiss_knockout", "americano", "mexicano", "ladder"]);
    let checked = 0;
    for (const t of STAGE_TEMPLATES) {
      expect(entrantListLocked("active", rowsOf(t.key)), t.key).toBe(!OPEN.has(t.key));
      checked++;
    }
    expect(checked).toBe(STAGE_TEMPLATES.length);
    expect(checked).toBeGreaterThan(OPEN.size);
  });

  it("C11 a knockout after a group stage is fed even with no progression stored (the stg census shape)", () => {
    // 65 stg knockouts sit after a league/group with progression null and fill from a seed proposal.
    const legacy: Row[] = [st("league", { seq: 1 }), st("knockout", { seq: 2 })];
    expect(isRootKnockoutStage(legacy[1]!, legacy)).toBe(false);
    expect(entrantListLocked("active", legacy)).toBe(true);
    expect(startEntrantsLine(legacy)).toBe("closes");
    // `seq`, not list order, names the entry stage.
    const reversed: Row[] = [st("knockout", { seq: 2 }), st("league", { seq: 1 })];
    expect(isRootKnockoutStage(reversed[0]!, reversed)).toBe(false);
    expect(entrantListLocked("active", reversed)).toBe(true);
    const ordered: Row[] = [st("league", { seq: 2 }), st("knockout", { seq: 1 })];
    expect(isRootKnockoutStage(ordered[1]!, ordered)).toBe(true);
    expect(entrantListLocked("active", ordered)).toBe(false);
  });

  it("X-LE-8 a standalone stepladder or page playoff is a root bracket; a double elimination is not; a stored `qualified` field is a fed stage", () => {
    const ROWS: { name: string; rows: Row[]; root: boolean }[] = [
      { name: "standalone stepladder", rows: [st("stepladder", { seq: 1 })], root: true },
      { name: "standalone page playoff", rows: [st("page_playoff", { seq: 1 })], root: true },
      { name: "double elimination", rows: [st("double_elim", { seq: 1 })], root: false },
      { name: "a knockout carrying `qualified`", rows: [st("knockout", { seq: 1, config: { qualified: [] } })], root: false },
      { name: "a knockout with a progression source", rows: [st("knockout", { seq: 1, progression: { from: "s1", top: 4 } })], root: false },
      { name: "a knockout whose config is not an object", rows: [st("knockout", { seq: 1, config: null })], root: false },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(isRootKnockoutStage(r.rows[0]!, r.rows), r.name).toBe(r.root);
      expect(entrantListLocked("active", r.rows), r.name).toBe(!r.root);
      expect(startEntrantsLine(r.rows), r.name).toBe(r.root ? "knockout_late" : "closes");
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect(ROWS.some((r) => r.root) && ROWS.some((r) => !r.root)).toBe(true);
  });

  it("a finished root knockout closes the list again; before Start nothing is locked", () => {
    const done: Row[] = [st("knockout", { seq: 1, status: "complete" })];
    expect(isRootKnockoutStage(done[0]!, done), "still the root stage").toBe(true);
    expect(isRunningRootKnockout(done[0]!, done)).toBe(false);
    expect(entrantListLocked("completed", done)).toBe(true);
    expect(entrantListLocked("active", done)).toBe(true);
    // Before Start the list is open whatever the stages: the empty case, and a fed knockout.
    expect(entrantListLocked("setup", [])).toBe(false);
    expect(entrantListLocked("scheduled", rowsOf("league_ko"))).toBe(false);
    // No stages after Start: nothing exempts the list.
    expect(entrantListLocked("active", [])).toBe(true);
  });

  it("the server's Start lock and its knockout admission ask this predicate, not a SQL copy of it", () => {
    const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const late = src("src/server/usecases/knockout-late-entry.ts");
    expect(late).toMatch(/import \{[^}]*\bisRootKnockoutStage\b[^}]*\} from "@\/lib\/open-entry-stages"/);
    expect(late).not.toMatch(/progression is null/);
    const entrants = src("src/server/usecases/entrants.ts");
    expect(entrants, "the Start lock exempts a root knockout").toMatch(/await hasRootKnockoutStage\(tx, divisionId\)/);
  });
});
