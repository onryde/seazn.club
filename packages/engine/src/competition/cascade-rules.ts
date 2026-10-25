// W2d Task 6 (spec §5.5; D3, D8, D10(d), D11, OC1, OC3; rule rows X-TB-3, X-TB-5, X-TB-7, FB-TB-4) — the write side of a
// tie-break order. `validateCascade` returns EVERY refusal rather than throwing at the first, so the stage editor can mark
// each step and the API can name them all (`TIEBREAK_KEY_INVALID`, spec §10); `offerableKeys` is the editor's "+ Add step"
// (§9). The ranker (`rankStandings`, tiebreakers.ts) runs what this accepts: the h2h modifier's position is the one rule
// both enforce, and cascade-rules.test.ts holds the two to each other.
//
// Before W2d the check lived in tiebreakers.ts, threw on the first metric it missed, knew none of the W2d keys, refused
// `sberger`/`direct` outside Swiss and had no production caller.
import { EngineError } from "../core/errors.ts";
import type { StageKind } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { RATIO_LEDGERS, type RatioKey } from "./display.ts";
import { DIFF_KEYS, FOR_KEYS } from "./tiebreakers.ts";

export type CascadeRefusalReason =
  | "empty" | "duplicate" | "first" | "last" | "sport" | "stage_format" | "cross_group" | "fair_play_off" | "position";

/** One refused step. `index` is its position in the order, `key` the step (both -1 / null for the empty order, which has
 *  no step). `need` is what the step lacks, where the message names it: the sport's primary measure (`first`), `lots`
 *  (`last`), the ledger the sport does not record (`sport`), `swiss` (`stage_format`), `fairPlay` (`fair_play_off`). */
export interface CascadeRefusal {
  readonly index: number;
  readonly key: TiebreakerKey | null;
  readonly reason: CascadeRefusalReason;
  readonly need?: string;
}

/** Where the order would run: the sport (its `metrics` and `primaryTableKey`), the cfg the stage plays (football's
 *  `fairPlay`, read as `module.configSchema` parses it), the stage kind (Swiss is exempt from the first/last rule, OC1;
 *  Buchholz needs it), and whether the order compares entrants across groups (D3). */
export interface CascadeContext {
  readonly module: AnySportModule;
  readonly cfg: unknown;
  readonly stageKind: StageKind;
  readonly crossGroup: boolean;
}

// What each key needs to rank on real data. `ledger`: the metrics its comparator reads (tiebreakers.ts) — every group must
// be one the sport records, and any alias of a group will do, as `metricOf` reads the first alias a row records.
interface KeyRule {
  readonly ledger?: readonly (readonly string[])[];
  /** Rule 3 (D10(d)): ranks on the Swiss ledger, which only a Swiss stage assembles. */
  readonly swissOnly?: true;
  /** Rule 4 (D3): compares the tied entrants with each other, so it means nothing across groups. */
  readonly headToHead?: true;
  /** A mini-table key: a run of them is an h2h block (the ranker's `H2H_PLAIN`). */
  readonly block?: true;
  /** Rule 5: closes the h2h block directly before it. */
  readonly modifier?: true;
  /** Rule 2 (D8): ranks only while the cfg tracks fair play. */
  readonly fairPlay?: true;
}

const ratio = (key: RatioKey): readonly (readonly string[])[] => RATIO_LEDGERS[key].map((metric) => [metric]);
const BLOCK = { headToHead: true, block: true } as const;
const MODIFIER = { headToHead: true, modifier: true } as const;

