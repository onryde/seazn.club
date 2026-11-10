import "server-only";
// ===========================================================================
// #350 Phase B — the JOINT VERIFIER and the JOINT RUNNER.
//
// THE CENTRAL DESIGN DECISION, stated once here because everything below
// follows from it:
//
//   `validateAssignments` takes ONE scalar config — one matchMinutes, one
//   gapMinutes, one blackouts[], one sessionWindows[], one constraints. A joint
//   run's divisions legitimately differ on every one of them.
//
// The tempting move is to merge them into a "strictest" config and make one
// call. That is wrong in both directions and silently: a merged session window
// applies division A's 09:00-12:00 to division B's fixtures (rejecting a legal
// afternoon board), and a merged blackout blacks out a division that never had
// one. There is no merge that is sound, because the fields are not properties of
// the BOARD — they are properties of a division's fixtures.
//
// So `verifyJoint` runs one pass PER DIVISION, with that division's own config,
// over that division's own fixtures, handing every OTHER division's proposed
// slots plus every obstacle in as `existing`. `validateAssignments` reports
// conflicts only for the assignments it is given, never for `existing`, so each
// pass judges exactly one division's fixtures by exactly one division's rules —
// while the checks that read the whole board (court occupancy, person overlap,
// feed order) still see every division's fixtures. That is precisely what
// JOINT_RULES' preamble promises the model, and the model is graded on it.
//
// Two consequences worth naming, both covered by tests:
//   * a cross-division court clash is reported TWICE, once per side, from the
//     two divisions' own passes. That is the desired report — either fixture
//     can be the one that moves — but it is also why some conflicts genuinely
//     arrive twice and are deduped below.
//   * cross-division court gap is charged at each division's OWN gapMinutes, so
//     verifyJoint can legitimately reject the greedy draft it was handed (the
//     drafting division applied its own, smaller, gap). Expected, not a bug.
// ===========================================================================
import {
  AI_VERIFY_POLICY,
  buildEngineConstraints,
  toEngineStartWindows,
} from "../engine-constraints";
import { isBlocking, toRuleFixture, windowBounds } from "../schedule-ai";
import { AiSchedulePlan } from "../schedule-ai-prompt";
import { validateInstructionRules } from "@seazn/engine/scheduling";
import type { HardConstraint, RuleFixture, VerifyConfig } from "@seazn/engine/scheduling";
import { conflictKey, validateAssignments, type Conflict } from "@seazn/engine/scheduling";
import { cmp, ms } from "./helpers";
import {
  jointFeedDependencies,
  toJointEngineAssignments,
  toJointObstacleAssignments,
} from "./joint-assignments";
import type { CompetitionPack, CompetitionPackDivision } from "./types";

/** A conflict's canonical detail alone, with the `fixtureId|reason|` prefix
 *  `conflictKey` (calendar.ts) leads with stripped off — NOT
 *  `canonConflictDetail` itself: it is not part of the engine's public
 *  barrel (only the `ConflictDetail`/`ConflictDetailKind` TYPES are
 *  re-exported, from calendar.ts), so this reuses `conflictKey`'s own
 *  computation rather than re-deriving canon locally, which would risk
 *  drifting from the engine's own field-order rules (review finding 6).
 *  Exact by construction: `conflictKey(c) === \`${c.fixtureId}|${c.reason}|\`
 *  + <canon>`, so slicing off that literal prefix recovers <canon> exactly,
 *  never an approximation. Same helper as competition-schedule-apply.ts's
 *  `sortConflicts` — duplicated rather than shared, matching how `cmp`
 *  itself is already duplicated per file here. */
const conflictDetailSuffix = (c: Conflict): string =>
  conflictKey(c).slice(`${c.fixtureId}|${c.reason}|`.length);

