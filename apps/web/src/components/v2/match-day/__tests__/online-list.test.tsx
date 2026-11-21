// Match Day online, Task 6 (plan 2026-11-05-match-day-all-in-one.md; spec 2026-11-05-match-day-all-in-one-design.md §5.1 rows, §5.2 order,
// §5.5 boards from earlier rounds; owner pick 2026-11-19: mock Option A, boards are rows): the online block of the list, rendered to markup,
// and the words its rows say. apps/web vitest is `environment: "node"`, so these see what the server paints; the clicks and the phone are
// the shell's driven suite and the e2e.
//
// Where an expected value comes from: the ORDER is spec §5.2 typed key by key (check-in or in progress, then paired, then over); a word
// is the dictionary's own text for the key the spec names (the house words "Board N", "Checking in", "Live · move N", "On hold" are also
// typed as English); the closing time is typed in the venue's zone; the presence marks are typed per seat from the fixture's own
// presence. Never read back from the component or from the rules the component calls.
// Anti-vacuity: every sweep says how many rows or locales it looked at, and zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { OnlineList } from "../online-list";
import { BoardRow } from "../board-row";
import { RoundRow } from "../round-row";
import {
  boardLabel,
  boardName,
  boardWord,
  boardsPlaying,
  earlierRoundChip,
  isOwnRound,
  nameParts,
  needsDecisionHeading,
  onlineRoundMeta,
  onlineRoundTitle,
  presenceText,
  roundWordLines,
  RING_TAIL_MAX,
} from "@/lib/match-day/online-copy";
import { boardRowWord, roundRowWord } from "@/lib/match-day/online";
import {
  NOW,
  arbiterRound,
  board,
  checkinRound,
  done,
  earlier,
  held,
  live,
  openWindow,
  overRound,
  pairedRound,
  playingRound,
  present,
  round,
  withState,
} from "./_online-fixtures";
import type { MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";

const dict = en as Dict;
const DICTS: Record<Locale, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };

// ---- markup readers (every attribute read anchors on `="`: an omitted prop serialises as "$undefined", a bare probe passes both ways) ----

