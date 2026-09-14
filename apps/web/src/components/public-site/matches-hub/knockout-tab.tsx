"use client";
// The competition hub's Knockout tab (plan 2026-09-13, Task 2 — design rulings
// R5–R9). Every bracket stage the competition publishes, grouped under its
// division: a champion banner once the stage is won, a rail of its rounds, the
// chosen round's match cards with a line under each saying where the winner
// goes, and — on large screens, behind a switch that defaults to Rounds — a
// one-sided Draw tree.
//
// The DOCUMENT decides the bracket (`doc.knockouts`, Task 1): which stages,
// their rounds in bracket order, each round's pre-resolved label, whether a
// Draw can be drawn, and which fixture crowns the stage. Nothing here
// re-derives any of those. What this file DOES decide is written out where it
// happens, and it is six things:
//
//  • which round a rail opens on (`defaultRoundKey`), and what happens to a
//    chosen round a later poll no longer carries (`selectedRoundKey`);
//  • the "next" sentence under each card (`nextLine`);
//  • what a slot still waiting on its feeder reads (`pendingSide`);
//  • which division is showing, reconciled against the chips on screen;
//  • Rounds or Draw (`knockoutMode`);
//  • scrolling the pressed round chip into view (`revealScrollLeft`).
//
// TWO READINGS OF THE PLAN THAT HAD TO BE RESOLVED, recorded here because a
// later reader will otherwise "fix" them back:
//
//  1. R5 gives the division CHIPS the testids `mh-knockout-division-{slug}`
//     and the division HEADING `mh-knockout-division-{slug}` as well — the
//     "Which division" ruling was added after the heading rule, and the two
//     collide whenever the rail and the heading are on screen together (and a
//     division slugged `all` collides with the All chip). The chips keep the
//     ruling's ids, which mirror the Matches tab's own; the heading is
//     `mh-knockout-heading-{slug}`.
//  2. R5 puts the view switch "only when drawable", but `?view=` is ONE
//     parameter for the whole tab. Per-view switches would duplicate the same
//     two testids and toggle each other. So there is one switch, shown when
//     any bracket on screen can be drawn; a bracket that cannot be drawn
//     ignores the mode.
import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type {
  CompetitionHubDocT,
  HubMatchT,
  KnockoutRoundT,
  KnockoutViewT,
} from "@/server/public-site/competition-hub-schema";
import { MatchCard } from "./match-card";
import { HUB_RAIL_CLASS, hubChip } from "./hub-chip";
import { useSearchParam, writeDivisionParam, writeSearchParam } from "../use-tab-param";

export interface KnockoutTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  locale: Locale;
  /** `Date.now()` at render, handed to every `MatchCard` for its relative
   *  kick-off sentence — passed down, never read here, for the same
   *  hydration reason the Matches tab gives. */
  now: number;
  /** `?division=`, read by `CompetitionLanding` and written back by this tab's
   *  own division chips. A SEED: a spectator's tap wins over it, and it is
   *  honoured only while a chip for it is on screen. */
  initialDivision?: string | null;
}

/** The third-place round's key, as the builder emits it (plan R3). Restated
 *  rather than imported: every client import of `@/server/public-site/*` is
 *  `import type`, so a value cannot cross that boundary. */
const THIRD_PLACE_KEY = "third-place";

/** The status line `hubHeader` gives a forfeited fixture: `forfeited` is an
 *  `other` status, and `STATUS_LINE_KEYS` keeps its own name for it. */
const FORFEITED_STATUS_KEY = "matchCentre.status.forfeited";

/** A round-0 cell in the Draw, in px; round k is this times 2^k, so every node
 *  sits centred between the two that feed it. */
const CELL_PX = 64;

type MatchIndex = ReadonlyMap<string, HubMatchT>;

/**
 * The side that WON, or null. Two conditions, and the first is not
 * belt-and-braces: `winnerIndex` is taken straight off the stored winner and
 * is not gated on status (`match-card.tsx` writes this up for forfeits), so a
 * match still in play can carry one. "Goes through" is a statement about a
 * finished match.
 */
