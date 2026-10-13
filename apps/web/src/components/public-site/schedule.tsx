"use client";
// Schedule tab (doc 09 §2): fixtures by round/date, entrant filter, decided
// scorelines from ScoreSummary.headline. Client-side filter keeps the page
// ISR-cacheable (searchParams would force dynamic rendering).
//
// Each fixture renders as a "scorebug" row — time/court rail, stacked sides,
// right-aligned per-side scores — the public site's signature element.
import Link from "next/link";
import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import type { PublicFixture } from "@/server/public-site/data";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { fmtPublicZoneAbbrev, fmtTime } from "@/lib/format";
import { dayDateShort, dayLabelLong } from "@/lib/day-label";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { msg } from "@/lib/messages";
import { unseatedForfeitLoser, type ForfeitCopy, type ForfeitWords } from "@/lib/forfeit-tag";
import { ForfeitTagChip } from "./forfeit-tag-chip";
import { bracketForfeitWords } from "@/lib/bracket-forfeit-words";
// Every word here arrives finished, in the ORG's locale (P6 fix round 1 #2,
// N1d d5, N1e e5). This is a Client Component ("use client" above) with no
// locale or <DictProvider> in its tree, and msgFor() carries `server-only`, so
// it resolves no phrase itself. Its two SERVER callers (the division page's
// schedule tab and the embed schedule widget) already hold
// `org.default_locale` and hand down, as plain props:
// - `slotLabels`: every unfilled slot's text, keyed `${fixtureId}:home` /
//   `${fixtureId}:away`, from the public round namer (same shape as
//   `entrantNames`, a pre-resolved Record<string,string>);
// - `roundLabels`: every fixture's round name, for the round view;
// - `stageNames`: every stage's name, which heads a round view group that two
//   stages would otherwise name identically (N1f f2);
// - `copy`: every other phrase — the row rail's Live / Ended / TBD, the
//   filter's label and first option, the view toggle and its group name, the
//   calendar link, the zone caption, the untimed day heading and the empty
//   state (`publicScheduleCopy`);
// - `locale`: the org's locale, which writes the day headings and the round
//   view's short rail date.
// The language is the org's, never the visitor's: both pages are ISR. `msg()`
// stays ONLY as the last-resort, English, fallback for a slot name
// `slotLabels` should always carry (this file's "never throws" convention).

interface Props {
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  divisionPath: string; // /{org}/{comp}/{div}
  /** Venue zone (schedule_settings.tz) — times + day grouping are venue-local,
   *  the same for every viewer (spec 2026-07-14 two-lane, venue authoritative). */
  tz: string;
  /** Pre-resolved, ORG-LOCALE slot-label text for every fixture with an
   *  unfilled slot (V360/V362 home/away_slot_label) — built server-side by
   *  the caller, keyed `${fixture.id}:home` / `${fixture.id}:away`. Absent
   *  for a filled slot (real entrant). */
  slotLabels: Record<string, string>;
  /** N1d d5 — every fixture's round NAME in the org's locale ("Semi-finals",
   *  "Losers' round 1"), keyed by fixture id, from the public round namer
   *  (`publicRoundNamer`, the hub rail's own label). The round view groups and
   *  heads by it, so a page playoff's Qualifier 1 and Eliminator, which share
   *  a round_no, are two groups. Built server-side by the caller. */
  roundLabels: Record<string, string>;
  /** N1e e1 — each stage's `seq`, keyed by stage id. `round_no` restarts in
   *  every stage, so the round view orders its groups by stage first. A stage
   *  missing here sorts after every stage that is present. */
  stageOrder: Record<string, number>;
  /** N1f f2 — each stage's NAME, keyed by stage id. Two stages in one division
   *  can produce the same round name (a knockout and its plate both end in a
   *  "Final"); the round view names the stage in front of those headings, and
   *  ONLY those. Already in the org's locale, like everything else here; a
   *  stage missing from the map keeps the bare round name. */
  stageNames: Record<string, string>;
  /** N1d d5, N1e e5 — every phrase this client component cannot resolve
   *  itself, in the org's locale, built server-side by the caller. */
  copy: ScheduleCopy;
  /** N1e e5 — the org's locale ("en", "es", …): the day headings and the
   *  round view's short rail date are written in it. */
  locale: string;
  /** T16 fix round 1, I4 — an online chess division's watch links (canvas WatchStatesDesktop A): keyed by fixture
   *  id, a board with nothing to watch absent, with their words in the org's locale. Absent for every other
   *  division (and in the embed). Each is a LABEL inside the row's own link — the row already opens the fixture
   *  page, where the watch panel is — so there is never a link inside a link. */
  watch?: {
    links: Record<string, PublicWatchLink>;
    copy: ScheduleWatchCopy;
    /** V4 (T17 fix round 4): each board still to be played whose round is open, by fixture id — the moment it opened.
     *  A board with no scheduled time shows it in the rail where it said "TBD". */
    roundOpenedAt?: Record<string, string>;
  };
}

