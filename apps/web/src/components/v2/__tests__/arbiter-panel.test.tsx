// T15 — the arbiter panel as painted (server render of the pure screen with
// the REAL dictionaries), built to the owner-approved canvas (ArbiterPhone,
// ArbiterDesktop on https://claude.ai/artifact/JKzKrtjSAPiU3QsFiRkEew).
// Effects do not run here (`environment: "node"`): the camera join, the
// polling and the clicks are the e2e's (e2e/arbiter-panel.spec.ts). What this
// suite owns: which copy each state paints — the canvas's own sentences as
// the expected values — every flag kind and its empty case, which decision
// controls each board offers, and that no untranslated key reaches the page
// in any locale.
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { ArbiterBoard, ArbiterFlag, ArbiterRound, NoResultOffer } from "@/lib/arbiter-view";
import { initialArbiterDecision, type ArbiterDecisionState } from "../arbiter-decision";
import {
  ArbiterPanel,
  ArbiterScreen,
  arbiterJoinStateFromError,
  arbiterWatchRelease,
  nextOffSince,
  shouldJoinVideo,
  showsOutageCard,
  type ArbiterScreenProps,
  type ArbiterVideoView,
} from "../arbiter-panel";
import { ApiV1Error } from "@/lib/client-v1";
// The container's first render (effects never run here): only the router's
// existence is needed.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { ArbiterGuardError } from "../arbiter-camera";

const LOCALES = { en, es, fr, nl } as const;

/** A local wall-clock time today: the panel paints the VIEWER's time of day,
 *  so building the instant from local fields keeps the test TZ-independent. */
const at = (h: number, m: number, s = 0) => new Date(2026, 9, 12, h, m, s).toISOString();
const NOW = Date.parse(at(19, 44));

const outOfBand = (plies: { from: number; to: number } | null): ArbiterFlag => ({
  id: "fl-oob",
  kind: "out_of_band_play",
  at: at(19, 38),
  plies,
});
const PRIYA_REPORT: ArbiterFlag = {
  id: "fl-cam",
  kind: "camera_lost",
  at: at(19, 41),
  personName: "Priya Raghunathan",
  windowFrom: at(19, 18),
  report: {
    offSeconds: 189,
    windowSeconds: 21 * 60,
    intervals: [{ from: at(19, 31, 5), to: at(19, 34, 14), confirmedByEvents: true }],
    connections: 2,
    sessions: 1,
  },
};

function board(over: Partial<ArbiterBoard> & Pick<ArbiterBoard, "fixtureId" | "boardNo">): ArbiterBoard {
  return {
    fixtureNo: over.boardNo + 10,
    white: { name: "Jonah Mbeki", personId: "p-w" },
    black: { name: "Elif Demirtaş", personId: "p-b" },
    state: { kind: "live", moveNo: 31 },
    clock: { whiteMs: 185_000, blackMs: 257_000, asOf: at(19, 44), running: false, turn: "white" },
    cameraPolicy: "required",
    videoOverridden: false,
    cameraReport: null,
    canResync: true,
    playable: true,
    canSettle: true,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    flags: [],
    ...over,
  };
}

/** The canvas's round: five boards in five states. */
const ROUND: ArbiterRound = {
  stageId: "st1",
  stageName: "Open Swiss",
  roundNo: 3,
  timeControl: "10+5",
  ownBoards: 0,
  current: true,
  boards: [
    board({ fixtureId: "f1", boardNo: 1, white: { name: "Ada Okonkwo", personId: "a" }, black: { name: "Tomasz Wieczorek", personId: "b" }, state: { kind: "live", moveNo: 23 } }),
    board({
      fixtureId: "f2",
      boardNo: 2,
      white: { name: "Maximiliana Wolfeschlegel-Featherstonehaugh", personId: "c" },
      black: { name: "Priya Raghunathan", personId: "d" },
      state: { kind: "result", score: "1–0", noResult: false },
      canResync: false,
      playable: false,
      canSettle: false,
      cameraReport: "settled",
      flags: [PRIYA_REPORT],
    }),
    board({ fixtureId: "f3", boardNo: 3, cameraReport: "pending", flags: [outOfBand({ from: 51, to: 53 })] }),
    board({ fixtureId: "f4", boardNo: 4, white: { name: "Sven Halvorsen", personId: "e" }, black: { name: "Grace Achterberg", personId: "f" }, state: { kind: "checking_in" }, clock: null, canResync: false }),
    board({ fixtureId: "f5", boardNo: 5, white: { name: "Rafael Quintero", personId: "g" }, black: { name: "Mei Lin Chu", personId: "h" }, state: { kind: "on_hold" } }),
  ],
};

const WATCHING: ArbiterVideoView = {
  kind: "watching",
  white: { present: true, live: true, offSinceMs: null, track: null },
  black: { present: true, live: false, offSinceMs: Date.parse(at(19, 42)), track: null },
};

const noop = () => undefined;
function props(over: Partial<ArbiterScreenProps> = {}): ArbiterScreenProps {
  return {
    round: ROUND,
    requested: null,
    decision: initialArbiterDecision("f3"),
    video: WATCHING,
    nowMs: NOW,
    slugs: { org: "club", comp: "autumn", div: "open" },
    on: { select: noop, resync: noop, goOn: noop, toggleSettle: noop, settle: noop, override: noop, retryVideo: noop },
    ...over,
  };
}