/** One division's verifier config — the per-division mirror of `verifyConfig`
 *  (schedule-ai.ts:914), reading `division.settings` instead of `pack.settings`.
 *
 *    startWindows       CONVERTED, not dropped. The single-division mirror
 *                        drops these on the grounds that the pack carries ISO
 *                        strings and the engine wants epoch ms — but that is a
 *                        conversion excuse: the `blackouts` and `sessionWindows`
 *                        lines below do exactly that conversion, with `ms()`.
 *                        The drop made `start_window` a conflict class the whole
 *                        joint product was blind to, at plan time AND apply
 *                        time, while the per-stage apply reports it through
 *                        `toSlotConfig` (schedule.ts:337-341).
 *                        The engine matches a `kind: "division"` window on the
 *                        assignment's `divisionId`, which the joint path is the
 *                        only one that stamps — so these govern per division
 *                        exactly as `restByGroup` does.
 *                        WARNINGS ONLY: `isBlocking` does not cover
 *                        `start_window`, and must not be taught to.
 *    fieldFairness: off
 *    parallelism: mixed  a PLACER preference, not a legality rule. Load-bearing
 *                        here in a way it is not single-division: the joint draft
 *                        feeds block-mode exclusivity asymmetrically (a division
 *                        avoids the divisions drafted BEFORE it and never those
 *                        after), so honouring it in the verifier would turn a
 *                        build-order artefact into a verdict.
 *    crossPersonClash: warn   INERT, and left here only so this literal keeps
 *                        parsing. Nothing reads the field any more: #399 made
 *                        the write gate refuse an INTRODUCED person overlap
 *                        absolutely (`isBlockingConflict` lists
 *                        `person_overlap` unconditionally), and the placer now
 *                        avoids one for that same reason rather than consulting
 *                        the setting. The asymmetry earlier revisions of this
 *                        comment documented — plan warns, apply refuses — is
 *                        therefore gone: both sides refuse. Do not restore a
 *                        branch on this value without first changing the gate. */
export function verifyConfigFor(
  division: CompetitionPackDivision,
  /** The RUN's resolved calendar window, epoch ms (#397). Optional, but the
   *  apply path DOES pass one since #399 — `applyWindow(d.settings)`, the
   *  division's own configured dates rather than the pack's widened window.
   *  What keeps a pre-existing out-of-window board from becoming a wall of
   *  refusals is the delta, not the absence of the bound. */
  window?: { from: number; to: number },
  /** The run-wide typed-rule inputs (#398). Optional for the same reason
   *  `window` is: the apply path passes none, because apply-time blocking is
   *  W4 (#399). `restByDivision` is what makes a cross-division pair rest at
   *  the MAX of both divisions rather than at whichever pass happened to see
   *  it — this function runs once PER DIVISION with that division's own
   *  config, which is exactly how the pair came to be checked twice at two
   *  different values. */
  rules?: {
    tz: string;
    hard: readonly HardConstraint[];
    ruleFixtures: readonly RuleFixture[];
    restByDivision: Readonly<Record<string, number>>;
  },
  /** The ORG zone ALONE, for the apply path (#399 follow-up, C1 gap A).
   *  Mirrors `window` exactly, for the identical reason: the round-order scan
   *  (`validateAssignments`, calendar.ts ~1535) is gated on `config.tz` alone
   *  and reads no other field `rules` carries, so this switches on THAT and
   *  nothing else — never `hard`/`ruleFixtures`/`restByDivision`, which stay
   *  `undefined` whenever `rules` is not also given. Provably so, not just by
   *  convention: `effectiveHard` (calendar.ts) merges `config.hard` with
   *  `config.constraints?.hard`, and `buildEngineConstraints` — the ONE
   *  builder `constraints` above goes through, `rules` or not — never
   *  populates `.hard` under `AI_VERIFY_POLICY` (`hard: false`). So
   *  `effectiveHard(config)` is `[]` at any call site that omits `rules`,
   *  this parameter included, and `validateInstructionRules`'s entire typed-
   *  rule block (gated on that same `tz`) loops over nothing regardless.
   *
   *  Ignored when `rules` is also supplied — `rules.tz` wins, the fuller,
   *  authoritative source. The two are not expected to be passed together in
   *  practice (the AI path passes `rules`; the apply path passes this), but
   *  the priority is spelled out rather than left to argument order.
   *
   *  Sourced from `settings.orgTz`, never `settings.displayTz`/`.tz` — same
   *  ruling `applyWindow` and `toVerifyConfig` (schedule.ts) already follow:
   *  the org zone governs every temporal boundary (#397), a division's
   *  display override must not move which calendar day a fixture is judged
   *  on, and two divisions of one competition must agree on that day. */
  tz?: string,
): VerifyConfig {
  const s = division.settings;
  return {
    ...(rules !== undefined
      ? {
          tz: rules.tz,
          hard: rules.hard,
          ruleFixtures: rules.ruleFixtures,
          restByDivision: rules.restByDivision,
        }
      : tz !== undefined
        ? { tz }
        : {}),
    perEntrantMinRest: s.perEntrantMinRest,
    matchMinutes: s.matchMinutes,
    // Through the ONE builder (#458) the board path and the single-division AI
    // path also go through. `AI_VERIFY_POLICY` pins the three solver knobs inert
    // — `PackConstraints` types them as bare `string` (the pack is a wire shape)
    // so this path cannot narrow them — and routes the durable rules to the
    // top-level `hard` field rather than `constraints.hard`, since
    // `effectiveHard` merges the two and carrying both would double-count.
    //
    // The builder DROPS a start window whose `target.kind` falls outside the
    // engine's enum, which is the behaviour this site had and the other two did
    // not. Same reason as ever: `kind` is a bare `string` here, so casting an
    // unrecognised one through would let the engine silently never match it and
    // hide that a stored settings row has drifted from the enum.
    //
    // PLAN-TIME CONSEQUENCE of carrying start windows at all, flagged rather
    // than left to be discovered: this function feeds `verifyJoint`, whose
    // non-blocking conflicts become `result.warnings`, which `planIsAcceptable`
    // divides by the movable count against SCHEDULING_AI_ESCALATE_WARN_RATIO
    // (schedule-ai.ts). So `start_window` violations count toward ladder
    // escalation, and a joint plan that used to look acceptable can escalate a
    // rung.
    //
    // Kept in the ratio on purpose. The pack SHOWS the model these windows
    // (`PackSettings.constraints.startWindows`), so ignoring them is a real
    // quality miss — and every other soft constraint the model is shown
    // (blackout, session window, rest, person overlap) already counts, so
    // excluding one class would make the heuristic inconsistent in a way nobody
    // would remember. It cannot change what an org is charged: credits are
    // quoted up front and escalation spends the already-paid budget. It CAN
    // bring `stopped_on_budget` forward, which is the honest cost. The ratio is
    // documented as uncalibrated and is an env knob — that is where it should be
    // tuned, not by hand-picking which reasons count. Pinned by a test in
    // competition-schedule-verify.test.ts.
    ...(s.constraints !== null
      ? { constraints: buildEngineConstraints(s.constraints, AI_VERIFY_POLICY) }
      : {}),
    gapMinutes: s.gapMinutes,
    blackouts: s.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: ms(b.from),
      to: ms(b.to),
    })),
    sessionWindows: s.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) })),
    // #397: the RUN's window, shared by every division's pass — one competition,
    // one set of days. Warn-only; `isBlocking` is unchanged.
    ...(window !== undefined ? { window } : {}),
  };
}

