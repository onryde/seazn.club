// The Sport picker's icons (Match Day C9 R2, owner 2026-11-03: "Sport A: icon tiles"). One small line drawing per
// sport, in the format diagrams' own hand (format-shape.tsx): a 1.5 stroke in the current colour, round caps and joins,
// no fills but the small solid dots that stand for a ball, a pip or a striker. Decorative: the tile's words name the
// sport, so the drawing is hidden from assistive technology.
import type { ReactNode } from "react";

/** The box, the format glyphs' height: a sport tile's icon sits at the same size as a format card's diagram. */
const BOX = 28;

const dot = (cx: number, cy: number, r = 2.2) => <circle cx={cx} cy={cy} r={r} className="fill-current stroke-none" />;

/** Sport key → its drawing. A Map, never an object: a key Object.prototype owns ("constructor") is a sport like any
 *  other here, and must fall through to the catch-all rather than find a prototype function. */
const GLYPHS: ReadonlyMap<string, ReactNode> = new Map<string, ReactNode>([
  [
    "football",
    // The ball: a centre panel and the seams running out to its edge.
    <>
      <circle cx={14} cy={14} r={10} />
      <path d="M14 10l3.8 2.76-1.45 4.48h-4.7l-1.45-4.48z" className="fill-current" />
      <path d="M14 10V4M17.8 12.76l5.7-1.85M16.35 17.24l3.5 4.85M11.65 17.24l-3.5 4.85M10.2 12.76l-5.7-1.85" />
    </>,
  ],
  [
    "cricket",
    // A bat, handle up and to the right, and the ball at its toe.
    <>
      <g transform="rotate(45 13 13)">
        <path d="M13 2v6" />
        <rect x={10.5} y={8} width={5} height={14} rx={2} />
      </g>
      {dot(21.5, 21.5)}
    </>,
  ],
  [
    "badminton",
    // The shuttlecock, cork down: the skirt, two feather lines, the band, the cork.
    <>
      <path d="M10 19L6 5h16l-4 14" />
      <path d="M12.7 19l-1.3-14M15.3 19l1.3-14M8 12h12" />
      <path d="M10 19h8v1a4 4 0 0 1-8 0z" />
    </>,
  ],
  [
    "tennis",
    // The ball and its two seams.
    <>
      <circle cx={14} cy={14} r={10} />
      <path d="M6.9 7c4.6 3.5 4.6 10.5 0 14M21.1 7c-4.6 3.5-4.6 10.5 0 14" />
    </>,
  ],
  [
    "tabletennis",
    // The bat, its short broad handle down and to the right, and the ball above it.
    <>
      <g transform="rotate(-45 14 14)">
        <circle cx={14} cy={10.5} r={7.5} />
        <path d="M11.8 18.2h4.4v5.3a2.2 2.2 0 0 1-4.4 0z" className="fill-current" />
      </g>
      {dot(22.5, 5.5)}
    </>,
  ],
  [
    "volleyball",
    // The ball and its three panel seams.
    <>
      <circle cx={14} cy={14} r={10} />
      <path d="M14 14c-3.5-2-5.3-5.6-4.8-8.8M14 14c4-2 7.6-1.6 9.6 2M14 14c-.5 4.4-3.4 7.7-7.5 6.6" />
      <path d="M17.4 4.6c-.2 3.6-1.6 6.6-3.4 9.4M21.8 20.3c-3-1.6-5.6-3.6-7.8-6.3" />
    </>,
  ],
  [
    "hockey",
    // A field hockey stick, its hook curled up at the foot, and the ball.
    <>
      <path d="M10 3l5.6 16.4c1 3 4 4 6 2" />
      {dot(7.5, 22)}
    </>,
  ],
  [
    "icehockey",
    // An ice hockey stick, its flat blade along the ice, and the puck.
    <>
      <path d="M11 3l5.4 15.4c.4 1.4 1.4 2.1 2.8 2.1H24" />
      <ellipse cx={7} cy={20.5} rx={3.5} ry={1.5} />
      <path d="M3.5 20.5v1.8c0 .8 1.6 1.5 3.5 1.5s3.5-.7 3.5-1.5v-1.8" />
    </>,
  ],
  [
    "boardgame",
    // Chess: the knight, facing left, on its base.
    <>
      <path d="M10.2 21.5c0-3.6 2.8-5.4 3.2-8l-3.6 1.6c-1.2.6-2.6-.5-2.1-1.8l2.6-5.1c.9-2.1 2.6-3.6 4.9-3.7l.8-1.5 1.2 2c3 1 4.5 4.5 4 9-.3 3-1.4 5-1.4 7.5" />
      <rect x={7.5} y={21.5} width={13} height={3} rx={1} />
      {dot(13.6, 8.6, 1)}
    </>,
  ],
  [
    "carrom",
    // The board: its four corner pockets, the centre ring, a baseline and the striker on it.
    <>
      <rect x={3.5} y={3.5} width={21} height={21} rx={2} />
      <circle cx={7} cy={7} r={1.6} />
      <circle cx={21} cy={7} r={1.6} />
      <circle cx={7} cy={21} r={1.6} />
      <circle cx={21} cy={21} r={1.6} />
      <circle cx={14} cy={12} r={3} />
      <path d="M9 19h10" />
      {dot(14, 19, 1.9)}
    </>,
  ],
  [
    "generic",
    // Any other game: a die.
    <>
      <rect x={5} y={5} width={18} height={18} rx={4} />
      {dot(10, 10, 1.6)}
      {dot(14, 14, 1.6)}
      {dot(18, 18, 1.6)}
    </>,
  ],
]);

/** The sports drawn here; any other key is drawn as the catch-all ("Any other game"). */
export const SPORT_ICON_KEYS: readonly string[] = Object.freeze([...GLYPHS.keys()]);

export function SportIcon({ sportKey, className = "" }: { sportKey: string; className?: string }) {
  const drawn = GLYPHS.has(sportKey) ? sportKey : "generic";
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={BOX}
      height={BOX}
      className={`stroke-current ${className}`}
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-sport-icon={drawn}
    >
      {GLYPHS.get(drawn)}
    </svg>
  );
}
