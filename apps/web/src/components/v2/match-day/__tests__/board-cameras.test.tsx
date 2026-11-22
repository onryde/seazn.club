// Match Day online, Task 9 - the two tiles (`BoardCameras`, board-cameras.tsx): what each player's tile says, in which order the board's own facts
// and the join's answer are read (`tileView`), the one word of each state (`tileWord`), the fold a held board opens with, and the retry press.
//
// Chess only: a tile is a player's camera meeting; no other sport has one.
//
// Two ways of looking, as in board-focus.test.tsx: `renderToStaticMarkup` reads what a person would see (copy from the English dictionary,
// never typed here) and the hook harness drives the one piece of state the view owns (the fold), because a click needs the dispatcher.
// Where an expected value comes from: the order of reading is the Arbiter Panel's own (typed in the table below from its header), the word of
// each state is the dictionary's entry for the key the rule names, a "time off since" is worked out by hand from the fixture's instants.
// Anti-vacuity: every sweep says how many cells it checked, and every "absent" claim is paired with the case that has it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { Dict } from "@/lib/i18n-constants";
import { useFmt, type Fmt } from "../../arbiter-flag-cards";
import { BoardCameras, CamerasToggle, anyUnavailable, tileView, tileWord } from "../board-cameras";
import type { JoinViews } from "../online/arbiter-joins";
import type { ArbiterVideoView } from "../online/arbiter-video";
import type { MatchDayBoardRow } from "@/lib/match-day/types";
import { held, live, meeting, NOW, present, withState } from "./_online-fixtures";

const MIN = 60_000;
const EN = enUi as Record<string, string>;
const dict = enUi as unknown as Dict;
const t = (key: string, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key]!);
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const joinable = (camera: "live" | "off" = "live") => ({ ...present(camera), joinable: true });
const WATCHING: ArbiterVideoView = { kind: "watching", tile: { present: true, live: true, offSinceMs: null, track: null } };
const viewsOf = (b: Pick<ArbiterBoard, "fixtureId">, kinds: Partial<Record<"home" | "away", ArbiterVideoView>>): JoinViews =>
  new Map(Object.entries(kinds).map(([side, v]) => [`${b.fixtureId}:${side}`, v])) as unknown as JoinViews;

const ADA = { name: "Ada Lovelace", personId: null };
const BEN = { name: "Ben Carson", personId: null };
/** Both players arrived: what a board the shell joins looks like. */
const LIVE_BOARD = live(12, { fixtureId: "b-cam", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable("live"), away: joinable("live") } });

/** A board as the list carries it: the cameras read the row's own fields. */
const toRow = (b: ArbiterBoard): MatchDayBoardRow => ({ ...b, stage_id: "stage-1", round_no: 3 });

const count = (h: string, testid: string) => h.split(`data-testid="${testid}"`).length - 1;
const tagOf = (h: string, testid: string): string | null => new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(h)?.[0] ?? null;

/** The component the view needs a formatter for, mounted under the English dictionary. */
function Probe(p: { board: ArbiterBoard; views: JoinViews; onRetry?: (key: string) => void; folded: boolean }) {
  const f = useFmt(NOW, "Europe/London");
  return <BoardCameras board={toRow(p.board)} views={p.views} f={f} dict={dict} onRetry={p.onRetry ?? (() => {})} folded={p.folded} bodyId="cams-body" />;
}
const render = (board: ArbiterBoard, views: JoinViews, onRetry?: (key: string) => void, folded = false) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <Probe board={board} views={views} onRetry={onRetry} folded={folded} />
    </DictProvider>,
  );
/** A formatter for the pure word table. */
function fmtOf(): Fmt {
  let out: Fmt | null = null;
  const sink = (f: Fmt) => {
    out = f;
  };
  function Grab() {
    sink(useFmt(NOW, "Europe/London"));
    return null;
  }
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <Grab />
    </DictProvider>,
  );
  if (out === null) throw new Error("the formatter was never built");
  return out;
}

