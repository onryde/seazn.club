// The DB/wire-shape -> CapacityInput adapter (D2), CLIENT-SAFE on purpose:
// the setup card imports this directly (design doc: "client-side import of
// the engine lib — no network"), and `capacity-guard.ts` (the server-only
// 422 authority) re-exports the very same function rather than holding a
// second copy — see that file's header for why a second implementation of
// "which days/courts/entrants" would be exactly the placer/verifier fork
// this codebase keeps naming as its recurring defect.
//
// Deliberately does NOT import `@seazn/engine/scheduling` (the barrel):
// that barrel is server-only (see scheduling/index.ts's header) and a `"use
// client"` file that reaches it ships z3-solver/@grpc into the browser
// bundle — `bracket-panel.tsx`/`slideshow.tsx` did exactly this and broke
// the production build until Task 11 found it. Every engine import here is
// a LEAF declared in package.json: `./scheduling/capacity` (this feature's
// own pure lib), `./scheduling/tz` (zero dependencies), and
// `./scheduling/calendar` — added for `resolveSelector` alone (forced-
// demand resolution below), and safe to add: calendar.ts's OWN imports are
// type-only plus the same two already-approved leaves (`rest-floor.ts`,
// `tz.ts`), verified before wiring this up. It stays a DEEP import
// (`.../calendar`, never the barrel) for exactly that reason — the barrel's
// `export *` chain is what drags in build.ts/placement-client.ts/grpc, not
// calendar.ts itself. `HardConstraint`/`RuleFixture` are TYPE-ONLY imports,
// erased at build time — they cost the bundle nothing regardless of source.
import { dayKeyInTz, weekdayOfYmd, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";
import { resolveSelector } from "@seazn/engine/scheduling/calendar";
import type {
  CapacityDay,
  CapacityEntrant,
  CapacityInput,
  CapacityWindow,
} from "@seazn/engine/scheduling/capacity";
import type { RuleFixture } from "@seazn/engine/scheduling/calendar";
import type { HardConstraint } from "@seazn/engine/scheduling";

/** Everything `capacityInputForFixtures` reads off a solved config. Plain
 *  epoch-ms/string fields — the same shape `SlotConfig & VerifyConfig`
 *  satisfies server-side (schedule.ts's plan), and the shape a client
 *  component builds from its own live form state (see capacity-card.tsx). */
export interface CapacityConfigInput {
  courts: string[];
  sessionWindows?: readonly { from: number; to: number }[];
  blackouts?: readonly { court?: string; from: number; to: number }[];
  matchMinutes: number;
  gapMinutes: number;
  perEntrantMinRest: number;
  window?: { from: number; to: number };
  tz?: string;
  constraints?: {
    restMin?: number;
    restByGroup?: Record<string, number>;
    noBackToBack?: boolean;
    /** Durable division rules (#398) — day caps this feature reads. Present
     *  on the server's `SlotConfig & VerifyConfig`; the setup card's
     *  `BoardConfig` carries no `hard` field at all (see capacity-card.tsx),
     *  so the CLIENT precheck never sees a day cap and can under-call
     *  "impossible" for a cap-only case. That's fine — "client hint, server
     *  authority" (design doc): the server guard always has this and is the
     *  422 gate that actually blocks Solve. */
    hard?: readonly HardConstraint[];
  };
  /** Compiled-instruction hard rules (`VerifyConfig.hard`) — merged with
   *  `constraints.hard` exactly as `effectiveHard` (calendar.ts) does,
   *  reimplemented inline rather than imported (see dayCapFor's comment). */
  hard?: readonly HardConstraint[];
}

export interface CapacityFixtureInput {
  home?: string | undefined;
  away?: string | undefined;
  poolId?: string | undefined;
  /** RuleFixture identity (calendar.ts:809 shape, minus `divisionId` — every
   *  fixture handed to one `capacityInputForFixtures` call already belongs
   *  to the single division being assessed, so the function's own
   *  `divisionId` parameter stands in for it when resolving a selector; see
   *  `forcedFixtureIdsByDate`). ALL THREE OPTIONAL and needed ONLY to
   *  resolve a `fixture_on_date`/`fixture_on_weekday` selector into a
   *  per-day FLOOR (`CapacityDay.forcedDemand`, capacity.ts's own doc
   *  comment). A caller that omits them simply gets no floor computed —
   *  under-counting is the direction this precheck must always err in, a
   *  false floor is the direction it must never take (same doc comment).
   *
   *  The client card's live form state does not track per-fixture identity
   *  today (`ext_key`/`winner_to_fixture` are not even in the public API
   *  schema — see stages-panel.tsx/settings-panel.tsx's own comments at
   *  their `capacityInputForFixtures` call sites) — that is fine and
   *  already precedented by `demandCap`: "client hint, server authority". */
  id?: string | undefined;
  extKey?: string | null | undefined;
  winnerTo?: string | null | undefined;
}

/** The calendar days a window covers, in `tz`, UNPADDED (unlike the
 *  solver's own `calendarDaysCovering`, which widens by a day on each side
 *  for lattice purposes this precheck has no use for). Built directly off
 *  the `tz.ts` leaf rather than importing the solver's version, which lives
 *  in `repair-domain.ts` — not a leaf. */
function calendarDays(window: { from: number; to: number }, tz: string): { ymd: string; from: number; to: number }[] {
  const out: { ymd: string; from: number; to: number }[] = [];
  let cursor = zonedTimeToUtc(dayKeyInTz(window.from, tz), "00:00", tz);
  while (cursor < window.to && out.length < 4000) {
    const ymd = dayKeyInTz(cursor, tz);
    const next = zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", tz);
    if (next <= cursor) break;
    // CLIPPED to the window, not just filtered by it: a sub-day window (the
    // tournament runs 09:00-17:00 on its only day) is one real day with a
    // shorter usable span, not zero days. Excluding the whole day here is
    // exactly the bug a first version of this function had — it silently
    // reported ample supply because the day it should have clipped to 4
    // hours never appeared in `days` at all.
    const from = Math.max(cursor, window.from);
    const to = Math.min(next, window.to);
    if (to > from) out.push({ ymd, from, to });
    cursor = next;
  }
  return out;
}

/** Subtract every `cut` that overlaps a window from `base`, splitting a
 *  window into up to two pieces per cut. */
function subtractIntervals(base: readonly CapacityWindow[], cuts: readonly CapacityWindow[]): CapacityWindow[] {
  let pieces = [...base];
  for (const cut of cuts) {
    const next: CapacityWindow[] = [];
    for (const p of pieces) {
      if (cut.to <= p.from || cut.from >= p.to) {
        next.push(p);
        continue;
      }
      if (cut.from > p.from) next.push({ from: p.from, to: Math.min(cut.from, p.to) });
      if (cut.to < p.to) next.push({ from: Math.max(cut.to, p.from), to: p.to });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.to > p.from);
}

/** A day's usable windows for ONE court: sessionWindows (or, when none are
 *  declared, the whole calendar day — the same "empty = unrestricted" rule
 *  the placer applies, calendar.ts:310) clipped to the day, minus every
 *  blackout that applies to this court (court-specific or global). */
function usableWindowsFor(
  court: string,
  dayFrom: number,
  dayTo: number,
  sessionWindows: readonly { from: number; to: number }[],
  blackouts: readonly { court?: string; from: number; to: number }[],
): CapacityWindow[] {
  const base: CapacityWindow[] =
    sessionWindows.length > 0
      ? sessionWindows
          .map((w) => ({ from: Math.max(w.from, dayFrom), to: Math.min(w.to, dayTo) }))
          .filter((w) => w.to > w.from)
      : [{ from: dayFrom, to: dayTo }];
  const applicable = blackouts.filter((b) => b.court === undefined || b.court === court);
  return subtractIntervals(base, applicable);
}

/** The flat per-day fixture-count ceiling from `max_fixtures_per_day` hard
 *  rules — v1 scope: competition-scoped (binds everyone) and this
 *  DIVISION's own division-scoped rule. A pool/entrant/person-scoped cap
 *  bounds a SUBSET of the day's demand, not the whole day's aggregate;
 *  modelling that precisely needs per-entrant demand splitting this
 *  precheck does not attempt (non-goal: "no soft-constraint prediction —
 *  that's the solver's job"). Multiple applicable rules take the MIN.
 *  `hard`/`constraints.hard` merged inline rather than importing
 *  `effectiveHard` (calendar.ts, not a leaf) — the merge itself is a
 *  two-array concat, not a rule worth a second implementation to avoid. */
function dayCapFor(config: CapacityConfigInput, divisionId: string): number | undefined {
  const hard = [...(config.hard ?? []), ...(config.constraints?.hard ?? [])];
  let cap: number | undefined;
  for (const h of hard) {
    if (h.type !== "max_fixtures_per_day") continue;
    const applies = h.scope.kind === "competition" || (h.scope.kind === "division" && h.scope.divisionId === divisionId);
    if (!applies) continue;
    cap = cap === undefined ? h.count : Math.min(cap, h.count);
  }
  return cap;
}

/** A sentinel `winnerTo` for a fixture whose terminal status the caller
 *  never supplied (`CapacityFixtureInput.winnerTo === undefined`, distinct
 *  from a KNOWN `null`). MUST be non-null: `null` is `resolveSelector`'s
 *  own definition of "terminal" (`f.winnerTo === null`), so defaulting an
 *  UNKNOWN status to `null` would make every fixture of unknown terminal
 *  status match a `terminal` selector — the over-counting direction
 *  `forcedDemand`'s doc comment (capacity.ts) forbids. Any fixed non-null
 *  string is safe here since `resolveSelector` only ever compares this
 *  field to the literal `null`, never to another fixture's id. */
const UNRESOLVED_WINNER_TO = "__capacity_input_unresolved_winner_to__";

/** `CapacityFixtureInput[]` -> the `RuleFixture[]` pool `resolveSelector`
 *  resolves against. A fixture missing `id` can never be identified, so it
 *  is EXCLUDED from the pool rather than guessed at — the same
 *  never-manufacture-a-false-floor rule the sentinel above follows for
 *  `winnerTo`. Every fixture is stamped with THIS division's id regardless
 *  of what (if anything) it supplies of its own: one `capacityDays` call
 *  only ever assesses one division's fixtures, so there is nothing for a
 *  per-fixture `divisionId` to disambiguate, and requiring the caller to
 *  repeat it on every fixture would be a redundant field to get wrong. */
function toRuleFixturePool(fixtures: readonly CapacityFixtureInput[], divisionId: string): RuleFixture[] {
  const out: RuleFixture[] = [];
  for (const f of fixtures) {
    if (f.id === undefined) continue;
    out.push({
      id: f.id,
      extKey: f.extKey ?? null,
      divisionId,
      ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
      winnerTo: f.winnerTo === undefined ? UNRESOLVED_WINNER_TO : f.winnerTo,
    });
  }
  return out;
}

/** `CapacityDay.forcedDemand` per date — the day's FLOOR, resolved through
 *  the engine's OWN `resolveSelector` (never reimplemented — see this
 *  file's header) so a `fixture_on_date`/`fixture_on_weekday` rule is
 *  judged by the SAME predicate the placer and verifier already use.
 *
 *  Scope and merge exactly mirror `dayCapFor`: `hard`/`constraints.hard`
 *  concatenated (not deduped — `resolveSelector` is called once per rule
 *  and the results are UNIONED into a per-date Set below, so a fixture
 *  named by two rules on the same date still counts once), and only
 *  competition- or this-division-scoped rules apply — a pool/entrant/
 *  person-scoped rule constrains a SUBSET of the day, not the whole day's
 *  floor, which is exactly why `dayCapFor` excludes the same scopes for
 *  `demandCap` (see its own comment).
 *
 *  `fixture_on_weekday` floors a date only when EXACTLY ONE bucket in the
 *  window matches that weekday — several matches is a subset restriction
 *  across multiple dates, not a floor on any one of them, and proving
 *  infeasibility over subsets is a Hall condition `capacity.ts` deliberately
 *  does not attempt (its own doc comment on `forcedDemand`). */
function forcedFixtureIdsByDate(
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityConfigInput,
  divisionId: string,
  bucketYmds: readonly string[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const ruleFixtures = toRuleFixturePool(fixtures, divisionId);
  if (ruleFixtures.length === 0) return out;

  const add = (date: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    let set = out.get(date);
    if (set === undefined) {
      set = new Set();
      out.set(date, set);
    }
    for (const id of ids) set.add(id);
  };
  const appliesToDivision = (scope: HardConstraint["scope"]): boolean =>
    scope.kind === "competition" || (scope.kind === "division" && scope.divisionId === divisionId);

  const hard = [...(config.hard ?? []), ...(config.constraints?.hard ?? [])];
  for (const h of hard) {
    if (h.type === "fixture_on_date") {
      if (!appliesToDivision(h.scope)) continue;
      if (!bucketYmds.includes(h.date)) continue; // outside this window — constrains nothing here
      add(h.date, resolveSelector(h.selector, h.scope, ruleFixtures).map((f) => f.id));
    } else if (h.type === "fixture_on_weekday") {
      if (!appliesToDivision(h.scope)) continue;
      const matches = bucketYmds.filter((ymd) => weekdayOfYmd(ymd) === h.weekday);
      if (matches.length !== 1) continue; // 0 or 2+ matches: not a floor (see header)
      add(matches[0]!, resolveSelector(h.selector, h.scope, ruleFixtures).map((f) => f.id));
    }
  }
  return out;
}

function capacityDays(
  config: CapacityConfigInput,
  divisionId: string,
  fixtures: readonly CapacityFixtureInput[],
): CapacityDay[] {
  const window = config.window!;
  const tz = config.tz!;
  const buckets = calendarDays(window, tz);
  const cap = dayCapFor(config, divisionId);
  const forced = forcedFixtureIdsByDate(
    fixtures,
    config,
    divisionId,
    buckets.map((b) => b.ymd),
  );
  const sessionWindows = config.sessionWindows ?? [];
  const blackouts = config.blackouts ?? [];
  return buckets.map((b) => {
    const forcedIds = forced.get(b.ymd);
    return {
      date: b.ymd,
      courts: config.courts.map((court) => ({
        court,
        windows: usableWindowsFor(court, b.from, b.to, sessionWindows, blackouts),
      })),
      ...(cap !== undefined ? { demandCap: cap } : {}),
      ...(forcedIds !== undefined && forcedIds.size > 0 ? { forcedDemand: forcedIds.size } : {}),
    };
  });
}

/** Per-entrant participation counts (k_e) off the fixture list, with the
 *  fixture's pool as `groupId` for a `restByGroup` lookup. A TBD side
 *  (home/away undefined) contributes nothing to any entrant's load. */
function capacityEntrants(fixtures: readonly CapacityFixtureInput[]): CapacityEntrant[] {
  const byId = new Map<string, CapacityEntrant>();
  const bump = (id: string | undefined, poolId: string | undefined): void => {
    if (id === undefined) return;
    const existing = byId.get(id);
    if (existing !== undefined) {
      existing.fixtures += 1;
      return;
    }
    byId.set(id, { entrantId: id, fixtures: 1, ...(poolId !== undefined ? { groupId: poolId } : {}) });
  };
  for (const f of fixtures) {
    bump(f.home, f.poolId);
    bump(f.away, f.poolId);
  }
  return [...byId.values()];
}

/**
 * Build the pure lib's input from a division's fixtures + resolved
 * schedule config. Returns `null` when there is nothing useful to assess:
 * an unbounded window (no `endAt`) has no day span to check supply
 * against, and `tz` absent is the same "skip rather than guess UTC" rule
 * every day-shaped rule in the engine package already follows.
 */
export function capacityInputForFixtures(
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityConfigInput,
  divisionId: string,
): CapacityInput | null {
  if (config.window === undefined || !Number.isFinite(config.window.to) || config.tz === undefined) return null;
  return {
    matchMinutes: config.matchMinutes,
    gapMinutes: config.gapMinutes,
    perEntrantMinRest: config.perEntrantMinRest,
    ...(config.constraints !== undefined
      ? {
          constraints: {
            restMin: config.constraints.restMin,
            restByGroup: config.constraints.restByGroup,
            noBackToBack: config.constraints.noBackToBack,
          },
        }
      : {}),
    fixtureCount: fixtures.length,
    days: capacityDays(config, divisionId, fixtures),
    entrants: capacityEntrants(fixtures),
  };
}
