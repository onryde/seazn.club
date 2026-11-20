// Match Day online, Task 6 (plan 2026-11-05-match-day-all-in-one.md; spec §5.1-§5.3, §6.3; MD-R2, MD-R7, MD-R18): the page's shell with
// the online block, rendered to markup. apps/web vitest is `environment: "node"`, so these see what the server paints (and what a first
// client render paints); what a click or a poll does is match-day-online-driven.test.tsx, and the phone is e2e/mobile.
//
// Where an expected value comes from: the counts words are the dictionary's own plural; the back label is the dictionary's own key for
// the case the plan names (courts: the court noun; boards alone: "All boards"; a match on no court: "Back to the list"); which row the
// page opens first is the plan's sentence (a court, else a match on no court, else the first round) typed row by row. Attribute reads
// anchor on `="` - an omitted prop serialises as "$undefined" and a bare probe passes in both states.
// Anti-vacuity: every sweep counts what it looked at.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { MatchDayCourt, MatchDayFixture, MatchDayView } from "@/lib/match-day/types";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import { MatchDayShell, type MatchDayShellProps } from "../match-day-shell";
import { arbiterRound, checkinRound, earlier, held, live, onlineView, overRound, pairedRound, round } from "./_online-fixtures";

const dict = en as Dict;

const court = (id: string, name: string): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  stream_link: null,
});
const match = (id: string): MatchDayFixture =>
  ({
    id,
    division_id: "div-otb",
    division_name: "Cup",
    division_slug: "cup",
    fixture_no: 3,
    sport_key: "generic",
    stage_label: "Knockout",
    round: { code: "QF", label: "Quarter-finals", coded: true },
    home: "Ana",
    away: "Ben",
    home_entrant_id: `${id}-h`,
    away_entrant_id: `${id}-a`,
    headline: null,
    summary: null,
    serving: null,
    started_at: "2026-11-19T17:40:00.000Z",
    called_at: null,
    stream: null,
    scorer_attention: null,
    live_video: null,
    format_line: null,
    court_stream: false,
    own_stream_code: false,
  }) as MatchDayFixture;

const shell = (v: MatchDayView, o: Partial<MatchDayShellProps> = {}) =>
  renderToStaticMarkup(
    <MatchDayShell
      competitionId="comp-1"
      competitionName="Westway Open"
      orgSlug="acme"
      compSlug="westway-open"
      locale="en"
      divisions={[]}
      initial={v}
      dict={dict}
      scoreDict={publicEn as Dict}
      viewerPlan="pro"
      frozenNames={NO_FROZEN_NAMES}
      {...o}
    />,
  );
const on = { onlineEnabled: true };
const tagWith = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
const attr = (tag: string, name: string): string | null => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const countOf = (html: string, testId: string) => (html.match(new RegExp(`data-testid="${testId}"`, "g")) ?? []).length;
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The counts line's parts (DotLine: each a dot-led span), read from the `md-counts` box and no further. */
const countParts = (html: string): string[] => {
  const at = html.indexOf('data-testid="md-counts"');
  const re = /<span[^>]*data-dot-part[^>]*><span[^>]*data-dot[^>]*>·<\/span><span[^>]*>([^<]*)<\/span><\/span>/y;
  re.lastIndex = html.indexOf(">", at) + 1;
  const parts: string[] = [];
  for (let m = re.exec(html); m !== null; m = re.exec(html)) parts.push(m[1]!);
  return parts;
};
const countsLine = (html: string): string => countParts(html).join(" · ");

