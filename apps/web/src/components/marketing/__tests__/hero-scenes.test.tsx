import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chess } from "chess.js";
import { builtinModules } from "@seazn/engine/sports";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carromPadRules, tennisPadRules } from "@seazn/engine/pad";
import offer from "@/lib/quick-match-offer.generated.json";
import { LOCALES } from "@/lib/i18n-constants";
import { pickVariant } from "@/lib/preferred-variant";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import {
  HERO_AUTO_PLAYS,
  HERO_CHESS,
  HERO_DEFAULT_SCENE,
  HERO_SCENES,
  heroChessSquare,
  heroSceneKey,
  heroSceneLabelKey,
  heroScoreText,
  heroTennisCall,
  type HeroSceneKey,
  type HeroScore,
} from "../hero-scenes";
import { HeroSceneArt } from "../hero-scene-art";

// The hero's art follows its Sport select (owner 2026-11-13: "when user choose the sport can we show relevant one?"). One
// scene per sport the quick match OFFERS, read off the probe's own record (lib/quick-match-offer.generated.json), never a
// list typed here; cricket stays in code for the day the quick match offers it. Every scorebug speaks its sport's score
// language, judged against the ENGINE's declarations (its default rules for the variant the setup screen opens on, its
// point calls, its chess score shape, its carrom board values), never against hero-scenes.ts itself.

const offeredSports = [...new Set(offer.offered.map((o) => o.sport_key))];
const excludedSports = [...new Set(offer.excluded.map((o) => o.sport_key))];
const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };

describe("hero scenes: which scene a key opens", () => {
  it("the empty case first: no key, a blank, an unknown or excluded-but-sceneless sport and prototype names all open badminton", () => {
    expect(HERO_DEFAULT_SCENE).toBe("badminton");
    const keys = [undefined, null, "", "   ", "generic", "Badminton", "constructor", "__proto__", "toString", "hasOwnProperty"];
    let checked = 0;
    for (const key of keys) {
      expect(heroSceneKey(key), String(key)).toBe("badminton");
      checked++;
    }
    expect(checked).toBe(keys.length);
  });

  it("every sport the quick match offers opens its OWN scene (swept from the offer record)", () => {
    expect(offeredSports.length, "offered sports in the probe's record").toBeGreaterThan(0);
    const markups = new Map<string, string>();
    for (const sport of offeredSports) {
      expect(heroSceneKey(sport), sport).toBe(sport);
      expect(Object.hasOwn(HERO_SCENES, sport), sport).toBe(true);
      const art = renderToStaticMarkup(
        <svg>
          <HeroSceneArt scene={sport as HeroSceneKey} />
        </svg>,
      );
      // The moving object, the trail it draws and the impact star: the choreography's three parts every scene owes.
      expect(art, `${sport}: the object in flight`).toMatch(/class="mk-ball"/);
      expect(art, `${sport}: its flight trail`).toMatch(/class="mk-trail"/);
      expect(art, `${sport}: the impact`).toMatch(/class="mk-star"/);
      markups.set(sport, art);
    }
    expect(markups.size, "scenes drawn").toBe(offeredSports.length);
    // A scene that is another sport's art under a new key is no scene: every drawing differs from every other.
    expect(new Set(markups.values()).size, "distinct drawings").toBe(offeredSports.length);
  });

  it("cricket stays in code (its scene and label) while the quick match excludes it", () => {
    expect(excludedSports).toContain("cricket");
    expect(heroSceneKey("cricket")).toBe("cricket");
    expect(heroScoreText("cricket", 0)).toBe("Falcons CC 142/3");
    expect(en[heroSceneLabelKey("cricket") as keyof typeof en]).toMatch(/cricket/i);
  });

  it("every scene has an accessible name in each of the four locales, and no two scenes share one", () => {
    const scenes = Object.keys(HERO_SCENES) as HeroSceneKey[];
    expect(Object.keys(DICTS).sort()).toEqual([...LOCALES].sort());
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale]!;
      const names = scenes.map((scene) => dict[heroSceneLabelKey(scene)]);
      for (const [i, name] of names.entries()) {
        expect(typeof name === "string" && name.trim().length > 0, `${locale} ${scenes[i]}`).toBe(true);
        checked++;
      }
      expect(new Set(names).size, `${locale}: distinct names`).toBe(scenes.length);
    }
    expect(checked).toBe(LOCALES.length * scenes.length);
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Score language, per sport, against the engine.
// ---------------------------------------------------------------------------------------------------------------------

type Mod = { key: string; configSchema: { parse(v: unknown): unknown }; variants: Record<string, unknown> };
const moduleOf = (sport: string): Mod => {
  const mod = (builtinModules as unknown as Mod[]).find((m) => m.key === sport);
  if (!mod) throw new Error(`no engine module for ${sport}`);
  return mod;
};
/** The rules the setup screen opens on for `sport`: the engine's resolved config of `pickVariant` over the offered
 *  variants, in the order the setup screen lists them (catalog key order, which the record keeps). */
function defaultRules<T>(sport: string): T {
  const variants = offer.offered.filter((o) => o.sport_key === sport).map((o) => ({ key: o.variant_key }));
  const variant = pickVariant(sport, variants);
  expect(variant, `${sport}: a default variant`).not.toBe("");
  const mod = moduleOf(sport);
  return mod.configSchema.parse(mod.variants[variant] ?? {}) as T;
}

const stepsOf = (sport: HeroSceneKey) => HERO_SCENES[sport].score.steps;

/** One rally, one point, to one side: the step after differs by exactly 1 on exactly one side. */
function onePointApart(before: readonly [number, number], after: readonly [number, number]): boolean {
  const dh = after[0] - before[0];
  const da = after[1] - before[1];
  return (dh === 1 && da === 0) || (dh === 0 && da === 1);
}

/** A rally-scored game (BWF 7.3, ITTF 2.11.1, FIVB 6.1.2): won at `setTo` with `winBy` clear, or at the cap. */
function gameOver(score: readonly [number, number], rules: { setTo: number; winBy: number; cap: number | null }): boolean {
  const top = Math.max(...score);
  return (top >= rules.setTo && Math.abs(score[0] - score[1]) >= rules.winBy) || (rules.cap !== null && top >= rules.cap);
}

/** The tennis scene's score: its names, and the set's games before the game its points play. */
function tennisScore(sport: HeroSceneKey): Extract<HeroScore, { kind: "tennis" }> {
  const { score } = HERO_SCENES[sport] as { score: HeroScore };
  if (score.kind !== "tennis") throw new Error(`${sport} keeps no tennis score`);
  return score;
}

/** ITF Rule 5: a game goes to the side that wins the point after 40 (the fourth) two clear; no-ad (Appendix V), the
 *  point after 40–40 decides it. `null` while the game is on. */
function tennisGameWon(points: readonly [number, number], calls: number, noAd: boolean): "home" | "away" | null {
  const [h, a] = points;
  if (Math.max(h, a) < calls) return null;
  if (!noAd && Math.abs(h - a) < 2) return null;
  return h > a ? "home" : "away";
}

/** ITF Rule 6 (a "tiebreak set"): won at `gamesTo` with `winBy` clear, or `tiebreakAt + 1` to `tiebreakAt` by the tiebreak. */
function tennisSetWon(
  games: readonly [number, number],
  set: { gamesTo: number; winBy: number; tiebreakAt: number | null },
): "home" | "away" | null {
  const [h, a] = games;
  const top = Math.max(h, a);
  const clear = (top >= set.gamesTo && Math.abs(h - a) >= set.winBy) ||
    (set.tiebreakAt !== null && top === set.tiebreakAt + 1 && Math.min(h, a) === set.tiebreakAt);
  return clear ? (h > a ? "home" : "away") : null;
}

const checkers: Record<string, (sport: HeroSceneKey) => number> = {
  rally(sport) {
    const rules = defaultRules<{ setTo: number; winBy: number; cap: number | null }>(sport);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      // Every score before the last is a game still being played; the last may be the game point won.
      if (i < steps.length - 1) expect(gameOver(s, rules), `${sport} ${s} is live under ${JSON.stringify(rules)}`).toBe(false);
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
  tennis(sport) {
    const calls = tennisPadRules.pointCalls;
    expect(calls.length).toBeGreaterThan(0);
    const { game } = defaultRules<{ game: { noAd: boolean } }>(sport);
    const { names, games } = tennisScore(sport);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      // A standard game's points are called 0, 15, 30, 40 (ITF Rule 5(a)) while it is on; the point that wins it counts a
      // game into the set, and the scorebug then shows the set's games.
      const won = tennisGameWon(s, calls.length, game.noAd);
      if (won === null) {
        for (const p of s) expect(p >= 0 && p < calls.length, `${sport} ${s}`).toBe(true);
        expect(heroScoreText(sport, i)).toBe(`${names[0]} ${calls[s[0]]}–${calls[s[1]]} ${names[1]}`);
      } else {
        const after = won === "home" ? [games[0] + 1, games[1]] : [games[0], games[1] + 1];
        expect(heroScoreText(sport, i)).toBe(`${names[0]} ${after[0]}–${after[1]} ${names[1]}`);
      }
    });
    return steps.length;
  },
  goals(sport) {
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      for (const g of s) expect(Number.isInteger(g) && g >= 0, `${sport} ${s}`).toBe(true);
      // Each play is one goal.
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
  chess(sport) {
    // The engine's own chess score shape (CHESS_SCORE, via the tie-break event's schema) and its points per game.
    const tiebreak = (boardgame.eventSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)["boardgame.tiebreak"]!;
    const { scoring } = defaultRules<{ scoring: { win: number; draw: number; loss: number } }>(sport);
    const games = [
      [scoring.win, scoring.loss],
      [scoring.draw, scoring.draw],
      [scoring.loss, scoring.win],
    ].map(([h, a]) => `${h},${a}`);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      const text = heroScoreText(sport, i);
      const [home, away = ""] = HERO_SCENES[sport].score.names;
      const score = text.slice(home.length + 1, -(away.length + 1));
      expect(tiebreak.safeParse({ rung: "rapid", winner: "H", score }).success, `${sport} "${score}"`).toBe(true);
      if (i > 0) expect(games, `${sport} step ${i}: one game's points`).toContain(`${s[0] - steps[i - 1]![0]},${s[1] - steps[i - 1]![1]}`);
    });
    return steps.length;
  },
  carrom(sport) {
    const rules = defaultRules<{ gameTo: number; queenPoints: number; queenCapAt: number; pointsPerCoin: number }>(sport);
    const coins = carromPadRules.opponentCoinsMax;
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      if (i < steps.length - 1) expect(Math.max(...s), `${sport} ${s}: game still on`).toBeLessThan(rules.gameTo);
      if (i > 0) {
        const prev = steps[i - 1]!;
        const side = s[0] !== prev[0] ? 0 : 1;
        expect(s[1 - side], `${sport} step ${i}: one board, one winner`).toBe(prev[1 - side]);
        // A board scores the opponent's coins left, plus the queen while the winner is below the cap (ICF 52(b), 54). Every
        // landing sinks the queen (the scene's label), and the board's winner has pocketed all their own coins, so at least
        // one of the opponent's is left: below the cap a board is worth the queen and a coin at least.
        const board = s[side]! - prev[side]!;
        const queen = prev[side]! < rules.queenCapAt ? rules.queenPoints : 0;
        const least = queen + rules.pointsPerCoin;
        const most = coins * rules.pointsPerCoin + queen;
        expect(board >= least && board <= most, `${sport} step ${i}: a board of ${board} (from ${least} to ${most})`).toBe(true);
      }
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
};

describe("hero scenes: each scorebug speaks its sport's score language (the engine's declarations)", () => {
  it("every offered sport's scorebug is checked against its engine rules, and each advances on a landing", () => {
    let sports = 0;
    let steps = 0;
    for (const sport of offeredSports as HeroSceneKey[]) {
      const kind = HERO_SCENES[sport].score.kind;
      const check = checkers[kind];
      expect(check, `${sport}: a checker for "${kind}"`).toBeDefined();
      const n = check!(sport);
      // Three plays on load, each landing moves the score: four frames at least.
      expect(n, `${sport} steps`).toBeGreaterThanOrEqual(4);
      steps += n;
      sports++;
    }
    expect(sports, "sports checked").toBe(offeredSports.length);
    expect(steps).toBeGreaterThan(0);
  });

  // The plays rest on the scene's last frame, and that frame is a DECIDED one (owner review 2026-11-13: "pin the final frame
  // per sport as a decided/won state"), for the side every landing scores for, the home side: judged by each sport's
  // default rules from the engine, never by the scene's own comments.
  it("the plays rest on the last frame, and it is decided for the scoring side under each sport's default rules", () => {
    let sports = 0;
    for (const sport of offeredSports as HeroSceneKey[]) {
      const { score } = HERO_SCENES[sport] as { score: HeroScore };
      const steps = score.steps;
      const last = steps.at(-1)!;
      expect(steps.length - 1, `${sport}: three plays on load, one landing each, rest on the last frame`).toBe(HERO_AUTO_PLAYS);
      const before = steps.slice(0, -1);
      switch (score.kind) {
        case "rally": {
          const rules = defaultRules<{ setTo: number; winBy: number; cap: number | null }>(sport);
          for (const s of before) expect(gameOver(s, rules), `${sport} ${s}: still on`).toBe(false);
          expect(gameOver(last, rules), `${sport} ${last}: the game won under ${JSON.stringify(rules)}`).toBe(true);
          expect(last[0] > last[1], `${sport} ${last}: won by the home side`).toBe(true);
          break;
        }
        case "tennis": {
          const calls = tennisPadRules.pointCalls.length;
          const { game, set } = defaultRules<{ game: { noAd: boolean }; set: { gamesTo: number; winBy: number; tiebreakAt: number | null } }>(sport);
          for (const s of before) expect(tennisGameWon(s, calls, game.noAd), `${sport} ${s}: the game still on`).toBeNull();
          expect(tennisGameWon(last, calls, game.noAd), `${sport} ${last}: the game won`).toBe("home");
          // The game it wins takes the set: live at the games before it, won with it.
          const { games } = tennisScore(sport);
          expect(tennisSetWon(games, set), `${sport} ${games}: the set still on`).toBeNull();
          expect(tennisSetWon([games[0] + 1, games[1]], set), `${sport}: the set won with the game`).toBe("home");
          break;
        }
        case "carrom": {
          const { gameTo } = defaultRules<{ gameTo: number }>(sport);
          for (const s of before) expect(Math.max(...s), `${sport} ${s}: the game still on`).toBeLessThan(gameTo);
          expect(last[0], `${sport} ${last}: the home side reaches ${gameTo}`).toBeGreaterThanOrEqual(gameTo);
          expect(last[1]).toBeLessThan(gameTo);
          break;
        }
        case "chess": {
          // Each landing is a game decided over the board: the mate chess.js plays below, a win in the engine's points.
          const { scoring } = defaultRules<{ scoring: { win: number; loss: number } }>(sport);
          const prev = before.at(-1)!;
          expect([last[0] - prev[0], last[1] - prev[1]], `${sport}: the last landing is a game won`).toEqual([scoring.win, scoring.loss]);
          expect(last[0] > last[1], `${sport} ${last}: the home side ahead`).toBe(true);
          break;
        }
        case "goals": {
          // A goals sport is decided by the clock, which the scorebug does not show: its resting frame is a win for the side
          // that scored, never level (the default rules' level score is a draw, or extra time and a shootout).
          for (let i = 1; i < steps.length; i++) {
            expect([steps[i]![0] - steps[i - 1]![0], steps[i]![1] - steps[i - 1]![1]], `${sport} landing ${i}: a home goal`).toEqual([1, 0]);
          }
          expect(last[0] > last[1], `${sport} ${last}: the home side ahead`).toBe(true);
          break;
        }
        default:
          throw new Error(`${sport}: no decided rule for "${score.kind}"`);
      }
      sports++;
    }
    expect(sports, "sports judged").toBe(offeredSports.length);
    expect(sports).toBeGreaterThan(0);
  });

  it("tennis writes no deuce or advantage frame: past 40 a frame must be a won game, else it is refused", () => {
    expect(heroTennisCall([5, 4], [3, 1])).toBe("40–15");
    expect(heroTennisCall([5, 4], [4, 1])).toBe("6–4");
    expect(heroTennisCall([5, 4], [1, 4])).toBe("5–5");
    for (const points of [[4, 3], [3, 4], [5, 4]] as const) {
      expect(() => heroTennisCall([5, 4], points), String(points)).toThrow(/deuce or advantage/);
    }
  });

  it("the score holds at its last frame past the plays (a replay past it adds nothing), and never reads a negative frame", () => {
    let checked = 0;
    for (const sport of Object.keys(HERO_SCENES) as HeroSceneKey[]) {
      const last = stepsOf(sport).length - 1;
      expect(heroScoreText(sport, last + 5), sport).toBe(heroScoreText(sport, last));
      expect(heroScoreText(sport, -1), sport).toBe(heroScoreText(sport, 0));
      expect(heroScoreText(sport, 1), `${sport}: the first landing moves it`).not.toBe(heroScoreText(sport, 0));
      checked++;
    }
    expect(checked).toBe(Object.keys(HERO_SCENES).length);
  });

});

// ---------------------------------------------------------------------------------------------------------------------
// The chess scene is a board played online (owner 2026-11-13).
// ---------------------------------------------------------------------------------------------------------------------

// Owner 2026-11-13: the chess scene should look like chess played online, a green-and-white board (light #eeeed2, dark
// #769656), its colours the scene's own and "not from game" (apps/web/src/games is Seazn Games, another product).
const ONLINE_BOARD = { light: "#eeeed2", dark: "#769656" } as const;

const attrsOf = (s: string): Record<string, string> =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

/** A FEN from the scene's own position (squares by name, FEN letters), side to move first. */
function fenOf(pieces: Readonly<Record<string, string>>, turn: "w" | "b"): string {
  const ranks: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (const file of "abcdefgh") {
      const piece = pieces[`${file}${rank}`];
      if (piece) {
        row += `${empty || ""}${piece}`;
        empty = 0;
      } else empty++;
    }
    ranks.push(row + (empty || ""));
  }
  return `${ranks.join("/")} ${turn} - - 0 1`;
}