/** The tile of a colour, whole. */
const tile = (h: string, colour: "white" | "black") => new RegExp(`<figure[^>]*data-testid="md-camera-tile"[^>]*data-colour="${colour}"[^>]*>[\\s\\S]*?</figure>`).exec(h)?.[0] ?? "";
const viewOf = (h: string, colour: "white" | "black") => /data-view="([a-zA-Z]+)"/.exec(tile(h, colour))?.[1] ?? null;
const wordOf = (h: string, colour: "white" | "black") => /data-testid="md-camera-word"[^>]*>([^<]*)</.exec(tile(h, colour))?.[1] ?? null;

// ---- which state a tile is in -----------------------------------------------------------------------------------------------------------

describe("tileView: the board's own facts first, then what the join answered", () => {
  it("EMPTY CASE FIRST: a watchable side no join has answered yet is `connecting` - never idle, never an empty tile", () => {
    expect(tileView(LIVE_BOARD, "home", new Map()).kind).toBe("connecting");
    expect(tileView(LIVE_BOARD, "away", new Map()).kind).toBe("connecting");
  });

  it("a side the shell joined reads the join's answer, by ITS key (home and away are not swapped)", () => {
    const views = viewsOf(LIVE_BOARD, { home: WATCHING, away: { kind: "unavailable" } });
    expect(tileView(LIVE_BOARD, "home", views).kind).toBe("watching");
    expect(tileView(LIVE_BOARD, "away", views).kind).toBe("unavailable");
    // Another board's views are not this board's.
    const other = viewsOf({ fixtureId: "elsewhere" }, { home: WATCHING, away: WATCHING });
    expect(tileView(LIVE_BOARD, "home", other).kind, "not this board's key").toBe("connecting");
  });

  it("(sweep) policy x override x state x side meeting: the order of reading, typed from the Arbiter Panel's own", () => {
    type Cell = { label: string; board: ArbiterBoard; expect: string };
    const done = withState({ kind: "result", score: "1-0", noResult: false }, { fixtureId: "b-cam", cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const base = (over: Partial<ArbiterBoard>) => ({ ...LIVE_BOARD, ...over });
    const cells: Cell[] = [
      { label: "policy off wins over everything", board: base({ cameraPolicy: "off", videoOverridden: true }), expect: "none" },
      { label: "let go without video", board: base({ videoOverridden: true }), expect: "overridden" },
      { label: "the game is over", board: done, expect: "over" },
      { label: "over beats a side that never arrived", board: { ...done, sides: { home: meeting(), away: meeting() } }, expect: "over" },
      { label: "no meeting for the side", board: base({ sides: { home: meeting(), away: joinable() } }), expect: "notStarted" },
      { label: "open but the player has not been counted in (pre-minted room)", board: base({ sides: { home: present("live"), away: joinable() } }), expect: "notStarted" },
      { label: "the meeting ended", board: base({ sides: { home: { ...joinable(), state: "ended" }, away: joinable() } }), expect: "ended" },
      { label: "watchable, no join answered", board: base({}), expect: "connecting" },
    ];
    let checked = 0;
    for (const c of cells) {
      expect(tileView(c.board, "home", new Map()).kind, c.label).toBe(c.expect);
      checked += 1;
    }
    expect(checked, "every row of the table was checked").toBe(cells.length);
    // A join's answer never beats a board fact: a stale `watching` for a side that is no longer watchable reads the fact.
    const stale = viewsOf(LIVE_BOARD, { home: WATCHING });
    expect(tileView(base({ sides: { home: meeting(), away: joinable() } }), "home", stale).kind).toBe("notStarted");
    expect(tileView(done, "home", viewsOf(done, { home: WATCHING })).kind).toBe("over");
    expect(tileView(base({ videoOverridden: true }), "home", stale).kind).toBe("overridden");
  });

  it("anyUnavailable: either side's join answering `unavailable` is the outage; a side that is not watchable is not (its answer is stale)", () => {
    expect(anyUnavailable(LIVE_BOARD, new Map())).toBe(false);
    expect(anyUnavailable(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: WATCHING, away: WATCHING }))).toBe(false);
    expect(anyUnavailable(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: WATCHING, away: { kind: "unavailable" } }))).toBe(true);
    expect(anyUnavailable(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: { kind: "unavailable" } }))).toBe(true);
    const notHere = { ...LIVE_BOARD, sides: { home: joinable(), away: meeting() } };
    expect(anyUnavailable(notHere, viewsOf(notHere, { away: { kind: "unavailable" } }))).toBe(false);
  });
});

