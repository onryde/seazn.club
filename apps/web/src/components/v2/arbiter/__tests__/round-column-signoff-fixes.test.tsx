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
import { initialOpenRoundUi, type OpenRoundUiState } from "../../desk/open-round-state";
import type { OpenRoundHandle } from "../../desk/use-open-round";
import { CheckinHero, OpenRoundBlockView, RoundColumn, WaitingList, type CheckinHeroProps, type RoundColumnData, type RoundColumnProps } from "../round-column";

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
const inner = (h: string, testid: string): string | null => innerAttr(h, ATTR(testid));
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

// ======================================================================================================================
// D2: the reopen / reinvite confirmation worded a seat from the run sheet's stamp line ("Not invited") while the waiting list behind it
// said Not delivered, Bounced or Here for the same seat. One helper (`seatWords`), two readers. Every word is compared across the two
// readers AND against the dictionary key typed here from the sign-off's own list of states, so a wrong word cannot be agreed upon.
// ======================================================================================================================

const textOf = (html: string) => html.replace(/<[^>]*>/g, "");

/** Every state a seat can be shown in, by the dictionary key that words it (typed from the sign-off, not from SEAT_WORD_KEYS). */
const WORD_CASES: { name: string; seat: ReturnType<typeof seat>; key: string }[] = [
  { name: "Sent", seat: seat(false, ["sent"]), key: "arbiter.invite.sent" },
  { name: "Delivered", seat: seat(false, ["delivered"]), key: "arbiter.invite.delivered" },
  { name: "Delayed", seat: seat(false, ["delayed"]), key: "arbiter.invite.delayed" },
  { name: "Bounced", seat: seat(false, ["bounced"]), key: "arbiter.invite.bounced" },
  { name: "Not delivered", seat: seat(false, ["not_delivered"]), key: "arbiter.invite.notDelivered" },
  { name: "Not invited", seat: seat(false, ["not_invited"]), key: "runsheet.round.notInvited" },
  { name: "Here", seat: seat(true, []), key: "arbiter.column.here" },
];
/** Black's seat beside each case: a word that is never the case's own, so a colour mix-up between the two seats shows. */
const otherSeat = (own: string) => (own === "Sent" ? seat(false, ["bounced"]) : seat(false, ["sent"]));

const WL_PROPS = { view: null, openRound: handle(), nowMs: NOW, requestBusy: false, on: { select: () => {}, extendBoard: () => {} } };
const waitingList = (boards: ArbiterBoard[]) =>
  underEnglish(<WaitingList boards={boards} view={WL_PROPS.view} openRound={WL_PROPS.openRound} nowMs={NOW} requestBusy={false} on={WL_PROPS.on} />);

/** The word the WAITING LIST shows for one seat: its invite chips, or the presence "Here". */
function listWord(h: string, fixtureId: string, colour: "white" | "black"): string {
  const row = innerAttr(h, `data-testid="arbiter-waiting-row" data-fixture-id="${fixtureId}"`)!;
  const seatHtml = innerAttr(row, `data-testid="arbiter-seat" data-colour="${colour}"`)!;
  const chips = [...seatHtml.matchAll(/<span\b[^>]*data-testid="arbiter-invite-word"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]!);
  if (chips.length > 0) return chips.join(", ");
  const presence = innerAttr(seatHtml, 'data-field="presence"')!;
  return textOf(presence).trim();
}

