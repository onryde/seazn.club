// R4: seed 3 withdraws after round 1. W1a asserts only that the cascade is
// CONSISTENT with the policy the engine reported; which policy SHOULD apply is
// the rulebook's call (W2+). Canary: also judge the cascade against the
// opposite policy.
//
// W1-driving Task 7 (D14; rulings 51, 53): on a LADDER, "round 1" is a
// challenge, so seed 3 withdraws after the first challenge that seats it.
// D8 decides every challenge before the next is issued, so nothing of seed
// 3's is pending then and the product's answer is policy "none"
// (withdrawal.ts:213-217): the ladder's expected policy is DERIVED from what
// was pending, never assumed. The open-format cascade ABANDONS pending
// fixtures (false premise 16), so the cascade model is chosen by kind.
import type { CheckResult } from "../results.ts";
import type { FixtureRow } from "../driver/types.ts";
import { fieldSizeFor } from "../field-size.ts";
import { DEPARTED_STATUSES, FORFEIT_MODEL_KINDS, PENDING_STATUSES, sameResult, snap, toObservedOutcome, winnerOf, type CompleteObs, type FixtureSnap, type ObservedFixture, type WithdrawalObs } from "../observed.ts";
import { routeTo } from "../routing.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, withCanary, type Item } from "./assertions.ts";
import { Recorder, playDivision, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 8;
/** withdrawal.ts applyUpdate: these are reported as skipped, never touched. */
const LOCKED = new Set(["finalized", "cancelled"]);

/** One pending fixture judged under a walkover: its item, and whether the
 *  cascade forfeited or voided (abandoned) it. */
interface WalkoverJudgement { readonly item: Item; readonly forfeited: boolean; readonly voided: boolean }
type WalkoverModel = (b: FixtureSnap, a: ObservedFixture, w: string) => WalkoverJudgement;
/** A fixture the cascade itself abandoned (withdrawal.ts applyUpdate counts
 *  `voided` once per core.abandon it posts, so one already abandoned before
 *  the withdrawal is not one of them). */
const voidedBy = (b: FixtureSnap, a: ObservedFixture) => a.status === "abandoned" && b.status !== "abandoned";

/** W1-driving Task 7 (false premise 16): how a walkover treats a pending
 *  fixture, by family.
 *  - forfeit (table and bracket kinds): forfeited to the OPPONENT, or voided
 *    (abandoned) when that seat is still TBD;
 *  - abandon (every other kind — ladder, page playoff, americano: the
 *    open-format branch, withdrawal.ts:213-217): voided, never forfeited. */
export const WALKOVER_MODEL: Readonly<Record<"forfeit" | "abandon", WalkoverModel>> = Object.freeze({
  forfeit: (b, a, w) => {
    const opponent = a.home === w ? a.away : a.home;
    if (opponent === null) {
      return { item: { ok: a.status === "abandoned", note: `${b.id}: ${a.status} after walkover with a TBD opponent, expected abandoned` }, forfeited: false, voided: voidedBy(b, a) };
    }
    const ok = a.status === "forfeited" && winnerOf(a.outcome) === opponent;
    return { item: { ok, note: `${b.id}: ${a.status}/${winnerOf(a.outcome)} after walkover, expected forfeited/${opponent}` }, forfeited: ok, voided: false };
  },
  abandon: (b, a) => ({ item: { ok: a.status === "abandoned", note: `${b.id}: ${a.status} after an open-format walkover, expected abandoned` }, forfeited: false, voided: voidedBy(b, a) }),
});
/** The walkover model a stage kind's withdrawal takes. */
export const walkoverModelFor = (kind: string): keyof typeof WALKOVER_MODEL => (FORFEIT_MODEL_KINDS.includes(kind) ? "forfeit" : "abandon");

/** What each policy implies for the withdrawn entrant's fixtures
 *  (withdrawal.ts:1-17 and 130-232, engine stage.ts withdrawTableEntrant):
 *  - expunge: every fixture it touched is abandoned, except locked ones;
 *  - walkover: each PENDING fixture is judged by the stage kind's
 *    WALKOVER_MODEL; finished ones stand;
 *  and the reported walkover count equals the forfeits observed, and the
 *  reported voided count equals the fixtures the cascade itself abandoned.
 *  `kind`: the stage kind the fixtures belong to. */
export function cascadeItems(policy: WithdrawalObs["policy"], w: string, before: readonly FixtureSnap[], after: readonly ObservedFixture[], walkoversReported: number, voidedReported: number, kind: string): Item[] {
  const items: Item[] = [];
  let forfeitedByCascade = 0;
  let voidedByCascade = 0;
  const walkover = WALKOVER_MODEL[walkoverModelFor(kind)];
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (a === undefined) { items.push({ ok: false, note: `${b.id}: vanished` }); continue; }
    if (policy === "walkover" && PENDING_STATUSES.includes(b.status)) {
      const j = walkover(b, a, w);
      if (j.forfeited) forfeitedByCascade++;
      if (j.voided) voidedByCascade++;
      items.push(j.item);
    } else if (policy === "expunge" && !LOCKED.has(b.status)) {
      if (voidedBy(b, a)) voidedByCascade++;
      items.push({ ok: a.status === "abandoned", note: `${b.id}: ${a.status} after expunge` });
    } else {
      items.push({ ok: sameResult(a, b), note: `${b.id}: changed ${b.status}→${a.status}` });
    }
  }
  if (policy === "walkover") items.push({ ok: forfeitedByCascade === walkoversReported, note: `reported ${walkoversReported} walkovers, observed ${forfeitedByCascade}` });
  items.push({ ok: voidedByCascade === voidedReported, note: `reported ${voidedReported} voided, observed ${voidedByCascade}` });
  return items;
}