function winnerOf(match: HubMatchT | undefined) {
  if (match === undefined || match.bucket !== "completed" || match.winnerIndex === null) {
    return null;
  }
  return match.header.sides[match.winnerIndex];
}

/**
 * The round a rail opens on. Four rungs, the first that answers wins (Task 2
 * fix round 1, ruling 1):
 *
 *  1. the first round, in rail order, holding a LIVE fixture — what a
 *     spectator arriving mid-match came for, even when an EARLIER round still
 *     has a fixture waiting (a losers' round live beside an upcoming winners'
 *     final) or the title is already won (a bronze match played after the
 *     final was decided);
 *  2. the round holding the CHAMPION's fixture — a finished bracket opens on
 *     the round the title was won in, even when a later round never settles
 *     (a double-elimination reset nobody owes reads `scheduled` for ever);
 *  3. the first round holding a fixture that is not finished — the round due
 *     next;
 *  4. the LAST round.
 */
export function defaultRoundKey(view: KnockoutViewT, matches: MatchIndex): string {
  const holding = (test: (match: HubMatchT | undefined) => boolean) =>
    view.rounds.find((round) => round.fixtureIds.some((id) => test(matches.get(id))));
  const live = holding((match) => match?.bucket === "live");
  if (live) return live.key;
  const championId = view.championFixtureId;
  if (championId !== null) {
    const crowned = view.rounds.find((round) => round.fixtureIds.includes(championId));
    if (crowned) return crowned.key;
  }
  const open = holding((match) => match?.bucket !== "completed");
  return (open ?? view.rounds[view.rounds.length - 1]!).key;
}

/**
 * The spectator's chosen round while the document still carries it, else the
 * default. Reconciled on every render, exactly as `matches-tab.tsx` reconciles
 * its chips: the live document replaces itself on every poll, and a chosen
 * round that disappeared would otherwise leave a rail with NOTHING pressed
 * above an empty list, with no chip left to tap.
 */
function selectedRoundKey(
  view: KnockoutViewT,
  chosen: string | undefined,
  matches: MatchIndex,
): string {
  return chosen !== undefined && view.rounds.some((round) => round.key === chosen)
    ? chosen
    : defaultRoundKey(view, matches);
}

export type KnockoutMode = "rounds" | "draw";

/**
 * Rounds or Draw: a tap wins; otherwise only the exact value `draw` in the URL
 * opens the Draw.
 *
 * The tap is held as state rather than read back from the URL because the
 * write is `replaceState`, which fires no `popstate` — so the store would not
 * re-render on it. The echo that write creates is harmless here: the state it
 * would be mistaken for is the same value.
 */
export function knockoutMode(tapped: KnockoutMode | null, fromUrl: string | null): KnockoutMode {
  if (tapped !== null) return tapped;
  return fromUrl === "draw" ? "draw" : "rounds";
}

export type NextLineKey =
  | "knockout.next.through"
  | "knockout.next.meets"
  | "knockout.next.meetsWinnerOf"
  | "knockout.next.advances";

/**
 * The sentence under a card: where this match's winner goes.
 *
 * Only for a DRAWABLE view — the one shape where round k's fixtures `i` and
 * `i ^ 1` feed the same fixture of round k+1, which is what makes "the winner
 * meets…" true. A double-elimination or odd-sized bracket does not pair its
 * rounds that way, and a wrong "next" is worse than none. Never for the final,
 * which has no next round, nor for the third-place round, whose winner goes
 * nowhere; and the semi-finals' next round is the FINAL, stepping over the
 * third-place round the builder places between them.
 *
 * Four branches, in order: this match is decided → its winner goes through;
 * the partner is decided → the winner meets them; the partner is undecided but
 * both its sides are known → the winner meets the winner of that pair;
 * otherwise → the winner goes through. `entrantId === ""` is a slot with nobody
 * in it yet (`hubSides`, `competition-hub.ts`).
 */