function html(p: ArbiterScreenProps, locale: keyof typeof LOCALES = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <ArbiterScreen {...p} />
    </DictProvider>,
  );
}
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The page's text, tags as spaces, whitespace collapsed. */
const text = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** The en dictionary is the copy authority beside the canvas. */
const EN = en as Record<string, string>;
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("the empty cases first", () => {
  it("no round open: says so, with the D8 sentence that flags are recorded anyway — and offers nothing to press", () => {
    const h = html(props({ round: null, decision: initialArbiterDecision(null), video: { kind: "idle" } }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.empty.title"]);
    expect(t).toContain(EN["arbiter.empty.body"]);
    expect(EN["arbiter.empty.body"]).toMatch(/whether or not anyone is watching/);
    expect(t).not.toContain(EN["arbiter.boardsHeading"]);
    expect(count(h, "<button"), "nothing to press").toBe(0);
    expect(h).toContain('href="/o/club/c/autumn/d/open?tab=fixtures"');
  });

  it("a round with no boards: says so, nothing to press", () => {
    const h = html(props({ round: { ...ROUND, boards: [] }, decision: initialArbiterDecision(null), video: { kind: "idle" } }));
    expect(text(h)).toContain(EN["arbiter.emptyBoards"]);
    expect(text(h)).not.toContain(EN["arbiter.ownRound"]);
    expect(count(h, "<button")).toBe(0);
  });

  it("C1: every board of the round is the viewer's own — the plain 'you're playing' state, never 'no boards', nothing to press or watch", () => {
    const h = html(props({ round: { ...ROUND, boards: [], ownBoards: 2 }, decision: initialArbiterDecision(null), video: { kind: "idle" } }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.ownRound"]);
    expect(EN["arbiter.ownRound"]).toMatch(/another organiser/);
    expect(t).not.toContain(EN["arbiter.emptyBoards"]);
    expect(count(h, "<button")).toBe(0);
    expect(count(h, "<figure"), "no tile").toBe(0);
  });

  it("a board with no flags says so; no pending card when no report is owed", () => {
    const h = html(props({ decision: initialArbiterDecision("f1") }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.flags.none"]);
    expect(t).not.toContain(EN["arbiter.flag.pending.chip"]);
  });
});

describe("notes above the round (re-review 1: N1, N3) — the empty case first", () => {
  const CURRENT = 'href="/o/club/c/autumn/d/open/arbiter"';
  const OLDER = EN["arbiter.olderRound"]!;
  const HIDDEN_ONE = EN["arbiter.ownHidden.one"]!;
  const HIDDEN_OTHER = EN["arbiter.ownHidden.other"]!;
  const notes = (h: string) => {
    const t = text(h);
    return {
      // The notes' box itself: never an empty one on screen.
      box: count(h, 'data-arbiter-notes=""'),
      older: t.includes(OLDER),
      currentLink: h.includes(CURRENT),
      hiddenOne: t.includes(HIDDEN_ONE),
      hiddenOther: t.includes(HIDDEN_OTHER.replace("{count}", "2")),
    };
  };
  const NONE = { box: 0, older: false, currentLink: false, hiddenOne: false, hiddenOther: false };

  it("the current round, nothing of the viewer's left out: no note, no link — the board as ever", () => {
    const h = html(props());
    expect(notes(h)).toEqual(NONE);
    expect(count(h, "<figure"), "the board is on screen").toBe(2);
  });

  it("N1: a pinned EARLIER round while a newer one is open — the plain line and the way to the current round, above the board still shown", () => {
    const h = html(props({ round: { ...ROUND, current: false } }));
    expect(notes(h)).toEqual({ ...NONE, box: 1, older: true, currentLink: true });
    expect(text(h)).toContain(EN["arbiter.requested.current"]);
    expect(count(h, "<figure"), "the pinned board stays on screen").toBe(2);
    expect(decode(h).indexOf(OLDER), "the note is in the markup").toBeGreaterThan(-1);
    expect(decode(h).indexOf(OLDER), "the note sits above the board").toBeLessThan(decode(h).indexOf("<figure"));
  });

  it("N1: an earlier round whose boards are all the viewer's own — still says a newer round is open", () => {
    const h = html(props({ round: { ...ROUND, current: false, boards: [], ownBoards: 1 }, decision: initialArbiterDecision(null), video: { kind: "idle" } }));
    expect(notes(h)).toEqual({ ...NONE, box: 1, older: true, currentLink: true });
    expect(text(h)).toContain(EN["arbiter.ownRound"]);
  });

  it("N3: some boards left out because the viewer plays on them — one line saying so (one, and more than one); none when nothing was left out", () => {
    const one = html(props({ round: { ...ROUND, ownBoards: 1 } }));
    expect(notes(one)).toEqual({ ...NONE, box: 1, hiddenOne: true });
    expect(count(text(one), HIDDEN_ONE), "one line").toBe(1);
    const two = html(props({ round: { ...ROUND, ownBoards: 2 } }));
    expect(notes(two)).toEqual({ ...NONE, box: 1, hiddenOther: true });
    expect(notes(html(props({ round: { ...ROUND, ownBoards: 0 } }))), "nothing left out").toEqual(NONE);
  });

  it("N3: EVERY board the viewer's own — the 'you're playing' state alone, never the line as well", () => {
    const h = html(props({ round: { ...ROUND, boards: [], ownBoards: 2 }, decision: initialArbiterDecision(null), video: { kind: "idle" } }));
    expect(notes(h)).toEqual(NONE);
    expect(text(h)).toContain(EN["arbiter.ownRound"]);
  });

  it("N1 + N3 together: both notes, one link", () => {
    const h = html(props({ round: { ...ROUND, current: false, ownBoards: 1 } }));
    expect(notes(h)).toEqual({ ...NONE, box: 1, older: true, currentLink: true, hiddenOne: true });
    expect(count(h, CURRENT)).toBe(1);
  });
});

describe("?fixture= — exactly that board, or said plainly (I3)", () => {
  const CURRENT = 'href="/o/club/c/autumn/d/open/arbiter"';
  it("a board that is not here: the plain sentence and a way to the current round — no board, no tile, nothing pressed", () => {
    const h = html(props({ round: null, requested: "unavailable", decision: initialArbiterDecision("gone"), video: { kind: "idle" } }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.requested.unavailable"]);
    expect(t).toContain(EN["arbiter.requested.current"]);
    expect(h).toContain(CURRENT);
    expect(t, "not the 'no round open' state").not.toContain(EN["arbiter.empty.title"]);
    expect(count(h, "<figure")).toBe(0);
    expect(count(h, "<button")).toBe(0);
  });

  it("C1: the viewer's own board, asked for by link: named as theirs, never opened", () => {
    const h = html(props({ round: null, requested: "own", decision: initialArbiterDecision("mine"), video: { kind: "idle" } }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.requested.own"]);
    expect(t).not.toContain(EN["arbiter.requested.unavailable"]);
    expect(h).toContain(CURRENT);
    expect(count(h, "<figure")).toBe(0);
  });

  it("the board on screen is not in the round (it left between the link and the read, or a refresh dropped it): said so — never the first board in its place", () => {
    const h = html(props({ decision: initialArbiterDecision("not-in-round") }));
    const t = text(h);
    expect(t).toContain(EN["arbiter.requested.unavailable"]);
    expect(h).toContain(CURRENT);
    expect(count(h, "<figure"), "no tile of another board").toBe(0);
    expect(h, "no board pressed").not.toContain('aria-pressed="true"');
    expect(t).not.toContain(EN["arbiter.emptyBoards"]);
    // The positive pair: a board that IS in the round opens.
    expect(count(html(props({ decision: initialArbiterDecision("f1") })), "<figure")).toBe(2);
  });
});

describe("the panel's first board (the container, first render)", () => {
  const panel = (initialFixtureId: string | null) =>
    renderToStaticMarkup(
      <DictProvider dict={en as unknown as Dict} locale="en">
        <ArbiterPanel round={ROUND} requested={null} slugs={{ org: "club", comp: "autumn", div: "open" }} initialFixtureId={initialFixtureId} />
      </DictProvider>,
    );
  const pressed = (h: string) => [...h.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));

  it("I3: the board asked for opens — and one not in the round is SAID, never the first board in its place", () => {
    expect(pressed(panel("f3")).map((l) => l.split(" · ")[0])).toEqual(["Board 3"]);
    const missing = panel("not-in-round");
    expect(text(missing)).toContain(EN["arbiter.requested.unavailable"]);
    expect(pressed(missing)).toEqual([]);
    expect(count(missing, "<figure")).toBe(0);
    // Nothing asked for: the first board.
    expect(pressed(panel(null)).map((l) => l.split(" · ")[0])).toEqual(["Board 1"]);
  });
});

describe("the header and the boards (canvas)", () => {
  it("back link, round line, title and the watch-only sentence (the owner's canvas line, hedged by T17B fix 2's ruling: what the rooms are set up to do, never a promise)", () => {
    const t = text(html(props()));
    expect(t).toContain("Back to run sheet");
    expect(t).toContain("Open Swiss · Round 3");
    expect(t).toContain("Arbiter");
    expect(t).toContain("You're watching. The players' rooms aren't set up to let them see or hear you, or to show each other.");
  });

  it("the desktop list: one button per board, labelled as the canvas labels them, the one on screen pressed", () => {
    const h = html(props());
    const buttons = [...h.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)];
    expect(buttons.length, "anti-vacuity: five boards").toBe(5);
    expect(buttons.map((b) => text(b[2]!))).toEqual([
      "Board 1 · live Ada Okonkwo vs Tomasz Wieczorek",
      "Board 2 · 1–0 · 1 flag Maximiliana Wolfeschlegel-Featherstonehaugh vs Priya Raghunathan",
      "Board 3 · live · 1 flag Jonah Mbeki vs Elif Demirtaş",
      "Board 4 · checking in Sven Halvorsen vs Grace Achterberg",
      "Board 5 · on hold Rafael Quintero vs Mei Lin Chu",
    ]);
    expect(buttons.map((b) => b[1])).toEqual(["false", "false", "true", "false", "false"]);
  });

  it("the phone picker: one option per board, names and flag count, the board on screen selected", () => {
    const h = html(props());
    const options = [...h.matchAll(/<option value="([^"]+)"( selected="")?>(.*?)<\/option>/g)];
    expect(options.length).toBe(5);
    expect(options.map((o) => decode(o[3]!))).toEqual([
      "Board 1 · Ada Okonkwo vs Tomasz Wieczorek",
      "Board 2 · Maximiliana Wolfeschlegel-Featherstonehaugh vs Priya Raghunathan · 1 flag",
      "Board 3 · Jonah Mbeki vs Elif Demirtaş · 1 flag",
      "Board 4 · Sven Halvorsen vs Grace Achterberg",
      "Board 5 · Rafael Quintero vs Mei Lin Chu",
    ]);
    expect(options.filter((o) => o[2]).map((o) => o[1])).toEqual(["f3"]);
  });

  it("the board on screen: its heading, 'Live · move 31', the clock '10+5', and both clocks", () => {
    const t = text(html(props()));
    expect(t).toContain("Board 3 · Jonah Mbeki vs Elif Demirtaş");
    expect(t).toContain("Live · move 31");
    expect(t).toContain("10+5");
    // 185 000 ms is 3:05 and 257 000 ms is 4:17 (the canvas's faces).
    expect(t).toContain("3:05");
    expect(t).toContain("4:17");
  });

  it("a running clock ticks from its last move; the other side's does not", () => {
    const b = { ...ROUND.boards[2]!, clock: { whiteMs: 185_000, blackMs: 257_000, asOf: at(19, 44), running: true, turn: "white" as const } };
    const t = text(html(props({ round: { ...ROUND, boards: [b] }, nowMs: NOW + 5_000 })));
    expect(t).toContain("3:00");
    expect(t).toContain("4:17");
  });

  it("every board state reads as the run sheet would say it", () => {
    const states: [ArbiterBoard["state"], string][] = [
      [{ kind: "checking_in" }, "Checking in"],
      [{ kind: "starting" }, "Starting"],
      [{ kind: "on_hold" }, "On hold"],
      [{ kind: "result", score: "½–½", noResult: false }, "Finished · ½–½"],
      [{ kind: "result", score: null, noResult: false }, "Finished"],
      // I-3: an abandoned board — VOID — reads No result, never a score.
      [{ kind: "result", score: null, noResult: true }, "Finished · No result"],
    ];
    let checked = 0;
    for (const [state, label] of states) {
      const b = { ...ROUND.boards[2]!, state };
      expect(text(html(props({ round: { ...ROUND, boards: [b] } }))), label).toContain(label);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("the two tiles", () => {
  it("watching: White's camera live, Black's off since the time this browser saw it go", () => {
    const h = html(props());
    const t = text(h);
    expect(count(t, "Camera live")).toBe(1);
    expect(t).toContain(`Camera off since ${hhmm(at(19, 42))}`);
    expect(t).toContain("Jonah Mbeki");
    expect(t).toContain("White");
    expect(t).toContain("Black");
    // The video element: muted, inline, autoplay — never sound.
    const videos = [...h.matchAll(/<video[^>]*>/g)].map((m) => m[0]);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatch(/muted=""/);
    expect(videos[0]).toMatch(/playsInline=""|playsinline=""/);
  });

  it("before mount no time of day is painted (the server's timezone is not the arbiter's)", () => {
    const t = text(html(props({ nowMs: null })));
    expect(t).not.toMatch(/Camera off since/);
    expect(t).toContain(EN["arbiter.tile.off"]);
    expect(t).not.toContain("Found at");
  });

  it("each video state paints its own sentence on both tiles", () => {
    const cases: [ArbiterVideoView, string][] = [
      [{ kind: "idle" }, EN["arbiter.tile.connecting"]!],
      [{ kind: "connecting" }, EN["arbiter.tile.connecting"]!],
      [{ kind: "none" }, EN["arbiter.tile.noCamera"]!],
      [{ kind: "overridden" }, EN["arbiter.tile.overridden"]!],
      [{ kind: "over" }, EN["arbiter.tile.over"]!],
      [{ kind: "ended" }, EN["arbiter.tile.over"]!],
      [{ kind: "unavailable" }, EN["arbiter.tile.unavailable"]!],
      [{ kind: "fault" }, EN["arbiter.tile.fault"]!],
      [{ kind: "error" }, EN["arbiter.tile.error"]!],
      [{ kind: "own" }, EN["arbiter.tile.own"]!],
      [
        { kind: "watching", white: { present: false, live: false, offSinceMs: null, track: null }, black: { present: false, live: false, offSinceMs: null, track: null } },
        EN["arbiter.tile.absent"]!,
      ],
    ];
    let checked = 0;
    for (const [video, sentence] of cases) {
      const h = html(props({ video }));
      const tiles = [...h.matchAll(/<figure[\s\S]*?<\/figure>/g)].map((m) => text(m[0]));
      expect(tiles, `${video.kind}: two tiles`).toHaveLength(2);
      for (const tile of tiles) expect(count(tile, sentence), video.kind).toBe(1);
      expect(count(h, "<video"), `${video.kind}: no video element`).toBe(0);
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("a fault or an error offers ONE retry; no other state does", () => {
    let checked = 0;
    for (const kind of ["fault", "error", "connecting", "unavailable", "none", "own"] as const) {
      const t = text(html(props({ video: { kind } })));
      expect(count(t, EN["arbiter.tile.retry"]!), kind).toBe(kind === "fault" || kind === "error" ? 1 : 0);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("flags on this board (canvas cards)", () => {
  it("heading for phone and desktop, the lede, and Moves made off Seazn as the canvas words it", () => {
    const t = text(html(props()));
    expect(t).toContain("Flags on this board");
    expect(t).toContain("Flags on Board 3");
    expect(t).toContain("Evidence for you to review. Nothing here changes a result by itself.");
    expect(t).toContain("Moves made off Seazn");
    // Plies 51–53: three plies, moves 26 to 27 (FIDE: ply 2N-1 is White's move N).
    expect(t).toContain("3 moves reached Lichess that were not played on Seazn's board (moves 26 to 27).");
    expect(t).toContain(`Found at ${hhmm(at(19, 38))}`);
  });

  it("one ply, two plies of one move, and an unreadable note each read honestly", () => {
    const cases: [{ from: number; to: number } | null, string][] = [
      [{ from: 9, to: 9 }, "1 move reached Lichess that was not played on Seazn's board (move 5)."],
      [{ from: 9, to: 10 }, "2 moves reached Lichess that were not played on Seazn's board (move 5)."],
      [null, EN["arbiter.flag.outOfBand.unread"]!],
    ];
    let checked = 0;
    for (const [plies, sentence] of cases) {
      const b = { ...ROUND.boards[2]!, flags: [outOfBand(plies)] };
      expect(text(html(props({ round: { ...ROUND, boards: [b] } })))).toContain(sentence);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the camera report card, word for word, with its timeline", () => {
    const b = { ...ROUND.boards[2]!, flags: [PRIYA_REPORT] };
    const h = html(props({ round: { ...ROUND, boards: [b] } }));
    const t = text(h);
    expect(t).toContain("Camera off · 3 min 9 s of 21 min");
    expect(t).toContain(`Priya Raghunathan: off ${hhmmss(at(19, 31, 5))} to ${hhmmss(at(19, 34, 14))}.`);
    // Gender-neutral (the canvas's "Her" is the sample's, not a rule).
    expect(t).toContain(EN["arbiter.flag.cameraOff.agree"]);
    expect(t).toContain("From 2 camera connections in 1 session.");
    expect(t).toContain(`${hhmm(at(19, 18))} first move`);
    expect(t).toContain(`${hhmm(at(19, 39))} game over`);
    expect(t).toContain(`${hhmm(at(19, 18))} start`);
    expect(t).toContain(`${hhmm(at(19, 39))} end`);
    // 19:31:05 is 785 s into a 1 260 s window; the gap is 189 s.
    const seg = /left:(\d+(?:\.\d+)?)%;width:(\d+(?:\.\d+)?)%/.exec(h.replace(/\s/g, ""));
    expect(seg, "one segment painted").not.toBeNull();
    expect(Number(seg![1])).toBeCloseTo((785 / 1260) * 100, 1);
    expect(Number(seg![2])).toBeCloseTo((189 / 1260) * 100, 1);
  });

  it("the agree sentence only when EVERY interval's own events agree; plural sessions", () => {
    const report = { ...(PRIYA_REPORT as Extract<ArbiterFlag, { kind: "camera_lost" }>).report!, sessions: 2 };
    const mixed: ArbiterFlag = {
      ...(PRIYA_REPORT as Extract<ArbiterFlag, { kind: "camera_lost" }>),
      report: {
        ...report,
        intervals: [...report.intervals, { from: at(19, 36), to: at(19, 37), confirmedByEvents: false }],
      },
    };
    const b = { ...ROUND.boards[2]!, flags: [mixed] };
    const t = text(html(props({ round: { ...ROUND, boards: [b] } })));
    expect(t).not.toContain(EN["arbiter.flag.cameraOff.agree"]);
    expect(t).toContain("From 2 camera connections in 2 sessions.");
    expect(t).toContain(`${hhmmss(at(19, 36))} to ${hhmmss(at(19, 37))}`);
  });

  it("an unreadable camera report says so in general words — never a guessed number", () => {
    const b = { ...ROUND.boards[2]!, flags: [{ ...PRIYA_REPORT, report: null } as ArbiterFlag] };
    const t = text(html(props({ round: { ...ROUND, boards: [b] } })));
    expect(t).toContain(EN["arbiter.flag.cameraOff.unread"]!.replace("{name}", "Priya Raghunathan"));
    expect(t).not.toMatch(/\d+ min \d+ s/);
  });

  it("camera connection problems: the neutral card, its duration from the loader's seconds", () => {
    const flag: ArbiterFlag = { id: "fl-cc", kind: "camera_connection_problems", at: at(19, 40), personName: "Elif Demirtaş", seconds: 90.4, stamps: 3 };
    const b = { ...ROUND.boards[2]!, flags: [flag] };
    const h = html(props({ round: { ...ROUND, boards: [b] } }));
    const t = text(h);
    expect(t).toContain("Camera connection problems (our side) — 1 min 30 s");
    expect(t).toContain(EN["arbiter.flag.connection.body.other"]!.replace("{name}", "Elif Demirtaş").replace("{count}", "3"));
  });

  it("camera connection problems with no match window to read the stamps over: still shown, plainly — never a made-up duration", () => {
    const flag: ArbiterFlag = { id: "fl-cc", kind: "camera_connection_problems", at: at(19, 40), personName: "Elif Demirtaş", seconds: null, stamps: null };
    const b = { ...ROUND.boards[2]!, flags: [flag] };
    const t = text(html(props({ round: { ...ROUND, boards: [b] } })));
    expect(t).toContain(EN["arbiter.flag.connection.chipPlain"]);
    expect(t).toContain(EN["arbiter.flag.connection.unread"]!.replace("{name}", "Elif Demirtaş"));
    expect(t).not.toMatch(/\d+ s\b/);
  });

  // T17B fix 2, D9: a player connected from more than one place at once (job 5's multiple_devices). Expected copy from
  // the dictionary, the times from the flag's own instants in the viewer's clock (h23, as every flag card says them).
  const DEVICES: ArbiterFlag = {
    id: "fl-dev",
    kind: "multiple_devices",
    at: at(19, 41),
    personName: "Elif Demirtaş",
    report: { devices: 2, seconds: 340, intervals: [{ from: at(19, 31, 5), to: at(19, 36, 45) }] },
  };
  const fillEn = (key: string, slots: Record<string, string | number>) =>
    Object.entries(slots).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), EN[key]!);

  it("multiple devices (D9): the amber evidence card — the count on its chip, when, and why it matters; on a finished board 'Mark as reviewed' closes it", () => {
    const b = { ...ROUND.boards[1]!, flags: [DEVICES] };
    const h = html(props({ round: { ...ROUND, boards: [b] }, decision: initialArbiterDecision("f2") }));
    const t = text(h);
    expect(t).toContain(fillEn("arbiter.flag.devices.chip", { count: 2 }));
    const span = fillEn("arbiter.flag.cameraOff.span", { from: "19:31:05", to: "19:36:45" });
    expect(t).toContain(fillEn("arbiter.flag.devices.spans", { name: "Elif Demirtaş", count: 2, spans: span }));
    expect(t).toContain(EN["arbiter.flag.devices.why"]);
    expect(t).toContain(EN["externalPlay.queue.markReviewed"]);
    // Evidence about the player: the amber card, as camera_lost and out-of-band are — never our side's neutral one.
    expect(h).toMatch(/<article class="[^"]*border-\[#f5d27a\][^"]*"><span class="[^"]*bg-\[#fef3c7\][^"]*">2 devices at once</);
  });

  it("multiple devices (D9): before the clock is known no time is painted — the count sentence alone; an unreadable note says so plainly, never a guessed count", () => {
    const b = { ...ROUND.boards[1]!, flags: [DEVICES] };
    const early = text(html(props({ round: { ...ROUND, boards: [b] }, decision: initialArbiterDecision("f2"), nowMs: null })));
    expect(early).toContain(fillEn("arbiter.flag.devices.count", { name: "Elif Demirtaş", count: 2 }));
    expect(early).not.toContain("19:31:05");
    const unread = { ...ROUND.boards[1]!, flags: [{ ...DEVICES, report: null, personName: null } as ArbiterFlag] };
    const t = text(html(props({ round: { ...ROUND, boards: [unread] }, decision: initialArbiterDecision("f2") })));
    expect(t).toContain(EN["arbiter.flag.devices.chipPlain"]);
    expect(t).toContain(fillEn("arbiter.flag.devices.unread", { name: EN["arbiter.flag.aPlayer"]! }));
    expect(t).not.toContain(fillEn("arbiter.flag.devices.chip", { count: 2 }));
  });

  it("the pending card while the report is still to come, and not once it is settled", () => {
    const t = text(html(props()));
    expect(t).toContain("Camera report · pending");
    expect(t).toContain("How long each camera was off is measured after the game. It arrives about 2 minutes after the players leave.");
    const settled = { ...ROUND.boards[2]!, cameraReport: "settled" as const };
    expect(text(html(props({ round: { ...ROUND, boards: [settled] } })))).not.toContain("Camera report · pending");
  });

  it("another board's camera report sits beside this board (canvas 'Board 2 · camera report'); never this board's own, never another kind", () => {
    const t = text(html(props()));
    expect(t).toContain("Board 2 · camera report");
    expect(count(t, "Camera off · 3 min 9 s of 21 min")).toBe(1);
    // On Board 2 itself the report is in its own flags, not repeated.
    const t2 = text(html(props({ decision: initialArbiterDecision("f2") })));
    expect(t2).not.toContain("Board 2 · camera report");
    expect(count(t2, "Camera off · 3 min 9 s of 21 min")).toBe(1);
    // Board 3's out-of-band flag does not appear as a report on Board 2's view.
    expect(t2).not.toContain("Board 3 · camera report");
    expect(t2).not.toContain("Moves made off Seazn");
  });

  it("no sanction language anywhere on the panel", () => {
    const t = text(html(props())).toLowerCase();
    let checked = 0;
    for (const word of ["blocked", "banned", "cheat", "disqualif", "monitored", "penalt"]) {
      expect(t, word).not.toContain(word);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("your decision", () => {
  it("a live flagged board: Resync, Let the game go on, Settle the result now… — phone and desktop headings", () => {
    const h = html(props());
    const t = text(h);
    expect(t).toContain("Your decision");
    expect(t).toContain("Your decision · Board 3");
    for (const label of ["Resync from Lichess", "Let the game go on", "Settle the result now…"]) expect(t).toContain(label);
    expect(h).toMatch(/aria-expanded="false"[^>]*>Settle the result now…/);
  });

  // T16 fix round 1, R4: a FINISHED board's open flags stay closable — job 5 raises its camera flags after the game, so
  // a finished board is the usual home of one. Its words are the queue's ("Mark as reviewed"): the game cannot go on.
  it("which controls each board offers (resync needs a game at Lichess; a flag is closable, the game over or not; settling needs a game not over)", () => {
    const rows: [string, string[]][] = [
      ["f1", ["Resync from Lichess", "Settle the result now…"]],
      ["f2", ["Mark as reviewed"]],
      ["f3", ["Resync from Lichess", "Let the game go on", "Settle the result now…"]],
      ["f4", ["Settle the result now…"]],
      ["f5", ["Resync from Lichess", "Settle the result now…"]],
    ];
    const ALL = ["Resync from Lichess", "Let the game go on", "Mark as reviewed", "Settle the result now…"];
    let checked = 0;
    for (const [id, offered] of rows) {
      const t = text(html(props({ decision: initialArbiterDecision(id) })));
      for (const label of ALL) expect(t.includes(label), `${id}: ${label}`).toBe(offered.includes(label));
      if (offered.length === 0) expect(t, `${id}: no decision section`).not.toContain("Your decision");
      checked++;
    }
    expect(checked).toBe(5);
    // The empty case: a finished board with no open flag offers nothing at all.
    const bare = { ...ROUND, boards: ROUND.boards.map((b) => (b.fixtureId === "f2" ? { ...b, flags: [] } : b)) };
    expect(text(html(props({ round: bare, decision: initialArbiterDecision("f2") }))), "no flag: no decision").not.toContain("Your decision");
    // Every locale names it with the queue's own key.
    let locales = 0;
    for (const loc of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      expect(text(html(props({ decision: initialArbiterDecision("f2") }), loc)), loc).toContain(LOCALES[loc]["externalPlay.queue.markReviewed"]!);
      locales++;
    }
    expect(locales).toBe(4);
  });

  // T16: the disclosure settles the board itself (it used to link to the
  // match page). Canvas HoldQueueDesktop: "Settle the result" — "{name} wins"
  // ×2, "Draw", "No result"; a drawn knockout: "Pick the winner" — "{name}
  // goes through" ×2. The server settles by SIDE, so the white player's
  // button carries whichever side White is (the canvas names by colour).
  const settleButtons = (h: string) =>
    [...h.matchAll(/<button[^>]*data-settle="([a-z_]+)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1]!, text(m[2]!)] as const);

  it("settle opens to the four buttons, each sending its side — by which side White is", () => {
    const cases: [ArbiterBoard["whiteSide"], [string, string][]][] = [
      ["home", [["home_wins", "Jonah Mbeki wins"], ["away_wins", "Elif Demirtaş wins"], ["draw", "Draw"], ["no_result", "No result"]]],
      ["away", [["away_wins", "Jonah Mbeki wins"], ["home_wins", "Elif Demirtaş wins"], ["draw", "Draw"], ["no_result", "No result"]]],
    ];
    let checked = 0;
    for (const [whiteSide, expected] of cases) {
      const b = { ...ROUND.boards[2]!, whiteSide };
      const h = html(props({ round: { ...ROUND, boards: [b] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }));
      expect(h).toMatch(/aria-expanded="true"/);
      expect(h).toMatch(new RegExp(`<legend[^>]*>${EN["externalPlay.settle.legend"]}</legend>`));
      expect(text(h)).toContain(EN["arbiter.decide.settleBody"]);
      expect(settleButtons(h), whiteSide).toEqual(expected);
      expect(h, "a line that feeds a next match: no D19 guidance").not.toContain('data-testid="arbiter-settle-no-next-match"');
      expect(h, "no way off to the match page any more").not.toContain('href="/o/club/c/autumn/d/open/f/13"');
      checked++;
    }
    expect(checked).toBe(2);
  });

  // M-5 (fix round 4): the panel's side column is narrow (about 290px at 1280), and a truncated winner button read as
  // a bare name — "Maximiliana Fe…" — with the verb cut away, in a knockout the organiser's one decisive control. Every
  // settle button wraps instead, and takes a row of its own — except Draw and No result, the one pair that shares a row
  // (two short labels side by side). A Draw with no No result beside it (a knockout, a Swiss, a double walkover) spans
  // too, never left half-width alone.
  it("every settle button shows its whole label: no truncation anywhere; a row of its own unless Draw and No result share one — every offer and the tie-break, counted", () => {
    const b = { ...ROUND.boards[2]!, whiteSide: "home" as const };
    const buttonsOf = (h: string) => [...h.matchAll(/<button([^>]*)data-settle="([a-z_]+)"([^>]*)>/g)].map((m) => ({ choice: m[2]!, cls: `${m[1]} ${m[3]}` }));
    const cases: { name: string; tiebreakOwed: boolean; noResultOffer: NoResultOffer; buttons: number }[] = [
      { name: "the void offered", tiebreakOwed: false, noResultOffer: { kind: "void" }, buttons: 4 },
      { name: "No result refused (a knockout)", tiebreakOwed: false, noResultOffer: { kind: "refused", why: "knockout" }, buttons: 3 },
      { name: "No result refused (a Swiss)", tiebreakOwed: false, noResultOffer: { kind: "refused", why: "swiss" }, buttons: 3 },
      { name: "the double walkover offered", tiebreakOwed: false, noResultOffer: { kind: "double_walkover" }, buttons: 4 },
      { name: "a tie-break owed", tiebreakOwed: true, noResultOffer: { kind: "void" }, buttons: 2 },
    ];
    let own = 0;
    let shared = 0;
    for (const c of cases) {
      const h = html(props({ round: { ...ROUND, boards: [{ ...b, tiebreakOwed: c.tiebreakOwed, noResultOffer: c.noResultOffer }] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }));
      const buttons = buttonsOf(h);
      expect(buttons.length, `${c.name}: premise, the buttons render`).toBe(c.buttons);
      const pair = buttons.some((x) => x.choice === "no_result");
      for (const { choice, cls } of buttons) {
        const label = `${c.name}, ${choice}`;
        expect(cls, `${label}: never cut short`).not.toMatch(/\btruncate\b/);
        expect(cls, `${label}: wraps`).toMatch(/\bbreak-words\b/);
        if (pair && (choice === "draw" || choice === "no_result")) {
          expect(cls, `${label}: the shared row`).not.toMatch(/col-span-2/);
          shared++;
        } else {
          expect(cls, `${label}: a row of its own`).toMatch(/\bmin-\[360px\]:col-span-2\b/);
          own++;
        }
      }
    }
    // Own rows: 2 winners in each of the five cases, plus the lone Draw three times and the double walkover once.
    expect([own, shared]).toEqual([2 * 5 + 3 + 1, 2]);
  });

  it("a drawn knockout (tie-break owed) offers a winner only — never Draw or No result", () => {
    const b = { ...ROUND.boards[2]!, tiebreakOwed: true, whiteSide: "away" as const };
    const h = html(props({ round: { ...ROUND, boards: [b] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }));
    expect(text(h)).toContain(EN["externalPlay.settle.pickLegend"]);
    expect(text(h)).toContain(EN["arbiter.decide.tiebreakBody"]);
    expect(settleButtons(h)).toEqual([
      ["away_wins", "Jonah Mbeki goes through"],
      ["home_wins", "Elif Demirtaş goes through"],
    ]);
  });

  // I-3: where the server refuses No result — any knockout (a knockout game needs a winner) and a Swiss (fix round 3: a
  // Swiss round needs every game decided) — its own reading arrives as `noResultOffer`, so the settle never offers the
  // "No result" it would refuse with a 409, and says why in its place, in every locale.
  it("a refused No result (knockout, Swiss): not offered, and the guidance says why — each refusal, every locale, counted", () => {
    const b = { ...ROUND.boards[2]!, whiteSide: "away" as const };
    // The sentence for each refusal, typed from the rulings (never the component's own map).
    const SENTENCE = { knockout: "arbiter.decide.knockoutNeedsWinner", swiss: "arbiter.decide.swissNeedsResult" } as const;
    const open = (board: typeof b, loc?: keyof typeof LOCALES) =>
      html(props({ round: { ...ROUND, boards: [board] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }), loc);
    let cells = 0;
    for (const why of ["knockout", "swiss"] as const) {
      const refused = { ...b, noResultOffer: { kind: "refused" as const, why } };
      for (const loc of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
        const dict = LOCALES[loc] as Record<string, string>;
        const h = open(refused, loc);
        expect(settleButtons(h).map(([c]) => c), `${why}, ${loc}`).toEqual(["away_wins", "home_wins", "draw"]);
        const guide = h.match(/<p[^>]*data-testid="arbiter-settle-guidance"[^>]*data-why="([a-z]+)"[^>]*>(.*?)<\/p>/);
        expect(guide, `${why}, ${loc}: the guidance renders`).not.toBeNull();
        expect(guide![1], `${why}, ${loc}`).toBe(why);
        expect(text(guide![2]!), `${why}, ${loc}`).toBe(dict[SENTENCE[why]]);
        cells++;
      }
      // A drawn knockout: a winner only, as before — No result is never offered there, so no guidance.
      const owed = open({ ...refused, tiebreakOwed: true });
      expect(settleButtons(owed).map(([c]) => c), why).toEqual(["away_wins", "home_wins"]);
      expect(owed, why).not.toContain('data-testid="arbiter-settle-guidance"');
    }
    expect(cells).toBe(2 * 4);
    // The pair: where the void is offered, No result is there, and no guidance.
    const league = open({ ...b, noResultOffer: { kind: "void" } });
    expect(settleButtons(league).map(([c]) => c)).toEqual(["away_wins", "home_wins", "draw", "no_result"]);
    expect(league).not.toContain('data-testid="arbiter-settle-guidance"');
  });

  // I-3, fix round 3: both players absent, on a board W2b takes a double walkover on — the choice in place of a winner
  // is that double walkover, labelled as what it writes (never "No result"), on a row of its own so the longer label
  // is never cut short.
  it("both players absent: the settle offers W2b's double walkover by its own name, on its own row, uncut — every locale, counted; the void's button keeps \"No result\"", () => {
    const b = { ...ROUND.boards[2]!, whiteSide: "away" as const };
    const open = (board: typeof b, loc?: keyof typeof LOCALES) =>
      html(props({ round: { ...ROUND, boards: [board] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }), loc);
    // M-7 (fix round 4): each sends its OWN kind — the server refuses the other one as a stale screen's.
    const button = (h: string, choice: "no_result" | "double_walkover") => h.match(new RegExp(`<button([^>]*)data-settle="${choice}"([^>]*)>(.*?)</button>`));
    let locales = 0;
    for (const loc of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const dict = LOCALES[loc] as Record<string, string>;
      const h = open({ ...b, noResultOffer: { kind: "double_walkover" } }, loc);
      expect(settleButtons(h).map(([c]) => c), loc).toEqual(["away_wins", "home_wins", "draw", "double_walkover"]);
      const dw = button(h, "double_walkover");
      expect(dw, `${loc}: the double walkover renders`).not.toBeNull();
      expect(text(dw![3]!), loc).toBe(dict["externalPlay.resolve.doubleWalkover"]);
      expect(text(dw![3]!), `${loc}: never "No result"`).not.toBe(dict["externalPlay.resolve.noResult"]);
      const cls = `${dw![1]} ${dw![2]}`;
      expect(cls, `${loc}: a row of its own`).toMatch(/\bmin-\[360px\]:col-span-2\b/);
      expect(cls, `${loc}: never cut short`).not.toMatch(/\btruncate\b/);
      expect(h, loc).not.toContain('data-testid="arbiter-settle-guidance"');
      locales++;
    }
    expect(locales).toBe(4);
    // The pair: the void's button says "No result", in the grid's own cell.
    const v = button(open({ ...b, noResultOffer: { kind: "void" } }), "no_result");
    expect(text(v![3]!)).toBe(EN["externalPlay.resolve.noResult"]);
    expect(`${v![1]} ${v![2]}`).not.toMatch(/col-span-2/);
  });

  it("a board nobody reached (no online game on file) keeps T15's way to its match page — no settle buttons; closed, the disclosure paints none", () => {
    const none = { ...ROUND.boards[2]!, canSettle: false };
    const h = html(props({ round: { ...ROUND, boards: [none] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }));
    expect(text(h)).toContain("Settle the result now…");
    expect(text(h)).toContain(EN["arbiter.decide.settleElsewhere"]);
    expect(h).toContain('href="/o/club/c/autumn/d/open/f/13"');
    expect(settleButtons(h)).toEqual([]);
    // ("Settle the result" is also a prefix of the toggle's label: anchor on the legend.)
    expect(h).not.toContain("<legend");
    // …and with no match page to go to either, nothing to settle from here.
    const nowhere = { ...none, fixtureNo: null };
    expect(text(html(props({ round: { ...ROUND, boards: [nowhere] } })))).not.toContain("Settle the result now…");
    expect(settleButtons(html(props())), "closed").toEqual([]);
  });

  it("while a request is in flight, the decision controls are disabled", () => {
    const h = html(props({ decision: { ...initialArbiterDecision("f3"), busy: { kind: "resync", boardId: "f3" } } }));
    const disabled = [...h.matchAll(/<button[^>]*disabled=""[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!));
    expect(disabled).toEqual(expect.arrayContaining(["Resync from Lichess", "Let the game go on"]));
    // …and every settle button too, whichever request it is.
    const open = html(props({ decision: { ...initialArbiterDecision("f3"), settleOpen: true, busy: { kind: "goOn", boardId: "f3" } } }));
    const off = [...open.matchAll(/<button[^>]*disabled=""[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!));
    expect(off).toEqual(expect.arrayContaining(["Jonah Mbeki wins", "Elif Demirtaş wins", "Draw", "No result", "Let the game go on"]));
  });

  it("each answer paints its own sentence (anti-vacuity: every notice kind)", () => {
    const notices: [ArbiterDecisionState["notice"], string][] = [
      [{ boardId: "f3", kind: "resynced", adopted: 2 }, EN["arbiter.notice.resynced.other"]!.replace("{count}", "2")],
      [{ boardId: "f3", kind: "resynced", adopted: 1 }, EN["arbiter.notice.resynced.one"]!.replace("{count}", "1")],
      [{ boardId: "f3", kind: "resynced", adopted: 0 }, EN["arbiter.notice.resyncedNone"]!],
      [{ boardId: "f3", kind: "resync_nothing" }, EN["arbiter.notice.resyncNothing"]!],
      [{ boardId: "f3", kind: "resync_failed", code: "NOT_FOUND" }, EN["arbiter.notice.resyncFailed"]!],
      // T16 (brief addendum 5): a player's stored Lichess access that cannot be opened is an operator fault on our
      // side (resyncExternalPlay passes reconcile's 503 through) — "try again" would not help.
      [{ boardId: "f3", kind: "resync_failed", code: "LICHESS_TOKEN_UNAVAILABLE" }, EN["arbiter.notice.resyncTokenUnavailable"]!],
      [{ boardId: "f3", kind: "went_on", stillOpen: 0 }, EN["arbiter.notice.wentOn"]!],
      [{ boardId: "f3", kind: "went_on", stillOpen: 1 }, EN["arbiter.notice.wentOnNew.one"]!.replace("{count}", "1")],
      [{ boardId: "f3", kind: "went_on", stillOpen: 2 }, EN["arbiter.notice.wentOnNew.other"]!.replace("{count}", "2")],
      [{ boardId: "f3", kind: "go_on_failed", code: "ARBITER_PLAYS_THIS_BOARD" }, EN["arbiter.notice.goOnOwnBoard"]!],
      [{ boardId: "f3", kind: "go_on_failed", code: "FLAG_NOT_FOUND" }, EN["arbiter.notice.failed"]!],
      [{ boardId: "f3", kind: "settled", status: "finished" }, EN["arbiter.notice.settled"]!],
      [{ boardId: "f3", kind: "settled", status: "tiebreak_owed" }, EN["arbiter.notice.settledTiebreak"]!],
      [{ boardId: "f3", kind: "settle_failed", code: "ALREADY_RESOLVED" }, EN["arbiter.notice.alreadyResolved"]!],
      // T16 fix round 2, N2: another organiser's decision landed while this one was on its way — its own sentence.
      [{ boardId: "f3", kind: "settle_failed", code: "BOARD_CHANGED" }, EN["arbiter.notice.boardChanged"]!],
      // T16 fix round 3, N4: the online game is over and its result was voided — the pad decides it.
      [{ boardId: "f3", kind: "settle_failed", code: "ONLINE_GAME_OVER" }, EN["arbiter.notice.onlineGameOver"]!],
      // Final review M-5: a board closed before its game started — never "over"; the same instruction, the pad.
      [{ boardId: "f3", kind: "settle_failed", code: "ONLINE_GAME_NEVER_STARTED" }, "This board's online game never started. Record its result on the scoring pad."],
      [{ boardId: "f3", kind: "settle_failed", code: "TIEBREAK_NEEDS_WINNER" }, EN["arbiter.notice.needsWinner"]!],
      [{ boardId: "f3", kind: "settle_failed", code: "ARBITER_PLAYS_THIS_BOARD" }, EN["arbiter.notice.settleOwnBoard"]!],
      // I-3's 409 — No result on a knockout board (a panel loaded before its stage became one still offered it).
      [{ boardId: "f3", kind: "settle_failed", code: "KNOCKOUT_NEEDS_WINNER" }, EN["arbiter.notice.knockoutNeedsWinner"]!],
      [{ boardId: "f3", kind: "settle_failed", code: "SWISS_NEEDS_RESULT" }, EN["arbiter.notice.swissNeedsResult"]!],
      // M-7, fix round 4: who turned up changed under the screen — No result and the double walkover swapped places.
      [{ boardId: "f3", kind: "settle_failed", code: "NO_RESULT_CHANGED" }, EN["arbiter.notice.noResultChanged"]!],
      [{ boardId: "f3", kind: "overridden" }, EN["arbiter.notice.overridden"]!],
      [{ boardId: "f3", kind: "override_failed", code: "FIXTURE_NOT_PLAYABLE" }, EN["arbiter.notice.notPlayable"]!],
      [{ boardId: "f3", kind: "override_failed", code: "VIDEO_NOT_REQUIRED" }, EN["arbiter.notice.notRequired"]!],
      // Self-override: seated after the panel loaded (it hides own boards).
      [{ boardId: "f3", kind: "override_failed", code: "ARBITER_PLAYS_THIS_BOARD" }, EN["arbiter.notice.ownBoard"]!],
      [{ boardId: "f3", kind: "override_failed", code: "UNKNOWN" }, EN["arbiter.notice.failed"]!],
    ];
    const seen = new Set<string>();
    for (const [notice, sentence] of notices) {
      const h = html(props({ decision: { ...initialArbiterDecision("f3"), notice } }));
      expect(h).toMatch(/role="status"/);
      expect(text(h), JSON.stringify(notice)).toContain(sentence);
      seen.add(sentence);
    }
    // 27 notices; "failed" is the shared fallback sentence (2 rows), so 26.
    expect(notices.length).toBe(27);
    expect(seen.size, "every notice paints its own sentence, the fallback once").toBe(26);
  });

  // R4 (T16 fix round 1): on a FINISHED board the close is a review, not a go-on — so is its answer (the queue's words).
  it("a finished board's closed flags: 'Marked as reviewed', with any newer flag counted — never 'The game goes on'", () => {
    const rows: [number, string][] = [
      [0, EN["externalPlay.queue.reviewed"]!],
      [1, EN["externalPlay.queue.reviewedNew.one"]!.replace("{count}", "1")],
      [3, EN["externalPlay.queue.reviewedNew.other"]!.replace("{count}", "3")],
    ];
    let checked = 0;
    for (const [stillOpen, sentence] of rows) {
      const t = text(html(props({ decision: { ...initialArbiterDecision("f2"), notice: { boardId: "f2", kind: "went_on", stillOpen } } })));
      expect(t, `${stillOpen}`).toContain(sentence);
      expect(t, `${stillOpen}: not a go-on`).not.toContain("The game goes on");
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("the outage card", () => {
  it("only during a video outage on a required, playable board not already let go — the whole table", () => {
    const POLICIES = ["off", "optional", "required"] as const;
    const VIDEO: ArbiterVideoView[] = [{ kind: "unavailable" }, { kind: "connecting" }, WATCHING, { kind: "fault" }, { kind: "error" }];
    let cells = 0;
    let shown = 0;
    for (const cameraPolicy of POLICIES)
      for (const videoOverridden of [false, true])
        for (const playable of [false, true])
          for (const video of VIDEO) {
            const b = { ...ROUND.boards[2]!, cameraPolicy, videoOverridden, playable };
            const expected = cameraPolicy === "required" && playable && !videoOverridden && video.kind === "unavailable";
            expect(showsOutageCard(b, video), JSON.stringify({ cameraPolicy, videoOverridden, playable, v: video.kind })).toBe(expected);
            const t = text(html(props({ round: { ...ROUND, boards: [b] }, decision: initialArbiterDecision("f3"), video })));
            expect(t.includes("Let this board play without video")).toBe(expected);
            cells++;
            if (expected) shown++;
          }
    expect(cells).toBe(60);
    expect(shown, "exactly one cell of the table").toBe(1);
  });

  it("the card's words are the canvas's", () => {
    const t = text(html(props({ video: { kind: "unavailable" } })));
    expect(t).toContain("Only during a video outage");
    expect(t).toContain("Video is unavailable right now");
    expect(t).toContain("Players can't take a seat while a camera is required. You can let this board start without video. This is written to the audit log.");
  });
});

describe("the camera join, as pure decisions", () => {
  it("joins only where there is a camera to watch: policy on, not let go, game not over", () => {
    const base = ROUND.boards[2]!;
    const rows: [Partial<ArbiterBoard>, boolean][] = [
      [{}, true],
      [{ cameraPolicy: "optional" }, true],
      [{ cameraPolicy: "off" }, false],
      [{ videoOverridden: true }, false],
      [{ state: { kind: "result", score: "1–0", noResult: false } }, false],
      [{ state: { kind: "checking_in" } }, true],
      [{ state: { kind: "on_hold" } }, true],
    ];
    let checked = 0;
    for (const [over, join] of rows) {
      expect(shouldJoinVideo({ ...base, ...over }), JSON.stringify(over)).toBe(join);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("each refusal of the join route becomes its own tile state; anything else is an error", () => {
    const rows: [unknown, ArbiterVideoView["kind"]][] = [
      [new ApiV1Error("x", 503, "VIDEO_UNAVAILABLE"), "unavailable"],
      [new ApiV1Error("x", 409, "VIDEO_NOT_IN_USE"), "none"],
      [new ApiV1Error("x", 409, "VIDEO_OVERRIDDEN"), "overridden"],
      [new ApiV1Error("x", 409, "VIDEO_MEETING_ENDED"), "ended"],
      [new ApiV1Error("x", 403, "ARBITER_PLAYS_THIS_BOARD"), "own"],
      // M2: the board ended between the loader's read and the join.
      [new ApiV1Error("x", 409, "FIXTURE_NOT_PLAYABLE"), "over"],
      [new ArbiterGuardError(new Error("audio")), "fault"],
      [new ApiV1Error("x", 404, "NOT_FOUND"), "error"],
      // The panel only lists opened rounds: unreachable but by a race, so no copy of its own.
      [new ApiV1Error("x", 409, "ROUND_NOT_OPEN"), "error"],
      [new Error("network"), "error"],
    ];
    let checked = 0;
    for (const [err, kind] of rows) {
      expect(arbiterJoinStateFromError(err).kind).toBe(kind);
      checked++;
    }
    expect(checked).toBe(10);
  });

  describe("I2: the watch is handed back — once, whenever the board closes", () => {
    const recorder = () => {
      const sent: { url: string; init: RequestInit }[] = [];
      return { sent, send: async (url: string, init: RequestInit) => void sent.push({ url, init }) };
    };
    const URL_OF = (f: string, p: string) => `/api/v1/fixtures/${f}/external-play/arbiter/${p}`;

    it("the empty case first: closed (or the tab hidden) before any mint — nothing sent", () => {
      const r = recorder();
      const w = arbiterWatchRelease("fx-1", r.send);
      w.release();
      w.close();
      expect(r.sent).toEqual([]);
    });

    it("minted then closed: ONE DELETE that outlives the page (keepalive); a second close sends nothing", () => {
      const r = recorder();
      const w = arbiterWatchRelease("fx-1", r.send);
      w.minted("pid-1");
      w.close();
      w.close();
      expect(r.sent).toEqual([{ url: URL_OF("fx-1", "pid-1"), init: { method: "DELETE", keepalive: true } }]);
    });

    it("the tab going away (pagehide) hands it back; the board closing after sends nothing more", () => {
      const r = recorder();
      const w = arbiterWatchRelease("fx-1", r.send);
      w.minted("pid-1");
      w.release();
      w.close();
      expect(r.sent.map((x) => x.url)).toEqual([URL_OF("fx-1", "pid-1")]);
    });

    it("a mint that lands AFTER the board closed is handed back at once — the POST raced the switch", () => {
      const r = recorder();
      const w = arbiterWatchRelease("fx-1", r.send);
      w.close();
      expect(r.sent, "premise: nothing to send yet").toEqual([]);
      w.minted("pid-late");
      expect(r.sent.map((x) => x.url)).toEqual([URL_OF("fx-1", "pid-late")]);
    });

    it("ids are path-encoded, and a failed send is caught here — never unhandled; the sweep removes what the browser could not", () => {
      // A rejected send that reports whether a rejection handler was attached.
      let handled = 0;
      const rejected = {
        then: (_ok: unknown, bad?: (e: unknown) => unknown) => {
          if (bad) {
            handled++;
            bad(new Error("offline"));
          }
          return Promise.resolve();
        },
        catch: (bad: (e: unknown) => unknown) => {
          handled++;
          bad(new Error("offline"));
          return Promise.resolve();
        },
      } as unknown as Promise<unknown>;
      const w = arbiterWatchRelease("fx/1", () => rejected);
      w.minted("p d");
      expect(() => w.close()).not.toThrow();
      expect(handled, "the failure has a handler").toBe(1);
      const r = recorder();
      const enc = arbiterWatchRelease("fx/1", r.send);
      enc.minted("p d");
      enc.close();
      expect(r.sent.map((x) => x.url)).toEqual([URL_OF("fx%2F1", "p%20d")]);
    });
  });

  it("'camera off since' starts when this browser first sees a present player's camera off, holds, and clears when it is back", () => {
    const off = { present: true, live: false, track: null };
    const on = { present: true, live: true, track: null };
    const gone = { present: false, live: false, track: null };
    expect(nextOffSince(null, off, 1_000)).toBe(1_000);
    expect(nextOffSince(1_000, off, 5_000), "a second reading keeps the first instant").toBe(1_000);
    expect(nextOffSince(1_000, on, 6_000)).toBeNull();
    expect(nextOffSince(1_000, gone, 6_000), "absent is its own state, not 'off since'").toBeNull();
  });
});

describe("every locale", () => {
  it("no untranslated key or unfilled slot reaches the page, in any state the panel paints", () => {
    const states: ArbiterScreenProps[] = [
      props(),
      props({ decision: { ...initialArbiterDecision("f3"), settleOpen: true, notice: { boardId: "f3", kind: "went_on", stillOpen: 2 } } }),
      props({
        round: { ...ROUND, boards: [{ ...ROUND.boards[2]!, tiebreakOwed: true }] },
        decision: { ...initialArbiterDecision("f3"), settleOpen: true, notice: { boardId: "f3", kind: "settled", status: "tiebreak_owed" } },
      }),
      props({ round: { ...ROUND, boards: [{ ...ROUND.boards[2]!, canSettle: false }] }, decision: { ...initialArbiterDecision("f3"), settleOpen: true } }),
      props({ video: { kind: "unavailable" } }),
      props({ video: { kind: "fault" }, decision: initialArbiterDecision("f2") }),
      props({ round: null, decision: initialArbiterDecision(null), video: { kind: "idle" } }),
      props({ round: { ...ROUND, boards: [], ownBoards: 1 }, decision: initialArbiterDecision(null), video: { kind: "idle" } }),
      props({ video: { kind: "own" } }),
      props({ round: { ...ROUND, current: false, ownBoards: 1 } }),
      props({ round: { ...ROUND, ownBoards: 2 } }),
      props({ round: null, requested: "unavailable", decision: initialArbiterDecision("x"), video: { kind: "idle" } }),
      props({ round: null, requested: "own", decision: initialArbiterDecision("x"), video: { kind: "idle" } }),
      props({
        round: {
          ...ROUND,
          boards: [{ ...ROUND.boards[2]!, flags: [outOfBand(null), { id: "c", kind: "camera_connection_problems", at: at(19, 40), personName: null, seconds: 61, stamps: 1 }, { id: "c2", kind: "camera_connection_problems", at: at(19, 41), personName: null, seconds: null, stamps: null }, { ...PRIYA_REPORT, report: null, personName: null } as ArbiterFlag] }],
        },
      }),
      // T17B fix 2, D9: a multiple_devices card read and unread, on a finished board.
      props({
        round: {
          ...ROUND,
          boards: [
            {
              ...ROUND.boards[1]!,
              flags: [
                { id: "d1", kind: "multiple_devices", at: at(19, 41), personName: "Elif Demirtaş", report: { devices: 3, seconds: 400, intervals: [{ from: at(19, 31, 5), to: at(19, 36, 45) }, { from: at(19, 40), to: at(19, 41) }] } },
                { id: "d2", kind: "multiple_devices", at: at(19, 42), personName: null, report: null },
              ],
            },
          ],
        },
        decision: initialArbiterDecision("f2"),
      }),
    ];
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      for (const p of states) {
        const t = text(html(p, locale));
        expect(t, `${locale}: raw key`).not.toMatch(/\b(?:arbiter|externalPlay)\.[a-zA-Z]/);
        expect(t, `${locale}: unfilled slot`).not.toMatch(/\{[a-z]+\}/i);
        checked++;
      }
    }
    expect(checked).toBe(60);
  });

  it("the source never asks for the arbiter's own camera or microphone", () => {
    let scanned = 0;
    for (const f of ["../arbiter-panel.tsx", "../arbiter-camera.ts"]) {
      const src = readFileSync(pathJoin(__dirname, f), "utf8");
      expect(src.length).toBeGreaterThan(1_000);
      for (const call of ["getUserMedia", "enableAudio", "enableVideo", "enableScreenShare"]) expect(src, `${f}: ${call}`).not.toContain(call);
      scanned++;
    }
    expect(scanned).toBe(2);
  });
});

function hhmm(iso: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
function hhmmss(iso: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
