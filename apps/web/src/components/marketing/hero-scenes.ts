// The marketing hero's illustrated scenes: one per sport the quick match offers, so the art beside the hero's Sport select
// shows the sport picked there (owner 2026-11-13: "we already have cricket animation, so when user choose the sport can
// we show relevant one?"). Cricket keeps its scene for the day the quick match offers it (a lineup sport, excluded today).
//
// A plain module, no directive: the quick match form (a server component) reads `HERO_SPORT_SELECT_ID` from here, and a
// value exported from a "use client" module would reach the server as a client reference, not the string.
//
// Each scene is data: its score (in the sport's own score language, swept against the engine in hero-scenes.test.tsx)
// and its geometry, which the one shared CSS choreography (globals.css, "Hero vignette choreography") reads as custom
// properties set inline per scene: the object rests, is tossed, is struck at 1.5s and flies a quadratic curve
// hit → ctrl → land, landing at 2.4s. The trail the art draws is that same curve, so the two cannot drift.
//
// Coordinates are the art's viewBox (420 × 360): the ground line is y = 300, and the band below it is where the scorebug
// chip sits, bottom-left.

/** The id the hero's Sport select carries (quick-match-cta.tsx), and the one the art listens on (hero-vignette.tsx). */
export const HERO_SPORT_SELECT_ID = "qm-cta-sport";

/** The plays on load (design/v3/12 §4.2: three, then it rests). One landing each, so a scene's scorebug has this many
 *  frames after its first, and rests on its last: the decided one (hero-scenes.test.tsx judges it per sport). */
export const HERO_AUTO_PLAYS = 3;

export interface HeroPoint {
  readonly x: number;
  readonly y: number;
}

/** The object's path: waits at `rest`, tossed through `toss` to `hit` (struck at 1.5s), then flies hit → ctrl → land. */
export interface HeroFlight {
  readonly rest: HeroPoint;
  readonly toss: HeroPoint;
  readonly hit: HeroPoint;
  readonly ctrl: HeroPoint;
  readonly land: HeroPoint;
  /** Scale while carried (1 when omitted). */
  readonly lift?: number;
  /** Scale where it comes to rest (a carrom coin dropping into its pocket). */
  readonly landScale?: number;
  /** Where the impact star pops, and when (seconds); the strike point at 1.5s by default. */
  readonly star?: HeroPoint;
  readonly starAt?: number;
}

/** A striker that swings about `pivot` (a racket, a bat, a boot, a stick): degrees, wound back → strike → follow-through
 *  → settle, then it sways between `settle` and `sway`. */
export interface HeroSwing {
  readonly pivot: HeroPoint;
  readonly back: number;
  readonly strike: number;
  readonly over: number;
  readonly settle: number;
  readonly sway: number;
}

/** A striker that slides (a carrom striker): along its baseline from `rest` to `aim`, shot into `hit`, rebounds to `end`. */
export interface HeroSlide {
  readonly rest: HeroPoint;
  readonly aim: HeroPoint;
  readonly hit: HeroPoint;
  readonly end: HeroPoint;
}

/** The scorebug's frames: `steps[0]` before any landing, one more per landing, held at the last. `rally`, `goals` and
 *  `carrom` read `home h–a away`; `tennis` calls the points (0, 15, 30, 40) of one game, and once the game is won shows
 *  the set's `games` with it counted; `chess` writes half points (the engine stores 1 / ½ / 0 as 2 / 1 / 0); `innings`
 *  reads `team runs/wickets`. */
export type HeroScore =
  | {
      readonly kind: "rally" | "goals" | "carrom" | "chess";
      readonly names: readonly [string, string];
      readonly steps: readonly (readonly [number, number])[];
    }
  | {
      readonly kind: "tennis";
      readonly names: readonly [string, string];
      /** The set's games before the game the steps play. */
      readonly games: readonly [number, number];
      readonly steps: readonly (readonly [number, number])[];
    }
  | { readonly kind: "innings"; readonly names: readonly [string]; readonly steps: readonly (readonly [number, number])[] };

export interface HeroScene {
  readonly score: HeroScore;
  readonly flight: HeroFlight;
  readonly swing?: HeroSwing;
  readonly slide?: HeroSlide;
}

const pt = (x: number, y: number): HeroPoint => ({ x, y });

/** The chess scene's board, drawn the way chess is played online (owner 2026-11-13): eight files by eight ranks of
 *  `square`, a8's top-left corner at (x, y), White at the near side (the bottom). Left of centre, so its h8 corner
 *  clears the replay button at a phone's width; above y = 300, the scorebug's band. */
export const HERO_BOARD = { x: 56, y: 24, square: 34 } as const;

const FILES = "abcdefgh";

