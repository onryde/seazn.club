// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, C18; plan 2 Task 5, mockup
// home.html "The draw"): a knockout's bracket as cards, one group per round, the final across the full width. Cards are
// named by their place in the bracket, numbered among their round's non-bye matches and not at all when a round has one
// (`fixtureLabel`, the setup preview's helper, controller ruling 2026-11-08), so the semi-finals of an 8-draw never read
// "Round 2". A winner's line is lime; a match in play carries the Live mark; a seat still waiting names its feeder in
// words (`winnerOfLabel`: "Winner of the semi-final", "Winner of match 1"), never a round code. A bye's card says so.
//
// A SERVER component over words home.tsx already resolved: no dictionary, token or database here. Two cards to a row on
// every width, as the mockup draws them; each name truncates inside its card (`min-w-0` down the chain), so a 40-character
// side never widens a 320px screen.
import { QuickMatchLiveBadge, type SeatView } from "./match-list";

export interface DrawCard {
  id: string;
  /** The card's name ("Semi-final", "Semi-final 2", "Final": `fixtureLabel`); null for a bye, which is not a match. */
  round: string | null;
  /** The round's sides-only fixture: one side goes straight through (C18, the generator's bye). */
  bye: boolean;
  isFinal: boolean;
  live: boolean;
  home: SeatView;
  away: SeatView;
  /** The score as it stands (live) or as it ended (settled); null before a match starts, and for a bye. */
  score: string | null;
}

export interface DrawRound {
  roundNo: number;
  cards: DrawCard[];
}

export function QuickMatchDraw({
  title,
  rounds,
  byeLabel,
  liveLabel,
}: {
  title: string;
  rounds: readonly DrawRound[];
  /** `bracket.slot.bye`, in the viewer's words. */
  byeLabel: string;
  liveLabel: string;
}) {
  return (
    <section data-testid="qm-draw" aria-labelledby="qm-draw-title" className="min-w-0">
      <h2
        id="qm-draw-title"
        data-testid="qm-draw-title"
        className="app-display mb-2 text-xs font-semibold tracking-[0.18em] text-[#b7aede]"
      >
        {title}
      </h2>
      <div className="flex min-w-0 flex-col gap-2">
        {rounds.map((r) => (
          <ol key={r.roundNo} className="grid min-w-0 grid-cols-2 gap-2">
            {r.cards.map((c) => (
              <QuickMatchDrawCard key={c.id} card={c} byeLabel={byeLabel} liveLabel={liveLabel} />
            ))}
          </ol>
        ))}
      </div>
    </section>
  );
}

export function QuickMatchDrawCard({ card: c, byeLabel, liveLabel }: { card: DrawCard; byeLabel: string; liveLabel: string }) {
  return (
    <li
      data-testid="qm-draw-card"
      data-fixture-id={c.id}
      data-bye={c.bye ? "true" : undefined}
      className={[
        "min-w-0 rounded-xl border px-2.5 py-2",
        c.isFinal ? "col-span-2 border-[color:var(--mk-lime)] bg-[#241650]" : "border-[#3b2a6e] bg-[rgba(36,22,80,0.75)]",
        c.bye ? "border-dashed" : "",
      ].join(" ")}
    >
      <p className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-[#8d7fc0]">
        {c.round !== null ? (
          <span data-testid="qm-draw-round" className="truncate">
            {c.round}
          </span>
        ) : null}
        {c.live ? <QuickMatchLiveBadge label={liveLabel} /> : null}
      </p>
      {seatLine(c.home)}
      {c.bye ? (
        <p className="mt-1 truncate text-[13px] text-[#8d7fc0]">{byeLabel}</p>
      ) : (
        seatLine(c.away)
      )}
      {c.score !== null ? (
        <p className="app-display mt-1 text-xs tracking-[0.04em] text-[#b7aede] [overflow-wrap:anywhere]">{c.score}</p>
      ) : null}
    </li>
  );
}

/** One side's line (a plain function, so the card's tree holds it): the name, or the feeder in words while it waits. */
function seatLine(seat: SeatView) {
  return (
    <p
      data-testid="qm-draw-seat"
      data-winner={seat.winner ? "true" : undefined}
      className={[
        "mt-1 truncate text-[13px]",
        seat.winner ? "font-semibold text-[color:var(--mk-lime)]" : seat.name === null ? "text-[#b7aede]" : "text-cream",
      ].join(" ")}
    >
      {seat.label}
    </p>
  );
}