describe("hero scenes: the chess scene is a board played online (owner 2026-11-13)", () => {
  const art = renderToStaticMarkup(
    <svg>
      <HeroSceneArt scene="boardgame" />
    </svg>,
  );

  it("draws a whole 8×8 board in the owner's green and white: 32 squares of each, alternating, a light square at White's right", () => {
    const squares = [...art.matchAll(/<rect\b([^>]*)>/g)]
      .map((m) => attrsOf(m[1]!))
      .filter((a) => a.fill === ONLINE_BOARD.light || a.fill === ONLINE_BOARD.dark)
      .map((a) => ({ x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height), fill: a.fill! }));
    expect(squares, "board squares in the owner's two colours").toHaveLength(64);
    expect(squares.filter((s) => s.fill === ONLINE_BOARD.light)).toHaveLength(32);
    expect(new Set(squares.map((s) => s.x)).size, "files").toBe(8);
    expect(new Set(squares.map((s) => s.y)).size, "ranks").toBe(8);
    const side = squares[0]!.w;
    expect(side, "a square's side").toBeGreaterThan(0);
    for (const s of squares) expect([s.w, s.h], "every square the same size").toEqual([side, side]);
    // Neighbours along a rank and along a file differ in colour: 7 pairs a rank × 8 ranks, and the same down the files.
    let pairs = 0;
    for (const s of squares) {
      for (const n of squares.filter((o) => (o.x === s.x + side && o.y === s.y) || (o.x === s.x && o.y === s.y + side))) {
        expect(n.fill, `(${s.x}, ${s.y}) and (${n.x}, ${n.y})`).not.toBe(s.fill);
        pairs++;
      }
    }
    expect(pairs, "neighbouring pairs checked").toBe(2 * 7 * 8);
    // FIDE Laws of Chess 2.1: the board is placed so the near corner square to each player's right is light. White sits
    // at the bottom (the near side), so the bottom-right square, h1, is light.
    const right = Math.max(...squares.map((s) => s.x));
    const bottom = Math.max(...squares.map((s) => s.y));
    expect(squares.find((s) => s.x === right && s.y === bottom)?.fill, "h1").toBe(ONLINE_BOARD.light);
  });

  it("takes nothing from the games module: no import of it in the scene's files, the two colours written in the art's own", () => {
    let files = 0;
    let read = 0;
    for (const file of ["hero-scene-art.tsx", "hero-scenes.ts"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // `from "x"`, a bare `import "x"` and `import("x")` alike.
      const specs = [...src.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specs) expect(spec, `${file} imports ${spec}`).not.toMatch(/(^|\/|@)games(\/|$)/);
      read += specs.length;
      files++;
    }
    expect(files).toBe(2);
    // The art imports hero-scenes.ts and React at least: a scan that read none read nothing.
    expect(read, "imports read").toBeGreaterThanOrEqual(2);
    const own = readFileSync(new URL("../hero-scene-art.tsx", import.meta.url), "utf8").toLowerCase();
    expect(own).toContain(`"${ONLINE_BOARD.light}"`);
    expect(own).toContain(`"${ONLINE_BOARD.dark}"`);
  });

  it("the one move it plays is legal and mates (the laws of chess, played through chess.js), and the piece slides along it", () => {
    const { pieces, move } = HERO_CHESS;
    const named = Object.keys(pieces);
    expect(named.length, "pieces on the board").toBeGreaterThan(2);
    const game = new Chess(fenOf(pieces, "w"));
    const played = game.move({ from: move.from, to: move.to });
    expect(played.color, "White, the near side, plays it").toBe("w");
    expect(game.isCheckmate(), `${move.from}-${move.to} mates`).toBe(true);
    // The screen reader hears the move the picture plays: a rook's mate.
    expect(played.piece).toBe("r");
    expect(en[heroSceneLabelKey("boardgame")]).toMatch(/\brook\b.*\bcheckmate\b/i);
    // The art draws every other piece where the position puts it, and the mover is the object that slides.
    let drawn = 0;
    for (const square of named.filter((s) => s !== move.from)) {
      const at = heroChessSquare(square);
      expect(art, `${pieces[square as keyof typeof pieces]} on ${square}`).toContain(`transform="translate(${at.x} ${at.y})`);
      drawn++;
    }
    expect(drawn).toBe(named.length - 1);
    // A slide: it starts on its square (no toss), runs straight (the control point on the line) and stops on the target.
    const { flight } = HERO_SCENES.boardgame;
    const from = heroChessSquare(move.from);
    const to = heroChessSquare(move.to);
    for (const p of [flight.rest, flight.toss, flight.hit]) expect(p).toEqual(from);
    expect(flight.land).toEqual(to);
    const cross = (flight.ctrl.x - from.x) * (to.y - from.y) - (flight.ctrl.y - from.y) * (to.x - from.x);
    expect(cross, "the control point on the move's line").toBe(0);
    // The impact is the mated king's: it pops on the king's square as the piece lands.
    const king = named.find((s) => pieces[s as keyof typeof pieces] === "k");
    expect(king, "Black's king").toBeDefined();
    expect(flight.star).toEqual(heroChessSquare(king!));
  });

  it("dots exactly the mover's legal squares while it is picked (chess.js), one dot each, and refuses a name that is no square", () => {
    const { pieces, move, hints } = HERO_CHESS;
    const legal = new Chess(fenOf(pieces, "w")).moves({ square: move.from, verbose: true }).map((m) => m.to);
    expect(legal.length, "the mover's legal squares").toBeGreaterThan(0);
    expect([...hints].sort()).toEqual([...legal].sort());
    const group = art.match(/<g\b[^>]*class="mk-hints"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? "";
    let dotted = 0;
    for (const square of hints) {
      const at = heroChessSquare(square);
      expect(group, `a dot on ${square}`).toMatch(new RegExp(`<circle\\b[^>]*cx="${at.x}"[^>]*cy="${at.y}"`));
      dotted++;
    }
    expect(dotted).toBe(legal.length);
    expect(group.match(/<circle\b/g)?.length, "no dot beyond them").toBe(legal.length);
    for (const name of ["", "d", "d0", "d9", "i1", "D1", "d1x", "a10"]) {
      expect(() => heroChessSquare(name), JSON.stringify(name)).toThrow(/no square/);
    }
    // White at the near side: a8 is up and to the left of h1.
    const [a8, h1] = [heroChessSquare("a8"), heroChessSquare("h1")];
    expect(a8.x < h1.x && a8.y < h1.y, "a8 top-left of h1").toBe(true);
  });

  it("each landing is the mating side's win: White is the home side, so every frame moves the home score by one game won", () => {
    const { scoring } = defaultRules<{ scoring: { win: number; draw: number; loss: number } }>("boardgame");
    const steps = stepsOf("boardgame");
    let landings = 0;
    for (let i = 1; i < steps.length; i++) {
      expect([steps[i]![0] - steps[i - 1]![0], steps[i]![1] - steps[i - 1]![1]], `landing ${i}`).toEqual([scoring.win, scoring.loss]);
      landings++;
    }
    expect(landings).toBe(steps.length - 1);
    expect(landings).toBeGreaterThan(0);
    // The owner's example: "Petrova ½–½ → 1½–½ Lund".
    expect(heroScoreText("boardgame", 0)).toBe("Petrova ½–½ Lund");
    expect(heroScoreText("boardgame", 1)).toBe("Petrova 1½–½ Lund");
  });
});
