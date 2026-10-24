// T16 (D12) — the Open round control's clicks, through the REAL component,
// reducer and runner (open-round-state.ts), with the network doubled at
// `apiV1`: Open round asks first and sends nothing; the confirmation's button
// sends ONE request with the round's number; the answer — the server's own
// count of PLAYERS invited, the boards it skipped, or a refusal by its code —
// shows on the control; a Resend sends for its own pairing and answers there.
// No DOM in this workspace: the hook harness renders the island and calls its
// handlers the way a browser would. The dialog (ConfirmDialog) is a child
// component the harness does not expand, so its props are read and called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MINUTES, emptyExtendTally } from "@/lib/checkin-extend";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});
const EN: Dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN, key, vars),
    useMsgPlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN, key, count, "en", vars),
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { OpenRoundControl } from "../open-round-control";

const en = EN as unknown as Record<string, string>;
const pl = (key: string, n: number) => en[`${key}.${n === 1 ? "one" : "other"}`]!.replace("{count}", String(n));
const P = (n: number, o: Partial<OpenRoundPairing> = {}): OpenRoundPairing => ({
  fixtureId: `f${n}`,
  boardNo: n,
  whiteName: `W${n}`,
  blackName: `B${n}`,
  invitedAt: null,
  owedSeats: 2,
  canResend: false,
  ...o,
});
const ROUND = (o: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 2,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: DEADLINE_AFTER_MS / 60_000,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: null,
  press: "open",
  earlierInPlay: [],
  pairings: [P(1), P(2)],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...o,
});
const OPENED_AT = "2026-10-16T18:04:00.000Z";
const INVITED = ROUND({
  state: "open",
  openedAt: OPENED_AT,
  deadlineAt: new Date(Date.parse(OPENED_AT) + DEADLINE_AFTER_MS).toISOString(),
  press: "none",
  pairings: [P(1, { owedSeats: 0, invitedAt: OPENED_AT, canResend: true }), P(2, { owedSeats: 0, invitedAt: OPENED_AT, canResend: true })],
});

const uniq = (tree: ReactElement[]) => [...new Set(tree)];
const byTestId = (tree: ReactElement[], id: string) => uniq(tree.filter((n) => propsOf(n)["data-testid"] === id));
const dialog = (tree: ReactElement[]) => {
  const d = uniq(tree.filter((n) => n.type === ConfirmDialog));
  expect(d, "one confirmation").toHaveLength(1);
  return propsOf(d[0]!) as { open: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void; title: string; confirmLabel: string };
};
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();
const flush = () => new Promise((r) => setTimeout(r, 0));
const noticeText = (tree: ReactElement[]) => byTestId(tree, "open-round-notice").map((n) => textOf(n)).join("|");
const mount = (round: OpenRoundView) => renderIsland(OpenRoundControl, { round, tz: "Europe/London" });

beforeEach(() => {
  net.calls.length = 0;
  router.refresh.mockReset();
});