describe("EMPTY CASE FIRST - a day of courts is exactly the page it was", () => {
  it("online_rounds: [] with the flag on: the same bytes as with the flag off, and no online block, heading or list", () => {
    const v = onlineView([], { courts: [court("c-1", "Court 1"), court("c-2", "Court 2")] });
    const flagOn = shell(v, on);
    expect(flagOn).toBe(shell(v));
    expect(flagOn).not.toContain('data-testid="md-online"');
    expect(flagOn).not.toContain(t(dict, "matchDay.online.title"));
    // The positive pair: the page is the courts' page.
    expect(countOf(flagOn, "md-list")).toBe(1);
    expect(flagOn).toContain("Court 1");
    expect(flagOn).toContain("Court 2");
  });

  it("the flag off: rounds the view carries are not drawn, nor counted, nor opened - the bytes of a view with none", () => {
    const withRounds = onlineView([checkinRound("s:3"), pairedRound("t:1")], { courts: [court("c-1", "Court 1")] });
    const without = onlineView([], { courts: [court("c-1", "Court 1")] });
    expect(shell(withRounds)).toBe(shell(without));
    // `?board=` and `?round=` open nothing with the flag off.
    const b = withRounds.online_rounds[0]!.round!.boards[0]!.fixtureId;
    expect(shell(withRounds, { focusBoardId: b, focusRoundKey: "s:3" })).toBe(shell(without));
  });

  it("a day with nothing at all is the empty page; one online round and no court is not", () => {
    expect(shell(onlineView([]), on)).toContain('data-testid="md-empty"');
    const html = shell(onlineView([pairedRound("s:3")]), on);
    expect(html).not.toContain('data-testid="md-empty"');
    expect(html).toContain('data-testid="md-online"');
  });
});

describe("the online block of the list", () => {
  const night = () =>
    onlineView([
      checkinRound("stage-1:3", { division_id: "div-chess" }),
      round("stage-2:1", "playing", arbiterRound([live(), live(5), held(1)], { stageId: "stage-2" }), { division_id: "div-blitz", division_name: "Club Blitz", stage_id: "stage-2" }),
    ]);

  it("two rounds and five boards: two round rows and five board rows, in the list column, after the courts", () => {
    const html = shell({ ...night(), courts: [court("c-1", "Court 1")] }, on);
    expect(countOf(html, "md-round-row")).toBe(2);
    expect(countOf(html, "md-board-row")).toBe(5);
    expect(html.indexOf('data-testid="md-online"')).toBeGreaterThan(html.indexOf("Court 1"));
    // Inside the list column, so a phone's list-then-focus swap carries it.
    const list = html.slice(html.indexOf('data-testid="md-list"'));
    expect(list.indexOf('data-testid="md-online"')).toBeGreaterThan(-1);
  });

  it("the rounds are listed check-in or in progress, then paired, then over (spec §5.2), whatever order the view has them", () => {
    const html = shell(onlineView([overRound("stage-c:1"), pairedRound("stage-b:2"), checkinRound("stage-1:3")]), on);
    const keys = [...html.matchAll(/data-testid="md-round-row"[^>]*?data-key="([^"]*)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["stage-1:3", "stage-b:2", "stage-c:1"]);
    // Two rounds in the SAME group keep the view's (competition's) order.
    const same = shell(onlineView([...night().online_rounds].reverse()), on);
    expect([...same.matchAll(/data-testid="md-round-row"[^>]*?data-key="([^"]*)"/g)].map((m) => m[1])).toEqual(["stage-2:1", "stage-1:3"]);
  });

  it("the counts line adds the boards: '... · 5 boards playing' (check-in and live boards; the held one is not playing)", () => {
    const html = shell(night(), on);
    // 2 checking in + 2 live = 4; the held board is the queue's.
    expect(countsLine(html)).toBe(plural(dict, "matchDay.header.boards", 4, "en"));
    expect(countsLine(html)).toBe("4 boards playing");
    const withCourts = shell({ ...night(), courts: [court("c-1", "Court 1")] }, on);
    expect(countsLine(withCourts)).toBe("1 court · 0 playing · 1 free · 4 boards playing");
  });

  it("a match on no court, then the boards: the no-court count first, the boards after", () => {
    const html = shell({ ...night(), playing_no_court: [match("m-1")] }, on);
    expect(countsLine(html)).toBe(`${plural(dict, "matchDay.header.noCourt.court", 1, "en")} · 4 boards playing`);
  });

  it("a round of one's own boards (none listed) is a row with no board rows under it, and the line says '0 boards playing' not '0 courts'", () => {
    const html = shell(onlineView([round("s:3", "playing", arbiterRound([], { ownBoards: 1 }), { own_boards: 1 })]), on);
    expect(countOf(html, "md-round-row")).toBe(1);
    expect(countOf(html, "md-board-row")).toBe(0);
    expect(countsLine(html)).toBe("0 boards playing");
  });

  it("a board held from an earlier round is listed under its round with the round's chip, and is not counted as playing", () => {
    const v = onlineView([checkinRound("stage-1:3", { needs_decision: [earlier(2, { fixtureId: "old-1" })] })]);
    const html = shell(v, on);
    expect(countOf(html, "md-board-subgroup")).toBe(1);
    expect(countOf(html, "md-board-row")).toBe(3);
    expect(countsLine(html)).toBe("2 boards playing");
  });
});

