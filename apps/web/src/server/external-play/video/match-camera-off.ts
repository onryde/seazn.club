// One player's camera evidence over ONE match (T13, controller ruling C1;
// design §5.2). Pure: the sweep reads every peer report of every session and
// hands the complete ones here.
//
// A player's camera was on at an instant when ANY of their connections had it
// on: a reload is a new peer, a rejoin after everyone left is a new session,
// and a second tab is a second peer at the same time. Each connection is on
// over [joined_at, left_at] minus its own off gaps (videoOffCoverage); the
// match's off time is the window minus the union of those, clipped to the
// window — before the first move the room is open but the match is not.
//
// An uncovered stretch counts only when it is LONGER than 3 cadences at the
// cadence floor (VIDEO_OFF_GAP_CADENCES x PEER_REPORT_MIN_CADENCE_MS = 15 s):
// the spec's own threshold (§5.2: off = a gap longer than 3x the sample
// cadence), at the smallest cadence a single report can measure, so a quick
// reload is not a camera loss and no gap one report calls off is lost to the
// union's rounding. Evidence for the organiser, never a sanction (D10).
//
// OUR faults are not the player's (T14 re-review 3, I-1): when the player's
// browser cannot refuse a remote stream it leaves the meeting and re-joins
// (camera-loader.ts, D7), and stamps the gap on the server
// (fixture_video_guard_faults). A stamped interval counts as covered where
// the player had NO connection in the meeting — a real fault takes them out
// (T14 fix round 6, M-1, adopted): a stamp held open while a connection sat
// in the meeting with its camera off excuses nothing, and that time is judged
// as any other. Never a camera_lost for our gap; never an excuse for theirs.
//
// A stamp excuses; it never HIDES (T14 fix round 5, ruling 1). The stamps are
// the player's browser's claim, so past either threshold in one match —
// stamped time over GUARD_FAULT_FLAG_SECONDS, or more than
// GUARD_FAULT_FLAG_STAMPS stamps — the organiser is told, neutrally
// (stampedInMatch → job 5's camera_connection_problems flag).
import {
  PEER_REPORT_MIN_CADENCE_MS,
  VIDEO_OFF_GAP_CADENCES,
  type VideoOffCoverage,
} from "./realtimekit";

export const MATCH_OFF_MIN_MS = VIDEO_OFF_GAP_CADENCES * PEER_REPORT_MIN_CADENCE_MS;

export type CompleteCoverage = Extract<VideoOffCoverage, { incomplete: false }>;

export type CameraOffInMatch = {
  windowSeconds: number;
  offSeconds: number;
  offIntervals: { from: string; to: string; seconds: number; confirmedByEvents: boolean }[];
  /** Connections (peer reports) the answer was built from. */
  connections: number;
};

type Span = [number, number];

/** Stamped time in one match past this many seconds is told to the organiser. */
export const GUARD_FAULT_FLAG_SECONDS = 60;
/** More stamps than this in one match are told to the organiser. */
export const GUARD_FAULT_FLAG_STAMPS = 3;

function faultSpan(g: { from: Date; to: Date }): Span {
  const a = g.from.getTime();
  const b = g.to.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) {
    throw new Error("matchCameraOff: a guard fault must be two dates, from <= to");
  }
  return [a, b];
}

function windowSpan(window: { from: Date; to: Date }): Span {
  const w0 = window.from.getTime();
  const w1 = window.to.getTime();
  if (!Number.isFinite(w0) || !Number.isFinite(w1) || w1 < w0) {
    throw new Error("matchCameraOff: the match window must be two dates, from <= to");
  }
  return [w0, w1];
}