/**
 * ONE config for a solve over the WHOLE joint board (#401).
 *
 * `verifyJoint` grades per division, each with that division's own config. The
 * repair solver takes a single config, and it must — the clash this whole
 * pipeline exists to catch is BETWEEN divisions, so a per-division solve would
 * find each board spotless and hand the organiser a double-booked court.
 *
 * The merge rule, and why it is safe rather than approximate:
 *
 *   * BLOCKING families are exact under the merge. `isBlocking` covers court
 *     double-booking and direct feed order, and nothing else. A court clash is a
 *     property of (court label, interval) and needs no per-division setting; a
 *     direct order violation is resolved from `dependencies` and the run-wide
 *     `ruleFixtures` this builds. So a board this config calls court- and
 *     order-clean IS court- and order-clean under every division's own pass.
 *     That is the guarantee the caller relies on, and it does not depend on any
 *     of the merges below being faithful.
 *   * Everything else merges CONSERVATIVELY — tighter than any one division, never
 *     looser. Rest and gaps take the maximum; blackouts take the union; courts
 *     and session windows take the INTERSECTION. A conservative merge can only
 *     cost the solver solutions, and a solver that finds none falls back to the
 *     LLM round that was going to run anyway. A loose merge would do the
 *     opposite: produce a board that is legal under the merge and illegal under
 *     the division that owns the fixture.
 *
 * COURTS ARE THE SHARP EDGE. Court ownership is a STRUCTURAL rule
 * (`jointStructuralCheck`), not a verifier one — no `validateAssignments` pass
 * rejects an Alpha fixture on a court only Beta owns. Hand the solver the union
 * and it will use the extra courts, and the joint verifier will grade the result
 * clean. Hence the intersection: every court the solver may pick is legal for
 * every division in the run.
 *
 * The cost is real and bounded: a competition whose divisions hold different
 * courts (`pack.divergentCourts` is non-empty) gives the solver fewer courts to
 * work with, and one whose divisions share NO court gives it none — that case is
 * declined outright rather than attempted. The proper fix is per-fixture court
 * domains in the engine's repair input, which is an engine change and not this
 * one; until then the conservative answer is the correct one.
 */
