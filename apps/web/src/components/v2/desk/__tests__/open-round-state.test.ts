// T16 (D12) — the Open round presses as one reducer plus the runner
// that puts them on the network (the Arbiter Panel's round column drives them through use-open-round.ts). The rules, each pinned below and then held
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
// The round's "+5 min" was a third request under R1, R3 and R4 until phase 2 moved it to the panel's own `RoundExtend`
// (checkin-extend-ui.ts); the state here has no part in it, and `extend` is not an action of this reducer.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ApiV1Error } from "@/lib/client-v1";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { quoteOf } from "@/lib/__tests__/_receipt-quote";
import type { OpenRoundResult } from "@/lib/open-round";
import {
  initialOpenRoundUi,
  openRoundRunner,
  openRoundUi,
  type OpenRoundUiAction,
  type OpenRoundUiState,
} from "../open-round-state";

const OPENED: OpenRoundResult = { opened: true, invited: 4, retrying: 0, skipped: [], payment: null };
const s0 = initialOpenRoundUi();
const run = (...actions: OpenRoundUiAction[]) => actions.reduce(openRoundUi, s0);

describe("open-round reducer — the rules, one at a time", () => {
  it("the empty case first: nothing pressed ⇒ no dialog, nothing in flight, no notice", () => {
    expect(s0).toEqual({ confirming: false, busy: null, notice: null, rowNotice: null, pay: null });
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
    expect(done).toEqual({ confirming: false, busy: null, notice: { kind: "answered", result: OPENED }, rowNotice: null, pay: null });
    const failed = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: false, code: "ROUND_CHANGED" } });
    expect(failed.notice).toEqual({ kind: "failed", code: "ROUND_CHANGED" });
    expect(failed.confirming).toBe(false);
  });

  it("R3 + R5: a resend's answer lands on ITS pairing; one for another pairing, or for the open, is dropped", () => {
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "resendDone", fixtureId: "f2", outcome: { ok: true, emailed: 2, retrying: 1 } })).toBe(resending);
    expect(openRoundUi(resending, { type: "openDone", outcome: { ok: true, result: OPENED } })).toBe(resending);
    // `retrying` differs from `emailed` and from zero, so a reducer that drops it, or swaps the two, shows.
    const done = openRoundUi(resending, { type: "resendDone", fixtureId: "f1", outcome: { ok: true, emailed: 2, retrying: 1 } });
    expect(done).toEqual({
      confirming: false,
      busy: null,
      notice: null,
      rowNotice: { fixtureId: "f1", notice: { kind: "resent", emailed: 2, retrying: 1 } },
      pay: null,
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
});

