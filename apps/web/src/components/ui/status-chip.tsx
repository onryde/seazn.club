// Status-chip vocabulary (v3/03 §1): the ONE way lifecycle state renders —
// cards, page headers, fixture rows. Copy comes from lib/messages so the
// vocabulary is a data table, not scattered class strings.
import { type MessageKey } from "@/lib/messages";
import { chipShowsCount } from "@/lib/public-site";
import { msgFor } from "@/lib/messages-i18n";
import type { Locale } from "@/lib/i18n-constants";

export type ChipState =
  | "draft"
  | "registration"
  | "in_progress"
  | "scheduled"
  | "live"
  | "completed"
  | "archived"
  | "frozen";

/** The chip's colour recipes. Exported so a chip that is not a competition's (the Sponsors tab's deal chip) wears the SAME
 *  vocabulary instead of inventing colours of its own. */
export const CHIP_STYLE: Record<ChipState, string> = {
  draft: "bg-slate-100 text-slate-600",
  registration: "border border-purple-300 bg-white text-purple-700",
  // UI5 item 6: under way, nothing on court this minute - the floodlit chip's lime, unlit and without its pulse.
  in_progress: "border border-lime-600/40 bg-lime-50 text-lime-900",
  scheduled: "border border-purple-200 bg-purple-50 text-purple-700",
  // Floodlit scorebug (floodlit-console spec §5): lime-on-night 10.7:1.
  live: "bg-night text-lime-400 ring-1 ring-inset ring-lime-400/40",
  completed: "bg-slate-100 text-slate-500",
  archived: "border border-slate-200 bg-transparent text-slate-400",
  frozen: "bg-sky-100 text-sky-700",
};

const CHIP_KEY: Record<ChipState, MessageKey> = {
  draft: "chip.draft",
  registration: "chip.registration",
  in_progress: "chip.inProgress",
  scheduled: "chip.scheduled",
  live: "chip.live",
  completed: "chip.completed",
  archived: "chip.archived",
  frozen: "chip.frozen",
};

/** Sort weight: Live first, then Registration open, In progress, Draft, rest (v3/03 §2; UI5 item 6). */
export const CHIP_SORT: Record<ChipState, number> = {
  live: 0,
  registration: 1,
  in_progress: 2,
  scheduled: 3,
  draft: 4,
  completed: 5,
  frozen: 5,
  archived: 6,
};

/** What a competition's divisions say, the card chip's input (`listCompetitionCardStats` reads every field in its one
 *  query for the whole list). Archived divisions count for none of it. */
export interface CompetitionChipSignals {
  /** Matches on court now. */
  inPlay: number;
  /** Any division's registration window open (the competition page's own predicate, card-stats.ts). */
  registrationOpen: boolean;
  divisions: number;
  /** Divisions started and not finished (`status = 'active'`). */
  divisionsActive: number;
  divisionsCompleted: number;
  /** Results in (card-stats' PLAYED). */
  played: number;
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

/** Whether a competition is over: every division completed (none counted when there are none), or the organiser's own
 *  "completed". The chip's Completed rung and the org home's Finished band (`homeGroupOf`, UI5 fix round 1, review m5) -
 *  ONE predicate, so a card never reads Completed while it sits in "Under way". */
export function competitionCompleted(status: string, s: Pick<CompetitionChipSignals, "divisions" | "divisionsCompleted">): boolean {
  return (s.divisions > 0 && s.divisionsCompleted === s.divisions) || status === "completed";
}

/** A competition card's chip (UI5 item 6, owner 2026-11-03: "why does it saying registration open even though no
 *  registration opened in division level"). Read off its DIVISIONS, never `competitions.status` alone - "published" means
 *  public, not taking sign-ups. Archived; then a match in play is Live; a division's registration window open is
 *  Registration open; every division completed (or the organiser's own "completed") is Completed; a division started or a
 *  result in is In progress; else Draft. Signals no read can produce are refused, never printed as a chip. */
export function competitionChipState(
  status: string,
  s: CompetitionChipSignals,
  opts: { archived?: boolean } = {},
): ChipState {
  if (![s.inPlay, s.divisions, s.divisionsActive, s.divisionsCompleted, s.played].every(isCount)) {
    throw new RangeError(`competition chip signals must be whole counts: ${JSON.stringify(s)}`);
  }
  if (s.divisionsActive + s.divisionsCompleted > s.divisions) {
    throw new RangeError(`more divisions started or finished than exist: ${JSON.stringify(s)}`);
  }
  if (opts.archived || status === "archived") return "archived";
  if (chipShowsCount(s.inPlay)) return "live";
  if (s.registrationOpen) return "registration";
  if (competitionCompleted(status, s)) return "completed";
  if (s.divisionsActive > 0 || s.played > 0) return "in_progress";
  return "draft";
}

export function divisionChipState(
  status: string,
  opts: { archived?: boolean; registrationOpen?: boolean } = {},
): ChipState {
  if (opts.archived) return "archived";
  if (status === "active") return "live";
  if (status === "completed") return "completed";
  if (status === "scheduled") return "scheduled";
  // 'setup' — registration window promotes the chip (the organiser's real state)
  return opts.registrationOpen ? "registration" : "draft";
}

/** The chip's shape: pair it with a `CHIP_STYLE` recipe. */
export const CHIP_BASE = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

export function StatusChip({
  state,
  className = "",
  locale = "en",
}: {
  state: ChipState;
  className?: string;
  /** Active locale for the chip vocabulary; server callers pass the resolved
   *  locale, everyone else gets English. */
  locale?: Locale;
}) {
  return (
    <span
      data-chip={state}
      className={`${CHIP_BASE} ${CHIP_STYLE[state]} ${className}`}
    >
      {state === "live" && (
        <span aria-hidden className="chip-pulse-dot h-1.5 w-1.5 rounded-full bg-lime-400" />
      )}
      {msgFor(locale, CHIP_KEY[state])}
    </span>
  );
}
