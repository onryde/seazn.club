// Property tests (PROMPT-23 acceptance): apply → undo → redo round-trips,
// the ledger is never mutated (append-only), watermark truncation linearises.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fold, redo, undo } from "./history.ts";
import type { LedgerEvent } from "./types.ts";

const NONE: ReadonlySet<string> = new Set();

// Random ledgers of interleaved edits over a small fixture pool. Each edit's
// `from` is the fixture's true prior placement — like the real emitters.
const arbitraryLedger = fc
  .array(
    fc.record({
      fixture: fc.constantFrom("f1", "f2", "f3", "f4"),
      at: fc.constantFrom("T1", "T2", "T3", "T4", "T5"),
      court: fc.constantFrom("C1", "C2"),
    }),
    { minLength: 1, maxLength: 20 },
  )
  .map((edits) => {
    const placement = new Map<string, { at: string | null; court: string | null }>();
    const events: LedgerEvent[] = [];
    edits.forEach((e, i) => {
      const from = placement.get(e.fixture) ?? { at: null, court: null };
      const to = { at: e.at, court: e.court };
      events.push({
        seq: i + 1,
        type: "schedule_edited",
        payload: { fixture: e.fixture, from, to },
      });
      placement.set(e.fixture, to);
    });
    return events;
  });

function append(events: LedgerEvent[], step: { event: { type: string; payload: Record<string, unknown> } }): LedgerEvent[] {
  const head = events[events.length - 1]?.seq ?? 0;
  return [...events, { seq: head + 1, type: step.event.type, payload: step.event.payload }];
}