describe("Open round — ask, then one request", () => {
  it("the empty case first: nothing pressed ⇒ the dialog is closed and nothing has been sent", () => {
    const ui = mount(ROUND());
    expect(dialog(ui.tree()).open).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("Open round only ASKS: the dialog opens, titled for this round, its button counting the players; nothing is sent", () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    const d = dialog(ui.tree());
    expect(d.open).toBe(true);
    expect(d.title).toBe(en["runsheet.round.confirmTitle"]!.replace("{round}", "2"));
    expect(d.confirmLabel).toBe(pl("runsheet.round.confirmCta", 4));
    expect(net.calls).toHaveLength(0);
  });

  it("Cancel closes it and sends nothing", () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onCancel();
    expect(dialog(ui.tree()).open).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("the confirmation sends ONE open-round with THIS round's number; a double tap sends nothing more; the dialog is held busy", async () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onConfirm();
    dialog(ui.tree()).onConfirm();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/s1/open-round", { roundNo: 2 }]]);
    expect(dialog(ui.tree()).busy).toBe(true);
    expect(propsOf(byTestId(ui.tree(), "open-round-cta")[0]!).disabled).toBe(true);
    net.calls[0]!.resolve({ opened: true, invited: 4, retrying: 0, skipped: [] });
    await flush();
    expect(dialog(ui.tree()).open, "answered: the dialog closes").toBe(false);
    expect(noticeText(ui.tree()), "the server's count, as PLAYERS").toBe(pl("externalPlay.openRound.invited", 4));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("a board the server skipped is named by its board number with the reason", async () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onConfirm();
    net.calls[0]!.resolve({ opened: true, invited: 2, retrying: 0, skipped: [{ fixtureId: "f2", reason: "send_failed" }] });
    await flush();
    const skip = en["runsheet.round.skipLine"]!
      .replace("{board}", en["arbiter.boardNo"]!.replace("{n}", "2"))
      .replace("{reason}", en["externalPlay.openRound.skipped.sendFailed"]!);
    // One line each: the count, then the skipped board (textOf joins the lines with a space).
    expect(noticeText(ui.tree())).toBe(`${pl("externalPlay.openRound.invited", 2)} ${skip}`);
  });

  it("every answer the server can give reads in words — a refusal by its reason, an error by its code — never the server's English", async () => {
    const cases: [unknown, boolean, string][] = [
      [{ opened: false, reason: "not_paired" }, true, en["externalPlay.openRound.notPaired"]!],
      [{ opened: false, reason: "clock_not_playable" }, true, en["externalPlay.openRound.clockNotPlayable"]!],
      [{ opened: false, reason: "already_open", skipped: [] }, true, en["externalPlay.openRound.alreadyOpen"]!],
      [new ApiV1Error("Online chess is off", 403, "ONLINE_CHESS_DISABLED"), false, en["runsheet.round.err.disabled"]!],
      [new ApiV1Error("changed", 409, "ROUND_CHANGED"), false, en["runsheet.round.err.roundChanged"]!],
      [new ApiV1Error("not online", 422, "ROUND_NOT_ONLINE"), false, en["runsheet.round.err.notOnline"]!],
      [new ApiV1Error("boom", 500, "INTERNAL"), false, en["runsheet.round.err.failed"]!],
    ];
    let checked = 0;
    for (const [answer, ok, expected] of cases) {
      net.calls.length = 0;
      const ui = mount(ROUND());
      click(byTestId(ui.tree(), "open-round-cta")[0]);
      dialog(ui.tree()).onConfirm();
      if (ok) net.calls[0]!.resolve(answer);
      else net.calls[0]!.reject(answer);
      await flush();
      expect(noticeText(ui.tree()), String(expected)).toBe(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: answers checked").toBe(7);
  });

  it("the notice survives the refresh that hands down the opened round", async () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onConfirm();
    net.calls[0]!.resolve({ opened: true, invited: 4, retrying: 0, skipped: [] });
    await flush();
    ui.rerender({ round: INVITED, tz: "Europe/London" });
    expect(noticeText(ui.tree())).toBe(pl("externalPlay.openRound.invited", 4));
    expect(byTestId(ui.tree(), "open-round-cta"), "everyone invited: no press left").toHaveLength(0);
  });
});

describe("Resend — on its own pairing", () => {
  it("sends for THAT pairing, answers on its row, and holds every other control meanwhile", async () => {
    const ui = mount(INVITED);
    click(byTestId(ui.tree(), "open-round-resend-f2")[0]);
    click(byTestId(ui.tree(), "open-round-resend-f1")[0]);
    expect(net.calls.map((c) => c.url)).toEqual(["/api/v1/fixtures/f2/external-play/resend"]);
    expect(propsOf(byTestId(ui.tree(), "open-round-resend-f1")[0]!).disabled).toBe(true);
    net.calls[0]!.resolve({ emailed: 2, retrying: 0 });
    await flush();
    const notices = byTestId(ui.tree(), "open-round-row-notice");
    expect(notices.map((n) => textOf(n))).toEqual([pl("runsheet.round.resent", 2)]);
    const row = byTestId(ui.tree(), "open-round-already-f2")[0]!;
    expect(textOf(row)).toContain(pl("runsheet.round.resent", 2));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("each refusal reads in words on the row (the window, a hold, a game, a change, the flag), and a send that reached nobody says so", async () => {
    const cases: [unknown, boolean, string][] = [
      [{ emailed: 0, retrying: 0 }, true, en["runsheet.round.resentNone"]!],
      [new ApiV1Error("x", 409, "WINDOW_CLOSED"), false, en["externalPlay.resend.windowClosed"]!],
      [new ApiV1Error("x", 409, "BOARD_HELD"), false, en["externalPlay.resend.boardHeld"]!],
      [new ApiV1Error("x", 409, "ONLINE_GAME_EXISTS"), false, en["externalPlay.resend.gameExists"]!],
      [new ApiV1Error("x", 409, "ROUND_CHANGED"), false, en["externalPlay.resend.roundChanged"]!],
      [new ApiV1Error("x", 403, "ONLINE_CHESS_DISABLED"), false, en["runsheet.round.err.disabled"]!],
      [new ApiV1Error("x", 500, "INTERNAL"), false, en["runsheet.round.resendFailed"]!],
    ];
    let checked = 0;
    for (const [answer, ok, expected] of cases) {
      net.calls.length = 0;
      const ui = mount(INVITED);
      click(byTestId(ui.tree(), "open-round-resend-f1")[0]);
      if (ok) net.calls[0]!.resolve(answer);
      else net.calls[0]!.reject(answer);
      await flush();
      expect(byTestId(ui.tree(), "open-round-row-notice").map((n) => textOf(n)), String(expected)).toEqual([expected]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: answers checked").toBe(7);
  });
});

// C1 (task 7 fix round 1): an invite the mail worker is still sending is neither "0 invited" nor "could not be sent". The server now
// answers { invited, retrying } for an open and { emailed, retrying } for a resend; the arbiter reads them in words, through the real
// component, reducer and runner. The true failure (nothing sent, nothing queued) keeps its old words.
describe("a retrying invite is not reported as no invite", () => {
  const SENDING = (n: number) => pl("runsheet.round.sending", n);
  const open = async (answer: unknown) => {
    net.calls.length = 0;
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onConfirm();
    net.calls[0]!.resolve(answer);
    await flush();
    return ui;
  };
  const resend = async (answer: unknown) => {
    net.calls.length = 0;
    const ui = mount(INVITED);
    click(byTestId(ui.tree(), "open-round-resend-f1")[0]);
    net.calls[0]!.resolve(answer);
    await flush();
    return byTestId(ui.tree(), "open-round-row-notice").map((n) => textOf(n));
  };

  it("open: only retrying seats says they are sending, and never '0 players invited'", async () => {
    const ui = await open({ opened: true, invited: 0, retrying: 3, skipped: [] });
    expect(noticeText(ui.tree())).toBe(SENDING(3));
    expect(noticeText(ui.tree())).not.toContain(pl("externalPlay.openRound.invited", 0));
  });

  it("open: invited and retrying together read as two lines, the count of each", async () => {
    const ui = await open({ opened: true, invited: 2, retrying: 1, skipped: [] });
    expect(noticeText(ui.tree())).toBe(`${pl("externalPlay.openRound.invited", 2)} ${SENDING(1)}`);
  });

  it("open: a retrying seat on a board the server also skipped keeps the skip line after the sending line", async () => {
    const ui = await open({ opened: true, invited: 0, retrying: 2, skipped: [{ fixtureId: "f2", reason: "send_failed" }] });
    const skip = en["runsheet.round.skipLine"]!
      .replace("{board}", en["arbiter.boardNo"]!.replace("{n}", "2"))
      .replace("{reason}", en["externalPlay.openRound.skipped.sendFailed"]!);
    expect(noticeText(ui.tree())).toBe(`${SENDING(2)} ${skip}`);
  });

  it("open: nothing sent and nothing queued keeps its old words (0 invited, the skipped board) - the true failure is not softened", async () => {
    const ui = await open({ opened: true, invited: 0, retrying: 0, skipped: [{ fixtureId: "f1", reason: "send_failed" }] });
    const skip = en["runsheet.round.skipLine"]!
      .replace("{board}", en["arbiter.boardNo"]!.replace("{n}", "1"))
      .replace("{reason}", en["externalPlay.openRound.skipped.sendFailed"]!);
    expect(noticeText(ui.tree())).toBe(`${pl("externalPlay.openRound.invited", 0)} ${skip}`);
    expect(noticeText(ui.tree())).not.toContain(SENDING(0));
  });

  it("resend: nothing emailed yet but invites queued says they are sending, not 'could not be sent'", async () => {
    const notices = await resend({ emailed: 0, retrying: 2 });
    expect(notices).toEqual([SENDING(2)]);
    expect(notices.join(" ")).not.toContain(en["runsheet.round.resentNone"]!);
  });

  it("resend: emailed and retrying together read as both facts on the row", async () => {
    expect(await resend({ emailed: 1, retrying: 1 })).toEqual([`${pl("runsheet.round.resent", 1)} ${SENDING(1)}`]);
    expect(await resend({ emailed: 2, retrying: 0 }), "no retrying: the old line alone").toEqual([pl("runsheet.round.resent", 2)]);
  });

  it("the sending line is a real sentence in every language: a plural pair, the count in both, no em dash or arrow", () => {
    let checked = 0;
    for (const locale of ["en", "nl", "fr", "es"]) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
      for (const form of ["one", "other"]) {
        const text = dict[`runsheet.round.sending.${form}`];
        expect(text, `${locale} runsheet.round.sending.${form}`).toBeTruthy();
        expect(text, `${locale} ${form} carries the count`).toContain("{count}");
        expect(text, `${locale} ${form}: no em dash or arrow`).not.toMatch(/[\u2014\u2192]/);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 plural forms").toBe(8);
  });
});

// Spec 2026-10-09 §3.2.2: "+5 min to the round" on the control of an OPEN round - through the real component, reducer and runner.
describe("+5 min to the round - on the control of an open round", () => {
  const EXTENDABLE = (extendableBoards: number) => ({ ...INVITED, extendableBoards });
  const extendNotice = (tree: ReactElement[]) => byTestId(tree, "open-round-extend-notice").map((n) => textOf(n)).join("|");
  const RESULT = {
    extended: 6,
    skipped: { closed: 0, gameStarted: 2, capReached: 0 },
    notOpenYet: 0,
    ownBoards: 0,
    failed: 0,
    addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
  };

  it("the empty case first: no extendable board, no button; a round not yet opened offers none either", () => {
    expect(byTestId(mount(EXTENDABLE(0)).tree(), "open-round-extend-cta")).toHaveLength(0);
    expect(byTestId(mount(ROUND({ extendableBoards: 4 })).tree(), "open-round-extend-cta"), "a paired round is not open: nothing to extend").toHaveLength(0);
    expect(byTestId(mount(EXTENDABLE(0)).tree(), "open-round-extend")).toHaveLength(0);
  });

  it("offered on an open round with extendable boards: the label, and the count of boards it reaches", () => {
    const ui = mount(EXTENDABLE(6));
    const cta = byTestId(ui.tree(), "open-round-extend-cta");
    expect(cta).toHaveLength(1);
    expect(textOf(cta[0]!)).toBe(en["externalPlay.checkinExtend.round"]!.replace("{minutes}", String(CHECKIN_EXTEND_STEP_MINUTES)));
    expect(textOf(byTestId(ui.tree(), "open-round-extend")[0]!)).toContain(pl("externalPlay.checkinExtend.roundHint", 6));
  });

  it("sends ONE request with THIS round's number to the extend route, however many taps; the answer is the round's extend notice and the page refreshes", async () => {
    const ui = mount(EXTENDABLE(6));
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/s1/extend-checkin", { roundNo: 2 }]]);
    expect(propsOf(byTestId(ui.tree(), "open-round-extend-cta")[0]!).disabled, "held while in flight").toBe(true);
    expect(propsOf(byTestId(ui.tree(), "open-round-cta")[0] ?? byTestId(ui.tree(), "open-round-resend-f1")[0]!).disabled, "so is every other control").toBe(true);
    net.calls[0]!.resolve(RESULT);
    await flush();
    expect(extendNotice(ui.tree())).toBe(`Added ${CHECKIN_EXTEND_STEP_MINUTES} minutes to 6 boards. ${pl("externalPlay.checkinExtend.skip.gameStarted", 2)}`);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("the answer survives the refresh, even when nothing is left to extend; a second press clears it first", async () => {
    const ui = mount(EXTENDABLE(6));
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    net.calls[0]!.resolve(RESULT);
    await flush();
    ui.rerender({ round: EXTENDABLE(0), tz: "Europe/London" });
    expect(extendNotice(ui.tree())).toContain("Added 5 minutes to 6 boards.");
    expect(byTestId(ui.tree(), "open-round-extend-cta"), "everything capped: no button").toHaveLength(0);
    ui.rerender({ round: EXTENDABLE(3), tz: "Europe/London" });
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    expect(extendNotice(ui.tree()), "cleared while the next is in flight").toBe("");
  });

  it("each refusal reads in words, never the code: the round not open, any other error", async () => {
    const cases: [ApiV1Error, string][] = [
      [new ApiV1Error("x", 409, "ROUND_NOT_OPEN"), en["externalPlay.checkinExtend.refused.roundNotOpen"]!],
      [new ApiV1Error("x", 403, "ARBITER_NOT_ORGANISER"), en["externalPlay.checkinExtend.refused.failed"]!],
      [new ApiV1Error("x", 500, "INTERNAL"), en["externalPlay.checkinExtend.refused.failed"]!],
    ];
    let checked = 0;
    for (const [err, expected] of cases) {
      net.calls.length = 0;
      const ui = mount(EXTENDABLE(2));
      click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
      net.calls[0]!.reject(err);
      await flush();
      expect(extendNotice(ui.tree()), err.code).toBe(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("a Resend in flight holds it: one request at a time across the control", () => {
    const ui = mount(EXTENDABLE(2));
    click(byTestId(ui.tree(), "open-round-resend-f1")[0]);
    expect(propsOf(byTestId(ui.tree(), "open-round-extend-cta")[0]!).disabled).toBe(true);
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    expect(net.calls.map((c) => c.url), "the +5 min tap behind it sent nothing").toEqual(["/api/v1/fixtures/f1/external-play/resend"]);
  });
});

// Owner rule (2026-10-19): +5 is offered ONLY inside a board's check-in window, and the screen keeps that true on a ticking clock - the
// button arrives AT the opening and leaves AT the deadline, with no refresh between. Through the real component and the real clock hook,
// under a fake clock (the island renders without a DOM; the hook's timers are the thing under test).
describe("+5 min to the round - the control's ticking clock", () => {
  const OPENS = Date.parse("2026-10-16T18:14:00.000Z");
  const CLOSES = Date.parse("2026-10-16T18:24:00.000Z");
  const WINDOW = { opensAt: new Date(OPENS).toISOString(), deadlineAt: new Date(CLOSES).toISOString(), extensionsLeft: CHECKIN_EXTEND_MAX };
  /** An open round whose one window is ahead: the server's snapshot count is 0 (nothing extendable yet). */
  const AHEAD = (over: Partial<OpenRoundView> = {}): OpenRoundView => ({ ...INVITED, extendableBoards: 0, extendWindows: [WINDOW], ...over });
  const cta = (tree: ReactElement[]) => byTestId(tree, "open-round-extend-cta").length;
  const extendNotice = (tree: ReactElement[]) => byTestId(tree, "open-round-extend-notice").map((n) => textOf(n)).join("|");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("one ms before the opening: no button; AT the opening: the button; one ms before the deadline: still; AT the deadline: gone - and then no timer is left running", () => {
    vi.setSystemTime(OPENS - 5);
    const ui = mount(AHEAD());
    vi.advanceTimersByTime(0);
    expect(cta(ui.tree()), "5 ms before the opening").toBe(0);
    vi.advanceTimersByTime(4);
    expect(Date.now(), "premise: the clock is 1 ms short of the opening").toBe(OPENS - 1);
    expect(cta(ui.tree()), "1 ms before the opening").toBe(0);
    vi.advanceTimersByTime(1);
    expect(Date.now(), "premise: the clock is AT the opening").toBe(OPENS);
    expect(cta(ui.tree()), "AT the opening").toBe(1);
    expect(textOf(byTestId(ui.tree(), "open-round-extend")[0]!), "reaching one board").toContain(pl("externalPlay.checkinExtend.roundHint", 1));
    vi.advanceTimersByTime(CLOSES - 1 - OPENS);
    expect(Date.now(), "premise: the clock is 1 ms short of the deadline").toBe(CLOSES - 1);
    expect(cta(ui.tree()), "1 ms before the deadline").toBe(1);
    vi.advanceTimersByTime(1);
    expect(Date.now(), "premise: the clock is AT the deadline").toBe(CLOSES);
    expect(cta(ui.tree()), "AT the deadline").toBe(0);
    expect(byTestId(ui.tree(), "open-round-extend-why").map((n) => propsOf(n)["data-why"]), "nothing to offer: the reason stands in its place").toEqual(["closed"]);
    expect(vi.getTimerCount(), "every edge is behind: no timer keeps running").toBe(0);
  });

  it("the count it shows is the CLOCK's, not the snapshot's: a stale server count of 6 over one live window reads 1", () => {
    vi.setSystemTime(OPENS + 1);
    const ui = mount(AHEAD({ extendableBoards: 6 }));
    expect(cta(ui.tree()), "before the clock is known, the server's count stands").toBe(1);
    expect(textOf(byTestId(ui.tree(), "open-round-extend")[0]!)).toContain(pl("externalPlay.checkinExtend.roundHint", 6));
    vi.advanceTimersByTime(0);
    expect(textOf(byTestId(ui.tree(), "open-round-extend")[0]!)).toContain(pl("externalPlay.checkinExtend.roundHint", 1));
  });

  it("the helper line stands under the button, its numbers from the constants", () => {
    vi.setSystemTime(OPENS + 1);
    const ui = mount(AHEAD());
    vi.advanceTimersByTime(0);
    expect(textOf(byTestId(ui.tree(), "open-round-extend-helper")[0]!)).toContain(
      en["externalPlay.checkinExtend.helper"]!.replace("{minutes}", String(CHECKIN_EXTEND_STEP_MINUTES)).replace("{max}", String(CHECKIN_EXTEND_MAX)),
    );
  });

  it("a round that is not open, or has no window, keeps no timer at all", () => {
    vi.setSystemTime(OPENS + 1);
    mount(ROUND({ extendWindows: [WINDOW] }));
    mount(AHEAD({ extendWindows: [] }));
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the answer to a press survives the deadline passing, with no button beside it", async () => {
    vi.setSystemTime(OPENS + 1);
    const ui = mount(AHEAD());
    vi.advanceTimersByTime(0);
    click(byTestId(ui.tree(), "open-round-extend-cta")[0]);
    net.calls[0]!.resolve(RESULT_FOR_CLOCK);
    await vi.advanceTimersByTimeAsync(0);
    expect(extendNotice(ui.tree()), "the answer is on screen").toContain("Added 5 minutes to 1 board.");
    await vi.advanceTimersByTimeAsync(CLOSES - Date.now());
    expect(Date.now()).toBe(CLOSES);
    expect(cta(ui.tree()), "the deadline passed: the button left").toBe(0);
    expect(extendNotice(ui.tree()), "the answer stayed").toContain("Added 5 minutes to 1 board.");
  });
});

// Owner copy (2026-10-19): where "+5 min to the round" is not offered the round says why - the one cause every board gives in its own
// words, "No board can be extended right now" for a mix, nothing for a round that lists no boards. The control's two facts: the
// server's tally of the boards no clock can change (`extendRefusals`) and the windows it counts on the ticking clock.
describe("+5 min to the round - the control's reason where it is not offered", () => {
  const OPENS = Date.parse("2026-10-16T18:14:00.000Z");
  const CLOSES = Date.parse("2026-10-16T18:24:00.000Z");
  const WIN = (left = CHECKIN_EXTEND_MAX) => ({ opensAt: new Date(OPENS).toISOString(), deadlineAt: new Date(CLOSES).toISOString(), extensionsLeft: left });
  const VIEW = (o: { tally?: Partial<OpenRoundView["extendRefusals"]>; windows?: OpenRoundView["extendWindows"]; extendable?: number } = {}): OpenRoundView => ({
    ...INVITED,
    extendableBoards: o.extendable ?? 0,
    extendWindows: o.windows ?? [],
    extendRefusals: { ...emptyExtendTally(), ...o.tally },
  });
  const whyOf = (tree: ReactElement[]) => byTestId(tree, "open-round-extend-why").map((n) => [propsOf(n)["data-why"], textOf(n)] as const);
  const WORDS = {
    game_started: en["externalPlay.checkinExtend.why.gameStarted"]!,
    closed: en["externalPlay.checkinExtend.why.closed"]!,
    not_open: en["externalPlay.checkinExtend.why.notOpen"]!,
    cap_reached: en["externalPlay.checkinExtend.why.capReached"]!,
  };
  const MIXED = en["externalPlay.checkinExtend.why.roundNoneOpen"]!;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the empty cases first: a round with no boards counted, and a round not opened, say nothing - and no button", () => {
    vi.setSystemTime(OPENS - 5);
    const empty = mount(VIEW());
    expect(byTestId(empty.tree(), "open-round-extend"), "no boards counted: no bar at all").toHaveLength(0);
    const paired = mount(ROUND({ extendRefusals: { ...emptyExtendTally(), game_started: 2 } }));
    expect(whyOf(paired.tree()), "a round that was never opened has nothing to extend and nothing to explain").toEqual([]);
  });

  it("ONE cause, in its own words: a game on each board; every board closed; no board open yet; no press left on the board that is open", () => {
    const rows: [string, OpenRoundView, number, keyof typeof WORDS][] = [
      ["game_started", VIEW({ tally: { game_started: 2 } }), OPENS + 1, "game_started"],
      ["closed", VIEW({ tally: { closed: 1 } }), OPENS + 1, "closed"],
      ["not_open", VIEW({ windows: [WIN()] }), OPENS - 1, "not_open"],
      ["cap_reached", VIEW({ windows: [WIN(0)] }), OPENS + 1, "cap_reached"],
    ];
    for (const [name, view, now, code] of rows) {
      vi.setSystemTime(now);
      const ui = mount(view);
      vi.advanceTimersByTime(0);
      expect(whyOf(ui.tree()), name).toEqual([[code, WORDS[code]]]);
      expect(byTestId(ui.tree(), "open-round-extend-cta"), `${name}: no button`).toHaveLength(0);
    }
    expect(rows.length, "anti-vacuity: four causes").toBe(4);
  });

  it("a MIX is 'No board can be extended right now': a game on one board and the other not open yet", () => {
    vi.setSystemTime(OPENS - 1);
    const ui = mount(VIEW({ tally: { game_started: 1 }, windows: [WIN()] }));
    vi.advanceTimersByTime(0);
    expect(whyOf(ui.tree())).toEqual([["mixed", MIXED]]);
  });

  it("before the viewer's clock is known, the snapshot's reading stands (the windows as the server saw them: not open yet)", () => {
    vi.setSystemTime(OPENS - 1);
    const ui = mount(VIEW({ windows: [WIN()] }));
    expect(whyOf(ui.tree()), "the first render, before any tick").toEqual([["not_open", WORDS.not_open]]);
  });

  it("on the ticking clock the sentence follows the windows: mix -> button AT the opening -> mix again AT the deadline - with no refresh", () => {
    vi.setSystemTime(OPENS - 5);
    const ui = mount(VIEW({ tally: { game_started: 1 }, windows: [WIN()] }));
    vi.advanceTimersByTime(0);
    const state = () => [whyOf(ui.tree()).map(([c]) => c), byTestId(ui.tree(), "open-round-extend-cta").length] as const;
    expect(state(), "5 ms before the opening: a game here, not open there").toEqual([["mixed"], 0]);
    vi.advanceTimersByTime(4);
    expect(state(), "1 ms before").toEqual([["mixed"], 0]);
    vi.advanceTimersByTime(1);
    expect(Date.now()).toBe(OPENS);
    expect(state(), "AT the opening: the button, and no reason beside it").toEqual([[], 1]);
    vi.advanceTimersByTime(CLOSES - 1 - OPENS);
    expect(state(), "1 ms before the deadline").toEqual([[], 1]);
    vi.advanceTimersByTime(1);
    expect(Date.now()).toBe(CLOSES);
    expect(state(), "AT the deadline: a game on one board, closed on the other").toEqual([["mixed"], 0]);
  });

  it("on the ticking clock a capped board says 'No extensions left' while its window runs and 'Check-in has closed' from its deadline on", () => {
    vi.setSystemTime(OPENS + 1);
    const ui = mount(VIEW({ windows: [WIN(0)] }));
    vi.advanceTimersByTime(0);
    expect(whyOf(ui.tree()).map(([c]) => c)).toEqual(["cap_reached"]);
    vi.advanceTimersByTime(CLOSES - Date.now());
    expect(Date.now()).toBe(CLOSES);
    expect(whyOf(ui.tree()).map(([c]) => c)).toEqual(["closed"]);
  });

  it("every locale has the round's sentence, and none carries an unfilled slot", () => {
    const sentence = (locale: Record<string, string>) => locale["externalPlay.checkinExtend.why.roundNoneOpen"];
    const dict = (l: string) => JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
    expect(sentence(en)).toBe("No board can be extended right now");
    let checked = 0;
    for (const l of ["es", "fr", "nl"]) {
      expect(sentence(dict(l)), `${l}: translated`).toBeTruthy();
      expect(sentence(dict(l)), `${l}: not the English`).not.toBe(sentence(en));
      expect(sentence(dict(l)), `${l}: no unfilled slot`).not.toMatch(/[{}]/);
      checked += 1;
    }
    expect(checked, "anti-vacuity: three other locales").toBe(3);
  });
});

const RESULT_FOR_CLOCK = {
  extended: 1,
  skipped: { closed: 0, gameStarted: 0, capReached: 0 },
  notOpenYet: 0,
  ownBoards: 0,
  failed: 0,
  addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
};
