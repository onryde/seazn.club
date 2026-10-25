// Task 16 sign-off fixes for the Arbiter Panel's round column (phase 2). Each describe is one defect from the screenshot sign-off
// (task-16-signoff.md "Defects seen"), driven through the real components the way the earlier suites do: `renderToStaticMarkup`
// for what a person reads (every word out of the English dictionary, never typed here) and the hook harness where a binding or a
// re-render is the point. The expected values are the controller's rulings (task-16-fix-brief.md) or the dictionary, never read back
// from the code under test.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import { emptyExtendTally, type CheckinExtendState } from "@/lib/checkin-extend";
import type { Dict } from "@/lib/i18n-constants";
import { messages } from "@/lib/messages";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import type { SeatInviteWord } from "@/lib/invite-status";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { initialOpenRoundUi } from "../../desk/open-round-state";
import type { OpenRoundHandle } from "../../desk/use-open-round";
import { RoundColumn, type RoundColumnData, type RoundColumnProps } from "../round-column";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const en = messages as unknown as Record<string, string>;
const TZ = "Europe/London";
const SLUGS = { org: "club", comp: "autumn", div: "open" };
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const pl = (key: string, n: number, vars: Record<string, string | number> = {}) =>
  Object.entries({ count: n, ...vars }).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[`${key}.${n === 1 ? "one" : "other"}`]!);
/** React escapes text; compare against the escaped form. */
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// ---- fixtures ---------------------------------------------------------------------------------------------------

const win = (from: number, to: number): CheckinExtendState => ({ canExtend: true, refusal: null, extensionsLeft: 3, opensAt: iso(NOW + from), deadlineAt: iso(NOW + to) });
const OPEN = () => win(-10 * MIN, 8 * MIN);
const seat = (here: boolean, invites: SeatInviteWord[] = []) => ({ here, invites });

let nextBoard = 0;
function board(o: Partial<ArbiterBoard> = {}): ArbiterBoard {
  nextBoard += 1;
  return {
    fixtureId: `fx-${nextBoard}`,
    fixtureNo: nextBoard,
    boardNo: nextBoard,
    white: { name: `Wendy ${nextBoard}`, personId: null },
    black: { name: `Blake ${nextBoard}`, personId: null },
    state: { kind: "checking_in" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: { state: "none", endedAt: null, evidenceAt: null }, away: { state: "none", endedAt: null, evidenceAt: null } },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    ...o,
  };
}
const checking = (white: ReturnType<typeof seat>, black: ReturnType<typeof seat>, o: Partial<ArbiterBoard> = {}) =>
  board({ state: { kind: "checking_in" }, checkin: OPEN(), seats: { white, black }, ...o });
const live = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "live", moveNo: 3 }, ...o });
const over = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "result", score: "1-0", noResult: false }, ...o });
const onHold = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "on_hold" }, ...o });
const ROUND = (boards: ArbiterBoard[], o: Partial<ArbiterRound> = {}): ArbiterRound => ({
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 1,
  timeControl: null,
  boards,
  ownBoards: 0,
  current: true,
  extendableBoards: 0,
  ...o,
});

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
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 1,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: DEADLINE_AFTER_MS / 60_000,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: "2026-10-16T19:00:00.000Z",
  press: "open",
  earlierInPlay: [],
  pairings: [P(1), P(2), P(3)],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...o,
});
const DATA = (o: Partial<RoundColumnData> = {}): RoundColumnData => ({ views: [], held: [], flagged: [], ownFlagged: 0, tz: TZ, awaitsStart: false, ...o });

const handle = (): OpenRoundHandle => ({ state: initialOpenRoundUi(), ask: vi.fn(), cancel: vi.fn(), open: vi.fn(), resend: vi.fn() });
const COLUMN = (o: Partial<RoundColumnProps> = {}): RoundColumnProps => ({
  round: null,
  requested: null,
  data: DATA(),
  nowMs: NOW,
  slugs: SLUGS,
  openRound: handle(),
  on: { select: () => {}, extendBoard: () => {} },
  roundExtend: null,
  placement: "grid",
  ...o,
});
const underEnglish = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={enUi as unknown as Dict} locale="en">{node}</DictProvider>);
const column = (o: Partial<RoundColumnProps> = {}) => underEnglish(<RoundColumn {...COLUMN(o)} />);

// ---- markup probes ----------------------------------------------------------------------------------------------

const ATTR = (testid: string) => `data-testid="${testid}"`;
const count = (h: string, testid: string) => h.split(ATTR(testid)).length - 1;
/** The inner markup of the first element whose opening tag contains `attr` (balanced on its own tag name). */
function innerAttr(h: string, attr: string): string | null {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*${attr}[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  const from = open.index + open[0].length;
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(h); m; m = re.exec(h)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index);
  }
  throw new Error(`unbalanced <${open[1]}> for ${attr}`);
}
const textIn = (h: string, testid: string): string | null => {
  const i = innerAttr(h, ATTR(testid));
  return i === null ? null : i.replace(/<[^>]*>/g, "");
};

