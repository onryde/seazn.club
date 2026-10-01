// Capture QR v2 §6.6 (W17) — the cadence a beat answer tells the phone. Pure: `now` passed in. The answered value is
// stored on the pairing, because silence is judged against it (§6.9).
import { POLL_FAR_SECONDS, POLL_NEAR_SECONDS, POLL_NEAR_WINDOW_MINUTES, POLL_STARTING_SECONDS } from "../config";
import { type SessionState, isActive } from "./session";

type PollInput = { open: SessionState | null; fixtureStatus: string; scheduledAt: Date | null; finished: boolean };

const nearWindowOpen = (i: PollInput, now: Date): boolean =>
  i.scheduledAt !== null && now.getTime() >= i.scheduledAt.getTime() - POLL_NEAR_WINDOW_MINUTES * 60_000;

/** §6.6, first row that applies wins. */
const POLL_ROWS: readonly { when: (i: PollInput, now: Date) => boolean; seconds: number }[] = [
  { when: (i) => i.open === "requested" || i.open === "provisioning", seconds: POLL_STARTING_SECONDS },
  { when: (i) => i.open !== null, seconds: POLL_NEAR_SECONDS },
  { when: (i) => i.fixtureStatus === "in_play", seconds: POLL_NEAR_SECONDS },
  { when: (i, now) => !i.finished && nearWindowOpen(i, now), seconds: POLL_NEAR_SECONDS },
  { when: () => true, seconds: POLL_FAR_SECONDS },   // no scheduled_at, far from the start, or finished
];

export function pollSecondsFor(i: PollInput, now: Date): number {
  if (i.open !== null && !isActive(i.open)) {
    throw new RangeError(`pollSecondsFor: a ${i.open} session is not open — pass null when there is no open session`);
  }
  return POLL_ROWS.find((r) => r.when(i, now))!.seconds;   // the last row always matches
}