export function jointSolverConfig(pack: CompetitionPack): VerifyConfig & { courts: string[] } {
  const divisions = pack.divisions;
  // Built by the shared producer, not a literal of its own (#443) — see
  // `toRuleFixture`. Each fixture's OWN division, because a joint pack spans
  // several.
  const ruleFixtures: RuleFixture[] = pack.fixtures.movable.map((f) =>
    // #449: the pool UUID, overriding the display key `pool` carries. A
    // RuleFixture's poolId MASKS its assignment's in `scopeCoversFixture`, so a
    // key here would defeat the uuid stamped by `toJointEngineAssignments`.
    toRuleFixture({ ...f, pool: pack.poolIds[f.id] ?? null }, f.division_id),
  );
  const settings = divisions.map((d) => d.settings);
  const max = (pick: (s: (typeof settings)[number]) => number): number =>
    settings.reduce((acc, s) => Math.max(acc, pick(s)), 0);

  // Courts every division may use. Order follows the pack's own court order so
  // the solve is deterministic.
  const courts = pack.courts.filter((c) => settings.every((s) => s.courts.includes(c)));

  // A division with NO session windows is unconstrained, not "constrained to
  // nothing" — it must not empty the intersection.
  const sessionWindows = intersectWindows(
    settings.filter((s) => s.sessionWindows.length > 0).map((s) => s.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) }))),
  );

  const withConstraints = settings.filter((s) => s.constraints !== null).map((s) => s.constraints!);
  const restByGroup: Record<string, number> = {};
  for (const c of withConstraints) {
    for (const [k, v] of Object.entries(c.restByGroup ?? {})) {
      restByGroup[k] = Math.max(restByGroup[k] ?? 0, v);
    }
  }
  const restMins = withConstraints.flatMap((c) => (c.restMin !== undefined ? [c.restMin] : []));

  return {
    tz: pack.tz,
    // The same merged stream `verifyJoint` grades against: the compiled
    // instruction plus every division's durable rules.
    hard: [...pack.parsed.hard, ...divisions.flatMap((d) => d.settings.constraints?.hard ?? [])],
    ruleFixtures,
    // A human entered in two divisions recovers at the MAX of both. The engine
    // reads this off each assignment's `divisionId`, which the joint path is the
    // only one that stamps.
    restByDivision: Object.fromEntries(divisions.map((d) => [d.id, d.settings.perEntrantMinRest])),
    perEntrantMinRest: max((s) => s.perEntrantMinRest),
    matchMinutes: max((s) => s.matchMinutes),
    gapMinutes: max((s) => s.gapMinutes),
    ...(withConstraints.length > 0
      ? {
          constraints: {
            ...(restMins.length > 0 ? { restMin: Math.max(...restMins) } : {}),
            ...(Object.keys(restByGroup).length > 0 ? { restByGroup } : {}),
            // Any division that forbids back-to-back forbids it for the merge.
            noBackToBack: withConstraints.some((c) => c.noBackToBack === true),
            // Start windows are TARGETED by entrant, pool or division id, so the
            // union is exact rather than conservative: a division's window binds
            // that division's fixtures and no others.
            //
            // The per-window transform is the SHARED one (#458) — this config
            // unions several divisions and so has no single `constraints` source
            // to hand `buildEngineConstraints`, but a hand-written copy of the
            // ISO→ms conversion and the unrecognised-kind drop is exactly the
            // duplication that produced #458.
            startWindows: withConstraints.flatMap((c) => toEngineStartWindows(c.startWindows)),
            fieldFairness: "off" as const,
            parallelism: "mixed" as const,
            crossPersonClash: "warn" as const,
          },
        }
      : {}),
    // Union: a blackout on one division's court is a court nobody should be put
    // on at that instant, and over-avoiding one is a lost solution, never an
    // illegal board.
    blackouts: divisions.flatMap((d) =>
      d.settings.blackouts.map((b) => ({
        ...(b.court !== undefined ? { court: b.court } : {}),
        from: ms(b.from),
        to: ms(b.to),
      })),
    ),
    sessionWindows,
    window: windowBounds(pack.window),
    courts,
  };
}