describe("what the page opens first (default focus, the plan's own order)", () => {
  const r = checkinRound("stage-1:3");

  it("a court on the page: the first court. A match on no court and no court: the match. Online rounds alone: the first round - never nothing", () => {
    const withCourt = shell(onlineView([r], { courts: [court("c-1", "Court 1")] }), on);
    expect(attr(tagWith(withCourt, "md-focus"), "data-online")).toBeNull();
    expect(countOf(withCourt, "md-focus")).toBe(1);
    expect(withCourt).toContain('aria-label="Court 1"');

    const withMatch = shell(onlineView([r], { playing_no_court: [match("m-1")] }), on);
    expect(attr(tagWith(withMatch, "md-focus"), "data-fixture-id")).toBe("m-1");
    expect(attr(tagWith(withMatch, "md-focus"), "data-online")).toBeNull();

    const roundsOnly = shell(onlineView([pairedRound("stage-b:2"), r]), on);
    const focus = tagWith(roundsOnly, "md-focus");
    expect(attr(focus, "data-online")).toBe("round");
    // `orderOnlineRounds`' first row, not the view's first: the round in check-in.
    expect(attr(focus, "data-key")).toBe("stage-1:3");
    expect(countOf(roundsOnly, "md-focus")).toBe(1);
  });

  it("a default focus is not an opened one: a phone shows the LIST (the focus is hidden on a phone), the desktop shows both", () => {
    const html = shell(onlineView([r]), on);
    expect(tagWith(html, "md-focus")).toContain("max-md:hidden");
    expect(tagWith(html, "md-list")).not.toContain("max-md:hidden");
    expect(html).not.toContain('data-testid="md-lost"');
  });
});

