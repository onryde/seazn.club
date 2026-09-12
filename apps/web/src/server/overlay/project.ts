// The folded state → OverlayLiveData (design §3.2). Pure. The two fields the
// overlay needs beyond ScoreSummary are read off the module's own STATE —
// which foldFixture already holds — by SHAPE, so no sport-key branch exists
// here and a twelfth sport that carries `asOf` or `innings` is covered by
// construction (owner ruling 4: "all sports").
import type { FoldedFixture } from "@/server/engine-db/fold";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";
import type { RecentEvent } from "@/lib/overlay-recent-types";
import type { OverlayClosedOver, OverlayCricketLive, OverlayCricketToss } from "@/lib/overlay-cricket";

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

const minutesAt = (holder: unknown, key: string): number | undefined => {
  if (typeof holder !== "object" || holder === null) return undefined;
  const value = (holder as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * F16 (product ruling 2026-09-10, `_THEMES.md` §3) — the NOMINAL length of
 * `phase`, in seconds, so the stage has a ceiling to hold the clock against.
 * Driven live, a fixture left `in_play` displayed `1205:25`.
 *
 * THE LENGTH IS KNOWABLE, and by shape rather than by sport key: both
 * clock-bearing kernels carry their resolved cfg ON THE STATE
 * (`FootballState.cfg`, football.ts:564; `PeriodState.cfg`,
 * period/kernel.ts:530), and both fix every phase length with REQUIRED
 * scalars — `halfMinutes` / `extraTime.halfMinutes` (football.ts:773-788) and
 * `periods.minutes` / `overtime.minutes` (period/kernel.ts:760-772). Football's
 * `halfMinutes` covers its four quarters too ("the length of one play period,
 * not literally half", S5/#431).
 *
 * ONE KNOWN DIVERGENCE FROM THE ENGINE, deliberate and recorded: `phaseLengths`
 * also honours `cfg.periodSeconds`, the optional per-label override that exists
 * for periods of UNEQUAL length (and which LOSES to the scalar when it is
 * uniform). Resolving it correctly needs each kernel's own phase-group lists,
 * and the engine exports neither `phaseLengths` nor `otLabels`; `packages/engine`
 * is out of scope for this programme. A competition that declares unequal
 * periods therefore gets the group's scalar as its ceiling — the same number
 * every other phase in that group uses, never an absurd one — which is what
 * this ceiling exists to guarantee. Wiring the override belongs with an engine
 * export of `phaseLengths`, not with a second copy of it here.
 *
 * The overtime group is recognised by the LABEL both kernels generate for it —
 * football's `ET_H1`/`ET_H2` (football.ts:695-702) and the period kernel's
 * `OT`/`OT1..OTk` (period/kernel.ts:631-639). No regulation label either kernel
 * produces (`H1`/`H2`, `Q1..Q4`, `P1..Pn`) begins with those.
 */
function nominalSecondsOf(state: unknown, phase: string): number | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const cfg = (state as { cfg?: unknown }).cfg;
  if (typeof cfg !== "object" || cfg === null) return undefined;
  const c = cfg as Record<string, unknown>;
  const minutes = /^(ET_|OT)/.test(phase)
    ? // football's extra time, then the period kernel's overtime
      (minutesAt(c.extraTime, "halfMinutes") ?? minutesAt(c.overtime, "minutes"))
    : // football's halves/quarters, then the period kernel's regulation periods
      (minutesAt(c, "halfMinutes") ?? minutesAt(c.periods, "minutes"));
  return minutes === undefined ? undefined : Math.round(minutes * 60);
}

/** The period family's clock stamp, present only while it is CURRENT. The
 *  guard `asOf.period === phase` is footballPosition's own
 *  (football.ts:730-741): a stamp from a phase the match has left is no
 *  clock, not a wrong one.
 *
 *  `nominalSeconds` is ABSENT rather than guessed when the state declares no
 *  readable cfg — see `nominalSecondsOf`. Absent is not "no clock": the anchor
 *  is still a recorded fact, and the stage holds it rather than ticking past a
 *  bound it does not have. */
function clockOf(state: unknown, active: FoldedFixture["active"]): OverlayLiveData["clock"] {
  if (typeof state !== "object" || state === null) return undefined;
  const s = state as { phase?: unknown; asOf?: unknown };
  if (typeof s.phase !== "string") return undefined;
  if (typeof s.asOf !== "object" || s.asOf === null) return undefined;
  const asOf = s.asOf as { period?: unknown; elapsed?: unknown };
  if (asOf.period !== s.phase || typeof asOf.elapsed !== "number") return undefined;
  const wall = anchorWallMs(active, asOf);
  if (wall === undefined) return undefined;
  const nominalSeconds = nominalSecondsOf(state, s.phase);
  return {
    phase: s.phase,
    anchorSeconds: asOf.elapsed,
    anchorAtWallMs: wall,
    ...(nominalSeconds === undefined ? {} : { nominalSeconds }),
  };
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

/**
 * W2 — `recent` is passed IN rather than derived here, because naming a person
 * needs the line-up and this projection is pure. It is always set, even to `[]`:
 * the overlay's moment layer reads `data.recent` on every poll, and an absent
 * field and an empty one would be two shapes for one fact.
 */
export function projectOverlayLiveData(input: {
  row: RowSnapshot;
  folded: FoldedFixture | null;
  venueTz: string;
  recent?: readonly RecentEvent[];
  /** W2 Task 3. Passed IN for the same reason `recent` is: naming the people at
   *  the crease needs the line-up, which this projection cannot read. */
  cricketLive?: OverlayCricketLive | null;
  cricketToss?: OverlayCricketToss | null;
  lastClosedOver?: OverlayClosedOver | null;
  scoringStarted?: boolean;
}): OverlayLiveData {
  const { row, folded, venueTz } = input;
  const out: OverlayLiveData = {
    status: row.status,
    summary: row.summary,
    outcome: row.outcome,
    lastSeq: row.last_seq,
    venueTz,
    recent: [...(input.recent ?? [])],
    ...(input.cricketLive ? { cricketLive: input.cricketLive } : {}),
    ...(input.cricketToss ? { cricketToss: input.cricketToss } : {}),
    ...(input.lastClosedOver ? { lastClosedOver: input.lastClosedOver } : {}),
    ...(input.scoringStarted !== undefined ? { scoringStarted: input.scoringStarted } : {}),
  };
  if (!folded) return out;
  const clock = clockOf(folded.state, folded.active);
  if (clock) out.clock = clock;
  const cricket = cricketOf(folded.state);
  if (cricket) out.cricket = cricket;
  return out;
}
