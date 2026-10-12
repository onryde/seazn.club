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
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";

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
  windowMinutes: 20,
  scheduledAt: null,
  press: "open",
  pairings: [P(1), P(2)],
  ...o,
});
const OPENED_AT = "2026-10-16T18:04:00.000Z";
const INVITED = ROUND({
  state: "open",
  openedAt: OPENED_AT,
  deadlineAt: "2026-10-16T18:24:00.000Z",
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
    net.calls[0]!.resolve({ opened: true, invited: 4, skipped: [] });
    await flush();
    expect(dialog(ui.tree()).open, "answered: the dialog closes").toBe(false);
    expect(noticeText(ui.tree()), "the server's count, as PLAYERS").toBe(pl("externalPlay.openRound.invited", 4));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("a board the server skipped is named by its board number with the reason", async () => {
    const ui = mount(ROUND());
    click(byTestId(ui.tree(), "open-round-cta")[0]);
    dialog(ui.tree()).onConfirm();
    net.calls[0]!.resolve({ opened: true, invited: 2, skipped: [{ fixtureId: "f2", reason: "send_failed" }] });
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
    net.calls[0]!.resolve({ opened: true, invited: 4, skipped: [] });
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
    net.calls[0]!.resolve({ emailed: 2 });
    await flush();
    const notices = byTestId(ui.tree(), "open-round-row-notice");
    expect(notices.map((n) => textOf(n))).toEqual([pl("runsheet.round.resent", 2)]);
    const row = byTestId(ui.tree(), "open-round-already-f2")[0]!;
    expect(textOf(row)).toContain(pl("runsheet.round.resent", 2));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("each refusal reads in words on the row (the window, a hold, a game, a change, the flag), and a send that reached nobody says so", async () => {
    const cases: [unknown, boolean, string][] = [
      [{ emailed: 0 }, true, en["runsheet.round.resentNone"]!],
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