describe("?board= and ?round= (read as ?court= is: a value naming a listed row opens it, anything else opens nothing)", () => {
  const r = checkinRound("stage-1:3", { needs_decision: [earlier(2, { fixtureId: "old-1", boardNo: 9 })] });
  const v = () => onlineView([r], { courts: [court("c-1", "Court 1")] });
  const firstBoard = r.round!.boards[1]!.fixtureId;

  it("a listed board: its panel, full-screen on a phone (the list hidden), named 'Board N · White v Black', the row highlighted", () => {
    const html = shell(v(), { ...on, focusBoardId: firstBoard });
    const focus = tagWith(html, "md-focus");
    expect(attr(focus, "data-online")).toBe("board");
    expect(attr(focus, "data-fixture-id")).toBe(firstBoard);
    expect(focus).not.toContain("max-md:hidden");
    expect(tagWith(html, "md-list")).toContain("max-md:hidden");
    expect(attr(focus, "aria-label")).toMatch(/^Board \d+ · White \d+ v Black \d+$/);
    // The header gives way on a phone (a court opened the same way does).
    expect(tagWith(html, "md-header")).toContain("max-md:hidden");
    // Exactly one row is the selected one.
    const rows = [...html.matchAll(/<button[^>]*data-testid="md-board-row"[^>]*>/g)].map((m) => m[0]);
    expect(rows.filter((x) => attr(x, "aria-current") === "true")).toHaveLength(1);
    expect(attr(rows.find((x) => attr(x, "aria-current") === "true")!, "data-fixture-id")).toBe(firstBoard);
  });

  it("a held board of an earlier round opens too, naming its round in the panel", () => {
    const html = shell(v(), { ...on, focusBoardId: "old-1" });
    const focus = tagWith(html, "md-focus");
    expect(attr(focus, "data-fixture-id")).toBe("old-1");
    expect(html).toContain('data-round-code="R2"');
  });

  it("a listed round: its panel, full-screen on a phone, its row highlighted", () => {
    const html = shell(v(), { ...on, focusRoundKey: "stage-1:3" });
    const focus = tagWith(html, "md-focus");
    expect(attr(focus, "data-online")).toBe("round");
    expect(attr(focus, "data-key")).toBe("stage-1:3");
    expect(focus).not.toContain("max-md:hidden");
    expect(attr(tagWith(html, "md-round-row"), "aria-current")).toBe("true");
  });

  it("a value naming nothing listed opens nothing: the DEFAULT focus, no 'left the list' notice, no board panel (8 values)", () => {
    const values: Partial<MatchDayShellProps>[] = [
      { focusBoardId: "ghost" },
      { focusBoardId: "" },
      { focusBoardId: "stage-1:3" }, // a round key in the board param
      { focusBoardId: "own-board-of-the-viewer" },
      { focusRoundKey: "ghost:1" },
      { focusRoundKey: "stage-1:4" },
      { focusRoundKey: firstBoard }, // a board id in the round param
      { focusRoundKey: "" },
    ];
    let checked = 0;
    for (const o of values) {
      const html = shell(v(), { ...on, ...o });
      const label = JSON.stringify(o);
      expect(html, label).not.toContain('data-testid="md-lost"');
      expect(attr(tagWith(html, "md-focus"), "data-online"), label).toBeNull();
      expect(html, label).toContain('aria-label="Court 1"');
      expect(tagWith(html, "md-list"), label).not.toContain("max-md:hidden");
      checked++;
    }
    expect(checked, "anti-vacuity: eight unlisted values").toBe(8);
  });

  it("with no court the default focus is the first round, and an unknown ?board= leaves it so (no panel for a board that is not there)", () => {
    const html = shell(onlineView([r]), { ...on, focusBoardId: "ghost" });
    const focus = tagWith(html, "md-focus");
    expect(attr(focus, "data-online")).toBe("round");
    expect(attr(focus, "data-key")).toBe("stage-1:3");
    expect(attr(focus, "data-fixture-id")).toBeNull();
    expect(html).not.toContain('data-testid="md-lost"');
  });

  it("a court asked for wins over a board and a round (the three params read in one order)", () => {
    const html = shell(v(), { ...on, focusCourtId: "c-1", focusBoardId: firstBoard, focusRoundKey: "stage-1:3" });
    expect(attr(tagWith(html, "md-focus"), "data-online")).toBeNull();
    expect(html).toContain('aria-label="Court 1"');
    expect(tagWith(html, "md-list")).toContain("max-md:hidden");
  });
});

describe("the phone's way back says where it goes", () => {
  const open = (v: MatchDayView) => shell(v, { ...on, focusRoundKey: "stage-1:3" });
  const backOf = (html: string) => {
    const at = html.lastIndexOf("<", html.indexOf('data-testid="md-back"'));
    // The button draws a chevron in front of the label.
    return text(html.slice(at, html.indexOf("</button>", at))).replace(/^‹\s*/, "");
  };

  it("with courts on the page it is the courts' own word; boards alone, 'All boards'; a match on no court beside them, 'Back to the list'", () => {
    const r = checkinRound("stage-1:3");
    expect(backOf(open(onlineView([r], { courts: [court("c-1", "Court 1")] })))).toBe(t(dict, "matchDay.back.court"));
    expect(backOf(open(onlineView([r])))).toBe(t(dict, "matchDay.back.board"));
    expect(backOf(open(onlineView([r], { playing_no_court: [match("m-1")] })))).toBe(t(dict, "matchDay.back.list"));
    expect(t(dict, "matchDay.back.board")).toBe("All boards");
  });
});

describe("another sport: a division that is not online has no round on the page, so the page is the courts' page", () => {
  it("a day of badminton courts and a match on no court, with the flag on: no online block, the court focused, nothing of the online page", () => {
    const html = shell(onlineView([], { courts: [court("c-1", "Court 1")], playing_no_court: [match("m-1")] }), on);
    expect(html).not.toContain('data-testid="md-online"');
    expect(html).not.toContain("data-online=");
    expect(html).toContain('data-testid="md-no-court"');
  });
});
