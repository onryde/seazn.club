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

/** The five lineup types, in the order a match plausibly produces them. */
export const LINEUP_TYPES = [
  "core.lineup.position",
  "core.lineup.substitution",
  "core.lineup.replacement",
  "core.lineup.retirement",
  "core.lineup.entry",
] as const;

export interface LineupPlan {
  /** The accepted events, in order, ready to append (home side). */
  readonly events: GoldenEvent[];
  /** Types the real reducer accepted under this policy. */
  readonly accepted: string[];
  /** Types it refused, with the reducer's own reason code. */
  readonly refused: Record<string, string>;
}

/** One home-side lineup event of each type, chosen against the squad AS IT STANDS and checked by the real reducer
 *  (`reduceLineupEvent`, strict policy), so a type the policy refuses is named with the reducer's reason instead of
 *  being assumed impossible. The chain evolves the squads event by event: a squad of one (tennis) takes its position
 *  change, then a substitution that puts a bench player on, then an exempt replacement OF that player, and so on. */
export function planLineupEvents(lineups: LineupPair, policy: LineupPolicy): LineupPlan {
  const side = lineups.home.entrantId;
  let squads: SquadState = initSquads(lineups);
  const events: GoldenEvent[] = [];
  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  const exemption = Object.keys(policy.exemptions ?? {})[0];

  const members = () => squads.home.members.filter((m) => m.role === "player");
  const onField = () => members().filter((m) => m.onField);
  const bench = () => members().filter((m) => !m.onField && m.timesOff === 0 && !m.started);
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

  for (const type of LINEUP_TYPES) {
    if (type === "core.lineup.replacement" && exemption === undefined) {
      refused[type] = "exemption-not-declared";
      continue;
    }
    const fields = onField();
    const benched = bench();
    const attempts: { payload: Record<string, unknown> }[] = [];
    if (type === "core.lineup.position") {
      for (const m of fields) {
        const groups = resolveGroupKeys(lineups);
        const other = groups.find((g) => g !== m.positionKey) ?? `${m.positionKey ?? "pos"}-alt`;
        attempts.push({ payload: { side, personId: m.personId, positionKey: other } });
      }
    } else if (type === "core.lineup.substitution" || type === "core.lineup.replacement") {
      const required = exemption === undefined ? undefined : policy.exemptions?.[exemption]?.requiresRole;
      for (const off of [...fields].reverse()) {
        for (const on of benched) {
          attempts.push({
            payload: {
              side,
              off: off.personId,
              on: slotOf(on.personId, off.positionKey, type === "core.lineup.replacement" && required !== undefined ? [required] : undefined),
              ...(type === "core.lineup.replacement" ? { exemption, reason: "injury" } : {}),
            },
          });
        }
      }
    } else if (type === "core.lineup.retirement") {
      for (const m of [...fields].reverse()) attempts.push({ payload: { side, personId: m.personId, reason: "retired hurt" } });
    } else {
      for (const on of benched) attempts.push({ payload: { side, on: slotOf(on.personId) } });
    }

    let last = "no candidate: nobody to act on";
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
export function lineupOffers(module: AnySportModule, corpus: GoldenCorpus): LineupOffer[] {
  return Object.entries(corpus.configs).map(([cfgName, raw]) => {
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = benchPair(module, cfg);
    const policy = module.lineupPolicy?.(cfg) ?? DEFAULT_LINEUP_POLICY;
    return { cfgName, lineups, plan: planLineupEvents(lineups, policy) };
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

export interface FloorExemption {
  readonly token: FloorToken;
  /** `"all"`, or the sports the exemption covers. */
  readonly sports: "all" | readonly string[];
  readonly reason: string;
  /** null while the exemption still holds for this sport; otherwise WHY it has gone stale. */
  stale(module: AnySportModule, corpus: GoldenCorpus): string | null;
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
    stale(module, corpus) {
      if (recordedTokens(corpus).has(eventToken("core.settle"))) return "the corpus records core.settle: delete the exemption";
      const probe = settleProbe(module, corpus);
      if (typeof probe === "string") return `the probe that proves the harness cannot record a settle could not run: ${probe}`;
      return probe.recorded === probe.effective
        ? `the harness now records the effective outcome (${probe.recorded}): record core.settle and delete the exemption`
        : null;
    },
  },
];

/** The recorded outcome of [start, abandon, settle] against the outcome the kernel reads from the same ledger. */
export function settleProbe(module: AnySportModule, corpus: GoldenCorpus): { recorded: string; effective: string } | string {
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
    const recorded = recomputeStream(module, raw, events, lineups).outcome;
    const envelopes: EventEnvelope[] = events.map((e, i) => makeEnvelope(i, e));
    const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, envelopes, { strictFromSeq: 0 });
    return { recorded, effective: JSON.stringify(outcomeOf(module as never, folded as never) ?? null) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const exemptionApplies = (e: FloorExemption, sport: string): boolean => e.sports === "all" || e.sports.includes(sport);

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

export function floorRequirement(module: AnySportModule, corpus: GoldenCorpus): FloorRequirement {
  const required = new Map<FloorToken, string>();
  const exempt = new Map<FloorToken, string>();
  const impossible = new Map<FloorToken, string>();

  // 1. core events — the kernel's own map, less exemptions, less lineup types no recorded config's policy accepts.
  const offers = lineupOffers(module, corpus);
  for (const type of CORE_TYPES) {
    const token = eventToken(type);
    const exemption = FLOOR_EXEMPTIONS.find((e) => e.token === token && exemptionApplies(e, module.key));
    if (exemption !== undefined) {
      exempt.set(token, exemption.reason);
      continue;
    }
    if (type.startsWith("core.lineup.")) {
      const offer = offers.find((o) => o.plan.accepted.includes(type));
      if (offer === undefined) {
        impossible.set(token, offers.map((o) => `${o.cfgName}: ${o.plan.refused[type] ?? "?"}`).join("; "));
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
    examined: { coreTypes: CORE_TYPES.length, configs: Object.keys(corpus.configs).length, admissionStates: admission.states },
  };
}

/** The tokens the sport's floor requires and its corpus does not hold. Empty = the floor is met. */
export function floorHoles(module: AnySportModule, corpus: GoldenCorpus): FloorToken[] {
  const have = recordedTokens(corpus);
  return [...floorRequirement(module, corpus).required.keys()].filter((token) => !have.has(token));
}

/** Exemptions that no longer hold for this sport (each entry's own `stale`), named. */
export function staleFloorExemptions(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const out: string[] = [];
  for (const e of FLOOR_EXEMPTIONS) {
    if (!exemptionApplies(e, module.key)) continue;
    const why = e.stale(module, corpus);
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
