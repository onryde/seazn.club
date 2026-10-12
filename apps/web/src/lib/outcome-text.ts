// The organiser's one-line result ("Bears of Brockley won (w/o)") — the division page's run sheet and the fixture
// console read it from here, so the two cannot word one result two ways (W2b loop H F2). Moved verbatim from
// `components/v2/stages-panel.tsx`, which re-exports it for its existing importers. Client-safe: no `server-only`.
import type { MessageKey } from "@/lib/messages";
import { NO_LEDGER, forfeitTag, type ForfeitLedger } from "@/lib/forfeit-tag";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

// EXPORTED (Competition Desk W2, Task 4/R13) — `run-sheet-row.tsx` reuses
// this same derivation rather than a second copy.
//
// W2b Task 13 (spec §5.5, UI-2): a credited result carries its tag — `forfeitTag` is the one reader, and `ledger` is
// the row's active abandon (`forfeitLedgerOfReason(fixture.abandon_reason)`; absent ⇒ none, never the status). A winner
// reads "{name} won (w/o)" / "(ret.)" / "(DQ)" / "(Aband. · DLS)"; a double walkover, which has no winner, reads its
// tag alone ("2× w/o" — before W2b it read nothing); a level abandon its level word and the tag. A bye keeps today's
// "won (w/o)" (no tag: `schedule.outcome.wonWo` below). The tags are ui.json's copies of public.json's, word for word
// (forfeit-tag.test.ts), so the organiser and the spectator read one abbreviation.
export function outcomeText(
  msg: Msg,
  outcome: unknown,
  entrantNames: Record<string, string>,
  ledger: ForfeitLedger = NO_LEDGER,
): string | null {
  const o = outcome as { kind?: string; winner?: string } | null;
  if (!o?.kind) return null;
  const winner = entrantNames[o.winner ?? ""] ?? "?";
  const tag = forfeitTag(outcome, ledger);
  if (tag !== null) {
    const word = msg(tag.tagKey);
    if (tag.kind === "double_walkover") return word;
    if (o.kind === "win" || o.kind === "award") return msg("schedule.outcome.wonTagged", { name: winner, tag: word });
    const level = outcomeText(msg, outcome, entrantNames);
    return level === null ? word : `${level} · ${word}`;
  }
  switch (o.kind) {
    case "win":
      return msg("schedule.outcome.won", { name: winner });
    case "award":
      return msg("schedule.outcome.wonWo", { name: winner });
    case "draw":
      return msg("schedule.outcome.draw");
    case "tie":
      return msg("schedule.outcome.tie");
    case "no_result":
      return msg("schedule.outcome.noResult");
    default:
      return null;
  }
}

/** A character no dictionary and no entrant name carries (Unicode private use), standing in for the winner's name so
 *  the template's own words can be found either side of it. */
const NAME_MARK = String.fromCharCode(0xe000);

/**
 * W2b loop H F1 (controller ruling: the result tag never truncates) — `outcomeText`, cut where the winner's name ENDS.
 * `lead` is everything up to and including the name, the part a narrow line may truncate; `tail` is the rest — " won
 * (w/o)", " a gagné (forf.)" — which it never does. The cut is found by rendering the SAME template with the name
 * swapped for a mark, so it holds for any locale's word order. A result that names nobody ("2× w/o", "Draw · Aband.")
 * is all tail. `lead + tail` is always `outcomeText`'s string, character for character.
 */
export function outcomeTextParts(
  msg: Msg,
  outcome: unknown,
  entrantNames: Record<string, string>,
  ledger: ForfeitLedger = NO_LEDGER,
): { lead: string; tail: string } | null {
  const winnerId = (outcome as { winner?: unknown } | null)?.winner;
  const key = typeof winnerId === "string" ? winnerId : "";
  const marked = outcomeText(msg, outcome, { ...entrantNames, [key]: NAME_MARK }, ledger);
  if (marked === null) return null;
  const at = marked.indexOf(NAME_MARK);
  if (at === -1) return { lead: "", tail: marked };
  return { lead: marked.slice(0, at) + (entrantNames[key] ?? "?"), tail: marked.slice(at + NAME_MARK.length) };
}

/**
 * A line that ENDS with a result's `tail`, cut in two: the part that may truncate and the tail that may not. Anything
 * else — no tail, or a line that does not end with it — is all `lead`, exactly as it read before. The whitespace
 * before the tail travels WITH it: the lead renders `white-space: nowrap`, which drops a space that ends its box (a
 * result naming nobody read "forfeited ·2× w/o"); the tail renders `whitespace-pre`, which keeps it.
 */
export function splitResultTail(line: string, tail: string | null | undefined): { lead: string; tail: string } {
  if (!tail || !line.endsWith(tail)) return { lead: line, tail: "" };
  const before = line.slice(0, line.length - tail.length);
  const lead = before.trimEnd();
  return { lead, tail: before.slice(lead.length) + tail };
}