/** A square's centre on the board, by name ("d1"). A name that is no square is refused, never drawn off the board. */
export function heroChessSquare(name: string): HeroPoint {
  const file = FILES.indexOf(name.charAt(0));
  const rank = Number(name.slice(1));
  if (name.length !== 2 || file < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) {
    throw new Error(`hero chess: "${name}" is no square`);
  }
  const { x, y, square } = HERO_BOARD;
  return pt(x + square * (file + 0.5), y + square * (8 - rank + 0.5));
}

/** The chess scene's position and the one move it plays: White (the home side) mates on the back rank. Squares by name,
 *  pieces by their FEN letter (upper case White); `hints` are the mover's legal squares, dotted while it is picked.
 *  hero-scenes.test.tsx plays the move through chess.js. */
export const HERO_CHESS = {
  pieces: {
    a7: "p",
    b7: "b",
    f7: "p",
    g7: "p",
    h7: "p",
    g8: "k",
    b2: "q",
    a2: "P",
    f2: "P",
    g2: "P",
    h2: "P",
    f3: "N",
    d1: "R",
    g1: "K",
  },
  move: { from: "d1", to: "d8" },
  hints: ["d2", "d3", "d4", "d5", "d6", "d7", "d8", "a1", "b1", "c1", "e1", "f1"],
} as const satisfies {
  pieces: Readonly<Record<string, string>>;
  move: { from: string; to: string };
  hints: readonly string[];
};

/** The square of the side's king (`K` White, `k` Black) in the scene's position; a position without one is refused. */
export function heroChessKing(king: "K" | "k"): string {
  const square = Object.keys(HERO_CHESS.pieces).find((s) => HERO_CHESS.pieces[s as keyof typeof HERO_CHESS.pieces] === king);
  if (!square) throw new Error(`hero chess: no ${king} on the board`);
  return square;
}

const chessFrom = heroChessSquare(HERO_CHESS.move.from);
const chessTo = heroChessSquare(HERO_CHESS.move.to);