const rowsOf = (html: string, testid: string): string[] => html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>[\\s\\S]*?</button>`, "g")) ?? [];
const attr = (tag: string, name: string): string | null => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const list = (rounds: MatchDayOnlineRound[], o: { selected?: Parameters<typeof OnlineList>[0]["selected"]; d?: Dict; locale?: Locale; nowMs?: number | null } = {}) =>
  renderToStaticMarkup(
    <OnlineList
      rounds={rounds}
      selected={o.selected ?? null}
      dict={o.d ?? dict}
      locale={o.locale ?? "en"}
      nowMs={o.nowMs === undefined ? NOW : o.nowMs}
      onOpenRound={() => {}}
      onOpenBoard={() => {}}
    />,
  );

/** The night the suite reads: a round in check-in with five boards in five states (given OUT of board order), a round paired and not
 *  opened (given FIRST), a finished round. */
function night() {
  const b = (n: number, state: Parameters<typeof withState>[0], over: Partial<ReturnType<typeof board>> = {}) =>
    withState(state, { boardNo: n, fixtureId: `n-${n}`, fixtureNo: n, white: { name: `Wh${n}`, personId: null }, black: { name: `Bl${n}`, personId: null }, ...over });
  const boards = [
    b(3, { kind: "result", score: "1-0", noResult: false }),
    b(1, { kind: "live", moveNo: 23 }, { sides: { home: present(), away: present("off") } }),
    b(5, { kind: "result", score: null, noResult: true }),
    // The one board still checking in: White is here, so the row says "closes 18:08 / 1 of 2 here".
    board({ boardNo: 4, fixtureId: "n-4", fixtureNo: 4, white: { name: "Wh4", personId: null }, black: { name: "Bl4", personId: null }, seats: { white: { here: true, invites: [] }, black: { here: false, invites: [] } }, checkin: openWindow(8) }),
    b(2, { kind: "on_hold" }, { flagCount: 1 }),
  ];
  const inProgress = round("stage-1:3", "checkin", arbiterRound(boards));
  const paired = pairedRound("stage-b:2", { division_id: "div-b", division_name: "Club Blitz", stage_name: "Knockout" });
  const over = overRound("stage-c:1", { division_id: "div-c", division_name: "Veterans" });
  return { inProgress, paired, over, rounds: [paired, over, inProgress] };
}

describe("EMPTY CASE FIRST - no online round, no block", () => {
  it("an empty list renders nothing: no heading, no card, no row", () => {
    expect(list([])).toBe("");
  });
});

describe("the rows, in spec §5.2's order", () => {
  it("rounds are listed check-in or in progress, then paired, then over - whatever order they arrive in - and each round's boards sit under it in BOARD order", () => {
    const n = night();
    const html = list(n.rounds);
    const roundKeys = rowsOf(html, "md-round-row").map((r) => attr(r, "data-key"));
    expect(roundKeys).toEqual(["stage-1:3", "stage-b:2", "stage-c:1"]);
    // The boards of the round in progress (given 3,1,5,4,2) and of the finished round, in the order the page paints all rows.
    const order = [...html.matchAll(/data-testid="md-(round|board)-row"[^>]*?(?:data-key|data-fixture-id)="([^"]*)"/g)].map((m) => m[2]);
    expect(order.slice(0, 6)).toEqual(["stage-1:3", "n-1", "n-2", "n-3", "n-4", "n-5"]);
    expect(order[6]).toBe("stage-b:2");
    expect(order[7]).toBe("stage-c:1");
    expect(rowsOf(html, "md-round-row")).toHaveLength(3);
    // 5 boards of the round in progress + 2 of the finished one; the paired round has none yet.
    expect(rowsOf(html, "md-board-row")).toHaveLength(7);
  });

  it("every row is a court row's grid: a 56px button on the three columns, wrapping its words and never cutting a name", () => {
    const html = list(night().rounds);
    const rows = [...rowsOf(html, "md-round-row"), ...rowsOf(html, "md-board-row")];
    expect(rows.length).toBe(10);
    for (const r of rows) expect(r).toContain("grid min-h-14 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto]");
    // Both players of a board stay readable at 320: the names line wraps (`[overflow-wrap:anywhere]`) and is never `truncate`d.
    for (const r of rowsOf(html, "md-board-row")) {
      expect(r).toContain("[overflow-wrap:anywhere]");
      expect(r).not.toContain("truncate");
    }
  });

  it("a board's words: Board N, White then Black, and the state word on the right (typed, the house words)", () => {
    const html = list([night().inProgress]);
    const byId = Object.fromEntries(rowsOf(html, "md-board-row").map((r) => [attr(r, "data-fixture-id")!, r]));
    expect(Object.keys(byId).sort()).toEqual(["n-1", "n-2", "n-3", "n-4", "n-5"]);
    expect(text(byId["n-1"]!)).toBe("Board 1 Wh1 Present v Bl1 Present, camera off Live · move 23");
    expect(text(byId["n-2"]!)).toContain("On hold 1 report");
    expect(text(byId["n-3"]!)).toContain("1-0");
    expect(text(byId["n-4"]!)).toContain("Checking in");
    expect(text(byId["n-5"]!)).toContain("No result");
    expect(attr(byId["n-1"]!, "data-state")).toBe("live");
    expect(attr(byId["n-2"]!, "data-state")).toBe("on_hold");
    expect(attr(byId["n-3"]!, "data-state")).toBe("result");
    expect(attr(byId["n-4"]!, "data-state")).toBe("checking_in");
  });

  it("a round's words: its name, its stage, time control and boards, and its one-line state (closes 18:08 over 1 of 2 here)", () => {
    const n = night();
    const rows = Object.fromEntries(rowsOf(list(n.rounds), "md-round-row").map((r) => [attr(r, "data-key")!, r]));
    expect(text(rows["stage-1:3"]!)).toBe("Online Rapid · Round 3 Swiss · 10+5 · 5 boards closes 18:08 1 of 2 here");
    expect(attr(rows["stage-1:3"]!, "data-state")).toBe("checkin");
    expect(text(rows["stage-b:2"]!)).toBe("Club Blitz · Round 2 Knockout Paired, not opened");
    expect(attr(rows["stage-b:2"]!, "data-state")).toBe("before");
    expect(text(rows["stage-c:1"]!)).toContain("Veterans · Round 1");
    expect(text(rows["stage-c:1"]!)).toContain("Finished");
    expect(attr(rows["stage-c:1"]!, "data-state")).toBe("playing");
  });

  it("the closing time prints in the VENUE's zone: 18:08Z is 23:38 in Kolkata", () => {
    const html = list([checkinRound("stage-1:3", { tz: "Asia/Kolkata", round: arbiterRound([board({ checkin: openWindow(8) })]) })]);
    expect(text(html)).toContain("closes 23:38");
    expect(text(html)).not.toContain("closes 18:08");
  });

  it("a division with two stages on the page names the stage in the row's name, and not again in its second line", () => {
    const html = list([checkinRound("stage-1:3", { multi_stage: true, division_name: "U18", stage_name: "Swiss" })]);
    const row = rowsOf(html, "md-round-row")[0]!;
    expect(text(row)).toContain("U18 · Swiss · Round 3");
    expect(text(row)).toContain("10+5 · 2 boards");
    expect(text(row)).not.toContain("Swiss 10+5");
  });

  it("a round with no board on screen (every board the viewer's own) says nothing on the right - never '0 of 0 playing'", () => {
    const own = round("stage-1:3", "playing", arbiterRound([], { ownBoards: 2 }), { own_boards: 2 });
    const html = list([own]);
    const row = rowsOf(html, "md-round-row")[0]!;
    expect(row).toContain('data-testid="md-round-row"');
    expect(text(html)).not.toMatch(/0 of 0/);
    expect(html).not.toContain("data-md-round-word");
    // The positive pair: one board playing says "1 of 1 playing".
    const one = list([round("stage-1:3", "playing", arbiterRound([live()]))]);
    expect(text(one)).toContain("1 of 1 playing");
    expect(one).toContain("data-md-round-word");
  });
});

describe("a selected row, and the boards of earlier rounds", () => {
  it("the selected board row, and only it, carries aria-current; so does a selected round row, and only it", () => {
    const n = night();
    const onBoard = list(n.rounds, { selected: { kind: "board", id: "n-4", name: "x" } });
    const current = [...rowsOf(onBoard, "md-board-row"), ...rowsOf(onBoard, "md-round-row")].filter((r) => attr(r, "aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(attr(current[0]!, "data-fixture-id")).toBe("n-4");
    const onRound = list(n.rounds, { selected: { kind: "round", key: "stage-b:2", name: "x" } });
    const roundCurrent = [...rowsOf(onRound, "md-board-row"), ...rowsOf(onRound, "md-round-row")].filter((r) => attr(r, "aria-current") === "true");
    expect(roundCurrent).toHaveLength(1);
    expect(attr(roundCurrent[0]!, "data-key")).toBe("stage-b:2");
    // Nothing selected: nothing is current.
    expect(list(n.rounds)).not.toContain('aria-current="true"');
  });

  it("a board of an EARLIER round sits under its division's round row after the round's own boards, in 'Needs a decision', wearing its round's chip", () => {
    const own = checkinRound("stage-1:3", {
      needs_decision: [earlier(2, { fixtureId: "old-1", boardNo: 5, white: { name: "Hoff", personId: null }, black: { name: "Fern", personId: null } })],
    });
    const html = list([own]);
    const all = [...html.matchAll(/data-testid="(md-round-row|md-board-row|md-board-subgroup)"/g)].map((m) => m[1]);
    // Round row, its two boards, then the sub-group heading, then the earlier board.
    expect(all).toEqual(["md-round-row", "md-board-row", "md-board-row", "md-board-subgroup", "md-board-row"]);
    expect(text(html.slice(html.indexOf('data-testid="md-board-subgroup"')))).toContain("Needs a decision · earlier rounds");
    const rows = rowsOf(html, "md-board-row");
    const old = rows[2]!;
    expect(attr(old, "data-fixture-id")).toBe("old-1");
    // The merged chip: R2, not coded (the board's own fallback), with the full name for a screen reader.
    expect(old).toContain('data-testid="md-round-chip"');
    expect(old).toContain('data-round-code="R2"');
    expect(old).toContain('data-round-coded="false"');
    expect(old).toContain("Round 2");
    expect(text(old)).toContain("Board 5 Hoff");
    // The round's own boards carry no chip.
    expect(rows[0]).not.toContain("md-round-chip");
    expect(rows[1]).not.toContain("md-round-chip");
    // The positive pair: with nothing held in an earlier round the sub-group is absent.
    expect(list([checkinRound("stage-1:3")])).not.toContain("md-board-subgroup");
  });
});

describe("the 'Needs a decision' heading says 'earlier rounds' only when it is true (ruling MD-R25)", () => {
  const sub = (r: MatchDayOnlineRound, d: Dict = dict, locale: Locale = "en") => {
    const html = list([r], { d, locale });
    const at = html.indexOf('data-testid="md-board-subgroup"');
    return at < 0 ? null : text(html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at)));
  };
  const own = (over: Partial<MatchDayBoardRow> = {}) => earlier(3, { fixtureId: "own-1", ...over });

  it("only boards of EARLIER rounds: the suffix; only boards of the LISTED round: the plain heading; a mix: the plain heading", () => {
    expect(sub(checkinRound("stage-1:3", { needs_decision: [earlier(2), earlier(1, { fixtureId: "old-2" })] }))).toBe("Needs a decision · earlier rounds");
    expect(sub(checkinRound("stage-1:3", { needs_decision: [own()] }))).toBe("Needs a decision");
    expect(sub(checkinRound("stage-1:3", { needs_decision: [earlier(2), own()] }))).toBe("Needs a decision");
    expect(sub(checkinRound("stage-1:3", { needs_decision: [own(), earlier(2)] }), dict), "order does not matter").toBe("Needs a decision");
    // Nothing held: no heading at all (the positive pair of the three above).
    expect(sub(checkinRound("stage-1:3"))).toBeNull();
  });

  it("a board of the listed round's NUMBER in another STAGE is not the listed round's: still 'earlier'", () => {
    expect(sub(checkinRound("stage-1:3", { needs_decision: [earlier(3, { stage_id: "stage-0" })] }))).toBe("Needs a decision · earlier rounds");
    expect(isOwnRound(earlier(3), { stage_id: "stage-1", round_no: 3 })).toBe(true);
    expect(isOwnRound(earlier(3, { stage_id: "stage-0" }), { stage_id: "stage-1", round_no: 3 })).toBe(false);
    expect(isOwnRound(earlier(2), { stage_id: "stage-1", round_no: 3 })).toBe(false);
  });

  it("the heading is the locale's own text, and the plain key is not the suffixed one in any locale (4 locales swept)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = DICTS[locale];
      expect(sub(checkinRound("stage-1:3", { needs_decision: [own()] }), d, locale)).toBe(t(d, "matchDay.online.needsDecisionPlain"));
      expect(sub(checkinRound("stage-1:3", { needs_decision: [earlier(2)] }), d, locale)).toBe(t(d, "matchDay.online.needsDecision"));
      expect(t(d, "matchDay.online.needsDecisionPlain")).not.toBe(t(d, "matchDay.online.needsDecision"));
      expect(t(d, "matchDay.online.needsDecision").startsWith(t(d, "matchDay.online.needsDecisionPlain")), `${locale}: the suffixed heading extends the plain one`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
    expect(needsDecisionHeading(dict, { stage_id: "stage-1", round_no: 3, needs_decision: [] })).toBeNull();
  });

  it("the own-round board still wears its round chip and counts in the round row's boards (m1): the row says 6 where it shows 6", () => {
    const r = checkinRound("stage-1:3", { needs_decision: [own({ boardNo: 9 })] });
    const html = list([r]);
    expect(rowsOf(html, "md-board-row").length, "2 listed boards + 1 own-round board under the heading").toBe(3);
    expect(text(rowsOf(html, "md-round-row")[0]!)).toContain("Swiss · 10+5 · 3 boards");
    // An earlier round's board is not THIS round's: the row says 2 although 3 rows sit under it.
    const e = checkinRound("stage-1:3", { needs_decision: [earlier(2)] });
    expect(rowsOf(list([e]), "md-board-row").length).toBe(3);
    expect(text(rowsOf(list([e]), "md-round-row")[0]!)).toContain("Swiss · 10+5 · 2 boards");
  });
});

describe("a player's presence ring stays with the last word of the name (controller finding V1)", () => {
  it("nameParts: the last word is the tail, the rest the head; one word is all tail; a long last word keeps only its last RING_TAIL_MAX characters", () => {
    expect(nameParts("Gus Martin")).toEqual({ head: "Gus ", tail: "Martin" });
    expect(nameParts("Maximiliana Featherstonehaugh-Wolstenh ac48")).toEqual({ head: "Maximiliana Featherstonehaugh-Wolstenh ", tail: "ac48" });
    expect(nameParts("Ana")).toEqual({ head: "", tail: "Ana" });
    expect(nameParts("")).toEqual({ head: "", tail: "" });
    expect(nameParts("Kai Dubois  ")).toEqual({ head: "Kai ", tail: "Dubois" });
    const long = "A".repeat(RING_TAIL_MAX + 9);
    expect(nameParts(`Pia ${long}`)).toEqual({ head: `Pia ${"A".repeat(9)}`, tail: "A".repeat(RING_TAIL_MAX) });
    // The cap is exact: a word of exactly RING_TAIL_MAX is not split.
    expect(nameParts(`Pia ${"B".repeat(RING_TAIL_MAX)}`)).toEqual({ head: "Pia ", tail: "B".repeat(RING_TAIL_MAX) });
    // Code points: an emoji is never cut in half, and head + tail always reads back as the (trimmed) name.
    const emoji = nameParts(`Zo ${"😀".repeat(RING_TAIL_MAX + 1)}`);
    expect(Array.from(emoji.tail)).toHaveLength(RING_TAIL_MAX);
    expect(emoji.head + emoji.tail).toBe(`Zo ${"😀".repeat(RING_TAIL_MAX + 1)}`);
  });

  /** The unit around each ring in the markup: the nowrap span that holds the name's tail and its `md-presence`. */
  const units = (html: string) => [...html.matchAll(/<span class="whitespace-nowrap"><span data-md-name-tail="true">([^<]*)<\/span><span data-testid="md-presence" data-mark="([^"]*)"/g)].map((m) => ({ tail: m[1]!, mark: m[2]! }));

  it("every ring sits in a whitespace-nowrap unit with ITS name's last word, White's and Black's, across the five presence cells", () => {
    const names = (n: number) => ({ white: { name: `Wh${n} Hoffmann`, personId: null }, black: { name: `Bl${n} Maximiliana Featherstonehaugh-Wolstenh ac48`, personId: null } });
    const html = list([
      round("stage-1:3", "playing", arbiterRound([
        live(1, { ...names(1), sides: { home: present(), away: present("off") } }),
        live(2, { ...names(2), sides: { home: board().sides.home, away: board().sides.away } }),
        live(3, { ...names(3), whiteSide: "away", sides: { home: present(), away: board().sides.away } }),
      ])),
    ]);
    // 3 boards x 2 seats = 6 rings, each bound to its own player's last word.
    expect(units(html)).toEqual([
      { tail: "Hoffmann", mark: "here" },
      { tail: "ac48", mark: "off" },
      { tail: "Hoffmann", mark: "away" },
      { tail: "ac48", mark: "away" },
      { tail: "Hoffmann", mark: "away" },
      { tail: "ac48", mark: "here" },
    ]);
    // The rest of the name still wraps: it is outside the unit, in the row's own overflow-wrap:anywhere line.
    expect(html).toContain("Bl1 Maximiliana Featherstonehaugh-Wolstenh <span");
  });

  it("no mark, no unit: a policy-off board's names are plain text, so nothing is bound for nothing", () => {
    const html = list([round("stage-1:3", "playing", arbiterRound([live(1, { cameraPolicy: "off", sides: { home: present(), away: present() } })]))]);
    // Nothing binds a name's tail to a ring (the row's own "Round 3" is a no-wrap unit since Task 7: that one is the title's, asserted here
    // so the probe is not blind to it - the old whole-markup `not.toContain("whitespace-nowrap")` could no longer tell the two apart).
    expect(html).not.toContain('<span class="whitespace-nowrap"><span data-md-name-tail');
    expect(html).toContain('<span class="whitespace-nowrap">Round 3</span>');
    expect(html).not.toContain("md-presence");
    expect(units(html)).toEqual([]);
  });
});

describe("presence marks (§5.1): green here, amber with the camera off, grey absent, none when the policy is off", () => {
  const marks = (b: ReturnType<typeof board>) => {
    const html = list([round("stage-1:3", "playing", arbiterRound([b]))]);
    return [...html.matchAll(/data-testid="md-presence" data-mark="([^"]*)"/g)].map((m) => m[1]);
  };

  it("sweeps white and black: three marks, each seat read for ITS player", () => {
    const cells: { home: ReturnType<typeof present>; away: ReturnType<typeof present>; expected: string[] }[] = [
      { home: present(), away: present(), expected: ["here", "here"] },
      { home: present("off"), away: present(), expected: ["off", "here"] },
      { home: present(), away: present("off"), expected: ["here", "off"] },
      { home: board().sides.home, away: present(), expected: ["away", "here"] },
      { home: board().sides.home, away: board().sides.away, expected: ["away", "away"] },
    ];
    let checked = 0;
    for (const c of cells) {
      expect(marks(live(1, { sides: { home: c.home, away: c.away } }))).toEqual(c.expected);
      checked++;
    }
    expect(checked, "anti-vacuity: five cells swept").toBe(5);
  });

  it("White's mark is the WHITE seat's: with the colours swapped (whiteSide away) the first name carries the away seat's presence", () => {
    // home is here, away is not; White plays the away seat, so White (named first) is absent and Black is here.
    expect(marks(live(1, { whiteSide: "away", sides: { home: present(), away: board().sides.away } }))).toEqual(["away", "here"]);
    expect(marks(live(1, { whiteSide: "home", sides: { home: present(), away: board().sides.away } }))).toEqual(["here", "away"]);
  });

  it("camera policy off draws no mark at all, and a mark says its words to a screen reader, not only a colour", () => {
    expect(marks(live(1, { cameraPolicy: "off", sides: { home: present(), away: present() } }))).toEqual([]);
    const html = list([round("stage-1:3", "playing", arbiterRound([live(1, { sides: { home: present(), away: present("off") } })]))]);
    expect(html).toContain('title="Present"');
    expect(html).toContain('title="Present, camera off"');
    expect(html).toContain('<span class="sr-only">Present, camera off</span>');
  });
});

describe("the words, in every locale", () => {
  it("renders the night in en, es, fr and nl with no raw key and the locale's own words (4 locales, rows counted)", () => {
    const n = night();
    let rows = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = DICTS[locale];
      const html = list([n.inProgress, n.paired], { d, locale });
      expect(html, `${locale}: a raw key reached the page`).not.toMatch(/matchDay\.online\./);
      expect(html).not.toMatch(/matchDay\.header\.boards/);
      rows += rowsOf(html, "md-round-row").length + rowsOf(html, "md-board-row").length;
      // The words are the locale's own text for the spec's keys, not English left in a translation.
      expect(html).toContain(t(d, "matchDay.online.word.checkingIn"));
      expect(html).toContain(t(d, "matchDay.online.word.paired"));
      expect(html).toContain(t(d, "matchDay.online.title"));
      expect(html).toContain(t(d, "matchDay.online.word.live", { n: 23 }));
    }
    expect(rows, "anti-vacuity: 2 round rows + 5 board rows in each of 4 locales").toBe(4 * 7);
    expect(t(DICTS.es, "matchDay.online.word.checkingIn")).not.toBe(t(DICTS.en, "matchDay.online.word.checkingIn"));
    expect(t(DICTS.fr, "matchDay.online.word.paired")).not.toBe(t(DICTS.en, "matchDay.online.word.paired"));
    expect(t(DICTS.nl, "matchDay.online.word.here", { here: 1, seats: 2 })).not.toBe(t(DICTS.en, "matchDay.online.word.here", { here: 1, seats: 2 }));
  });

  it("the chip's full name and the sub-group heading follow the locale too", () => {
    const own = checkinRound("stage-1:3", { needs_decision: [earlier(2)] });
    for (const locale of ["es", "fr", "nl"] as const) {
      const html = list([own], { d: DICTS[locale], locale });
      expect(html).toContain(t(DICTS[locale], "matchDay.online.roundN", { n: 2 }));
      expect(html).toContain(t(DICTS[locale], "matchDay.online.needsDecision"));
    }
  });
});

describe("clicks (the harness drives what static markup cannot): a row opens ITS round or board, by key and by fixture id", () => {
  it("a round row opens its key; a board row opens its fixture id; neither calls the other's handler", () => {
    const openRound = vi.fn();
    const openBoard = vi.fn();
    const b = { ...live(), stage_id: "stage-1", round_no: 3 } as MatchDayBoardRow;
    const roundRow = walk(RoundRow({ round: checkinRound("stage-1:3"), selected: false, dict, locale: "en", nowMs: NOW, onOpen: openRound }));
    const boardRow = walk(BoardRow({ board: b, selected: false, dict, locale: "en", onOpen: openBoard }));
    const press = (tree: ReturnType<typeof walk>, testid: string) => (propsOf(tree.find((e) => propsOf(e)["data-testid"] === testid)!).onClick as () => void)();
    press(roundRow, "md-round-row");
    expect(openRound).toHaveBeenCalledTimes(1);
    expect(openRound).toHaveBeenCalledWith("stage-1:3");
    expect(openBoard).not.toHaveBeenCalled();
    press(boardRow, "md-board-row");
    expect(openBoard).toHaveBeenCalledTimes(1);
    expect(openBoard).toHaveBeenCalledWith(b.fixtureId);
    expect(openRound).toHaveBeenCalledTimes(1);
  });

  it("the list hands each row its own handler: rounds get onOpenRound, boards (and the earlier-round boards) get onOpenBoard", () => {
    const onOpenRound = vi.fn();
    const onOpenBoard = vi.fn();
    const island = renderIsland(OnlineList, {
      rounds: [checkinRound("stage-1:3", { needs_decision: [earlier(2)] })],
      selected: null,
      dict,
      locale: "en",
      nowMs: NOW,
      onOpenRound,
      onOpenBoard,
    });
    const tree = island.tree();
    const rounds = tree.filter((e) => e.type === RoundRow);
    const boards = tree.filter((e) => e.type === BoardRow);
    expect(rounds).toHaveLength(1);
    expect(boards).toHaveLength(3);
    expect(propsOf(rounds[0]!).onOpen).toBe(onOpenRound);
    for (const b of boards) expect(propsOf(b).onOpen).toBe(onOpenBoard);
  });
});

describe("the words as data (online-copy.ts)", () => {
  const rowOf = (b: ReturnType<typeof board>): MatchDayBoardRow => ({ ...b, stage_id: "s", round_no: 1 });

  it("a board's word, state by state, with a hold's and a cancelled board's reports on a second line (ruling MD-R28: the desk's word) (one/other plural)", () => {
    const word = (b: ReturnType<typeof board>) => boardWord(dict, "en", boardRowWord(rowOf(b)));
    expect(word(board())).toEqual({ text: "Checking in", sub: null, tone: "wait" });
    expect(word(withState({ kind: "starting" }))).toEqual({ text: "Starting", sub: null, tone: "wait" });
    expect(word(live(12))).toEqual({ text: "Live · move 12", sub: null, tone: "live" });
    expect(word(held(0))).toEqual({ text: "On hold", sub: null, tone: "hold" });
    expect(word(held(1))).toEqual({ text: "On hold", sub: "1 report", tone: "hold" });
    expect(word(held(2))).toEqual({ text: "On hold", sub: "2 reports", tone: "hold" });
    expect(word(done("½-½"))).toEqual({ text: "½-½", sub: null, tone: "done" });
    expect(word(done(null))).toEqual({ text: "Finished", sub: null, tone: "quiet" });
    expect(word(withState({ kind: "result", score: null, noResult: true }))).toEqual({ text: "No result", sub: null, tone: "quiet" });
    expect(word(withState({ kind: "cancelled" }, { flagCount: 1 }))).toEqual({ text: "Cancelled", sub: "1 report", tone: "hold" });
  });

  it("a round's word, kind by kind: closes + here, playing, paired, not started, over; and nothing for a round of the viewer's own boards", () => {
    const lines = (r: MatchDayOnlineRound, tz = "Europe/London") => roundWordLines(dict, "en", tz, roundRowWord({ ...r, tz }, NOW));
    expect(lines(checkinRound("s:3"))).toEqual({ main: "closes 18:08", sub: "1 of 4 here", tone: "wait" });
    expect(lines(playingRound("s:3"))).toEqual({ main: "2 of 2 playing", sub: null, tone: "live" });
    expect(lines(pairedRound("s:3"))).toEqual({ main: "Paired, not opened", sub: null, tone: "quiet" });
    expect(lines(round("s:3", "not_started", null))).toEqual({ main: "Not started", sub: null, tone: "quiet" });
    expect(lines(overRound("s:3"))).toEqual({ main: "Finished", sub: null, tone: "quiet" });
    expect(lines(round("s:3", "playing", arbiterRound([])))).toBeNull();
  });

  it("titles and names: the stage only when the division has two; a board is named with its players, White first", () => {
    expect(onlineRoundTitle(dict, { division_name: "Open", stage_name: "Swiss", round_no: 2, multi_stage: false })).toBe("Open · Round 2");
    expect(onlineRoundTitle(dict, { division_name: "Open", stage_name: "Swiss", round_no: 2, multi_stage: true })).toBe("Open · Swiss · Round 2");
    expect(boardLabel(dict, { boardNo: 4 })).toBe("Board 4");
    expect(boardName(dict, { boardNo: 4, white: { name: "Chen", personId: null }, black: { name: "Silva", personId: null } })).toBe("Board 4 · Chen v Silva");
    expect(boardName(DICTS.es, { boardNo: 4, white: { name: "Chen", personId: null }, black: { name: "Silva", personId: null } })).toBe("Tablero 4 · Chen contra Silva");
    expect(earlierRoundChip(dict, 2)).toEqual({ code: "R2", label: "Round 2", coded: false });
    expect(onlineRoundMeta(dict, "en", round("stage-1:3", "playing", arbiterRound([live()])))).toBe("Swiss · 10+5 · 1 board");
    expect(onlineRoundMeta(dict, "en", round("stage-1:3", "before", null))).toBe("Swiss");
  });

  it("presenceText: the three marks have words, no mark has none", () => {
    expect(presenceText(dict, "here")).toBe("Present");
    expect(presenceText(dict, "off")).toBe("Present, camera off");
    expect(presenceText(dict, "away")).toBe("Not here");
    expect(presenceText(dict, null)).toBeNull();
  });

  it("boardsPlaying counts boards checking in, starting or live - not held, decided or cancelled - over the rounds it is given", () => {
    expect(boardsPlaying([])).toBe(0);
    expect(boardsPlaying([pairedRound("s:1")])).toBe(0);
    const mixed = round("s:3", "playing", arbiterRound([board(), withState({ kind: "starting" }), live(), held(1), done(), withState({ kind: "cancelled" })]));
    expect(boardsPlaying([mixed])).toBe(3);
    expect(boardsPlaying([mixed, mixed])).toBe(6);
    // A board of an earlier round, even a live one, is the sub-group's and never "playing" here.
    expect(boardsPlaying([round("s:3", "playing", arbiterRound([done()]), { needs_decision: [earlier(2, { state: { kind: "live", moveNo: 3 } })] })])).toBe(0);
    expect(plural(dict, "matchDay.header.boards", 6, "en")).toBe("6 boards playing");
    expect(plural(dict, "matchDay.header.boards", 1, "en")).toBe("1 board playing");
  });
});

// Spec §6.4, row "An organizer who plays on a board": "that board is not listed; one line says so". The omission is the loader's own rule
// (`own_boards` counts the boards it left out); the LINE was the half the port from the Arbiter Panel dropped (review T10 I-1).
describe("an organiser who plays on a board: the board is not listed, and ONE line says so (spec §6.4)", () => {
  const KEY = "matchDay.online.ownHidden";
  const lineCount = (h: string) => h.split('data-testid="md-own-hidden"').length - 1;

  it("EMPTY CASE FIRST: a night where nobody plays on a listed board prints no such line, in any locale", () => {
    let looked = 0;
    for (const locale of Object.keys(DICTS) as Locale[]) {
      const h = list(night().rounds, { d: DICTS[locale], locale });
      expect(lineCount(h), `${locale}: no own board, no line`).toBe(0);
      expect(text(h), `${locale}: and none of the words either`).not.toContain(t(DICTS[locale], KEY));
      looked++;
    }
    expect(looked, "anti-vacuity: four locales looked at").toBe(4);
  });

  it("a round with an own board says so once, in the reader's language, under that round's boards and before the next row", () => {
    let looked = 0;
    for (const locale of Object.keys(DICTS) as Locale[]) {
      const d = DICTS[locale];
      const n = night();
      const h = list([n.paired, n.over, { ...n.inProgress, own_boards: 2 }], { d, locale });
      expect(lineCount(h), `${locale}: exactly one line`).toBe(1);
      const words = t(d, KEY);
      expect(words, `${locale}: the key is in the dictionary and says something`).not.toBe(KEY);
      expect(words.length, `${locale}: words, not a stub`).toBeGreaterThan(20);
      // T10 review NEW-2: the line states what is true of the viewer's own boards and promises nothing about anyone else - a club with ONE
      // organiser has nobody to "look after" them, and a seated viewer need not be an organiser. No locale names an organiser.
      expect(words, `${locale}: the line names no other organiser`).not.toMatch(/organi[sz]/i);
      // The markup escapes an apostrophe (French "s'en charge"), so the words are compared as the server paints them.
      expect(text(h), `${locale}: the line is the dictionary's own words`).toContain(words.replaceAll("'", "&#x27;"));
      // Where the organiser looks for the missing board: right after the boards of THAT round (the last is board 5), before the paired row.
      const at = h.indexOf('data-testid="md-own-hidden"');
      const lastBoard = h.indexOf('data-fixture-id="n-5"');
      const nextRow = h.indexOf('data-key="stage-b:2"');
      expect(lastBoard, "premise: the round's last board is listed").toBeGreaterThan(-1);
      expect(nextRow, "premise: the paired round's row is listed").toBeGreaterThan(-1);
      expect(at, `${locale}: after the round's boards`).toBeGreaterThan(lastBoard);
      expect(at, `${locale}: before the next round's row`).toBeLessThan(nextRow);
      // The board itself stays unlisted: the rows are exactly the ones the night has.
      expect(rowsOf(h, "md-board-row"), `${locale}: no row stands in for the hidden board`).toHaveLength(7);
      looked++;
    }
    expect(looked, "anti-vacuity: four locales looked at").toBe(4);
  });

  it("a round with no board on screen (every board the viewer's own) still says so - the line is what the empty round has instead of rows", () => {
    const own = round("stage-1:3", "playing", arbiterRound([], { ownBoards: 2 }), { own_boards: 2 });
    const h = list([own]);
    expect(lineCount(h)).toBe(1);
    expect(text(h)).toContain(t(dict, KEY));
    expect(rowsOf(h, "md-board-row")).toHaveLength(0);
  });

  it("each round that has an own board carries its own line, and a round that has none carries none", () => {
    const a = { ...playingRound("stage-1:3"), own_boards: 1 };
    const b = playingRound("stage-2:1", { division_id: "div-b", stage_id: "stage-2" });
    const c = { ...playingRound("stage-3:2", { division_id: "div-c", stage_id: "stage-3" }), own_boards: 3 };
    const h = list([a, b, c]);
    expect(lineCount(h), "two rounds with an own board, two lines").toBe(2);
  });
});