export function nextLine(
  view: KnockoutViewT,
  roundKey: string,
  fixtureId: string,
  matches: MatchIndex,
): { key: NextLineKey; vars: Record<string, string> } | null {
  if (!view.drawable || roundKey === THIRD_PLACE_KEY) return null;
  const bracket = view.rounds.filter((round) => round.key !== THIRD_PLACE_KEY);
  const at = bracket.findIndex((round) => round.key === roundKey);
  const round = bracket[at];
  const next = bracket[at + 1];
  if (round === undefined || next === undefined) return null;
  const index = round.fixtureIds.indexOf(fixtureId);
  if (index < 0) return null;

  const winner = winnerOf(matches.get(fixtureId));
  if (winner) {
    return { key: "knockout.next.through", vars: { name: winner.name, round: next.label } };
  }
  const partnerId = round.fixtureIds[index ^ 1];
  const partner = partnerId === undefined ? undefined : matches.get(partnerId);
  const partnerWinner = winnerOf(partner);
  if (partnerWinner) {
    return { key: "knockout.next.meets", vars: { name: partnerWinner.name, round: next.label } };
  }
  if (partner !== undefined && partner.header.sides.every((side) => side.entrantId !== "")) {
    return {
      key: "knockout.next.meetsWinnerOf",
      vars: { a: partner.header.sides[0].name, b: partner.header.sides[1].name, round: next.label },
    };
  }
  return { key: "knockout.next.advances", vars: { round: next.label } };
}

export type PendingSideKey = "knockout.pendingPair" | "knockout.pendingLoser";

/**
 * What an EMPTY slot of a drawable bracket reads while the match that feeds
 * it is still to be decided: the two entrants who could fill it (fix round,
 * D2 — the owner-approved mock). Null leaves the slot the document's own
 * sentence, which names the feeder's round as the rail does ("Winner of
 * Quarter-finals, match 1" — `feeder-slot-label.ts`, fix round N1).
 *
 * THE FEEDER is `generateSingleElim`'s wiring, and the relationship the tree's
 * connectors already draw: bracket round k+1's fixture j is fed on side s by
 * round k's fixture 2j+s, as its WINNER. The third-place fixture is fed on
 * side s by the semi-finals' fixture s, as its LOSER — so it reads "Loser of
 * {a} v {b}": "{a} or {b}" there would be the same words as the final's slot
 * waiting on the same semi, with nothing to say one gets the winner and the
 * other the loser. Both relationships checked against two real hub documents
 * in the fix-round report.
 *
 * Four conditions, each with its own reason:
 *  • DRAWABLE only — the one shape `twoSidedBracket` has proved pairs its
 *    rounds this way. A double-elimination or odd-sized bracket does not, and
 *    a wrong pair is worse than the engine's sentence.
 *  • the slot is EMPTY (`entrantId === ""`). A filled slot is the real entrant.
 *  • the feeder is NOT decided (`bucket !== "completed"`): live, or still to
 *    play. A decided feeder has filled the slot already; one that ended with
 *    nobody through (abandoned, cancelled) never will, and a pair would
 *    promise that it might.
 *  • BOTH of the feeder's sides are known. A feeder still waiting on a slot of
 *    its own, or a bye's empty side, is not a pair of entrants.
 */
export function pendingSide(
  view: KnockoutViewT,
  fixtureId: string,
  side: 0 | 1,
  matches: MatchIndex,
): { key: PendingSideKey; vars: { a: string; b: string } } | null {
  if (!view.drawable) return null;
  const slot = matches.get(fixtureId)?.header.sides[side];
  if (slot === undefined || slot.entrantId !== "") return null;

  const bracket = view.rounds.filter((round) => round.key !== THIRD_PLACE_KEY);
  const third = view.rounds.find((round) => round.key === THIRD_PLACE_KEY);
  let feederId: string | undefined;
  let key: PendingSideKey;
  if (third !== undefined && third.fixtureIds.includes(fixtureId)) {
    const semis = bracket[bracket.length - 2];
    feederId = semis?.fixtureIds[2 * third.fixtureIds.indexOf(fixtureId) + side];
    key = "knockout.pendingLoser";
  } else {
    const at = bracket.findIndex((round) => round.fixtureIds.includes(fixtureId));
    // Not in the bracket, or in round 0: nothing feeds it.
    if (at < 1) return null;
    feederId = bracket[at - 1]!.fixtureIds[2 * bracket[at]!.fixtureIds.indexOf(fixtureId) + side];
    key = "knockout.pendingPair";
  }

  const feeder = feederId === undefined ? undefined : matches.get(feederId);
  if (feeder === undefined || feeder.bucket === "completed") return null;
  const [a, b] = feeder.header.sides;
  if (a.entrantId === "" || b.entrantId === "") return null;
  return { key, vars: { a: a.name, b: b.name } };
}

