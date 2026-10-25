// T16 (D12), retargeted by phase 2 (Task 10): the Open round presses and the WORDS of their answers.
//
// The Open round control that used to mount on each stage card is deleted; the Arbiter Panel's round column presses the same
// thing through `useOpenRound` (reducer + runner, open-round-state.ts) and words each answer with `openNoticeText` /
// `resendNoticeText` (open-round-control.tsx, kept exactly for that). So this suite drives the REAL chain a person triggers, hook
// -> reducer -> runner -> the notice the state holds -> the helper that words it, with the network doubled at `apiV1`:
// Open round asks first and sends nothing; the answer - the server's own count of PLAYERS invited, the boards it skipped, or a
// refusal by its code - reads in words; a Resend sends for its own pairing and answers there.
// What the control drew around them (its card, its dialog title, its "+5 min to the round") went with it; the round's "+5" is the
// panel's own `RoundExtend` (arbiter-panel.test.tsx), and the column's block is arbiter/__tests__/round-column.test.tsx.
// No DOM in this workspace: the hook harness renders a probe that hands the handle out as a prop.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { emptyExtendTally } from "@/lib/checkin-extend";

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

import { ApiV1Error } from "@/lib/client-v1";
import { openNoticeText, resendNoticeText } from "../open-round-control";
import { initialOpenRoundUi } from "../open-round-state";
import { useOpenRound, type OpenRoundHandle } from "../use-open-round";

const en = EN as unknown as Record<string, string>;
const pl = (key: string, n: number) => en[`${key}.${n === 1 ? "one" : "other"}`]!.replace("{count}", String(n));
/** The very `msg` / `plural` the column hands its helpers (`useMsg` / `useMsgPlural`), over the English dictionary. */
const msg = (key: string, vars?: Record<string, string | number>) => tRuntime(EN, key, vars);
const plural = (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN, key, count, "en", vars);

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

