// T15 — the arbiter page (/o/{org}/c/{comp}/d/{div}/arbiter): organisers
// only, an online chess division only, and the panel gets the round the
// loader read for THIS division plus the board asked for in `?fixture=`.
// The page never joins a meeting itself: tokens are fetched by the arbiter's
// own browser, after mount (spec §10), so nothing secret is in the HTML.
//
// Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §7): the page also
// follows the online-chess flag (a club not offered online chess gets a 404,
// asked AFTER the three cheap checks) and loads the round column's data -
// the open rounds, the held boards, the flagged boards, the venue zone and
// whether the division has started - in ONE Promise.all.
//
// Same scaffold as the division page's tests: no jsdom, the async server
// component called directly, its returned tree read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({
  sport_key: "boardgame",
  config: { onlinePlay: "lichess" } as Record<string, unknown> | null,
  status: "active",
}));
const getDivision = vi.hoisted(() => vi.fn());
const usecases = vi.hoisted(() => ({
  loadArbiterRound: vi.fn(),
  arbiterRequestedRound: vi.fn(),
  joinAsArbiter: vi.fn(),
  onlineChessOffered: vi.fn(),
  listOpenRounds: vi.fn(),
  listNeedsOrganiserExternalPlay: vi.fn(),
  listFlaggedExternalPlay: vi.fn(),
}));
const schedule = vi.hoisted(() => ({ getScheduleSettings: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/divisions", () => ({ getDivision }));
vi.mock("@/server/usecases/external-play", () => usecases);
vi.mock("@/server/usecases/schedule", () => schedule);
// The panel is mounted for real in the seam test below (static markup, effects never run): it only needs a router to exist.
// `notFound` stays the real one, so a 404 is still a thrown digest.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => undefined }),
}));

import ArbiterPage from "../page";
import { ArbiterPanel } from "@/components/v2/arbiter-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";

type PanelProps = ComponentProps<typeof ArbiterPanel>;

const PAGE = { auth: { orgId: "org-1", userId: "user-1", role: "owner", via: "session" }, canEdit: true, division: { id: "div-1" } };
const ROUND = { stageId: "st", stageName: "Open", roundNo: 2, timeControl: "10+5", boards: [], ownBoards: 0, current: true };
// Four reads, four DIFFERENT non-empty values: a field wired to the wrong read, or dropped, cannot read as right.
const VIEWS = [{ stageId: "st", roundNo: 3, press: "open", marker: "views" }];
const HELD = [{ fixtureId: "fx-held", marker: "held" }];
const FLAGGED = { boards: [{ fixtureId: "fx-flagged", marker: "flagged" }], ownBoards: 2 };
const VENUE_TZ = "Asia/Tokyo";
// The six fields of the column, as the panel's type declares them (RoundColumnData): the page must hand every one.
const COLUMN_FIELDS = ["awaitsStart", "flagged", "held", "ownFlagged", "tz", "views"];

const render = (search: Record<string, string | string[] | undefined> = {}) =>
  ArbiterPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(search),
  });
const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining("404") });
const panel = async (search: Record<string, string | string[] | undefined> = {}) => (await render(search)) as ReactElement<PanelProps>;
/** Every read the page makes for the column, plus the zone: none of these may run for a page that is going to 404. */
const columnReads = () => [usecases.listOpenRounds, usecases.listNeedsOrganiserExternalPlay, usecases.listFlaggedExternalPlay, schedule.getScheduleSettings];
/** Every loader and reader behind the gates. */
const allReads = () => [...columnReads(), usecases.loadArbiterRound, usecases.arbiterRequestedRound];
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;

beforeEach(() => {
  division.sport_key = "boardgame";
  division.config = { onlinePlay: "lichess" };
  division.status = "active";
  getDivision.mockReset().mockImplementation(async () => ({ id: "div-1", sport_key: division.sport_key, config: division.config, status: division.status }));
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  usecases.loadArbiterRound.mockReset().mockResolvedValue(ROUND);
  usecases.arbiterRequestedRound.mockReset().mockResolvedValue({ kind: "round", stageId: "st", roundNo: 1 });
  usecases.joinAsArbiter.mockReset();
  usecases.onlineChessOffered.mockReset().mockResolvedValue(true);
  usecases.listOpenRounds.mockReset().mockResolvedValue(VIEWS);
  usecases.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue(HELD);
  usecases.listFlaggedExternalPlay.mockReset().mockResolvedValue(FLAGGED);
  schedule.getScheduleSettings.mockReset().mockResolvedValue({ division_id: "div-1", tz: VENUE_TZ });
});

