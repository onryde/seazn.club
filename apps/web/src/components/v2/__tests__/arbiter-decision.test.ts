// T15 — the arbiter's decision actions (canvas "Your decision · Board N"):
// "Resync from Lichess", "Let the game go on", "Settle the result now…", and
// the outage card's "Let this board play without video". An ordered-action
// surface (controller rule): every transition is pinned below, then a
// fast-check sequence sweep holds the rules after EVERY step of random
// sequences across three boards.
//
// The rules, from the canvas and design §5.3 — never from the reducer:
//   R1 One request at a time: a second resync/override while one is in flight
//      changes nothing (a double tap cannot send two).
//   R2 Nothing acts without a board on screen.
//   R3 A completion lands only if it answers THE request in flight (same kind,
//      same board); anything else — a duplicate, a stale answer — is ignored.
//   R4 A notice belongs to the board on screen: switching boards clears it,
//      and an answer for a board no longer on screen frees the panel but shows
//      nothing on this one.
//   R5 "Let the game go on" writes nothing: never in flight, only a notice.
//   R6 The settle disclosure belongs to its board: switching closes it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  arbiterDecision,
  initialArbiterDecision,
  type ArbiterDecisionAction,
  type ArbiterDecisionState,
} from "../arbiter-decision";

const run = (s: ArbiterDecisionState, ...actions: ArbiterDecisionAction[]) => actions.reduce(arbiterDecision, s);
const on = (boardId: string | null) => initialArbiterDecision(boardId);

describe("transitions", () => {
  it("the empty case: no board on screen — every action is a no-op", () => {
    const s0 = on(null);
    expect(s0).toEqual({ boardId: null, busy: null, settleOpen: false, notice: null });
    const actions: ArbiterDecisionAction[] = [
      { type: "resync" },
      { type: "override" },
      { type: "goOn" },
      { type: "toggleSettle" },
      { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 2 } },
      { type: "overrideDone", boardId: "b1", outcome: { ok: true } },
    ];
    let checked = 0;
    for (const a of actions) {
      expect(arbiterDecision(s0, a), a.type).toBe(s0);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("resync: in flight, then answered with what it adopted", () => {
    const s1 = run(on("b1"), { type: "resync" });
    expect(s1.busy).toEqual({ kind: "resync", boardId: "b1" });
    const s2 = run(s1, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 3 } });
    expect(s2.busy).toBeNull();
    expect(s2.notice).toEqual({ boardId: "b1", kind: "resynced", adopted: 3 });
  });

  it("resync with nothing at Lichess to read, and a refused resync, each say so", () => {
    const nothing = run(on("b1"), { type: "resync" }, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: false, adopted: 0 } });
    expect(nothing.notice).toEqual({ boardId: "b1", kind: "resync_nothing" });
    const failed = run(on("b1"), { type: "resync" }, { type: "resyncDone", boardId: "b1", outcome: { ok: false, code: "NOT_FOUND" } });
    expect(failed.notice).toEqual({ boardId: "b1", kind: "resync_failed", code: "NOT_FOUND" });
    expect(failed.busy).toBeNull();
  });

  it("R1: a second press while one is in flight changes nothing — of either kind", () => {
    const s1 = run(on("b1"), { type: "resync" });
    expect(arbiterDecision(s1, { type: "resync" })).toBe(s1);
    expect(arbiterDecision(s1, { type: "override" })).toBe(s1);
  });

  it("R3: a completion of the other kind, or for another board, or with nothing in flight, is ignored", () => {
    const s1 = run(on("b1"), { type: "resync" });
    expect(arbiterDecision(s1, { type: "overrideDone", boardId: "b1", outcome: { ok: true } })).toBe(s1);
    expect(arbiterDecision(s1, { type: "resyncDone", boardId: "b2", outcome: { ok: true, read: true, adopted: 1 } })).toBe(s1);
    const idle = on("b1");
    expect(arbiterDecision(idle, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 1 } })).toBe(idle);
  });

  it("R4: switching boards clears the notice; an answer for the board left behind frees the panel and shows nothing here", () => {
    const answered = run(on("b1"), { type: "goOn" });
    expect(answered.notice).toEqual({ boardId: "b1", kind: "went_on" });
    expect(run(answered, { type: "select", boardId: "b2" }).notice).toBeNull();

    const left = run(on("b1"), { type: "override" }, { type: "select", boardId: "b2" });
    expect(left.busy, "the request is still in flight after the switch").toEqual({ kind: "override", boardId: "b1" });
    const landed = run(left, { type: "overrideDone", boardId: "b1", outcome: { ok: true } });
    expect(landed.busy).toBeNull();
    expect(landed.notice).toBeNull();
    expect(landed.boardId).toBe("b2");
  });

  it("R5: 'Let the game go on' never puts anything in flight, and is refused while a request is", () => {
    const s = run(on("b1"), { type: "goOn" });
    expect(s.busy).toBeNull();
    const inFlight = run(on("b1"), { type: "resync" });
    expect(arbiterDecision(inFlight, { type: "goOn" })).toBe(inFlight);
  });

  it("override: answered OK, or refused with Task 8's code", () => {
    const ok = run(on("b1"), { type: "override" }, { type: "overrideDone", boardId: "b1", outcome: { ok: true } });
    expect(ok.notice).toEqual({ boardId: "b1", kind: "overridden" });
    const refused = run(on("b1"), { type: "override" }, { type: "overrideDone", boardId: "b1", outcome: { ok: false, code: "VIDEO_NOT_REQUIRED" } });
    expect(refused.notice).toEqual({ boardId: "b1", kind: "override_failed", code: "VIDEO_NOT_REQUIRED" });
  });

  it("R6: the settle disclosure toggles, and closes on a switch — also on re-selecting the same board", () => {
    const open = run(on("b1"), { type: "toggleSettle" });
    expect(open.settleOpen).toBe(true);
    expect(run(open, { type: "toggleSettle" }).settleOpen).toBe(false);
    expect(run(open, { type: "select", boardId: "b2" }).settleOpen).toBe(false);
    // Re-selecting the board on screen is not a switch: nothing changes.
    expect(arbiterDecision(open, { type: "select", boardId: "b1" })).toBe(open);
  });
});