export const HERO_SCENES = {
  // Rally scoring to 15, two clear (BWF 3×15, the quick match's default badminton rules): 15–12 takes the game.
  badminton: {
    score: { kind: "rally", names: ["Kim", "Park"], steps: [[12, 12], [13, 12], [14, 12], [15, 12]] },
    flight: { rest: pt(290, 318), toss: pt(276, 96), hit: pt(272, 168), ctrl: pt(178, -40), land: pt(84, 289) },
    swing: { pivot: pt(318, 296), back: 30, strike: -20, over: -45, settle: -32, sway: -28 },
  },
  // Chess as it is played online: a mini-match in half points. Each play is White's mate (HERO_CHESS), so each landing is
  // a game won by the home side, Petrova.
  boardgame: {
    score: { kind: "chess", names: ["Petrova", "Lund"], steps: [[1, 1], [3, 1], [5, 1], [7, 1]] },
    // A slide, not a flight: the piece leaves its square on the strike's beat and runs straight to the target (the control
    // point is the move's midpoint); the impact is the mated king's square, as the piece lands.
    flight: {
      rest: chessFrom,
      toss: chessFrom,
      hit: chessFrom,
      ctrl: pt((chessFrom.x + chessTo.x) / 2, (chessFrom.y + chessTo.y) / 2),
      land: chessTo,
      star: heroChessSquare(heroChessKing("k")),
      starAt: 2.4,
    },
  },
  // Carrom, club rules (game to 29, the queen 5 below 24): a board scores the opponent's coins left, plus the queen. Each
  // landing sinks the queen and wins the board with one of Ravi's coins left, 6 a board, and the third reaches 29.
  carrom: {
    score: { kind: "carrom", names: ["Asha", "Ravi"], steps: [[11, 9], [17, 9], [23, 9], [29, 9]] },
    flight: {
      rest: pt(236, 160),
      toss: pt(236, 160),
      hit: pt(236, 160),
      ctrl: pt(181, 160),
      land: pt(126, 160),
      landScale: 0.55,
      star: pt(244, 168),
    },
    slide: { rest: pt(304, 190), aim: pt(282, 212), hit: pt(251, 177), end: pt(262, 190) },
  },
  // Kept for the day the quick match offers cricket (a lineup sport, excluded today): a straight drive, four runs.
  cricket: {
    score: { kind: "innings", names: ["Falcons CC"], steps: [[142, 3], [146, 3], [150, 3], [154, 3]] },
    flight: { rest: pt(-30, 150), toss: pt(190, 288), hit: pt(288, 219), ctrl: pt(186, -10), land: pt(84, 286) },
    swing: { pivot: pt(316, 296), back: 35, strike: -20, over: -45, settle: -32, sway: -28 },
  },
  // A penalty: the ball on the spot, the boot strikes it under the bar.
  football: {
    score: { kind: "goals", names: ["United", "Rovers"], steps: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    flight: { rest: pt(256, 283), toss: pt(256, 283), hit: pt(256, 283), ctrl: pt(168, 180), land: pt(80, 236) },
    swing: { pivot: pt(322, 200), back: -45, strike: 0, over: 30, settle: 20, sway: 17 },
  },
  // A penalty corner: the ball pushed out, stopped and struck into the goal.
  hockey: {
    score: { kind: "goals", names: ["Oaks", "Elms"], steps: [[1, 1], [2, 1], [3, 1], [4, 1]] },
    flight: { rest: pt(196, 288), toss: pt(240, 288), hit: pt(268, 288), ctrl: pt(177, 248), land: pt(86, 272) },
    swing: { pivot: pt(338, 150), back: -30, strike: 0, over: 25, settle: 16, sway: 13 },
  },
  // A pass onto the blade, a wrist shot under the bar.
  icehockey: {
    score: { kind: "goals", names: ["Wolves", "Bears"], steps: [[2, 2], [3, 2], [4, 2], [5, 2]] },
    flight: { rest: pt(190, 290), toss: pt(240, 290), hit: pt(280, 290), ctrl: pt(186, 236), land: pt(92, 270) },
    swing: { pivot: pt(340, 150), back: -25, strike: 0, over: 22, settle: 14, sway: 11 },
  },
  // Rally scoring to 11, two clear: 11–8 takes the game.
  tabletennis: {
    score: { kind: "rally", names: ["Lin", "Ito"], steps: [[8, 8], [9, 8], [10, 8], [11, 8]] },
    flight: { rest: pt(300, 236), toss: pt(318, 90), hit: pt(329, 172), ctrl: pt(212, 60), land: pt(96, 236) },
    swing: { pivot: pt(352, 236), back: 25, strike: -20, over: -45, settle: -32, sway: -28 },
  },
  // Serving for the set at 5–4: 15–15, 30–15, 40–15, and the winner takes the game and the set, 6–4.
  tennis: {
    score: { kind: "tennis", names: ["Moreau", "Silva"], games: [5, 4], steps: [[1, 1], [2, 1], [3, 1], [4, 1]] },
    flight: { rest: pt(300, 284), toss: pt(280, 70), hit: pt(271, 159), ctrl: pt(176, 0), land: pt(82, 284) },
    swing: { pivot: pt(322, 298), back: 24, strike: -20, over: -45, settle: -32, sway: -28 },
  },
  // Rally scoring to 21, two clear (beach, the quick match's default volleyball rules): a spike takes the set at 21–18.
  volleyball: {
    score: { kind: "rally", names: ["Costa", "Weber"], steps: [[18, 18], [19, 18], [20, 18], [21, 18]] },
    flight: { rest: pt(322, 282), toss: pt(300, 64), hit: pt(282, 104), ctrl: pt(183, 40), land: pt(84, 282) },
  },
} as const satisfies Record<string, HeroScene>;

export type HeroSceneKey = keyof typeof HERO_SCENES;

/** The scene the art opens on with no sport, and for any key it has no scene for. */
export const HERO_DEFAULT_SCENE: HeroSceneKey = "badminton";

/** The scene for a sport key: exact keys only (a sport key is lower case, never the funnel's `Badminton`), own keys only
 *  (`constructor` is no sport), anything else badminton. */
export function heroSceneKey(sport: string | null | undefined): HeroSceneKey {
  return typeof sport === "string" && Object.hasOwn(HERO_SCENES, sport) ? (sport as HeroSceneKey) : HERO_DEFAULT_SCENE;
}

/** The dictionary key of a scene's accessible name (marketing namespace, all four locales). */
export function heroSceneLabelKey(scene: HeroSceneKey): `home.hero.scene.${HeroSceneKey}` {
  return `home.hero.scene.${scene}`;
}

/** ITF Rule 5(a): the call of a standard game's points won, 0 to 3. */
const POINT_CALLS = ["0", "15", "30", "40"] as const;

/** A tennis frame's score: the game's points called while it is on; once a side wins the point after 40 two clear, the
 *  set's `games` with that game counted. Deuce and advantage are no frame the scorebug writes: a frame past 40 that is no
 *  won game is refused, never written as a games score. */
export function heroTennisCall(games: readonly [number, number], points: readonly [number, number]): string {
  const [h, a] = points;
  const last = POINT_CALLS.length - 1;
  if (h <= last && a <= last) return `${POINT_CALLS[h]}–${POINT_CALLS[a]}`;
  if (Math.abs(h - a) < 2) throw new Error(`hero tennis: ${h}–${a} is deuce or advantage, no frame the scorebug writes`);
  return h > a ? `${games[0] + 1}–${games[1]}` : `${games[0]}–${games[1] + 1}`;
}

/** Half points written the chess way: 2 → "1", 1 → "½", 3 → "1½". */
function halfPoints(n: number): string {
  const whole = Math.floor(n / 2);
  const half = n % 2 === 1 ? "½" : "";
  return whole === 0 ? half || "0" : `${whole}${half}`;
}

/** The scorebug's words for a scene after `landings` landings: the first frame before any, held at the last. */
export function heroScoreText(scene: HeroSceneKey, landings: number): string {
  const { score } = HERO_SCENES[scene] as HeroScene;
  const [home, away] = score.steps[Math.min(Math.max(landings, 0), score.steps.length - 1)]!;
  if (score.kind === "innings") return `${score.names[0]} ${home}/${away}`;
  const [a, b] = score.names;
  if (score.kind === "tennis") return `${a} ${heroTennisCall(score.games, [home, away])} ${b}`;
  if (score.kind === "chess") return `${a} ${halfPoints(home)}–${halfPoints(away)} ${b}`;
  return `${a} ${home}–${away} ${b}`;
}

/** The point on the flight curve at `t` (0 = struck, 1 = landed). */
export function heroFlightAt(flight: HeroFlight, t: number): HeroPoint {
  const u = 1 - t;
  return {
    x: u * u * flight.hit.x + 2 * u * t * flight.ctrl.x + t * t * flight.land.x,
    y: u * u * flight.hit.y + 2 * u * t * flight.ctrl.y + t * t * flight.land.y,
  };
}

/** The trail the art draws: the flight curve itself. */
export function heroTrailPath(flight: HeroFlight): string {
  const { hit, ctrl, land } = flight;
  return `M${hit.x} ${hit.y} Q${ctrl.x} ${ctrl.y} ${land.x} ${land.y}`;
}

const at = (p: HeroPoint) => `${Math.round(p.x * 10) / 10}px, ${Math.round(p.y * 10) / 10}px`;

/** How much of the trail is still undrawn when the object reaches t (the stroke's dash offset, of 100): the curve's own
 *  arc length, so the drawn trail ends at the object, not ahead of it (equal steps of t are not equal lengths). */
export function heroTrailOffsetAt(flight: HeroFlight, t: number): number {
  const N = 240;
  let total = 0;
  let upTo = 0;
  let prev = heroFlightAt(flight, 0);
  for (let i = 1; i <= N; i++) {
    const p = heroFlightAt(flight, i / N);
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    total += d;
    if (i / N <= t) upTo += d;
    prev = p;
  }
  return total === 0 ? 0 : Math.round((100 - (100 * upTo) / total) * 10) / 10;
}

/** The custom properties the shared choreography reads (globals.css): the whole geometry, set on every scene, so none
 *  inherits another's. The flight's quarter points are the curve's own, at t = ¼, ½, ¾. */
export function heroSceneStyle(scene: HeroSceneKey): Record<`--mk-${string}`, string> {
  const { flight, swing, slide } = HERO_SCENES[scene] as HeroScene;
  return {
    "--mk-rest": at(flight.rest),
    "--mk-toss": at(flight.toss),
    "--mk-hit": at(flight.hit),
    "--mk-f1": at(heroFlightAt(flight, 0.25)),
    "--mk-f2": at(heroFlightAt(flight, 0.5)),
    "--mk-f3": at(heroFlightAt(flight, 0.75)),
    "--mk-land": at(flight.land),
    "--mk-d1": String(heroTrailOffsetAt(flight, 0.25)),
    "--mk-d2": String(heroTrailOffsetAt(flight, 0.5)),
    "--mk-d3": String(heroTrailOffsetAt(flight, 0.75)),
    "--mk-lift": String(flight.lift ?? 1),
    "--mk-land-scale": String(flight.landScale ?? 1),
    "--mk-star-at": `${flight.starAt ?? 1.5}s`,
    ...(swing
      ? {
          "--mk-pivot": `${swing.pivot.x}px ${swing.pivot.y}px`,
          "--mk-back": `${swing.back}deg`,
          "--mk-strike": `${swing.strike}deg`,
          "--mk-over": `${swing.over}deg`,
          "--mk-settle": `${swing.settle}deg`,
          "--mk-sway": `${swing.sway}deg`,
        }
      : {}),
    ...(slide
      ? {
          "--mk-s-rest": at(slide.rest),
          "--mk-s-aim": at(slide.aim),
          "--mk-s-hit": at(slide.hit),
          "--mk-s-end": at(slide.end),
        }
      : {}),
  };
}
