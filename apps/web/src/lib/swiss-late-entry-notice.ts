// W3 Task 10 — what the desk SAYS after "Add late player" (spec 2026-10-31-format-matrix-w3-swiss-design.md §4,
// ruling 250; X-SW-12/13/14, UI half), and the pending-latecomer line on a Swiss stage's rail.
//
// Pure and client-safe: the stage rail, the stages panel and the entrants panel all render these lines, and `apps/web`
// vitest has no DOM, so every decision about WHAT is said lives here, where a test can read it.
//
// The server's answer (`LateEntryResult`, Task 9) says which case each created entrant took:
//   (a) the unstarted round was re-paired with the newcomer — the entrants whose match changed are NAMED, because no
//       channel tells them (controller ruling I3: no per-player "your match changed" notifier exists; deferred, the
//       owner knows), and printed scorer sheets now show old names (T9 m13: the QR on them stays valid);
//   (b) the newcomer plays the round's bye holder — in a round already opened for online play that new game has no
//       invite yet (T9 m11);
//   (c) the newcomer joins from the next round.
// A new match that found no free slot is flagged (spec §4 "unscheduled if there is none, flagged to the desk").
//
// VOCABULARY. A field member is an "entrant" (the desk's noun: a doubles pair or a team is one); a board is a "match"
// on screen — `board` is internal vocabulary, as in `reshapeNotice` and `swiss-legend.ts`.
import type { LateEntryResult } from "@/server/api-v1/schemas";
import type { MessageKey } from "@/lib/messages";
import { swissFirstRoundIn } from "@/lib/swiss-late-entry";
import { nextUnseatedSwissRound } from "@/lib/swiss-shell";

/** The plain keys this module emits — tied to the English catalog by `satisfies`, so a missing key is a tsc error. */
export const LATE_ENTRY_MESSAGE_KEYS = [
  "swiss.lateEntry.repairedNoChange",
  "swiss.lateEntry.tellChanged",
  "swiss.lateEntry.reprintSheets",
  "swiss.lateEntry.newMatchUnscheduled",
  "swiss.lateEntry.tookBye",
  "swiss.lateEntry.inviteOwed",
  "swiss.lateEntry.nextRound",
] as const satisfies readonly MessageKey[];
export type LateEntryMessageKey = (typeof LATE_ENTRY_MESSAGE_KEYS)[number];

/** The plural bases (`.one` / `.other` in every locale) this module emits. */
export const LATE_ENTRY_PLURAL_KEYS = [
  "swiss.lateEntry.repaired",
  "swiss.lateEntry.joinNextRound",
  "swiss.lateEntry.joinedAfterLast",
] as const;
export type LateEntryPluralKey = (typeof LATE_ENTRY_PLURAL_KEYS)[number];

/** "done" says what happened; "todo" is something the organiser still has to do. */
export type LateEntryNoticeTone = "done" | "todo";
type Params = Record<string, string | number>;
export type LateEntryNoticeLine =
  | { key: LateEntryMessageKey; params: Params; tone: LateEntryNoticeTone }
  | { plural: LateEntryPluralKey; count: number; params: Params; tone: LateEntryNoticeTone };

/** The i18n surface the lines need; `useMsg` / `useMsgPlural` satisfy it. */
export type LateEntryNoticeI18n = {
  t: (key: LateEntryMessageKey, vars?: Params) => string;
  plural: (key: string, count: number, vars?: Params) => string;
};

export interface LateEntryNoticeOptions {
  /** The reader's locale: the named entrants are listed with its conjunction (`Intl.ListFormat`). */
  locale: string;
  /** Whether round `round` of stage `stageId` is already open for online play (its boards' games were created). Only a
   *  (b) asks: an (a) never fires on an opened round, since an online game counts as a start (T9 C5 re-ruling). */
  onlineRoundOpen?: (stageId: string, round: number) => boolean;
}

/**
 * The notice for one "Add late player" press: one result per created entrant (a CSV batch has several), each case's
 * lines in turn. Empty in, empty out. A line repeated across the batch (two re-pairs of one round both owe the same
 * reprint) is said once.
 */