// ── the sequence sweep ─────────────────────────────────────────────────────
const BOARDS = ["b1", "b2", "b3"] as const;
const board = fc.constantFrom(...BOARDS);
const action: fc.Arbitrary<ArbiterDecisionAction> = fc.oneof(
  { arbitrary: board.map((boardId) => ({ type: "select" as const, boardId })), weight: 3 },
  { arbitrary: fc.constant({ type: "resync" as const }), weight: 3 },
  { arbitrary: fc.constant({ type: "override" as const }), weight: 2 },
  { arbitrary: fc.constant({ type: "goOn" as const }), weight: 2 },
  { arbitrary: fc.constant({ type: "toggleSettle" as const }), weight: 2 },
  {
    arbitrary: fc.tuple(board, fc.boolean(), fc.nat(5)).map(([boardId, read, adopted]) => ({
      type: "resyncDone" as const,
      boardId,
      outcome: read ? { ok: true as const, read: true, adopted } : { ok: false as const, code: "NOT_FOUND" },
    })),
    weight: 4,
  },
  {
    arbitrary: fc.tuple(board, fc.boolean()).map(([boardId, ok]) => ({
      type: "overrideDone" as const,
      boardId,
      outcome: ok ? { ok: true as const } : { ok: false as const, code: "FIXTURE_NOT_PLAYABLE" },
    })),
    weight: 3,
  },
);

/** The reference model: the rules above as the smallest state that states
 *  them — a selected board and at most one request. */
type Model = { selected: string | null; inflight: { kind: "resync" | "override"; boardId: string } | null };

describe("the sequence sweep: the rules hold after every step", () => {
  it("random sequences over three boards (anti-vacuity: every rule's interesting branch is reached)", () => {
    const seen = { steps: 0, accepted: 0, refusedBusy: 0, staleIgnored: 0, landedHere: 0, landedElsewhere: 0, switches: 0 };
    fc.assert(
      fc.property(fc.option(board, { nil: null }), fc.array(action, { minLength: 1, maxLength: 40 }), (start, actions) => {
        let s = initialArbiterDecision(start);
        const m: Model = { selected: start, inflight: null };
        for (const a of actions) {
          const before = s;
          s = arbiterDecision(s, a);
          seen.steps++;
          switch (a.type) {
            case "select":
              if (m.selected !== a.boardId) {
                seen.switches++;
                expect(s.notice, "R4: a switch clears the notice").toBeNull();
                expect(s.settleOpen, "R6").toBe(false);
              }
              m.selected = a.boardId;
              break;
            case "resync":
            case "override":
              if (m.selected === null) expect(s, "R2").toBe(before);
              else if (m.inflight !== null) {
                expect(s, "R1").toBe(before);
                seen.refusedBusy++;
              } else {
                m.inflight = { kind: a.type, boardId: m.selected };
                seen.accepted++;
              }
              break;
            case "goOn":
              if (m.selected !== null && m.inflight === null) expect(s.notice).toEqual({ boardId: m.selected, kind: "went_on" });
              else expect(s, "R2/R5").toBe(before);
              break;
            case "toggleSettle":
              if (m.selected === null) expect(s).toBe(before);
              else expect(s.settleOpen).toBe(!before.settleOpen);
              break;
            case "resyncDone":
            case "overrideDone": {
              const kind = a.type === "resyncDone" ? "resync" : "override";
              const answers = m.inflight !== null && m.inflight.kind === kind && m.inflight.boardId === a.boardId;
              if (!answers) {
                expect(s, "R3").toBe(before);
                seen.staleIgnored++;
              } else {
                m.inflight = null;
                if (a.boardId === m.selected) {
                  expect(s.notice?.boardId).toBe(a.boardId);
                  seen.landedHere++;
                } else {
                  expect(s.notice, "R4: answered off-screen").toEqual(before.notice);
                  seen.landedElsewhere++;
                }
              }
              break;
            }
          }
          // After EVERY step:
          expect(s.boardId).toBe(m.selected);
          expect(s.busy).toEqual(m.inflight);
          if (s.notice !== null) expect(s.notice.boardId, "R4: a notice is for the board on screen").toBe(s.boardId);
          if (s.settleOpen) expect(s.boardId).not.toBeNull();
        }
      }),
      { numRuns: 1200, seed: 1512 },
    );
    expect(seen.steps).toBeGreaterThan(1_000);
    for (const [k, n] of Object.entries(seen)) expect(n, `anti-vacuity: ${k}`).toBeGreaterThan(20);
  });
});
