// The golden floor (GF-1, owner ruling 2026-10-15) — what EVERY sport's corpus must hold before the epoch guard can
// be trusted on it.
//
// WHY. `scripts/fold-epoch-guard.ts` compares corpora, so it is exactly as wide as they are: a fold change that moves
// no recorded stream owes no bump and gets none. The corpora were frozen from each module's own generator, which
// never emits `core.void`, `core.note`, `core.finalize`, `core.award`, `core.suspend`, `core.resume`, `core.settle` or
// a `core.lineup.*` event, and never draws a `withdrew` forfeit or a double walkover outside chess. Undo (`core.void`)
// is the commonest thing a phone writes, and a change to how it folds moved no golden in any sport
// (reviews/1e.md, M2). The floor makes those paths a CHECKED requirement instead of an accident of the generator.
//
// WHAT THE FLOOR IS. For one sport, two sets of tokens, both DERIVED from the engine's own declarations:
//
//  1. `event:<type>` — every `core.*` type the kernel accepts (`CORE_EVENT_SCHEMAS`: the keys, not a table typed
//     here). Minus the explicit, reasoned, staleness-checked `FLOOR_EXEMPTIONS`, and minus the lineup types the sport's
//     own policy refuses in EVERY declared config (`planLineupEvents` asks the real reducer; a refusal is a named
//     reason, not an exemption row).
//  2. `outcome:<token>` — every outcome the sport's module can produce:
//       - `win`, always: a sport that cannot decide a match is not one;
//       - `draw` iff `module.supportsDraws` says so for a draw-kind stage in some recorded config (`DRAW_KINDS`);
//       - `award:<reason>` for each of `FORFEIT_REASONS`, and `double_walkover`, iff `forfeitAdmission` (the kernel's
//         own phase guard) admits it in a state the module's own generator reaches;
//       - `tie` / `no_result` from `NATURAL_OUTCOMES`: NO module declares which outcome kinds it can produce
//         (`OUTCOME_KINDS` is the global six; the review's premise that a per-module union exists is false), so these
//         two are a reasoned per-sport list. `unrequiredObservedOutcomes` is its staleness check in the direction that
//         matters: a bounded sweep of the module's own generator must not reach a token the floor does not require.
//
//  3. `overlay:<fact>:set|cleared` (GF-2 T3) — the kernel facts the format-2 corpus records beside module state (stoppage,
//     squads, settlement, expunged, levelWithdrawal: the keys of the fold result, read off a real fold), each seen LEAVING its
//     kernel default and, where an undo reopens it, coming back. `core.settle` is required like any other kernel event: the
//     exemption it held until GF-2 is retired (the harness now records the effective outcome).
//  4. `stats:award:<key>` (GF-2 T4) — for each award key the sport DECLARES in `playerStats.awards` (football `motm`, hockey `potm`,
//     icehockey `mvp`; the other eight declare none), a `core.award` naming it, credited as `<key>_awards` in the format-3 corpus's
//     recorded final player-stats rows. A sport that declares no award key has nothing to credit and no such token.
//
// WHAT IT IS NOT. It is a presence check: it says a corpus RECORDS a path, not that the guard would SEE a change to it. That is
// the "recorded, overlay unpinned" class below, probed by ablation against the real format-3 recorder.
//
// Purity: this file reads corpora through `golden.ts` (node:fs), so it stays out of the published testkit barrel.
import { CORE_EVENT_SCHEMAS, forfeitAdmission, foldMatch, foldMatchWithStoppage, outcomeOf, playRecorded, summaryOf, type EventEnvelope } from "../core/events.ts";
import {
  DEFAULT_LINEUP_POLICY,
  initSquads,
  reduceLineupEvent,
  type LineupPolicy,
  type SquadState,
} from "../core/lineup.ts";
import { DRAW_KINDS, FORFEIT_REASONS, OUTCOME_KINDS, isLevelOutcome, type LineupPair, type LineupSlot, type MatchOutcome } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { corpusFormat, recomputeStream, textDigest, type GoldenCorpus, type GoldenEvent, type Recomputed } from "./golden.ts";
import { FOLD_OVERLAY_KEYS, OVERLAY_COLUMNS, overlayTransitions } from "./golden-overlay.ts";
import { awardStatKey, creditedAwardKeys } from "./golden-stats.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

// ------------------------------------------------------------------------------------------------------------ tokens

/** `event:core.void`, `outcome:award:retired`, `outcome:double_walkover`, `undo:core.forfeit`, `standing:core.abandon`,
 *  `overlay:settlement:set`, `stats:award:motm`. */
export type FloorToken = `event:${string}` | `outcome:${string}` | `undo:${string}` | `standing:${string}` | `overlay:${string}` | `stats:${string}`;

/** Every `core.*` type the kernel accepts — the keys of its own schema map. */
export const CORE_TYPES: readonly string[] = Object.keys(CORE_EVENT_SCHEMAS);

export const eventToken = (type: string): FloorToken => `event:${type}`;
export const outcomeToken = (token: string): FloorToken => `outcome:${token}`;
/** A `core.void` keyed by the TYPE of the event it strikes: an undo of a goal and an undo of a forfeit are different folds. */
export const undoToken = (type: string): FloorToken => `undo:${type}`;

/** The kernel events that DECIDE or END a match — a mis-tapped forfeit, abandon or settle is the undo a phone needs most, and
 *  voiding one must REOPEN the match (the decided flag, the walkover credit, the stoppage and the settlement it set all clear).
 *  All three are required of every sport: the kernel owns them, and `forfeitAdmission` / the abandon path / `settleApplies`
 *  admit them everywhere (GF-2 T3 added the settle: its undo is the only thing that clears the settlement beside module state). */
export const UNDOABLE_KERNEL: readonly string[] = ["core.forfeit", "core.abandon", "core.settle"];

/** An event a stream records and NOTHING strikes. An abandon that stands leaves a match ended with no outcome (the fixture
 *  awaits a settle or a replay), which is a different fold from an abandon that was voided and played on; a corpus that
 *  only ever struck its abandons would never record the first. */
export const standingToken = (type: string): FloorToken => `standing:${type}`;
export const STANDING_KERNEL: readonly string[] = ["core.abandon"];

/** A kernel fact the recorded overlay moved: `overlay:settlement:set` (it left its kernel default) or `overlay:settlement:cleared`
 *  (it came back, i.e. an undo reopened what the fact had closed). Read off a stream's `overlay` alone (`overlayTransitions`). */
export type OverlayTransition = "set" | "cleared";
export const overlayToken = (fact: string, transition: OverlayTransition): FloorToken => `overlay:${fact}:${transition}`;

/** A `core.award` the player-stats rows CREDITED: `stats:award:motm` is held when some stream's recorded `playerStats` has a person
 *  with `motm_awards` of 1 or more (GF-2 T4). Required only for the keys the sport's own `playerStats.awards` DECLARES: an award
 *  the sport does not declare credits nobody (the fold ignores it), so there is nothing for the corpus to pin. */
export const statsAwardToken = (key: string): FloorToken => `stats:award:${key}`;

