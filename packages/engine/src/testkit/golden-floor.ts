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
// WHAT IT IS NOT. It does not record `outcomeOf` / `summaryOf` / stoppage (the kernel overlays): the corpus record
// shape is untouched by this task. That is why `core.settle` is exempt (see its row) until that later task lands.
//
// Purity: this file reads corpora through `golden.ts` (node:fs), so it stays out of the published testkit barrel.
import { CORE_EVENT_SCHEMAS, forfeitAdmission, foldMatchWithStoppage, outcomeOf, playRecorded, type EventEnvelope } from "../core/events.ts";
import {
  DEFAULT_LINEUP_POLICY,
  initSquads,
  reduceLineupEvent,
  type LineupPolicy,
  type SquadState,
} from "../core/lineup.ts";
import { DRAW_KINDS, FORFEIT_REASONS, type LineupPair, type LineupSlot } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { recomputeStream, type GoldenCorpus, type GoldenEvent } from "./golden.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

// ------------------------------------------------------------------------------------------------------------ tokens

/** `event:core.void`, `outcome:award:retired`, `outcome:double_walkover`. */
export type FloorToken = `event:${string}` | `outcome:${string}`;

/** Every `core.*` type the kernel accepts — the keys of its own schema map. */
export const CORE_TYPES: readonly string[] = Object.keys(CORE_EVENT_SCHEMAS);

export const eventToken = (type: string): FloorToken => `event:${type}`;
export const outcomeToken = (token: string): FloorToken => `outcome:${token}`;

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
    for (const event of stream.events) if (event.type.startsWith("core.")) out.add(eventToken(event.type));
    const token = outcomeTokenOf(stream.outcome);
    if (token !== null) out.add(outcomeToken(token));
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
/** How many generator seeds per config the completeness sweep walks (`unrequiredObservedOutcomes`). */
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

/** The harness function that turns a recorded ledger into a stream's recorded half. Injectable so the settle exemption's
 *  staleness is testable against a harness that records the kernel's overlays — the future the exemption waits for. */
export type Recorder = typeof recomputeStream;

export interface FloorExemption {
  readonly token: FloorToken;
  /** `"all"`, or the sports the exemption covers. */
  readonly sports: "all" | readonly string[];
  readonly reason: string;
  /** null while the exemption still holds for this sport; otherwise WHY it has gone stale. */
  stale(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder): string | null;
}

/** The one thing the harness cannot yet record faithfully: a settlement. `recomputeStream` stores `module.outcome(state)`,
 *  and a settle lives BESIDE module state (`outcomeOf` lays it over), so a stream carrying one would record the module's
 *  bare answer while the effective outcome is a win — a recorded value that is wrong the moment it is written, and one
 *  `apps/web/src/server/engine-db/__tests__/outcome-readers.test.ts` forbids by name ("no golden corpus stream carries
 *  core.settle"). Recording `outcomeOf` / `summaryOf` is the SEPARATE later task; the settle streams land with it. */
export const FLOOR_EXEMPTIONS: readonly FloorExemption[] = [
  {
    token: eventToken("core.settle"),
    sports: "all",
    reason:
      "the corpus records the module's bare outcome (recomputeStream), and a settlement is laid over it by outcomeOf — a settle stream would record " +
      "a draw/null where the effective outcome is a win; recording outcomeOf/summaryOf is the later kernel-overlay task",
    stale(module, corpus, record) {
      if (recordedTokens(corpus).has(eventToken("core.settle"))) return "the corpus records core.settle: delete the exemption";
      const probe = settleProbe(module, corpus, record);
      if (typeof probe === "string") return `the probe that proves the harness cannot record a settle could not run: ${probe}`;
      return probe.recorded === probe.effective
        ? `the harness now records the effective outcome (${probe.recorded}): record core.settle and delete the exemption`
        : null;
    },
  },
];