describe("history properties (PROMPT-23)", () => {
  it("apply → undo → redo round-trips to the identical state", () => {
    fc.assert(
      fc.property(arbitraryLedger, fc.integer({ min: 1, max: 5 }), (ledger, steps) => {
        const before = fold(ledger, null);
        let events = ledger;
        let wm: number | null = null;
        let undone = 0;
        for (let i = 0; i < steps; i++) {
          try {
            const step = undo(events, wm, NONE);
            events = append(events, step);
            wm = step.newWatermark;
            undone++;
          } catch {
            break; // ran out of edits
          }
        }
        for (let i = 0; i < undone; i++) {
          const step = redo(events, wm, NONE);
          events = append(events, step);
          wm = step.newWatermark;
        }
        expect(fold(events, wm)).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("undo never mutates existing ledger rows (append-only)", () => {
    fc.assert(
      fc.property(arbitraryLedger, (ledger) => {
        const frozen = JSON.parse(JSON.stringify(ledger)) as LedgerEvent[];
        try {
          undo(ledger, null, NONE);
          redo(ledger, 0, NONE);
        } catch {
          /* NOTHING_TO_* is fine */
        }
        expect(ledger).toEqual(frozen);
      }),
      { numRuns: 100 },
    );
  });

  it("a fresh edit after undo linearises history: redo impossible, fold coherent", () => {
    fc.assert(
      fc.property(arbitraryLedger, (ledger) => {
        fc.pre(ledger.length >= 2);
        let events = ledger;
        const step = undo(events, null, NONE);
        events = append(events, step);
        // new edit at head, watermark jumps to head
        events = append(events, {
          event: {
            type: "schedule_edited",
            payload: { fixture: "f1", from: { at: null, court: null }, to: { at: "T9", court: "C9" } },
          },
        });
        const head = events[events.length - 1]!.seq;
        expect(() => redo(events, head, NONE)).toThrowError(
          expect.objectContaining({ code: "NOTHING_TO_REDO" }),
        );
        expect(fold(events, head).fixtures.f1).toMatchObject({ at: "T9", court: "C9" });
      }),
      { numRuns: 100 },
    );
  });
});

// TEST-STRATEGY rule 10 (engine mutation debt, history.ts): random ledgers of
// MIXED registry kinds, written the way the app's emitters write them (each
// `from` / snapshot is the fixture's true placement at that moment, tracked
// below independently of `fold`), then a random walk of Undo / Redo / FRESH
// EDITS with the invariants checked after every step.
//
// Kinds: the placement ops and the pool clear. The generation pair is left
// out on purpose: fold's fixtures_generated never reads a snapshot's slot, so
// apply ∘ invert is not the identity on placement there (recorded in the
// mutation-debt report; no production code reads the fold today).
//
// Fresh edits mid-walk cover the path the mutation-debt report found broken
// (edit, edit, Undo, fresh edit, Undo, Undo, Redo left the executor's writes
// disagreeing with fold at the watermark). The rule is the owner's ruling of
// 2026-10-11: history is ONE linear timeline — a fresh edit keeps the Undos
// before it as history, Undo walks back through them, and Redo replays only
// what Undo walked back since the latest fresh edit. history.sequence.test.ts
// enumerates that rule exhaustively for single edits; this walk takes it
// across every registry kind.
// Sport: not applicable — the division ledger consults no sport module.
type Slot = { at: string | null; court: string | null; locked: boolean; exists: boolean };
const FIX = ["f1", "f2", "f3", "f4"] as const;
const TIMES = ["2026-10-11T09:00:00.000Z", "2026-10-11T10:00:00.000Z", "2026-10-11T11:00:00.000Z"] as const;
const DEFAULT_SLOT: Slot = { at: null, court: null, locked: false, exists: true };
const KINDS = ["schedule_applied", "schedule_shifted", "schedule_edited", "schedule_cleared", "pool_entrants_cleared"] as const;

const pick = fc.uniqueArray(fc.constantFrom(...FIX), { minLength: 1, maxLength: 3 });
const editSpec = fc.oneof(
  fc.record({ kind: fc.constant("schedule_applied" as const), picks: pick, at: fc.constantFrom(...TIMES), court: fc.constantFrom("C1", "C2") }),
  fc.record({ kind: fc.constant("schedule_shifted" as const), minutes: fc.constantFrom(-15, 15, 30) }),
  fc.record({
    kind: fc.constant("schedule_edited" as const),
    fixture: fc.constantFrom(...FIX),
    at: fc.constantFrom(...TIMES),
    court: fc.constantFrom("C1", "C2"),
    // undefined = a ledger row from before the lock flag existed
    locked: fc.option(fc.boolean(), { nil: undefined }),
  }),
  fc.record({ kind: fc.constant("schedule_cleared" as const), picks: pick }),
  fc.record({ kind: fc.constant("pool_entrants_cleared" as const), picks: pick }),
);

type EditSpec = typeof editSpec extends fc.Arbitrary<infer T> ? T : never;
type Row = { type: string; payload: Record<string, unknown> };

const freshSlots = () => new Map<string, Slot>(FIX.map((id) => [id, { ...DEFAULT_SLOT }]));
const cloneSlots = (slot: Map<string, Slot>) => new Map([...slot].map(([id, f]) => [id, { ...f }]));

/** The row one spec's emitter appends against the board as it stands
 *  (`slot`, updated in place as the write lands), or null for a spec that
 *  would touch nothing — an emitter appends no event for a no-op. */
function emit(slot: Map<string, Slot>, s: EditSpec): Row | null {
  if (s.kind === "schedule_applied") {
    const moves = s.picks
      .filter((id) => slot.get(id)!.exists)
      .map((id) => {
        const f = slot.get(id)!;
        const m = { fixture: id, from: { at: f.at, court: f.court }, to: { at: s.at, court: s.court } };
        f.at = s.at;
        f.court = s.court;
        return m;
      });
    return moves.length > 0 ? { type: s.kind, payload: { moves } } : null;
  }
  if (s.kind === "schedule_shifted") {
    const moves = FIX.filter((id) => slot.get(id)!.exists && slot.get(id)!.at !== null).map((id) => {
      const f = slot.get(id)!;
      const to = new Date(Date.parse(f.at!) + s.minutes * 60_000).toISOString();
      const m = { fixture: id, from: { at: f.at, court: f.court }, to: { at: to, court: f.court } };
      f.at = to;
      return m;
    });
    return moves.length > 0 ? { type: s.kind, payload: { minutes: s.minutes, moves } } : null;
  }
  if (s.kind === "schedule_edited") {
    const f = slot.get(s.fixture)!;
    if (!f.exists) return null;
    const from = s.locked === undefined ? { at: f.at, court: f.court } : { at: f.at, court: f.court, locked: f.locked };
    const to = s.locked === undefined ? { at: s.at, court: s.court } : { at: s.at, court: s.court, locked: s.locked };
    f.at = s.at;
    f.court = s.court;
    if (s.locked !== undefined) f.locked = s.locked;
    return { type: s.kind, payload: { fixture: s.fixture, from, to } };
  }
  if (s.kind === "schedule_cleared") {
    const cleared = s.picks
      .filter((id) => slot.get(id)!.exists && (slot.get(id)!.at !== null || slot.get(id)!.court !== null))
      .map((id) => {
        const f = slot.get(id)!;
        const snap = { id, at: f.at, court: f.court };
        f.at = null;
        f.court = null;
        return snap;
      });
    return cleared.length > 0 ? { type: s.kind, payload: { scope: { excludeLocked: false }, cleared } } : null;
  }
  const fixtures = s.picks
    .filter((id) => slot.get(id)!.exists)
    .map((id) => {
      const f = slot.get(id)!;
      const snap = { id, pool_id: "pA", at: f.at, court: f.court };
      f.exists = false;
      f.at = null;
      f.court = null;
      return snap;
    });
  return fixtures.length > 0 ? { type: s.kind, payload: { pool_id: "pA", fixtures } } : null;
}

/** The app's executor, re-implemented on the tracker: what one appended Undo
 *  or Redo row writes to the fixtures table. Independent of `fold`. */
function execute(slot: Map<string, Slot>, row: Row): void {
  type Snap = { id: string; at?: string | null; court?: string | null };
  type To = { at: string | null; court: string | null; locked?: boolean };
  const p = row.payload;
  switch (row.type) {
    case "schedule_applied":
    case "schedule_shifted":
      for (const m of p.moves as { fixture: string; to: To }[]) Object.assign(slot.get(m.fixture)!, { at: m.to.at, court: m.to.court });
      return;
    case "schedule_edited": {
      const f = slot.get(p.fixture as string)!;
      const to = p.to as To;
      Object.assign(f, { at: to.at, court: to.court }, to.locked === undefined ? {} : { locked: to.locked });
      return;
    }
    case "schedule_cleared":
      for (const s of p.cleared as Snap[]) Object.assign(slot.get(s.id)!, { at: null, court: null });
      return;
    case "schedule_restored":
      for (const s of p.restored as Snap[]) Object.assign(slot.get(s.id)!, { at: s.at ?? null, court: s.court ?? null });
      return;
    case "pool_entrants_cleared":
      for (const s of p.fixtures as Snap[]) Object.assign(slot.get(s.id)!, { exists: false, at: null, court: null });
      return;
    case "pool_entrants_restored":
      for (const s of p.fixtures as Snap[]) Object.assign(slot.get(s.id)!, { exists: true, at: s.at ?? null, court: s.court ?? null });
      return;
    default:
      throw new Error(`this executor has no statement for ${row.type}`);
  }
}

function mixedLedger(specs: fc.Arbitrary<EditSpec[]>) {
  return specs.map((list) => {
    const slot = freshSlots();
    const events: LedgerEvent[] = [];
    for (const s of list) {
      const row = emit(slot, s);
      if (row) events.push({ seq: events.length + 1, ...row });
    }
    return { events, final: cloneSlots(slot) };
  });
}

/** What the board shows per fixture: its slot and lock, or "gone". A fixture
 *  the fold never saw sits at the fresh default (it predates the ledger). */
function view(events: LedgerEvent[], wm: number | null): Record<string, unknown> {
  const state = fold(events, wm).fixtures;
  return Object.fromEntries(
    FIX.map((id) => {
      const f = state[id] ?? DEFAULT_SLOT;
      return [id, f.exists ? { at: f.at, court: f.court, locked: f.locked } : "gone"];
    }),
  );
}
function trackedView(final: Map<string, Slot>): Record<string, unknown> {
  return Object.fromEntries(
    FIX.map((id) => {
      const f = final.get(id)!;
      return [id, f.exists ? { at: f.at, court: f.court, locked: f.locked } : "gone"];
    }),
  );
}

type WalkStep = "undo" | "redo" | { edit: EditSpec };
const walkStep: fc.Arbitrary<WalkStep> = fc.oneof(
  { arbitrary: fc.constant<WalkStep>("undo"), weight: 3 },
  { arbitrary: fc.constant<WalkStep>("redo"), weight: 2 },
  { arbitrary: editSpec.map((edit): WalkStep => ({ edit })), weight: 1 },
);

// 200 fast-check runs of up to 24 steps, each step folding the ledger twice:
// ~2.5 s alone, past vitest's 5 s default on a loaded machine. The budget is
// for wall clock under load, not a cap on the work — never trade numRuns for it.
const WALK_TIMEOUT_MS = 30_000;

describe("history properties — mixed registry kinds (rule 10)", () => {
  it("every Undo / Redo / fresh-edit step keeps the executor's writes and the watermark in agreement; undo-all / redo-all round-trip", () => {
    const undoneKinds = new Map<string, number>(KINDS.map((k) => [k, 0]));
    const seen = new Map<string, number>();
    const count = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);
    let steps = 0;
    let runs = 0;
    fc.assert(
      fc.property(
        mixedLedger(fc.array(editSpec, { minLength: 1, maxLength: 12 })),
        fc.array(walkStep, { minLength: 1, maxLength: 24 }),
        ({ events: ledger, final }, walk) => {
          fc.pre(ledger.length > 0);
          runs++;
          // the tracker (the emitters' own view) and the fold agree on the ledger as written
          expect(view(ledger, null)).toEqual(trackedView(final));
          let events = ledger;
          // null = the ledger head, exactly as the app persists it after a fresh edit
          let wm: number | null = null;
          const headSeq = () => events[events.length - 1]!.seq;
          const at = () => wm ?? headSeq();
          // the fixtures table, written row by row by the (re-implemented) executor
          const table = cloneSlots(final);
          // the newest fresh edit, and the board right after it was written
          let lastFresh = { seq: ledger.length, board: trackedView(final) };
          const agree = () => {
            // what the executor has written is what the watermark says
            expect(view(events, wm)).toEqual(trackedView(table));
            expect(view(events, null)).toEqual(trackedView(table));
          };
          const tryStep = (action: "undo" | "redo"): boolean => {
            let s: ReturnType<typeof undo>;
            try {
              s = action === "undo" ? undo(events, wm, NONE) : redo(events, wm, NONE);
            } catch (err) {
              expect((err as { code?: string }).code).toBe(action === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO");
              return false;
            }
            const before = events;
            const target = before.find((e) => e.seq === s.event.payload[action === "undo" ? "__undo_of" : "__redo_of"])!;
            if (target.payload.__undo_of !== undefined || target.payload.__redo_of !== undefined) {
              count(`${action} of an undo/redo row`);
            }
            if (action === "undo") {
              undoneKinds.set(target.type, (undoneKinds.get(target.type) ?? 0) + 1);
              expect(s.newWatermark).toBeLessThan(at());
            } else {
              expect(s.newWatermark).toBeGreaterThan(at());
              expect(s.newWatermark).toBeLessThanOrEqual(lastFresh.seq);
            }
            events = append(events, s);
            execute(table, s.event);
            wm = s.newWatermark;
            steps++;
            // append-only: the old rows are untouched, exactly one row was added
            expect(events.slice(0, before.length)).toEqual(before);
            expect(events).toHaveLength(before.length + 1);
            expect(wm).toBeGreaterThanOrEqual(0);
            expect(wm).toBeLessThanOrEqual(headSeq());
            agree();
            return true;
          };
          const freshEdit = (spec: EditSpec): void => {
            const row = emit(table, spec);
            if (row === null) return;
            if (at() < headSeq()) count("fresh edit after an Undo/Redo");
            events = append(events, { event: row });
            wm = null;
            lastFresh = { seq: headSeq(), board: trackedView(table) };
            steps++;
            agree();
            // a fresh edit leaves nothing to redo
            expect(tryStep("redo")).toBe(false);
          };
          for (const step of walk) {
            if (typeof step === "object") freshEdit(step.edit);
            else tryStep(step);
          }
          // undo everything: back to the fixtures as they stood before the ledger.
          // Undo walks back one registry row at a time, so the walk is bounded by
          // the ledger's length; a step past it is a runaway, not a slow pass.
          const undoBound = events.length;
          for (let i = 0; tryStep("undo"); i++) expect(i, "undo-all outran the ledger").toBeLessThan(undoBound);
          expect(wm).toBe(0);
          expect(view(events, wm)).toEqual(trackedView(freshSlots()));
          // redo everything: the board as it stood right after the newest fresh edit
          const redoBound = events.length;
          for (let i = 0; tryStep("redo"); i++) expect(i, "redo-all outran the ledger").toBeLessThan(redoBound);
          expect(wm).toBe(lastFresh.seq);
          expect(view(events, wm)).toEqual(lastFresh.board);
        },
      ),
      { numRuns: 200 },
    );
    // anti-vacuity: runs happened, steps were taken, every kind was undone at
    // least once, and the walk reached the paths fresh edits open up
    expect(runs).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(0);
    for (const [kind, n] of undoneKinds) expect(n, `${kind} was never undone`).toBeGreaterThan(0);
    for (const key of ["fresh edit after an Undo/Redo", "undo of an undo/redo row", "redo of an undo/redo row"]) {
      expect(seen.get(key) ?? 0, `${key} never happened`).toBeGreaterThan(0);
    }
  }, WALK_TIMEOUT_MS);
});
