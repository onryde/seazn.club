// Court stream §5.3–§5.5 — which match a court phone's video belongs to. Pure: no I/O, no clock, `now` passed in
// (domain-purity.test.ts). The use-cases feed it one court's facts at every beat.
import { isNotResponding } from "./pairing";
import type { CodeView } from "./stream-code";
import type { SessionState } from "./session";

export type CourtMatchFacts = {
  fixtureId: string;
  status: string; // fixtures.status
  streamed: boolean; // fixture_stream_settings.court_stream
  latched: boolean; // auto_start_blocked_at is not null (organiser Stop, or this court phone's Stop)
  kickoffAt: Date | null; // last active core.start (kickoffsOf); in_play only
  calledAt: Date | null; // set only while the call still holds (liveCallSql)
  scheduledAt: Date | null;
  roundNo: number | null; // fixtures.round_no
  seqInRound: number | null; // fixtures.seq_in_round
  openSession: { sid: string; createdAt: Date } | null; // this link's newest ACTIVE session for the fixture
};

export type CourtFocus = {
  current: { fixtureId: string; sid: string } | null; // newest-created open court session, any fixture
  start: string | null; // the fixture to start now (nothing open, or a handover), or null
  handover: boolean; // start !== null && current !== null
  focusFixtureId: string | null; // the waiting/live fields' subject: start ?? current ?? next
  nextFixtureId: string | null; // first streamed, unlatched, "scheduled" match in queue order
  scoringFixtureId: string | null; // first "scheduled" match in queue order, streamed or not (O10)
};

const at = (d: Date | null): number => (d === null ? Number.NEGATIVE_INFINITY : d.getTime());
const nullsLast = (a: number | null, b: number | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Match Day's own queue order, row by row — the first row that separates two matches decides. Exported for the
 *  SQL parity test (Task 6). */
const QUEUE_ROWS: readonly ((a: CourtMatchFacts, b: CourtMatchFacts) => number)[] = [
  (a, b) => (a.calledAt === null ? 1 : 0) - (b.calledAt === null ? 1 : 0), // a held call first…
  (a, b) => (a.calledAt && b.calledAt ? a.calledAt.getTime() - b.calledAt.getTime() : 0), // …by calledAt
  (a, b) => nullsLast(a.scheduledAt?.getTime() ?? null, b.scheduledAt?.getTime() ?? null),
  (a, b) => nullsLast(a.roundNo, b.roundNo),
  (a, b) => nullsLast(a.seqInRound, b.seqInRound),
  (a, b) => cmpId(a.fixtureId, b.fixtureId),
];
export function queueOrder(a: CourtMatchFacts, b: CourtMatchFacts): number {
  for (const row of QUEUE_ROWS) {
    const d = row(a, b);
    if (d !== 0) return d;
  }
  return 0;
}

/** §5.3 candidate: newest kickoff wins (null sorts oldest); a tie goes to the greater fixture id. */
function newestKickoff(a: CourtMatchFacts, b: CourtMatchFacts): number {
  return at(b.kickoffAt) - at(a.kickoffAt) || cmpId(b.fixtureId, a.fixtureId);
}

const isCandidate = (m: CourtMatchFacts): boolean => m.streamed && !m.latched && m.status === "in_play";
const firstScheduled = (ms: readonly CourtMatchFacts[]): string | null =>
  [...ms].filter((m) => m.status === "scheduled").sort(queueOrder)[0]?.fixtureId ?? null;

/** §5.3 start rows: given a candidate with no open session of its own, and the current open session (if any). */
function startOf(candidate: CourtMatchFacts | undefined, current: CourtMatchFacts | null): string | null {
  if (!candidate || candidate.openSession !== null) return null;
  if (current === null) return candidate.fixtureId;
  if (current.fixtureId === candidate.fixtureId) return null;
  const handover = current.status !== "in_play" || at(current.kickoffAt) < at(candidate.kickoffAt);
  return handover ? candidate.fixtureId : null;
}

export function courtFocus(matches: readonly CourtMatchFacts[]): CourtFocus {
  const open = matches.filter((m) => m.openSession !== null).sort((a, b) => b.openSession!.createdAt.getTime() - a.openSession!.createdAt.getTime());
  const currentMatch = open[0] ?? null;
  const current = currentMatch ? { fixtureId: currentMatch.fixtureId, sid: currentMatch.openSession!.sid } : null;
  const start = startOf([...matches].filter(isCandidate).sort(newestKickoff)[0], currentMatch);
  const nextFixtureId = firstScheduled(matches.filter((m) => m.streamed && !m.latched));
  return {
    current,
    start,
    handover: start !== null && current !== null,
    focusFixtureId: start ?? current?.fixtureId ?? nextFixtureId,
    nextFixtureId,
    scoringFixtureId: firstScheduled(matches),
  };
}

export type CourtPhoneStatus = "unpaired" | "waiting" | "live" | "offline";

/** §5.5: the desk's phone status. The offline boundary is isNotResponding's (NOT_RESPONDING_BEATS answered cadences). */
export function courtPhoneStatus(
  i: { pairing: { lastBeatAt: Date; answeredPoll: number } | null; openState: SessionState | null },
  now: Date,
): CourtPhoneStatus {
  if (i.pairing === null) return "unpaired";
  if (isNotResponding({ held: true, lastBeatAt: i.pairing.lastBeatAt, answeredPoll: i.pairing.answeredPoll }, now)) return "offline";
  return i.openState === "live" ? "live" : "waiting";
}

/** The court code's CodeView for `codeStatus` (grace 0): `finishedAt` is the day's end once it has passed, else null. */
export function courtCodeView(v: { endedAt: Date | null; expiresAt: Date }, now: Date): CodeView {
  return { endedAt: v.endedAt, finishedAt: now.getTime() >= v.expiresAt.getTime() ? v.expiresAt : null };
}