/**
 * `match` with each waiting side renamed per `pendingSide`, for the two places
 * a side's name is shown — the Draw's node and the Rounds list's card — so the
 * two can never disagree. The SAME object when neither side changes. The side
 * keeps `entrantId === ""`, so every reader that asks "is anyone here yet"
 * (the node's muted style, `MatchCard`'s placeholder crest, `nextLine`) still
 * gets the true answer.
 */
function withPendingSides(
  view: KnockoutViewT,
  match: HubMatchT,
  matches: MatchIndex,
  dict: PublicDict,
): HubMatchT {
  const nameOf = (side: 0 | 1) => {
    const pending = pendingSide(view, match.fixtureId, side, matches);
    return pending === null ? null : t(dict, pending.key, pending.vars);
  };
  const names = [nameOf(0), nameOf(1)] as const;
  if (names[0] === null && names[1] === null) return match;
  const rename = (side: 0 | 1) => {
    const name = names[side];
    return name === null ? match.header.sides[side] : { ...match.header.sides[side], name };
  };
  return { ...match, header: { ...match.header, sides: [rename(0), rename(1)] } };
}

/**
 * The `scrollLeft` that brings a chip fully into a horizontally scrolling
 * rail's visible window, moving the rail as little as possible — and not at
 * all when the chip is already visible.
 *
 * Both boxes in VIEWPORT coordinates (`getBoundingClientRect`); `width` is the
 * rail's `clientWidth`, and the paddings are the rail's own, so a chip is
 * brought in clear of the phone gutter the rail bleeds into. A chip wider than
 * the window shows its start. Never `scrollIntoView`: that also scrolls the
 * PAGE to the rail, which is not what a round tap asked for.
 *
 * Pure so every arm is unit-testable; the element reads and the write live in
 * the layout effect below, which only a browser can run.
 */
export function revealScrollLeft(
  rail: { scrollLeft: number; left: number; width: number; padStart: number; padEnd: number },
  chip: { left: number; width: number },
): number {
  const start = rail.left + rail.padStart;
  const end = rail.left + rail.width - rail.padEnd;
  let next = rail.scrollLeft;
  if (chip.left < start) {
    next -= start - chip.left;
  } else if (chip.left + chip.width > end) {
    next += Math.min(chip.left + chip.width - end, chip.left - start);
  }
  return Math.max(0, next);
}

/** The divisions that have a bracket, first-appearance order — and only when
 *  there are at least two, because one division is no choice. ONE list, read
 *  by the rail AND by the reconciliation, so a chosen division can never be
 *  honoured without a chip on screen that clears it (the Matches tab's review
 *  F2, which found the two written separately). */
function divisionChoices(views: readonly KnockoutViewT[]): { slug: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const view of views) {
    if (!seen.has(view.divisionSlug)) seen.set(view.divisionSlug, view.divisionName);
  }
  return seen.size > 1 ? [...seen].map(([slug, name]) => ({ slug, name })) : [];
}

/** Views under one entry per division, first-appearance order — by a map on
 *  `divisionId`, for the reason `table-tab.tsx`'s `byDivision` gives. */
function byDivision(views: readonly KnockoutViewT[]): KnockoutViewT[][] {
  const groups = new Map<string, KnockoutViewT[]>();
  for (const view of views) {
    const group = groups.get(view.divisionId);
    if (group) group.push(view);
    else groups.set(view.divisionId, [view]);
  }
  return [...groups.values()];
}