// ======================================================================================================================
// D7: the round card's tally says where EVERY board is. "2 of 4 boards playing / 1 board finished" left the fourth (held) board
// unaccounted for; a plain "N on hold" line names it, only when there is one.
// ======================================================================================================================

describe("D7: the playing card counts the held boards (the tally adds up)", () => {
  const playingCard = (boards: ArbiterBoard[]) => column({ round: ROUND(boards, { roundNo: 1 }) });

  it("the sign-off's own round: 2 of 4 playing, 1 finished, 1 on hold - the fourth board is named", () => {
    const h = playingCard([live(), live(), over(), onHold()]);
    expect(textIn(h, "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 4, { count: 2, total: 4 })));
    expect(textIn(h, "arbiter-column-finished")).toBe(esc(pl("arbiter.column.finished", 1)));
    expect(textIn(h, "arbiter-column-onhold")).toBe(esc(pl("arbiter.column.onHold", 1)));
  });

  it("zero held: no line at all (an empty cell is not information), and not its words either", () => {
    const h = playingCard([live(), live(), over()]);
    expect(h).not.toContain(ATTR("arbiter-column-onhold"));
    expect(h).not.toContain(en["arbiter.column.onHold.one"]!.replace("{count} ", ""));
  });

  it("one and two held: the singular and the plural of the line, counted from the boards", () => {
    const one = playingCard([live(), onHold()]);
    const two = playingCard([onHold(), live(), onHold()]);
    expect(textIn(one, "arbiter-column-onhold")).toBe(esc(pl("arbiter.column.onHold", 1)));
    expect(textIn(two, "arbiter-column-onhold")).toBe(esc(pl("arbiter.column.onHold", 2)));
    expect(pl("arbiter.column.onHold", 1), "anti-vacuity: the two forms differ").not.toBe(pl("arbiter.column.onHold", 2));
  });

  it("a card with held boards and nothing finished still shows the line (the finished clause's gate does not hide it)", () => {
    const h = playingCard([live(), onHold()]);
    expect(h).not.toContain(ATTR("arbiter-column-finished"));
    expect(textIn(h, "arbiter-column-onhold")).toBe(esc(pl("arbiter.column.onHold", 1)));
  });

  it("every board held: the card says '0 of 2 boards playing' and '2 boards on hold'", () => {
    const h = playingCard([onHold(), onHold()]);
    expect(textIn(h, "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 2, { count: 0, total: 2 })));
    expect(textIn(h, "arbiter-column-onhold")).toBe(esc(pl("arbiter.column.onHold", 2)));
  });

  it("a round with no board on screen prints no count at all, held line included", () => {
    const h = column({ round: ROUND([], { ownBoards: 4 }) });
    expect(h).toContain('data-phase="playing"');
    expect(h).not.toContain(ATTR("arbiter-column-onhold"));
  });

  it("the line sits with the other counts, inside one group, after the playing line (no stray wrapper)", () => {
    const h = playingCard([live(), over(), onHold()]);
    const status = innerAttr(h, ATTR("arbiter-column-status"))!;
    const order = ["arbiter-column-playing", "arbiter-column-finished", "arbiter-column-onhold"].map((id) => status.indexOf(ATTR(id)));
    expect(order.every((i) => i >= 0), "all three lines are present").toBe(true);
    expect(order, "playing, then finished, then on hold").toEqual([...order].sort((a, b) => a - b));
    expect(status).not.toMatch(/<div class="[^"]*"><\/div>/);
  });
});

describe("D7: the check-in hero counts them too (same gap, same predicate)", () => {
  const hero = (boards: ArbiterBoard[]) => column({ round: ROUND(boards) });

  it("a board held while others still check in: the hero names it", () => {
    const h = hero([checking(seat(true), seat(false)), live(), onHold(), onHold()]);
    expect(h).toContain('data-phase="checkin"');
    expect(textIn(h, "arbiter-checkin-onhold")).toBe(esc(pl("arbiter.column.onHold", 2)));
    expect(textIn(h, "arbiter-checkin-playing")).toBe(esc(pl("arbiter.column.alreadyPlaying", 1)));
  });

  it("zero held: no line (and one held is the singular)", () => {
    expect(hero([checking(seat(true), seat(false)), live()])).not.toContain(ATTR("arbiter-checkin-onhold"));
    expect(textIn(hero([checking(seat(true), seat(false)), onHold()]), "arbiter-checkin-onhold")).toBe(esc(pl("arbiter.column.onHold", 1)));
  });

  it("held alone, with nothing playing or finished, still opens the group", () => {
    const h = hero([checking(seat(false), seat(false)), onHold()]);
    expect(h).not.toContain(ATTR("arbiter-checkin-playing"));
    expect(h).not.toContain(ATTR("arbiter-checkin-finished"));
    expect(count(h, "arbiter-checkin-onhold")).toBe(1);
  });
});