/** m-5: the reported count of LOCKED fixtures the cascade skipped.
 *  withdrawal.ts applyUpdate counts a PLANNED fixture that is finalized or
 *  cancelled. Only an expunge plans played fixtures — a played status with a
 *  result (lib/table-withdrawal.ts) — so it is the finalized ones with a
 *  result; a walkover plans pending ones only, and a pending fixture is never
 *  locked. */
export function skippedItem(policy: WithdrawalObs["policy"], before: readonly FixtureSnap[], reported: number): Item {
  const observed = policy === "expunge" ? before.filter((b) => b.status === "finalized" && b.outcome !== null).length : 0;
  return { ok: reported === observed, note: `reported ${reported} locked fixture(s) skipped, observed ${observed}` };
}

/** R4's family: the ladder's timing and policy (D14) differ from every other kind's. */
type R4Family = "default" | "ladder";
const familyOf = (kind: string): R4Family => (kind === "ladder" ? "ladder" : "default");

/** D14 (ruling 51): WHEN seed 3 withdraws, per family — after round 1, or on
 *  a ladder after the first challenge that seats seed 3 (a challenge batch is
 *  that one fixture). The hook fires once either way. */
export const R4_TRIGGER: Readonly<Record<R4Family, (round: number, batch: readonly FixtureRow[], seed3: string) => boolean>> = Object.freeze({
  default: (round) => round === 1,
  ladder: (_round, batch, seed3) => batch.some((f) => f.home_entrant_id === seed3 || f.away_entrant_id === seed3),
});

/** Ruling 53: the open-format branch's policy (withdrawal.ts:213-217) —
 *  "walkover" only when the entrant had something pending, else "none". */
export function expectedPolicy(before: readonly FixtureSnap[]): "walkover" | "none" {
  return before.some((f) => PENDING_STATUSES.includes(f.status)) ? "walkover" : "none";
}

/** Ruling 53: a withdrawn player's ladder finalRanks rung is a rulebook
 *  question, recorded as a note and never asserted either way. */
const LADDER_RANKS_ROUTE = routeTo("W7", "a withdrawn player keeps a ladder finalRanks rung (the raw ladder_order) — ruling 53");

export interface NotChallengedLaterInput {
  readonly kind: string;
  readonly seed3: string;
  /** Seed 3's index in the RAW ladder_order when its withdrawal answered (-1: absent). */
  readonly heldAt: number;
  /** The RAW ladder_order at the end of the run. */
  readonly raw: readonly string[];
  /** The entrants the product holds as departed (DEPARTED_STATUSES). */
  readonly departed: ReadonlySet<string>;
  /** The challenge fixtures playLadder issued AFTER the withdrawal step, as
   *  observed — or the bare id of one the division no longer lists. */
  readonly later: readonly (ObservedFixture | string)[];
}

