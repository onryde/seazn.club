// The hero vignette's drawings, one per scene (hero-scenes.ts holds each scene's score and geometry). Object relay, no
// humans (design/v3/12 §4.2): the ball, shuttle, puck or piece is the protagonist. Each drawing has the same parts so the
// one CSS choreography (globals.css) moves them all: `.mk-bat` (a striker that swings about its pivot) or `.mk-slide` (one
// that slides), `.mk-star` (the impact), `.mk-trail` (the flight, drawn as it flies) and `.mk-ball` (the object, drawn
// about its own origin, so the choreography's translate places it). `.mk-net` is a goal's net, which bulges as it scores;
// `.mk-pick`, `.mk-hints`, `.mk-dest` and `.mk-mate` are the chess board's cues around its one move.
//
// No directive: the client vignette imports it; nothing here holds state.
import type { ReactNode } from "react";
import {
  HERO_BOARD,
  HERO_CHESS,
  HERO_SCENES,
  heroChessKing,
  heroChessSquare,
  heroTrailPath,
  type HeroFlight,
  type HeroPoint,
  type HeroSceneKey,
} from "./hero-scenes";

const INK = "#1e1b2e";
const MESH = "#b7aede";
const GROUND_Y = 300;

function Ground({ color = "var(--mk-lime)" }: { color?: string }) {
  return (
    <line x1="16" y1={GROUND_Y} x2="404" y2={GROUND_Y} stroke={color} strokeWidth="4" strokeLinecap="round" opacity="0.85" />
  );
}

/** The flight, drawn behind the object as it flies (the curve the object follows, hero-scenes.ts `heroTrailPath`). */
function Trail({ flight }: { flight: HeroFlight }) {
  return (
    <path
      className="mk-trail"
      d={heroTrailPath(flight)}
      pathLength={100}
      fill="none"
      stroke="var(--mk-lime)"
      strokeWidth="3"
      strokeLinecap="round"
      opacity="0.55"
    />
  );
}

