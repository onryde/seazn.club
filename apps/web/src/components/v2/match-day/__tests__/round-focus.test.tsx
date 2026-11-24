// Match Day online, Task 7 - the round panel (`RoundFocus`): what one online round wants from the organiser, in the focus column.
//
// Two ways of looking, on purpose (the arbiter column's suite does the same): `renderToStaticMarkup` reads what a person would see (copy
// comes from the English dictionary, never typed here), and the hook harness (`renderIsland`, no DOM in this workspace) drives the REAL
// seam - the panel's own `useOpenRoundWith`, reducers and runners with the network doubled at `apiV1` - because a pure view cannot see
// whether the press it renders is wired to anything (AGENTS recurring classes 1 and 2). Neither `next/navigation` nor a router is mocked:
// the panel reads none, and a render that reached `useRouter` would throw outside the app router.
//
// Where an expected value comes from: counts come from the FIXTURE (boards typed with their seats and windows), sentences from the
// dictionary's entry for the key the spec names, routes from the server's own (`open-round`, `extend-checkin`, the stage's `generate`).
// Anti-vacuity: every sweep reports what it checked, and every "no press" claim is paired with the same view WITH its presses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import { emptyExtendTally } from "@/lib/checkin-extend";
import type { Dict } from "@/lib/i18n-constants";
import type { Reader } from "@/lib/match-day/online";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";
import { messages } from "@/lib/messages";
import type { OpenRoundPairing, OpenRoundResult, OpenRoundView } from "@/lib/open-round";
import { OPEN_ROUND_SKIP_KEYS } from "@/lib/open-round";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { RETIRED_EXTEND_REASONS, RETIRED_EXTEND_REASON_LEADS } from "@/lib/__tests__/_retired-extend-reasons";
import type { MatchDayCtx } from "../court-focus";
import { OpenRoundBlockView, RoundFocus, WaitingList, type RoundFocusProps } from "../round-focus";
import { OpenPayReceipt } from "../../online-chess/open-pay-receipt";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { quoteOf } from "@/lib/__tests__/_receipt-quote";
import { openNoticeText } from "../../desk/open-round-control";
import { arbiterRound, board, done, held, iso, live, NOW, openWindow, overRound, playingRound, round, withState } from "./_online-fixtures";

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
const { ApiV1Error } = await import("@/lib/client-v1");

const en = messages as unknown as Record<string, string>;
const t = (key: string, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);
const pl = (key: string, n: number, vars: Record<string, string | number> = {}) =>
  Object.entries({ count: n, ...vars }).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[`${key}.${n === 1 ? "one" : "other"}`]!);
/** React escapes text; compare against the escaped form. */
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const dict = enUi as unknown as Dict;
const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };
const FROZEN: Reader = { ...EDITOR, frozen: true };
const VIEWER: Reader = { ...EDITOR, editor: false };
const NOT_OFFERED: Reader = { ...EDITOR, offered: false };

const P = (n: number, o: Partial<OpenRoundPairing> = {}): OpenRoundPairing => ({
  fixtureId: `f${n}`,
  boardNo: n,
  whiteName: `White ${n}`,
  blackName: `Black ${n}`,
  invitedAt: null,
  owedSeats: 2,
  canResend: false,
  ...o,
});
const VIEW = (o: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "stage-1",
  stageName: "Swiss",
  roundNo: 3,
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
  pairings: [P(1), P(2), P(3)],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...o,
});

/** A paired, not opened row carrying its view (what `readOnlineRounds` builds from one). */
const paired = (key: string, view: OpenRoundView | null, over: Partial<MatchDayOnlineRound> = {}) => round(key, "before", null, { view, ...over });
const noop = () => {};
const props = (r: MatchDayOnlineRound, o: Partial<RoundFocusProps> = {}): RoundFocusProps => ({
  ctx,
  round: r,
  next: null,
  reader: EDITOR,
  nowMs: NOW,
  backLabel: "All rounds",
  onBack: noop,
  onChanged: noop,
  onFrozen: noop,
  onOpenBoard: noop,
  onOpenRound: noop,
  ...o,
});
const underEnglish = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale="en">{node}</DictProvider>);
const html = (r: MatchDayOnlineRound, o: Partial<RoundFocusProps> = {}) => underEnglish(<RoundFocus {...props(r, o)} />);

const count = (h: string, testid: string) => h.split(`data-testid="${testid}"`).length - 1;
const tagOf = (h: string, testid: string): string | null => new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h)?.[0] ?? null;
/** The inner text of the first element with this test id (tags stripped). */
const textIn = (h: string, testid: string): string | null => {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m: RegExpExecArray | null;
  const from = open.index + open[0].length;
  while ((m = re.exec(h)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index).replace(/<[^>]+>/g, "");
  }
  return null;
};

/** The inner HTML of the first element with this test id (tags kept): where a thing STANDS is asserted on what its container holds. */
const innerOf = (h: string, testid: string): string | null => {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m: RegExpExecArray | null;
  const from = open.index + open[0].length;
  while ((m = re.exec(h)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index);
  }
  return null;
};

/** Every control this panel draws that STARTS play or moves the day on (the presses `mayPress(reader, "start")` gates). */
const PRESSES = [
  "md-round-open-cta",
  "md-round-reopen-cta",
  "arbiter-column-reinvite",
  "arbiter-waiting-resend",
  "arbiter-waiting-extend",
  "arbiter-extend-round-cta",
  "md-round-pair-next",
  "md-round-ready-go",
] as const;
const presses = (h: string) => PRESSES.reduce((n, id) => n + count(h, id), 0);

beforeEach(() => {
  net.calls.length = 0;
});

// ---- the phases -----------------------------------------------------------------------------------------------------------------

describe("RoundFocus: not started - the division must start first", () => {
  it("says to start the division, offers nothing, and names its state", () => {
    const h = html(round("stage-1:1", "not_started", null));
    expect(textIn(h, "md-round-start-first")).toBe(en["externalPlay.openRound.startFirst"]);
    expect(presses(h), "no press of any kind").toBe(0);
    expect(tagOf(h, "md-focus")).toContain('data-state="not_started"');
  });
});

