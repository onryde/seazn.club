// T15 — the arbiter panel's view of one opened round (chess design §5.3:
// "An arbiter, when assigned, joins receive-only and sees both players' tiles
// for a chosen fixture, plus that fixture's flags").
//
// Shared by the server loader (usecases/external-play/arbiter.ts) and the
// client panel (components/v2/arbiter-panel.tsx), so it imports nothing that
// is server-only. The two note readers below read the evidence notes the
// flags' PRODUCERS write — reconcile (out_of_band_play) and the sweep's job 5
// (camera_lost). They are strict: a note they cannot read is null and the
// panel says so in general words, never a guessed number. The duration of a
// `camera_connection_problems` flag is NEVER read from its note (controller
// addendum 2026-10-12): the loader reads it from fixture_video_guard_faults.

export type ArbiterColour = "white" | "black";
export type ArbiterCameraPolicy = "off" | "optional" | "required";

/** Where one board stands, as the run sheet would say it. */
export type ArbiterBoardState =
  /** No game yet: the players are still arriving. */
  | { kind: "checking_in" }
  /** A game exists at Lichess, nobody has moved. */
  | { kind: "starting" }
  | { kind: "live"; moveNo: number }
  /** Held for the organiser (fixture_external_play.status = needs_organiser). */
  | { kind: "on_hold" }
  /** Over: a result written (score White first, "1–0"), or settled without one. */
  | { kind: "result"; score: string | null }
  /** T16 fix round 1, R4 — the fixture was cancelled: no result will come, but its OPEN flags are still the organiser's
   *  to review. Only the Flagged list carries one; the round panel lists no cancelled board. */
  | { kind: "cancelled" };

/** No game to watch, settle or let go on: a result is in, or the board was cancelled. */
export function boardIsOver(state: ArbiterBoardState): boolean {
  return state.kind === "result" || state.kind === "cancelled";
}

export type ArbiterPlayer = {
  name: string;
  /** The seat's ONE player (guard.ts `loadSides`), or null when the side has
   *  no single player. The cameras are the join route's answer, not this. */
  personId: string | null;
};

export type ArbiterClock = {
  whiteMs: number;
  blackMs: number;
  /** When those values were true (the last accepted move), or null. */
  asOf: string | null;
  running: boolean;
  turn: ArbiterColour;
};

export type CameraOffInterval = { from: string; to: string; confirmedByEvents: boolean };

/** The sweep's camera report (job 5), as its note states it. */
export type CameraOffReport = {
  offSeconds: number;
  windowSeconds: number;
  intervals: CameraOffInterval[];
  connections: number;
  sessions: number;
};

export type ArbiterFlag =
  | {
      id: string;
      kind: "out_of_band_play";
      at: string;
      /** 1-based plies; null when the note could not be read. */
      plies: { from: number; to: number } | null;
    }
  | {
      id: string;
      kind: "camera_lost";
      at: string;
      personName: string | null;
      report: CameraOffReport | null;
      /** The match window's start (the first move), for the timeline. */
      windowFrom: string | null;
    }
  | {
      id: string;
      kind: "camera_connection_problems";
      at: string;
      personName: string | null;
      /** From fixture_video_guard_faults over job 5's window, never from the
       *  note. Both null when there is no match window to read them over. */
      seconds: number | null;
      stamps: number | null;
    };

export type ArbiterBoard = {
  fixtureId: string;
  /** The per-division ordinal (`/f/{no}`), for the fixture page link. */
  fixtureNo: number | null;
  boardNo: number;
  white: ArbiterPlayer;
  black: ArbiterPlayer;
  state: ArbiterBoardState;
  clock: ArbiterClock | null;
  cameraPolicy: ArbiterCameraPolicy;
  /** An organiser already let this board play without video (D11). */
  videoOverridden: boolean;
  /** Required boards that have begun: is the sweep's camera report still to
   *  come ("pending"), or settled? null when there is none to expect. */
  cameraReport: "pending" | "settled" | null;
  /** A game is on file at Lichess and the board is not over. */
  canResync: boolean;
  /** Still to be played (no result, not settled): the video override applies. */
  playable: boolean;
  /** T16: still to be played AND an online board on file (a bridge row) —
   *  "Settle the result now…" settles it through the resolve route. */
  canSettle: boolean;
  /** T16: which side plays White. The settle buttons name the players by
   *  colour; the server settles by side. */
  whiteSide: "home" | "away";
  /** T16: a drawn knockout game waits for the organiser to pick who goes
   *  through (held `tiebreak_owed`): the settle offers a winner only. */
  tiebreakOwed: boolean;
  /** Open flags only: a flag the organiser closed has had its review. */
  flags: ArbiterFlag[];
};