/** The union of spans, each clipped to [w0, w1]; empty pieces dropped. */
function clippedUnion(spans: readonly Span[], w0: number, w1: number): Span[] {
  const clipped = spans
    .map(([a, b]): Span => [Math.max(a, w0), Math.min(b, w1)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const union: Span[] = [];
  for (const s of clipped) {
    const last = union[union.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else union.push([s[0], s[1]]);
  }
  return union;
}

export type StampedInMatch = {
  /** Stamps that touch the match window (a zero-length one inside counts). */
  stamps: number;
  /** Their union inside the window, in seconds. */
  seconds: number;
  intervals: { from: string; to: string }[];
  /** Past either threshold: the organiser is told (never camera_lost). */
  flag: boolean;
};

/** `spans` minus `holes` (both any order): what of each span no hole covers. */
function minus(spans: readonly Span[], holes: readonly Span[]): Span[] {
  const cut = clippedUnion(holes, -Infinity, Infinity);
  const out: Span[] = [];
  for (const [a, b] of spans) {
    let cursor = a;
    for (const [x, y] of cut) {
      if (y <= cursor || x >= b) continue;
      if (x > cursor) out.push([cursor, x]);
      cursor = Math.max(cursor, y);
    }
    if (b > cursor) out.push([cursor, b]);
  }
  return out;
}

/** Our safeguard's stamps over ONE match window, and whether they are many
 *  or long enough that the organiser must be told (ruling 1, fix round 5). */
export function stampedInMatch(
  window: { from: Date; to: Date },
  guardFaults: readonly { from: Date; to: Date }[],
): StampedInMatch {
  const [w0, w1] = windowSpan(window);
  const inside = guardFaults.map(faultSpan).filter(([a, b]) => a <= w1 && b >= w0);
  const union = clippedUnion(inside, w0, w1);
  const seconds = union.reduce((n, [a, b]) => n + (b - a), 0) / 1000;
  return {
    stamps: inside.length,
    seconds,
    intervals: union.map(([a, b]) => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() })),
    flag: seconds > GUARD_FAULT_FLAG_SECONDS || inside.length > GUARD_FAULT_FLAG_STAMPS,
  };
}

export function matchCameraOff(
  window: { from: Date; to: Date },
  reports: readonly CompleteCoverage[],
  /** Intervals our D7 safeguard held the camera out of the meeting. */
  guardFaults: readonly { from: Date; to: Date }[] = [],
): CameraOffInMatch {
  const [w0, w1] = windowSpan(window);

  // A stamp excuses only while no connection of the player was in the
  // meeting (M-1): our guard's fault is a LEAVE, so a connected peer means the
  // stamp is not what kept the camera out.
  const connected: Span[] = reports.map((r): Span => [Date.parse(r.joinedAt), Date.parse(r.leftAt)]);
  const on: Span[] = minus(guardFaults.map(faultSpan), connected);
  const confirmedOff: Span[] = [];
  for (const r of reports) {
    let cursor = Date.parse(r.joinedAt);
    const left = Date.parse(r.leftAt);
    const gaps = r.offIntervals
      .map((iv): Span & { confirmed?: boolean } => Object.assign([Date.parse(iv.from), Date.parse(iv.to)] as Span, { confirmed: iv.confirmedByEvents }))
      .sort((a, b) => a[0] - b[0]);
    for (const g of gaps) {
      if (g[0] > cursor) on.push([cursor, g[0]]);
      cursor = Math.max(cursor, g[1]);
      if (g.confirmed) confirmedOff.push([g[0], g[1]]);
    }
    if (left > cursor) on.push([cursor, left]);
  }

  // The union of every connection's on-spans, clipped to the window.
  const union = clippedUnion(on, w0, w1);

  // The window minus the union.
  const off: Span[] = [];
  let cursor = w0;
  for (const [a, b] of union) {
    if (a > cursor) off.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (w1 > cursor) off.push([cursor, w1]);

  const offIntervals = off
    .filter(([a, b]) => b - a > MATCH_OFF_MIN_MS)
    .map(([a, b]) => ({
      from: new Date(a).toISOString(),
      to: new Date(b).toISOString(),
      seconds: (b - a) / 1000,
      confirmedByEvents: confirmedOff.some(([x, y]) => x < b && y > a),
    }));
  return {
    windowSeconds: (w1 - w0) / 1000,
    offSeconds: offIntervals.reduce((n, iv) => n + iv.seconds, 0),
    offIntervals,
    connections: reports.length,
  };
}
