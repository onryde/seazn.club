// The folded state → OverlayLiveData (design §3.2). Pure. The two fields the
// overlay needs beyond ScoreSummary are read off the module's own STATE —
// which foldFixture already holds — by SHAPE, so no sport-key branch exists
// here and a twelfth sport that carries `asOf` or `innings` is covered by
// construction (owner ruling 4: "all sports").
import type { FoldedFixture } from "@/server/engine-db/fold";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";

interface RowSnapshot {
  status: string;
  summary: LiveFixtureData["summary"];
  outcome: LiveFixtureData["outcome"];
  last_seq: number | null;
}

/**
 * The wall time of the envelope that SET `asOf` — the last one carrying a
 * `GameTime` stamp equal to it.
 *
 * Review 2026-09-09 (I2): this used to be `active[active.length - 1]`, the
 * chronologically last envelope, which is a different event whenever an
 * UNSTAMPED one follows a stamped one. `applyEvent` only writes `asOf` when
 * the event carries an `at` (`football.ts:2522` — `if (at === null) return
 * applied`), so a stamped goal followed by a substitution, an unstamped card
 * or a note left `anchorSeconds` frozen at the goal while `anchorAtWallMs`
 * advanced past it. The presentation formula `anchorSeconds + (now −
 * anchorAtWallMs)` then produced a SMALLER number than the tick before it, and
 * the on-air clock jumped backward by the gap between the two events.
 *
 * Matching on the stamp (not on event type) keeps this shape-based: any sport
 * whose payloads carry the kernel's `GameTime` is covered, and no sport-key
 * branch appears here.
 */
function anchorWallMs(
  active: FoldedFixture["active"],
  asOf: { period?: unknown; elapsed?: unknown },
): number | undefined {
  for (let i = active.length - 1; i >= 0; i--) {
    const payload = active[i]?.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const at = (payload as { at?: unknown }).at;
    if (typeof at !== "object" || at === null) continue;
    const stamp = at as { period?: unknown; elapsed?: unknown };
    if (stamp.period !== asOf.period || stamp.elapsed !== asOf.elapsed) continue;
    const wall = Date.parse(active[i]!.recordedAt);
    return Number.isFinite(wall) ? wall : undefined;
  }
  // No envelope in the active stream accounts for this `asOf`. Rather than
  // anchor on an arbitrary event (the defect above), emit no clock — the same
  // "a stale clock on air is worse than no clock" rule the phase guard applies.
  return undefined;
}

/** The period family's clock stamp, present only while it is CURRENT. The
 *  guard `asOf.period === phase` is footballPosition's own
 *  (football.ts:730-741): a stamp from a phase the match has left is no
 *  clock, not a wrong one. */
function clockOf(state: unknown, active: FoldedFixture["active"]): OverlayLiveData["clock"] {
  if (typeof state !== "object" || state === null) return undefined;
  const s = state as { phase?: unknown; asOf?: unknown };
  if (typeof s.phase !== "string") return undefined;
  if (typeof s.asOf !== "object" || s.asOf === null) return undefined;
  const asOf = s.asOf as { period?: unknown; elapsed?: unknown };
  if (asOf.period !== s.phase || typeof asOf.elapsed !== "number") return undefined;
  const wall = anchorWallMs(active, asOf);
  if (wall === undefined) return undefined;
  return { phase: s.phase, anchorSeconds: asOf.elapsed, anchorAtWallMs: wall };
}

/** Cricket's innings, by shape: an `innings[]` whose entries carry the four
 *  numbers. Anything else (no innings, or innings without `legalBalls`) is
 *  not cricket's state and yields nothing. */
function cricketOf(state: unknown): OverlayLiveData["cricket"] {
  if (typeof state !== "object" || state === null) return undefined;
  const raw = (state as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const innings: NonNullable<OverlayLiveData["cricket"]>["innings"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.runs !== "number" ||
      typeof e.wickets !== "number" ||
      typeof e.legalBalls !== "number"
    ) {
      return undefined;
    }
    if (!(e.ballsLimit === null || typeof e.ballsLimit === "number")) return undefined;
    innings.push({
      runs: e.runs,
      wickets: e.wickets,
      legalBalls: e.legalBalls,
      ballsLimit: e.ballsLimit,
    });
  }
  return { innings };
}

export function projectOverlayLiveData(input: {
  row: RowSnapshot;
  folded: FoldedFixture | null;
  venueTz: string;
}): OverlayLiveData {
  const { row, folded, venueTz } = input;
  const out: OverlayLiveData = {
    status: row.status,
    summary: row.summary,
    outcome: row.outcome,
    lastSeq: row.last_seq,
    venueTz,
  };
  if (!folded) return out;
  const clock = clockOf(folded.state, folded.active);
  if (clock) out.clock = clock;
  const cricket = cricketOf(folded.state);
  if (cricket) out.cricket = cricket;
  return out;
}
