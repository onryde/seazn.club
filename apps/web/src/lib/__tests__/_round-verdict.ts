// What a round's refusals COME TO, as a parity oracle for the three readers of "can a round-wide +5 reach any board?" (the server's
// `extendRefusal`, Match Day's `liveExtendRefusal` per board, the Open round control's `liveRoundRefusals`): the readers hand back
// different shapes, so each is collapsed to one word and the words are compared. It was `roundWhy` (lib/checkin-extend.ts) while a round
// printed a reason in its place; nothing prints one now (B1), so the collapse lives with the only code that still asks for it: tests.
//
//   "none"   - some board would accept a press (the round has its button), or no board has a reason to speak of (no boards, or every
//              board is over: `not_playable` is silent)
//   <refusal> - every board that has a reason gives the same one
//   "mixed"  - two or more different reasons
import type { ExtendRefusal } from "@/lib/checkin-extend";

export type RoundVerdict = "none" | "mixed" | Exclude<ExtendRefusal, "not_playable">;

export function roundVerdict(refusals: Iterable<ExtendRefusal | null>): RoundVerdict {
  const spoken = new Set<Exclude<ExtendRefusal, "not_playable">>();
  for (const r of refusals) {
    if (r === null) return "none";
    if (r !== "not_playable") spoken.add(r);
  }
  if (spoken.size === 0) return "none";
  if (spoken.size > 1) return "mixed";
  return [...spoken][0]!;
}
