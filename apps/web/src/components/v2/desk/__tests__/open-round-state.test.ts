// T16 (D12) — the Open round control's actions as one reducer plus the runner
// that puts them on the network. The rules, each pinned below and then held
// over random sequences (fast-check) against a model written from the rules —
// never from the reducer:
//   R1 one request at a time, across the round's Open AND its pairings' Resend;
//   R2 the round is opened only from its confirmation: no press sends without
//      the dialog having stated how many and to whom;
//   R3 an answer lands only if it answers the request in flight;
//   R4 while a request is in flight the confirmation can be neither asked for
//      nor dismissed (its buttons are busy);
//   R5 the open's answer closes the confirmation and is the round's notice;
//      a resend's answer is its pairing's notice.
// Spec §3.2.2: "+5 min to the round" (`extend`) is a third request under R1, R3 and R4 (the dialog is modal), and its answer is the
// round's SECOND notice (`extendNotice`), which neither the open's answer nor the resend's touches.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ApiV1Error } from "@/lib/client-v1";
import type { OpenRoundResult } from "@/lib/open-round";
import type { CheckinExtendRoundResult } from "@/lib/checkin-extend";
import {
  initialOpenRoundUi,
  openRoundRunner,
  openRoundUi,
  type OpenRoundUiAction,
  type OpenRoundUiState,
} from "../open-round-state";

const OPENED: OpenRoundResult = { opened: true, invited: 4, retrying: 0, skipped: [] };
const EXTENDED: CheckinExtendRoundResult = {
  extended: 6,
  skipped: { closed: 1, gameStarted: 2, capReached: 0 },
  notOpenYet: 0,
  ownBoards: 0,
  failed: 0,
  addedMinutes: 5,
};
const s0 = initialOpenRoundUi();
const run = (...actions: OpenRoundUiAction[]) => actions.reduce(openRoundUi, s0);