describe("RoundFocus: before - paired, waiting to be opened", () => {
  it("lists the pairings and offers ONE primary 'Open round N' (no earlier round in play)", () => {
    const h = html(paired("stage-1:3", VIEW()));
    expect(count(h, "md-round-open-cta"), "one open press").toBe(1);
    expect(tagOf(h, "md-round-open-cta")).toContain('data-primary="true"');
    expect(count(h, "arbiter-column-pairings") === 1 && [1, 2, 3].every((n) => count(h, `arbiter-column-pairing-f${n}`) === 1), "all 3 pairings listed").toBe(true);
    expect(textIn(h, "md-round-open-cta")).toBe(en["runsheet.round.openCta"]);
    expect(count(h, "arbiter-column-earlier")).toBe(0);
    expect(tagOf(h, "md-focus")).toContain('data-state="before"');
  });

  it("an earlier round still in play: the warning stands inline and the press is quiet, not primary", () => {
    const h = html(paired("stage-1:3", VIEW({ earlierInPlay: [{ roundNo: 2, games: 3 }] })));
    expect(count(h, "md-round-open-cta"), "still pressable: a warning, never a block").toBe(1);
    expect(tagOf(h, "md-round-open-cta")).toContain('data-primary="false"');
    expect(textIn(h, "arbiter-column-earlier")).toBe(pl("runsheet.round.confirmEarlierInPlay", 3, { round: 2 }));
  });

  it("the confirmation is the run sheet's, under the panel's own test id, and only while it is asked for", () => {
    const view = VIEW();
    const r = paired("stage-1:3", view);
    const ui = renderIsland(RoundFocus, props(r));
    const blockProps = () => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as { on: { ask(): void }; state: { confirming: boolean }; panel: { confirmTestId: string; ctaTestId: string } };
    expect(blockProps().state.confirming, "empty case: not asked").toBe(false);
    expect(blockProps().panel).toEqual({ ctaTestId: "md-round-open-cta", confirmTestId: "md-round-confirm" });
    const confirming = underEnglish(
      <OpenRoundBlockView view={view} mayPress state={{ confirming: true, busy: null, notice: null, rowNotice: null, pay: null }} tz="Europe/London" showStage={false} on={{ ask: noop, cancel: noop, open: noop }} panel={{ ctaTestId: "md-round-open-cta", confirmTestId: "md-round-confirm" }} />,
    );
    expect(count(confirming, "md-round-confirm"), "the dialog carries the panel's id").toBe(1);
    expect(count(confirming, "arbiter-column-confirm"), "and not the column's").toBe(0);
  });

  it("FROZEN, a viewer and a club that is not offered keep the pairings and lose the press; the same view unfrozen has it", () => {
    const r = paired("stage-1:3", VIEW());
    expect(count(html(r, { reader: EDITOR }), "md-round-open-cta"), "anti-vacuity: the editor has it").toBe(1);
    let checked = 0;
    for (const reader of [FROZEN, VIEWER, NOT_OFFERED]) {
      const h = html(r, { reader });
      expect(count(h, "md-round-open-cta"), JSON.stringify(reader)).toBe(0);
      expect(count(h, "arbiter-column-pairings"), "the read stays").toBe(1);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a press the server would not take (view.press none) and a row with no view say so instead of offering one", () => {
    expect(count(html(paired("stage-1:3", VIEW({ press: "none" }))), "md-round-open-cta")).toBe(0);
    const none = html(paired("stage-1:3", null));
    expect(textIn(none, "md-round-nothing")).toBe(en["arbiter.column.nothingPaired"]);
    expect(presses(none)).toBe(0);
    expect(count(html(paired("stage-1:3", VIEW({ pairings: [] }))), "md-round-nothing"), "no pairings, no block over '0 boards'").toBe(1);
  });
});

/** A round in check-in: three boards, two of them with a seat not here (board 1: white here; board 2: nobody; board 3: both here). */
const here = { here: true, invites: [] };
const away = { here: false, invites: [] };
function checkinFixture() {
  const b1 = board({ fixtureId: "c-1", boardNo: 1, seats: { white: here, black: away } });
  const b2 = board({ fixtureId: "c-2", boardNo: 2, seats: { white: away, black: away } });
  const b3 = board({ fixtureId: "c-3", boardNo: 3, seats: { white: here, black: here } });
  const view = VIEW({ state: "open", press: "none", pairings: [P(1, { fixtureId: "c-1", canResend: true }), P(2, { fixtureId: "c-2", canResend: true }), P(3, { fixtureId: "c-3" })] });
  return { r: round("stage-1:3", "checkin", arbiterRound([b1, b2, b3], { extendableBoards: 2 }), { view }), view };
}

describe("RoundFocus: checking in", () => {
  it("shows the clock, the tally and 'Not here yet' for exactly the boards with a seat missing", () => {
    const { r } = checkinFixture();
    const h = html(r);
    expect(count(h, "arbiter-checkin-clock"), "the clock").toBe(1);
    expect(count(h, "arbiter-checkin-tally"), "the tally").toBe(1);
    expect(count(h, "arbiter-waiting-row"), "boards 1 and 2 are waited on; board 3 is complete").toBe(2);
    expect(h).toContain(`data-fixture-id="c-1"`);
    expect(h).toContain(`data-fixture-id="c-2"`);
    expect(count(h, "arbiter-waiting-row") + 1, "board 3 is not listed").toBe(3);
    expect(textIn(h, "arbiter-waiting-heading")).toBe(pl("arbiter.column.waiting", 2));
    expect(tagOf(h, "md-focus")).toContain('data-state="checkin"');
  });

  it("FROZEN loses every press on the SAME view; unfrozen has Resend and +5 on both rows and the round's +5", () => {
    const { r } = checkinFixture();
    const open = html(r, { reader: EDITOR });
    expect(count(open, "arbiter-waiting-resend"), "anti-vacuity: a Resend on each waiting row").toBe(2);
    expect(count(open, "arbiter-waiting-extend"), "a +5 on each waiting row").toBe(2);
    expect(count(open, "arbiter-extend-round-cta"), "the round's +5").toBe(1);
    let checked = 0;
    for (const reader of [FROZEN, VIEWER, NOT_OFFERED]) {
      const h = html(r, { reader });
      expect(presses(h), JSON.stringify(reader)).toBe(0);
      expect(count(h, "arbiter-waiting-row"), "the waiting list still lists").toBe(2);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a board held for a Lichess link whose window runs: the block says why, and the round's press is 'Open round N again'", () => {
    const linked = withState({ kind: "on_hold" }, { fixtureId: "h-1", boardNo: 4, checkin: openWindow(), flagCount: 0 });
    (linked as { hold_reason?: string }).hold_reason = "lichess_unlinked";
    const wait = board({ fixtureId: "c-1", boardNo: 1, seats: { white: here, black: away } });
    const view = VIEW({ state: "open", press: "reopen", pairings: [P(1, { fixtureId: "c-1" }), P(4, { fixtureId: "h-1" })] });
    const r = round("stage-1:3", "checkin", arbiterRound([wait, linked]), { view });
    const h = html(r);
    expect(count(h, "md-round-linkhold-board")).toBe(1);
    expect(tagOf(h, "md-round-linkhold-board")).toContain('data-reason="lichess_unlinked"');
    expect(textIn(h, "md-round-linkhold-reason")).toBe(en[OPEN_ROUND_SKIP_KEYS.lichess_unlinked]);
    expect(textIn(h, "md-round-reopen-cta")).toBe(t("matchDay.round.openAgain", { round: 3 }));
    expect(count(h, "md-round-linkhold-closed"), "the window runs: no closed line").toBe(0);
    expect(count(html(r, { reader: FROZEN }), "md-round-reopen-cta"), "frozen: the block says why, the press is gone").toBe(0);
    expect(count(html(r, { reader: FROZEN }), "md-round-linkhold"), "frozen: the block stays").toBe(1);
  });
});

describe("RoundFocus: playing", () => {
  it("prints the tallies from the boards on screen", () => {
    const r = round("stage-1:3", "playing", arbiterRound([live(), live(9), done("1-0")]));
    const h = html(r);
    expect(textIn(h, "arbiter-column-playing")).toBe(pl("arbiter.column.playing", 3, { count: 2, total: 3 }));
    expect(textIn(h, "arbiter-column-finished")).toBe(pl("arbiter.column.finished", 1));
    expect(tagOf(h, "md-focus")).toContain('data-state="playing"');
  });

  it("'Round N+1 is ready to open' is ONE line with a go-to press, and the playing panel never draws the next round's open press", () => {
    const nextView = VIEW({ roundNo: 4, press: "open" });
    const next = paired("stage-1:4", nextView);
    const h = html(playingRound("stage-1:3"), { next });
    expect(textIn(h, "md-round-ready")).toContain(t("matchDay.round.ready", { round: 4 }));
    expect(tagOf(h, "md-round-ready")).toContain('data-key="stage-1:4"');
    expect(count(h, "md-round-ready-go"), "anti-vacuity: the go-to press is drawn").toBe(1);
    expect(textIn(h, "md-round-ready-go")).toBe(t("matchDay.round.readyGo", { round: 4 }));
    expect(count(h, "md-round-open-cta"), "the next round's open belongs to the next round's own panel").toBe(0);
    expect(count(h, "arbiter-column-open"), "and no open block at all").toBe(0);
    // the same row with no `next`: no line, no press
    const alone = html(playingRound("stage-1:3"), { next: null });
    expect(count(alone, "md-round-ready")).toBe(0);
    // frozen: the line is said, the go-to press is not
    const frozen = html(playingRound("stage-1:3"), { next, reader: FROZEN });
    expect(count(frozen, "md-round-ready")).toBe(1);
    expect(count(frozen, "md-round-ready-go")).toBe(0);
  });

  it("a checking-in round says it too", () => {
    const { r } = checkinFixture();
    const h = html(r, { next: paired("stage-1:4", VIEW({ roundNo: 4 })) });
    expect(count(h, "md-round-ready")).toBe(1);
    expect(count(h, "md-round-open-cta")).toBe(0);
  });

  it("the round's own press: a board owed its invite again offers a reinvite, never the next round's open", () => {
    const owedView = VIEW({ state: "open", press: "reinvite", pairings: [P(1, { owedSeats: 2 }), P(2, { owedSeats: 0 })] });
    const r = round("stage-1:3", "playing", arbiterRound([live(), live(9)]), { view: owedView });
    expect(count(html(r), "arbiter-column-reinvite")).toBe(1);
    expect(count(html(r), "md-round-open-cta")).toBe(0);
    expect(count(html(r, { reader: FROZEN }), "arbiter-column-reinvite")).toBe(0);
  });
});

describe("RoundFocus: Pair next round (MD-R15)", () => {
  const over = (o: Partial<MatchDayOnlineRound> = {}) => overRound("stage-1:3", { pair_next_round: 4, ...o });

  it("EMPTY CASE FIRST: a round with no board on screen is never over, so nothing to pair", () => {
    const none = round("stage-1:3", "playing", arbiterRound([]), { pair_next_round: 4 });
    expect(count(html(none), "md-round-pair-next")).toBe(0);
  });

  it("offers ONE primary press with its hint when every board is over and the stage's next round to pair is round + 1", () => {
    const h = html(over());
    expect(count(h, "md-round-pair-next")).toBe(1);
    expect(tagOf(h, "md-round-pair-next")).toContain('data-primary="true"');
    expect(textIn(h, "md-round-pair-next")).toBe(en["schedule.pairNext"]);
    expect(textIn(h, "md-round-pair")).toContain(t("matchDay.round.pairHint", { round: 4 }));
  });

  it("is not offered while a board still plays, when the stage pairs no round, or a round further on, and not to frozen, viewer or club-not-offered readers", () => {
    const refused: [string, string][] = [
      ["a board still plays", html(playingRound("stage-1:3", { pair_next_round: 4 }))],
      ["no round left to pair", html(over({ pair_next_round: null }))],
      ["a round further on is next (round 4 is already paired)", html(over({ pair_next_round: 5 }))],
      ["frozen", html(over(), { reader: FROZEN })],
      ["viewer", html(over(), { reader: VIEWER })],
      ["not offered", html(over(), { reader: NOT_OFFERED })],
    ];
    for (const [why, h] of refused) expect(count(h, "md-round-pair-next"), why).toBe(0);
    expect(refused.length, "anti-vacuity").toBe(6);
  });

  it("a board owed its invite again keeps the round open: not over, no Pair next", () => {
    const owedView = VIEW({ state: "open", press: "reinvite", pairings: [P(1, { fixtureId: "o-1", owedSeats: 2 })] });
    const r = round("stage-1:3", "playing", arbiterRound([done("1-0", { fixtureId: "o-1" }), done("0-1")]), { pair_next_round: 4, view: owedView });
    expect(count(html(r), "md-round-pair-next")).toBe(0);
    expect(count(html(r), "arbiter-column-reinvite"), "it is the reinvite that is offered").toBe(1);
  });
});

describe("RoundFocus: boards held for a Lichess link (MD-R2/R22)", () => {
  const heldFor = (reason: string, checkin = openWindow()) => {
    const b = withState({ kind: "on_hold" }, { fixtureId: `h-${reason}`, boardNo: 7, checkin });
    (b as { hold_reason?: string }).hold_reason = reason;
    return b;
  };
  const rowOf = (b: ReturnType<typeof heldFor>, press: OpenRoundView["press"]) =>
    round("stage-1:3", "playing", arbiterRound([live(), b]), { view: VIEW({ state: "open", press, pairings: [P(1), P(7, { fixtureId: b.fixtureId })] }) });

  it("only the two link reasons draw the block; every other reason a board can be held for does not (swept over NEEDS_REASONS)", () => {
    let checked = 0;
    let withBlock = 0;
    for (const reason of NEEDS_REASONS) {
      const h = html(rowOf(heldFor(reason), "none"));
      const expected = reason === "lichess_unlinked" || reason === "lichess_reconnect";
      expect(count(h, "md-round-linkhold") === 1, reason).toBe(expected);
      if (expected) withBlock += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity: every reason is read").toBe(NEEDS_REASONS.length);
    expect(withBlock, "and exactly the two link reasons drew it").toBe(2);
  });

  it("each reason has its own sentence; 'Open round N again' is offered to an editor while the round can take it", () => {
    const a = html(rowOf(heldFor("lichess_unlinked"), "reopen"));
    const b = html(rowOf(heldFor("lichess_reconnect"), "reopen"));
    expect(textIn(a, "md-round-linkhold-reason")).toBe(en[OPEN_ROUND_SKIP_KEYS.lichess_unlinked]);
    expect(textIn(b, "md-round-linkhold-reason")).toBe(en[OPEN_ROUND_SKIP_KEYS.lichess_reconnect]);
    expect(en[OPEN_ROUND_SKIP_KEYS.lichess_unlinked]).not.toBe(en[OPEN_ROUND_SKIP_KEYS.lichess_reconnect]);
    expect(textIn(a, "md-round-reopen-cta")).toBe(t("matchDay.round.openAgain", { round: 3 }));
  });

  it("a closed window says so - never silent - and the server's own 'none' means no press to loop on", () => {
    const closed = { ...openWindow(), canExtend: false, refusal: "closed" as const, deadlineAt: iso(NOW - 60_000) };
    const h = html(rowOf(heldFor("lichess_unlinked", closed), "none"));
    expect(tagOf(h, "md-round-linkhold-board")).toContain('data-window-closed="true"');
    expect(textIn(h, "md-round-linkhold-closed")).toBe(en[OPEN_ROUND_SKIP_KEYS.window_closed]);
    expect(count(h, "md-round-reopen-cta")).toBe(0);
    // the same board with its window running: no closed line (the negative needs its positive pair)
    const running = html(rowOf(heldFor("lichess_unlinked"), "reopen"));
    expect(tagOf(running, "md-round-linkhold-board")).toContain('data-window-closed="false"');
    expect(count(running, "md-round-linkhold-closed")).toBe(0);
  });
});

// ---- the wiring: the panel's own hooks, reducers and runners, through the real seam ---------------------------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));
type BlockProps = { state: { confirming: boolean; busy: unknown; notice: unknown; rowNotice: unknown }; on: { ask(): void; cancel(): void; open(): void } };

describe("RoundFocus: Open round - the row's own stage and round, answered through the shell's quiet read", () => {
  it("asks first, sends ONE open-round for THIS row's stage and round (an older stage's row too), then reads the day - never the router", async () => {
    const onChanged = vi.fn();
    const older = paired("stage-old:2", VIEW({ stageId: "stage-old", roundNo: 2 }), { stage_id: "stage-old", round_no: 2 });
    const ui = renderIsland(RoundFocus, props(older, { onChanged }));
    const block = () => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as BlockProps;
    block().on.ask();
    expect(block().state.confirming, "asked").toBe(true);
    expect(net.calls, "asking sends nothing").toHaveLength(0);
    block().on.open();
    block().on.open();
    expect(net.calls.map((c) => [c.url, c.json]), "one POST, this row's own stage").toEqual([["/api/v1/stages/stage-old/open-round", { roundNo: 2 }]]);
    const answer: OpenRoundResult = { opened: true, invited: 6, retrying: 0, skipped: [], payment: null };
    net.calls[0]!.resolve(answer);
    await flush();
    expect(onChanged, "the shell's read, once").toHaveBeenCalledTimes(1);
    expect(block().state.busy).toBeNull();
    expect(block().state.notice).toEqual({ kind: "answered", result: answer });
  });

  it("a poll that hands a NEW row object with the same key keeps the open confirmation (the round did not change)", () => {
    const r = paired("stage-1:3", VIEW());
    const ui = renderIsland(RoundFocus, props(r));
    const block = () => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as BlockProps;
    block().on.ask();
    expect(block().state.confirming).toBe(true);
    ui.rerender(props({ ...r, view: VIEW({ pairings: [P(1), P(2), P(3), P(4)] }) }));
    expect(block().state.confirming, "same stage and round: the dialog the organiser reads stays").toBe(true);
    ui.rerender(props(paired("stage-1:4", VIEW({ roundNo: 4 }), { round_no: 4 })));
    expect(block().state.confirming, "a different round resets it: a confirmation never carries to a round nobody confirmed").toBe(false);
  });

  it("the billing freeze (402) on an open is worded as the freeze, not 'failed'", async () => {
    const ui = renderIsland(RoundFocus, props(paired("stage-1:3", VIEW())));
    const block = () => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as BlockProps;
    block().on.ask();
    block().on.open();
    net.calls[0]!.reject(new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", { feature_key: "competitions.max_active" }));
    await flush();
    const h = underEnglish(<OpenRoundBlockView view={VIEW()} mayPress state={block().state as never} tz="Europe/London" showStage={false} on={{ ask: noop, cancel: noop, open: noop }} panel={{ ctaTestId: "md-round-open-cta", confirmTestId: "md-round-confirm" }} />);
    expect(textIn(h, "arbiter-column-open-notice")).toContain(esc(en["runsheet.round.err.frozen"]!));
    expect(h).not.toContain(esc(en["runsheet.round.err.failed"]!));
  });
});

describe("RoundFocus: +5 on a board, Resend and the round's +5 (check-in)", () => {
  const waiting = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => propsOf(ui.tree().find((e) => e.type === WaitingList)!) as unknown as { on: { extendBoard(id: string): void }; openRound: { resend(id: string): void; state: { rowNotice: { fixtureId: string; notice: { kind: string; code?: string } } | null } }; extendNotice: { fixtureId: string; text: string } | null; requestBusy: boolean };
  const extendResult = { fixtureId: "c-1", addedMinutes: 5, deadlineAt: iso(NOW + 13 * 60_000), extensionsLeft: 2 };

  it("a board's +5 posts that board's extend-checkin once (a double tap is one), says what happened under the board, then reads the day", async () => {
    const onChanged = vi.fn();
    const ui = renderIsland(RoundFocus, props(checkinFixture().r, { onChanged }));
    waiting(ui).on.extendBoard("c-1");
    waiting(ui).on.extendBoard("c-1");
    waiting(ui).on.extendBoard("c-2");
    expect(net.calls.map((c) => c.url), "one request at a time").toEqual(["/api/v1/fixtures/c-1/external-play/extend-checkin"]);
    expect(waiting(ui).requestBusy, "the other row's +5 is disabled while one is out").toBe(true);
    net.calls[0]!.resolve(extendResult);
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(waiting(ui).requestBusy).toBe(false);
    const notice = waiting(ui).extendNotice;
    expect(notice?.fixtureId, "the answer sits under the board it was pressed for").toBe("c-1");
    expect(notice?.text.length ?? 0, "and says something").toBeGreaterThan(0);
  });

  it("while the round's +5 is out, a board's +5 sends nothing (one request at a time across the two), and the round's press answers once it lands", async () => {
    const onChanged = vi.fn();
    const ui = renderIsland(RoundFocus, props(checkinFixture().r, { onChanged }));
    const hero = ui.tree().find((e) => propsOf(e).roundExtend !== undefined)!;
    (propsOf(propsOf(hero).roundExtend as ReactElement).onExtend as () => void)();
    expect(net.calls.map((c) => c.url), "the round's request is out").toEqual(["/api/v1/stages/stage-1/extend-checkin"]);
    expect(waiting(ui).requestBusy, "the waiting list sees the round's request").toBe(true);
    waiting(ui).on.extendBoard("c-1");
    expect(net.calls, "the board's +5 is not sent while the round's is out").toHaveLength(1);
    net.calls[0]!.resolve({ extended: 2, skipped: [], addedMinutes: 5 });
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(waiting(ui).requestBusy).toBe(false);
    waiting(ui).on.extendBoard("c-1");
    expect(net.calls, "free again: the board's +5 goes").toHaveLength(2);
  });

  it("a board id that is not in this round sends nothing", () => {
    const ui = renderIsland(RoundFocus, props(checkinFixture().r));
    waiting(ui).on.extendBoard("not-a-board");
    expect(net.calls).toHaveLength(0);
  });

  it("the billing freeze on a board's +5 reads as the freeze; the day is not read", async () => {
    const onChanged = vi.fn();
    const ui = renderIsland(RoundFocus, props(checkinFixture().r, { onChanged }));
    waiting(ui).on.extendBoard("c-2");
    net.calls[0]!.reject(new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", {}));
    await flush();
    expect(waiting(ui).extendNotice).toEqual({ fixtureId: "c-2", text: en["runsheet.round.err.frozen"] });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Resend posts the round's own resend route for that board; a 402 is the freeze's sentence on that row", async () => {
    const ui = renderIsland(RoundFocus, props(checkinFixture().r));
    waiting(ui).openRound.resend("c-1");
    expect(net.calls.map((c) => c.url)).toEqual(["/api/v1/fixtures/c-1/external-play/resend"]);
    net.calls[0]!.reject(new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", {}));
    await flush();
    const row = waiting(ui).openRound.state.rowNotice;
    expect(row?.fixtureId).toBe("c-1");
    expect(row?.notice).toMatchObject({ kind: "failed", code: "PAYMENT_REQUIRED" });
  });

  it("the round's +5 posts the stage's extend route for this row's round", async () => {
    const onChanged = vi.fn();
    const ui = renderIsland(RoundFocus, props(checkinFixture().r, { onChanged }));
    // The bar is handed to the hero as a prop (`roundExtend`), not as a child: the tree walk does not descend into it.
    const hero = ui.tree().find((e) => propsOf(e).roundExtend !== undefined)!;
    expect(hero, "anti-vacuity: the check-in hero is in the tree").toBeDefined();
    const bar = propsOf(hero).roundExtend as ReactElement;
    expect(typeof propsOf(bar).onExtend, "and carries the round's +5 bar").toBe("function");
    (propsOf(bar).onExtend as () => void)();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/stage-1/extend-checkin", { roundNo: 3 }]]);
    net.calls[0]!.resolve({ extended: 2, skipped: [], addedMinutes: 5 });
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("RoundFocus: Pair next round - the stage rail's own route, one request, and the answer outlives the press", () => {
  const pairProps = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => {
    const el = ui.tree().find((e) => typeof propsOf(e).onPair === "function") as ReactElement | undefined;
    return el === undefined ? null : (propsOf(el) as unknown as { onPair(round: number): void; state: { busy: boolean; notice: { kind: string; round?: number; code?: string } | null } });
  };

  it("posts {} to the row's own stage's generate route once, then reads the day, and keeps 'paired' on screen", async () => {
    const onChanged = vi.fn();
    const r = overRound("stage-1:3", { pair_next_round: 4 });
    const ui = renderIsland(RoundFocus, props(r, { onChanged }));
    expect(pairProps(ui), "anti-vacuity: the block is in the tree").not.toBeNull();
    pairProps(ui)!.onPair(4);
    pairProps(ui)!.onPair(4);
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/stage-1/generate", {}]]);
    expect(pairProps(ui)!.state.busy).toBe(true);
    net.calls[0]!.resolve({ created: 2, existing: 0, swiss_paired_round: 4 });
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(pairProps(ui)!.state).toEqual({ busy: false, notice: { kind: "paired", round: 4, caution: null } });
    // the poll moves the row on: the press is gone (the stage pairs round 5 next, not this round + 1) and the answer stays said
    ui.rerender(props({ ...r, pair_next_round: 5 }, { onChanged }));
    expect(pairProps(ui)!.state.notice).toMatchObject({ kind: "paired", round: 4 });
    // What that block DRAWS now: the answer is on screen, the press is not (the early return must keep a standing answer).
    const block = ui.tree().find((e) => typeof propsOf(e).onPair === "function")!;
    const h = underEnglish(block);
    expect(count(h, "md-round-pair-next"), "no press once the next round is paired").toBe(0);
    expect(textIn(h, "md-round-pair-notice"), "the answer stays said").toContain(t("matchDay.round.pairedNotice", { round: 4 }));
  });

  it("a refusal says what the server said; a 402 is a PLAN LIMIT in generic words, never the freeze sentence (MD-R32: the generate route has no freeze guard)", async () => {
    const r = overRound("stage-1:3", { pair_next_round: 4 });
    const ui = renderIsland(RoundFocus, props(r));
    pairProps(ui)!.onPair(4);
    net.calls[0]!.reject(new ApiV1Error("plan", 402, "PAYMENT_REQUIRED", { feature_key: "stages.max" }));
    await flush();
    expect(pairProps(ui)!.state.notice).toMatchObject({ kind: "failed", code: "PAYMENT_REQUIRED" });
    const el = ui.tree().find((e) => typeof propsOf(e).onPair === "function")!;
    expect(underEnglish(el)).toContain(esc(en["matchDay.round.pairPlanLimit"]!));
    expect(underEnglish(el), "not the sentence about active competitions").not.toContain(esc(en["runsheet.round.err.frozen"]!));
    expect(en["matchDay.round.pairPlanLimit"], "the two sentences really differ").not.toBe(en["runsheet.round.err.frozen"]);
    // an unreadable failure is the panel's own sentence
    pairProps(ui)!.onPair(4);
    net.calls[1]!.reject(new Error("network"));
    await flush();
    expect(underEnglish(ui.tree().find((e) => typeof propsOf(e).onPair === "function")!)).toContain(esc(en["matchDay.round.pairFailed"]!));
  });
});

// ---- Task 7 fix round 1: MD-R30 / MD-R31 / MD-R32 and the review's minors (M1, M3, M5) -------------------------------------------

describe("RoundFocus: MD-R31 - no 'X of N playing' above 'N boards finished'", () => {
  it("EMPTY CASE FIRST: a round with no board on screen prints no count at all", () => {
    const none = round("stage-1:3", "playing", arbiterRound([]));
    expect(count(html(none), "arbiter-column-playing")).toBe(0);
    expect(count(html(none), "arbiter-column-finished")).toBe(0);
  });

  it("every board over: the finished line stands alone; any board still playing, held or waiting to restart keeps the playing line", () => {
    const allOver = html(round("stage-1:3", "playing", arbiterRound([done("1-0"), done("0-1")])));
    expect(count(allOver, "arbiter-column-playing"), "all over: no playing line").toBe(0);
    expect(textIn(allOver, "arbiter-column-finished")).toBe(pl("arbiter.column.finished", 2));
    const cases: [string, MatchDayOnlineRound, number][] = [
      ["one still plays", round("stage-1:3", "playing", arbiterRound([done("1-0"), live()])), 1],
      ["one is held", round("stage-1:3", "playing", arbiterRound([done("1-0"), done("0-1"), held()])), 0],
    ];
    for (const [why, r, playing] of cases) {
      const h = html(r);
      expect(textIn(h, "arbiter-column-playing"), why).toBe(pl("arbiter.column.playing", r.round!.boards.length, { count: playing, total: r.round!.boards.length }));
    }
    expect(cases.length, "anti-vacuity: both negatives are read").toBe(2);
    // a board owed its invite again is "waiting to restart", not finished: the round is NOT all over, so the line stays
    const owedView = VIEW({ state: "open", press: "reinvite", pairings: [P(1, { fixtureId: "o-1", owedSeats: 2 })] });
    const waiting = html(round("stage-1:3", "playing", arbiterRound([done("1-0", { fixtureId: "o-1" }), done("0-1")]), { view: owedView }));
    expect(count(waiting, "arbiter-column-playing"), "a board waiting to restart keeps it").toBe(1);
  });
});

describe("RoundFocus: MD-R30 - a 402 on a guarded press tells the shell the competition froze", () => {
  const waiting = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => propsOf(ui.tree().find((e) => e.type === WaitingList)!) as unknown as { on: { extendBoard(id: string): void }; openRound: { resend(id: string): void } };
  const block = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as BlockProps;
  const frozen402 = () => new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", { feature_key: "competitions.max_active" });

  it("each of the four guarded presses (open, resend, a board's +5, the round's +5) reports it once, and a poll's new row object does not report it again", async () => {
    type Flow = { ui: ReturnType<typeof renderIsland<RoundFocusProps>>; r: MatchDayOnlineRound };
    const flows: [string, (onFrozen: () => void) => Flow][] = [
      [
        "open",
        (onFrozen) => {
          const r = paired("stage-1:3", VIEW());
          const ui = renderIsland(RoundFocus, props(r, { onFrozen }));
          block(ui).on.ask();
          block(ui).on.open();
          return { ui, r };
        },
      ],
      [
        "resend",
        (onFrozen) => {
          const r = checkinFixture().r;
          const ui = renderIsland(RoundFocus, props(r, { onFrozen }));
          waiting(ui).openRound.resend("c-1");
          return { ui, r };
        },
      ],
      [
        "a board's +5",
        (onFrozen) => {
          const r = checkinFixture().r;
          const ui = renderIsland(RoundFocus, props(r, { onFrozen }));
          waiting(ui).on.extendBoard("c-2");
          return { ui, r };
        },
      ],
      [
        "the round's +5",
        (onFrozen) => {
          const r = checkinFixture().r;
          const ui = renderIsland(RoundFocus, props(r, { onFrozen }));
          const hero = ui.tree().find((e) => propsOf(e).roundExtend !== undefined)!;
          (propsOf(propsOf(hero).roundExtend as ReactElement).onExtend as () => void)();
          return { ui, r };
        },
      ],
    ];
    for (const [name, start] of flows) {
      net.calls.length = 0;
      const onFrozen = vi.fn();
      const { ui, r } = start(onFrozen);
      expect(net.calls, `${name}: one request is out`).toHaveLength(1);
      expect(onFrozen, `${name}: nothing is reported before the answer`).not.toHaveBeenCalled();
      net.calls[0]!.reject(frozen402());
      await flush();
      expect(onFrozen, `${name}: the 402 is reported`).toHaveBeenCalledTimes(1);
      // a poll hands the panel a NEW row object with the same key: the answer still stands, and the shell is not told twice
      ui.rerender(props({ ...r }, { onFrozen }));
      await flush();
      expect(onFrozen, `${name}: a poll's new row object does not report it again`).toHaveBeenCalledTimes(1);
    }
    expect(flows.length, "anti-vacuity: four presses").toBe(4);
  });

  it("an answer that is not the freeze reports nothing: a success, an unreadable failure, and Pair next's 402 (a plan limit, MD-R32)", async () => {
    const reported = vi.fn();
    const ui = renderIsland(RoundFocus, props(paired("stage-1:3", VIEW()), { onFrozen: reported }));
    block(ui).on.ask();
    block(ui).on.open();
    net.calls[0]!.resolve({ opened: true, invited: 2, retrying: 0, skipped: [] });
    await flush();
    const other = renderIsland(RoundFocus, props(checkinFixture().r, { onFrozen: reported }));
    waiting(other).on.extendBoard("c-1");
    net.calls[1]!.reject(new Error("network"));
    await flush();
    const over = renderIsland(RoundFocus, props(overRound("stage-1:3", { pair_next_round: 4 }), { onFrozen: reported }));
    const pairEl = over.tree().find((e) => typeof propsOf(e).onPair === "function")!;
    (propsOf(pairEl).onPair as (round: number) => void)(4);
    net.calls[2]!.reject(frozen402());
    await flush();
    expect(net.calls, "anti-vacuity: all three answers were driven").toHaveLength(3);
    expect(reported).not.toHaveBeenCalled();
  });
});

describe("RoundFocus: M1 - the window's closed sentence is said of the BOARD whose own window ran out, unless the press restarts the window for everyone (B5)", () => {
  // The server's two branches (open-round.ts): a RE-OPEN ("reopen": nobody is bound to the open) starts the window again for every board, so no
  // board is "past its time" beside that press; a RE-INVITE ("reinvite": some board still plays inside the running window) invites only the
  // boards whose OWN batch window has not closed and answers `window_closed` for the rest (`closedSkips`). The sentence follows the board.
  const closed = { ...openWindow(), canExtend: false, refusal: "closed" as const, deadlineAt: iso(NOW - 60_000) };
  const heldBoard = (fixtureId: string, boardNo: number, checkin: typeof closed | ReturnType<typeof openWindow>) => {
    const b = withState({ kind: "on_hold" }, { fixtureId, boardNo, checkin });
    (b as { hold_reason?: string }).hold_reason = "lichess_unlinked";
    return b;
  };
  const heldRow = (press: OpenRoundView["press"]) =>
    round("stage-1:3", "playing", arbiterRound([live(), heldBoard("h-1", 7, closed)]), { view: VIEW({ state: "open", press, pairings: [P(1), P(7, { fixtureId: "h-1" })] }) });
  /** Two boards held for a link in one round: board 7's own window has run out, board 8's still runs. */
  const twoHeldRow = (press: OpenRoundView["press"]) =>
    round("stage-1:3", "playing", arbiterRound([live(), heldBoard("h-1", 7, closed), heldBoard("h-2", 8, openWindow())]), {
      view: VIEW({ state: "open", press, pairings: [P(1), P(7, { fixtureId: "h-1" }), P(8, { fixtureId: "h-2" })] }),
    });
  const blockOf = (h: string, fixtureId: string) => {
    const at = h.indexOf(`data-fixture-id="${fixtureId}"`);
    expect(at, `${fixtureId} is in the block`).toBeGreaterThan(-1);
    const from = h.lastIndexOf("<li", at);
    return h.slice(from, h.indexOf("</li>", at) + 5);
  };

  it("no press (server none, or a reader who may not press): the sentence is said; a RE-OPEN offered: it is not (the window starts again for everyone)", () => {
    const sentence = en[OPEN_ROUND_SKIP_KEYS.window_closed]!;
    const none = html(heldRow("none"));
    expect(textIn(none, "md-round-linkhold-closed")).toBe(sentence);
    expect(count(none, "md-round-reopen-cta")).toBe(0);
    const h = html(heldRow("reopen"));
    expect(tagOf(h, "md-round-linkhold-board"), "reopen").toContain('data-window-closed="true"');
    expect(count(h, "md-round-linkhold-closed"), "reopen: the sentence would contradict the press").toBe(0);
    expect(count(h, "md-round-reopen-cta"), "reopen: positive pair, the press is offered").toBe(1);
    // a reader who may not press (frozen) is offered no press, so the sentence is what tells them why the board waits
    const frozen = html(heldRow("reopen"), { reader: FROZEN });
    expect(count(frozen, "md-round-reopen-cta"), "frozen: no press").toBe(0);
    expect(textIn(frozen, "md-round-linkhold-closed"), "frozen: no press, so the sentence stays").toBe(sentence);
  });

  it("a RE-INVITE offered: the press cannot invite a board whose own window has closed, so THAT board says so and the board whose window runs does not", () => {
    const sentence = en[OPEN_ROUND_SKIP_KEYS.window_closed]!;
    const h = html(twoHeldRow("reinvite"));
    expect(count(h, "md-round-reopen-cta"), "the press is offered").toBe(1);
    const a = blockOf(h, "h-1");
    const b = blockOf(h, "h-2");
    expect(a, "board 7: its own window has closed").toContain('data-window-closed="true"');
    expect(textIn(a, "md-round-linkhold-closed"), "board 7 is told it cannot be invited, press or no press").toBe(sentence);
    expect(b, "board 8: its window still runs").toContain('data-window-closed="false"');
    expect(count(b, "md-round-linkhold-closed"), "board 8 is not").toBe(0);
    expect(count(h, "md-round-linkhold-closed"), "exactly one sentence in the block").toBe(1);
    // and the same two boards beside a RE-OPEN: the window starts again for both, so neither is told it has passed
    const reopen = html(twoHeldRow("reopen"));
    expect(count(reopen, "md-round-reopen-cta")).toBe(1);
    expect(count(reopen, "md-round-linkhold-closed"), "reopen: nobody is past their time").toBe(0);
    expect(count(reopen, "md-round-linkhold-board"), "anti-vacuity: both boards are in the block").toBe(2);
  });
});

describe("RoundFocus: M3 - 'Open round N again' says the same thing in its dialog and stands beside its reason", () => {
  const linkRow = (phase: "checkin" | "playing") => {
    const b = withState({ kind: "on_hold" }, { fixtureId: "h-1", boardNo: 4, checkin: openWindow(), flagCount: 0 });
    (b as { hold_reason?: string }).hold_reason = "lichess_unlinked";
    const view = VIEW({ state: "open", press: "reopen", pairings: [P(1, { fixtureId: "c-1" }), P(4, { fixtureId: "h-1" })] });
    const boards = phase === "checkin" ? [board({ fixtureId: "c-1", boardNo: 1, seats: { white: here, black: away } }), b] : [live(5, { fixtureId: "c-1", boardNo: 1 }), b];
    return round("stage-1:3", phase, arbiterRound(boards), { view });
  };
  /** The round press's confirmation: in the playing phase it is a child of the status; in check-in it is a part of the `press` prop. */
  const dialogOf = (r: MatchDayOnlineRound) => {
    const ui = renderIsland(RoundFocus, props(r));
    const tree = ui.tree();
    const direct = tree.find((e) => propsOf(e).testId === "arbiter-column-reinvite-dialog");
    if (direct !== undefined) return propsOf(direct) as unknown as { title: string; confirmLabel: string };
    const holder = tree.find((e) => propsOf(e).press !== undefined)!;
    return propsOf((propsOf(holder).press as { dialog: ReactElement }).dialog) as unknown as { title: string; confirmLabel: string };
  };

  it("the dialog is titled and confirmed with the press's own words, in both phases; a plain reinvite and a plain reopen keep the run sheet's", () => {
    for (const phase of ["checkin", "playing"] as const) {
      const d = dialogOf(linkRow(phase));
      expect(d.title, phase).toBe(t("matchDay.round.openAgainTitle", { round: 3 }));
      expect(d.confirmLabel, phase).toBe(t("matchDay.round.openAgain", { round: 3 }));
    }
    // no link hold: the other two branches are as they were (the negatives need their positive pair)
    const owed = [P(1, { owedSeats: 2 }), P(2, { owedSeats: 2 })];
    const reinvite = dialogOf(round("stage-1:3", "playing", arbiterRound([live(), live(9)]), { view: VIEW({ state: "open", press: "reinvite", pairings: owed }) }));
    expect(reinvite.title).toBe(t("runsheet.round.confirmTitleReinvite", { round: 3 }));
    expect(reinvite.confirmLabel).toBe(pl("runsheet.round.inviteCta", 4));
    const reopen = dialogOf(round("stage-1:3", "playing", arbiterRound([live(), live(9)]), { view: VIEW({ state: "open", press: "reopen", pairings: owed }) }));
    expect(reopen.title).toBe(t("arbiter.column.reopenConfirmTitle", { round: 3 }));
    expect(reopen.confirmLabel).toBe(pl("arbiter.column.reopenConfirmCta", 4));
  });

  it("the press stands INSIDE the link-hold block, not in the hero or the status; with no hold it is where it was", () => {
    for (const phase of ["checkin", "playing"] as const) {
      const h = html(linkRow(phase));
      expect(count(innerOf(h, "md-round-linkhold")!, "md-round-reopen-cta"), `${phase}: beside the reasons`).toBe(1);
      expect(count(h, "md-round-reopen-cta"), `${phase}: exactly one`).toBe(1);
      const home = innerOf(h, phase === "checkin" ? "arbiter-checkin-hero" : "arbiter-column-status")!;
      expect(count(home, "md-round-reopen-cta"), `${phase}: not also up in the ${phase === "checkin" ? "hero" : "status"}`).toBe(0);
    }
    const reinvite = html(round("stage-1:3", "checkin", arbiterRound([board({ fixtureId: "c-1", boardNo: 1 })]), { view: VIEW({ state: "open", press: "reinvite", pairings: [P(1, { fixtureId: "c-1" })] }) }));
    expect(count(innerOf(reinvite, "arbiter-checkin-hero")!, "arbiter-column-reinvite"), "no hold: the hero's own press").toBe(1);
    expect(count(reinvite, "md-round-linkhold")).toBe(0);
  });
});

describe("RoundFocus: M5 - one card after Pair next round, a full-width press, and no unprompted 'can't extend' line", () => {
  const over = () => overRound("stage-1:3", { pair_next_round: 4 });
  const nextRow = () => paired("stage-1:4", VIEW({ roundNo: 4 }), { round_no: 4 });
  const pairEl = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => ui.tree().find((e) => typeof propsOf(e).onPair === "function")!;
  const readyEl = (ui: ReturnType<typeof renderIsland<RoundFocusProps>>) => ui.tree().find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === "ReadyLine");

  it("right after the pair answers, ONE card says the round is paired and carries the go-to press; reloaded, the ready line is the card", async () => {
    const onOpenRound = vi.fn();
    const next = nextRow();
    // reloaded (no answer standing) with round 4 paired: the ready line, and no pair card at all
    const reloaded = renderIsland(RoundFocus, props({ ...over(), pair_next_round: null }, { next, onOpenRound }));
    expect(readyEl(reloaded), "reloaded: the ready line is drawn").toBeDefined();
    expect(underEnglish(pairEl(reloaded)), "an empty pair block").toBe("");
    // the real sequence: round 3 is over and round 4 is not paired (no next row); the press pairs it; the poll then brings round 4 as the next row
    const ui = renderIsland(RoundFocus, props(over(), { next: null, onOpenRound }));
    expect(readyEl(ui), "before the press there is no next round to be ready").toBeUndefined();
    (propsOf(pairEl(ui)).onPair as (round: number) => void)(4);
    net.calls[0]!.resolve({ created: 2, existing: 0, swiss_paired_round: 4 });
    await flush();
    ui.rerender(props({ ...over(), pair_next_round: null }, { next, onOpenRound }));
    expect(readyEl(ui), "after the answer: no second card").toBeUndefined();
    const card = underEnglish(pairEl(ui));
    expect(textIn(card, "md-round-pair-notice")).toContain(t("matchDay.round.pairedNotice", { round: 4 }));
    expect(textIn(card, "md-round-ready-go"), "the go-to press is in the same card").toBe(t("matchDay.round.readyGo", { round: 4 }));
    expect(count(card, "md-round-ready"), "and it is not a ready card").toBe(0);
    (propsOf(pairEl(ui)).go as { onOpenRound(key: string): void; next: MatchDayOnlineRound }).onOpenRound("stage-1:4");
    expect(onOpenRound).toHaveBeenCalledWith("stage-1:4");
    // the answer is about round 4: a next row for any OTHER round does not borrow it (the ready line stays, the card has no go-to press)
    const other = renderIsland(RoundFocus, props(over(), { next: null }));
    (propsOf(pairEl(other)).onPair as (round: number) => void)(4);
    net.calls[1]!.resolve({ created: 2, existing: 0, swiss_paired_round: 4 });
    await flush();
    other.rerender(props({ ...over(), pair_next_round: null }, { next: paired("stage-1:6", VIEW({ roundNo: 6 }), { round_no: 6 }) }));
    expect(readyEl(other), "another round's ready line stays").toBeDefined();
    expect(count(underEnglish(pairEl(other)), "md-round-ready-go"), "and the paired card has no go-to press for it").toBe(0);
    // a reader who may not press sees the answer and no go-to press, in the card
    const frozen = renderIsland(RoundFocus, props(over(), { next: null, reader: EDITOR }));
    (propsOf(pairEl(frozen)).onPair as (round: number) => void)(4);
    net.calls[2]!.resolve({ created: 2, existing: 0, swiss_paired_round: 4 });
    await flush();
    frozen.rerender(props({ ...over(), pair_next_round: null }, { next, reader: FROZEN }));
    expect(count(underEnglish(pairEl(frozen)), "md-round-ready-go"), "frozen: no press").toBe(0);
    expect(textIn(underEnglish(pairEl(frozen)), "md-round-pair-notice"), "the answer is still said").toContain(t("matchDay.round.pairedNotice", { round: 4 }));
  });

  it("Pair next round is a block-width press like Open round (no `items-start` shrinking it), under the reader's own width rules", () => {
    const h = html(over());
    expect(tagOf(h, "md-round-pair")).not.toMatch(/items-start/);
    expect(tagOf(h, "md-round-pair-next")).toMatch(/\bw-full\b/);
    // the Open round block, the one it is made to match, has the same shape: a stretch column and a w-full press
    const open = html(paired("stage-1:3", VIEW()));
    expect(tagOf(open, "arbiter-column-open")).not.toMatch(/items-start/);
    expect(tagOf(open, "md-round-open-cta")).toMatch(/\bw-full\b/);
  });

  it("a closed check-in prints no 'Can't extend check-in' line of its own; an open one still has its press", () => {
    const closedWindow = { ...openWindow(), canExtend: false, refusal: "closed" as const, deadlineAt: iso(NOW - 60_000) };
    const closed = round("stage-1:3", "checkin", arbiterRound([board({ fixtureId: "c-1", boardNo: 1, checkin: closedWindow })], { extendableBoards: 0 }), {
      view: VIEW({ state: "open", press: "none", pairings: [P(1, { fixtureId: "c-1" })] }),
    });
    const h = html(closed);
    expect(count(h, "arbiter-extend-round-why"), "no unprompted reason").toBe(0);
    expect(Object.keys(RETIRED_EXTEND_REASONS).length + RETIRED_EXTEND_REASON_LEADS.length, "anti-vacuity: seven probes").toBe(7);
    for (const words of [...Object.values(RETIRED_EXTEND_REASONS), ...RETIRED_EXTEND_REASON_LEADS]) expect(h, `and none of the reasons' words anywhere ("${words}")`).not.toContain(esc(words));
    expect(count(h, "arbiter-extend-round-cta"), "nothing to press on a closed round").toBe(0);
    expect(count(html(checkinFixture().r), "arbiter-extend-round-cta"), "positive pair: an open round still has its +5").toBe(1);
  });
});

// ---- Online Chess credits: an Open on an UNPAID package (spec 2026-11-23-online-chess-credits-design.md §7.6, §8.4; plan Task 12) ------------------------
// The press is the panel's own `useOpenRoundWith`; the 402 it answers with stands the receipt up over the panel on the division the ROW names, its confirm
// is the open again with `pay`, and the round's notice - not the receipt - says what came of it. Driven through the real chain with the network doubled.
describe("RoundFocus: an unpaid package stands the pay-and-open receipt up", () => {
  const paidCtx = { ...ctx, viewerPlan: "pro", currency: "eur" } as unknown as MatchDayCtx;
  const QUOTE = quoteOf({ size: 64, held: 41, rounds: 5, cameras: true });
  const unpaid = () => new ApiV1Error("Pay first", 402, ONLINE_PACKAGE_CODES.unpaid, { quote: QUOTE, next: null } as unknown as Record<string, unknown>);
  type Block = { on: { ask(): void; open(): void }; state: { pay: unknown; notice: { kind: string; result?: OpenRoundResult } | null; busy: unknown } };
  const mount = (o: Partial<RoundFocusProps> = {}) => {
    const ui = renderIsland(RoundFocus, props(paired("stage-1:3", VIEW()), { ctx: paidCtx, ...o }));
    const block = () => propsOf(ui.tree().find((e) => e.type === OpenRoundBlockView)!) as unknown as Block;
    const receipt = () => ui.tree().find((e) => e.type === OpenPayReceipt);
    const receiptProps = () => propsOf(receipt()!) as unknown as { ask: { quote: unknown; next: unknown }; divisionId: string; viewerPlan: string; buy: unknown; buyMoreHref: string; onPay(b: unknown): Promise<void>; onClose(): void };
    return { ui, block, receipt, receiptProps };
  };
  const openAndAskToPay = async (m: ReturnType<typeof mount>) => {
    m.block().on.ask();
    m.block().on.open();
    net.calls[0]!.reject(unpaid());
    await flush();
  };

  it("the empty case first: no receipt until an open is answered unpaid, and the press is the ordinary open", () => {
    const m = mount();
    expect(m.receipt()).toBeUndefined();
    m.block().on.ask();
    expect(m.receipt(), "a confirmation is not a receipt").toBeUndefined();
    m.block().on.open();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/stage-1/open-round", { roundNo: 3 }]]);
  });

  it("the 402 stands the receipt up with the server's quote, the ROW's division, the plan, the currency and the credits page; no notice, nothing refreshed", async () => {
    const onChanged = vi.fn();
    const m = mount({ onChanged });
    await openAndAskToPay(m);
    expect(m.receiptProps()).toMatchObject({
      ask: { quote: QUOTE, next: null },
      divisionId: "div-chess",
      viewerPlan: "pro",
      buy: { orgId: "org-1", currency: "eur" },
      buyMoreHref: "/o/club/settings/credits?kind=stream",
    });
    expect(m.block().state.notice, "an unpaid answer is not a failure").toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("with no currency from the page the chooser is the credits link (buy null), never a chooser that would charge in a guessed currency", async () => {
    const m = mount({ ctx: { ...paidCtx, currency: undefined } as MatchDayCtx });
    await openAndAskToPay(m);
    expect(m.receiptProps().buy).toBeNull();
    net.calls.length = 0;
    const noOrg = mount({ ctx: { ...paidCtx, orgId: undefined } as MatchDayCtx });
    await openAndAskToPay(noOrg);
    expect(noOrg.receiptProps().buy).toBeNull();
  });

  it("the receipt's confirm is the open AGAIN with the pay body; the answer closes the receipt and the notice names the payment ONLY because it was applied", async () => {
    const onChanged = vi.fn();
    const m = mount({ onChanged });
    await openAndAskToPay(m);
    const body = { size: 64, expectedOwed: 8 };
    const done = m.receiptProps().onPay(body);
    expect(net.calls[1]!.json).toEqual({ roundNo: 3, pay: body });
    const applied: OpenRoundResult = { opened: true, invited: 6, retrying: 0, skipped: [], payment: { applied: true, credits: 8, size: 64, capacityLoweredTo: null } };
    net.calls[1]!.resolve(applied);
    await done;
    await flush();
    expect(m.receipt(), "answered: the receipt is gone").toBeUndefined();
    const notice = m.block().state.notice!;
    expect(notice).toEqual({ kind: "answered", result: applied });
    const lines = openNoticeText(notice as never, VIEW(), ((k: string, v?: Record<string, string | number>) => t(k, v)) as never, ((k: string, n: number, v?: Record<string, string | number>) => pl(k, n, v)) as never);
    expect(lines[0]).toBe(pl("onlineChess.openRound.paid", 8, { round: 3 }));
    expect(onChanged, "the day is re-read once").toHaveBeenCalledTimes(1);
  });

  it("a round that still does not open after the pay shows the round's OWN reason and no payment line (the pay is not claimed)", async () => {
    const m = mount();
    await openAndAskToPay(m);
    const done = m.receiptProps().onPay({ size: 64, expectedOwed: 8 });
    net.calls[1]!.resolve({ opened: false, reason: "not_paired" } satisfies OpenRoundResult);
    await done;
    await flush();
    expect(m.receipt()).toBeUndefined();
    const lines = openNoticeText(m.block().state.notice as never, VIEW(), ((k: string, v?: Record<string, string | number>) => t(k, v)) as never, ((k: string, n: number, v?: Record<string, string | number>) => pl(k, n, v)) as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/Paid/);
  });

  it("a refused pay (409 changed) leaves the receipt standing for it to redraw: it rejects to the receipt, no notice, no refresh; the next confirm is sent", async () => {
    const onChanged = vi.fn();
    const m = mount({ onChanged });
    await openAndAskToPay(m);
    const changed = new ApiV1Error("Changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, { quote: QUOTE } as unknown as Record<string, unknown>);
    const first = m.receiptProps().onPay({ size: 64, expectedOwed: 8 });
    net.calls[1]!.reject(changed);
    await expect(first).rejects.toBe(changed);
    await flush();
    expect(m.receipt(), "still standing").toBeDefined();
    expect(m.block().state.notice).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    void m.receiptProps().onPay({ size: 64, expectedOwed: 7 });
    expect(net.calls[2]!.json).toEqual({ roundNo: 3, pay: { size: 64, expectedOwed: 7 } });
  });

  it("Close takes the receipt away and sends nothing; the same open can be pressed again and asks again", async () => {
    const m = mount();
    await openAndAskToPay(m);
    m.receiptProps().onClose();
    expect(m.receipt()).toBeUndefined();
    expect(net.calls, "nothing since the open").toHaveLength(1);
    m.block().on.ask();
    m.block().on.open();
    expect(net.calls).toHaveLength(2);
    net.calls[1]!.reject(unpaid());
    await flush();
    expect(m.receipt()).toBeDefined();
  });

  it("the round on screen changing takes the receipt with it: a receipt for round 3 is never confirmed for round 4", async () => {
    const m = mount();
    await openAndAskToPay(m);
    m.ui.rerender(props(paired("stage-1:4", VIEW({ roundNo: 4 }), { round_no: 4 }), { ctx: paidCtx }));
    expect(m.receipt()).toBeUndefined();
  });
});