/** The recorded outcome of [start, abandon, settle] against the outcome the kernel reads from the same ledger. */
export function settleProbe(module: AnySportModule, corpus: GoldenCorpus, record: Recorder = recomputeStream): { recorded: string; effective: string } | string {
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
// The floor is a PRESENCE check: a corpus that records `core.suspend` satisfies it. It does not follow that the epoch guard
// can see a change to how a pause folds, because the harness records the MODULE's state, outcome, summary and deltas — not
// the kernel overlay (stoppage clock, squads, settlement). An event the kernel owns, or one a module folds as `return
// state`, can sit in a stream and move nothing the guard compares. That is a class, not a gap to hide: each CLAIM below
// says which events are inert in which sports and why, the inertness is DERIVED by ablation (remove the event, compare
// every recorded field), and a claim whose ablation starts finding movement is stale — the day the harness records the
// overlay, every claim goes red and is deleted, and the manual-bump caveat in GOLDEN-POLICY.md goes with it.

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
  /** The sports the claim covers — a statement about the module's own declaration, not a list typed here. */
  appliesTo(module: AnySportModule): boolean;
  readonly reason: string;
}

export const OVERLAY_CLAIMS: readonly OverlayClaim[] = [
  {
    id: "stoppage",
    tokens: [eventToken("core.suspend"), eventToken("core.resume")],
    mode: "together",
    appliesTo: () => true,
    reason:
      "kernel-owned: core.suspend / core.resume never reach module.apply, and the stoppage clock (core/time.ts) and the " +
      "open-stoppage refusals live in the kernel overlay, which the harness does not record — a change to how a pause folds moves no golden",
  },
  {
    id: "note",
    tokens: [eventToken("core.note")],
    mode: "together",
    appliesTo: () => true,
    reason:
      "a free-text annotation: it reaches module.apply but every module folds it as `return state`, so the recorded states, " +
      "outcome, summary and deltas are identical with or without it",
  },
  {
    id: "award",
    tokens: [eventToken("core.award")],
    mode: "together",
    appliesTo: () => true,
    reason:
      "a player award (motm and the like): it reaches module.apply but every module folds it as `return state`, so the recorded " +
      "fields are identical with or without it",
  },
  {
    id: "lineup",
    tokens: LINEUP_TYPES.map(eventToken),
    mode: "chain",
    appliesTo: (module) => module.onLineup === undefined,
    reason:
      "kernel-owned squads: a module that declares no onLineup never sees a lineup change, so its recorded fields are identical " +
      "with or without them — a change to the lineup reducer (core/lineup.ts) moves no golden in that sport",
  },
];

/** `core.finalize` is probed beside the claims as a CONTROL: it is folded by every module and is not claimed unpinned, so
 *  a probe that could only ever answer "unpinned" would show here. */
const OVERLAY_CONTROLS: readonly OverlayClaim["tokens"][] = [[eventToken("core.finalize")]];

interface Ablation {
  readonly kept: GoldenEvent[];
}

/** The ledger without every event whose type is in `remove`, the `voids` ids renumbered to the survivors' new places; null
 *  when a void targets a removed event (its target is gone, so there is nothing sound to compare). */
function ablate(events: readonly GoldenEvent[], remove: ReadonlySet<string>): Ablation | null {
  const place = new Map<number, number>();
  let next = 0;
  events.forEach((event, i) => {
    if (!remove.has(event.type)) place.set(i, next++);
  });
  const kept: GoldenEvent[] = [];
  for (const event of events) {
    if (remove.has(event.type)) continue;
    if (event.voids === undefined) {
      kept.push(event);
      continue;
    }
    const target = place.get(Number(event.voids.slice(2)));
    if (target === undefined) return null;
    kept.push({ ...event, voids: `e-${target}` });
  }
  return { kept };
}

/** Whether removing `big \ small` from the ledger changes any recorded field, across every recorded stream that carries one
 *  of those events. Moved = a retained step's state differs, the outcome / summary / deltas differ, or an ablated event's
 *  OWN step already changed the state (a module that folds the event into state). */
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
    const near = ablate(stream.events, small);
    const far = ablate(stream.events, big);
    if (near === null || far === null) continue;
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
    const gone = near.kept.map((e, i) => (extra.has(e.type) ? i : -1)).filter((i) => i >= 0);
    const retained = near.kept.map((_, i) => i).filter((i) => !gone.includes(i));
    const sameSteps = JSON.stringify(retained.map((i) => a.states[i])) === JSON.stringify(b.states);
    const ownStepsNeutral = gone.every((i) => i === 0 || a.states[i] === a.states[i - 1]);
    if (!(sameSteps && ownStepsNeutral && a.outcome === b.outcome && a.summary === b.summary && a.deltas === b.deltas)) moved++;
  }
  const verdict: OverlayVerdict = streams === 0 ? "unrecorded" : moved > 0 || refused > 0 ? "pinned" : "unpinned";
  return { verdict, streams, moved, refused };
}

