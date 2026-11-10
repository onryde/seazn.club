// W4 app-A Task 4 (K3, X-RB-1): the engine's own single-elimination bracket (`generateSingleElim` declares the shape —
// pre-flight R9), stored the way the app stores it (usecases/stages/generators.ts `bracketToGen`: `round_no` = the engine's round + 1,
// `seq_in_round` counted per round in emission order, `ext_key` = the engine's id). Each row also carries what the
// ENGINE says about it, so a test's expected values come from the engine, never from the role key under test:
//   - `isFinal` / `thirdPlace` — the engine's flags;
//   - `bye` — the engine baked an `award` on it (a bye line, isByeLine's system-bye arm once stored);
//   - `path` — its route to the final through the engine's winner feeds: "" for the final, "H"/"A" for the semi-final
//     feeding the final's home/away seat, "HA" for the line feeding the home semi-final's away seat, and so on; "3p" for
//     the third-place match (fed by losers).
import { generateSingleElim } from "@seazn/engine/scheduling";

export interface EngineBracketRow {
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  ext_key: string;
  isFinal: boolean;
  thirdPlace: boolean;
  bye: boolean;
  path: string;
}

export function engineBracketRows(n: number, thirdPlace: boolean, pool: string | null = null): EngineBracketRow[] {
  const bracket = generateSingleElim({ entrants: Array.from({ length: n }, (_, i) => `e${i + 1}`), thirdPlace });
  const byId = new Map(bracket.fixtures.map((f) => [f.id, f]));
  const path = new Map<string, string>();
  const finals = bracket.fixtures.filter((f) => f.isFinal === true);
  if (finals.length !== 1) throw new Error(`engineBracketRows: the engine declared ${finals.length} finals for n=${n}`);
  const queue: [string, string][] = [[finals[0]!.id, ""]];
  while (queue.length > 0) {
    const [id, p] = queue.shift()!;
    path.set(id, p);
    const f = byId.get(id)!;
    if (f.homeFrom?.side === "winner") queue.push([f.homeFrom.fixtureId, `${p}H`]);
    if (f.awayFrom?.side === "winner") queue.push([f.awayFrom.fixtureId, `${p}A`]);
  }
  for (const f of bracket.fixtures) if (f.thirdPlace === true) path.set(f.id, "3p");
  const counters = new Map<number, number>();
  return bracket.fixtures.map((f) => {
    const round_no = f.round + 1;
    const seq = (counters.get(round_no) ?? 0) + 1;
    counters.set(round_no, seq);
    const p = path.get(f.id);
    if (p === undefined) throw new Error(`engineBracketRows: ${f.id} feeds neither the final nor the third place`);
    return {
      pool_id: pool,
      round_no,
      seq_in_round: seq,
      ext_key: f.id,
      isFinal: f.isFinal === true,
      thirdPlace: f.thirdPlace === true,
      bye: f.award !== undefined,
      path: p,
    };
  });
}
