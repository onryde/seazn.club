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
// below independently of `fold`), then a random walk of Undo / Redo with the
// invariants checked after every step.
//
// Kinds: the placement ops and the pool clear. The generation pair is left
// out on purpose: fold's fixtures_generated never reads a snapshot's slot, so
// apply ∘ invert is not the identity on placement there (recorded in the
// mutation-debt report; no production code reads the fold today).
//
// NOT covered, deliberately: a fresh edit AFTER an Undo followed by more
// Undo/Redo. That path is the defect recorded in the mutation-debt report
// (edit, edit, Undo, fresh edit, Undo, Undo, Redo leaves the ledger head —
// what the executor wrote — disagreeing with fold at the watermark); it is
// owed a ruling and a fix, not a test that freezes either side of it.
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

/** Emit one event per spec from the tracked placement, skipping a spec that
 *  would touch nothing (an emitter appends no event for a no-op). */
function mixedLedger(specs: fc.Arbitrary<EditSpec[]>) {
  return specs.map((list) => {
    const slot = new Map<string, Slot>(FIX.map((id) => [id, { ...DEFAULT_SLOT }]));
    const events: LedgerEvent[] = [];
    const add = (type: string, payload: Record<string, unknown>) => events.push({ seq: events.length + 1, type, payload });
    for (const s of list) {
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
        if (moves.length > 0) add(s.kind, { moves });
      } else if (s.kind === "schedule_shifted") {
        const moves = FIX.filter((id) => slot.get(id)!.exists && slot.get(id)!.at !== null).map((id) => {
          const f = slot.get(id)!;
          const to = new Date(Date.parse(f.at!) + s.minutes * 60_000).toISOString();
          const m = { fixture: id, from: { at: f.at, court: f.court }, to: { at: to, court: f.court } };
          f.at = to;
          return m;
        });
        if (moves.length > 0) add(s.kind, { minutes: s.minutes, moves });
      } else if (s.kind === "schedule_edited") {
        const f = slot.get(s.fixture)!;
        if (!f.exists) continue;
        const from = s.locked === undefined ? { at: f.at, court: f.court } : { at: f.at, court: f.court, locked: f.locked };
        const to = s.locked === undefined ? { at: s.at, court: s.court } : { at: s.at, court: s.court, locked: s.locked };
        add(s.kind, { fixture: s.fixture, from, to });
        f.at = s.at;
        f.court = s.court;
        if (s.locked !== undefined) f.locked = s.locked;
      } else if (s.kind === "schedule_cleared") {
        const cleared = s.picks
          .filter((id) => slot.get(id)!.exists && (slot.get(id)!.at !== null || slot.get(id)!.court !== null))
          .map((id) => {
            const f = slot.get(id)!;
            const snap = { id, at: f.at, court: f.court };
            f.at = null;
            f.court = null;
            return snap;
          });
        if (cleared.length > 0) add(s.kind, { scope: { excludeLocked: false }, cleared });
      } else {
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
        if (fixtures.length > 0) add(s.kind, { pool_id: "pA", fixtures });
      }
    }
    return { events, final: new Map([...slot].map(([id, f]) => [id, { ...f }])) };
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

describe("history properties — mixed registry kinds (rule 10)", () => {
  it("every Undo/Redo step appends one event and keeps head and watermark in agreement; undo-all / redo-all round-trip", () => {
    const undoneKinds = new Map<string, number>(KINDS.map((k) => [k, 0]));
    let steps = 0;
    let runs = 0;
    fc.assert(
      fc.property(
        mixedLedger(fc.array(editSpec, { minLength: 1, maxLength: 12 })),
        fc.array(fc.constantFrom<"undo" | "redo">("undo", "redo"), { minLength: 1, maxLength: 24 }),
        ({ events: ledger, final }, walk) => {
          fc.pre(ledger.length > 0);
          runs++;
          // the tracker (the emitters' own view) and the fold agree on the ledger as written
          expect(view(ledger, null)).toEqual(trackedView(final));
          let events = ledger;
          let wm = ledger.length;
          const tryStep = (action: "undo" | "redo"): boolean => {
            let s: ReturnType<typeof undo>;
            try {
              s = action === "undo" ? undo(events, wm, NONE) : redo(events, wm, NONE);
            } catch (err) {
              expect((err as { code?: string }).code).toBe(action === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO");
              return false;
            }
            const before = events;
            if (action === "undo") {
              const target = before.find((e) => e.seq === s.event.payload.__undo_of)!;
              undoneKinds.set(target.type, (undoneKinds.get(target.type) ?? 0) + 1);
              expect(s.newWatermark).toBeLessThan(wm);
            } else {
              expect(s.newWatermark).toBeGreaterThan(wm);
            }
            events = append(events, s);
            wm = s.newWatermark;
            steps++;
            // append-only: the old rows are untouched, exactly one row was added
            expect(events.slice(0, before.length)).toEqual(before);
            expect(events).toHaveLength(before.length + 1);
            expect(wm).toBeGreaterThanOrEqual(0);
            expect(wm).toBeLessThanOrEqual(events[events.length - 1]!.seq);
            // what the executor has written (every row, in order) is what the watermark says
            expect(view(events, null)).toEqual(view(events, wm));
            return true;
          };
          for (const action of walk) tryStep(action);
          // undo everything: back to the fixtures as they stood before the ledger.
          // Each original edit is undone at most once, so the walk is bounded by
          // the ledger's length; a step past it is a runaway, not a slow pass.
          for (let i = 0; tryStep("undo"); i++) expect(i, "undo-all outran the ledger").toBeLessThan(ledger.length);
          expect(wm).toBe(0);
          expect(view(events, wm)).toEqual(trackedView(new Map(FIX.map((id) => [id, { ...DEFAULT_SLOT }]))));
          // redo everything: the ledger's own end state again
          for (let i = 0; tryStep("redo"); i++) expect(i, "redo-all outran the ledger").toBeLessThan(ledger.length);
          expect(wm).toBe(ledger.length);
          expect(view(events, wm)).toEqual(trackedView(final));
        },
      ),
      { numRuns: 200 },
    );
    // anti-vacuity: runs happened, steps were taken, and every kind was undone at least once
    expect(runs).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(0);
    for (const [kind, n] of undoneKinds) expect(n, `${kind} was never undone`).toBeGreaterThan(0);
  });
});