describe("open-round reducer — the rules, one at a time", () => {
  it("the empty case first: nothing pressed ⇒ no dialog, nothing in flight, no notice", () => {
    expect(s0).toEqual({ confirming: false, busy: null, notice: null, rowNotice: null, extendNotice: null });
  });

  it("R2: Open sends nothing until the confirmation is up; from it, it is THE request in flight", () => {
    expect(run({ type: "open" }), "no dialog ⇒ refused").toEqual(s0);
    const asked = run({ type: "ask" });
    expect(asked.confirming).toBe(true);
    expect(openRoundUi(asked, { type: "open" }).busy).toEqual({ kind: "open" });
  });

  it("R1: a second Open, or a Resend, while the first is in flight is refused; so is a second Resend", () => {
    const sending = run({ type: "ask" }, { type: "open" });
    expect(openRoundUi(sending, { type: "open" })).toBe(sending);
    expect(openRoundUi(sending, { type: "resend", fixtureId: "f1" })).toBe(sending);
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(resending.busy).toEqual({ kind: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "resend", fixtureId: "f2" })).toBe(resending);
    expect(openRoundUi(resending, { type: "ask" }), "R4: no dialog over a request in flight").toBe(resending);
  });

  it("R4: the dialog cannot be dismissed while its request is in flight; before, Cancel closes it and sends nothing", () => {
    const sending = run({ type: "ask" }, { type: "open" });
    expect(openRoundUi(sending, { type: "cancel" })).toBe(sending);
    expect(run({ type: "ask" }, { type: "cancel" })).toEqual(s0);
  });

  it("R3 + R5: the open's answer closes the dialog and becomes the notice; an answer nobody asked for is dropped", () => {
    const stray = openRoundUi(s0, { type: "openDone", outcome: { ok: true, result: OPENED } });
    expect(stray, "no open in flight").toBe(s0);
    const done = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: true, result: OPENED } });
    expect(done).toEqual({ confirming: false, busy: null, notice: { kind: "answered", result: OPENED }, rowNotice: null, extendNotice: null });
    const failed = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: false, code: "ROUND_CHANGED" } });
    expect(failed.notice).toEqual({ kind: "failed", code: "ROUND_CHANGED" });
    expect(failed.confirming).toBe(false);
  });

  it("R3 + R5: a resend's answer lands on ITS pairing; one for another pairing, or for the open, is dropped", () => {
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "resendDone", fixtureId: "f2", outcome: { ok: true, emailed: 2 } })).toBe(resending);
    expect(openRoundUi(resending, { type: "openDone", outcome: { ok: true, result: OPENED } })).toBe(resending);
    const done = openRoundUi(resending, { type: "resendDone", fixtureId: "f1", outcome: { ok: true, emailed: 2 } });
    expect(done).toEqual({
      confirming: false,
      busy: null,
      notice: null,
      rowNotice: { fixtureId: "f1", notice: { kind: "resent", emailed: 2 } },
      extendNotice: null,
    });
  });

  it("a new request clears the answer it replaces (the round's for an open, the pairing's for a resend)", () => {
    const answered = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: false, code: "X" } });
    expect(run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: false, code: "X" } }, { type: "ask" }, { type: "open" }).notice).toBeNull();
    const resent = openRoundUi(openRoundUi(answered, { type: "resend", fixtureId: "f1" }), {
      type: "resendDone",
      fixtureId: "f1",
      outcome: { ok: false, code: "WINDOW_CLOSED" },
    });
    expect(resent.notice, "the round's own notice is not the pairing's to clear").toEqual(answered.notice);
    expect(openRoundUi(resent, { type: "resend", fixtureId: "f2" }).rowNotice).toBeNull();
  });

  it("R1 + R4: +5 min is THE request in flight - a second one, an Open and a Resend are refused behind it - and it is refused under the dialog", () => {
    const extending = run({ type: "extend" });
    expect(extending.busy).toEqual({ kind: "extend" });
    expect(openRoundUi(extending, { type: "extend" }), "a second +5 min").toBe(extending);
    expect(openRoundUi(extending, { type: "ask" }), "no dialog over it").toBe(extending);
    expect(openRoundUi(extending, { type: "resend", fixtureId: "f1" })).toBe(extending);
    const sending = run({ type: "ask" }, { type: "open" });
    expect(openRoundUi(sending, { type: "extend" }), "behind an Open in flight").toBe(sending);
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "extend" }), "behind a Resend in flight").toBe(resending);
    const asked = run({ type: "ask" });
    expect(openRoundUi(asked, { type: "extend" }), "the confirmation is modal").toBe(asked);
  });

  it("R3: a +5 min answer lands only on the +5 min in flight; it is the round's extend notice, and it touches neither of the others", () => {
    expect(openRoundUi(s0, { type: "extendDone", outcome: { ok: true, result: EXTENDED } }), "nothing in flight").toBe(s0);
    const opening = run({ type: "ask" }, { type: "open" });
    expect(openRoundUi(opening, { type: "extendDone", outcome: { ok: true, result: EXTENDED } }), "an Open in flight").toBe(opening);
    const answeredOpen = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: true, result: OPENED } });
    const done = openRoundUi(openRoundUi(answeredOpen, { type: "extend" }), { type: "extendDone", outcome: { ok: true, result: EXTENDED } });
    expect(done).toEqual({
      confirming: false,
      busy: null,
      notice: { kind: "answered", result: OPENED },
      rowNotice: null,
      extendNotice: { kind: "answered", result: EXTENDED },
    });
    const failed = run({ type: "extend" }, { type: "extendDone", outcome: { ok: false, code: "ROUND_NOT_OPEN" } });
    expect(failed.extendNotice).toEqual({ kind: "failed", code: "ROUND_NOT_OPEN" });
    expect(run({ type: "extend" }, { type: "extendDone", outcome: { ok: true, result: EXTENDED } }, { type: "extend" }).extendNotice, "a new press clears the old answer").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sequence property: random presses and answers, the reducer against a
// model of R1–R5 (written from the rules above).