// ---- the word of a state -------------------------------------------------------------------------------------------------------------------

describe("tileWord: one word per state, the dictionary's", () => {
  const f = fmtOf();
  it("(sweep) every kind a tile can be in has its own word, from the key the rule names", () => {
    const cases: [ArbiterVideoView, string][] = [
      [{ kind: "idle" }, "arbiter.tile.connecting"],
      [{ kind: "connecting" }, "arbiter.tile.connecting"],
      [{ kind: "switching" }, "arbiter.tile.connecting"],
      [{ kind: "notStarted" }, "arbiter.tile.notCheckedIn"],
      [{ kind: "busy" }, "arbiter.tile.busy"],
      [{ kind: "none" }, "arbiter.tile.noCamera"],
      [{ kind: "overridden" }, "arbiter.tile.overridden"],
      [{ kind: "over" }, "arbiter.tile.over"],
      [{ kind: "ended" }, "arbiter.tile.over"],
      [{ kind: "unavailable" }, "arbiter.tile.unavailable"],
      [{ kind: "fault" }, "arbiter.tile.fault"],
      [{ kind: "error" }, "arbiter.tile.error"],
      [{ kind: "own" }, "arbiter.tile.own"],
      [{ kind: "watching", tile: { present: true, live: true, offSinceMs: null, track: null } }, "arbiter.tile.live"],
      [{ kind: "watching", tile: { present: false, live: false, offSinceMs: null, track: null } }, "arbiter.tile.absent"],
      [{ kind: "watching", tile: { present: true, live: false, offSinceMs: null, track: null } }, "arbiter.tile.off"],
    ];
    for (const [view, key] of cases) expect(tileWord(view, f).text, `${view.kind} -> ${key}`).toBe(t(key));
    expect(cases.length, "every kind of ArbiterVideoView, plus the three watching faces").toBe(16);
    expect(new Set(cases.map(([v]) => v.kind)).size, "all 14 kinds are covered").toBe(14);
  });

  it("'camera off since' is the venue's time of day for the instant THIS browser first saw it off (Europe/London = UTC in November)", () => {
    const view: ArbiterVideoView = { kind: "watching", tile: { present: true, live: false, offSinceMs: NOW - 5 * MIN, track: null } };
    expect(tileWord(view, f).text).toBe(t("arbiter.tile.offSince", { time: "17:55" }));
  });

  it("busy is not a failure's colour: it waits (the check-in line has first call on the vendor), the pair of unavailable", () => {
    expect(tileWord({ kind: "busy" }, f).tone).toBe("wait");
    expect(tileWord({ kind: "unavailable" }, f).tone).toBe("bad");
    expect(tileWord({ kind: "error" }, f).tone).toBe("bad");
  });
});

// ---- the tiles ----------------------------------------------------------------------------------------------------------------------------

