// W5 app PR A, Task 3 (X-SF-4, FX-G21; owner R24 pick 4 option A): "Sits out: Eve" on a round of a round-robin stage - the desk run
// sheet's round bar and the public fixtures list. One pure module both read, so the two surfaces cannot disagree.
//
// The fact is `stages.config.round_byes` (written by Generate from the engine's own `rounds[].bye`, never derived from who is
// missing after a roster change). A withdrawn or disqualified entrant is not named: her bye is a round she was never going to
// sit out of. Client-safe and strip-types-safe: no import.

/** One stored bye, as `config.round_byes` holds it. */
export interface SitsOutBye {
  round_no: number;
  entrant_id: string;
}

/** The stage's recorded byes out of its `config`, or [] when it has none (a stage drawn before W5, a knockout, a Swiss stage). A
 *  malformed value reads as none, as the server's own reader does. */
export function sitsOutByesOf(config: unknown): SitsOutBye[] {
  const raw = typeof config === "object" && config !== null ? (config as { round_byes?: unknown }).round_byes : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is SitsOutBye => typeof b === "object" && b !== null && typeof (b as SitsOutBye).entrant_id === "string" && Number.isInteger((b as SitsOutBye).round_no),
  );
}

/**
 * round_no -> the names that sit it out, in the order the byes are stored (a round of a several-pool group may name one per pool).
 * An id with no name (a setup stage's seat id, `slot:N`) is not named, and a `departed` id is not named: the line is dropped
 * with it, so a round with nobody left to name has no line at all.
 *
 * `departed` is who has left the field - the CALLER's set, from the one place that spells the departed vocabulary (the console
 * page's `activeEntrantIds` complement, the public page's `DEPARTED_STATUS_CHIPS`); this module spells no status.
 */
export function sitsOutByRound(
  byes: readonly SitsOutBye[],
  names: Readonly<Record<string, string>>,
  departed: ReadonlySet<string>,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const b of byes) {
    const name = names[b.entrant_id];
    if (name === undefined || departed.has(b.entrant_id)) continue;
    const list = out.get(b.round_no) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(b.round_no, list);
  }
  return out;
}