/** The watch links' words (I4), in the org's locale. */
export interface ScheduleWatchCopy {
  live: string;
  final: string;
  notOpened: string;
  /** T17 owner change (2026-10-13): the round open, no move yet. */
  starting: string;
}

export interface ScheduleCopy {
  /** The day view's heading for fixtures with no time yet. */
  timeTbd: string;
  /** The entrant filter's first option. */
  allEntrants: string;
  /** Row rail: a match in play. */
  live: string;
  /** Row rail: a decided match. */
  ended: string;
  /** Row rail, under the clock (V4, T17 fix round 4): an online board's round opened at that time. */
  roundOpened: string;
  /** W2a — a held bracket match (`needs_decision`): neither live nor finished. Read by the bracket card. */
  held: string;
  /** Row rail: a match with no time yet. */
  tbd: string;
  /** The entrant filter's screen-reader label. */
  filterLabel: string;
  /** The day/round toggle's group name. */
  viewLabel: string;
  /** The toggle's day button. */
  viewDay: string;
  /** The toggle's round button. */
  viewRound: string;
  /** The calendar (.ics) link. */
  calendar: string;
  /** A group heading's zone caption; `{zone}` is the venue zone's abbreviation. */
  timesIn: string;
  /** No fixtures at all. */
  empty: string;
  /** W2b Task 13 (review I-2) — the forfeit tags and sentences (`forfeitCopyOf` over the caller's public dictionary),
   *  read by this tab's rows and by the bracket. Optional: a caller that hands none shows no tag, exactly as before. */
  forfeit?: ForfeitCopy;
}

// Day bucket key as the venue-local calendar date (YYYY-MM-DD) so a 23:30 venue
// match doesn't slide onto the next/previous day for a viewer in another zone.
function dayKey(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso)); // YYYY-MM-DD
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date(iso));
  }
}


const UNSCHEDULED = "unscheduled";

/** The rail's clock, in the venue's zone. Exported for `schedule-rail-fits.test.ts`,
 *  which measures every minute of a day in the face the rail paints it in. */
export const timeOf = (iso: string, tz: string) => fmtTime(tz, iso);
/** The round view's rail date ("25 sept"): the venue-local day, in the tag.
 *  N1f f3 (review-n1e m2) — this used to be `dayLabel`, which leads with the
 *  weekday: "THU 24 SEPT" needs 68px, "JEU. 24 SEPT." 72px, and the rail is a
 *  ~56px track, so EVERY locale's date ended in an ellipsis, English included.
 *  Day + short month is the shortest unambiguous form (a bare day number is
 *  not: the round view spans months) and it fits every locale in every month
 *  — `__tests__/schedule-rail-fits.test.ts` measures all 48.
 *  What it costs (review-n1f m5): the round view heads its groups by ROUND,
 *  not by day, so this rail line is the ONLY place a match's date appears in
 *  that view — and it no longer names the weekday. Whether the weekday comes
 *  back in some other form is an owner decision, still open. The day view is
 *  unaffected: its rail shows the court, and its group heading the full day. */
