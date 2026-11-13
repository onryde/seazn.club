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
  /** Scale while carried (a chess piece lifted off the board). */
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
 *  `carrom` read `home h–a away`; `tennis` calls the points (0, 15, 30, 40); `chess` writes half points (the engine stores
 *  1 / ½ / 0 as 2 / 1 / 0); `innings` reads `team runs/wickets`. */
export type HeroScore =
  | {
      readonly kind: "rally" | "goals" | "carrom" | "tennis" | "chess";
      readonly names: readonly [string, string];
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

export const HERO_SCENES = {
  // Rally scoring to 15, two clear (BWF 3×15, the quick match's default badminton rules): 15–12 takes the game.
  badminton: {
    score: { kind: "rally", names: ["Kim", "Park"], steps: [[12, 12], [13, 12], [14, 12], [15, 12]] },
    flight: { rest: pt(290, 318), toss: pt(276, 96), hit: pt(272, 168), ctrl: pt(178, -40), land: pt(84, 289) },
    swing: { pivot: pt(318, 296), back: 30, strike: -20, over: -45, settle: -32, sway: -28 },
  },
  // A board game: a mini-match in half points, one game a landing (a win, then a draw, then a win).
  boardgame: {
    score: { kind: "chess", names: ["Petrova", "Lund"], steps: [[1, 1], [3, 1], [4, 2], [6, 2]] },
    flight: {
      rest: pt(320, 232),
      toss: pt(320, 214),
      hit: pt(320, 218),
      ctrl: pt(322, 138),
      land: pt(276, 144),
      lift: 1.3,
      star: pt(188, 100),
      starAt: 2.3,
    },
  },
  // Carrom, club rules (game to 29, the queen 5 below 24): a board scores the coins left, plus the queen.
  carrom: {
    score: { kind: "carrom", names: ["Asha", "Ravi"], steps: [[12, 9], [18, 9], [22, 9], [29, 9]] },
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
  // A game's points, called: 0–15, 15–15, 30–15, 40–15.
  tennis: {
    score: { kind: "tennis", names: ["Moreau", "Silva"], steps: [[0, 1], [1, 1], [2, 1], [3, 1]] },
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
  if (score.kind === "tennis") return `${a} ${POINT_CALLS[home]}–${POINT_CALLS[away]} ${b}`;
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