/** The outcome kinds that are LEVEL (`draw`, `tie`, `no_result`): the kernel's own `isLevelOutcome` asked of each kind it
 *  declares (`OUTCOME_KINDS`), never a list typed here. A withdrawal can be laid over a held level result only. */
export const LEVEL_OUTCOME_TOKENS: readonly string[] = OUTCOME_KINDS.filter((kind) => isLevelOutcome({ kind } as MatchOutcome));

/** The outcome token a recorded `outcome` field names, or null while the stream recorded no outcome. An award is
 *  keyed by its REASON (`award:walkover`): the reason is what the sport's `forfeitCredit` and the table react to. */
export function outcomeTokenOf(outcomeJson: string): string | null {
  const o: unknown = JSON.parse(outcomeJson);
  if (o === null) return null;
  const rec = o as { kind?: unknown; reason?: unknown };
  if (typeof rec.kind !== "string") throw new Error(`golden floor: a recorded outcome without a kind: ${outcomeJson}`);
  if (rec.kind !== "award") return rec.kind;
  if (typeof rec.reason !== "string") throw new Error(`golden floor: a recorded award without a reason: ${outcomeJson}`);
  return `award:${rec.reason}`;
}

/** Every token the corpus holds: each event type any stream records and each outcome any stream ends on. */
export function recordedTokens(corpus: GoldenCorpus): Set<FloorToken> {
  const out = new Set<FloorToken>();
  for (const stream of corpus.streams) {
    const struck = new Set(stream.events.flatMap((e) => (e.type === "core.void" && e.voids !== undefined ? [e.voids] : [])));
    stream.events.forEach((event, i) => {
      if (event.type.startsWith("core.")) out.add(eventToken(event.type));
      if (STANDING_KERNEL.includes(event.type) && !struck.has(`e-${i}`)) out.add(standingToken(event.type));
      if (event.type !== "core.void") return;
      // A recorded void the fold would refuse is a corrupt corpus, not a token: name it.
      const where = `${stream.config}#${stream.seed}`;
      if (event.voids === undefined) throw new Error(`golden floor: a core.void in stream ${where} (event ${i}) has no target`);
      const target = /^e-(\d+)$/.exec(event.voids)?.[1];
      const index = target === undefined ? -1 : Number(target);
      if (index < 0 || index >= i) throw new Error(`golden floor: a core.void in stream ${where} (event ${i}) targets "${event.voids}", which is not an earlier event`);
      out.add(undoToken(stream.events[index]!.type));
    });
    const token = outcomeTokenOf(stream.outcome);
    if (token !== null) out.add(outcomeToken(token));
    // A format-2 stream records the kernel overlay; a format-1 stream (no `overlay`) records none, and so holds no overlay token.
    if (stream.overlay !== undefined) {
      for (const [fact, moved] of overlayTransitions(stream.overlay)) {
        if (moved.set) out.add(overlayToken(fact, "set"));
        if (moved.cleared) out.add(overlayToken(fact, "cleared"));
      }
    }
    // A format-3 stream records the final player-stats rows; an earlier format records none, and so holds no stats token.
    if (stream.playerStats !== undefined) for (const key of creditedAwardKeys(stream.playerStats)) out.add(statsAwardToken(key));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------- lineups

/** Bench persons a floor lineup stream names on each side. Three is the smallest that lets a squad of ONE (every
 *  singles sport) take a position change, a substitution, an exempt replacement, a retirement and an entry in turn. */
export const FLOOR_BENCH = 3;

/** The catalog-valid starting pair plus a bench, so a lineup event has someone to bring on. The starters are exactly
 *  `defaultLineupPair`'s (ids `H-p1..`), so `init` is what every other stream of the corpus folds from. */
export function benchPair(module: AnySportModule, cfg: unknown, size: number = FLOOR_BENCH): LineupPair {
  const base = defaultLineupPair(resolvePositions(module, cfg));
  const withBench = (lineup: LineupPair["home"]): LineupPair["home"] => ({
    ...lineup,
    slots: [
      ...lineup.slots,
      ...Array.from({ length: size }, (_, i): LineupSlot => ({
        personId: `${lineup.entrantId}-b${i + 1}`,
        slot: "bench",
        orderNo: lineup.slots.length + i + 1,
      })),
    ],
  });
  return { home: withBench(base.home), away: withBench(base.away) };
}

/** The order a match plausibly produces lineup changes in: each depends on the squad the earlier ones left (a squad of
 *  ONE takes a position change, then a substitution that puts a bench player on, then an exempt replacement OF that
 *  player, ...). A planner exists for each; `lineupTypesOf` ties this list to the kernel's own declaration. */
const LINEUP_PLAN_ORDER = [
  "core.lineup.position",
  "core.lineup.substitution",
  "core.lineup.replacement",
  "core.lineup.retirement",
  "core.lineup.entry",
] as const;

/** The lineup types the floor plans, in plan order — and ONLY if they are exactly the `core.lineup.*` types the kernel
 *  declares. A type the kernel gained with no planner here, or a planner for a type it dropped, is a named failure: the
 *  list is an ORDER, not a vocabulary, and the vocabulary is `CORE_EVENT_SCHEMAS`. */
export function lineupTypesOf(coreTypes: readonly string[] = CORE_TYPES): string[] {
  const declared = coreTypes.filter((t) => t.startsWith("core.lineup."));
  const planned: readonly string[] = LINEUP_PLAN_ORDER;
  const unplanned = declared.filter((t) => !planned.includes(t));
  if (unplanned.length > 0) {
    throw new Error(`golden floor: the kernel declares ${unplanned.join(", ")} and golden-floor.ts has no planner for it: add one to LINEUP_PLAN_ORDER / ATTEMPTS`);
  }
  const retired = planned.filter((t) => !declared.includes(t));
  if (retired.length > 0) {
    throw new Error(`golden floor: golden-floor.ts plans ${retired.join(", ")} but the kernel no longer declares it: remove its planner`);
  }
  return [...planned];
}

/** The five lineup types — derived from, and checked against, the kernel's own declaration at import. */
export const LINEUP_TYPES: readonly string[] = lineupTypesOf();

export interface LineupPlan {
  /** The accepted events, in order, ready to append (home side). */
  readonly events: GoldenEvent[];
  /** Types the real reducer accepted under this policy. */
  readonly accepted: string[];
  /** Types it refused, with the reducer's own reason code — or `no-candidate` when the plan never got to ask. */
  readonly refused: Record<string, string>;
}

/** What a planner may read: the squad as it stands, the policy, and the helpers that name a person's slot. */
interface PlanCtx {
  readonly side: string;
  readonly lineups: LineupPair;
  readonly policy: LineupPolicy;
  readonly exemption: string | undefined;
  readonly fields: readonly { personId: string; positionKey?: string }[];
  readonly benched: readonly { personId: string; positionKey?: string }[];
  slotOf(personId: string, positionKey?: string, roles?: readonly string[]): LineupSlot;
}
type Attempt = { payload: Record<string, unknown> };

/** One candidate payload list per lineup type — a `Record` keyed by the plan order, so a type with no entry here does not
 *  compile, and there is no `else` for a new type to fall into silently. */
const ATTEMPTS: Readonly<Record<(typeof LINEUP_PLAN_ORDER)[number], (c: PlanCtx) => Attempt[]>> = {
  "core.lineup.position": (c) => {
    const groups = resolveGroupKeys(c.lineups);
    return c.fields.map((m) => {
      const other = groups.find((g) => g !== m.positionKey) ?? `${m.positionKey ?? "pos"}-alt`;
      return { payload: { side: c.side, personId: m.personId, positionKey: other } };
    });
  },
  "core.lineup.substitution": (c) => substitutionAttempts(c, false),
  "core.lineup.replacement": (c) => substitutionAttempts(c, true),
  "core.lineup.retirement": (c) => [...c.fields].reverse().map((m) => ({ payload: { side: c.side, personId: m.personId, reason: "retired hurt" } })),
  "core.lineup.entry": (c) => c.benched.map((on) => ({ payload: { side: c.side, on: c.slotOf(on.personId) } })),
};

function substitutionAttempts(c: PlanCtx, replacement: boolean): Attempt[] {
  const required = c.exemption === undefined ? undefined : c.policy.exemptions?.[c.exemption]?.requiresRole;
  const out: Attempt[] = [];
  for (const off of [...c.fields].reverse()) {
    for (const on of c.benched) {
      out.push({
        payload: {
          side: c.side,
          off: off.personId,
          on: c.slotOf(on.personId, off.positionKey, replacement && required !== undefined ? [required] : undefined),
          ...(replacement ? { exemption: c.exemption, reason: "injury" } : {}),
        },
      });
    }
  }
  return out;
}

/** One home-side lineup event of each type, chosen against the squad AS IT STANDS and checked by the real reducer
 *  (`reduceLineupEvent`, strict policy), so a type the policy refuses is named with the reducer's reason instead of
 *  being assumed impossible. The chain evolves the squads event by event. */
export function planLineupEvents(lineups: LineupPair, policy: LineupPolicy, coreTypes: readonly string[] = CORE_TYPES): LineupPlan {
  const types = lineupTypesOf(coreTypes);
  const side = lineups.home.entrantId;
  let squads: SquadState = initSquads(lineups);
  const events: GoldenEvent[] = [];
  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  const exemption = Object.keys(policy.exemptions ?? {})[0];

  const members = () => squads.home.members.filter((m) => m.role === "player");
  const slotOf = (personId: string, positionKey?: string, roles?: readonly string[]): LineupSlot => {
    const named = lineups.home.slots.find((s) => s.personId === personId);
    const position = positionKey ?? named?.positionKey;
    return {
      personId,
      slot: "starting",
      orderNo: named?.orderNo ?? members().length + 1,
      ...(position === undefined ? {} : { positionKey: position }),
      ...(roles === undefined ? {} : { roles: [...roles] }),
    };
  };

  for (const type of types) {
    if (type === "core.lineup.replacement" && exemption === undefined) {
      refused[type] = "exemption-not-declared";
      continue;
    }
    const ctx: PlanCtx = {
      side,
      lineups,
      policy,
      exemption,
      fields: members().filter((m) => m.onField),
      benched: members().filter((m) => !m.onField && m.timesOff === 0 && !m.started),
      slotOf,
    };
    const attempts = ATTEMPTS[type as (typeof LINEUP_PLAN_ORDER)[number]](ctx);

    let last = "no-candidate";
    let placed = false;
    for (const { payload } of attempts) {
      const result = reduceLineupEvent(squads, { type, payload }, policy);
      if (result.ok) {
        squads = result.squads;
        events.push({ type, payload });
        accepted.push(type);
        placed = true;
        break;
      }
      last = result.reason;
    }
    if (!placed) refused[type] = last;
  }
  return { events, accepted, refused };
}

function resolveGroupKeys(lineups: LineupPair): string[] {
  return [...new Set(lineups.home.slots.map((s) => s.positionKey).filter((k): k is string => k !== undefined))];
}

export interface LineupOffer {
  readonly cfgName: string;
  readonly lineups: LineupPair;
  readonly plan: LineupPlan;
}

/** For each config the corpus records: the bench pair, and what the sport's own policy lets that config do. */
export function lineupOffers(module: AnySportModule, corpus: GoldenCorpus, coreTypes: readonly string[] = CORE_TYPES): LineupOffer[] {
  return Object.entries(corpus.configs).map(([cfgName, raw]) => {
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = benchPair(module, cfg);
    const policy = module.lineupPolicy?.(cfg) ?? DEFAULT_LINEUP_POLICY;
    return { cfgName, lineups, plan: planLineupEvents(lineups, policy, coreTypes) };
  });
}

// ----------------------------------------------------------------------------------------------- outcome derivation

/** How many generator seeds per recorded config the admission sweep walks. The admission of a forfeit reason depends on
 *  the PHASE a state is in, not on the score, so a handful of walks reaches every phase a module has. */
export const ADMISSION_SEEDS = 4;
/** How many generator seeds per config the completeness sweep walks (`unrequiredObservedOutcomes`).
 *
 *  LIMIT, stated: 40 walks reach an outcome that turns up at least about once in forty. They do NOT reach a rare one —
 *  cricket's `tie` first appears around generator seed 460 (the `stoppage` scenario searches `SEED_BUDGET` = 3000 seeds
 *  for it). So an undeclared rare outcome of a sport is invisible to this direction of the check; the rare outcomes a
 *  sport CAN produce are the ones `NATURAL_OUTCOMES` declares by hand, and the opposite direction
 *  (`staleNaturalOutcomes`: a declared token no corpus records) is what keeps that table honest. A per-sport seed count
 *  was considered and declined: it would cost minutes of fold per sport to find a ~1-in-500 outcome that nothing
 *  suggests exists beyond cricket's, and a bound anyone can raise is no more honest than one stated here. */
export const OBSERVE_SEEDS = 40;
const WALK_EVENTS = 120;

export interface Admission {
  /** reason -> the first state in which the kernel's phase guard admits it. */
  readonly reasons: ReadonlyMap<string, string>;
  /** where a double walkover is admitted, or null. */
  readonly both: string | null;
  /** states the guard was asked about. */
  readonly states: number;
}

/** What the kernel's phase guard (`forfeitAdmission`, the function the console's forfeit dialog uses) admits in the
 *  states the module's OWN generator reaches. Not typed here: the sport answers. */
export function forfeitAdmissions(module: AnySportModule, corpus: GoldenCorpus): Admission {
  const reasons = new Map<string, string>();
  let both: string | null = null;
  let states = 0;
  for (const [name, raw] of Object.entries(corpus.configs)) {
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (let seed = 1; seed <= ADMISSION_SEEDS; seed++) {
      let walk;
      try {
        walk = buildWalk(module, cfg, lineups, seed, 60);
      } catch {
        continue;
      }
      const init: unknown = module.init(cfg, lineups);
      for (let i = 0; i <= walk.events.length; i++) {
        const state: unknown = i === 0 ? init : walk.states[i - 1];
        const played = playRecorded(walk.events.slice(0, i), module);
        const verdict = forfeitAdmission(module as never, state as never, { playRecorded: played });
        states++;
        const where = `${name}:${seed} after ${i} event(s), phase ${verdict.phase}${played ? ", play recorded" : ""}`;
        for (const reason of verdict.reasons) if (!reasons.has(reason)) reasons.set(reason, where);
        if (verdict.both && both === null) both = where;
      }
    }
  }
  return { reasons, both, states };
}

/** `tie` and `no_result` are produced by branches of a module's `apply`; no declaration lists them (the review's "module's
 *  declared outcome union" does not exist — `OUTCOME_KINDS` is the global six). So they are a reasoned per-sport list, and
 *  the list is checked both ways: a listed token must be recorded (it is in the floor), and no sport may REACH one that
 *  is not listed (`unrequiredObservedOutcomes`). */
export const NATURAL_OUTCOMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cricket: {
    tie: "limited-overs scores level after both innings and no super over to follow: cricket.ts settles `tie`, a kind distinct from `draw` (core/types.ts MatchOutcome)",
    no_result: "a match that cannot reach its minimum overs, or is abandoned without a result: cricket.ts settles `no_result`",
  },
};

// ---------------------------------------------------------------------------------------------------- exemptions

/** The harness function that turns a recorded ledger into a stream's recorded half. Injectable so a probe can be shown to answer
 *  both ways: under `kernelRecorder` (the real format-2 recording) and under `moduleRecorder` (what the harness recorded before). */
export type Recorder = (module: AnySportModule, rawConfig: unknown, events: readonly GoldenEvent[], lineups?: LineupPair) => Recomputed;

/** The floor's recorder since GF-2 T3: the REAL format-2 recording (the effective outcome, a digest of the summary after every
 *  event, the kernel overlay as change points, and the dense per-step overlay a probe compares). Every probe below defaults to it,
 *  because the corpora are format 2 and a probe that asked a narrower question than the corpus records would answer "unpinned"
 *  for what the guard now compares. */
export const kernelRecorder: Recorder = (module, rawConfig, events, lineups) => recomputeStream(module, rawConfig, events, lineups, 2);

/** The floor's recorder since GF-2 T4: the REAL format-3 recording, the format-2 one plus the final player-stats rows. A probe
 *  defaults to it because the corpora are format 3, and a probe that asked a narrower question than the corpus records would
 *  answer "unpinned" for what the guard now compares (an award, until this recorder, moved no recorded field). `kernelRecorder`
 *  stays, explicit, as the CONTROL of that retirement: the same probe is unpinned under it. */
export const statsRecorder: Recorder = (module, rawConfig, events, lineups) => recomputeStream(module, rawConfig, events, lineups, 3);

/** The MODULE-ONLY recorder (corpus format 1): what the harness recorded before GF-2. Kept, explicit, as the CONTROL of every
 *  retirement: the same probe that answers "pinned" under `kernelRecorder` answers "unpinned" under this one, which is what shows
 *  the claim it retired was true before and is false now (a probe that could only ever answer one way would prove nothing). */
export const moduleRecorder: Recorder = (module, rawConfig, events, lineups) => recomputeStream(module, rawConfig, events, lineups, 1);

export interface FloorExemption {
  readonly token: FloorToken;
  /** `"all"`, or the sports the exemption covers. */
  readonly sports: "all" | readonly string[];
  readonly reason: string;
  /** null while the exemption still holds for this sport; otherwise WHY it has gone stale. */
  stale(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder): string | null;
}

/** The exemption table, EMPTY since GF-2 T3. It held one row, `core.settle` (all sports): the harness recorded `module.outcome(state)`,
 *  a settlement lives BESIDE module state (`outcomeOf` lays it over), so a settle stream would have recorded the module's bare
 *  answer while the effective outcome is a win, a value wrong the moment it is written. Format 2 records the effective outcome, so
 *  `settleProbe` now reads recorded === effective in every sport: the row went stale, which is what its `stale()` was written to
 *  announce, and it is deleted (golden-floor.test.ts holds the flip: the same probe under `moduleRecorder` still differs).
 *  The mechanism stays for the next reasoned exemption; a row owes a reason and a `stale()` that turns it into a failure. */
export const FLOOR_EXEMPTIONS: readonly FloorExemption[] = [];

/** The recorded outcome of [start, abandon, settle] against the outcome the kernel reads from the same ledger. Under the module-only
 *  recorder they differ (the old exemption's reason); under the format-2 recorder they are the same settled win. */
export function settleProbe(module: AnySportModule, corpus: GoldenCorpus, record: Recorder = kernelRecorder): { recorded: string; effective: string } | string {
  const [name, raw] = Object.entries(corpus.configs)[0] ?? [];
  if (name === undefined) return "the corpus records no config";
  const cfg = module.configSchema.parse(raw) as unknown;
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const events: GoldenEvent[] = [
    { type: "core.start", payload: {} },
    { type: "core.abandon", payload: { reason: "floodlight failure" } },
    { type: "core.settle", payload: { winner: lineups.home.entrantId, method: "organiser" } },
  ];
  try {
    const recorded = record(module, raw, events, lineups).outcome;
    const envelopes: EventEnvelope[] = events.map((e, i) => makeEnvelope(i, e));
    const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, envelopes, { strictFromSeq: 0 });
    return { recorded, effective: JSON.stringify(outcomeOf(module as never, folded as never) ?? null) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const exemptionApplies = (e: FloorExemption, sport: string): boolean => e.sports === "all" || e.sports.includes(sport);

// -------------------------------------------------------------------------------------- recorded, overlay unpinned
//
// The floor is a PRESENCE check: a corpus that records `core.note` satisfies it. It does not follow that the epoch guard can see
// a change to how a note folds, because an event a module folds as `return state` can sit in a stream and move nothing the guard
// compares. That is a class, not a gap to hide: each CLAIM below says which events are inert and why, the inertness is DERIVED by
// ablation (remove the event, compare every recorded field), and a claim whose ablation starts finding movement is stale.
//
// Before GF-2 the class held every kernel-owned event as well (a pause: the stoppage clock lives in the overlay; a lineup change
// a module does not read: the squads live in the overlay), because the harness recorded the module's answers only. Format 2
// records the overlay and the summary after every event, so `ablationProbe` compares those too, and both classes flipped under
// the real recorder: `stoppage` (all eleven sports) and `lineup` (boardgame, carrom, generic, and football's position change) are
// retired. GF-2 T4 recorded the final player-stats rows (format 3) and the award class split along the sport's own declaration:
// a sport that declares an award key credits it in those rows, so there the event is pinned (football `motm`, hockey `potm`,
// icehockey `mvp`); the eight sports that declare none ignore it, and an award stays unpinned there. What is left is what no
// recorded fact depends on: a note everywhere, and an award where the sport declares no key for it.

export type OverlayVerdict = "unpinned" | "pinned" | "unrecorded";

export interface OverlayResult {
  readonly verdict: OverlayVerdict;
  /** Recorded streams that carry the event, i.e. were ablated. */
  readonly streams: number;
  /** Of those, how many changed a recorded field (a state, the outcome, the summary or the deltas) when it was removed. */
  readonly moved: number;
  /** Of those, how many the kernel REFUSED once it was removed (its absence is load-bearing for admission). */
  readonly refused: number;
}

export interface OverlayClaim {
  readonly id: string;
  /** The events claimed unpinned, in plan order. */
  readonly tokens: readonly FloorToken[];
  /** `together`: the tokens are removed as one (a pause is a suspend AND its resume). `chain`: token k is judged by what
   *  it adds to the tokens planned before it, i.e. the ledger without tokens k.. against the one without k+1.. (a lineup
   *  change depends on the squad the earlier ones left, so it cannot be removed alone). */
  readonly mode: "together" | "chain";
  /** Where the class is ASSERTED, from the module's OWN declaration (not a list typed here): the probe must agree there, or
   *  the claim is stale (`staleOverlayClaims`). A module with no `onLineup` is never shown a lineup change. */
  assertedFor(module: AnySportModule): boolean;
  /** Whether the class COVERS a sport x token, given what the probe found. This is what the policy's list of manual bumps
   *  stands for, and it is derived from the VERDICT, not from the declaration: a module that declares `onLineup` can still
   *  ignore one lineup type (football's position change moves nothing it reads), and a declaration-only rule left that
   *  token unlisted while the policy said otherwise (review N1). */
  covers(module: AnySportModule, token: FloorToken, verdict: OverlayVerdict): boolean;
  readonly reason: string;
}

const coversWhenUnpinned: OverlayClaim["covers"] = (_module, _token, verdict) => verdict === "unpinned";

export const OVERLAY_CLAIMS: readonly OverlayClaim[] = [
  {
    id: "note",
    tokens: [eventToken("core.note")],
    mode: "together",
    assertedFor: () => true,
    covers: coversWhenUnpinned,
    reason:
      "a free-text annotation: it reaches module.apply but every module folds it as `return state`, so every recorded field (the " +
      "states, the effective outcome, the summary and its digest after each event, the deltas, the kernel overlay) is identical with " +
      "or without it: nothing computes from a note",
  },
  {
    id: "award",
    tokens: [eventToken("core.award")],
    mode: "together",
    // from the module's OWN declaration (`playerStats.awards`), like the lineup claim read `onLineup`: a sport that declares an award key
    // credits it in the player-stats rows, which format 3 records, so there the event is pinned (a claim that cannot hold is stale)
    assertedFor: (module) => (module.playerStats?.awards ?? []).length === 0,
    covers: coversWhenUnpinned,
    reason:
      "an award this sport declares no key for: it reaches module.apply but every module folds it as `return state`, so every recorded " +
      "field is identical with or without it, and the player-statistics fold ignores a key the sport's playerStats.awards does not " +
      "declare, so no stat row moves either. A sport that DECLARES an award key is not in this class: format 3 records the rows, " +
      "an award there adds `<key>_awards` to a person, and the golden floor requires one (`stats:award:<key>`)",
  },
];

/** Probed beside the claims as CONTROLS: events the modules fold into the state the corpora record (a finalize closes the
 *  phase, an abandon ends play, a forfeit decides), and so are NOT claimed unpinned. A probe that could only ever answer
 *  "unpinned" would show here. */
export const OVERLAY_CONTROLS: readonly FloorToken[] = ["core.finalize", "core.abandon", "core.forfeit"].map(eventToken);

export interface Ablation {
  readonly kept: GoldenEvent[];
  /** Where each kept event stood in the ledger that was ablated (`origin[i]` is the original index of `kept[i]`). */
  readonly origin: number[];
}

/** The ledger without every event whose type is in `remove`, AND without every void that struck one of them (a void of an event
 *  that is not there strikes nothing, and what it struck is exactly what is being asked about), the surviving `voids` ids renumbered
 *  to where their targets now sit. GF-1 refused such a ledger; the settle story (GF-2 T3) strikes the only settle a sport's
 *  corpus records before saying it again, so refusing would leave `core.settle` unprobeable, and a verdict of "unrecorded" over a
 *  recorded event is the blind spot this probe exists to close. */
export function ablateEvents(events: readonly GoldenEvent[], remove: ReadonlySet<string>): Ablation {
  const gone = new Set<number>();
  events.forEach((event, i) => {
    if (remove.has(event.type)) gone.add(i);
  });
  // a void sits after its target, so one forward pass settles a void of a void as well
  events.forEach((event, i) => {
    if (event.voids !== undefined && gone.has(Number(event.voids.slice(2)))) gone.add(i);
  });
  const place = new Map<number, number>();
  let next = 0;
  events.forEach((_, i) => {
    if (!gone.has(i)) place.set(i, next++);
  });
  const kept: GoldenEvent[] = [];
  const origin: number[] = [];
  events.forEach((event, i) => {
    if (gone.has(i)) return;
    origin.push(i);
    kept.push(event.voids === undefined ? event : { ...event, voids: `e-${place.get(Number(event.voids.slice(2)))}` });
  });
  return { kept, origin };
}

/** The recorded form of the state before any event: what the first event folds from. */
function initialState(module: AnySportModule, rawConfig: unknown, recordedLineups: LineupPair | undefined): string {
  const cfg = module.configSchema.parse(rawConfig) as unknown;
  const lineups = recordedLineups ?? defaultLineupPair(resolvePositions(module, cfg));
  return JSON.stringify(foldMatch(module as never, cfg as never, lineups, [], { strictFromSeq: 0 }));
}

/** The digest of the summary the pad shows BEFORE any event (step -1 of `summaries`). */
function initialSummary(module: AnySportModule, rawConfig: unknown, recordedLineups: LineupPair | undefined): string {
  const cfg = module.configSchema.parse(rawConfig) as unknown;
  const lineups = recordedLineups ?? defaultLineupPair(resolvePositions(module, cfg));
  return textDigest(JSON.stringify(summaryOf(module as never, foldMatchWithStoppage(module as never, cfg as never, lineups, [], { strictFromSeq: 0 }) as never) ?? null));
}

/** A recorded overlay value names the event that opened it (`stoppage.eventId`, `settlement.eventId`, `levelWithdrawal.eventId`:
 *  `e-<index in THIS ledger>`). Two ledgers that differ by an ablated event number the same event differently, so a comparison
 *  maps each id to where the event sits in the other ledger first; an id whose event is gone is left, and so reads as the
 *  difference it is. */
function renumberEventIds(value: string, place: ReadonlyMap<number, number>): string {
  return value.replace(/"eventId":"e-(\d+)"/g, (whole, index: string) => {
    const moved = place.get(Number(index));
    return moved === undefined ? whole : `"eventId":"e-${moved}"`;
  });
}

/** Whether removing `big \ small` from the ledger changes any recorded field, across every recorded stream that carries one
 *  of those events. Moved = a retained step's state differs, the outcome / summary / deltas differ, or an ablated event's OWN
 *  step already changed the state (a module that folds the event into state).
 *
 *  Under a format-2 recorder (the dense overlay and the summary digests are present) "every recorded field" is wider, and so is
 *  what the guard compares: the kernel overlay (outcome, stoppage, settlement, expunged, levelWithdrawal, decider, squads) and
 *  the summary digest, at every retained step, and the same two at an ablated event's own step against the step before it. A
 *  module-only recorder (format 1) has neither, and the comparison is the narrower one it always was. */
function ablationProbe(
  module: AnySportModule,
  corpus: GoldenCorpus,
  small: ReadonlySet<string>,
  big: ReadonlySet<string>,
  record: Recorder,
): OverlayResult {
  const extra = new Set([...big].filter((t) => !small.has(t)));
  let streams = 0;
  let moved = 0;
  let refused = 0;
  for (const stream of corpus.streams) {
    if (!stream.events.some((e) => extra.has(e.type))) continue;
    const near = ablateEvents(stream.events, small);
    const far = ablateEvents(stream.events, big);
    const raw = corpus.configs[stream.config];
    streams++;
    // The recorded ledger itself must fold: a recorder that cannot is the probe's failure, not evidence.
    const a = record(module, raw, near.kept, stream.lineups);
    let b;
    try {
      b = record(module, raw, far.kept, stream.lineups);
    } catch {
      refused++;
      continue;
    }
    // Where each event sits in each ledger: the pairs both keep, and the near steps that exist only because of what is ablated
    // (the events themselves, and the voids that struck them, which go with them).
    const farAt = new Map(far.origin.map((original, position) => [original, position] as const));
    const pairs = near.origin.flatMap((original, nearIndex) => (farAt.has(original) ? [[nearIndex, farAt.get(original)!] as const] : []));
    const gone = near.origin.map((original, nearIndex) => (farAt.has(original) ? -1 : nearIndex)).filter((i) => i >= 0);
    const ablated = gone.filter((i) => extra.has(near.kept[i]!.type));
    const sameSteps = JSON.stringify(pairs.map(([n]) => a.states[n])) === JSON.stringify(pairs.map(([, f]) => b.states[f]));
    // An ablated event's OWN step must leave the recorded state as it found it (the state before the first event is the
    // module's init). Without this a module that folds the event into state would read as inert whenever a later event
    // happened to overwrite what it wrote, or whenever nothing follows it. (A void that went with its target is not an
    // ablated event: its step re-folds the ledger without the target, which is the change under test.)
    const initial = ablated.includes(0) ? initialState(module, raw, stream.lineups) : null;
    const ownStepsNeutral = ablated.every((i) => a.states[i] === (i === 0 ? initial : a.states[i - 1]));
    let kernelSame = true;
    if (a.dense !== undefined && b.dense !== undefined) {
      const place = new Map(pairs);
      const denseA = a.dense;
      const denseB = b.dense;
      kernelSame = OVERLAY_COLUMNS.every((column) => {
        // (the far ledger's ids are its own, so the near ledger's are mapped onto them; at an own step nothing is renumbered)
        const atRetained = pairs.every(([n, f]) => renumberEventIds(denseA.steps[column][n]!, place) === denseB.steps[column][f]);
        const atOwn = ablated.every((i) => denseA.steps[column][i] === (i === 0 ? denseA.initial[column] : denseA.steps[column][i - 1]));
        return atRetained && atOwn;
      });
      if (a.summaries !== undefined && b.summaries !== undefined) {
        const summariesA = a.summaries;
        const summariesB = b.summaries;
        const initialSummaryDigest = ablated.includes(0) ? initialSummary(module, raw, stream.lineups) : null;
        kernelSame =
          kernelSame &&
          pairs.every(([n, f]) => summariesA[n] === summariesB[f]) &&
          ablated.every((i) => summariesA[i] === (i === 0 ? initialSummaryDigest : summariesA[i - 1]));
      }
    }
    // Format 3 also records the final player-stats rows: an event the stats fold reads (an award the sport declares) moves them.
    // Both sides come from ONE recorder, so a recorder that does not produce them (format 1 and 2) has `undefined` on both and the
    // comparison is the narrower one it was.
    const statsSame = a.playerStats === b.playerStats;
    if (!(sameSteps && ownStepsNeutral && kernelSame && statsSame && a.outcome === b.outcome && a.summary === b.summary && a.deltas === b.deltas)) moved++;
  }
  const verdict: OverlayVerdict = streams === 0 ? "unrecorded" : moved > 0 || refused > 0 ? "pinned" : "unpinned";
  return { verdict, streams, moved, refused };
}

/** For every event a claim names, and the controls: is it recorded, and does it move a recorded golden? With `scope: "all"`
 *  every OTHER core event the corpus records is probed too, one type at a time, so an unpinned event no claim names shows up
 *  (`uncoveredUnpinned`). */
export function overlayVerdicts(
  module: AnySportModule,
  corpus: GoldenCorpus,
  record: Recorder = statsRecorder,
  claims: readonly OverlayClaim[] = OVERLAY_CLAIMS,
  scope: "claims" | "all" = "claims",
): Map<FloorToken, OverlayResult> {
  const out = new Map<FloorToken, OverlayResult>();
  const typeOf = (token: FloorToken): string => token.slice("event:".length);
  for (const claim of claims) {
    const types = claim.tokens.map(typeOf);
    claim.tokens.forEach((token, k) => {
      const big = new Set(claim.mode === "chain" ? types.slice(k) : types);
      const small = new Set(claim.mode === "chain" ? types.slice(k + 1) : []);
      out.set(token, ablationProbe(module, corpus, small, big, record));
    });
  }
  const alone = (token: FloorToken) => ablationProbe(module, corpus, new Set(), new Set([typeOf(token)]), record);
  for (const token of OVERLAY_CONTROLS) if (!out.has(token)) out.set(token, alone(token));
  if (scope === "all") {
    for (const token of recordedTokens(corpus)) if (token.startsWith("event:core.") && !out.has(token)) out.set(token, alone(token));
  }
  return out;
}

export interface UncoveredReport {
  /** Recorded core events probed. */
  readonly probed: number;
  /** Of those, the ones whose removal moves no recorded golden. */
  readonly unpinned: number;
  /** The unpinned ones no claim covers, named. */
  readonly uncovered: string[];
}

/** The other direction of the class: every core event the corpus RECORDS is ablated, and every one that moves no golden must
 *  be covered by a claim. Without it the class is tested one way only (each claim holds) and an unpinned event the table
 *  never names stays invisible, which is how football's position change slipped past the `onLineup` rule. An event that moves
 *  something is pinned and owes nothing here. Probed one type at a time unless a claim groups it (a pause is suspend AND resume). */
export function uncoveredUnpinned(
  module: AnySportModule,
  corpus: GoldenCorpus,
  record: Recorder = statsRecorder,
  claims: readonly OverlayClaim[] = OVERLAY_CLAIMS,
): UncoveredReport {
  const verdicts = overlayVerdicts(module, corpus, record, claims, "all");
  let probed = 0;
  let unpinned = 0;
  const uncovered: string[] = [];
  for (const [token, r] of verdicts) {
    if (!token.startsWith("event:core.") || r.verdict === "unrecorded") continue;
    probed++;
    if (r.verdict !== "unpinned") continue;
    unpinned++;
    if (!claims.some((c) => c.tokens.includes(token) && c.covers(module, token, r.verdict))) {
      uncovered.push(`${module.key} ${token}: moves no recorded golden (${r.streams} stream(s) ablated) and no OVERLAY_CLAIMS class covers it: add it to a class with its reason, or record what it changes`);
    }
  }
  return { probed, unpinned, uncovered };
}

/** Why a lineup type is impossible under every recorded config, as `cfg: <reducer refusal code>` joined by `; `. The reason
 *  is the REDUCER's own code per config. A type the plan never got to ask the reducer about (`no-candidate`: nobody to act
 *  on) or one it neither accepted nor refused is a defect of the PLAN, not a policy fact, and the floor refuses to derive
 *  an exemption from it. */
export function impossibleReason(moduleKey: string, offers: readonly LineupOffer[], type: string): string {
  // Empty case: with no recorded config nothing was asked of the reducer, so "impossible under every config" is true of
  // anything. A corpus that loses its configs must not shrink the floor.
  if (offers.length === 0) throw new Error(`golden floor: ${moduleKey} has no recorded config, so ${type} cannot be declared impossible`);
  return offers
    .map((o) => {
      const why = o.plan.refused[type];
      if (why === undefined || why === "no-candidate") {
        throw new Error(`golden floor: ${moduleKey}/${o.cfgName} cannot say why ${type} is impossible (${why ?? "the plan neither accepted nor refused it"}): the planner found nobody to act on`);
      }
      return `${o.cfgName}: ${why}`;
    })
    .join("; ");
}

/** Claims that no longer hold for this sport, named: the event moves a recorded golden, is not recorded, or could not be
 *  probed. A token the sport's own policy makes impossible is not claimed (nothing to record). */
export function staleOverlayClaims(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder, claims: readonly OverlayClaim[] = OVERLAY_CLAIMS): string[] {
  const out: string[] = [];
  const impossible = floorRequirement(module, corpus).impossible;
  let verdicts: Map<FloorToken, OverlayResult>;
  try {
    verdicts = overlayVerdicts(module, corpus, record, claims);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    for (const claim of claims) {
      if (!claim.assertedFor(module)) continue;
      for (const token of claim.tokens) if (!impossible.has(token)) out.push(`${module.key} ${token}: the probe that proves the "${claim.id}" claim could not run: ${why}`);
    }
    return out;
  }
  for (const claim of claims) {
    if (!claim.assertedFor(module)) continue;
    for (const token of claim.tokens) {
      if (impossible.has(token)) continue;
      const r = verdicts.get(token);
      if (r === undefined || r.verdict === "unrecorded") {
        out.push(`${module.key} ${token}: not recorded, so the "${claim.id}" claim holds over nothing (the floor reds first)`);
      } else if (r.verdict === "pinned") {
        out.push(
          `${module.key} ${token}: moves a recorded golden (${r.moved} of ${r.streams} stream(s) change, ${r.refused} refused, when it is removed): ` +
            `the "${claim.id}" claim no longer holds — the manual-bump caveat in GOLDEN-POLICY.md does not apply to it in this sport, move it out of OVERLAY_CLAIMS`,
        );
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- the kernel overlay tokens
//
// GF-2 recorded what a phone computes from the KERNEL beside what it computes from the module (golden-overlay.ts). Recording a
// column is not exercising it: a corpus whose overlay never leaves the kernel defaults records `{}` for every stream and pins
// nothing (measured over the 381 streams GF-2 T2 reformatted: no stream reached a settlement, an expunge or a level
// withdrawal). So the floor requires each fact to be seen MOVING, and to be seen coming BACK where an undo can reopen it.

/** What the floor requires of one kernel fact (a key of the fold result besides `state`). */
interface OverlayRule {
  /** Why the corpus must show the fact LEAVING its kernel default. */
  readonly set: string;
  /** Why it must show the fact coming BACK to the default. Absent = not required: a stream's overlay cannot say it for `squads`
   *  (its default is the digest of the team sheets, which only a fold can compute). */
  readonly cleared?: string;
  /** The fact exists only over a level result: required only where the sport's floor requires a level outcome. */
  readonly whenLevel?: true;
}

/** Owner ruling (GF-2 design §4, 2026-10-15), one row per key the kernel's fold returns besides `state`. */
const OVERLAY_RULES: Readonly<Record<(typeof FOLD_OVERLAY_KEYS)[number], OverlayRule>> = {
  stoppage: {
    set: "a core.suspend opens a stoppage, which the kernel keeps beside module state",
    cleared: "a core.resume (or a decision, or a void of the suspend) closes it again",
  },
  squads: { set: "a lineup change moves the squads off the team sheets, which the kernel keeps beside module state" },
  settlement: {
    set: "a core.settle lays an organiser's win over a level or abandoned match (outcomeOf)",
    cleared: "a void of the settle takes the win away and the match is level or abandoned again",
  },
  expunged: {
    set: "a core.abandon{expunge} takes the match off the table (outcomeOf reads null)",
    cleared: "a void of the expunging abandon puts the match back",
  },
  levelWithdrawal: {
    set: "a core.forfeit{withdrew} over a held level result is an award (outcomeOf, summaryOf)",
    cleared: "a void of the withdrawal restores the level result",
    whenLevel: true,
  },
};

/** The keys the kernel's fold returns beside the module state, READ OFF a real fold of an empty ledger (never a list typed
 *  here): the facts the floor owes a rule. */
export function foldKeysOf(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const raw = Object.values(corpus.configs)[0];
  if (raw === undefined) throw new Error(`golden floor: ${module.key} has no recorded config, so the keys of the kernel's fold cannot be read`);
  const cfg = module.configSchema.parse(raw) as unknown;
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, [], { strictFromSeq: 0 });
  return Object.keys(folded).filter((key) => key !== "state");
}

/** The overlay tokens a sport's floor requires: one rule per fold key. A key with no rule (the kernel gained a fact) and a rule
 *  with no key (it lost one) are both named failures, never a silently smaller floor. `levelReachable`: the sport's floor
 *  requires a draw, a tie or a no_result, i.e. a withdrawal can be laid over a held level result there. */
export function overlayRequirement(foldKeys: readonly string[], levelReachable: boolean): Map<FloorToken, string> {
  for (const key of foldKeys) {
    if (!Object.hasOwn(OVERLAY_RULES, key)) {
      throw new Error(`golden floor: the kernel's fold returns "${key}" and the floor has no overlay rule for it: add one to OVERLAY_RULES, or argue it away`);
    }
  }
  for (const key of Object.keys(OVERLAY_RULES)) {
    if (!foldKeys.includes(key)) throw new Error(`golden floor: OVERLAY_RULES names "${key}", which the kernel's fold no longer returns: remove its rule`);
  }
  const out = new Map<FloorToken, string>();
  for (const key of foldKeys) {
    const rule = OVERLAY_RULES[key as keyof typeof OVERLAY_RULES];
    if (rule.whenLevel === true && !levelReachable) continue;
    out.set(overlayToken(key, "set"), rule.set);
    if (rule.cleared !== undefined) out.set(overlayToken(key, "cleared"), rule.cleared);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- requirement

export interface FloorRequirement {
  readonly sport: string;
  /** token -> the engine fact it was derived from. */
  readonly required: ReadonlyMap<FloorToken, string>;
  /** token -> the reasoned exemption that excuses it (never also in `required`). */
  readonly exempt: ReadonlyMap<FloorToken, string>;
  /** lineup types the sport's policy refuses in every recorded config, with the reducer's reason. */
  readonly impossible: ReadonlyMap<FloorToken, string>;
  /** how many facts were examined to derive the above — anti-vacuity. */
  readonly examined: { coreTypes: number; configs: number; admissionStates: number };
}

export function floorRequirement(
  module: AnySportModule,
  corpus: GoldenCorpus,
  coreTypes: readonly string[] = CORE_TYPES,
  exemptions: readonly FloorExemption[] = FLOOR_EXEMPTIONS,
): FloorRequirement {
  const required = new Map<FloorToken, string>();
  const exempt = new Map<FloorToken, string>();
  const impossible = new Map<FloorToken, string>();

  // 1. core events — the kernel's own map, less exemptions, less lineup types no recorded config's policy accepts.
  const offers = lineupOffers(module, corpus, coreTypes);
  for (const type of coreTypes) {
    const token = eventToken(type);
    const exemption = exemptions.find((e) => e.token === token && exemptionApplies(e, module.key));
    if (exemption !== undefined) {
      exempt.set(token, exemption.reason);
      continue;
    }
    if (type.startsWith("core.lineup.")) {
      const offer = offers.find((o) => o.plan.accepted.includes(type));
      if (offer === undefined) {
        impossible.set(token, impossibleReason(module.key, offers, type));
        continue;
      }
      required.set(token, `accepted by the reducer under ${module.key}/${offer.cfgName}'s lineup policy`);
      continue;
    }
    required.set(token, "CORE_EVENT_SCHEMAS declares it");
  }

  // 1b. an undo of each decisive kernel event.
  for (const type of UNDOABLE_KERNEL) {
    required.set(undoToken(type), `a mis-tapped ${type} is undone with core.void, which must reopen the match`);
  }

  for (const type of STANDING_KERNEL) required.set(standingToken(type), `a ${type} that nothing strikes: the match stays ended`);

  // 2. outcomes.
  required.set(outcomeToken("win"), "every sport decides a match");
  for (const [name, raw] of Object.entries(corpus.configs)) {
    const cfg = module.configSchema.parse(raw) as unknown;
    const kind = [...DRAW_KINDS].find((k) => module.supportsDraws(cfg as never, k));
    if (kind !== undefined) {
      required.set(outcomeToken("draw"), `supportsDraws(${name}, ${kind}) is true`);
      break;
    }
  }
  const admission = forfeitAdmissions(module, corpus);
  for (const reason of FORFEIT_REASONS) {
    const where = admission.reasons.get(reason);
    if (where !== undefined) required.set(outcomeToken(`award:${reason}`), `forfeitAdmission admits "${reason}" (${where})`);
  }
  if (admission.both !== null) required.set(outcomeToken("double_walkover"), `forfeitAdmission admits a double walkover (${admission.both})`);
  for (const [token, why] of Object.entries(NATURAL_OUTCOMES[module.key] ?? {})) required.set(outcomeToken(token), `NATURAL_OUTCOMES: ${why}`);

  // 3. the kernel overlay — each fact the fold keeps beside module state, seen moving (and coming back where an undo reopens it).
  const levelReachable = LEVEL_OUTCOME_TOKENS.some((kind) => required.has(outcomeToken(kind)));
  for (const [token, why] of overlayRequirement(foldKeysOf(module, corpus), levelReachable)) required.set(token, why);

  // 4. the player stats (GF-2 T4) — an award the sport DECLARES, seen credited. Only where the corpus can record it (format 3): the
  //    floor asks for what the corpus's own format holds, as it asked for the overlay tokens only from format 2.
  if (corpusFormat(corpus) >= 3) {
    for (const award of module.playerStats?.awards ?? []) {
      required.set(statsAwardToken(award.key), `playerStats.awards declares "${award.key}": a core.award naming it must reach a person's ${awardStatKey(award.key)}`);
    }
  }

  return {
    sport: module.key,
    required,
    exempt,
    impossible,
    examined: { coreTypes: coreTypes.length, configs: Object.keys(corpus.configs).length, admissionStates: admission.states },
  };
}

/** The tokens the sport's floor requires and its corpus does not hold. Empty = the floor is met. */
export function floorHoles(module: AnySportModule, corpus: GoldenCorpus): FloorToken[] {
  const have = recordedTokens(corpus);
  return [...floorRequirement(module, corpus).required.keys()].filter((token) => !have.has(token));
}

/** Exemptions that no longer hold for this sport (each entry's own `stale`), named. */
export function staleFloorExemptions(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder, exemptions: readonly FloorExemption[] = FLOOR_EXEMPTIONS): string[] {
  const out: string[] = [];
  for (const e of exemptions) {
    if (!exemptionApplies(e, module.key)) continue;
    const why = e.stale(module, corpus, record);
    if (why !== null) out.push(`${module.key} ${e.token}: ${why}`);
  }
  return out;
}

/** Natural-outcome rows that name a sport the registry does not have, or a token no corpus of that sport records. */
export function staleNaturalOutcomes(modules: readonly AnySportModule[], corpusOf: (key: string) => GoldenCorpus): string[] {
  const out: string[] = [];
  const keys = new Set(modules.map((m) => m.key));
  for (const [sport, tokens] of Object.entries(NATURAL_OUTCOMES)) {
    if (!keys.has(sport)) {
      out.push(`NATURAL_OUTCOMES names "${sport}", which is not a registered sport`);
      continue;
    }
    const have = recordedTokens(corpusOf(sport));
    for (const token of Object.keys(tokens)) {
      if (!have.has(outcomeToken(token))) out.push(`NATURAL_OUTCOMES lists ${sport} ${token}, which no ${sport} stream records`);
    }
  }
  return out;
}

/** Outcomes a bounded sweep of the module's own generator reaches that the floor does not require — the direction in
 *  which an undeclared table rots. Also returns how many walks it took, so zero is visible as a failure. */
export function unrequiredObservedOutcomes(
  module: AnySportModule,
  corpus: GoldenCorpus,
  requirement: FloorRequirement,
): { unrequired: string[]; walks: number; observed: string[] } {
  const observed = new Set<string>();
  let walks = 0;
  for (const raw of Object.values(corpus.configs)) {
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (let seed = 1; seed <= OBSERVE_SEEDS; seed++) {
      let walk;
      try {
        walk = buildWalk(module, cfg, lineups, seed, WALK_EVENTS);
      } catch {
        continue;
      }
      walks++;
      const last: unknown = walk.states[walk.states.length - 1];
      const outcome = last === undefined ? null : module.outcome(last);
      if (outcome === null) continue;
      observed.add(outcome.kind === "award" ? `award:${outcome.reason}` : outcome.kind);
    }
  }
  const unrequired = [...observed].filter((token) => !requirement.required.has(outcomeToken(token)));
  return { unrequired, walks, observed: [...observed].sort() };
}
