// W2b loop-F review M-4 (plan D3): FORFEIT_REASON_WRONG_PHASE names the phase it judged and the reasons that phase
// admits. The engine's refusal carries both (`EngineError.data`: `phase`, `allowed`, `both` — core/events.ts, the one
// `forfeitReasonsAllowed` list the guard judges by), `server/api-v1/http.ts` forwards them on the wire, and the copy
// renders them in the reader's language (`lib/scoring-vocab.ts` `scoringErrorText`). A static sentence cannot be
// right, because what a phase admits depends on the sport and on whether anything has been played:
//   - chess admits a walkover while play is under way;
//   - every other sport admits one after the Start only until something is played (ruling 112).
// No `server-only`: the pad and the console read it too.
import { FORFEIT_REASONS, type ForfeitPhase, type ForfeitReason } from "@seazn/engine/core";

/** The phases the guard refuses in — never "over" (R0: the module's own done/final guard answers there). */
export type RefusalPhase = Exclude<ForfeitPhase, "over">;
export const REFUSAL_PHASES: readonly RefusalPhase[] = ["pre", "play", "tiebreak"];

/** W2b PF-2 — the forfeit reasons only the withdrawal cascade may record. `server/engine-db/append-event.ts` refuses
 *  them from every other writer (INVALID_EVENT, `cascade_only`), whatever the phase admits. */
export const CASCADE_ONLY_FORFEIT_REASONS = ["withdrew"] as const satisfies readonly ForfeitReason[];
/** A reason an organiser, scorer or API writer may record — the engine's reasons less PF-2's cascade-only ones. */
export type WriterForfeitReason = Exclude<ForfeitReason, (typeof CASCADE_ONLY_FORFEIT_REASONS)[number]>;
const CASCADE_ONLY: ReadonlySet<string> = new Set(CASCADE_ONLY_FORFEIT_REASONS);
export const isCascadeOnlyForfeitReason = (reason: unknown): boolean => typeof reason === "string" && CASCADE_ONLY.has(reason);

export interface ForfeitPhaseRefusal {
  phase: RefusalPhase;
  /** The reasons the phase admits that THIS writer may record, in FORFEIT_REASONS order: the engine's list less PF-2's
   *  cascade-only reasons (loop-F R-3) — the refusal reaches an organiser, a scorer or an API key, never the cascade,
   *  so naming "withdrawal" would offer a reason the server refuses them. */
  allowed: WriterForfeitReason[];
  /** The refused forfeit named both sides (a double walkover). */
  both: boolean;
}

const REASONS: ReadonlySet<string> = new Set(FORFEIT_REASONS);

/** The refusal's named shape, or null when it is not one this codebase can read — an unknown phase, an empty or
 *  unknown reason list, a non-boolean `both` — or when the phase admits no reason this writer may record (only the
 *  cascade's). Null keeps the code's own copy; it never renders a guess. */
export function forfeitPhaseRefusalOf(data: unknown): ForfeitPhaseRefusal | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { phase?: unknown; allowed?: unknown; both?: unknown };
  if (typeof d.phase !== "string" || !(REFUSAL_PHASES as readonly string[]).includes(d.phase)) return null;
  if (!Array.isArray(d.allowed) || d.allowed.length === 0) return null;
  if (!d.allowed.every((r) => typeof r === "string" && REASONS.has(r))) return null;
  if (typeof d.both !== "boolean") return null;
  const allowed = [...new Set(d.allowed as ForfeitReason[])].filter((r): r is WriterForfeitReason => !CASCADE_ONLY.has(r));
  if (allowed.length === 0) return null;
  return { phase: d.phase as RefusalPhase, allowed, both: d.both };
}
