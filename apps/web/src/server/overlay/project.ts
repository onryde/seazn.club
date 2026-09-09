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
  const last = active[active.length - 1];
  if (!last) return undefined;
  const wall = Date.parse(last.recordedAt);
  if (!Number.isFinite(wall)) return undefined;
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