describe("open-round reducer — reset (the round on screen changed)", () => {
  it("goes back to the initial state from ANY state, and an answer still in flight for the old round is then dropped (R3)", () => {
    const answeredOpen = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: true, result: OPENED } });
    const answeredResend = run({ type: "resend", fixtureId: "f1" }, { type: "resendDone", fixtureId: "f1", outcome: { ok: true, emailed: 2, retrying: 0 } });
    const states = [
      s0,
      run({ type: "ask" }),
      run({ type: "ask" }, { type: "open" }),
      run({ type: "resend", fixtureId: "f1" }),
      answeredOpen,
      answeredResend,
    ];
    // Anti-vacuity: the five states past the first are NOT already initial, so the reset has something to wipe.
    expect(states.slice(1).filter((st) => JSON.stringify(st) !== JSON.stringify(s0))).toHaveLength(5);
    for (const st of states) expect(openRoundUi(st, { type: "reset" })).toEqual(s0);
    const late: [OpenRoundUiState, OpenRoundUiAction][] = [
      [run({ type: "ask" }, { type: "open" }), { type: "openDone", outcome: { ok: true, result: OPENED } }],
      [run({ type: "resend", fixtureId: "f1" }), { type: "resendDone", fixtureId: "f1", outcome: { ok: true, emailed: 2, retrying: 0 } }],
    ];
    for (const [inFlight, answer] of late) {
      const afterReset = openRoundUi(inFlight, { type: "reset" });
      expect(openRoundUi(afterReset, answer), `${answer.type} for the old round lands nowhere`).toBe(afterReset);
    }
    expect(late).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The sequence property: random presses and answers, the reducer against a
// model of R1–R5 (written from the rules above).

type Model = { confirming: boolean; busy: OpenRoundUiState["busy"]; pay: boolean };
const IDS = ["f1", "f2"] as const;
const openDone = (ok: boolean): OpenRoundUiAction =>
  ok ? { type: "openDone", outcome: { ok: true, result: OPENED } } : { type: "openDone", outcome: { ok: false, code: "E" } };
const resendDone = (fixtureId: string, ok: boolean): OpenRoundUiAction =>
  ok
    ? { type: "resendDone", fixtureId, outcome: { ok: true, emailed: 2, retrying: 0 } }
    : { type: "resendDone", fixtureId, outcome: { ok: false, code: "E" } };
const actionArb: fc.Arbitrary<OpenRoundUiAction> = fc.oneof(
  fc.constant<OpenRoundUiAction>({ type: "unpaid", quote: quoteOf({ size: 16 }), next: null }),
  fc.constant<OpenRoundUiAction>({ type: "pay" }),
  fc.constant<OpenRoundUiAction>({ type: "payFailed" }),
  fc.constant<OpenRoundUiAction>({ type: "closePay" }),
  fc.constant<OpenRoundUiAction>({ type: "ask" }),
  fc.constant<OpenRoundUiAction>({ type: "cancel" }),
  fc.constant<OpenRoundUiAction>({ type: "open" }),
  fc.constantFrom(...IDS).map((fixtureId): OpenRoundUiAction => ({ type: "resend", fixtureId })),
  fc.boolean().map(openDone),
  fc.tuple(fc.constantFrom(...IDS), fc.boolean()).map(([fixtureId, ok]) => resendDone(fixtureId, ok)),
);

function step(m: Model, a: OpenRoundUiAction): Model {
  switch (a.type) {
    case "reset":
      return { confirming: false, busy: null, pay: false };
    case "ask":
      return m.busy === null && !m.pay ? { ...m, confirming: true } : m;
    case "cancel":
      return m.busy === null ? { ...m, confirming: false } : m;
    case "open":
      return m.busy === null && m.confirming ? { ...m, busy: { kind: "open" } } : m;
    case "unpaid":
      return m.busy?.kind === "open" ? { confirming: false, busy: null, pay: true } : m;
    case "pay":
      return m.busy === null && m.pay ? { ...m, busy: { kind: "open" } } : m;
    case "payFailed":
      return m.busy?.kind === "open" && m.pay ? { ...m, busy: null } : m;
    case "closePay":
      return m.busy === null && m.pay ? { ...m, pay: false } : m;
    case "resend":
      return m.busy === null && !m.confirming && !m.pay ? { ...m, busy: { kind: "resend", fixtureId: a.fixtureId } } : m;
    case "openDone":
      return m.busy?.kind === "open" ? { confirming: false, busy: null, pay: false } : m;
    case "resendDone":
      return m.busy?.kind === "resend" && m.busy.fixtureId === a.fixtureId ? { ...m, busy: null } : m;
  }
}

describe("open-round reducer — random sequences hold R1–R5", () => {
  it("over random sequences the reducer agrees with the rules' model at every step (anti-vacuity: each rule's case reached)", () => {
    const reached = { opens: 0, refusedSecond: 0, resends: 0, strayDone: 0, cancelBusy: 0, unpaid: 0, pays: 0, payRefused: 0, receiptClosed: 0 };
    fc.assert(
      fc.property(
        // A random tail after a random prefix: the receipt's path (ask, open, unpaid, pay) is five coordinated presses, which a purely random
        // sequence almost never strings together; the prefixes put the property INSIDE it (anti-vacuity below counts that it got there).
        fc.tuple(fc.constantFrom<OpenRoundUiAction[]>([], [{ type: "ask" }, { type: "open" }, { type: "unpaid", quote: quoteOf({ size: 16 }), next: null }], [{ type: "ask" }, { type: "open" }, { type: "unpaid", quote: quoteOf({ size: 16 }), next: null }, { type: "pay" }]), fc.array(actionArb, { minLength: 1, maxLength: 24 })).map(([prefix, tail]) => [...prefix, ...tail]),
        (actions) => {
        let s = s0;
        let m: Model = { confirming: false, busy: null, pay: false };
        for (const a of actions) {
          const before = s;
          s = openRoundUi(s, a);
          m = step(m, a);
          expect({ confirming: s.confirming, busy: s.busy, pay: s.pay !== null }).toEqual(m);
          // R1: never two requests, by construction of `busy`; count what the property saw.
          if (a.type === "open" && before.busy === null && before.confirming) reached.opens += 1;
          if ((a.type === "open" || a.type === "resend") && before.busy !== null) reached.refusedSecond += 1;
          if (a.type === "resend" && before.busy === null && !before.confirming) reached.resends += 1;
          if ((a.type === "openDone" || a.type === "resendDone") && s === before) reached.strayDone += 1;
          if (a.type === "cancel" && before.busy !== null) reached.cancelBusy += 1;
          if (a.type === "unpaid" && before.busy?.kind === "open") reached.unpaid += 1;
          if (a.type === "pay" && before.busy === null && before.pay !== null) reached.pays += 1;
          if (a.type === "payFailed" && before.busy?.kind === "open" && before.pay !== null) reached.payRefused += 1;
          if (a.type === "closePay" && before.busy === null && before.pay !== null) reached.receiptClosed += 1;
          // R5: an open's answer is the round's notice, and only it sets one.
          if (a.type === "openDone" && before.busy?.kind === "open") {
            expect(s.notice).toEqual(a.outcome.ok ? { kind: "answered", result: a.outcome.result } : { kind: "failed", code: a.outcome.code });
          } else if (a.type === "unpaid" && before.busy?.kind === "open") {
            expect(s.notice, "R6: an unpaid answer sets no notice").toBeNull();
          } else if (a.type !== "open") {
            expect(s.notice).toBe(before.notice);
          }
        }
      },
      ),
      { numRuns: 600, seed: 160416 },
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
    const post = vi.fn().mockRejectedValueOnce(new ApiV1Error("Round changed", 409, "ROUND_CHANGED")).mockResolvedValueOnce({ emailed: 2, retrying: 1 });
    const refresh = vi.fn();
    const runner = openRoundRunner({ dispatch, post, refresh });
    await runner.open("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openDone", outcome: { ok: false, code: "ROUND_CHANGED" } });
    expect(refresh).not.toHaveBeenCalled();
    expect(await runner.resend("f 1")).toBe(true);
    expect(post).toHaveBeenLastCalledWith("/api/v1/fixtures/f%201/external-play/resend", undefined);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "resendDone", fixtureId: "f 1", outcome: { ok: true, emailed: 2, retrying: 1 } });
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

// ---------------------------------------------------------------------------
// Online Chess credits (spec 2026-11-23-online-chess-credits-design.md §7.6, §8.4; plan Task 12): an Open press on an UNPAID package is answered
// with the receipt's ask (402 ONLINE_CHESS_UNPAID { quote, next }), and the receipt's confirm is the open again with `pay`. The rules:
//   R6 an unpaid answer lands only on the open in flight (R3): it closes the confirmation, sets no notice and stands the receipt up;
//   R7 the receipt's confirm is a request in flight too (one at a time, R1) and only from a standing receipt; a refusal of it (409 changed, 402 short,
//      anything else) leaves the receipt standing and frees the press, and ITS answer is the round's notice and closes the receipt (R5);
//   R8 the receipt can be closed only while nothing is in flight (R4), and while it stands no confirmation or resend can be raised.
const ASK = { quote: quoteOf({ size: 64, held: 41, rounds: 5 }), next: null };
const unpaidOpen = (): OpenRoundUiState => run({ type: "ask" }, { type: "open" }, { type: "unpaid", ...ASK });
const paying = (): OpenRoundUiState => openRoundUi(unpaidOpen(), { type: "pay" });

describe("open-round reducer - the unpaid answer and the receipt it stands up (R6-R8)", () => {
  it("R6: the unpaid answer to the open in flight closes the confirmation, sets no notice and stands the receipt up with the server's quote", () => {
    const st = unpaidOpen();
    expect(st).toEqual({ confirming: false, busy: null, notice: null, rowNotice: null, pay: ASK });
    expect(st.pay!.quote.size, "the receipt is for the STORED size the server quoted").toBe(64);
  });

  it("R6: it clears the previous answer the open replaced, and an unpaid answer nobody asked for is dropped", () => {
    const answered = run({ type: "ask" }, { type: "open" }, { type: "openDone", outcome: { ok: false, code: "ROUND_CHANGED" } });
    expect(answered.notice).not.toBeNull();
    const again = openRoundUi(openRoundUi(answered, { type: "ask" }), { type: "open" });
    expect(openRoundUi(again, { type: "unpaid", ...ASK }).notice, "the old failure is gone").toBeNull();
    expect(openRoundUi(s0, { type: "unpaid", ...ASK }), "no open in flight").toBe(s0);
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "unpaid", ...ASK }), "a resend in flight is not the open").toBe(resending);
  });

  it("R7: Pay and open is THE request in flight, from a standing receipt only; a second is refused", () => {
    expect(openRoundUi(s0, { type: "pay" }), "no receipt standing").toBe(s0);
    const st = paying();
    expect(st.busy).toEqual({ kind: "open" });
    expect(st.pay, "the receipt stays up while it is paid").toEqual(ASK);
    expect(openRoundUi(st, { type: "pay" })).toBe(st);
    expect(openRoundUi(st, { type: "resend", fixtureId: "f1" })).toBe(st);
  });

  it("R7: a refusal of the pay (changed, short, any other) frees the press and leaves the receipt standing, with no notice", () => {
    const st = openRoundUi(paying(), { type: "payFailed" });
    expect(st).toEqual({ confirming: false, busy: null, notice: null, rowNotice: null, pay: ASK });
    expect(openRoundUi(st, { type: "pay" }).busy, "the organiser can press again").toEqual({ kind: "open" });
    expect(openRoundUi(s0, { type: "payFailed" }), "nothing in flight").toBe(s0);
    const resending = run({ type: "resend", fixtureId: "f1" });
    expect(openRoundUi(resending, { type: "payFailed" })).toBe(resending);
  });

  it("R5+R7: the pay's answer is the round's notice and closes the receipt, whether the round opened or gave its own reason", () => {
    const opened = openRoundUi(paying(), { type: "openDone", outcome: { ok: true, result: OPENED } });
    expect(opened).toEqual({ confirming: false, busy: null, notice: { kind: "answered", result: OPENED }, rowNotice: null, pay: null });
    const refusedResult: OpenRoundResult = { opened: false, reason: "not_paired" };
    const refused = openRoundUi(paying(), { type: "openDone", outcome: { ok: true, result: refusedResult } });
    expect(refused.notice, "the round's own reason").toEqual({ kind: "answered", result: refusedResult });
    expect(refused.pay).toBeNull();
  });

  it("R8: the receipt closes only while nothing is in flight; while it stands no confirmation or resend is raised", () => {
    const standing = unpaidOpen();
    expect(openRoundUi(paying(), { type: "closePay" }), "in flight").toEqual(paying());
    expect(openRoundUi(standing, { type: "closePay" })).toEqual(s0);
    expect(openRoundUi(s0, { type: "closePay" }), "nothing standing").toBe(s0);
    expect(openRoundUi(standing, { type: "ask" }), "no dialog over the receipt").toBe(standing);
    expect(openRoundUi(standing, { type: "resend", fixtureId: "f1" })).toBe(standing);
  });

  it("reset wipes a standing receipt, and a pay answer in flight for the old round is then dropped (R3)", () => {
    for (const st of [unpaidOpen(), paying()]) expect(openRoundUi(st, { type: "reset" })).toEqual(s0);
    const afterReset = openRoundUi(paying(), { type: "reset" });
    expect(openRoundUi(afterReset, { type: "openDone", outcome: { ok: true, result: OPENED } })).toBe(afterReset);
    expect(openRoundUi(afterReset, { type: "payFailed" })).toBe(afterReset);
  });
});