/** Intersect interval lists. An empty input list means "nobody constrained
 *  this", which is the whole timeline, not nothing. */
function intersectWindows(
  lists: { from: number; to: number }[][],
): { from: number; to: number }[] {
  if (lists.length === 0) return [];
  return lists.reduce((acc, list) => {
    const out: { from: number; to: number }[] = [];
    for (const a of acc) {
      for (const b of list) {
        const from = Math.max(a.from, b.from);
        const to = Math.min(a.to, b.to);
        if (from < to) out.push({ from, to });
      }
    }
    return out;
  });
}

/** The joint pipeline's conflict partition: `warnings` is the EXACT complement
 *  of `blocking`, never a narrower selection.
 *
 *  Extracted and exported only so a test can pin that, because it is the one
 *  place R13 can be broken silently. This partition feeds two things at once —
 *  `planIsAcceptable`'s escalation numerator, and the `warnings` the response
 *  carries — so a filter added here drops a whole conflict class from BOTH the
 *  ladder's quality signal and the organiser's review, with every joint suite
 *  still green. R13 exists because a cross-division person double-book is a
 *  warning that no automated gate catches: the organiser reading the proposal
 *  is the last line of defence, and this is where they stop being able to. */
export function partitionConflicts(conflicts: readonly Conflict[]): {
  blocking: Conflict[];
  warnings: Conflict[];
} {
  return {
    blocking: conflicts.filter(isBlocking),
    warnings: conflicts.filter((c) => !isBlocking(c)),
  };
}

/**
 * Verify a joint proposal: one `validateAssignments` pass per division, each
 * with that division's own config, each over the whole board.
 *
 * See the section header for why this is not one merged call. The `existing`
 * handed to a division's pass is every OTHER division's proposed slots plus
 * every obstacle — that is what makes a cross-division court clash visible: the
 * other division's fixture is on the board, so this division's fixture collides
 * with it and is reported. The other side of the same clash is reported by that
 * division's own pass.
 *
 * `existing` also carries every OBSTACLE — the selected divisions' own immovable
 * fixtures plus every out-of-run division's placements. Dropping them does not
 * fail loudly: it makes the verifier call a board clean while the model has
 * double-booked a court against a real, already-scheduled fixture nobody can
 * move.
 *
 * Deduplication is not cosmetic. `validateAssignments` resolves feed
 * dependencies against the whole board rather than the pass's own assignments,
 * so a within-division order violation is re-reported verbatim by every other
 * division's pass. Keyed on (fixtureId, reason, detail): the two SIDES of a
 * court clash differ on fixtureId and both survive, which is the intent — either
 * one can be the fixture that moves.
 *
 * @throws HttpError 500 AI_PLAN_INVALID_ASSIGNMENT (inherited from
 *   {@link toJointEngineAssignments}) when the plan names a fixture outside the
 *   pack — the invariant every entry has a resolvable `divisionId`, without
 *   which an assignment would be verified by no pass at all.
 */