describe("BoardCameras: two tiles, White first", () => {
  it("a live board opens UNFOLDED: a video box per tile, each with the player's name, colour and presence mark", () => {
    const h = render(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: WATCHING, away: WATCHING }));
    expect(count(h, "md-camera-tile")).toBe(2);
    expect(tagOf(h, "md-cameras")).toContain('data-folded="false"');
    expect((h.match(/aspect-video/g) ?? []).length, "a video box per tile").toBe(2);
    expect((h.match(/<video/g) ?? []).length, "a live tile draws the player's video, muted").toBe(2);
    expect(h).toContain("muted");
    expect(tile(h, "white")).toContain(esc("Ada Lovelace"));
    expect(tile(h, "black")).toContain(esc("Ben Carson"));
    expect(tile(h, "white")).toContain(esc(t("arbiter.colour.white")));
    expect(tile(h, "black")).toContain(esc(t("arbiter.colour.black")));
    expect(count(tile(h, "white"), "md-presence")).toBe(1);
    expect(count(tile(h, "black"), "md-presence")).toBe(1);
  });

  it("White is the LEFT tile whoever holds which seat: the tile follows the colour, and the side behind it follows `whiteSide`", () => {
    const swapped = { ...LIVE_BOARD, whiteSide: "away" as const, sides: { home: joinable("off"), away: joinable("live") } };
    const h = render(swapped, viewsOf(swapped, { home: WATCHING, away: { kind: "unavailable" } }));
    const order = [...h.matchAll(/data-testid="md-camera-tile"[^>]*data-colour="(white|black)"[^>]*data-side="(home|away)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(order, "White first, on the away seat now").toEqual(["white:away", "black:home"]);
    // Each tile reads ITS side's answer, and ITS side's presence mark: White (away) is live and unavailable, Black (home) is camera-off and watching.
    expect(viewOf(h, "white")).toBe("unavailable");
    expect(viewOf(h, "black")).toBe("watching");
    expect(/data-mark="(here|off|away)"/.exec(tile(h, "white"))?.[1]).toBe("here");
    expect(/data-mark="(here|off|away)"/.exec(tile(h, "black"))?.[1]).toBe("off");
  });

  it("a tile that is not live says why in ONE word (the dictionary's), and draws no video", () => {
    const b = { ...LIVE_BOARD, sides: { home: joinable(), away: meeting() } };
    const h = render(b, viewsOf(b, { home: { kind: "busy" } }));
    expect(viewOf(h, "white")).toBe("busy");
    expect(wordOf(h, "white")).toBe(esc(t("arbiter.tile.busy")));
    expect(viewOf(h, "black"), "the side whose player has not arrived").toBe("notStarted");
    expect(wordOf(h, "black")).toBe(esc(t("arbiter.tile.notCheckedIn")));
    expect(h, "no video is drawn for either").not.toContain("<video");
    expect(count(h, "md-camera-retry"), "busy retries by itself: no button").toBe(0);
  });

  it("a camera that is off keeps the box and says since when", () => {
    const view: ArbiterVideoView = { kind: "watching", tile: { present: true, live: false, offSinceMs: NOW - 5 * MIN, track: null } };
    const h = render(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: view, away: WATCHING }));
    expect(wordOf(h, "white")).toBe(esc(t("arbiter.tile.offSince", { time: "17:55" })));
    expect(tile(h, "white")).toContain("border-[#f5d27a]");
    expect(tile(h, "black"), "the other tile is not marked").not.toContain("border-[#f5d27a]");
  });

  it("'Try again' is offered for an error and a fault ONLY, and presses with that tile's own meeting key", () => {
    let checked = 0;
    for (const kind of ["error", "fault", "busy", "unavailable", "notStarted", "own", "connecting"] as const) {
      const h = render(LIVE_BOARD, viewsOf(LIVE_BOARD, { home: { kind } as ArbiterVideoView, away: WATCHING }));
      expect(count(h, "md-camera-retry"), kind).toBe(kind === "error" || kind === "fault" ? 1 : 0);
      checked += 1;
    }
    expect(checked).toBe(7);
    // Wired: each tile's press hands ITS meeting key to the shell (White's is the home side here).
    const onRetry = vi.fn();
    const ui = renderIsland(BoardCameras, { board: toRow(LIVE_BOARD), views: viewsOf(LIVE_BOARD, { home: { kind: "error" }, away: { kind: "fault" } }), f: fmtOf(), dict, onRetry, folded: false, bodyId: "cams-body" });
    const presses = ui.tree().filter((e) => propsOf(e)["data-testid"] === "md-camera-retry");
    expect(presses, "one per failed tile").toHaveLength(2);
    for (const press of presses) (propsOf(press).onClick as () => void)();
    expect(onRetry.mock.calls).toEqual([["b-cam:home"], ["b-cam:away"]]);
  });

  it("a 43-character name keeps the tile inside its column: truncated with its full text in the title, min-w-0 down the chain", () => {
    const long = "Bartholomew-Alexander Montgomery-Featherst."; // 43
    expect(long).toHaveLength(43);
    const b = { ...LIVE_BOARD, white: { name: long, personId: null } };
    const h = render(b, viewsOf(b, { home: WATCHING, away: WATCHING }));
    const white = tile(h, "white");
    expect(white).toContain(`title="${long}"`);
    expect(white).toMatch(/class="min-w-0 truncate"/);
    expect(tagOf(h, "md-cameras")).toContain("min-w-0");
    expect(tagOf(white, "md-camera-tile")).toContain("min-w-0");
  });
});