describe("openRoundRunner - the unpaid answer and the pay-and-open", () => {
  const unpaidError = (ask = ASK) => new ApiV1Error("Pay first", 402, ONLINE_PACKAGE_CODES.unpaid, ask as unknown as Record<string, unknown>);

  it("a 402 ONLINE_CHESS_UNPAID is the receipt's ask, not a failure: the quote and next are dispatched and nothing is refreshed", async () => {
    const dispatch = vi.fn();
    const refresh = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(unpaidError());
    const runner = openRoundRunner({ dispatch, post, refresh });
    expect(await runner.open("s1", 1)).toBe(true);
    expect(dispatch.mock.calls.map((c) => c[0].type)).toEqual(["open", "unpaid"]);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "unpaid", quote: ASK.quote, next: null });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a 402 that carries no quote (a body that does not parse) is an ordinary failure by its code, never a half-drawn receipt", async () => {
    const dispatch = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new ApiV1Error("Pay first", 402, ONLINE_PACKAGE_CODES.unpaid, { quote: { size: 64 } }));
    await openRoundRunner({ dispatch, post, refresh: vi.fn() }).open("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openDone", outcome: { ok: false, code: ONLINE_PACKAGE_CODES.unpaid } });
  });

  it("payOpen sends the open again WITH the pay body, once; its answer is the open's answer and the page refreshes", async () => {
    const dispatch = vi.fn();
    const refresh = vi.fn();
    let answer!: (v: unknown) => void;
    const post = vi.fn(() => new Promise((r) => (answer = r)));
    const runner = openRoundRunner({ dispatch, post, refresh });
    const body = { size: 64 as const, expectedOwed: 4 };
    const first = runner.payOpen("s1", 1, body);
    await expect(runner.payOpen("s1", 1, body), "a second press while one is out").rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/stages/s1/open-round", { roundNo: 1, pay: body });
    answer(OPENED);
    await first;
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([{ type: "pay" }, { type: "openDone", outcome: { ok: true, result: OPENED } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refused pay (409 changed, 402 short, a 500) is freed and RETHROWN to the receipt - never swallowed, never the round's notice, no refresh", async () => {
    const dispatch = vi.fn();
    const refresh = vi.fn();
    const changed = new ApiV1Error("Changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, { quote: ASK.quote } as unknown as Record<string, unknown>);
    const post = vi.fn().mockRejectedValueOnce(changed).mockResolvedValueOnce(OPENED);
    const runner = openRoundRunner({ dispatch, post, refresh });
    await expect(runner.payOpen("s1", 1, { size: 64, expectedOwed: 4 })).rejects.toBe(changed);
    expect(dispatch.mock.calls.map((c) => c[0].type)).toEqual(["pay", "payFailed"]);
    expect(refresh).not.toHaveBeenCalled();
    await runner.payOpen("s1", 1, { size: 64, expectedOwed: 4 }); // the runner is free again
    expect(post).toHaveBeenCalledTimes(2);
  });
});