export function verifyJoint(plan: AiSchedulePlan, pack: CompetitionPack): Conflict[] {
  const all = toJointEngineAssignments(plan, pack);
  const obstacles = toJointObstacleAssignments(pack);
  const deps = jointFeedDependencies(pack);
  const seen = new Set<string>();
  const out: Conflict[] = [];

  // #398: built ONCE for the run, then handed to every per-division pass.
  // `restByDivision` is the fix for cross-division rest: a human entered in two
  // divisions recovers at the MAX of both values, not at whichever division's
  // pass happened to look at the pair. `hard` merges the compiled instruction
  // with every division's durable rules so there is one stream.
  const restByDivision = Object.fromEntries(
    pack.divisions.map((d) => [d.id, d.settings.perEntrantMinRest]),
  );
  // Same shared producer as `jointSolverConfig` (#443): the verifier and the
  // solver must be handed rule fixtures built by ONE piece of code, or they can
  // disagree about which fixture a feed edge names.
  const ruleFixtures: RuleFixture[] = pack.fixtures.movable.map((f) =>
    // #449: the pool UUID, overriding the display key `pool` carries. A
    // RuleFixture's poolId MASKS its assignment's in `scopeCoversFixture`, so a
    // key here would defeat the uuid stamped by `toJointEngineAssignments`.
    toRuleFixture({ ...f, pool: pack.poolIds[f.id] ?? null }, f.division_id),
  );
  const hard: HardConstraint[] = [
    ...pack.parsed.hard,
    ...pack.divisions.flatMap((d) => d.settings.constraints?.hard ?? []),
  ];
  // A competition-scoped rule is a statement about the WHOLE board, so it is
  // evaluated ONCE below rather than inside a per-division pass — counted per
  // pass, three fixtures split 2/1 across two divisions would satisfy a 2/day
  // cap the competition plainly breaks. The per-division passes get only the
  // `min_rest_minutes` entries, which are resolved pairwise (and raise the rest
  // bound rather than reporting a rule of their own).
  const rules = {
    tz: pack.tz,
    hard: hard.filter((h) => h.type === "min_rest_minutes"),
    ruleFixtures,
    restByDivision,
  };
  // `obstacles` as the third argument: a per-day cap counts what is already on
  // the day, and an outside booking occupies a court just as surely as a fixture.
  for (const c of validateInstructionRules(all, { tz: pack.tz, hard, ruleFixtures }, obstacles)) {
    // The engine's own identity (calendar.ts's `conflictKey`, C3 2026-08-13:
    // now folds `details` through `canonConflictDetail` rather than a raw
    // prose string) — reused rather than reimplemented so this dedupe can
    // never drift from what `deltaConflicts` and the joint apply gate key on.
    const key = conflictKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }

  for (const division of pack.divisions) {
    const mine = all.filter((a) => a.divisionId === division.id);
    if (mine.length === 0) continue;
    const others = all.filter((a) => a.divisionId !== division.id);
    for (const c of validateAssignments(
      mine,
      verifyConfigFor(division, windowBounds(pack.window), rules),
      [...others, ...obstacles],
      deps,
    )) {
      const key = conflictKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  // Sort on DOMAIN keys, never on the fixture UUID (the determinism contract at
  // schedule-ai.ts:1-12). Division order is the pack's own (name, slug) order, so
  // the report also arrives grouped by division and then in playing order, which
  // is how the model reads it back on a repair round.
  const rank = new Map<string, [number, number, number, string]>();
  const divisionIndex = new Map(pack.divisions.map((d, i) => [d.id, i]));
  for (const f of pack.fixtures.movable) {
    rank.set(f.id, [divisionIndex.get(f.division_id) ?? pack.divisions.length, f.round, f.seq, f.ext_key ?? ""]);
  }
  const UNRANKED: [number, number, number, string] = [Number.MAX_SAFE_INTEGER, 0, 0, ""];
  return out.sort((a, b) => {
    const ra = rank.get(a.fixtureId) ?? UNRANKED;
    const rb = rank.get(b.fixtureId) ?? UNRANKED;
    return (
      ra[0] - rb[0] ||
      ra[1] - rb[1] ||
      ra[2] - rb[2] ||
      cmp(ra[3], rb[3]) ||
      cmp(a.reason, b.reason) ||
      // The two conflicts' canonical detail SUFFIX (review finding 6) — NOT
      // `conflictKey` whole, which a prior version of this comment claimed
      // "reduces to" the same thing. It does not: `conflictKey` LEADS with
      // `fixtureId`, so comparing it whole sorts primarily by fixtureId and
      // never reaches the detail at all when the two fixtures differ,
      // silently changing this order from pre-C3 (which compared the raw
      // `detail` string — no fixtureId prefix, off its prose instead of the
      // structured detail) and making the `cmp(a.fixtureId, b.fixtureId)`
      // tie-break below unreachable (once the suffix comparison is 0, the
      // fixtureId prefix that produced it must already be equal too).
      cmp(conflictDetailSuffix(a), conflictDetailSuffix(b)) ||
      // Last-resort only: two conflicts identical on every domain key AND
      // the same canonical detail. Reaching this means the seed has
      // duplicate (round, seq, ext_key) within one division, which the
      // fixture generator does not produce.
      cmp(a.fixtureId, b.fixtureId)
    );
  });
}

/** Structural gate run before the engine verifier — the joint mirror of
 *  `structuralCheck` (schedule-ai.ts:841). One rule changes: a fixture's
 *  `court_label` must appear in ITS OWN division's `settings.courts`, not merely
 *  in `pack.courts`. The union is a rendering convenience for the board; using
 *  it as the gate would let the model place an Alpha fixture on a court only
 *  Beta has, which is unschedulable in the real world and which the engine
 *  cannot detect (it has no notion of which courts a division owns). */
export function jointStructuralCheck(
  plan: AiSchedulePlan,
  movableIds: Set<string>,
  pack: CompetitionPack,
): string | null {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const divisionById = new Map(pack.divisions.map((d) => [d.id, d]));
  const pinned = new Map(pack.fixtures.movable.filter((f) => f.pinned).map((f) => [f.id, f]));
  // #622 review: the joint mirror of `structuralCheck`'s own `narrowedCourts`
  // (schedule-ai.ts) — `CompetitionPackFixture` extends `PackFixture` and
  // inherits its `courts` field unchanged from the per-division sub-pack
  // (`buildJointPack`'s `movable` spread), so the data was always here; only
  // this check never read it, letting a joint AI plan relocate a round-tagged
  // fixture (e.g. a final requiring the championship court) onto any court in
  // its division's list.
  const narrowedCourts = new Map(
    pack.fixtures.movable
      .filter((f) => f.courts !== undefined)
      .map((f) => [f.id, new Set(f.courts!)] as const),
  );
  const seen = new Set<string>();
  const placed = new Set<string>();
  for (const a of plan.assignments) {
    if (!movableIds.has(a.fixture_id)) return `assignment references non-movable fixture ${a.fixture_id}`;
    if (seen.has(a.fixture_id)) return `fixture ${a.fixture_id} appears more than once`;
    seen.add(a.fixture_id);
    placed.add(a.fixture_id);
    const division = divisionById.get(fixtureById.get(a.fixture_id)?.division_id ?? "");
    if (division === undefined) return `assignment references a fixture with no division: ${a.fixture_id}`;
    if (!division.settings.courts.includes(a.court_label)) {
      return `fixture ${a.fixture_id} uses a court its own division (${division.name}) does not have: ${a.court_label}`;
    }
    const pin = pinned.get(a.fixture_id);
    // Same pin exemption `structuralCheck` grants — a retroactive tag change
    // must not make an already-pinned fixture's own current court unsatisfiable.
    const narrow = narrowedCourts.get(a.fixture_id);
    if (narrow && !narrow.has(a.court_label) && !(pin && pin.current.court === a.court_label)) {
      return `fixture ${a.fixture_id} uses a court not permitted for its stage: ${a.court_label}`;
    }
    if (
      pin &&
      (pin.current.at === null ||
        ms(pin.current.at) !== ms(a.scheduled_at) ||
        pin.current.court !== a.court_label)
    ) {
      return `pinned fixture ${a.fixture_id} must not move`;
    }
  }
  for (const u of plan.unschedulable) {
    if (!movableIds.has(u.fixture_id)) return `unschedulable references non-movable fixture ${u.fixture_id}`;
    if (seen.has(u.fixture_id)) return `fixture ${u.fixture_id} appears more than once`;
    seen.add(u.fixture_id);
    if (pinned.has(u.fixture_id)) return `pinned fixture ${u.fixture_id} cannot be marked unschedulable`;
  }
  // R7: `movableIds` iteration order is NOT stable — only `.size` and
  // membership are. This loop reads membership and produces at most one id in an
  // error string, so it is safe; nothing here may serialise the whole set.
  for (const id of movableIds) {
    if (!seen.has(id)) return `movable fixture ${id} is missing from the plan`;
  }
  // UNREACHABLE BY CONSTRUCTION, kept because schedule-ai.ts:870 keeps it and
  // the two must not drift. Every pinned movable id has already been accounted
  // for above: absent from both lists → "is missing from the plan"; in
  // `unschedulable` → "cannot be marked unschedulable"; in `assignments` →
  // `placed`. It only becomes live if one of those three guards is removed.
  for (const [id] of pinned) {
    if (movableIds.has(id) && !placed.has(id)) return `pinned fixture ${id} must stay at its current slot`;
  }
  return null;
}