describe("the arbiter page", () => {
  it("an organiser on an online chess division: the panel, the asked-for board's OWN round (I3), that board, and the column", async () => {
    const tree = await panel({ fixture: "fx-9" });
    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe(ArbiterPanel);
    expect(tree.props).toEqual({
      round: ROUND,
      requested: null,
      slugs: { org: "org", comp: "comp", div: "div" },
      initialFixtureId: "fx-9",
      column: { views: VIEWS, held: HELD, flagged: FLAGGED.boards, ownFlagged: 2, tz: VENUE_TZ, awaitsStart: false },
    });
    expect(usecases.arbiterRequestedRound).toHaveBeenCalledWith(PAGE.auth, "div-1", "fx-9");
    expect(usecases.loadArbiterRound).toHaveBeenCalledWith(PAGE.auth, "div-1", { round: { stageId: "st", roundNo: 1 } });
    expect(pageAuth.requireDivisionPage).toHaveBeenCalledWith("org", "comp", "div", { tail: "/arbiter" });
    expect(usecases.joinAsArbiter, "no token is minted for the HTML").not.toHaveBeenCalled();
  });

  it("no ?fixture= (or a repeated one) opens on the panel's default board; no round open is still the panel", async () => {
    usecases.loadArbiterRound.mockResolvedValue(null);
    let checked = 0;
    for (const search of [{}, { fixture: ["a", "b"] }]) {
      const tree = (await render(search)) as ReactElement<{ initialFixtureId: unknown; round: unknown; requested: unknown }>;
      expect(tree.props.initialFixtureId).toBeNull();
      expect(tree.props.round).toBeNull();
      expect(tree.props.requested).toBeNull();
      expect(usecases.loadArbiterRound).toHaveBeenLastCalledWith(PAGE.auth, "div-1", {});
      checked++;
    }
    expect(checked).toBe(2);
    expect(usecases.arbiterRequestedRound, "nothing asked for").not.toHaveBeenCalled();
  });

  it("I3: a board that is not here (or is the viewer's own) is SAID so — no round loaded, so no other board can open — and the column's reads still run", async () => {
    let checked = 0;
    for (const kind of ["unavailable", "own"] as const) {
      usecases.loadArbiterRound.mockClear();
      for (const read of columnReads()) read.mockClear();
      usecases.arbiterRequestedRound.mockResolvedValue({ kind });
      const tree = await panel({ fixture: "fx-gone" });
      expect(tree.props.requested, kind).toBe(kind);
      expect(tree.props.round, kind).toBeNull();
      expect(tree.props.initialFixtureId).toBe("fx-gone");
      expect(usecases.loadArbiterRound, kind).not.toHaveBeenCalled();
      // The page does not special-case it: the column is handed whole and the PANEL decides what a notice shows.
      expect(tree.props.column, kind).toEqual({ views: VIEWS, held: HELD, flagged: FLAGGED.boards, ownFlagged: 2, tz: VENUE_TZ, awaitsStart: false });
      for (const read of columnReads()) expect(read, `${kind}: the column's reads still run`).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("404 for a viewer, for a division that does not play online, and for another sport — the flag is never asked, no loader, no reader", async () => {
    const cases: [string, () => void][] = [
      ["viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
      ["over the board", () => (division.config = { variant: "classical" })],
      ["no config", () => (division.config = null)],
      ["online play off", () => (division.config = { onlinePlay: "off" })],
      ["another sport", () => (division.sport_key = "generic")],
    ];
    let checked = 0;
    for (const [label, arm] of cases) {
      division.sport_key = "boardgame";
      division.config = { onlinePlay: "lichess" };
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      arm();
      await notFound(render({ fixture: "fx-1" }));
      // A cheap check refused it: PostHog is not asked (a remote call, kept 60 s per org), and nothing is read for a column.
      expect(usecases.onlineChessOffered, `${label}: the flag is never asked`).not.toHaveBeenCalled();
      for (const read of allReads()) expect(read, `${label}: no read`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a viewer does not even load the division: canEdit is the first check", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    await notFound(render());
    expect(getDivision).not.toHaveBeenCalled();
    expect(usecases.onlineChessOffered).not.toHaveBeenCalled();
  });
});

describe("the arbiter page follows the online-chess flag (spec §7)", () => {
  it("flag off: 404, and no reader is asked", async () => {
    usecases.onlineChessOffered.mockResolvedValue(false);
    // With a board asked for, so the I3 reader would also have been tempting to run.
    await notFound(render({ fixture: "fx-1" }));
    expect(usecases.onlineChessOffered, "the flag WAS asked, once, for this club").toHaveBeenCalledTimes(1);
    expect(usecases.onlineChessOffered).toHaveBeenCalledWith(PAGE.auth);
    for (const read of allReads()) expect(read, "no read behind a refused flag").not.toHaveBeenCalled();
    expect(allReads().length, "anti-vacuity: six readers watched").toBe(6);
  });

  it("flag on: the panel renders and the flag was asked once, with the page's auth", async () => {
    const tree = await panel();
    expect(tree.type).toBe(ArbiterPanel);
    expect(usecases.onlineChessOffered).toHaveBeenCalledTimes(1);
    expect(usecases.onlineChessOffered).toHaveBeenCalledWith(PAGE.auth);
  });

  it("the order is canEdit, the division, THEN the flag, THEN the reads (cheap checks first)", async () => {
    await panel({ fixture: "fx-1" });
    const asked = firstCall(usecases.onlineChessOffered);
    expect(firstCall(pageAuth.requireDivisionPage), "auth before the division").toBeLessThan(firstCall(getDivision));
    expect(firstCall(getDivision), "the division (sport, online play) before the flag").toBeLessThan(asked);
    let checked = 0;
    for (const read of allReads()) {
      expect(read, "premise: this read ran").toHaveBeenCalled();
      expect(firstCall(read), "the flag is asked before every read").toBeGreaterThan(asked);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("the sequence: on, then the same club switched off — the next render is a 404, and the one after the flag returns is the panel again", async () => {
    expect((await panel()).type).toBe(ArbiterPanel);
    usecases.onlineChessOffered.mockResolvedValue(false);
    await notFound(render());
    usecases.onlineChessOffered.mockResolvedValue(true);
    expect((await panel()).type).toBe(ArbiterPanel);
  });
});

describe("the arbiter page loads the round column (spec §5, §7)", () => {
  it("the column is handed to the panel with all SIX fields, each from its own read (a dropped or crossed field fails)", async () => {
    const tree = await panel();
    const column = tree.props.column as unknown as Record<string, unknown>;
    expect(column, "the page hands a column").toBeDefined();
    expect(Object.keys(column).sort(), "exactly the six fields").toEqual(COLUMN_FIELDS);
    // By identity: the read's own result, not a copy or a neighbour's.
    expect(column.views).toBe(VIEWS);
    expect(column.held).toBe(HELD);
    expect(column.flagged).toBe(FLAGGED.boards);
    expect(column.ownFlagged).toBe(FLAGGED.ownBoards);
    expect(column.tz).toBe(VENUE_TZ);
    expect(column.awaitsStart).toBe(false);
    expect(COLUMN_FIELDS.length, "anti-vacuity: six fields checked").toBe(6);
    // ... and each read was asked for THIS division, as this organiser.
    for (const read of columnReads()) expect(read).toHaveBeenCalledWith(PAGE.auth, "div-1");
  });

  it("the venue zone is the schedule settings' own (a literal zone seeded in the mock, never a default)", async () => {
    let checked = 0;
    for (const tz of ["Asia/Tokyo", "America/Sao_Paulo"]) {
      schedule.getScheduleSettings.mockResolvedValue({ division_id: "div-1", tz });
      expect((await panel()).props.column.tz, tz).toBe(tz);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("nothing paired, nobody held, nothing flagged: the column is still handed, empty and whole (never undefined)", async () => {
    usecases.listOpenRounds.mockResolvedValue([]);
    usecases.listNeedsOrganiserExternalPlay.mockResolvedValue([]);
    usecases.listFlaggedExternalPlay.mockResolvedValue({ boards: [], ownBoards: 0 });
    usecases.loadArbiterRound.mockResolvedValue(null);
    const column = (await panel()).props.column;
    expect(column).toStrictEqual({ views: [], held: [], flagged: [], ownFlagged: 0, tz: VENUE_TZ, awaitsStart: false });
  });

  it("awaitsStart follows the division's status - the division page's own rule: setup and scheduled have not started, active and completed have", async () => {
    // The rulebook (division-phase.ts: scoring opens only after the explicit start), not the predicate under test.
    const AWAITS_START: Record<string, boolean> = { setup: true, scheduled: true, active: false, completed: false };
    let checked = 0;
    for (const [status, expected] of Object.entries(AWAITS_START)) {
      division.status = status;
      const column = (await panel()).props.column;
      expect(column.awaitsStart, `${status}: told as a boolean, not left undefined`).toBe(expected);
      // The views are the reader's own whatever the status: the PANEL's column decides that the start line wins.
      expect(column.views, `${status}: views untouched`).toBe(VIEWS);
      checked++;
    }
    expect(checked, "anti-vacuity: all four statuses swept").toBe(4);
  });

  it("the sequence: not started, then started — the same division, the start line goes", async () => {
    division.status = "scheduled";
    expect((await panel()).props.column.awaitsStart).toBe(true);
    division.status = "active";
    expect((await panel()).props.column.awaitsStart).toBe(false);
  });

  it("the reads run TOGETHER: every read is started before any has answered (one Promise.all, not a chain of awaits)", async () => {
    const release: (() => void)[] = [];
    const held = <T,>(value: T) => new Promise<T>((resolve) => release.push(() => resolve(value)));
    usecases.listOpenRounds.mockImplementation(() => held(VIEWS));
    usecases.listNeedsOrganiserExternalPlay.mockImplementation(() => held(HELD));
    usecases.listFlaggedExternalPlay.mockImplementation(() => held(FLAGGED));
    schedule.getScheduleSettings.mockImplementation(() => held({ division_id: "div-1", tz: VENUE_TZ }));
    usecases.loadArbiterRound.mockImplementation(() => held(ROUND));

    const pending = panel();
    // Nothing has been released: if the page awaited one read before starting the next, the later ones would never be called.
    await vi.waitFor(() => {
      for (const read of [...columnReads(), usecases.loadArbiterRound]) expect(read).toHaveBeenCalledTimes(1);
    });
    expect(release.length, "anti-vacuity: five reads were holding").toBe(5);
    for (const go of release) go();
    const tree = await pending;
    expect(tree.props.round).toBe(ROUND);
    expect(tree.props.column.views).toBe(VIEWS);
  });
});

// The seam, through its real producer and consumer: the page's own output mounted in the real panel. A fixture on both ends would
// prove the fixture; here the page produces the column and the panel's column paints it.
describe("the page's column is what the real panel paints", () => {
  const paint = async (): Promise<string> => {
    const tree = await panel();
    return renderToStaticMarkup(
      <DictProvider dict={en as unknown as Dict} locale="en">
        <ArbiterPanel {...tree.props} />
      </DictProvider>,
    );
  };

  it("before a round opens, the division's status decides between 'start the division first' and 'nothing paired'", async () => {
    usecases.loadArbiterRound.mockResolvedValue(null);
    // The same reads in both cells (as the real reader answers [] before the start, and [] when nothing is paired): only the status moves.
    usecases.listOpenRounds.mockResolvedValue([]);
    usecases.listNeedsOrganiserExternalPlay.mockResolvedValue([]);
    usecases.listFlaggedExternalPlay.mockResolvedValue({ boards: [], ownBoards: 0 });
    division.status = "setup";
    const notStarted = await paint();
    expect(notStarted, "a column is on the page, before any round").toMatch(/data-testid="arbiter-round-column"[^>]*data-phase="before"/);
    expect(notStarted).toContain('data-testid="arbiter-column-start-first"');
    expect(notStarted).not.toContain('data-testid="arbiter-column-nothing"');
    division.status = "active";
    const started = await paint();
    expect(started).toMatch(/data-testid="arbiter-round-column"[^>]*data-phase="before"/);
    expect(started).not.toContain('data-testid="arbiter-column-start-first"');
    expect(started).toContain('data-testid="arbiter-column-nothing"');
  });
});