export type ArbiterRound = {
  stageId: string;
  stageName: string;
  roundNo: number;
  /** "10+5" — the division's clock. */
  timeControl: string | null;
  /** Never a board the viewer plays on (C1, D7). */
  boards: ArbiterBoard[];
  /** How many of the round's boards were left out because the viewer plays
   *  on them: every board left out ⇒ the panel says "you're playing"; some
   *  ⇒ one line says why the board numbers skip (N3). */
  ownBoards: number;
  /** This is the division's most recently OPENED round (D12). false ⇒ a
   *  `?fixture=` pinned an earlier round while a newer one is open, and the
   *  panel offers the way to it (N1). */
  current: boolean;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** reconcile.ts `outOfBandEvidence`:
 *  "ply N (uci) played at Lichess, not through Seazn; …" or
 *  "plies A-B (uci …) played at Lichess, not through Seazn; …". */
export function parseOutOfBandNote(note: string | null): { from: number; to: number } | null {
  if (note === null) return null;
  const m = /^(?:ply (\d+)|plies (\d+)-(\d+)) \([a-h1-8qrbn ]+\) played at Lichess, not through Seazn; /.exec(note);
  if (!m) return null;
  const from = Number(m[1] ?? m[2]);
  const to = Number(m[1] ?? m[3]);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null;
  return { from, to };
}

/** The move a ply belongs to (FIDE: move N is White's ply 2N-1, Black's 2N). */
export function fullMoveOf(ply: number): number {
  return Math.ceil(ply / 2);
}

/** The move being played after a ledger of `plies` (the "Live · move N" label). */
export function boardMoveNo(plies: number): number {
  return Math.floor(plies / 2) + 1;
}

/** sweep.ts job 5 (`readCameraEvidence`):
 *  "camera off {s} s of {w} s in the match: {from} to {to}[ (its own off/on
 *  events agree)]; …; from {n} camera connection[s] over {m} session[s];
 *  camera required". */
export function parseCameraLostNote(note: string | null): CameraOffReport | null {
  if (note === null) return null;
  const m =
    /^camera off (\d+) s of (\d+) s in the match: (.+); from (\d+) camera connections? over (\d+) sessions?; camera required$/.exec(
      note,
    );
  if (!m) return null;
  const offSeconds = Number(m[1]);
  const windowSeconds = Number(m[2]);
  if (offSeconds > windowSeconds) return null;
  const intervals: CameraOffInterval[] = [];
  for (const part of m[3]!.split("; ")) {
    const iv = /^(\S+) to (\S+?)( \(its own off\/on events agree\))?$/.exec(part);
    if (!iv || !ISO.test(iv[1]!) || !ISO.test(iv[2]!)) return null;
    if (Date.parse(iv[2]!) < Date.parse(iv[1]!)) return null;
    intervals.push({ from: iv[1]!, to: iv[2]!, confirmedByEvents: iv[3] !== undefined });
  }
  if (intervals.length === 0) return null;
  return { offSeconds, windowSeconds, intervals, connections: Number(m[4]), sessions: Number(m[5]) };
}

/** The off intervals as positions on a bar the length of the match window. */
export function timelineSegments(a: {
  windowFrom: string | null;
  windowSeconds: number;
  intervals: readonly CameraOffInterval[];
}): { leftPct: number; widthPct: number }[] {
  if (a.windowFrom === null || a.windowSeconds <= 0) return [];
  const start = Date.parse(a.windowFrom);
  if (Number.isNaN(start)) return [];
  const span = a.windowSeconds * 1000;
  const clamp = (ms: number) => Math.min(span, Math.max(0, ms - start));
  return a.intervals.map((iv) => {
    const left = clamp(Date.parse(iv.from));
    const right = clamp(Date.parse(iv.to));
    return { leftPct: (left / span) * 100, widthPct: ((right - left) / span) * 100 };
  });
}
