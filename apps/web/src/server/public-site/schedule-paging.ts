// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the public division Schedule's words and row extras, built ONCE from
// the cached division document - for the division page (`app/(public)/live/.../[divisionSlug]/page.tsx`) and for the round loader
// beside it (`.../[divisionSlug]/rounds/route.ts`), so a round loaded on a tap reads exactly as the rounds the page sent. Every
// word is the ORG's (the page is ISR; never the visitor's), and every read is the public one `getPublicDivision` already made.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { bracketForfeitWords } from "@/lib/bracket-forfeit-words";
import { packRows } from "@/lib/packed-rows";
import {
  entrantRounds,
  pageSchedule,
  rowExtras,
  type PagedScheduleData,
  type ScheduleRoundsAnswer,
} from "@/lib/schedule-paging";
import type { ScheduleCopy, ScheduleWatchCopy } from "@/components/public-site/schedule";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { loadDivisionWatch } from "@/server/usecases/external-play-read";
import { publicRoundNamer, type PublicRoundNamer } from "./feeder-slot-label";
import { publicScheduleCopy, publicSitsOutLines, publicWatchCopy } from "./schedule-copy";
import type { getPublicDivision } from "./data";

type PublicDivisionData = NonNullable<Awaited<ReturnType<typeof getPublicDivision>>>;

export interface PublicScheduleContext {
  entrantNames: Record<string, string>;
  entrantStatuses: Record<string, string>;
  namer: PublicRoundNamer;
  slotLabels: Record<string, string>;
  roundLabels: Record<string, string>;
  copy: ScheduleCopy;
  stageOrder: Record<string, number>;
  stageNames: Record<string, string>;
  sitsOut: Record<string, string>;
  watch?: { links: Record<string, PublicWatchLink>; roundOpenedAt: Record<string, string>; copy: ScheduleWatchCopy };
}

/** The Schedule's words and per-fixture labels for a division, in the org's locale. */
export async function publicScheduleContext(
  data: PublicDivisionData,
  o: { locale: Locale; dict: Dict },
): Promise<PublicScheduleContext> {
  const { division, stages, fixtures, entrants } = data;
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor(o.locale, k, v);
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  const entrantStatuses = Object.fromEntries(entrants.map((e) => [e.id, e.status]));
  const stageById = new Map(stages.map((s) => [s.id, s]));
  // R10d n4: a side still waiting on a match is named through the public round namer ("Winner of Semi-finals, match 1"), as
  // the hub, the match centre and the embed widgets do.
  const namer = publicRoundNamer({ ui: lookup, dict: o.dict, fixtures, stageKind: (stageId) => stageById.get(stageId)?.kind });
  // <Schedule> is a Client Component — it cannot call msgFor() itself (server-only), so every unfilled slot's text is
  // pre-resolved HERE. N1c c5: through the SAME namer as the Bracket, so the schedule tab and the bracket name one waiting side
  // with one text. `seat`, not `slot`: a sibling-fed seat of a `timing: "setup"` bracket carries no stored label.
  const slotLabels: Record<string, string> = {};
  for (const f of fixtures) {
    if (!f.home_entrant_id) slotLabels[`${f.id}:home`] = namer.seat(f.id, "home", f.home_slot_label);
    if (!f.away_entrant_id) slotLabels[`${f.id}:away`] = namer.seat(f.id, "away", f.away_slot_label);
  }
  // N1d d5: the round view heads each group with the round's NAME from the same namer ("Round {n}" in the org's locale only for
  // a fixture whose stage the namer does not know).
  const roundLabels = Object.fromEntries(
    fixtures.map((f) => [f.id, namer.roundLabel(f.id) ?? lookup("schedule.round", { n: f.round_no })]),
  );
  // W2b Task 13 (review I-2): the forfeit tags and sentences ride the schedule copy, so the schedule rows AND the bracket tiles
  // tag a credited result — in the org's locale like the rest of the copy.
  const copy: ScheduleCopy = { ...publicScheduleCopy(o.dict, lookup), forfeit: forfeitCopyOf((k) => t(o.dict, k)) };
  // T16 fix round 1, I4: an online chess division's Fixtures list says which boards can be watched — one read, and none at all
  // for a division that does not play online.
  const watch =
    supportsOnlinePlay(division.sport_key) && readOnlinePlay(division.config) === "lichess"
      ? { ...(await loadDivisionWatch(division.id)), copy: publicWatchCopy(lookup) }
      : undefined;
  return {
    entrantNames,
    entrantStatuses,
    namer,
    slotLabels,
    roundLabels,
    copy,
    // N1e e1: round_no restarts in every stage, so the round view orders its groups by each stage's seq first.
    stageOrder: Object.fromEntries(stages.map((s) => [s.id, s.seq])),
    // N1f f2: two stages can name a round the same ("Final" in a knockout and in its plate).
    stageNames: Object.fromEntries(stages.map((s) => [s.id, s.name])),
    sitsOut: publicSitsOutLines(o.dict, stages, entrantNames, entrantStatuses),
    ...(watch ? { watch } : {}),
  };
}

function plan(data: PublicDivisionData, ctx: PublicScheduleContext) {
  const { groups, rowsOf } = pageSchedule(data.fixtures, ctx);
  const all = {
    slotLabels: ctx.slotLabels,
    forfeitWords: bracketForfeitWords(data.fixtures, ctx.entrantNames, ctx.copy.forfeit, ctx.entrantStatuses),
    ...(ctx.watch ? { watch: ctx.watch } : {}),
  };
  return { groups, rowsOf, all };
}

/** The division page's paged Schedule: every round's header, and only the OPEN rounds' rows (packed) with their extras. */
export function pagedScheduleData(data: PublicDivisionData, ctx: PublicScheduleContext): PagedScheduleData {
  const { groups, rowsOf, all } = plan(data, ctx);
  const openRows = groups.filter((g) => g.open).flatMap((g) => rowsOf.get(g.key)!);
  return {
    groups: groups.map((g) => (g.open ? { ...g, rows: packRows(rowsOf.get(g.key)!) } : g)),
    extras: rowExtras(openRows, all),
  };
}

/** The round loader's answer: one round's rows by its key, or one team's rows across every round. Null for a round or a team
 *  this division does not have (the route answers 404, never an empty list that reads as "no matches"). */
export function scheduleRoundsAnswer(
  data: PublicDivisionData,
  ctx: PublicScheduleContext,
  q: { round: string } | { entrant: string },
): ScheduleRoundsAnswer | null {
  const { rowsOf, all } = plan(data, ctx);
  if ("round" in q) {
    const rows = rowsOf.get(q.round);
    if (rows === undefined) return null;
    return { kind: "round", key: q.round, rows, extras: rowExtras(rows, all) };
  }
  if (ctx.entrantNames[q.entrant] === undefined) return null;
  const rounds = entrantRounds(rowsOf, q.entrant);
  return { kind: "entrant", entrantId: q.entrant, rounds, extras: rowExtras(rounds.flatMap((r) => r.rows), all) };
}