/** Ruling 53 (D14): the ladder's twin of r4-not-paired-later. Items: seed 3
 *  is off the LIVE ladder (raw minus departed, the product's read-time
 *  filter); seed 3 still holds its rung in the RAW order (stages.ts never
 *  prunes it); and no later challenge seats seed 3 (one item each — the
 *  product would refuse one LADDER_ENTRANT_WITHDRAWN). Ladder only; no later
 *  challenge is an abstain with its reason, never a pass (TEST-STRATEGY rule 2). */
export function notChallengedLater(i: NotChallengedLaterInput): CheckResult {
  const id = "r4-not-challenged-later";
  if (i.kind !== "ladder") return assertion(id, [], "ladder only: challenges exist on ladder stages alone");
  if (i.later.length === 0) return assertion(id, [], "no challenge followed the withdrawal");
  const live = i.raw.filter((e) => !i.departed.has(e));
  return assertion(id, [
    { ok: !live.includes(i.seed3), note: `withdrawn ${i.seed3} is still on the live ladder` },
    { ok: i.heldAt >= 0 && i.raw.indexOf(i.seed3) === i.heldAt, note: `withdrawn ${i.seed3} at raw rung ${i.raw.indexOf(i.seed3)}, held rung ${i.heldAt} at withdrawal` },
    ...i.later.map((f) => (typeof f === "string"
      ? { ok: false, note: `${f}: a later challenge the division no longer lists` }
      : { ok: f.home !== i.seed3 && f.away !== i.seed3, note: `${f.id}: a later challenge seats withdrawn ${i.seed3}` })),
  ]);
}

/** What the observed /complete says of a withdrawn player's finalRanks rung (review m-4): the rung it holds, that it holds
 *  none, or that no finalRanks exists — each with the raw rung it held when its withdrawal answered. */
function ladderRanksNote(complete: CompleteObs | null, entrantId: string, heldAt: number): string {
  const ranks = complete?.finalRanks ?? null;
  if (ranks === null) return `ladder finalRanks: ${complete?.completed === true ? "stage completed with no finalRanks" : "stage not complete"}, no rung observed for withdrawn ${entrantId} (raw held ${heldAt})`;
  const rung = ranks.indexOf(entrantId);
  return rung < 0 ? `ladder finalRanks hold no rung for withdrawn ${entrantId} (raw held ${heldAt})` : `ladder finalRanks rung ${rung} for withdrawn ${entrantId} (raw held ${heldAt})`;
}

/** The stage's RAW ladder_order as the product lists it ([] before any challenge). */
async function ladderOrderOf(ctx: Parameters<Scenario["run"]>[0], divisionId: string, stageId: string): Promise<string[]> {
  const listed = (await ctx.driver.listStages(divisionId)).find((s) => s.id === stageId)?.config.ladder_order;
  return Array.isArray(listed) ? listed.filter((x): x is string => typeof x === "string") : [];
}