// A full Record, so a new TiebreakerKey cannot compile without saying what it needs. In the union's own order, which is the
// order `offerableKeys` offers in.
const KEY_RULES: Readonly<Record<TiebreakerKey, KeyRule>> = {
  points: {},
  wins: {},
  h2h_points: BLOCK,
  h2h_diff: { ...BLOCK, ledger: [DIFF_KEYS] },
  h2h_for: { ...BLOCK, ledger: [FOR_KEYS] },
  diff: { ledger: [DIFF_KEYS] },
  for: { ledger: [FOR_KEYS] },
  // The net-run-rate fraction's four counters (spec 04 §5, tiebreakers.ts `nrrFraction`).
  nrr: { ledger: [["runs_for"], ["balls_faced_eff"], ["runs_against"], ["balls_bowled_eff"]] },
  set_ratio: { ledger: ratio("set_ratio") },
  game_ratio: { ledger: ratio("game_ratio") },
  board_ratio: { ledger: ratio("board_ratio") },
  point_ratio: { ledger: ratio("point_ratio") },
  buchholz: { swissOnly: true },
  buchholz_cut1: { swissOnly: true },
  // Rule 3: valid on any table stage — outside Swiss it reads the pool's own results in game points (§5.6, B5).
  sberger: {},
  direct: { headToHead: true },
  fair_play: { ledger: [["fair_play"]], fairPlay: true },
  seed: {},
  lots: {},
  set_diff: { ledger: ratio("set_ratio") },
  point_diff: { ledger: ratio("point_ratio") },
  h2h_two: { headToHead: true },
  h2h_wins: BLOCK,
  h2h_set_ratio: { ...BLOCK, ledger: ratio("set_ratio") },
  h2h_point_ratio: { ...BLOCK, ledger: ratio("point_ratio") },
  h2h_reapply: MODIFIER,
  h2h_exclusion: MODIFIER,
  matches_played: {},
  // B3 (FIH GTR App. 3): gf − goals_pc − goals_stroke (tiebreakers.ts `fieldGoals`).
  field_goals: { ledger: [["gf"], ["goals_pc"], ["goals_stroke"]] },
};
const KEYS = Object.keys(KEY_RULES) as TiebreakerKey[];

// D8: the order may rank on fair play only while the cfg tracks it. Read as the sport's schema parses the cfg, so a stored
// partial cfg reads football's declared default (on) rather than "absent"; a cfg the schema refuses is read as given.
function tracksFairPlay(module: AnySportModule, cfg: unknown): boolean {
  const parsed = module.configSchema.safeParse(cfg);
  const read: unknown = parsed.success ? parsed.data : cfg;
  return typeof read === "object" && read !== null && (read as { fairPlay?: unknown }).fairPlay === true;
}

/** Every refusal of `cascade` in `ctx`; `[]` = valid. In the spec's rule order (§5.5 1 → 5), each rule's by index. Throws
 *  CONFIG_INVALID for a key outside the vocabulary (rule 6: the zod enum refuses those before this runs). */