type Model = { confirming: boolean; busy: OpenRoundUiState["busy"] };
const IDS = ["f1", "f2"] as const;
const openDone = (ok: boolean): OpenRoundUiAction =>
  ok ? { type: "openDone", outcome: { ok: true, result: OPENED } } : { type: "openDone", outcome: { ok: false, code: "E" } };
const resendDone = (fixtureId: string, ok: boolean): OpenRoundUiAction =>
  ok
    ? { type: "resendDone", fixtureId, outcome: { ok: true, emailed: 2 } }
    : { type: "resendDone", fixtureId, outcome: { ok: false, code: "E" } };
const extendDone = (ok: boolean): OpenRoundUiAction =>
  ok ? { type: "extendDone", outcome: { ok: true, result: EXTENDED } } : { type: "extendDone", outcome: { ok: false, code: "E" } };
const actionArb: fc.Arbitrary<OpenRoundUiAction> = fc.oneof(
  fc.constant<OpenRoundUiAction>({ type: "extend" }),
  fc.boolean().map(extendDone),
  fc.constant<OpenRoundUiAction>({ type: "ask" }),
  fc.constant<OpenRoundUiAction>({ type: "cancel" }),
  fc.constant<OpenRoundUiAction>({ type: "open" }),
  fc.constantFrom(...IDS).map((fixtureId): OpenRoundUiAction => ({ type: "resend", fixtureId })),
  fc.boolean().map(openDone),
  fc.tuple(fc.constantFrom(...IDS), fc.boolean()).map(([fixtureId, ok]) => resendDone(fixtureId, ok)),
);

function step(m: Model, a: OpenRoundUiAction): Model {
  switch (a.type) {
    case "ask":
      return m.busy === null ? { ...m, confirming: true } : m;
    case "cancel":
      return m.busy === null ? { ...m, confirming: false } : m;
    case "open":
      return m.busy === null && m.confirming ? { ...m, busy: { kind: "open" } } : m;
    case "resend":
      return m.busy === null && !m.confirming ? { ...m, busy: { kind: "resend", fixtureId: a.fixtureId } } : m;
    case "extend":
      return m.busy === null && !m.confirming ? { ...m, busy: { kind: "extend" } } : m;
    case "extendDone":
      return m.busy?.kind === "extend" ? { ...m, busy: null } : m;
    case "openDone":
      return m.busy?.kind === "open" ? { confirming: false, busy: null } : m;
    case "resendDone":
      return m.busy?.kind === "resend" && m.busy.fixtureId === a.fixtureId ? { ...m, busy: null } : m;
  }
}