export const shortDate = (iso: string, tz: string, dateTag: string) =>
  dayDateShort(dayKey(iso, tz), dateTag);

/** A fixture's round NAME as the round view heads it: the public round namer's
 *  label, or its round number when the caller has none for it. */
export const roundNameOf = (f: Pick<PublicFixture, "id" | "round_no">, roundLabels: Record<string, string>) =>
  roundLabels[f.id] ?? String(f.round_no);

/** N1g g1 (review-n1f I1) — every round name that more than one STAGE of the
 *  division produces (a knockout and its plate both ending in a "Final"). The
 *  round view names the stage in front of exactly these headings.
 *
 *  Pass the division's WHOLE fixture list. Whether a name is shared is a fact
 *  about the division, not about what is on screen: decided over the
 *  entrant-filtered list, a spectator filtered to a plate finalist saw a bare
 *  "Final" — reading as THE final — and the heading changed identity as the
 *  filter changed. Stages are counted, not fixtures: a name repeated inside one
 *  stage is not shared. */
export function sharedRoundNames(
  fixtures: readonly Pick<PublicFixture, "id" | "stage_id" | "round_no">[],
  roundLabels: Record<string, string>,
): Set<string> {
  const stagesByName = new Map<string, Set<string>>();
  for (const f of fixtures) {
    const name = roundNameOf(f, roundLabels);
    const stages = stagesByName.get(name) ?? new Set<string>();
    stages.add(f.stage_id);
    stagesByName.set(name, stages);
  }
  return new Set([...stagesByName].filter(([, stages]) => stages.size > 1).map(([name]) => name));
}

/** Per-side score lines fit the stacked layout only when short ("3", "21").
    Long lines (cricket innings, set strings) fall back to the headline chip.
    R116-2: an empty seat a walkover was won over (ruling 116) is HER side, so its line is read by her id — the row
    stacks its credited score as any walkover does. */
/** A decided row's credited headline when it has no per-side lines: the accent pill. Design audit 3.3: a forfeited row
 *  (its tag beside it) wears the same pill as every other decided row in the list. */
const HEADLINE_PILL = "rounded-full bg-accent-soft px-2.5 py-0.5 font-display text-sm font-semibold tabular-nums text-accent-strong";

function sideLines(f: PublicFixture): [string, string] | null {
  const perSide = f.summary?.perSide;
  if (!perSide || perSide.length !== 2) return null;
  if (perSide.some((s) => s.line.length > 7)) return null;
  const byId = Object.fromEntries(perSide.map((s) => [s.entrantId, s.line]));
  const homeId = f.home_entrant_id ?? unseatedForfeitLoser(f, "home");
  const awayId = f.away_entrant_id ?? unseatedForfeitLoser(f, "away");
  const home = homeId ? byId[homeId] : undefined;
  const away = awayId ? byId[awayId] : undefined;
  return home != null && away != null ? [home, away] : null;
}

/** I4 — one online board's watch link, as a label in its row: a live pill, the final position with its score,
 *  the quiet "round not opened" line, or — from the round's open until the first move (T17 owner change,
 *  2026-10-13) — "starting", between the two: an outlined pill with an empty ring where Live has a filled one. */