export function validateCascade(cascade: readonly TiebreakerKey[], ctx: CascadeContext): readonly CascadeRefusal[] {
  // Rule 6 — a stored order is data: own-property lookup, so neither an unknown key nor "toString" finds a rule.
  cascade.forEach((key, index) => {
    if (!Object.hasOwn(KEY_RULES, key)) {
      throw new EngineError("CONFIG_INVALID", `tie-break key "${key}" at position ${index + 1} is not a tie-break key`, { key, index });
    }
  });
  // Rule 1, the empty case first: every stage kind, Swiss included.
  if (cascade.length === 0) return [{ index: -1, key: null, reason: "empty" }];
  const out: CascadeRefusal[] = [];
  const seen = new Set<TiebreakerKey>();
  cascade.forEach((key, index) => {
    // OC3: "between two" may follow several steps; nothing else repeats.
    if (seen.has(key) && key !== "h2h_two") out.push({ index, key, reason: "duplicate" });
    seen.add(key);
  });
  // OC1: a Swiss order keeps its own shape (W3 owns Swiss orders); rules 2-5 still apply to it.
  if (ctx.stageKind !== "swiss") {
    const primary = ctx.module.primaryTableKey;
    const last = cascade.length - 1;
    if (cascade[0] !== primary) out.push({ index: 0, key: cascade[0] as TiebreakerKey, reason: "first", need: primary });
    // The order ends in a drawing of lots, exactly once: one anywhere else leaves every step after it dead.
    cascade.forEach((key, index) => {
      if (key === "lots" && index !== last) out.push({ index, key, reason: "last", need: "lots" });
    });
    if (cascade[last] !== "lots") out.push({ index: last, key: cascade[last] as TiebreakerKey, reason: "last", need: "lots" });
  }
  // Rule 2 — the sport records what the step ranks on; fair play also needs the cfg to track it.
  const recorded = new Set(ctx.module.metrics.map((metric) => metric.key));
  cascade.forEach((key, index) => {
    const rule = KEY_RULES[key];
    const missing = (rule.ledger ?? []).filter((aliases) => !aliases.some((metric) => recorded.has(metric)));
    if (missing.length > 0) {
      out.push({ index, key, reason: "sport", need: missing.map((aliases) => aliases.join(" or ")).join(", ") });
    } else if (rule.fairPlay === true && !tracksFairPlay(ctx.module, ctx.cfg)) {
      out.push({ index, key, reason: "fair_play_off", need: "fairPlay" });
    }
  });
  // Rule 3 — the stage format has the data.
  cascade.forEach((key, index) => {
    if (KEY_RULES[key].swissOnly === true && ctx.stageKind !== "swiss") out.push({ index, key, reason: "stage_format", need: "swiss" });
  });
  // Rule 4 — entrants from different groups never played each other.
  if (ctx.crossGroup) {
    cascade.forEach((key, index) => {
      if (KEY_RULES[key].headToHead === true) out.push({ index, key, reason: "cross_group" });
    });
  }
  // Rule 5 — a modifier directly follows an h2h block's last key, so a block has at most one (the ranker's `parseCascade`).
  cascade.forEach((key, index) => {
    if (KEY_RULES[key].modifier !== true) return;
    const before = cascade[index - 1];
    if (before === undefined || KEY_RULES[before].block !== true) out.push({ index, key, reason: "position" });
  });
  return out;
}

// A refusal's identity within one ctx: its step, key and reason. `need` is left out: in one ctx it is fixed by the key and
// the reason (the primary, "lots", the key's missing ledger, "swiss", "fairPlay"), so it never tells two refusals apart —
// cascade-rules.test.ts's complement sweep holds that premise over every refusal it sees.
const refusalId = (refusal: CascadeRefusal, index: number): string => JSON.stringify([index, refusal.key, refusal.reason]);

/** "+ Add step" (§9): exactly the keys `k` for which `validateCascade(insert(cascade, position, k), ctx)` adds no refusal —
 *  every refusal of the new order is one the old order already had, moved past the inserted step. A refusal the insertion
 *  clears (a missing primary, a missing `lots`) is no obstacle. `position` is an insertion point, 0..cascade.length;
 *  anything else is CONFIG_INVALID. In TiebreakerKey's own order. */
export function offerableKeys(cascade: readonly TiebreakerKey[], position: number, ctx: CascadeContext): readonly TiebreakerKey[] {
  if (!Number.isInteger(position) || position < 0 || position > cascade.length) {
    throw new EngineError("CONFIG_INVALID", `insert position ${position} is outside the order (0..${cascade.length})`, { position });
  }
  const before = new Set(
    validateCascade(cascade, ctx).map((refusal) => refusalId(refusal, refusal.index >= position ? refusal.index + 1 : refusal.index)),
  );
  return KEYS.filter((key) =>
    validateCascade([...cascade.slice(0, position), key, ...cascade.slice(position)], ctx).every((refusal) =>
      before.has(refusalId(refusal, refusal.index)),
    ),
  );
}

/** Rule 4's question of one step (D3; spec §5.9): does it compare the tied entrants with each other — an `h2h_*` key,
 *  `h2h_two`, `direct`, a block modifier? `defaultCrossGroup` (table-rules.ts) removes exactly these, so a default
 *  cross-group order is one rule 4 never refuses. A stored order is data: a key outside the vocabulary is CONFIG_INVALID,
 *  as in rule 6. */
export function isHeadToHeadKey(key: TiebreakerKey): boolean {
  if (!Object.hasOwn(KEY_RULES, key)) throw new EngineError("CONFIG_INVALID", `tie-break key "${key}" is not a tie-break key`, { key });
  return KEY_RULES[key].headToHead === true;
}
