// W2b loop-F review M-4 (plan D3): FORFEIT_REASON_WRONG_PHASE names the phase it judged and the reasons that phase
// admits. The engine's refusal carries both (`EngineError.data`: `phase`, `allowed`, `both` — core/events.ts, the one
// `forfeitReasonsAllowed` list the guard judges by), `server/api-v1/http.ts` forwards them on the wire, and the copy
// renders them in the reader's language (`lib/scoring-vocab.ts` `scoringErrorText`). A static sentence cannot be
// right: chess admits a walkover after the start, the default modules do not. No `server-only`: the pad and the
// console read it too.
import { FORFEIT_REASONS, type ForfeitPhase, type ForfeitReason } from "@seazn/engine/core";

/** The phases the guard refuses in — never "over" (R0: the module's own done/final guard answers there). */
export type RefusalPhase = Exclude<ForfeitPhase, "over">;
export const REFUSAL_PHASES: readonly RefusalPhase[] = ["pre", "play", "tiebreak"];

export interface ForfeitPhaseRefusal {
  phase: RefusalPhase;
  /** In FORFEIT_REASONS order, as the engine lists them. */
  allowed: ForfeitReason[];
  /** The refused forfeit named both sides (a double walkover). */
  both: boolean;
}

const REASONS: ReadonlySet<string> = new Set(FORFEIT_REASONS);

/** The refusal's named shape, or null when it is not one this codebase can read — an unknown phase, an empty or
 *  unknown reason list, a non-boolean `both`. Null keeps the code's own copy; it never renders a guess. */
export function forfeitPhaseRefusalOf(data: unknown): ForfeitPhaseRefusal | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { phase?: unknown; allowed?: unknown; both?: unknown };
  if (typeof d.phase !== "string" || !(REFUSAL_PHASES as readonly string[]).includes(d.phase)) return null;
  if (!Array.isArray(d.allowed) || d.allowed.length === 0) return null;
  if (!d.allowed.every((r) => typeof r === "string" && REASONS.has(r))) return null;
  if (typeof d.both !== "boolean") return null;
  return { phase: d.phase as RefusalPhase, allowed: [...new Set(d.allowed as ForfeitReason[])], both: d.both };
}
