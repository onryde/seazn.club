// Text-pinned copy of apps/web/src/server/usecases/format-gates.ts (it imports
// "server-only", so it cannot load here). createStages checks the double-elim
// gate FIRST, then the advanced gate, before any insert (stages.ts:373-382),
// and each gate reads every stage of the POST. format-gates-copy.test.ts pins
// both bodies term by term, their order and the `some` over stages.
export const DOUBLE_ELIM_KINDS: readonly string[] = Object.freeze(["double_elim", "page_playoff"]);
export const ADVANCED_KINDS: readonly string[] = Object.freeze(["americano", "ladder"]);
export const ADVANCED_CONFIG_KEYS: readonly string[] = Object.freeze(["byes", "cross_feeds", "placements"]);

export type FormatGate = "formats.double_elim" | "formats.advanced";

export type GateStage = { kind: string; config?: Readonly<Record<string, unknown>> };

/** Every gate a POST of these stages fires, in createStages' order: a plan
 *  must grant ALL of them for the POST to pass (final batch FB-7). */
export function expectedGates(stages: readonly GateStage[]): FormatGate[] {
  const out: FormatGate[] = [];
  if (stages.some((s) => DOUBLE_ELIM_KINDS.includes(s.kind))) out.push("formats.double_elim");
  if (stages.some((s) => ADVANCED_KINDS.includes(s.kind) || ADVANCED_CONFIG_KEYS.some((k) => s.config?.[k] !== undefined))) out.push("formats.advanced");
  return out;
}

/** The gate a POST of these stages is refused by first — the one its 402 names. */
export function expectedGate(stages: readonly GateStage[]): FormatGate | null {
  return expectedGates(stages)[0] ?? null;
}
