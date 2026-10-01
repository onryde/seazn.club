// W1-driving Task 9 (ruling 45): where a double elim, a stepladder or a page
// playoff ends. I2 reads the champion off the winner of the TERMINAL final —
// pp-final, the last stepladder game, or gf / gf-reset — and "exactly one
// unbeaten entrant" stays knockout-only.
//
// This lives beside the snapshot, not in invariants.ts: the invariant layer
// is type-only (boundary.test.ts, PF7) so the fast-check model and W10's
// shadow checks can reuse it, and this module value-imports the engine. The
// snapshot writes the keys onto ObservedStage.terminalFinals — the same shape
// as ObservedFixture.declared, an engine-derived expectation carried as data —
// and I2 judges that data.
import { generateDoubleElim, generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";

/** The bracket kinds whose champion is the winner of a terminal final
 *  (ruling 45). invariants.test.ts holds it equal to I2's stage kinds minus
 *  knockout, so the snapshot and I2 cannot disagree on which stages carry the
 *  keys. */
export const STRUCTURAL_FINAL_KINDS: readonly string[] = Object.freeze(["double_elim", "stepladder", "page_playoff"]);

/** The terminal final is the engine's own `isFinal` fixture for this bracket
 *  shape — never a key table typed here. The ids are the product's ext_keys
 *  (usecases/stages.ts bracketToGen: `extKey: f.id`). Engine order is kept:
 *  gf before gf-reset. Only the field's SIZE shapes the keys, and the
 *  generators refuse a size they cannot lay out (a page playoff of anything
 *  but 4 throws CONFIG_INVALID), exactly as the product's Start does. */
export function terminalFinalKeys(kind: string, field: readonly string[], config: Record<string, unknown>): readonly string[] {
  const finals = (fx: readonly { id: string; isFinal?: boolean }[]) => fx.filter((f) => f.isFinal === true).map((f) => f.id);
  switch (kind) {
    case "page_playoff": return finals(generatePagePlayoff({ entrants: [...field] }).fixtures);
    case "stepladder": return finals(generateStepladder({ entrants: [...field] }).fixtures);
    case "double_elim": return finals(generateDoubleElim({ entrants: [...field], bracketReset: config.bracketReset === true }).fixtures);
    default: throw new Error(`invariants: '${kind}' has no structural final (knockout keeps the unbeaten rule)`);
  }
}