function WatchChip({ link, copy }: { link: PublicWatchLink; copy: ScheduleWatchCopy }) {
  const base = "col-span-2 col-start-2 mt-1 justify-self-start";
  if (link.kind === "live") {
    return (
      <span
        data-testid="schedule-watch"
        data-kind="live"
        className={`${base} inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-ink`}
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        {copy.live}
      </span>
    );
  }
  if (link.kind === "starting") {
    return (
      <span
        data-testid="schedule-watch"
        data-kind="starting"
        className={`${base} inline-flex items-center gap-1.5 rounded-full border border-accent-line px-2.5 py-0.5 text-xs font-semibold text-accent-strong`}
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-current" />
        {copy.starting}
      </span>
    );
  }
  if (link.kind === "final") {
    return (
      <span
        data-testid="schedule-watch"
        data-kind="final"
        className={`${base} inline-flex items-center gap-2 rounded-md border border-accent-line bg-surface px-2 py-0.5 text-xs font-semibold text-ink`}
      >
        {link.score !== "" ? <span className="font-display text-base font-bold leading-none tabular-nums">{link.score}</span> : null}
        {copy.final}
      </span>
    );
  }
  return (
    <span data-testid="schedule-watch" data-kind="not_opened" className={`${base} text-xs text-ink-muted`}>
      {copy.notOpened}
    </span>
  );
}

