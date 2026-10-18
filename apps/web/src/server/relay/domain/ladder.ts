// The compositor's degrade ladder, as web reads it off the heartbeat (relay-job.v1 `rung`). It imports NOTHING, on
// purpose: api-v1/schemas.ts takes `z.enum(LADDER_RUNGS)` from here, and that file is also loaded by the standalone
// generators (node --experimental-strip-types, no module resolver). domain-purity.test.ts pins it.
//
// Owner ruling 2026-10-18 (compositor `docs/_INDEX.md` Owed 20, "no lite mode; if CPU impacts, measure and raise the
// CPU size"): the score is never removed. The ladder is `full → overlay_half_rate` and the bottom holds; frames drop
// before the encoder first. So any step down in production means the Machine is short of CPU — a SIZING alarm, which
// the heartbeat use-case raises and ops answer by raising the Machine size (compositor C17 runbook).

/** The rungs, top first (compositor C05 `Rung { Full, OverlayHalfRate }`, snake_case on the wire, C07). */
export const LADDER_RUNGS = ["full", "overlay_half_rate"] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** The sizing alarm's decision for one beat: the rung it stepped DOWN to, or null. It fires on ENTRY to a rung below
 *  the top — the previous beat's stored rung was anything else — never on every beat of a held step (a match is
 *  ~2 000 beats). A beat that reports no rung alarms nothing, and the beat AFTER it alarms again if it is stepped: once
 *  the rung is unknown, a second alarm is the safe direction for a sizing alarm, a missed one is not. */
export function steppedDownTo(previous: unknown, current: LadderRung | null | undefined): LadderRung | null {
  if (current == null || current === LADDER_RUNGS[0]) return null;
  return previous === current ? null : current;
}
