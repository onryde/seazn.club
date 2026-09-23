// The round-code chip (schedule-board knockout round codes, design review
// 2026-09-23, owner-approved): ONE presentational piece rendered by both the
// card's meta line (fixture-block.tsx) and the round legend (board-legend.tsx),
// so the key can never drift from the thing it explains.
//
// Emphasis is one step, no more: a bracket-role code ("QF", "WB2") reads
// semibold in a stronger ink token than a plain "R{n}", which keeps the meta
// line's own `text-slate-500`. No fill, no new hue, no icon — the division
// badge (solid accent fill, white ink) stays the loudest thing on the card.
// No line-height either: the chip inherits the meta line's, so a card is
// exactly as tall as it was before the chip existed.

const BASE = "text-[10px] tabular-nums";
const KNOCKOUT = "font-semibold text-slate-700";
const PLAIN = "text-slate-500";

export function RoundCodeChip({
  code,
  knockout,
  title,
  testId,
}: {
  code: string;
  /** A bracket-role code (the heavier variant); false for a plain "R{n}". */
  knockout: boolean;
  /** The long round name, for the card's tooltip. */
  title?: string;
  /** The card's `board-round-code`; the legend passes none. */
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-round-code-chip={knockout ? "knockout" : "plain"}
      title={title}
      className={`${BASE} ${knockout ? KNOCKOUT : PLAIN}`}
    >
      {code}
    </span>
  );
}