/** The probe hands the whole handle out as a prop, so a test reads and calls exactly what the column reads and calls. */
function Probe({ view }: { view: OpenRoundView | null }) {
  return createElement("probe", { handle: useOpenRound(view) });
}
const mount = (view: OpenRoundView) => {
  const ui = renderIsland(Probe, { view });
  const handle = () => propsOf(ui.tree()[0]!).handle as OpenRoundHandle;
  return { ui, handle };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

/** What the column prints for the round's last Open: the helper over the notice the state holds (null when there is none). */
const openLines = (h: OpenRoundHandle, round: OpenRoundView): string[] | null => (h.state.notice === null ? null : openNoticeText(h.state.notice, round, msg, plural));
/** What the column prints on a pairing for its last Resend. */
const resendLine = (h: OpenRoundHandle): { fixtureId: string; text: string } | null =>
  h.state.rowNotice === null ? null : { fixtureId: h.state.rowNotice.fixtureId, text: resendNoticeText(h.state.rowNotice.notice, msg, plural) };

/** Presses Open round from its confirmation and answers the one request. */
async function openAnswered(answer: unknown, ok: boolean, round: OpenRoundView = ROUND()) {
  net.calls.length = 0;
  const { ui, handle } = mount(round);
  handle().ask();
  handle().open();
  if (ok) net.calls[0]!.resolve(answer);
  else net.calls[0]!.reject(answer);
  await flush();
  return { ui, handle, round };
}
/** Presses Resend on one pairing of an opened round and answers the one request. */
async function resendAnswered(fixtureId: string, answer: unknown, ok: boolean) {
  net.calls.length = 0;
  const { ui, handle } = mount(INVITED);
  handle().resend(fixtureId);
  if (ok) net.calls[0]!.resolve(answer);
  else net.calls[0]!.reject(answer);
  await flush();
  return { ui, handle };
}

beforeEach(() => {
  net.calls.length = 0;
  router.refresh.mockReset();
});

describe("Open round - ask, then one request", () => {
  it("the empty case first: nothing pressed ⇒ the dialog is closed, nothing has been sent, and there is nothing to word", () => {
    const { handle } = mount(ROUND());
    expect(handle().state).toEqual(initialOpenRoundUi());
    expect(openLines(handle(), ROUND()), "no answer yet: no notice").toBeNull();
    expect(resendLine(handle())).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it("Open round only ASKS: the confirmation is up and nothing is sent; Cancel closes it and sends nothing", () => {
    const { handle } = mount(ROUND());
    handle().ask();
    expect(handle().state.confirming).toBe(true);
    expect(net.calls).toHaveLength(0);
    handle().cancel();
    expect(handle().state.confirming).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("a board the server skipped is named by its board number with the reason, after the count of players invited", async () => {
    const { handle, round } = await openAnswered({ opened: true, invited: 2, retrying: 0, skipped: [{ fixtureId: "f2", reason: "send_failed" }] }, true);
    const skip = en["runsheet.round.skipLine"]!
      .replace("{board}", en["arbiter.boardNo"]!.replace("{n}", "2"))
      .replace("{reason}", en["externalPlay.openRound.skipped.sendFailed"]!);
    // One line each: the count, then the skipped board.
    expect(openLines(handle(), round)).toEqual([pl("externalPlay.openRound.invited", 2), skip]);
  });

  it("every answer the server can give reads in words - a refusal by its reason, an error by its code - never the server's English", async () => {
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
      const { handle, round } = await openAnswered(answer, ok);
      expect(openLines(handle(), round), String(expected)).toEqual([expected]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: answers checked").toBe(7);
  });

  it("the notice survives the refresh that hands down the opened round (the same round, redrawn)", async () => {
    const { ui, handle } = await openAnswered({ opened: true, invited: 4, retrying: 0, skipped: [] }, true);
    ui.rerender({ view: INVITED });
    expect(openLines(handle(), INVITED)).toEqual([pl("externalPlay.openRound.invited", 4)]);
    expect(router.refresh, "the answer refreshed the page once").toHaveBeenCalledTimes(1);
  });
});

describe("Resend - on its own pairing", () => {
  it("sends for THAT pairing, answers on its row, and holds every other press meanwhile", async () => {
    const { handle } = mount(INVITED);
    handle().resend("f2");
    handle().resend("f1");
    expect(net.calls.map((c) => c.url), "the second pairing's press waited").toEqual(["/api/v1/fixtures/f2/external-play/resend"]);
    expect(handle().state.busy).toEqual({ kind: "resend", fixtureId: "f2" });
    net.calls[0]!.resolve({ emailed: 2, retrying: 0 });
    await flush();
    expect(resendLine(handle())).toEqual({ fixtureId: "f2", text: pl("runsheet.round.resent", 2) });
    expect(handle().state.busy).toBeNull();
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
      const { handle } = await resendAnswered("f1", answer, ok);
      expect(resendLine(handle()), String(expected)).toEqual({ fixtureId: "f1", text: expected });
      checked += 1;
    }
    expect(checked, "anti-vacuity: answers checked").toBe(7);
  });
});

// C1 (task 7 fix round 1): an invite the mail worker is still sending is neither "0 invited" nor "could not be sent". The server now
// answers { invited, retrying } for an open and { emailed, retrying } for a resend; the arbiter reads them in words, through the real
// hook, reducer and runner. The true failure (nothing sent, nothing queued) keeps its old words.
describe("a retrying invite is not reported as no invite", () => {
  const SENDING = (n: number) => pl("runsheet.round.sending", n);
  const skipLine = (board: number) =>
    en["runsheet.round.skipLine"]!
      .replace("{board}", en["arbiter.boardNo"]!.replace("{n}", String(board)))
      .replace("{reason}", en["externalPlay.openRound.skipped.sendFailed"]!);

  it("open: only retrying seats says they are sending, and never '0 players invited'", async () => {
    const { handle, round } = await openAnswered({ opened: true, invited: 0, retrying: 3, skipped: [] }, true);
    expect(openLines(handle(), round)).toEqual([SENDING(3)]);
  });

  it("open: invited and retrying together read as two lines, the count of each", async () => {
    const { handle, round } = await openAnswered({ opened: true, invited: 2, retrying: 1, skipped: [] }, true);
    expect(openLines(handle(), round)).toEqual([pl("externalPlay.openRound.invited", 2), SENDING(1)]);
  });

  it("open: a retrying seat on a board the server also skipped keeps the skip line after the sending line", async () => {
    const { handle, round } = await openAnswered({ opened: true, invited: 0, retrying: 2, skipped: [{ fixtureId: "f2", reason: "send_failed" }] }, true);
    expect(openLines(handle(), round)).toEqual([SENDING(2), skipLine(2)]);
  });

  it("open: nothing sent and nothing queued keeps its old words (0 invited, the skipped board) - the true failure is not softened", async () => {
    const { handle, round } = await openAnswered({ opened: true, invited: 0, retrying: 0, skipped: [{ fixtureId: "f1", reason: "send_failed" }] }, true);
    const lines = openLines(handle(), round);
    expect(lines).toEqual([pl("externalPlay.openRound.invited", 0), skipLine(1)]);
    expect(lines!.join(" ")).not.toContain(SENDING(0));
  });

  it("resend: nothing emailed yet but invites queued says they are sending, not 'could not be sent'", async () => {
    const { handle } = await resendAnswered("f1", { emailed: 0, retrying: 2 }, true);
    expect(resendLine(handle())).toEqual({ fixtureId: "f1", text: SENDING(2) });
    expect(resendLine(handle())!.text).not.toContain(en["runsheet.round.resentNone"]!);
  });

  it("resend: emailed and retrying together read as both facts on the row", async () => {
    expect(resendLine((await resendAnswered("f1", { emailed: 1, retrying: 1 }, true)).handle())!.text).toBe(`${pl("runsheet.round.resent", 1)} ${SENDING(1)}`);
    expect(resendLine((await resendAnswered("f1", { emailed: 2, retrying: 0 }, true)).handle())!.text, "no retrying: the old line alone").toBe(pl("runsheet.round.resent", 2));
  });

  it("the sending line is a real sentence in every language: a plural pair, the count in both, no em dash or arrow", () => {
    // Built from code points: a `\u` escape written into a source file by a tool becomes a raw control character.
    const banned = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2192)}]`);
    let checked = 0;
    for (const locale of ["en", "nl", "fr", "es"]) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
      for (const form of ["one", "other"]) {
        const text = dict[`runsheet.round.sending.${form}`];
        expect(text, `${locale} runsheet.round.sending.${form}`).toBeTruthy();
        expect(text, `${locale} ${form} carries the count`).toContain("{count}");
        expect(text, `${locale} ${form}: no em dash or arrow`).not.toMatch(banned);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 plural forms").toBe(8);
  });
});