export function lateEntryNotice(
  results: readonly LateEntryResult[],
  names: Readonly<Record<string, string>>,
  opts: LateEntryNoticeOptions,
): LateEntryNoticeLine[] {
  const nameOf = (id: string): string => names[id] ?? "?";
  const list = (ids: readonly string[]): string => {
    const sorted = ids.map(nameOf).sort((x, y) => x.localeCompare(y, opts.locale));
    return new Intl.ListFormat(opts.locale, { style: "long", type: "conjunction" }).format(sorted);
  };
  const out: LateEntryNoticeLine[] = [];
  const said = new Set<string>();
  const push = (line: LateEntryNoticeLine) => {
    const id = JSON.stringify(line);
    if (said.has(id)) return;
    said.add(id);
    out.push(line);
  };
  const unscheduled = (r: LateEntryResult) => {
    if (r.new_board !== undefined && !r.new_board.scheduled) {
      push({ key: "swiss.lateEntry.newMatchUnscheduled", params: {}, tone: "todo" });
    }
  };

  for (const r of results) {
    const name = nameOf(r.entrant_id);
    switch (r.case) {
      case "a": {
        // The server always reports who moved on a re-pair (T9 `repairRound`). Without it, "No other match changed" would
        // be a claim nobody checked — refused by name instead.
        if (r.repaired === undefined) throw new Error("late entry (a) without its changed entrants");
        const changed = r.repaired.changed_entrant_ids;
        if (changed.length === 0) {
          push({ key: "swiss.lateEntry.repairedNoChange", params: { round: r.round, name }, tone: "done" });
        } else {
          push({ plural: "swiss.lateEntry.repaired", count: changed.length, params: { round: r.round, name }, tone: "done" });
          push({ key: "swiss.lateEntry.tellChanged", params: { names: list(changed) }, tone: "todo" });
        }
        // A printed sheet is stale when a name on it moved, or the round grew a match it has no sheet for.
        if (changed.length > 0 || r.new_board !== undefined) {
          push({ key: "swiss.lateEntry.reprintSheets", params: { round: r.round }, tone: "todo" });
        }
        unscheduled(r);
        break;
      }
      case "b": {
        if (r.bye_holder_id === undefined) throw new Error("late entry (b) without its bye holder");
        const holder = nameOf(r.bye_holder_id);
        push({ key: "swiss.lateEntry.tookBye", params: { name, holder, round: r.round }, tone: "done" });
        if (opts.onlineRoundOpen?.(r.stage_id, r.round) === true) {
          push({ key: "swiss.lateEntry.inviteOwed", params: { round: r.round, name, holder }, tone: "todo" });
        }
        unscheduled(r);
        break;
      }
      case "c":
        push({ key: "swiss.lateEntry.nextRound", params: { name, round: r.round }, tone: "done" });
        break;
    }
  }
  return out;
}

export interface SwissLatecomerCounts {
  /** Entrants whose first round in this stage is the round the next Pair seats. */
  joinNext: number;
  /** Entrants who arrived after the last round started (an automatic arrival, ruling 250): first round past `rounds`. */
  afterLast: number;
}

/**
 * The rail's pending latecomers on one Swiss stage (spec §4: the desk shows "N late players join next round"; ruling
 * C4: derived from the entrants' stored first round, V484/V485). An unknown roster or a stage with no usable declared
 * round count has no line — never a zero dressed up as a fact.
 *
 * "Next round" is the round the next Pair seats (`nextUnseatedSwissRound`). A stamp for a LATER round (round 1 unpaired
 * after a (c)) is not "next round" and is not counted until that round is the next one.
 */
export function swissLatecomerCounts(args: {
  stageId: string;
  rounds: unknown;
  fixtures: Parameters<typeof nextUnseatedSwissRound>[0];
  /** The registered/confirmed field (the page's own predicate); a withdrawn latecomer is pending nowhere. */
  activeEntrantIds: readonly string[] | undefined;
  entrantFirstRounds: Readonly<
    Record<string, { swiss_first_round?: number | null; swiss_first_round_stage_id?: string | null } | undefined>
  > | undefined;
}): SwissLatecomerCounts {
  const none = { joinNext: 0, afterLast: 0 };
  const { rounds } = args;
  if (args.activeEntrantIds === undefined) return none;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) return none;
  const next = nextUnseatedSwissRound(args.fixtures);
  let joinNext = 0;
  let afterLast = 0;
  for (const id of args.activeEntrantIds) {
    const first = swissFirstRoundIn(args.entrantFirstRounds?.[id] ?? {}, args.stageId);
    if (first === null) continue;
    if (first > rounds) afterLast += 1;
    else if (first === next) joinNext += 1;
  }
  return { joinNext, afterLast };
}

/** The rail line(s) for the counts: nothing at zero (an empty cell is not information). */
export function swissLatecomerLines(counts: SwissLatecomerCounts): LateEntryNoticeLine[] {
  const out: LateEntryNoticeLine[] = [];
  if (counts.joinNext > 0) {
    out.push({ plural: "swiss.lateEntry.joinNextRound", count: counts.joinNext, params: {}, tone: "done" });
  }
  if (counts.afterLast > 0) {
    out.push({ plural: "swiss.lateEntry.joinedAfterLast", count: counts.afterLast, params: {}, tone: "done" });
  }
  return out;
}

/** One line in the reader's language. */
export function lateEntryNoticeText(line: LateEntryNoticeLine, i18n: LateEntryNoticeI18n): string {
  return "key" in line ? i18n.t(line.key, line.params) : i18n.plural(line.plural, line.count, line.params);
}
