// The folded state → OverlayLiveData (design §3.2). Pure. The two fields the
// overlay needs beyond ScoreSummary are read off the module's own STATE —
// which foldFixture already holds — by SHAPE, so no sport-key branch exists
// here and a twelfth sport that carries `asOf` or `innings` is covered by
// construction (owner ruling 4: "all sports").
import type { FoldedFixture } from "@/server/engine-db/fold";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";
import type { RecentEvent } from "@/lib/overlay-recent-types";
import type { OverlayClosedOver, OverlayCricketLive, OverlayCricketToss, OverlayHighlights } from "@/lib/overlay-cricket";
import { carromTossOf, tennisTossOf } from "@/lib/overlay-toss";
import { latestClockAnchor } from "@/components/v2/scorepad/v3/clock";
import { clockPeriodsOf, type MatchTimeCfg } from "@/components/v2/scorepad/v3/skins/football-match-time";
import { matchTimeCfgOf } from "@/components/v2/scorepad/v3/skins/football-match-time-cfg";

interface RowSnapshot {
  status: string;
  summary: LiveFixtureData["summary"];
  outcome: LiveFixtureData["outcome"];
  last_seq: number | null;
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

/** A clock event's type, whatever the sport: the pad builds it as `${module.key}.clock` (`pad-host.tsx` `publishClock`),
 *  and `FoldedFixture` names no sport, so the stream is the authority. */
const CLOCK_SUFFIX = ".clock";
const FOOTBALL_CLOCK = "football.clock";
/** Every anchor the overlay reads is foreign: a row's `recordedAt` is the server's time. */
const NOT_OWN: ReadonlySet<string> = new Set();

/** The stream's clock event type — its newest event whose type ends `.clock` — or undefined when nobody has started,
 *  paused or corrected a clock in this match. */
function clockTypeOf(active: FoldedFixture["active"]): string | undefined {
  for (let i = active.length - 1; i >= 0; i--) {
    const type = active[i]!.type;
    if (type.endsWith(CLOCK_SUFFIX)) return type;
  }
  return undefined;
}

/** A PLAY period of the period kernel (hockey, ice hockey), by the labels it generates (`Q1..Q4`, `P1..Pn`, `OT`,
 *  `OT1..OTk` — period/kernel.ts:631-639) or a bare half. A break, a shootout and the end are none of these. */
const PLAY_PERIOD = /^(?:[QPH]\d+|OT\d*)$/;

/** Where a period-kernel play period falls in the match, for ORDER only: regulation periods by their number, every
 *  overtime after all of them. `null` for a label that is no play period. */
function periodRank(label: string): number | null {
  const m = /^(?:[QPH](\d+)|OT(\d*))$/.exec(label);
  if (m === null) return null;
  return m[1] !== undefined ? Number(m[1]) : 1_000_000 + Number(m[2] || 0);
}

/** The fields match time reads, copied off the parsed cfg so the wire carries those and nothing else. */
function matchTimeOf(cfg: unknown): MatchTimeCfg {
  const c = matchTimeCfgOf(cfg);
  return {
    halves: c.halves,
    halfMinutes: c.halfMinutes,
    extraTime: { enabled: c.extraTime.enabled, halfMinutes: c.extraTime.halfMinutes },
    ...(c.periodSeconds === undefined ? {} : { periodSeconds: { ...c.periodSeconds } }),
  };
}

/**
 * THE CLOCK ON AIR — one rule for every sport that has one (S2-5 ruling 110 for football; owner ruling 2026-11-17
 * extended it to hockey and ice hockey, which until then anchored on the newest stamp of ANY kind, so a goal typed ten
 * seconds late pulled the clock back ten seconds and a goal entered before a Start set a clock running).
 *
 * The anchor is the newest standing `<sport>.clock` event (Start, Pause or Correct, from any screen; a goal or a card
 * never moves it), at that row's `recordedAt` — the server's time, which the stage reads through its measured server
 * offset. Football's is spelled in match time (`matchTime`, §7.4); the others as elapsed time in the period.
 *
 *  - No clock event in the match yet: NO clock. A goal stamped before anyone started the clock is not a clock, and
 *    "a stale clock on air is worse than no clock".
 *  - The match in a phase that is no clock period (a break, a shootout, the end): no clock, so the stage holds what
 *    it last showed.
 *  - The anchor in the current period: its reading, running or paused.
 *  - The anchor in another period: this period has had no clock event yet, and a period marker stops the clock in the
 *    fold, so the period stands at its own start, paused (§7.2: "0, stopped") — `45:00` before the second half's
 *    Start, as on the console — when the anchor's period is EARLIER. An anchor in a LATER period than the fold's
 *    phase (a voided whistle) is no clock rather than a wrong one: football by its declared period order, the
 *    period kernel by its labels (`periodRank`).
 */
function clockOf(state: unknown, active: FoldedFixture["active"]): OverlayLiveData["clock"] {
  if (typeof state !== "object" || state === null) return undefined;
  const s = state as { phase?: unknown; cfg?: unknown };
  if (typeof s.phase !== "string") return undefined;
  const clockType = clockTypeOf(active);
  if (clockType === undefined) return undefined;
  const anchor = latestClockAnchor(active, clockType, NOT_OWN);
  if (anchor === null) return undefined;
  const nominalSeconds = nominalSecondsOf(state, s.phase);
  const length = nominalSeconds === undefined ? {} : { nominalSeconds };
  if (clockType === FOOTBALL_CLOCK) {
    const matchTime = matchTimeOf(s.cfg);
    const periods = clockPeriodsOf(matchTime);
    const now = periods.indexOf(s.phase);
    if (now < 0) return undefined;
    const base = { phase: s.phase, anchorAtWallMs: anchor.recordedAtMs, matchTime, ...length };
    if (anchor.period === s.phase) return { ...base, anchorSeconds: anchor.elapsed, running: anchor.running };
    const then = periods.indexOf(anchor.period);
    if (then < 0 || then > now) return undefined;
    return { ...base, anchorSeconds: 0, running: false };
  }
  const base = { phase: s.phase, anchorAtWallMs: anchor.recordedAtMs, ...length };
  if (anchor.period === s.phase) return { ...base, anchorSeconds: anchor.elapsed, running: anchor.running };
  if (!PLAY_PERIOD.test(s.phase)) return undefined;
  // Only an anchor in an EARLIER period leaves this one standing at its start. One in a later period (a voided
  // whistle), or in a phase that is no play period, is no clock rather than a wrong one — football's rule above.
  const now = periodRank(s.phase);
  const then = periodRank(anchor.period);
  if (now === null || then === null || then > now) return undefined;
  return { ...base, anchorSeconds: 0, running: false };
}

/** When the match STARTED: the surviving `core.start`'s `recordedAt` (the server's time) — the event `fixtures.status`
 *  is derived from, so "started" has one authority. The stream is void-resolved, so a voided start is not here. Absent
 *  with no start, or with a stamp that does not parse: the corner timer then shows nothing rather than a wrong time. */
function matchStartedAtMsOf(active: FoldedFixture["active"]): number | undefined {
  const start = active.find((e) => e.type === "core.start");
  if (start === undefined) return undefined;
  const ms = Date.parse(start.recordedAt);
  return Number.isFinite(ms) ? ms : undefined;
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
  /** Ended-card top batter / bowler — from the same scorecard fold as the crease. */
  highlights?: OverlayHighlights | null;
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
    ...(input.highlights && (input.highlights.batter || input.highlights.bowler)
      ? { highlights: input.highlights }
      : {}),
  };
  if (!folded) return out;
  const startedAtMs = matchStartedAtMsOf(folded.active);
  if (startedAtMs !== undefined) out.matchStartedAtMs = startedAtMs;
  const clock = clockOf(folded.state, folded.active);
  if (clock) out.clock = clock;
  const cricket = cricketOf(folded.state);
  if (cricket) out.cricket = cricket;
  // R2005 change 11: carrom's toss, off its own folded state (the engine's `tossTaken` / `firstBreak`), beside
  // cricket's. Absent until a toss is taken — and again once one is voided, because the fold no longer holds it.
  const carromToss = carromTossOf(folded.state);
  if (carromToss) out.carromToss = carromToss;
  // S2-7 (TN-TS-1): tennis's toss, the side the fold seated to serve first — only while a `tennis.toss` survives.
  const tennisToss = tennisTossOf(folded.state, folded.active);
  if (tennisToss) out.tennisToss = tennisToss;
  return out;
}