/** For every event a claim names (and the finalize control): is it recorded, and does it move a recorded golden? */
export function overlayVerdicts(module: AnySportModule, corpus: GoldenCorpus, record: Recorder = recomputeStream): Map<FloorToken, OverlayResult> {
  const out = new Map<FloorToken, OverlayResult>();
  const typeOf = (token: FloorToken): string => token.slice("event:".length);
  for (const claim of OVERLAY_CLAIMS) {
    const types = claim.tokens.map(typeOf);
    claim.tokens.forEach((token, k) => {
      const big = new Set(claim.mode === "chain" ? types.slice(k) : types);
      const small = new Set(claim.mode === "chain" ? types.slice(k + 1) : []);
      out.set(token, ablationProbe(module, corpus, small, big, record));
    });
  }
  for (const tokens of OVERLAY_CONTROLS) {
    const types = new Set(tokens.map(typeOf));
    for (const token of tokens) out.set(token, ablationProbe(module, corpus, new Set(), types, record));
  }
  return out;
}

/** Claims that no longer hold for this sport, named: the event moves a recorded golden, is not recorded, or could not be
 *  probed. A token the sport's own policy makes impossible is not claimed (nothing to record). */
export function staleOverlayClaims(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder): string[] {
  const out: string[] = [];
  const impossible = floorRequirement(module, corpus).impossible;
  let verdicts: Map<FloorToken, OverlayResult>;
  try {
    verdicts = overlayVerdicts(module, corpus, record);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    for (const claim of OVERLAY_CLAIMS) {
      if (!claim.appliesTo(module)) continue;
      for (const token of claim.tokens) if (!impossible.has(token)) out.push(`${module.key} ${token}: the probe that proves the "${claim.id}" claim could not run: ${why}`);
    }
    return out;
  }
  for (const claim of OVERLAY_CLAIMS) {
    if (!claim.appliesTo(module)) continue;
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

export function floorRequirement(module: AnySportModule, corpus: GoldenCorpus, coreTypes: readonly string[] = CORE_TYPES): FloorRequirement {
  const required = new Map<FloorToken, string>();
  const exempt = new Map<FloorToken, string>();
  const impossible = new Map<FloorToken, string>();

  // 1. core events — the kernel's own map, less exemptions, less lineup types no recorded config's policy accepts.
  const offers = lineupOffers(module, corpus, coreTypes);
  for (const type of coreTypes) {
    const token = eventToken(type);
    const exemption = FLOOR_EXEMPTIONS.find((e) => e.token === token && exemptionApplies(e, module.key));
    if (exemption !== undefined) {
      exempt.set(token, exemption.reason);
      continue;
    }
    if (type.startsWith("core.lineup.")) {
      const offer = offers.find((o) => o.plan.accepted.includes(type));
      if (offer === undefined) {
        // The reason is the reducer's own refusal code per config. A type the plan never got to ask the reducer about
        // ('no-candidate': nobody to act on) or one the plan neither accepted nor refused is a defect of the PLAN, not a
        // policy fact — the floor refuses to derive an exemption from it.
        const reasons = offers.map((o) => {
          const why = o.plan.refused[type];
          if (why === undefined || why === "no-candidate") {
            throw new Error(`golden floor: ${module.key}/${o.cfgName} cannot say why ${type} is impossible (${why ?? "the plan neither accepted nor refused it"}): the planner found nobody to act on`);
          }
          return `${o.cfgName}: ${why}`;
        });
        impossible.set(token, reasons.join("; "));
        continue;
      }
      required.set(token, `accepted by the reducer under ${module.key}/${offer.cfgName}'s lineup policy`);
      continue;
    }
    required.set(token, "CORE_EVENT_SCHEMAS declares it");
  }

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
export function staleFloorExemptions(module: AnySportModule, corpus: GoldenCorpus, record?: Recorder): string[] {
  const out: string[] = [];
  for (const e of FLOOR_EXEMPTIONS) {
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