export const r4Withdrawal: Scenario = {
  key: "R4",
  entrantCount: ENTRANTS,
  canaryCheck: "r4-cascade-consistent",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "R4"));
    const seed3 = setup.idOfSeed(3);
    const family = familyOf(setup.stage.kind);
    let withdrawal: WithdrawalObs | null = null;
    let heldAt = -1;
    // D12: the withdrawal hook runs on stage 1 only (playDivision).
    const plays = await playDivision(ctx, rec, setup, {
      afterRound: async (round, batch) => {
        if (withdrawal !== null || !R4_TRIGGER[family](round, batch, seed3)) return;
        const before = (await ctx.driver.listFixtures(setup.division.id))
          .filter((f) => f.stage_id === setup.stage.id && (f.home_entrant_id === seed3 || f.away_entrant_id === seed3))
          .map((f) => snap({ id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome), declared: null }));
        const out = await ctx.driver.withdraw(seed3);
        rec.facts.add("withdrawn");
        rec.withdrawn.add(seed3);
        if (out.policy === "expunge") rec.facts.add("expunged");
        withdrawal = { entrantId: seed3, afterRound: round, policy: out.policy, walkovers: out.walkovers, voided: out.voided, skippedFinalized: out.skipped_finalized, before };
        if (family === "ladder") heldAt = (await ladderOrderOf(ctx, setup.division.id, setup.stage.id)).indexOf(seed3);
      },
    });
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal });
    const w = withdrawal as WithdrawalObs | null;
    if (w === null) {
      return {
        observed,
        events: rec.events,
        notes: rec.notes,
        assertions: [
          builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed),
          assertion("r4-policy-reported", [{ ok: false, note: family === "ladder" ? "no challenge seated seed 3; nobody withdrew" : "round 1 never finished; nobody withdrew" }]),
          stageCompleted(observed), loopBounded(rec, observed), advanceSeededAsDeclared(plays, observed, rec.withdrawn), lineupsPut(rec, setup),
        ],
      };
    }
    const kind = setup.stage.kind;
    // Ruling 53 / review m-4: the W7 note is written AFTER the snapshot, from the finalRanks the product actually minted —
    // what was seen, never a finalRanks fact claimed at withdrawal time. Recorded, never asserted.
    if (family === "ladder") rec.notes.push(`${ladderRanksNote(observed.stages[0].complete, w.entrantId, heldAt)} — ${LADDER_RANKS_ROUTE.wave} rulebook question`);
    const mine = observed.stages[0].fixtures.filter((f) => f.home === w.entrantId || f.away === w.entrantId);
    // Canary: ALSO judge the cascade against the OPPOSITE policy (m-1).
    const opposite = w.policy === "walkover" ? "expunge" : "walkover";
    const later = observed.stages[0].fixtures.filter((f) => (f.roundNo ?? 0) > w.afterRound && f.home !== null && f.away !== null);
    // Ruling 53: on a ladder the policy is the open-format rule over what was pending; the canary also judges the other one.
    const want = expectedPolicy(w.before);
    const policyItems: Item[] = family === "ladder"
      ? withCanary(
        [{ ok: w.policy === want, note: `policy ${w.policy}, expected ${want} (${w.before.filter((b) => PENDING_STATUSES.includes(b.status)).length} pending at withdrawal; withdrawal.ts open-format rule)` }],
        [{ ok: w.policy === (want === "none" ? "walkover" : "none"), note: `policy ${w.policy}, expected ${want === "none" ? "walkover" : "none"}` }],
        ctx.spec.canary,
      )
      : [{ ok: w.policy !== "none", note: `policy ${w.policy} on a started division` }];
    const challenged = family === "ladder"
      ? notChallengedLater({
        kind, seed3: w.entrantId, heldAt,
        raw: await ladderOrderOf(ctx, setup.division.id, setup.stage.id),
        departed: new Set((await ctx.driver.listEntrants(setup.division.id)).filter((e) => DEPARTED_STATUSES.includes(e.status)).map((e) => e.id)),
        later: rec.ladderSteps.filter((s) => s.step > w.afterRound).map((s) => observed.stages[0].fixtures.find((f) => f.id === s.fixtureId) ?? s.fixtureId),
      })
      : notChallengedLater({ kind, seed3: w.entrantId, heldAt, raw: [], departed: new Set(), later: [] });
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("r4-policy-reported", policyItems),
        assertion("r4-cascade-consistent", withCanary(
          [...cascadeItems(w.policy, w.entrantId, w.before, mine, w.walkovers, w.voided, kind), skippedItem(w.policy, w.before, w.skippedFinalized)],
          [...cascadeItems(opposite, w.entrantId, w.before, mine, w.walkovers, w.voided, kind), skippedItem(opposite, w.before, w.skippedFinalized)],
          ctx.spec.canary,
        )),
        assertion("r4-not-paired-later",
          later.map((f) => ({ ok: f.home !== w.entrantId && f.away !== w.entrantId, note: `${f.id} (round ${f.roundNo}) seats the withdrawn entrant` })),
          setup.stage.kind === "swiss" ? null : "not a swiss stage"),
        challenged,
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