function ScorebugRow({
  fixture: f,
  entrantNames,
  href,
  railMode,
  tz,
  slotLabels,
  copy,
  dateTag,
  forfeit,
  watch,
  roundOpenedAt,
}: {
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  href: string;
  railMode: "time" | "date";
  tz: string;
  slotLabels: Record<string, string>;
  copy: ScheduleCopy;
  dateTag: string;
  /** W2b Task 13 (review I-2) — this row's forfeit tag and sentence, when it has one. */
  forfeit: ForfeitWords | undefined;
  watch: { link: PublicWatchLink; copy: ScheduleWatchCopy } | null;
  /** V4: when this online board's round opened, or null (no online play, the round not open, or nothing to play). */
  roundOpenedAt: string | null;
}) {
  const live = f.status === "in_play";
  // W2a fix round 1 (M5): a HELD bracket match (`needs_decision`) was played to a level score — only who advances is
  // owed — so it reads Ended with its score lines, as a decided one does. Nobody won, so no name is bolded.
  // W2b T13 review I-2: a FORFEITED match is over too — it read its kickoff time as if still to be played.
  const decided =
    f.status === "decided" || f.status === "finalized" || f.status === "needs_decision" || f.status === "forfeited";
  const winner = f.outcome?.winner ?? null;
  // A double walkover credits nobody: its summary's 0 — 0 would read as an unplayed match, so it shows its tag alone.
  const doubleWalkover = forfeit?.kind === "double_walkover";
  const lines = (decided || live) && !doubleWalkover ? sideLines(f) : null;
  // V4 (T17 fix round 4, as V1): an online board with no scheduled time whose round is open shows when it opened —
  // the fixture page's "Round opened HH:MM" clock — where the rail said "TBD". A real time, a live or a decided row
  // keeps its own.
  const opened = !decided && !live && !f.scheduled_at ? roundOpenedAt : null;
  // The tag rides the winner's score (the first row when nobody won), AFTER it, as on the hub's draw node, the bracket
  // footer, the results matrix and the hub card (design audit 3.9).
  const chip =
    forfeit === undefined ? null : (
      <ForfeitTagChip tag={forfeit.tag} sentence={forfeit.sentence} testId="schedule-forfeit-tag" />
    );
  const chipOn = (id: string | null, first: boolean) => chip !== null && (winner === null ? first : id === winner);
  // Design review M-3: the tag has its OWN track beside the stacked scores. Inside the winner's score cell it pushed
  // that line's digit a tag's width left of the other line's, breaking the column's right edge. Both lines carry a
  // cell in the track (the loser's empty), so the track is as wide as the tag and both digits end on one edge; the
  // cell's `-ml-1.5` keeps the tag the 6px after its score it always sat.
  const tagTrack = lines !== null && chip !== null;
  const tagCell = (on: boolean) => (tagTrack ? <span className="-ml-1.5 flex items-center">{on ? chip : null}</span> : null);
  // R116-1: an empty seat a walkover was won over (a withdrawn winner's, ruling 116) names her, never its bye label.
  const sideName = (id: string | null, seat: "home" | "away") => {
    const named = id ?? unseatedForfeitLoser(f, seat);
    return named !== null ? (entrantNames[named] ?? "?") : (slotLabels[`${f.id}:${seat}`] ?? msg("schedule.tbd"));
  };
  const homeName = sideName(f.home_entrant_id, "home");
  const awayName = sideName(f.away_entrant_id, "away");

  const nameCls = (id: string | null) =>
    winner && id === winner
      ? "truncate text-[15px] font-semibold leading-6 text-ink"
      : winner
        ? "truncate text-[15px] font-medium leading-6 text-ink-muted"
        : "truncate text-[15px] font-medium leading-6 text-ink";
  const scoreCls = (id: string | null) => {
    const weight = winner && id === winner ? "font-bold" : "font-semibold";
    const color = live ? "text-emerald-700" : winner && id !== winner ? "text-ink-muted" : "text-ink";
    return `pl-2 text-right font-display text-lg tabular-nums leading-6 ${weight} ${color}`;
  };

  // N1f f1: the rail track (first column) holds the LONGEST word any of the
  // four dictionaries puts in it, measured in the face it actually paints in —
  // Barlow Condensed SemiBold at 14px, where fr "déterminer" is 55.2px, the
  // widest of them. `schedule-rail-fits.test.ts` reads this number back out of
  // the class and re-measures every rail string against it, so a narrower
  // track or a longer translation reds instead of shipping.
  return (
    <Link
      href={href}
      className={`relative grid ${tagTrack ? "grid-cols-[3.5rem_minmax(0,1fr)_auto_auto]" : "grid-cols-[3.5rem_minmax(0,1fr)_auto]"} items-center gap-x-3 px-3.5 py-2.5 transition hover:bg-accent-soft/60`}
    >
      {live ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" /> : null}

      {/* `min-w-0`: a grid item's automatic minimum is its min-content width,
          so without it a long status word makes this CELL wider than the track
          and paints across the gap into the entrant name (N1f f1). With it the
          cell is exactly the track, and the status line below can wrap — or,
          as a last resort, break — INSIDE the column instead. */}
      <span className="row-span-2 flex min-w-0 flex-col items-start">
        {live ? (
          <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
            {/* `shrink-0` (N1h h1, review-n1g G1): when the word and the dot
                are wider than the track together (fr "EN DIRECT"), this row
                shrinks its items, and an empty dot has no minimum, so without
                it the dot painted as a 4.7×6px oval. The word wraps instead. */}
            <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            {copy.live}
          </span>
        ) : (
          <span className="w-full break-words font-display text-sm font-semibold text-ink">
            {decided ? copy.ended : f.scheduled_at ? timeOf(f.scheduled_at, tz) : opened !== null ? timeOf(opened, tz) : copy.tbd}
          </span>
        )}
        {/* A court name is free text, so this line DOES truncate — but at the
            track's own width (the cell is `min-w-0`), not at a second literal
            that can drift away from the grid above. */}
        {opened !== null && f.court_name === null ? (
          // V4: the word under the round-open clock. A status word, so it WRAPS inside the track rather than
          // truncating (`schedule-rail-fits.test.ts` measures it); a board with a court keeps its court here.
          <span className="mt-0.5 w-full break-words text-[10px] uppercase tracking-wide text-ink-muted">{copy.roundOpened}</span>
        ) : (
          <span className="mt-0.5 w-full truncate text-[10px] uppercase tracking-wide text-ink-muted">
            {!decided && !live && railMode === "date" && f.scheduled_at
              ? shortDate(f.scheduled_at, tz, dateTag)
              : (f.court_name ?? "")}
          </span>
        )}
      </span>

      <span title={homeName} className={nameCls(f.home_entrant_id)}>{homeName}</span>
      {lines ? (
        <span data-testid="schedule-score" className={scoreCls(f.home_entrant_id)}>{lines[0]}</span>
      ) : chip !== null ? (
        // No score lines beside the tag (a double walkover, or a line too long for the column): the tag alone, with a
        // credited headline when there is one — never a double walkover's 0 — 0.
        <span className="row-span-2 flex items-center gap-1.5 self-center">
          {!doubleWalkover && f.summary?.headline ? (
            <span className={HEADLINE_PILL}>{f.summary.headline}</span>
          ) : null}
          {chip}
        </span>
      ) : (
        <span
          className={`row-span-2 self-center ${
            f.summary?.headline ? HEADLINE_PILL : "text-[11px] text-ink-muted"
          }`}
        >
          {f.summary?.headline ?? (f.venue_name && railMode === "time" ? f.venue_name : "")}
        </span>
      )}
      {tagCell(chipOn(f.home_entrant_id, true))}
      <span title={awayName} className={nameCls(f.away_entrant_id)}>{awayName}</span>
      {lines ? <span data-testid="schedule-score" className={scoreCls(f.away_entrant_id)}>{lines[1]}</span> : null}
      {tagCell(chipOn(f.away_entrant_id, false))}
      {watch !== null ? <WatchChip link={watch.link} copy={watch.copy} /> : null}
    </Link>
  );
}

export function Schedule({
  fixtures,
  entrantNames,
  divisionPath,
  tz,
  slotLabels,
  roundLabels,
  stageOrder,
  stageNames,
  copy,
  locale,
  watch,
}: Props) {
  const [entrant, setEntrant] = useState<string>("");
  // Day view first (fixtures by date) — matches how a spectator reads a
  // timetable on the day. Round view stays a click away for bracket-style flow.
  const [view, setView] = useState<"day" | "round">("day");
  const shown = entrant
    ? fixtures.filter((f) => f.home_entrant_id === entrant || f.away_entrant_id === entrant)
    : fixtures;
  // The Intl tag dates are written in: the org's locale, "en" as en-GB
  // ("Friday 25 September"), as every public date was before N1e e5.
  const dateTag = intlLocaleFor(locale);
  // W2b Task 13 (review I-2): every row's forfeit words, built once from the WHOLE division (a double walkover's
  // next-round clause reads the fixture its line feeds), exactly as the bracket builds its own.
  const forfeitWords = bracketForfeitWords(fixtures, entrantNames, copy.forfeit);

  // Only offer the day view when at least one fixture actually has a date.
  const anyScheduled = fixtures.some((f) => f.scheduled_at);
  const mode = anyScheduled ? view : "round";

  // Round view (N1d d5, N1e e1): one group per round NAME within a stage, in
  // play order. Groups are opened walking the fixtures by the stage's seq, then
  // (round_no, seq_in_round), so each lands at its stage's place and its
  // earliest match whatever order the caller passed. `round_no` restarts in
  // every stage: without the stage first, a league's rounds interleaved with
  // the knockout it feeds, and two stages' "Round 1" merged into one group.
  const stageRank = (f: PublicFixture) => stageOrder[f.stage_id] ?? Number.POSITIVE_INFINITY;
  const inPlayOrder = [...shown].sort(
    (a, b) => stageRank(a) - stageRank(b) || a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
  );
  const groups = new Map<string, PublicFixture[]>();
  const roundNames = new Map<string, string>();
  const groupStage = new Map<string, string>();
  for (const f of mode === "day" ? shown : inPlayOrder) {
    let key: string;
    if (mode === "day") {
      key = f.scheduled_at ? dayKey(f.scheduled_at, tz) : UNSCHEDULED;
    } else {
      const name = roundNameOf(f, roundLabels);
      key = JSON.stringify([f.stage_id, name]);
      roundNames.set(key, name);
      groupStage.set(key, f.stage_id);
    }
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  const orderedGroups =
    mode === "day"
      ? [...groups.entries()].sort(([a], [b]) => {
          if (a === UNSCHEDULED) return 1;
          if (b === UNSCHEDULED) return -1;
          return a.localeCompare(b);
        })
      : [...groups.entries()];

  // N1f f2, N1g g1: a round name two stages share ("Final" in a knockout and
  // in its plate) is headed with its stage. Decided over the division's WHOLE
  // fixture list — `fixtures`, never the entrant-filtered `shown` — so a
  // heading reads the same whoever the filter is on.
  const shared = sharedRoundNames(fixtures, roundLabels);

  const groupLabel = (key: string): string => {
    if (mode === "round") {
      const name = roundNames.get(key);
      if (name == null) return key;
      if (!shared.has(name)) return name;
      const stageId = groupStage.get(key);
      const stageName = stageId != null ? stageNames[stageId] : undefined;
      // No name for the stage means nothing to tell them apart WITH, so the
      // round name goes out alone rather than with a dangling separator.
      return stageName ? `${stageName} · ${name}` : name;
    }
    if (key === UNSCHEDULED) return copy.timeTbd;
    return dayLabelLong(key, dateTag);
  };

  const options = Object.entries(entrantNames).sort(([, a], [, b]) => a.localeCompare(b));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="entrant-filter">
          {copy.filterLabel}
        </label>
        <select
          id="entrant-filter"
          value={entrant}
          onChange={(e) => setEntrant(e.target.value)}
          // `min-w-0 max-w-full`: a `<select>` sizes itself to its LONGEST
          // option, so a 43-character entrant name made this filter 383px in
          // a 288px phone column and scrolled the page sideways (T17 HB9d).
          // Capped, the closed control shows the chosen name cut by the
          // browser; the open list still shows every name in full.
          className="min-w-0 max-w-full rounded-lg border border-zinc-300 bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-line"
        >
          <option value="">{copy.allEntrants}</option>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {anyScheduled && (
          <div
            role="group"
            aria-label={copy.viewLabel}
            className="inline-flex overflow-hidden rounded-lg border border-zinc-300 text-sm"
          >
            {(["day", "round"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={mode === v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 font-medium transition ${
                  mode === v
                    ? "bg-accent text-accent-ink"
                    : "bg-surface text-ink-muted hover:bg-accent-soft hover:text-accent-strong"
                }`}
              >
                {v === "day" ? copy.viewDay : copy.viewRound}
              </button>
            ))}
          </div>
        )}
        <a
          href={`${divisionPath}/calendar.ics${entrant ? `?entrant=${entrant}` : ""}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-strong underline-offset-2 hover:underline"
        >
          <CalendarPlus aria-hidden className="h-4 w-4" />
          {copy.calendar}
        </a>
      </div>

      {orderedGroups.map(([key, list]) => (
        <section key={key} className="mb-6">
          <h3 className="mb-2 flex items-center gap-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {groupLabel(key)}
            {(() => {
              const anchor = list.find((x) => x.scheduled_at)?.scheduled_at;
              return anchor ? (
                <span className="font-sans text-[10px] font-medium normal-case tracking-normal text-ink-muted">
                  {copy.timesIn.replace("{zone}", fmtPublicZoneAbbrev(locale, tz, anchor))}
                </span>
              ) : null;
            })()}
            <span aria-hidden className="h-px flex-1 bg-zinc-200" />
          </h3>
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-surface shadow-sm">
            {[...list]
              .sort((a, b) =>
                mode === "day"
                  ? (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") ||
                    a.round_no - b.round_no
                  : a.round_no - b.round_no,
              )
              .map((f) => (
                <li key={f.id}>
                  <ScorebugRow
                    fixture={f}
                    entrantNames={entrantNames}
                    href={`${divisionPath}/fixtures/${f.id}`}
                    railMode={mode === "day" ? "time" : "date"}
                    tz={tz}
                    slotLabels={slotLabels}
                    copy={copy}
                    dateTag={dateTag}
                    forfeit={forfeitWords.get(f.id)}
                    watch={watch?.links[f.id] ? { link: watch.links[f.id]!, copy: watch.copy } : null}
                    roundOpenedAt={watch?.roundOpenedAt?.[f.id] ?? null}
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          {copy.empty}
        </p>
      ) : null}
    </div>
  );
}