/** The word the CONFIRMATION shows for one seat of a board: the part after "White: " in its row. */
function dialogWord(h: string, dialogTestId: string, fixtureId: string, colour: "white" | "black"): string | null {
  const dialog = innerAttr(h, ATTR(dialogTestId));
  if (dialog === null) return null;
  const row = innerAttr(dialog, `data-testid="open-round-invitee-${fixtureId}"`);
  if (row === null) return null;
  const seatHtml = innerAttr(row, `data-seat="${colour}"`);
  if (seatHtml === null) return null;
  const prefix = esc(en[colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"]!) + ": ";
  const text = textOf(seatHtml);
  return text.startsWith(prefix) ? text.slice(prefix.length) : `[no "${prefix}" prefix] ${text}`;
}

function heroDialog(boards: ArbiterBoard[], press: "reopen" | "reinvite", pairings: OpenRoundPairing[], state: Partial<OpenRoundUiState> = { confirming: true }): string {
  const props: CheckinHeroProps = {
    round: ROUND(boards),
    view: VIEW({ state: "open", press, pairings }),
    tz: TZ,
    nowMs: NOW,
    openRound: { ...handle(), state: { ...initialOpenRoundUi(), ...state } },
    roundExtend: null,
  };
  return underEnglish(<CheckinHero {...props} />);
}

describe("D2: the confirmation and the waiting list word a seat the same way", () => {
  it("every state, in the reopen confirmation: the list's word, the dialog's word and the dictionary's word are one", () => {
    let checked = 0;
    for (const c of WORD_CASES) {
      const b = checking(c.seat, otherSeat(c.name));
      // Reopen: nobody holds a stamp, so every seat is owed.
      const dialog = heroDialog([b], "reopen", [P(b.boardNo, { fixtureId: b.fixtureId, owedSeats: 2 })]);
      const list = waitingList([b]);
      const want = esc(en[c.key]!);
      // A board with its white seat Here and the other not is still in the list (one seat is not here).
      expect(listWord(list, b.fixtureId, "white"), `${c.name}: list`).toBe(want);
      expect(dialogWord(dialog, "arbiter-column-reinvite-dialog", b.fixtureId, "white"), `${c.name}: reopen dialog`).toBe(want);
      // The other seat, so a mix-up of colours is caught: Black reads what Black's own seat holds.
      expect(dialogWord(dialog, "arbiter-column-reinvite-dialog", b.fixtureId, "black"), `${c.name}: black in the reopen dialog`).toBe(listWord(list, b.fixtureId, "black"));
      checked += 1;
    }
    expect(checked, "anti-vacuity: seven states").toBe(7);
  });

  it("every state, in the reinvite confirmation (a stamped board with one seat still owed) - the same words", () => {
    let checked = 0;
    for (const c of WORD_CASES) {
      const b = checking(c.seat, otherSeat(c.name));
      const dialog = heroDialog([b], "reinvite", [P(b.boardNo, { fixtureId: b.fixtureId, owedSeats: 1, invitedAt: iso(NOW - 5 * MIN) })]);
      expect(dialogWord(dialog, "arbiter-column-reinvite-dialog", b.fixtureId, "white"), c.name).toBe(esc(en[c.key]!));
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("the sign-off's reopen: seats the list calls Not delivered, Bounced and Here are never called 'Not invited' by the dialog", () => {
    const boards = [
      checking(seat(true), seat(false, ["not_delivered"])),
      checking(seat(false, ["bounced"]), seat(false, ["not_delivered"])),
      checking(seat(false, ["not_delivered"]), seat(false, ["not_delivered"])),
    ];
    const pairings = boards.map((b) => P(b.boardNo, { fixtureId: b.fixtureId, owedSeats: 2 }));
    const dialog = inner(heroDialog(boards, "reopen", pairings), "arbiter-column-reinvite-dialog")!;
    expect(dialog.split('data-testid="open-round-invitee-').length - 1, "premise: three boards listed").toBe(3);
    expect(dialog, "no seat is Not invited, so the word must not appear").not.toContain(esc(en["runsheet.round.notInvited"]!));
    expect(dialog).toContain(esc(en["arbiter.invite.bounced"]!));
    expect(dialog).toContain(esc(en["arbiter.invite.notDelivered"]!));
    expect(dialog).toContain(esc(en["arbiter.column.here"]!));
  });

  it("a seat with two mailboxes names both words, in the list's order; a seat the loader could not read says nothing", () => {
    const b = checking(seat(false, ["sent", "bounced"]), seat(false, []));
    const dialog = heroDialog([b], "reopen", [P(b.boardNo, { fixtureId: b.fixtureId, owedSeats: 2 })]);
    expect(dialogWord(dialog, "arbiter-column-reinvite-dialog", b.fixtureId, "white")).toBe(`${esc(en["arbiter.invite.sent"]!)}, ${esc(en["arbiter.invite.bounced"]!)}`);
    expect(dialogWord(dialog, "arbiter-column-reinvite-dialog", b.fixtureId, "black"), "no readable mail: no word to give").toBeNull();
  });

  it("the guards: a board whose seats are unknown, or that the round does not list, keeps the stamp line (it has nothing better)", () => {
    const unknown = board({ state: { kind: "checking_in" }, checkin: OPEN(), seats: null });
    const dialog = heroDialog([unknown], "reopen", [P(unknown.boardNo, { fixtureId: unknown.fixtureId, owedSeats: 2 }), P(99, { fixtureId: "not-on-screen", owedSeats: 2 })]);
    const rows = inner(dialog, "arbiter-column-reinvite-dialog")!;
    expect(rows.split('data-testid="open-round-invitee-').length - 1, "both pairings are listed").toBe(2);
    expect(rows.split(esc(en["runsheet.round.notInvited"]!)).length - 1, "each says what the stamp says: nobody was invited").toBe(2);
    expect(rows).not.toContain("data-seat=");
  });

  it("the first Open (the before phase) is unchanged: nobody is invited, and its rows still say so", () => {
    const html = underEnglish(
      <OpenRoundBlockView view={VIEW()} state={{ ...initialOpenRoundUi(), confirming: true }} tz={TZ} showStage={false} on={{ ask: () => {}, cancel: () => {}, open: () => {} }} />,
    );
    const dialog = inner(html, "arbiter-column-confirm")!;
    expect(dialog.split(esc(en["runsheet.round.notInvited"]!)).length - 1, "one 'Not invited' per pairing").toBe(3);
    expect(dialog).not.toContain("data-seat=");
  });
});

// ======================================================================================================================
// D3: at 768 the invite chip sat on the name's line on some boards and under it on others, so the rows did not line up. In the
// column the seat is two lines at EVERY width: the colour and the name, then the words (presence and invites) on their own row.
// ======================================================================================================================

describe("D3: a seat's words are on their own row under the name", () => {
  const rowsOf = (boards: ArbiterBoard[]) => waitingList(boards);

  it("every seat has a name line and a words row; the words row holds the presence and every invite chip, the name line holds neither", () => {
    const b = checking(seat(false, ["sent", "bounced"]), seat(true));
    const h = rowsOf([b]);
    let checked = 0;
    for (const colour of ["white", "black"] as const) {
      const seatHtml = innerAttr(h, `data-testid="arbiter-seat" data-colour="${colour}"`)!;
      const words = innerAttr(seatHtml, ATTR("arbiter-seat-words"));
      expect(words, `${colour}: the words row exists`).not.toBeNull();
      expect(words, `${colour}: the presence is in it`).toContain('data-field="presence"');
      const outside = seatHtml.replace(words!, "");
      expect(outside, `${colour}: the name line carries no presence`).not.toContain('data-field="presence"');
      expect(outside, `${colour}: the name line carries no chip`).not.toContain(ATTR("arbiter-invite-word"));
      expect(outside, `${colour}: the name stays on its own line`).toContain('data-field="name"');
      expect(words, `${colour}: the name is not in the words row`).not.toContain('data-field="name"');
      checked += 1;
    }
    expect(checked).toBe(2);
    const white = innerAttr(innerAttr(h, `data-testid="arbiter-seat" data-colour="white"`)!, ATTR("arbiter-seat-words"))!;
    expect((white.match(/data-testid="arbiter-invite-word"/g) ?? []).length, "both invite chips are in the row").toBe(2);
  });

  it("the seat is a column, not a wrapping row: the layout does not depend on the width", () => {
    const b = checking(seat(false, ["delivered"]), seat(false, ["not_delivered"]));
    const h = rowsOf([b]);
    for (const colour of ["white", "black"] as const) {
      const tag = new RegExp(`<li\\b[^>]*data-testid="arbiter-seat" data-colour="${colour}"[^>]*>`).exec(h)![0];
      const cls = /class="([^"]*)"/.exec(tag)![1]!.split(/\s+/);
      expect(cls, colour).toContain("flex-col");
      expect(cls, `${colour}: no wrapping row`).not.toContain("flex-wrap");
      expect(cls, `${colour}: min-w-0 still runs down the chain`).toContain("min-w-0");
    }
    const wordsTag = /<div\b[^>]*data-testid="arbiter-seat-words"[^>]*>/.exec(h)![0];
    const wordsCls = /class="([^"]*)"/.exec(wordsTag)![1]!.split(/\s+/);
    expect(wordsCls, "the chips wrap among themselves").toContain("flex-wrap");
    expect(wordsCls).toContain("min-w-0");
  });

  it("the seat that is here and the seat with no readable mail use the same two-line shape", () => {
    const b = checking(seat(true), seat(false, []));
    const h = rowsOf([b]);
    const here = innerAttr(innerAttr(h, `data-testid="arbiter-seat" data-colour="white"`)!, ATTR("arbiter-seat-words"))!;
    expect(textOf(here)).toContain(esc(en["arbiter.column.here"]!));
    const bare = innerAttr(innerAttr(h, `data-testid="arbiter-seat" data-colour="black"`)!, ATTR("arbiter-seat-words"))!;
    expect(textOf(bare)).toContain(esc(en["arbiter.column.notHereYet"]!));
    expect(bare).not.toContain(ATTR("arbiter-invite-word"));
  });

  it("every seat of every row gets a words row (checked: 4 rows x 2 seats)", () => {
    const boards = [
      checking(seat(false, ["sent"]), seat(false, ["bounced"])),
      checking(seat(true), seat(false, ["not_invited"])),
      checking(seat(false, []), seat(false, ["delayed"])),
      checking(seat(false, ["not_delivered"]), seat(true)),
    ];
    const h = rowsOf(boards);
    expect(h.split(ATTR("arbiter-seat-words")).length - 1).toBe(8);
    expect(h.split(ATTR("arbiter-seat")+" ").length - 1, "premise: eight seats").toBe(8);
  });
});