function Star({ at }: { at: HeroPoint }) {
  return (
    <g transform={`translate(${at.x} ${at.y}) scale(1.15)`}>
      <path
        className="mk-star"
        d="M-20 -14 l10 -22 6 20 20 -8 -14 18 22 6 -24 6 10 20 -20 -12 -6 22 -8 -22z"
        fill="var(--mk-orange)"
        stroke={INK}
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** The glow that lifts the object off the night stage: lime at its heart, gone at its edge (`HALO`, defined once per svg). */
const HALO = "mk-halo";
const Halo = ({ r, cx = 0, cy = 0 }: { r: number; cx?: number; cy?: number }) => (
  <circle cx={cx} cy={cy} r={r} fill={`url(#${HALO})`} />
);
function HaloDef() {
  return (
    <defs>
      <radialGradient id={HALO}>
        <stop offset="0" style={{ stopColor: "var(--mk-lime)", stopOpacity: 0.6 }} />
        <stop offset="0.55" style={{ stopColor: "var(--mk-lime)", stopOpacity: 0.22 }} />
        <stop offset="1" style={{ stopColor: "var(--mk-lime)", stopOpacity: 0 }} />
      </radialGradient>
    </defs>
  );
}

/** A net seen across the court: two posts, a mesh panel between them, the white tape on top. */
function Net({ x, width, top, bottom, postTop = top - 6 }: { x: number; width: number; top: number; bottom: number; postTop?: number }) {
  const cols = Array.from({ length: Math.floor(width / 6) }, (_, i) => x + 6 * (i + 1));
  const rows = Array.from({ length: Math.floor((bottom - top) / 6) }, (_, i) => top + 6 * (i + 1));
  return (
    <g>
      <rect x={x} y={top} width={width} height={bottom - top} fill={MESH} fillOpacity="0.14" />
      <g stroke={MESH} strokeWidth="1.2" opacity="0.85">
        {cols.map((cx) => (
          <line key={`c${cx}`} x1={cx} y1={top} x2={cx} y2={bottom} />
        ))}
        {rows.map((ry) => (
          <line key={`r${ry}`} x1={x} y1={ry} x2={x + width} y2={ry} />
        ))}
      </g>
      <line x1={x} y1={bottom} x2={x + width} y2={bottom} stroke={MESH} strokeWidth="2" />
      {[x, x + width].map((px) => (
        <line key={px} x1={px} y1={postTop} x2={px} y2={GROUND_Y} stroke="var(--mk-cream)" strokeWidth="5" strokeLinecap="round" />
      ))}
      <line x1={x - 3} y1={top} x2={x + width + 3} y2={top} stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
    </g>
  );
}

/** A goal, face on: the net (which bulges as the shot lands), then the frame over it. */
function Goal({ left, right, bar, post = "var(--mk-cream)", mesh = MESH, backboard }: {
  left: number;
  right: number;
  bar: number;
  post?: string;
  mesh?: string;
  backboard?: string;
}) {
  const cols = Array.from({ length: Math.floor((right - left) / 10) }, (_, i) => left + 10 * (i + 1));
  const rows = Array.from({ length: Math.floor((GROUND_Y - bar) / 10) }, (_, i) => bar + 10 * (i + 1));
  const frame = `M${left} ${GROUND_Y} L${left} ${bar} L${right} ${bar} L${right} ${GROUND_Y}`;
  return (
    <g>
      <g className="mk-net">
        <rect x={left} y={bar} width={right - left} height={GROUND_Y - bar} fill={mesh} fillOpacity="0.12" />
        <g stroke={mesh} strokeWidth="1.3" opacity="0.8">
          {cols.map((cx) => (
            <line key={`c${cx}`} x1={cx} y1={bar} x2={cx} y2={GROUND_Y} />
          ))}
          {rows.map((ry) => (
            <line key={`r${ry}`} x1={left} y1={ry} x2={right} y2={ry} />
          ))}
        </g>
      </g>
      {backboard ? (
        <rect x={left} y={GROUND_Y - 16} width={right - left} height="16" fill={backboard} stroke={INK} strokeWidth="2" />
      ) : null}
      <path d={frame} fill="none" stroke={INK} strokeWidth="11" strokeLinejoin="round" />
      <path d={frame} fill="none" stroke={post} strokeWidth="7" strokeLinejoin="round" />
    </g>
  );
}

/** Racket strings, clipped to the head. */
function Strings({ id, cx, cy, rx, ry, color = "var(--mk-cream)" }: { id: string; cx: number; cy: number; rx: number; ry: number; color?: string }) {
  const xs = Array.from({ length: Math.floor((2 * rx) / 7) }, (_, i) => cx - rx + 7 * (i + 1));
  const ys = Array.from({ length: Math.floor((2 * ry) / 7) }, (_, i) => cy - ry + 7 * (i + 1));
  return (
    <>
      <defs>
        <clipPath id={id}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`} stroke={color} strokeWidth="1.3" opacity="0.6">
        {xs.map((x) => (
          <line key={`x${x}`} x1={x} y1={cy - ry} x2={x} y2={cy + ry} />
        ))}
        {ys.map((y) => (
          <line key={`y${y}`} x1={cx - rx} y1={y} x2={cx + rx} y2={y} />
        ))}
      </g>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The scenes.
// ---------------------------------------------------------------------------------------------------------------------

function Badminton() {
  const { flight } = HERO_SCENES.badminton;
  return (
    <>
      <Ground />
      <Net x={184} width={26} top={192} bottom={244} />
      <Trail flight={flight} />
      {/* racket: grip at the pivot, head up; the swing brings the head's sweet spot through the strike point */}
      <g className="mk-bat">
        <rect x="315.5" y="196" width="5" height="58" rx="2.5" fill="var(--mk-cream)" stroke={INK} strokeWidth="2" />
        <rect x="312" y="250" width="12" height="46" rx="6" fill="var(--mk-lime)" stroke={INK} strokeWidth="3" />
        <ellipse cx="318" cy="160" rx="30" ry="40" fill="#1a0f3e" stroke={INK} strokeWidth="10" />
        <Strings id="mk-strings-badminton" cx={318} cy={160} rx={25} ry={35} />
        <ellipse cx="318" cy="160" rx="30" ry="40" fill="none" stroke="var(--mk-cream)" strokeWidth="5" />
      </g>
      <Star at={flight.hit} />
      {/* the shuttle: cork at the origin, feathers trailing up and right */}
      <g className="mk-ball">
        <Halo r={40} cx={12} cy={-12} />
        <path d="M1.5 -11 L11 -1.5 L39 -16 L16 -39 Z" fill="#ffffff" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
        <path d="M4 -9 L22 -33 M9 -4 L33 -22 M7 -19 L19 -7" stroke={INK} strokeWidth="1.6" opacity="0.55" />
        <circle r="11" fill="#fb7185" stroke={INK} strokeWidth="3" />
      </g>
    </>
  );
}

function Tennis() {
  const { flight } = HERO_SCENES.tennis;
  return (
    <>
      <Ground />
      <Net x={160} width={66} top={244} bottom={294} />
      <Trail flight={flight} />
      <g className="mk-bat">
        <path d="M322 242 L305 194 M322 242 L339 194" stroke={INK} strokeWidth="9" strokeLinecap="round" fill="none" />
        <path d="M322 242 L305 194 M322 242 L339 194" stroke="var(--mk-lime)" strokeWidth="5" strokeLinecap="round" fill="none" />
        <rect x="315" y="236" width="14" height="62" rx="6" fill="var(--mk-cream)" stroke={INK} strokeWidth="3" />
        <ellipse cx="322" cy="150" rx="34" ry="46" fill="#1a0f3e" stroke={INK} strokeWidth="11" />
        <Strings id="mk-strings-tennis" cx={322} cy={150} rx={29} ry={41} />
        <ellipse cx="322" cy="150" rx="34" ry="46" fill="none" stroke="var(--mk-lime)" strokeWidth="6" />
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={36} />
        <circle r="16" fill="#e6f54a" stroke={INK} strokeWidth="3" />
        <path d="M-12 -10.5 Q-2 0 -12 10.5 M12 -10.5 Q2 0 12 10.5" stroke="#ffffff" strokeWidth="2.2" fill="none" />
      </g>
    </>
  );
}

function TableTennis() {
  const { flight } = HERO_SCENES.tabletennis;
  return (
    <>
      <Ground />
      {/* the table, side on: the top, its white edge, two legs; the net clamped at its middle */}
      <rect x="50" y="256" width="8" height="44" fill="#8d7fc0" />
      <rect x="282" y="256" width="8" height="44" fill="#8d7fc0" />
      <rect x="20" y="246" width="300" height="10" rx="2" fill="#2563eb" stroke={INK} strokeWidth="3" />
      <line x1="22" y1="246" x2="318" y2="246" stroke="#ffffff" strokeWidth="2.5" />
      <rect x="160" y="214" width="20" height="32" fill={MESH} fillOpacity="0.25" />
      <g stroke={MESH} strokeWidth="1.2">
        <line x1="166" y1="214" x2="166" y2="246" />
        <line x1="172" y1="214" x2="172" y2="246" />
        <line x1="160" y1="222" x2="180" y2="222" />
        <line x1="160" y1="230" x2="180" y2="230" />
        <line x1="160" y1="238" x2="180" y2="238" />
      </g>
      <line x1="160" y1="210" x2="160" y2="252" stroke="var(--mk-cream)" strokeWidth="4" strokeLinecap="round" />
      <line x1="180" y1="210" x2="180" y2="252" stroke="var(--mk-cream)" strokeWidth="4" strokeLinecap="round" />
      <line x1="158" y1="214" x2="182" y2="214" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
      <Trail flight={flight} />
      <g className="mk-bat">
        <rect x="346" y="190" width="12" height="46" rx="4" fill="#d9b98a" stroke={INK} strokeWidth="3" />
        <circle cx="352" cy="164" r="30" fill="#0f0a1f" stroke={INK} strokeWidth="3" />
        <circle cx="352" cy="164" r="26" fill="#e11d48" />
        <g fill="#9f1239">
          <circle cx="344" cy="156" r="1.6" />
          <circle cx="356" cy="152" r="1.6" />
          <circle cx="360" cy="166" r="1.6" />
          <circle cx="346" cy="172" r="1.6" />
        </g>
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={26} />
        <circle r="10" fill="#ffffff" stroke={INK} strokeWidth="2.5" />
      </g>
    </>
  );
}

function Volleyball() {
  const { flight } = HERO_SCENES.volleyball;
  return (
    <>
      <Ground />
      <Net x={180} width={40} top={140} bottom={198} />
      <Trail flight={flight} />
      {/* no striker: the set rises, the spike lands as the star */}
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={40} />
        <circle r="18" fill="#ffffff" />
        <path d="M0 -18 A18 18 0 0 1 15.6 9 Q4 2 0 -18 Z" fill="#fde047" />
        <path d="M-15.6 9 A18 18 0 0 0 15.6 9 Q0 -2 -15.6 9 Z" fill="#2563eb" />
        <path d="M0 -18 Q4 2 15.6 9 M-15.6 9 Q0 -2 15.6 9 M0 -18 Q-6 -2 -15.6 9" stroke={INK} strokeWidth="1.8" fill="none" />
        <circle r="18" fill="none" stroke={INK} strokeWidth="3" />
      </g>
    </>
  );
}

function Football() {
  const { flight } = HERO_SCENES.football;
  return (
    <>
      <Ground />
      <Goal left={24} right={150} bar={196} />
      <Trail flight={flight} />
      {/* a boot on the end of its swing: toe left, studs down; the strike meets the ball on the spot */}
      <g className="mk-bat">
        <path
          d="M352 254 L352 280 Q352 292 340 294 L282 294 Q268 294 268 284 Q268 276 280 274 L318 268 L326 254 Z"
          fill="var(--mk-lime)"
          stroke={INK}
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d="M300 286 l10 -14 M312 286 l10 -16 M324 286 l10 -18" stroke="var(--mk-cream)" strokeWidth="3" strokeLinecap="round" />
        <line x1="326" y1="254" x2="352" y2="254" stroke="var(--mk-cream)" strokeWidth="4" strokeLinecap="round" />
        <g fill={INK}>
          <rect x="284" y="294" width="6" height="5" rx="1" />
          <rect x="300" y="294" width="6" height="5" rx="1" />
          <rect x="328" y="294" width="6" height="5" rx="1" />
          <rect x="342" y="292" width="6" height="5" rx="1" />
        </g>
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={38} />
        <circle r="17" fill="#ffffff" stroke={INK} strokeWidth="3" />
        <path d="M0 -6.5 L6.2 -2 L3.8 5.3 L-3.8 5.3 L-6.2 -2 Z" fill={INK} />
        <path d="M0 -6.5 L0 -14.5 M6.2 -2 L13.8 -4.5 M3.8 5.3 L8.5 11.8 M-3.8 5.3 L-8.5 11.8 M-6.2 -2 L-13.8 -4.5" stroke={INK} strokeWidth="2" />
      </g>
    </>
  );
}

function Hockey() {
  const { flight } = HERO_SCENES.hockey;
  return (
    <>
      <Ground />
      <Goal left={28} right={150} bar={226} backboard="#3b2a6e" />
      <Trail flight={flight} />
      {/* the stick: grip at the pivot, the hook on the ground meeting the ball */}
      <g className="mk-bat">
        <path d="M338 150 L308 278 Q304 296 288 296 Q276 296 280 284" stroke={INK} strokeWidth="13" strokeLinecap="round" fill="none" />
        <path d="M338 150 L308 278 Q304 296 288 296 Q276 296 280 284" stroke="var(--mk-lime)" strokeWidth="8" strokeLinecap="round" fill="none" />
        <path d="M338 150 L330 186" stroke="var(--mk-cream)" strokeWidth="9" strokeLinecap="round" />
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={30} />
        <circle r="12" fill="#ffffff" stroke={INK} strokeWidth="2.5" />
        <g fill="#c4b5fd">
          <circle cx="-3" cy="-3" r="1.6" />
          <circle cx="4" cy="-1" r="1.6" />
          <circle cx="0" cy="4" r="1.6" />
        </g>
      </g>
    </>
  );
}

function IceHockey() {
  const { flight } = HERO_SCENES.icehockey;
  return (
    <>
      <rect x="16" y="298" width="388" height="8" fill="#bae6fd" opacity="0.18" />
      <Ground color="#bae6fd" />
      <line x1="36" y1={GROUND_Y} x2="150" y2={GROUND_Y} stroke="#ef4444" strokeWidth="4" />
      <Goal left={36} right={150} bar={226} post="#ef4444" mesh="#e2e8f0" />
      <Trail flight={flight} />
      {/* the stick: the shaft from the pivot, the taped blade flat on the ice */}
      <g className="mk-bat">
        <path d="M340 150 L302 288" stroke={INK} strokeWidth="12" strokeLinecap="round" />
        <path d="M340 150 L302 288" stroke="#d9b98a" strokeWidth="7" strokeLinecap="round" />
        <path d="M306 290 L262 292" stroke={INK} strokeWidth="13" strokeLinecap="round" />
        <path d="M306 290 L262 292" stroke="var(--mk-cream)" strokeWidth="8" strokeLinecap="round" />
        <path d="M300 290 L266 292" stroke={INK} strokeWidth="8" strokeDasharray="3 4" opacity="0.45" />
        <circle cx="340" cy="150" r="6" fill={INK} />
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <ellipse rx="34" ry="20" fill={`url(#${HALO})`} />
        <ellipse cy="4" rx="16" ry="6" fill="#0f0a1f" stroke="var(--mk-cream)" strokeWidth="2" />
        <rect x="-16" y="-2" width="32" height="6" fill="#0f0a1f" />
        <ellipse cy="-2" rx="16" ry="6" fill="#2a2440" stroke="var(--mk-cream)" strokeWidth="2.5" />
      </g>
    </>
  );
}

// The chess scene: a board as chess is played online (owner 2026-11-13: "online / external chess play"). Its colours are
// its own, never the games module's: the green-and-white board, the half-strength yellow that lights a picked piece's
// square and the last move's two, the dots of shade on a picked piece's legal squares, the orange of a move's arrow, and
// the red glow of a king in check.
const BOARD_LIGHT = "#eeeed2";
const BOARD_DARK = "#769656";
const MOVE_LIGHT = "#ffff00";
const HINT_SHADE = "#000000";
const MOVE_ARROW = "#ffaa00";
const CHECK_RED = "#e70000";
const FILE_LETTERS = "abcdefgh";
const WHITE_PIECE = "#fbfaf7";
const BLACK_PIECE = "#2c2834";

type PieceKind = "k" | "q" | "r" | "b" | "n" | "p";

/** The pieces' silhouettes, drawn about the square's centre, about 29 tall: `body` takes the side's fill and outline,
 *  `detail` the lines drawn on it. */
const PIECES: Record<PieceKind, { body: ReactNode; detail?: ReactNode }> = {
  p: {
    body: (
      <>
        <path d="M-5.5 -2.2 H5.5 V0.3 H3.2 Q3.4 6 8.4 9.4 L9.4 13 H-9.4 L-8.4 9.4 Q-3.4 6 -3.2 0.3 H-5.5 Z" />
        <circle cy="-7" r="5.4" />
      </>
    ),
  },
  r: {
    body: (
      <path d="M-9 -13.5 H-5 V-10.2 H-2 V-13.5 H2 V-10.2 H5 V-13.5 H9 V-6.5 L6.4 -4.2 L6.8 7 L10 9.6 L10 13 H-10 L-10 9.6 L-6.8 7 L-6.4 -4.2 L-9 -6.5 Z" />
    ),
    detail: <path d="M-6.4 -4.2 H6.4 M-6.8 7 H6.8" />,
  },
  n: {
    body: (
      <path d="M-7.5 13 H10 V9.8 Q10 8 8.6 7.4 Q11.4 -2 8.6 -7.4 Q5.6 -12.6 -0.6 -13.2 L-1.6 -16 L-4.4 -12.2 Q-6.6 -11 -8 -8 L-11.4 -2.4 Q-12.4 -0.2 -10.6 1.2 Q-8.8 2.2 -7.2 0.6 L-4.8 -1.4 Q-1.8 -1.2 -0.6 -3.4 Q0.6 1.2 -3.8 4.8 Q-7.6 8 -7.5 10.4 Z" />
    ),
    detail: (
      <>
        <circle cx="-3.6" cy="-7.4" r="1.25" stroke="none" />
        <path d="M2.4 -11.6 Q7.2 -8 6.4 0" fill="none" />
      </>
    ),
  },
  b: {
    body: (
      <>
        <path d="M-4.6 3.4 H4.6 L4.2 5.2 Q4.4 8.2 9 10 L9.6 13 H-9.6 L-9 10 Q-4.4 8.2 -4.2 5.2 Z" />
        <path d="M0 -11 Q7.6 -5 5.8 0.6 Q5 2.8 3.6 3.4 H-3.6 Q-5 2.8 -5.8 0.6 Q-7.6 -5 0 -11 Z" />
        <circle cy="-13" r="2.4" />
      </>
    ),
    detail: <path d="M1.6 -6.8 L-1.8 -2.2" />,
  },
  q: {
    body: (
      <>
        <path d="M-6.6 3 H6.6 L6.2 6 Q6.6 8.6 9.6 10 L10 13 H-10 L-9.6 10 Q-6.6 8.6 -6.2 6 Z" />
        <path d="M-9.6 -6.8 L-6.6 3 H6.6 L9.6 -6.8 L5.4 -1.4 L4.8 -9.6 L1.4 -2 L0 -11.2 L-1.4 -2 L-4.8 -9.6 L-5.4 -1.4 Z" />
        {[
          [-9.8, -8],
          [-4.9, -10.8],
          [0, -12.6],
          [4.9, -10.8],
          [9.8, -8],
        ].map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r="1.9" />
        ))}
      </>
    ),
    detail: <path d="M-6.2 6 H6.2" />,
  },
  k: {
    body: (
      <>
        <path d="M-6.6 3.6 H6.6 L6.2 6 Q6.6 8.6 9.6 10 L10 13 H-10 L-9.6 10 Q-6.6 8.6 -6.2 6 Z" />
        <path d="M0 -6.4 Q-3.4 -9.4 -7 -8.4 Q-11.6 -6.6 -10 -1.4 L-6.6 3.6 H6.6 L10 -1.4 Q11.6 -6.6 7 -8.4 Q3.4 -9.4 0 -6.4 Z" />
        <path d="M-1.4 -16.4 H1.4 V-14.2 H3.6 V-11.4 H1.4 V-6.6 H-1.4 V-11.4 H-3.6 V-14.2 H-1.4 Z" />
      </>
    ),
    detail: <path d="M-6.2 6 H6.2" />,
  },
};

/** A piece by its FEN letter (upper case White), about the origin. */
function ChessPiece({ letter }: { letter: string }) {
  const white = letter === letter.toUpperCase();
  const { body, detail } = PIECES[letter.toLowerCase() as PieceKind];
  return (
    <>
      <g fill={white ? WHITE_PIECE : BLACK_PIECE} stroke={white ? INK : "#0d0b12"} strokeWidth="1.8" strokeLinejoin="round">
        {body}
      </g>
      {detail ? (
        <g fill={white ? INK : "#e6e2ef"} stroke={white ? INK : "#e6e2ef"} strokeWidth="1.4" strokeLinecap="round">
          {detail}
        </g>
      ) : null}
    </>
  );
}

const CHESS_CLIP = "mk-chess-board";
const CHECK_GLOW = "mk-chess-check";

function Chess() {
  const { flight } = HERO_SCENES.boardgame;
  const { pieces, move, hints } = HERO_CHESS;
  const { x: left, y: top, square: side } = HERO_BOARD;
  const edge = 8 * side;
  /** A square's top-left corner, by name. */
  const corner = (name: string) => {
    const c = heroChessSquare(name);
    return { x: c.x - side / 2, y: c.y - side / 2 };
  };
  const squares = Array.from({ length: 64 }, (_, i) => ({ file: i % 8, rank: 8 - Math.floor(i / 8) }));
  // a1 is dark: a square is light when its file and rank (from 1) sum to an odd number.
  const isLight = (file: number, rank: number) => (file + 1 + rank) % 2 === 1;
  const king = heroChessKing("k");
  const kingAt = corner(king);
  const lit = (name: string, className: string) => {
    const c = corner(name);
    return <rect className={className} x={c.x} y={c.y} width={side} height={side} fill={MOVE_LIGHT} fillOpacity="0.5" />;
  };
  return (
    <>
      <defs>
        <clipPath id={CHESS_CLIP}>
          <rect x={left} y={top} width={edge} height={edge} rx="5" />
        </clipPath>
        <radialGradient id={CHECK_GLOW}>
          <stop offset="0" stopColor="#ff0000" />
          <stop offset="0.3" stopColor={CHECK_RED} />
          <stop offset="0.9" stopColor="#a90000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x={left} y={top + 6} width={edge} height={edge} rx="6" fill="#07040f" opacity="0.45" />
      <g clipPath={`url(#${CHESS_CLIP})`}>
        {squares.map(({ file, rank }) => (
          <rect
            key={`${file}${rank}`}
            x={left + side * file}
            y={top + side * (8 - rank)}
            width={side}
            height={side}
            fill={isLight(file, rank) ? BOARD_LIGHT : BOARD_DARK}
          />
        ))}
        {/* the picked piece's square, which stays lit as the move's from-square; the target, lit as the piece leaves */}
        {lit(move.from, "mk-pick")}
        {lit(move.to, "mk-dest")}
        {/* the mated king's square glows red as the piece lands */}
        <rect className="mk-mate" x={kingAt.x} y={kingAt.y} width={side} height={side} fill={`url(#${CHECK_GLOW})`} />
      </g>
      {/* coordinates, the way an online board prints them: ranks down the a-file, files along the first rank */}
      <g fontSize="7.5" fontWeight="700">
        {Array.from({ length: 8 }, (_, i) => (
          <text key={`r${i}`} x={left + 2.5} y={top + side * (7 - i) + 8.5} fill={isLight(0, i + 1) ? BOARD_DARK : BOARD_LIGHT}>
            {i + 1}
          </text>
        ))}
        {Array.from({ length: 8 }, (_, i) => (
          <text
            key={`f${i}`}
            x={left + side * (i + 1) - 2.5}
            y={top + edge - 2.5}
            textAnchor="end"
            fill={isLight(i, 1) ? BOARD_DARK : BOARD_LIGHT}
          >
            {FILE_LETTERS[i]}
          </text>
        ))}
      </g>
      {/* the picked piece's legal squares, dotted until it moves */}
      <g className="mk-hints" fill={HINT_SHADE} fillOpacity="0.17">
        {hints.map((name) => {
          const c = heroChessSquare(name);
          return <circle key={name} cx={c.x} cy={c.y} r={side * 0.16} />;
        })}
      </g>
      {/* the move's arrow, drawn as the piece slides along it */}
      <path
        className="mk-trail"
        d={heroTrailPath(flight)}
        pathLength={100}
        fill="none"
        stroke={MOVE_ARROW}
        strokeWidth={side * 0.2}
        strokeLinecap="round"
        opacity="0.75"
      />
      <g transform={`translate(${flight.star!.x} ${flight.star!.y})`}>
        <circle className="mk-star" r={side * 0.9} fill={`url(#${CHECK_GLOW})`} />
      </g>
      {Object.entries(pieces)
        .filter(([name]) => name !== move.from)
        .map(([name, letter]) => {
          const c = heroChessSquare(name);
          return (
            <g key={name} transform={`translate(${c.x} ${c.y})`}>
              <ChessPiece letter={letter} />
            </g>
          );
        })}
      {/* mate: the badge on the king's square */}
      <g className="mk-mate" transform={`translate(${kingAt.x + side - 3} ${kingAt.y + 3})`}>
        <circle r="7" fill={CHECK_RED} stroke="#ffffff" strokeWidth="1.6" />
        <text y="3.4" textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#ffffff">
          #
        </text>
      </g>
      {/* the piece that moves */}
      <g className="mk-ball">
        <ChessPiece letter={pieces[move.from]} />
      </g>
    </>
  );
}

function Carrom() {
  const { flight } = HERO_SCENES.carrom;
  const ring = [30, 90, 150, 210, 270, 330].map((deg, i) => ({
    x: 236 + 21 * Math.cos((deg * Math.PI) / 180),
    y: 160 + 21 * Math.sin((deg * Math.PI) / 180),
    black: i % 2 === 1,
  }));
  return (
    <>
      {/* the board, top down and turned a quarter: frame, surface, four pockets, the baselines, the centre circle */}
      <g transform="rotate(45 236 160)">
        <rect x="134" y="58" width="204" height="204" rx="10" fill="#8b5a2b" stroke={INK} strokeWidth="3" />
        <rect x="146" y="70" width="180" height="180" rx="4" fill="#f2d49b" />
        {[0, 90, 180, 270].map((turn) => (
          <g key={turn} transform={`rotate(${turn} 236 160)`} stroke="#7c2d12" strokeWidth="1.6" fill="none">
            <line x1="188" y1="222" x2="284" y2="222" />
            <line x1="188" y1="232" x2="284" y2="232" />
            <circle cx="188" cy="227" r="5" fill="#e11d48" />
            <circle cx="284" cy="227" r="5" fill="#e11d48" />
          </g>
        ))}
        <circle cx="236" cy="160" r="30" fill="none" stroke="#7c2d12" strokeWidth="2" />
        <circle cx="236" cy="160" r="12" fill="none" stroke="#e11d48" strokeWidth="2" />
        {[
          [158, 82],
          [314, 82],
          [158, 238],
          [314, 238],
        ].map(([cx, cy]) => (
          <circle key={`${cx}${cy}`} cx={cx} cy={cy} r="11" fill="#0f0a1f" stroke={INK} strokeWidth="2" />
        ))}
      </g>
      {ring.map((c) => (
        <circle
          key={`${c.x}`}
          cx={c.x}
          cy={c.y}
          r="8"
          fill={c.black ? INK : "var(--mk-cream)"}
          stroke={c.black ? "var(--mk-cream)" : INK}
          strokeWidth="2"
        />
      ))}
      <Trail flight={flight} />
      {/* the striker: slides along its baseline, then is shot into the queen */}
      <g className="mk-slide">
        <Halo r={30} />
        <circle r="13" fill="var(--mk-cream)" stroke={INK} strokeWidth="3" />
        <circle r="7.5" fill="none" stroke="var(--mk-lime)" strokeWidth="3" />
      </g>
      <Star at={flight.star!} />
      {/* the queen: cut into the left pocket */}
      <g className="mk-ball">
        <Halo r={28} />
        <circle r="10" fill="#e11d48" stroke={INK} strokeWidth="2.5" />
        <circle r="5" fill="none" stroke="#fecdd3" strokeWidth="1.5" />
      </g>
    </>
  );
}

function Cricket() {
  const { flight } = HERO_SCENES.cricket;
  return (
    <>
      <Ground />
      {/* the stumps behind the bat */}
      <g stroke={INK} strokeWidth="8" strokeLinecap="round">
        <line x1="372" y1="238" x2="372" y2={GROUND_Y} />
        <line x1="384" y1="238" x2="384" y2={GROUND_Y} />
        <line x1="396" y1="238" x2="396" y2={GROUND_Y} />
      </g>
      <g stroke="#d9b98a" strokeWidth="5" strokeLinecap="round">
        <line x1="372" y1="238" x2="372" y2={GROUND_Y} />
        <line x1="384" y1="238" x2="384" y2={GROUND_Y} />
        <line x1="396" y1="238" x2="396" y2={GROUND_Y} />
      </g>
      <line x1="368" y1="233" x2="400" y2="233" stroke="var(--mk-cream)" strokeWidth="4" strokeLinecap="round" />
      <Trail flight={flight} />
      <g className="mk-bat">
        <rect x="302" y="150" width="28" height="106" rx="13" fill="#d9b98a" stroke={INK} strokeWidth="3" />
        <rect x="310" y="250" width="12" height="46" rx="6" fill="#8a6a3f" stroke={INK} strokeWidth="3" />
      </g>
      <Star at={flight.hit} />
      <g className="mk-ball">
        <Halo r={34} />
        <circle r="15" fill="#f43f5e" stroke={INK} strokeWidth="3" />
        <path d="M-10 -6 q10 7 20 0" fill="none" stroke="var(--mk-cream)" strokeWidth="2" />
      </g>
    </>
  );
}

const ART: Record<HeroSceneKey, () => ReactNode> = {
  badminton: Badminton,
  boardgame: Chess,
  carrom: Carrom,
  cricket: Cricket,
  football: Football,
  hockey: Hockey,
  icehockey: IceHockey,
  tabletennis: TableTennis,
  tennis: Tennis,
  volleyball: Volleyball,
};

/** One scene's drawing, for the vignette's svg (viewBox 0 0 420 360). */
export function HeroSceneArt({ scene }: { scene: HeroSceneKey }) {
  const Art = ART[scene];
  return (
    <>
      <HaloDef />
      <Art />
    </>
  );
}
