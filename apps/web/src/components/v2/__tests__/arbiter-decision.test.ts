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
//   R5 (T16; it wrote nothing before) "Let the game go on" and each settle
//      button are requests like the others — R1, R3 and R4 hold for them; the
//      go-on's answer says how many flags were raised since the screen
//      loaded, a settle's whether the board is finished or now waits for the
//      tie-break's winner.
//   R6 The settle disclosure belongs to its board: switching closes it, and
//      so does a settle that FINISHES the board (a tie-break owed keeps it
//      open: the winner is still to pick).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import {
  arbiterDecision,
  decisionRunner,
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
      { type: "resync", boardId: "b1" },
      { type: "override", boardId: "b1" },
      { type: "goOn", boardId: "b1" },
      { type: "settle", boardId: "b1" },
      { type: "toggleSettle" },
      { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 2 } },
      { type: "overrideDone", boardId: "b1", outcome: { ok: true } },
      { type: "goOnDone", boardId: "b1", outcome: { ok: true, closed: 1, stillOpen: 0 } },
      { type: "settleDone", boardId: "b1", outcome: { ok: true, status: "finished" } },
    ];
    let checked = 0;
    for (const a of actions) {
      expect(arbiterDecision(s0, a), a.type).toBe(s0);
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("resync: in flight, then answered with what it adopted", () => {
    const s1 = run(on("b1"), { type: "resync", boardId: "b1" });
    expect(s1.busy).toEqual({ kind: "resync", boardId: "b1" });
    const s2 = run(s1, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 3 } });
    expect(s2.busy).toBeNull();
    expect(s2.notice).toEqual({ boardId: "b1", kind: "resynced", adopted: 3 });
  });

  it("resync with nothing at Lichess to read, and a refused resync, each say so", () => {
    const nothing = run(on("b1"), { type: "resync", boardId: "b1" }, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: false, adopted: 0 } });
    expect(nothing.notice).toEqual({ boardId: "b1", kind: "resync_nothing" });
    const failed = run(on("b1"), { type: "resync", boardId: "b1" }, { type: "resyncDone", boardId: "b1", outcome: { ok: false, code: "NOT_FOUND" } });
    expect(failed.notice).toEqual({ boardId: "b1", kind: "resync_failed", code: "NOT_FOUND" });
    expect(failed.busy).toBeNull();
  });

  it("R1: a second press while one is in flight changes nothing — of either kind", () => {
    const s1 = run(on("b1"), { type: "resync", boardId: "b1" });
    expect(arbiterDecision(s1, { type: "resync", boardId: "b1" })).toBe(s1);
    expect(arbiterDecision(s1, { type: "override", boardId: "b1" })).toBe(s1);
  });

  it("R3: a completion of the other kind, or for another board, or with nothing in flight, is ignored", () => {
    const s1 = run(on("b1"), { type: "resync", boardId: "b1" });
    expect(arbiterDecision(s1, { type: "overrideDone", boardId: "b1", outcome: { ok: true } })).toBe(s1);
    expect(arbiterDecision(s1, { type: "resyncDone", boardId: "b2", outcome: { ok: true, read: true, adopted: 1 } })).toBe(s1);
    const idle = on("b1");
    expect(arbiterDecision(idle, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 1 } })).toBe(idle);
  });

  it("R4: switching boards clears the notice; an answer for the board left behind frees the panel and shows nothing here", () => {
    const answered = run(on("b1"), { type: "goOn", boardId: "b1" }, { type: "goOnDone", boardId: "b1", outcome: { ok: true, closed: 2, stillOpen: 0 } });
    expect(answered.notice).toEqual({ boardId: "b1", kind: "went_on", stillOpen: 0 });
    expect(run(answered, { type: "select", boardId: "b2" }).notice).toBeNull();

    const left = run(on("b1"), { type: "override", boardId: "b1" }, { type: "select", boardId: "b2" });
    expect(left.busy, "the request is still in flight after the switch").toEqual({ kind: "override", boardId: "b1" });
    const landed = run(left, { type: "overrideDone", boardId: "b1", outcome: { ok: true } });
    expect(landed.busy).toBeNull();
    expect(landed.notice).toBeNull();
    expect(landed.boardId).toBe("b2");
  });

  it("a press that raced a switch (sent for the board just left): in flight for THAT board, this board's notice kept, its answer frees the panel", () => {
    const here = run(on("b2"), { type: "goOn", boardId: "b2" }, { type: "goOnDone", boardId: "b2", outcome: { ok: true, closed: 1, stillOpen: 1 } });
    const raced = run(here, { type: "resync", boardId: "b1" });
    expect(raced.busy).toEqual({ kind: "resync", boardId: "b1" });
    expect(raced.notice).toEqual({ boardId: "b2", kind: "went_on", stillOpen: 1 });
    const done = run(raced, { type: "resyncDone", boardId: "b1", outcome: { ok: true, read: true, adopted: 1 } });
    expect(done.busy).toBeNull();
    expect(done.notice).toEqual({ boardId: "b2", kind: "went_on", stillOpen: 1 });
  });

  it("R5: 'Let the game go on' is a request: in flight, answered with the flags raised since, refused by name — and refused while another is in flight", () => {
    const s = run(on("b1"), { type: "goOn", boardId: "b1" });
    expect(s.busy).toEqual({ kind: "goOn", boardId: "b1" });
    expect(run(s, { type: "goOnDone", boardId: "b1", outcome: { ok: true, closed: 1, stillOpen: 2 } }).notice).toEqual({ boardId: "b1", kind: "went_on", stillOpen: 2 });
    expect(run(s, { type: "goOnDone", boardId: "b1", outcome: { ok: false, code: "ARBITER_PLAYS_THIS_BOARD" } }).notice).toEqual({
      boardId: "b1", kind: "go_on_failed", code: "ARBITER_PLAYS_THIS_BOARD",
    });
    const inFlight = run(on("b1"), { type: "resync", boardId: "b1" });
    let refused = 0;
    for (const a of [{ type: "goOn", boardId: "b1" }, { type: "settle", boardId: "b1" }] as const) {
      expect(arbiterDecision(inFlight, a), a.type).toBe(inFlight);
      refused++;
    }
    expect(refused).toBe(2);
  });

  it("R5/R6: a settle that FINISHES the board closes the disclosure; one that opens the tie-break, or is refused, keeps it open", () => {
    const open = run(on("b1"), { type: "toggleSettle" }, { type: "settle", boardId: "b1" });
    expect(open.busy).toEqual({ kind: "settle", boardId: "b1" });
    const finished = run(open, { type: "settleDone", boardId: "b1", outcome: { ok: true, status: "finished" } });
    expect([finished.settleOpen, finished.notice]).toEqual([false, { boardId: "b1", kind: "settled", status: "finished" }]);
    const owed = run(open, { type: "settleDone", boardId: "b1", outcome: { ok: true, status: "tiebreak_owed" } });
    expect([owed.settleOpen, owed.notice]).toEqual([true, { boardId: "b1", kind: "settled", status: "tiebreak_owed" }]);
    const refused = run(open, { type: "settleDone", boardId: "b1", outcome: { ok: false, code: "ALREADY_RESOLVED" } });
    expect([refused.settleOpen, refused.notice]).toEqual([true, { boardId: "b1", kind: "settle_failed", code: "ALREADY_RESOLVED" }]);
    // A settle answered after a switch frees the panel and touches neither
    // the notice nor the disclosure of the board on screen.
    const switched = run(open, { type: "select", boardId: "b2" }, { type: "toggleSettle" });
    const landed = run(switched, { type: "settleDone", boardId: "b1", outcome: { ok: true, status: "finished" } });
    expect([landed.busy, landed.notice, landed.settleOpen]).toEqual([null, null, true]);
  });

  it("override: answered OK, or refused with Task 8's code", () => {
    const ok = run(on("b1"), { type: "override", boardId: "b1" }, { type: "overrideDone", boardId: "b1", outcome: { ok: true } });
    expect(ok.notice).toEqual({ boardId: "b1", kind: "overridden" });
    const refused = run(on("b1"), { type: "override", boardId: "b1" }, { type: "overrideDone", boardId: "b1", outcome: { ok: false, code: "VIDEO_NOT_REQUIRED" } });
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
  { arbitrary: board.map((boardId) => ({ type: "resync" as const, boardId })), weight: 3 },
  { arbitrary: board.map((boardId) => ({ type: "override" as const, boardId })), weight: 2 },
  { arbitrary: board.map((boardId) => ({ type: "goOn" as const, boardId })), weight: 2 },
  { arbitrary: board.map((boardId) => ({ type: "settle" as const, boardId })), weight: 2 },
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
  {
    arbitrary: fc.tuple(board, fc.nat(2)).map(([boardId, n]) => ({
      type: "goOnDone" as const,
      boardId,
      outcome: n === 0 ? { ok: false as const, code: "ARBITER_PLAYS_THIS_BOARD" } : { ok: true as const, closed: n, stillOpen: n - 1 },
    })),
    weight: 3,
  },
  {
    arbitrary: fc.tuple(board, fc.constantFrom("finished", "tiebreak_owed", "refused")).map(([boardId, r]) => ({
      type: "settleDone" as const,
      boardId,
      outcome: r === "refused" ? { ok: false as const, code: "ALREADY_RESOLVED" } : { ok: true as const, status: r as "finished" | "tiebreak_owed" },
    })),
    weight: 3,
  },
);

/** A settle and its answer back to back — the press-then-answer pair a
 *  uniform draw almost never lines up, so R6's "a finished board closes the
 *  disclosure" is reached by construction (counted below as settledClosed). */
const chunk: fc.Arbitrary<ArbiterDecisionAction[]> = fc.oneof(
  { arbitrary: action.map((a) => [a]), weight: 12 },
  {
    arbitrary: fc.tuple(board, fc.constantFrom("finished" as const, "tiebreak_owed" as const)).map(([boardId, status]): ArbiterDecisionAction[] => [
      { type: "settle", boardId },
      { type: "settleDone", boardId, outcome: { ok: true, status } },
    ]),
    weight: 2,
  },
);

/** The reference model: the rules above as the smallest state that states
 *  them — a selected board and at most one request. */
type Model = { selected: string | null; inflight: { kind: "resync" | "override" | "goOn" | "settle"; boardId: string } | null };
const DONE_KIND = { resyncDone: "resync", overrideDone: "override", goOnDone: "goOn", settleDone: "settle" } as const;

describe("the sequence sweep: the rules hold after every step", () => {
  it("random sequences over three boards (anti-vacuity: every rule's interesting branch is reached)", () => {
    const seen = { steps: 0, accepted: 0, racedPress: 0, refusedBusy: 0, staleIgnored: 0, landedHere: 0, landedElsewhere: 0, switches: 0, settledClosed: 0 };
    fc.assert(
      fc.property(fc.option(board, { nil: null }), fc.array(chunk, { minLength: 1, maxLength: 30 }).map((c) => c.flat()), (start, actions) => {
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
            case "goOn":
            case "settle":
              if (m.selected === null) expect(s, "R2").toBe(before);
              else if (m.inflight !== null) {
                expect(s, "R1").toBe(before);
                seen.refusedBusy++;
              } else {
                m.inflight = { kind: a.type, boardId: a.boardId };
                if (a.boardId === m.selected) expect(s.notice, "a new request clears this board's notice").toBeNull();
                else {
                  expect(s.notice, "a raced press leaves this board's notice").toEqual(before.notice);
                  seen.racedPress++;
                }
                seen.accepted++;
              }
              break;
            case "toggleSettle":
              if (m.selected === null) expect(s).toBe(before);
              else expect(s.settleOpen).toBe(!before.settleOpen);
              break;
            case "resyncDone":
            case "overrideDone":
            case "goOnDone":
            case "settleDone": {
              const kind = DONE_KIND[a.type];
              const answers = m.inflight !== null && m.inflight.kind === kind && m.inflight.boardId === a.boardId;
              if (!answers) {
                expect(s, "R3").toBe(before);
                seen.staleIgnored++;
              } else {
                m.inflight = null;
                if (a.boardId === m.selected) {
                  expect(s.notice?.boardId).toBe(a.boardId);
                  // R6: only a FINISHED board closes the disclosure.
                  const finishes = a.type === "settleDone" && a.outcome.ok && a.outcome.status === "finished";
                  expect(s.settleOpen, "R6").toBe(finishes ? false : before.settleOpen);
                  if (finishes) seen.settledClosed++;
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

describe("the runner: what reaches the network", () => {
  type Sent = { path: string; body: unknown };
  function harness(answer: (path: string) => Promise<unknown>) {
    let state = initialArbiterDecision("b1");
    const sent: Sent[] = [];
    let refreshed = 0;
    const runner = decisionRunner({
      dispatch: (a) => (state = arbiterDecision(state, a)),
      post: (path, body) => (sent.push({ path, body }), answer(path)),
      refresh: () => void (refreshed += 1),
      overrideNote: "the note",
    });
    return { runner, sent, get state() { return state; }, get refreshed() { return refreshed; } };
  }

  it("a double tap sends ONE resync; its answer lands and the page refreshes", async () => {
    let release!: (v: unknown) => void;
    const h = harness(() => new Promise((r) => (release = r)));
    const first = h.runner.resync("b1");
    const second = await h.runner.resync("b1");
    expect(second, "the second press is refused before the network").toBe(false);
    expect(h.sent).toEqual([{ path: "/api/v1/fixtures/b1/external-play/resync", body: undefined }]);
    expect(h.state.busy).toEqual({ kind: "resync", boardId: "b1" });
    release({ read: true, adopted: 2, finished: false });
    expect(await first).toBe(true);
    expect(h.state.busy).toBeNull();
    expect(h.state.notice).toEqual({ boardId: "b1", kind: "resynced", adopted: 2 });
    expect(h.refreshed).toBe(1);
    // …and after it, a press is a new request.
    const third = h.runner.override("b1");
    release(undefined);
    await third;
    expect(h.sent.map((x) => x.path)).toEqual(["/api/v1/fixtures/b1/external-play/resync", "/api/v1/fixtures/b1/external-play/video-override"]);
    expect(h.sent[1]!.body).toEqual({ note: "the note" });
  });

  it("T16: 'Let the game go on' sends the ids ON SCREEN to flags/close; a settle sends its button to resolve — one request at a time across kinds", async () => {
    let release!: (v: unknown) => void;
    const h = harness(() => new Promise((r) => (release = r)));
    const goOn = h.runner.goOn("b1", ["f1", "f2"]);
    expect(await h.runner.settle("b1", "draw"), "a settle while the go-on is in flight is refused before the network").toBe(false);
    release({ closed: 2, stillOpen: 1 });
    await goOn;
    expect(h.state.notice).toEqual({ boardId: "b1", kind: "went_on", stillOpen: 1 });
    const settle = h.runner.settle("b1", "away_wins");
    release({ status: "finished" });
    await settle;
    expect(h.sent).toEqual([
      { path: "/api/v1/fixtures/b1/external-play/flags/close", body: { ids: ["f1", "f2"] } },
      { path: "/api/v1/fixtures/b1/external-play/resolve", body: { kind: "away_wins" } },
    ]);
    expect(h.state.notice).toEqual({ boardId: "b1", kind: "settled", status: "finished" });
    expect(h.refreshed).toBe(2);
  });

  it("a refusal carries the route's code, frees the panel, and does not refresh", async () => {
    const h = harness(() => Promise.reject(new ApiV1Error("x", 409, "VIDEO_NOT_REQUIRED")));
    await h.runner.override("b1");
    expect(h.state.busy).toBeNull();
    expect(h.state.notice).toEqual({ boardId: "b1", kind: "override_failed", code: "VIDEO_NOT_REQUIRED" });
    expect(h.refreshed).toBe(0);
    const n = harness(() => Promise.reject(new TypeError("network")));
    await n.runner.resync("b1");
    expect(n.state.notice).toEqual({ boardId: "b1", kind: "resync_failed", code: "UNKNOWN" });
  });
});
