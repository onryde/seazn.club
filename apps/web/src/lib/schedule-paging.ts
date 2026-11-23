// W5 follow-ups C (owner 2026-11-23, Option A "by round"): a BIG public schedule as rounds - which ship their rows with the page
// (the live round, the next round) and which are headers whose rows load on a tap. Pure and client-safe: the division page builds
// the plan on the server, the round loader (`app/(public)/live/.../[divisionSlug]/rounds/route.ts`) answers a folded round or a
// team's matches out of the SAME grouping, and the client paints what they send.
import type { PublicFixture } from "@/server/public-site/data";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import type { ForfeitWords } from "@/lib/forfeit-tag";
import type { PackedRows } from "@/lib/packed-rows";
import { isCatchUpRoundExtKey } from "@/lib/roundrobin-late-entry";
import { bucketCounts, planRounds, type PlannedRound } from "@/lib/round-paging";
import { scheduleRoundGroups, sharedRoundNames } from "@/lib/schedule-round-groups";

type GroupedFixture = Pick<PublicFixture, "id" | "stage_id" | "round_no" | "seq_in_round" | "status" | "scheduled_at" | "ext_key">;

export interface PagedScheduleGroup extends PlannedRound {
  /** The round's heading, as the small schedule's round view names it (`scheduleRoundGroups`). */
  label: string;
  stageId: string;
  roundNo: number;
  /** W5 T23 (X-CU-7): a round appended for a late player's catch-up matches. */
  catchUp: boolean;
  /** W5 T3 (X-SF-4): the round's "Sits out: Eve" line, in the org's words; null when nobody sits out. */
  sitsOut: string | null;
  /** The first time in the round - the "Times in BST" caption's instant; null when nothing in it has a time. */
  anchorAt: string | null;
}

export interface PagedScheduleInput {
  roundLabels: Record<string, string>;
  stageOrder: Record<string, number>;
  stageNames: Record<string, string>;
  /** `publicSitsOutLines`, keyed `${stage_id}:${round_no}`. */
  sitsOut?: Record<string, string>;
}

/** The division's rounds planned (open / folded, with their counts), and every round's fixtures by key. */
export function pageSchedule<F extends GroupedFixture>(
  fixtures: readonly F[],
  a: PagedScheduleInput,
): { groups: PagedScheduleGroup[]; rowsOf: Map<string, F[]> } {
  const rounds = scheduleRoundGroups(fixtures, { ...a, shared: sharedRoundNames(fixtures, a.roundLabels) });
  const plan = planRounds(rounds.map((r) => ({ key: r.key, buckets: bucketCounts(r.fixtures, (f) => f.status) })));
  const groups = rounds.map((r, i): PagedScheduleGroup => ({
    ...plan[i]!,
    label: r.label,
    stageId: r.stageId,
    roundNo: r.roundNo,
    catchUp: r.fixtures.some((f) => isCatchUpRoundExtKey(f.ext_key)),
    sitsOut: a.sitsOut?.[`${r.stageId}:${r.roundNo}`] ?? null,
    anchorAt: r.fixtures.find((f) => f.scheduled_at)?.scheduled_at ?? null,
  }));
  return { groups, rowsOf: new Map(rounds.map((r) => [r.key, r.fixtures])) };
}

/** A team's matches in every round it plays, in play order - the "Find a team" answer, across ALL rounds. */
export function entrantRounds<F extends GroupedFixture & Pick<PublicFixture, "home_entrant_id" | "away_entrant_id">>(
  rowsOf: ReadonlyMap<string, readonly F[]>,
  entrantId: string,
): { key: string; rows: F[] }[] {
  const out: { key: string; rows: F[] }[] = [];
  for (const [key, rows] of rowsOf) {
    const mine = rows.filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);
    if (mine.length > 0) out.push({ key, rows: mine });
  }
  return out;
}

/** What a schedule row reads besides the fixture itself, for exactly the rows sent: its unfilled seats' names, its forfeit
 *  words (built over the WHOLE division: a double walkover's next-round clause reads the fixture its line feeds) and, for an
 *  online chess division, its watch link and round-open stamp. */
export interface ScheduleRowExtras {
  slotLabels: Record<string, string>;
  forfeit: Record<string, ForfeitWords>;
  watchLinks?: Record<string, PublicWatchLink>;
  roundOpenedAt?: Record<string, string>;
}

export function rowExtras(
  rows: readonly Pick<PublicFixture, "id">[],
  all: {
    slotLabels: Record<string, string>;
    forfeitWords: ReadonlyMap<string, ForfeitWords>;
    watch?: { links: Record<string, PublicWatchLink>; roundOpenedAt?: Record<string, string> };
  },
): ScheduleRowExtras {
  const out: ScheduleRowExtras = { slotLabels: {}, forfeit: {} };
  if (all.watch) {
    out.watchLinks = {};
    out.roundOpenedAt = {};
  }
  for (const { id } of rows) {
    for (const seat of ["home", "away"] as const) {
      const label = all.slotLabels[`${id}:${seat}`];
      if (label !== undefined) out.slotLabels[`${id}:${seat}`] = label;
    }
    const words = all.forfeitWords.get(id);
    if (words !== undefined) out.forfeit[id] = words;
    const link = all.watch?.links[id];
    if (link !== undefined) out.watchLinks![id] = link;
    const opened = all.watch?.roundOpenedAt?.[id];
    if (opened !== undefined) out.roundOpenedAt![id] = opened;
  }
  return out;
}

/** The paged schedule as the division page hands it to the client: every round's header, and the rows of the open ones packed
 *  (`lib/packed-rows.ts`) with their extras. */
export interface PagedScheduleData {
  groups: (PagedScheduleGroup & { rows?: PackedRows<PublicFixture> })[];
  extras: ScheduleRowExtras;
}

/** The round loader's answer: one round's rows, or a team's rows across every round it plays. */
export type ScheduleRoundsAnswer =
  | { kind: "round"; key: string; rows: PublicFixture[]; extras: ScheduleRowExtras }
  | { kind: "entrant"; entrantId: string; rounds: { key: string; rows: PublicFixture[] }[]; extras: ScheduleRowExtras };

/** Every word the paged Schedule and the hub's paged Matches tab say beyond the row's own (`ScheduleCopy`), resolved in the
 *  org's locale on the server - both are client components with no dictionary. A count is a pair of plural templates
 *  (`{count}`), chosen in the browser by `Intl.PluralRules` in the org's locale (`pagedCount`). */
export interface PagedScheduleCopy {
  searchLabel: string;
  searchClear: string;
  /** `{query}`: what was typed. */
  searchNone: string;
  /** `{team}`: the team the list is narrowed to. */
  searchShowing: string;
  /** `{team}`. */
  searchNoMatches: string;
  filterLabel: string;
  filter: { all: string; live: string; upcoming: string; results: string };
  finished: { one: string; other: string };
  show: string;
  hide: string;
  state: Record<"live" | "next" | "upcoming" | "finished" | "inProgress", string>;
  matches: { one: string; other: string };
  loading: string;
  loadFailed: string;
  retry: string;
  empty: { live: string; upcoming: string; results: string };
}

/** `{count}` filled into the plural template the org's locale picks for `n` (the `.one` / `.other` pair of `plural()`). */
export function pagedCount(forms: { one: string; other: string }, n: number, locale: string): string {
  let cat: string;
  try {
    cat = new Intl.PluralRules(locale).select(n);
  } catch {
    cat = n === 1 ? "one" : "other";
  }
  return (cat === "one" ? forms.one : forms.other).replaceAll("{count}", String(n));
}
