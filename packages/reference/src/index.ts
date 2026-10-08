// @seazn/reference — independent oracles written FROM THE RULEBOOK, never from
// engine code (design §7.2), by a different agent than the one fixing the
// engine in that wave. W1b ships it EMPTY of families; each wave adds the
// families its signed rulebooks cover, before fixing anything. Imports:
// relative within src, and `import type { … } from "@seazn/engine/core"`
// statements only (ruling 27) — scripts/reference-boundary.ts.
// W2a adds the first family, bracket-finish (packages/engine/rules/*.md).
import type { StageKind } from "@seazn/engine/core";
import { bracketFinish, type BracketFinishFamily } from "./families/bracket-finish.ts";

export {
  BRACKET_STAGE_KINDS,
  LEVEL_KINDS,
  OUT_OF_SCOPE,
  OutOfScope,
  RULED_OUT,
  RULED_SPORTS,
  RuledOut,
  bracketFinish,
  expectBracketFinish,
} from "./families/bracket-finish.ts";
export type {
  Action,
  BracketCase,
  BracketExpect,
  BracketFinishFamily,
  LevelKind,
  OutOfScopeReason,
  PlayResult,
  RefusalCode,
  Rung,
  RuledOutReason,
  SettleMethod,
  Side,
  Status,
  WinMethod,
} from "./families/bracket-finish.ts";

export type StageKindName = StageKind;

/** What every family declares: where it answers from, and which stage kind × sport pairs it answers. */
export interface ReferenceFamilyScope {
  readonly id: string;
  /** The signed rulebook section this family answers from. */
  readonly rulebook: string;
  readonly stageKinds: readonly StageKindName[];
  readonly sports: readonly string[] | "any";
}

/** Every family FAMILIES holds — a union discriminated by `id`, so `requireFamily(kind, sport).expect(c)` is typed by
 *  the family it resolves to (W2a: bracket-finish alone). */
export type ReferenceFamily = BracketFinishFamily;

export const FAMILIES: readonly ReferenceFamily[] = Object.freeze([bracketFinish]);

export class NoReferenceFamily extends Error {
  constructor(stageKind: string, sport: string) {
    super(`reference: no reference family for ${stageKind} × ${sport} — no oracle, so no exact check`);
    this.name = "NoReferenceFamily";
  }
}

/** Controller ruling T15-R5: more than one family for a pair is refused, never resolved to the first match. */
export class AmbiguousReferenceFamily extends Error {
  constructor(stageKind: string, sport: string, ids: readonly string[]) {
    super(`reference: ${ids.length} reference families for ${stageKind} × ${sport} (${ids.join(", ")}) — one pair, one oracle`);
    this.name = "AmbiguousReferenceFamily";
  }
}

/** The families answering a pair: FAMILIES, or an injected list (its test). */
export function familiesFor(stageKind: StageKindName, sport: string): ReferenceFamily[];
export function familiesFor<F extends ReferenceFamilyScope>(stageKind: StageKindName, sport: string, families: readonly F[]): F[];
export function familiesFor(stageKind: StageKindName, sport: string, families: readonly ReferenceFamilyScope[] = FAMILIES): ReferenceFamilyScope[] {
  return families.filter((f) => f.stageKinds.includes(stageKind) && (f.sports === "any" || f.sports.includes(sport)));
}

/** The ONE family answering a pair: none is `NoReferenceFamily`, more than one `AmbiguousReferenceFamily`. */
export function requireFamily(stageKind: StageKindName, sport: string): ReferenceFamily;
export function requireFamily<F extends ReferenceFamilyScope>(stageKind: StageKindName, sport: string, families: readonly F[]): F;
export function requireFamily(stageKind: StageKindName, sport: string, families: readonly ReferenceFamilyScope[] = FAMILIES): ReferenceFamilyScope {
  const found = familiesFor(stageKind, sport, families);
  if (found.length > 1) throw new AmbiguousReferenceFamily(stageKind, sport, found.map((f) => f.id));
  const [f] = found;
  if (f === undefined) throw new NoReferenceFamily(stageKind, sport);
  return f;
}