function roundBadge(
  round: KnockoutRoundT,
  matches: MatchIndex,
  dict: PublicDict,
  pressed: boolean,
): ReactNode {
  const fixtures = round.fixtureIds.map((id) => matches.get(id));
  if (fixtures.some((match) => match?.bucket === "live")) {
    // Colour alone is not a label: the dot is decorative and a screen reader
    // hears the dictionary's "Live" beside the round's name instead.
    return (
      <>
        <span
          aria-hidden="true"
          className={`ml-2 h-2 w-2 shrink-0 rounded-full ${pressed ? "bg-emerald-300" : "bg-emerald-500"}`}
        ></span>
        <span className="sr-only">{t(dict, "knockout.liveRound")}</span>
      </>
    );
  }
  const done = fixtures.filter((match) => match?.bucket === "completed").length;
  // One string, not `{done}/{total}`: React separates adjacent text children
  // with comment nodes in server markup.
  return <span className="ml-2 text-xs opacity-80">{`${done}/${round.fixtureIds.length}`}</span>;
}

function championBanner(view: KnockoutViewT, matches: MatchIndex, dict: PublicDict): ReactNode {
  if (view.championFixtureId === null) return null;
  const final = matches.get(view.championFixtureId);
  if (final === undefined || final.winnerIndex === null) return null;
  const winner = final.header.sides[final.winnerIndex];
  const loser = final.header.sides[final.winnerIndex === 0 ? 1 : 0];
  // The label of the round that holds the crowning fixture — the same string
  // its card carries (plan R3) — so "Beat X in the Final" and "Grand final"
  // both come out of the document rather than out of an assumption.
  const roundLabel =
    view.rounds.find((round) => round.fixtureIds.includes(final.fixtureId))?.label ??
    final.roundLabel;
  return (
    <div
      data-testid={`mh-knockout-champion-${view.id}`}
      className="relative flex min-w-0 items-center gap-3 overflow-hidden rounded-2xl bg-court px-4 pb-4 pt-5 text-court-ink"
    >
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-accent"></span>
      <EntityLogo src={winner.badgeUrl} name={winner.name} colour={winner.colour} size={40} />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-court-muted">
          <svg
            width="14"
            height="12"
            viewBox="0 0 14 12"
            aria-hidden="true"
            className="shrink-0"
          >
            <path d="M1 10 0 2l4 3 3-5 3 5 4-3-1 8z" fill="currentColor" />
          </svg>
          {t(dict, "knockout.champion")}
        </p>
        {/* Wraps rather than truncates: the champion's name is the one string
            this banner exists for, and an ellipsis would hide it. */}
        <p className="break-words font-display text-2xl font-bold uppercase leading-tight">
          {winner.name}
        </p>
        {roundLabel ? (
          <p className="text-[13px] text-court-muted">
            {t(
              dict,
              // A final won by forfeit was never played, so "Beat X" would
              // report a match that did not happen.
              final.header.statusLine?.key === FORFEITED_STATUS_KEY
                ? "knockout.championLineWalkover"
                : "knockout.championLine",
              { name: loser.name, round: roundLabel },
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function drawNode(match: HubMatchT, dict: PublicDict): ReactNode {
  const live = match.bucket === "live";
  return (
    <Link
      href={match.href}
      data-testid={`mh-knockout-node-${match.fixtureId}`}
      aria-label={t(dict, "matchesHub.card.label", {
        home: match.header.sides[0].name,
        away: match.header.sides[1].name,
      })}
      className={`relative z-10 block w-full min-w-0 rounded-lg border bg-surface px-2 py-1 shadow-sm transition hover:border-accent-line ${live ? "border-emerald-400" : "border-zinc-200"}`}
    >
      {([0, 1] as const).map((i) => {
        const side = match.header.sides[i];
        const tone =
          match.winnerIndex === i
            ? "font-semibold text-ink"
            : side.entrantId === ""
              ? "italic text-ink-muted"
              : "text-ink";
        return (
          <span key={i} className="flex h-[22px] min-w-0 items-center gap-2 text-[13px]">
            <span className={`min-w-0 flex-1 truncate ${tone}`} title={side.name}>
              {side.name}
            </span>
            <span className="shrink-0 font-display text-[15px] tabular-nums text-ink">
              {match.header.scoreLines[i] ?? ""}
            </span>
          </span>
        );
      })}
    </Link>
  );
}

const COLUMN_HEAD =
  "mb-2 h-5 truncate font-display text-[13px] font-semibold uppercase leading-5 tracking-wider text-ink-muted";
// The connector strokes between a pair and the node they feed. Each sits in
// the cell's own box — half the cell tall, half the column gap wide — so the
// geometry follows the cell height with no per-round arithmetic in a class.
const CONNECTOR = "pointer-events-none absolute w-1.5 border-zinc-300";

function drawTree(view: KnockoutViewT, matches: MatchIndex, dict: PublicDict): ReactNode {
  const bracket = view.rounds.filter((round) => round.key !== THIRD_PLACE_KEY);
  const third = view.rounds.find((round) => round.key === THIRD_PLACE_KEY);
  return (
    <div data-testid={`mh-knockout-draw-${view.id}`} className="hidden lg:block">
      {/* Its own scroll region. Columns are 184px with a 12px gap, so a
          32-draw's five columns come to 968px and fit the 977px content column
          of a 1024px window with a classic 15px scrollbar; a 64-draw's six do
          not, and scroll here rather than on the page. Focusable and named,
          so a keyboard can scroll it and axe's scrollable-region rule holds
          (AGENTS.md 23). */}
      <div
        data-testid={`mh-knockout-draw-region-${view.id}`}
        role="region"
        tabIndex={0}
        aria-label={t(dict, "knockout.drawLabel")}
        className="overflow-x-auto pb-2"
      >
        <div className="flex w-max gap-3">
          {bracket.map((round, k) => {
            const cell = CELL_PX * 2 ** k;
            const last = k === bracket.length - 1;
            return (
              <div
                key={round.key}
                data-testid={`mh-knockout-col-${view.id}-${round.key}`}
                className="w-[184px] shrink-0"
              >
                <p className={COLUMN_HEAD}>{round.label}</p>
                <div>
                  {round.fixtureIds.map((id, i) => {
                    const match = matches.get(id);
                    return (
                      <div key={id} className="relative flex items-center" style={{ height: cell }}>
                        {last ? null : i % 2 === 0 ? (
                          <span
                            aria-hidden="true"
                            className={`${CONNECTOR} left-full top-1/2 h-1/2 rounded-tr-md border-r-2 border-t-2`}
                          ></span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className={`${CONNECTOR} bottom-1/2 left-full h-1/2 rounded-br-md border-b-2 border-r-2`}
                          ></span>
                        )}
                        {k > 0 ? (
                          <span
                            aria-hidden="true"
                            className={`${CONNECTOR} right-full top-1/2 border-t-2`}
                          ></span>
                        ) : null}
                        {match ? drawNode(withPendingSides(view, match, matches, dict), dict) : null}
                      </div>
                    );
                  })}
                </div>
                {last && third ? (
                  <div className="mt-4">
                    <p className={COLUMN_HEAD}>{third.label}</p>
                    {third.fixtureIds.map((id) => {
                      const match = matches.get(id);
                      return match ? (
                        <div key={id} className="relative flex items-center" style={{ height: CELL_PX }}>
                          {drawNode(withPendingSides(view, match, matches, dict), dict)}
                        </div>
                      ) : null;
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function KnockoutTab({ doc, dict, locale, now, initialDivision }: KnockoutTabProps) {
  const [chosenDivision, setDivision] = useState<string | null>(initialDivision ?? null);
  // Per VIEW id: a spectator reading the Final of one bracket and the
  // quarter-finals of another keeps both.
  const [chosenRounds, setChosenRounds] = useState<Record<string, string>>({});
  const [tappedMode, setTappedMode] = useState<KnockoutMode | null>(null);
  const mode = knockoutMode(tappedMode, useSearchParam("view"));
  const rails = useRef(new Map<string, HTMLDivElement>());

  const matches: MatchIndex = new Map(doc.matches.map((match) => [match.fixtureId, match]));
  const divisions = divisionChoices(doc.knockouts);
  // Reconciled against the CHIPS on screen: an unknown slug, a bare
  // `?division=` (the empty string), and a division chosen while there is no
  // rail all fall back to All — the one choice nothing on screen can strand.
  const division = divisions.some((d) => d.slug === chosenDivision) ? chosenDivision : null;
  const shown = doc.knockouts.filter((view) => division === null || view.divisionSlug === division);
  const selected = new Map(
    shown.map((view) => [view.id, selectedRoundKey(view, chosenRounds[view.id], matches)]),
  );

  // The pressed chip is scrolled into its rail on mount and whenever which
  // chip is pressed changes — a finished draw opens on its Final, the LAST
  // chip, which is off-screen on a phone. Keyed on the pressed set (and the
  // mode, which shows the rail again) rather than on every render, so a live
  // poll never snaps a rail the spectator has scrolled by hand.
  //
  // BROWSER-ONLY AND UNIT-UNTESTABLE: refs never attach under
  // `renderToStaticMarkup` or `_hook-harness`, so the map is empty in every
  // unit test and this loop does nothing there. `revealScrollLeft`'s
  // arithmetic is pinned as a pure function; that the rail really moves is
  // Task 3's e2e.
  const pressedKey = [...selected].map(([id, key]) => `${id}:${key}`).join("|");
  useLayoutEffect(() => {
    for (const rail of rails.current.values()) {
      const chip = rail.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (chip === null) continue;
      const box = rail.getBoundingClientRect();
      const style = window.getComputedStyle(rail);
      rail.scrollLeft = revealScrollLeft(
        {
          scrollLeft: rail.scrollLeft,
          left: box.left,
          width: rail.clientWidth,
          padStart: Number.parseFloat(style.paddingLeft) || 0,
          padEnd: Number.parseFloat(style.paddingRight) || 0,
        },
        chip.getBoundingClientRect(),
      );
    }
  }, [pressedKey, mode]);

  if (doc.knockouts.length === 0) {
    // Unreachable through the hub — `deriveHubTabs` offers no Knockout tab
    // without a view — so this is a direct render or a stale deep link. The
    // root stays, so the panel handle exists on every arm.
    return <div data-testid="mh-knockout" className="min-w-0"></div>;
  }

  const chooseDivision = (slug: string | null) => {
    setDivision(slug);
    writeDivisionParam(slug);
  };
  const chooseMode = (next: KnockoutMode) => {
    setTappedMode(next);
    // Rounds is the default, so it takes the parameter out rather than
    // writing `view=rounds` into every link a spectator copies.
    writeSearchParam("view", next === "draw" ? "draw" : null);
  };
  const chooseRound = (viewId: string, key: string) => {
    setChosenRounds((previous) => ({ ...previous, [viewId]: key }));
  };
  // Whether the Rounds/Draw switch exists: some bracket on screen can be drawn.
  const canDraw = shown.some((view) => view.drawable);
  const viewSwitch = canDraw ? (
    // Hidden below the large breakpoint, where there is no Draw to switch
    // to: a `?view=draw` link opened on a phone shows Rounds.
    <div
      data-testid="mh-knockout-view"
      role="group"
      aria-label={t(dict, "knockout.view.label")}
      className="flex shrink-0 gap-2 max-lg:hidden"
    >
      {hubChip("mh-knockout-view-rounds", t(dict, "knockout.view.rounds"), mode === "rounds", () =>
        chooseMode("rounds"),
      )}
      {hubChip("mh-knockout-view-draw", t(dict, "knockout.view.draw"), mode === "draw", () =>
        chooseMode("draw"),
      )}
    </div>
  ) : null;

  return (
    <div data-testid="mh-knockout" className="min-w-0 space-y-6">
      {/* ONE toolbar row at lg (fix round, C2): the division chips on the
          left when there is a rail, else the one division's heading (below,
          in its section); the switch on the right. It used to sit on a row
          of its own, a ~70px band.

          Both bars carry `lg:` classes only, so below lg each is a plain
          block and the panel lays out exactly as before. And neither ever
          holds the switch ALONE: the root spaces every child but its last,
          and a visible wrapper whose only content is hidden below lg would
          keep that margin as a blank band on every phone. Beside the switch
          there is always the rail or the heading, both always shown. */}
      {divisions.length > 0 ? (
        <div
          data-testid="mh-knockout-toolbar"
          className="lg:flex lg:items-start lg:justify-between lg:gap-4"
        >
          <div
            data-testid="mh-knockout-divisions"
            role="group"
            tabIndex={0}
            aria-label={t(dict, "matchesHub.divisionsLabel")}
            className={HUB_RAIL_CLASS}
          >
            {hubChip("mh-knockout-division-all", t(dict, "matchesHub.division.all"), division === null, () =>
              chooseDivision(null),
            )}
            {divisions.map((d) =>
              hubChip(`mh-knockout-division-${d.slug}`, d.name, division === d.slug, () =>
                chooseDivision(d.slug),
              ),
            )}
          </div>
          {viewSwitch}
        </div>
      ) : null}

      {byDivision(shown).map((views) => {
        const first = views[0]!;
        return (
          <section key={first.divisionId} className="min-w-0 space-y-4">
            <div
              data-testid={`mh-knockout-titlebar-${first.divisionSlug}`}
              className="lg:flex lg:items-center lg:justify-between lg:gap-4"
            >
              <h2
                data-testid={`mh-knockout-heading-${first.divisionSlug}`}
                className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl"
              >
                {first.divisionName}
              </h2>
              {/* With no division rail there is exactly one division, so this
                  is the one heading on the tab and the switch's only row. */}
              {divisions.length > 0 ? null : viewSwitch}
            </div>
            {views.map((view) => {
              const roundKey = selected.get(view.id)!;
              const round = view.rounds.find((r) => r.key === roundKey)!;
              const drawn = mode === "draw" && view.drawable;
              return (
                // A flex GAP, not `space-y-3`: with the Draw open, the tree is
                // the last child and is not rendered below lg, and `space-y`
                // still put its margin under the rounds block — 12px of
                // nothing on every phone. A gap only sits between boxes that
                // exist.
                <section
                  key={view.id}
                  data-testid={`mh-knockout-stage-${view.id}`}
                  className="flex min-w-0 flex-col gap-3"
                >
                  <h3 className="font-display text-lg font-semibold text-ink">{view.stageName}</h3>
                  {championBanner(view, matches, dict)}
                  <div
                    data-testid={`mh-knockout-rounds-${view.id}`}
                    className={drawn ? "min-w-0 space-y-3 lg:hidden" : "min-w-0 space-y-3"}
                  >
                    <div
                      data-testid={`mh-knockout-rail-${view.id}`}
                      role="group"
                      tabIndex={0}
                      aria-label={t(dict, "knockout.roundsLabel")}
                      className={HUB_RAIL_CLASS}
                      ref={(el) => {
                        if (el) rails.current.set(view.id, el);
                        else rails.current.delete(view.id);
                      }}
                    >
                      {view.rounds.map((r) =>
                        hubChip(
                          `mh-knockout-round-${view.id}-${r.key}`,
                          <>
                            {r.label}
                            {roundBadge(r, matches, dict, r.key === roundKey)}
                          </>,
                          r.key === roundKey,
                          () => chooseRound(view.id, r.key),
                        ),
                      )}
                    </div>
                    {/* Two-up from `md`, as the Matches tab lays out the same
                        cards; each cell can shrink, because a grid item
                        defaults to its content's width and the card truncates
                        its own strings. */}
                    <ul className="grid gap-3 md:grid-cols-2" role="list">
                      {round.fixtureIds.map((id) => {
                        const match = matches.get(id);
                        if (match === undefined) return null;
                        const line = nextLine(view, round.key, id, matches);
                        return (
                          <li key={id} className="min-w-0 space-y-1">
                            {/* No round caption (fix round, D1): the stage's
                                heading and the pressed round chip right
                                above already name both. */}
                            <MatchCard
                              match={withPendingSides(view, match, matches, dict)}
                              dict={dict}
                              locale={locale}
                              now={now}
                              showDivision={false}
                              showRound={false}
                            />
                            {line ? (
                              <p
                                data-testid={`mh-knockout-next-${id}`}
                                className="flex min-w-0 gap-1.5 px-3 text-xs text-ink-muted"
                              >
                                <span aria-hidden="true">→</span>
                                <span className="min-w-0">{t(dict, line.key, line.vars)}</span>
                              </p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {drawn ? drawTree(view, matches, dict) : null}
                </section>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