describe("BoardCameras: the fold (the PANEL's state: a held board opens folded - board-focus.test.tsx; the press is the state row's - CamerasToggle below)", () => {
  const heldBoard = held(1, { fixtureId: "b-held", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });

  it("FOLDED (MD-R33): one status line - a colour square, the presence mark and the word per tile, no video box, no <video>, and NO toggle in the strip (it is on the state row)", () => {
    const h = render(heldBoard, viewsOf(heldBoard, { home: WATCHING, away: WATCHING }), undefined, true);
    expect(tagOf(h, "md-cameras")).toContain('data-folded="true"');
    expect(h).not.toContain("aspect-video");
    expect(h).not.toContain("<video");
    expect(count(h, "md-cameras-toggle"), "the strip carries no toggle of its own").toBe(0);
    expect(wordOf(h, "white")).toBe(esc(t("arbiter.tile.live")));
    expect(count(h, "md-camera-colour"), "a colour square per tile").toBe(2);
    // The square is for the eye; the name and the colour are the tile's title and its screen-reader text.
    let checked = 0;
    for (const [colour, who, word] of [["white", "Ada Lovelace", "arbiter.colour.white"], ["black", "Ben Carson", "arbiter.colour.black"]] as const) {
      const fig = tile(h, colour);
      expect(fig, `${colour}: the title names the colour and the player`).toContain(`title="${esc(t(word))} · ${esc(who)}"`);
      expect(fig, `${colour}: and the screen-reader text`).toMatch(new RegExp(`class="sr-only">${esc(t(word))} · ${esc(who)}`));
      expect(fig, `${colour}: the square is hidden from a screen reader`).toMatch(/data-testid="md-camera-colour"/);
      checked += 1;
    }
    expect(checked).toBe(2);
    expect(tile(h, "white")).toContain("bg-white");
    expect(tile(h, "black")).toContain("bg-slate-900");
  });

  it("folded is ONE line (the MD-R33 budget): a wrapping row below lg and NO wrap from lg (B10: the height cannot depend on the font), each word cut with its whole text in the title, and the body drops out of the box tree so both tiles are siblings in it", () => {
    const h = render(heldBoard, viewsOf(heldBoard, { home: WATCHING, away: WATCHING }), undefined, true);
    expect(tagOf(h, "md-cameras")).toMatch(/class="[^"]*\bflex-wrap\b/);
    expect(tagOf(h, "md-cameras"), "from lg the row does not wrap").toMatch(/class="[^"]*\blg:flex-nowrap\b/);
    let words = 0;
    for (const colour of ["white", "black"] as const) {
      const word = /<span data-testid="md-camera-word"[^>]*>/.exec(tile(h, colour))![0];
      expect(word, `${colour}: from lg the word is cut, not wrapped`).toMatch(/class="[^"]*\blg:truncate\b/);
      expect(word, `${colour}: and the whole word is the title`).toContain(`title="${esc(t("arbiter.tile.live"))}"`);
      words += 1;
    }
    expect(words, "both tiles were read").toBe(2);
    expect(/<div id="cams-body" class="([^"]*)"/.exec(h)![1], "the body is out of the box tree").toBe("contents");
  });

  it("UNFOLDED: a video box per tile, the player's name VISIBLE (not screen-reader only) under it, the body a grid - whatever the board's state", () => {
    let checked = 0;
    for (const board of [live(3, { ...LIVE_BOARD }), heldBoard, withState({ kind: "checking_in" }, { ...LIVE_BOARD, state: { kind: "checking_in" } }), withState({ kind: "result", score: "1-0", noResult: false }, { ...LIVE_BOARD, state: { kind: "result", score: "1-0", noResult: false } })]) {
      const h = render(board, new Map(), undefined, false);
      expect(tagOf(h, "md-cameras"), board.state.kind).toContain('data-folded="false"');
      expect(/<div id="cams-body" class="([^"]*)"/.exec(h)![1], board.state.kind).toContain("grid");
      expect((h.match(/aspect-video/g) ?? []).length, `${board.state.kind}: a video box per tile`).toBe(2);
      expect(h, `${board.state.kind}: the name is visible`).toContain(`>${esc(board.white.name)}<`);
      expect(h, `${board.state.kind}: not screen-reader only`).not.toMatch(/class="sr-only">(White|Black) · /);
      expect(count(h, "md-cameras-toggle"), "and no toggle in the strip").toBe(0);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("CamerasToggle: the fold's one press (it lives on the state row, MD-R36)", () => {
  const toggleOf = (folded: boolean, onToggle: () => void = () => {}, className?: string) =>
    renderIsland(CamerasToggle, { folded, onToggle, controlsId: "cams-body", f: fmtOf(), ...(className === undefined ? {} : { className }) });
  const btn = (ui: ReturnType<typeof toggleOf>) => ui.tree().find((e) => propsOf(e)["data-testid"] === "md-cameras-toggle")!;

  it("says what it will do: Show video while folded (aria-expanded false), Hide video while open (true); it names the strip it controls", () => {
    const folded = toggleOf(true);
    expect(propsOf(btn(folded))["aria-expanded"]).toBe(false);
    expect(propsOf(btn(folded))["aria-controls"]).toBe("cams-body");
    expect(folded.text()).toBe(t("matchDay.cameras.show"));
    const open = toggleOf(false);
    expect(propsOf(btn(open))["aria-expanded"]).toBe(true);
    expect(open.text()).toBe(t("matchDay.cameras.hide"));
  });

  it("a press calls onToggle once; it is a phone-sized tap below lg (44px) and keeps its footprint small from lg; a class from outside (the phone's hide) is kept", () => {
    const calls: number[] = [];
    const ui = toggleOf(true, () => calls.push(1), "max-lg:hidden");
    (propsOf(btn(ui)).onClick as () => void)();
    expect(calls).toEqual([1]);
    const cls = String(propsOf(btn(ui)).className);
    expect(cls).toMatch(/max-lg:min-h-11/);
    expect(cls.split(/\s+/), "the caller's class is kept").toContain("max-lg:hidden");
    const plain = String(propsOf(btn(toggleOf(true))).className);
    expect(plain, "no stray space without one").toBe(plain.trim());
  });
});

describe("the copy the cameras add exists in every language", () => {
  const KEYS = ["arbiter.tile.notCheckedIn", "arbiter.tile.busy", "matchDay.cameras.group", "matchDay.cameras.show", "matchDay.cameras.hide", "matchDay.cameras.switch", "matchDay.cameras.viewCameras", "matchDay.cameras.viewBoard"];
  it("each new key has its own words in en, es, fr and nl, translated and not copied (a sweep, with its count)", () => {
    let checked = 0;
    for (const [name, d] of [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      for (const key of KEYS) {
        const value = (d as Record<string, string>)[key];
        expect(value, `${name} ${key}`).toBeTypeOf("string");
        expect(value!.length, `${name} ${key}`).toBeGreaterThan(2);
        if (name !== "en") expect(value, `${name} ${key} is translated, not copied`).not.toBe(EN[key]);
        checked += 1;
      }
    }
    expect(checked).toBe(KEYS.length * 4);
  });
});