describe("open-round reducer — random sequences hold R1–R5", () => {
  it("over random sequences the reducer agrees with the rules' model at every step (anti-vacuity: each rule's case reached)", () => {
    const reached = { opens: 0, refusedSecond: 0, resends: 0, strayDone: 0, cancelBusy: 0, extends: 0, extendRefused: 0, extendAnswered: 0 };
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 24 }), (actions) => {
        let s = s0;
        let m: Model = { confirming: false, busy: null };
        for (const a of actions) {
          const before = s;
          s = openRoundUi(s, a);
          m = step(m, a);
          expect({ confirming: s.confirming, busy: s.busy }).toEqual(m);
          // R1: never two requests, by construction of `busy`; count what the property saw.
          if (a.type === "open" && before.busy === null && before.confirming) reached.opens += 1;
          if ((a.type === "open" || a.type === "resend") && before.busy !== null) reached.refusedSecond += 1;
          if (a.type === "extend" && before.busy === null && !before.confirming) reached.extends += 1;
          if (a.type === "extend" && (before.busy !== null || before.confirming)) reached.extendRefused += 1;
          if (a.type === "extendDone" && before.busy?.kind === "extend") reached.extendAnswered += 1;
          if (a.type === "resend" && before.busy === null && !before.confirming) reached.resends += 1;
          if ((a.type === "openDone" || a.type === "resendDone" || a.type === "extendDone") && s === before) reached.strayDone += 1;
          if (a.type === "cancel" && before.busy !== null) reached.cancelBusy += 1;
          // R5: an open's answer is the round's notice, and only it sets one.
          if (a.type === "openDone" && before.busy?.kind === "open") {
            expect(s.notice).toEqual(a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code });
          } else if (a.type !== "open") {
            expect(s.notice).toBe(before.notice);
          }
          // Spec §3.2.2: the extend notice is set by an extend's answer and cleared by an extend press, and by nothing else.
          if (a.type === "extendDone" && before.busy?.kind === "extend") {
            expect(s.extendNotice).toEqual(a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code });
          } else if (!(a.type === "extend" && before.busy === null && !before.confirming)) {
            expect(s.extendNotice).toBe(before.extendNotice);
          }
        }
      }),
      { numRuns: 300, seed: 160416 },
    );
    for (const [rule, n] of Object.entries(reached)) expect(n, `anti-vacuity: ${rule}`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The runner: what reaches the network.

describe("openRoundRunner — at most one request on the network", () => {
  it("a double tap sends ONE open; its answer is dispatched and the page refreshes", async () => {
    const dispatch = vi.fn();
    let answer!: (v: unknown) => void;
    const post = vi.fn(() => new Promise((r) => (answer = r)));
    const refresh = vi.fn();
    const runner = openRoundRunner({ dispatch, post, refresh });
    const first = runner.open("s1", 2);
    expect(await runner.open("s1", 2), "the second tap").toBe(false);
    expect(await runner.resend("f1"), "a resend while the open is in flight").toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/stages/s1/open-round", { roundNo: 2 });
    answer(OPENED);
    expect(await first).toBe(true);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
      { type: "open" },
      { type: "openDone", outcome: { ok: true, result: OPENED } },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refusal's CODE is dispatched (never its English message) and nothing is refreshed; the next tap is sent", async () => {
    const dispatch = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new ApiV1Error("Round changed", 409, "ROUND_CHANGED")).mockResolvedValueOnce({ emailed: 2 });
    const refresh = vi.fn();
    const runner = openRoundRunner({ dispatch, post, refresh });
    await runner.open("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openDone", outcome: { ok: false, code: "ROUND_CHANGED" } });
    expect(refresh).not.toHaveBeenCalled();
    expect(await runner.resend("f 1")).toBe(true);
    expect(post).toHaveBeenLastCalledWith("/api/v1/fixtures/f%201/external-play/resend", undefined);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "resendDone", fixtureId: "f 1", outcome: { ok: true, emailed: 2 } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("+5 min posts the round to the extend route ONCE, whatever the double tap, and refreshes on its answer", async () => {
    const dispatch = vi.fn();
    let answer!: (v: unknown) => void;
    const post = vi.fn(() => new Promise((r) => (answer = r)));
    const refresh = vi.fn();
    const runner = openRoundRunner({ dispatch, post, refresh });
    const first = runner.extend("s 1", 2);
    expect(await runner.extend("s 1", 2), "the second tap").toBe(false);
    expect(await runner.open("s 1", 2), "an open while it is in flight").toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/stages/s%201/extend-checkin", { roundNo: 2 });
    answer(EXTENDED);
    expect(await first).toBe(true);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
      { type: "extend" },
      { type: "extendDone", outcome: { ok: true, result: EXTENDED } },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refused +5 min dispatches the door's CODE and refreshes nothing; the next tap is sent", async () => {
    const dispatch = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new ApiV1Error("Round not open", 409, "ROUND_NOT_OPEN")).mockResolvedValueOnce(EXTENDED);
    const refresh = vi.fn();
    const runner = openRoundRunner({ dispatch, post, refresh });
    await runner.extend("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "extendDone", outcome: { ok: false, code: "ROUND_NOT_OPEN" } });
    expect(refresh).not.toHaveBeenCalled();
    expect(await runner.extend("s1", 1)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a thrown non-API error is UNKNOWN, and frees the runner", async () => {
    const dispatch = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(OPENED);
    const runner = openRoundRunner({ dispatch, post, refresh: vi.fn() });
    await runner.open("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openDone", outcome: { ok: false, code: "UNKNOWN" } });
    expect(await runner.open("s1", 1)).toBe(true);
  });
});
