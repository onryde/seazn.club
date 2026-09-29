// @seazn/reference — independent oracles written FROM THE RULEBOOK, never from
// engine code (design §7.2), by a different agent than the one fixing the
// engine in that wave. W1b ships it EMPTY of families; each wave adds the
// families its signed rulebooks cover, before fixing anything. Imports:
// relative within src, and `import type { … } from "@seazn/engine/core"`
// statements only (ruling 27) — scripts/reference-boundary.ts.
import type { StageKind } from "@seazn/engine/core";

export type StageKindName = StageKind;

export interface ReferenceFamily {
  readonly id: string;
  /** The signed rulebook section this family answers from. */
  readonly rulebook: string;
  readonly stageKinds: readonly StageKindName[];
  readonly sports: readonly string[] | "any";
}

export const FAMILIES: readonly ReferenceFamily[] = Object.freeze([]);

export class NoReferenceFamily extends Error {
  constructor(stageKind: string, sport: string) {
    super(`reference: no reference family for ${stageKind} × ${sport} — no oracle, so no exact check`);
    this.name = "NoReferenceFamily";
  }
}

export function familiesFor(stageKind: StageKindName, sport: string): ReferenceFamily[] {
  return FAMILIES.filter((f) => f.stageKinds.includes(stageKind) && (f.sports === "any" || f.sports.includes(sport)));
}

export function requireFamily(stageKind: StageKindName, sport: string): ReferenceFamily {
  const [f] = familiesFor(stageKind, sport);
  if (f === undefined) throw new NoReferenceFamily(stageKind, sport);
  return f;
}
