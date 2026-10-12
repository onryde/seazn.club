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
// (fixture_video_guard_faults). Each stamped interval counts as covered, so
// only what lies outside it is judged — never a camera_lost for our gap.
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

export function matchCameraOff(
  window: { from: Date; to: Date },
  reports: readonly CompleteCoverage[],
  /** Intervals our D7 safeguard held the camera out of the meeting. */
  guardFaults: readonly { from: Date; to: Date }[] = [],
): CameraOffInMatch {
  const w0 = window.from.getTime();
  const w1 = window.to.getTime();
  if (!Number.isFinite(w0) || !Number.isFinite(w1) || w1 < w0) {
    throw new Error("matchCameraOff: the match window must be two dates, from <= to");
  }

  const on: Span[] = [];
  for (const g of guardFaults) {
    const a = g.from.getTime();
    const b = g.to.getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) {
      throw new Error("matchCameraOff: a guard fault must be two dates, from <= to");
    }
    on.push([a, b]);
  }
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
  const clipped = on
    .map(([a, b]): Span => [Math.max(a, w0), Math.min(b, w1)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const union: Span[] = [];
  for (const s of clipped) {
    const last = union[union.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else union.push([s[0], s[1]]);
  }

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
