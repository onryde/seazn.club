// The hero vignette's drawings, one per scene (hero-scenes.ts holds each scene's score and geometry). Object relay, no
// humans (design/v3/12 §4.2): the ball, shuttle, puck or piece is the protagonist. Each drawing has the same parts so the
// one CSS choreography (globals.css) moves them all: `.mk-bat` (a striker that swings about its pivot) or `.mk-slide` (one
// that slides), `.mk-star` (the impact), `.mk-trail` (the flight, drawn as it flies) and `.mk-ball` (the object, drawn
// about its own origin, so the choreography's translate places it). `.mk-net` is a goal's net, which bulges as it scores.
//
// No directive: the client vignette imports it; nothing here holds state.
import type { ReactNode } from "react";
import { HERO_SCENES, heroTrailPath, type HeroFlight, type HeroPoint, type HeroSceneKey } from "./hero-scenes";

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

/** Chess pieces, drawn about their own origin (about 40 tall). */
const PIECE: Record<"knight" | "king" | "rook" | "pawn", ReactNode> = {
  knight: (
    <>
      <path d="M-10 10 C-10 1 -1 -2 -4 -7 L-12 -3 Q-17 -5 -15 -11 L-5 -19 L-5 -24 L0 -20 Q12 -20 13 -5 Q14 5 10 10 Z" />
      <rect x="-14" y="10" width="28" height="7" rx="3" />
    </>
  ),
  king: (
    <>
      <path d="M-9 10 L-11 -4 Q0 -10 11 -4 L9 10 Z M-2 -8 L-2 -14 L-6 -14 L-6 -18 L-2 -18 L-2 -22 L2 -22 L2 -18 L6 -18 L6 -14 L2 -14 L2 -8 Z" />
      <rect x="-13" y="10" width="26" height="7" rx="3" />
    </>
  ),
  rook: (
    <>
      <path d="M-9 10 L-9 -8 L-12 -8 L-12 -18 L-7 -18 L-7 -13 L-2 -13 L-2 -18 L2 -18 L2 -13 L7 -13 L7 -18 L12 -18 L12 -8 L9 -8 L9 10 Z" />
      <rect x="-13" y="10" width="26" height="7" rx="3" />
    </>
  ),
  pawn: (
    <>
      <path d="M-8 10 Q-8 0 -3 -3 A6.5 6.5 0 1 1 3 -3 Q8 0 8 10 Z" />
      <rect x="-12" y="10" width="24" height="7" rx="3" />
    </>
  ),
};

function Piece({ kind, at, side }: { kind: keyof typeof PIECE; at: HeroPoint; side: "white" | "black" }) {
  return (
    <g
      transform={`translate(${at.x} ${at.y})`}
      fill={side === "white" ? "var(--mk-cream)" : INK}
      stroke={side === "white" ? INK : "var(--mk-cream)"}
      strokeWidth="2.5"
      strokeLinejoin="round"
    >
      {PIECE[kind]}
    </g>
  );
}

/** The board: six files by five ranks of 44, from (122, 34); a square's centre. */
const SQ = 44;
const square = (file: number, rank: number): HeroPoint => ({ x: 122 + SQ * file + SQ / 2, y: 34 + SQ * rank + SQ / 2 });

function Chess() {
  const { flight } = HERO_SCENES.boardgame;
  const squares = Array.from({ length: 30 }, (_, i) => ({ file: i % 6, rank: Math.floor(i / 6) }));
  return (
    <>
      <rect x="112" y="24" width="284" height="240" rx="10" fill="#3b2a6e" stroke={INK} strokeWidth="3" />
      {squares.map(({ file, rank }) => (
        <rect
          key={`${file}${rank}`}
          x={122 + SQ * file}
          y={34 + SQ * rank}
          width={SQ}
          height={SQ}
          fill={(file + rank) % 2 === 0 ? "var(--mk-cream)" : "var(--mk-purple)"}
        />
      ))}
      {/* the knight forks the king and the rook */}
      <Piece kind="king" at={square(1, 1)} side="black" />
      <Piece kind="rook" at={square(5, 1)} side="black" />
      <Piece kind="pawn" at={square(2, 3)} side="white" />
      <Piece kind="king" at={square(0, 4)} side="white" />
      <Trail flight={flight} />
      <Star at={flight.star!} />
      <g className="mk-ball">
        <Halo r={36} />
        <g fill="var(--mk-cream)" stroke={INK} strokeWidth="3" strokeLinejoin="round" transform="scale(1.2)">
          {PIECE.knight}
          <circle cx="-3" cy="-13" r="1.6" fill={INK} stroke="none" />
        </g>
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
