// Pure helpers for the schedule board (doc 12 §2). Isomorphic — used by the
// server page (feed labels) and the client board (grid math); unit-testable
// without React or a DB.
import type { Conflict } from "@seazn/engine/scheduling";
import { GRID_FLOOR_MINUTES } from "@seazn/engine/scheduling/grid-step";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import {
  addYmdDays,
  isoFromZonedParts,
  ymdSpanDays,
  zonedDateInput,
  zonedTimeInput,
} from "@/lib/zoned-datetime";

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine verifier reason tokens → API conflict
// codes. The single source of truth for the mapping, lifted here (isomorphic,
// no server-only) so both sides share ONE table: usecases/schedule.ts maps
// drag-drop conflicts through it on the server, and the AI diff panel maps a
// blocking row's engine reason through it on the client to reach the shared
// `board.conflict.*` labels the conflicts panel already localizes (v4 Task 13).
// The Record key type keeps it exhaustive against the engine's reason union.
// ---------------------------------------------------------------------------
export const REASON_CODE: Record<Conflict["reason"], ScheduleConflict["code"]> = {
  court: "conflict.court",
  rest: "warn.rest",
  person_overlap: "warn.person_overlap",
  order: "warn.order",
  blackout: "warn.blackout",
  // #397: outside the pack's resolved calendar window. Warn this wave; W4
  // (#399) promotes it to a delta-based block.
  window: "warn.window",
  // #398: a rule compiled from the organiser's instruction, or a durable
  // division rule in the same vocabulary. Warn this wave; W4 (#399) decides
  // what blocks.
  instruction: "warn.instruction",
  no_slot: "warn.no_slot",
  // Jul3/04 §3: an unsatisfiable start window is a hard bound, not a warning
  start_window: "conflict.start_window",
};

// ---------------------------------------------------------------------------
// The publish gate's two refusal codes (#230 item 2 + follow-up).
//
// Isomorphic on purpose. `publishSchedule` and `startDivision` throw them and
// the board's confirm dialog branches on them — and the board is a client
// component, so importing a VALUE out of `server/usecases/schedule` would drag
// `postgres` into the browser bundle. One definition, both sides; the usecase
// re-exports these so existing server importers are unaffected.
// ---------------------------------------------------------------------------

/** Blocking conflicts on the board at the moment of publish. There is NO
 *  override for these — `acknowledge_warnings` is checked strictly after, and
 *  only ever against the warnings, so a client must not offer a way past this
 *  one. */
export const PUBLISH_BLOCKED = "SCHEDULE_BLOCKING_CONFLICTS";
/** Warning-level conflicts the organiser has not yet said "publish anyway" to.
 *  A distinguishable code, so the console can offer the confirm step instead of
 *  rendering a dead end. */
export const PUBLISH_UNACKNOWLEDGED = "SCHEDULE_UNACKNOWLEDGED_WARNINGS";

export interface FeedRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

export interface FeedLabelPair {
  home?: SlotLabel;
  away?: SlotLabel;
}

/**
 * TBD card labels from the feed wiring: the fixture receiving a winner/loser
 * carries a `{ key: "slot.winner_match" | "slot.loser_match", params:
 * {round, seq} }` pair for the fed slot (doc 12 §2 — cards render feed
 * labels until entrants resolve).
 *
 * Data, never pre-rendered text (P7/F1) — this used to hand-build
 * `"Winner of R1 #2"` here, a second, hardcoded-English copy of the SAME
 * vocabulary `fixtures.home_slot_label`/`away_slot_label` already carry as
 * `{key,params}`. Callers resolve this through resolveSlotLabel(), the one
 * composition point both label mechanisms share (see board/types.ts's
 * cardTitle()), so a card's short code and this feed's rendered text can't
 * drift onto two ref formats.
 */
export function feedLabels(rows: readonly FeedRow[]): Record<string, FeedLabelPair> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labels: Record<string, FeedLabelPair> = {};
  for (const source of rows) {
    for (const [target, slot, key] of [
      [source.winner_to_fixture, source.winner_to_slot, "slot.winner_match"],
      [source.loser_to_fixture, source.loser_to_slot, "slot.loser_match"],
    ] as const) {
      if (!target || !slot || !byId.has(target)) continue;
      const label: SlotLabel = { key, params: { round: source.round_no, seq: source.seq_in_round } };
      const pair = (labels[target] ??= {});
      if (slot === 1) pair.home = label;
      else pair.away = label;
    }
  }
  return labels;
}

/**
 * One empty seat's label, for every organiser surface that renders one:
 *
 *     entrant name → STORED `*_slot_label` → FEED label → that surface's TBD
 *
 * The caller has already handled the entrant name and supplies its own
 * fallback key to `resolveSlotLabel` (`schedule.tbd` on the run sheet,
 * `bracket.tbd` in the tree — they were localized separately before this
 * helper existed). This picks between the middle two and returns `null` for
 * the fallback.
 *
 * ONE composition point on purpose. The two seats used to spell this out
 * twice per surface, and a duplicated expression needs a test per copy: a
 * mutant inverting only the HOME seat's precedence survived a 59-test gate
 * while its AWAY mirror died, because the only case exercising the collision
 * happened to sit on the away side.
 *
 * STORED WINS OVER FEED, deliberately, and this is the mainline bye shape
 * rather than a theoretical one. `generateProgressionSetupFixtures`' third
 * pass (`usecases/stages.ts` ~2812) stamps a bye's award label onto the
 * WINNER-FEED TARGET's seat, so that seat carries a stored "Rank 1" AND an
 * inbound edge from the bye line at the same time. Stored is right: the bye
 * means seed 1 is already through, and "Winner of R1·1" would tell the
 * organiser to wait on a match whose result changes nothing.
 * `awardsSeededByes`/`destinationSlotsBySeed` read that same stored label,
 * which is why it has to stay the authority.
 *
 * The feed is consulted at all because that same generator leaves a
 * sibling-fed seat's stored label NULL on purpose — `stageOwesDraw`/
 * `fixtureAwaitsSeedDraw` read "no label ⇒ sibling-fed" for `timing:"setup"`
 * stages, so stamping one there would pin a permanent "Needs draw" row.
 */
export function seatLabel(
  stored: SlotLabel | null | undefined,
  feed: FeedLabelPair | undefined,
  seat: "home" | "away",
): SlotLabel | null {
  return stored ?? feed?.[seat] ?? null;
}

/** Day key (YYYY-MM-DD, local) for grouping assignments into board days. */
export function dayKey(isoOrDate: string | Date): string {
  const d = new Date(isoOrDate);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Slot rows for a day grid: starts every `slotMinutes` from `fromMs` up to
 *  (and excluding) `toMs`.
 *
 *  `slotMinutes` is expected to come from `gridStepMinutes`, which already
 *  applies this floor — the guard stays because a bad step here does not draw a
 *  coarse grid, it draws NO grid (`t += NaN` never terminates the comparison)
 *  or hangs the render (`t += 0`). It reads the engine's constant rather than
 *  its own 5 so there is one definition of the finest legal step in the repo. */
export function daySlots(fromMs: number, toMs: number, slotMinutes: number): number[] {
  const out: number[] = [];
  const step = Math.max(GRID_FLOOR_MINUTES, slotMinutes) * 60_000;
  for (let t = fromMs; t < toMs; t += step) out.push(t);
  return out;
}

/**
 * An instant as a `datetime-local` value on the BROWSER's clock.
 *
 * NOT for anything the scheduler consumes. A time the organiser types for a
 * VENUE — a blackout, the board's start, play hours — means the venue's wall
 * clock, and resolving it here would store an instant off by the offset between
 * the two zones (#448: `settings.orgTz` is the governing clock). Those fields go
 * through `@/lib/zoned-datetime`, which takes the zone explicitly. What is left
 * here is the fixture move panel, where the organiser is looking at a time
 * already rendered in their own zone.
 */
export function toLocalInput(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Daily play hours ⇄ session windows (PROMPT-33 follow-up). The engine takes
// ABSOLUTE {from,to} intervals; organisers think "we play 09:00–18:00". These
// two convert between the shapes so the settings panel can offer plain hours
// while the auto pass and validator keep their one interval system.
// ---------------------------------------------------------------------------

export interface IsoWindow {
  from: string;
  to: string;
}

const HHMM = /^\d{2}:\d{2}$/;

/** Cap on the expansion when the schedule has no end date — two weeks of
 *  windows is plenty for the auto pass's search horizon. */
const DEFAULT_SPAN_DAYS = 14;

/** Hard ceiling on the expansion, so a mistyped end date cannot generate a
 *  year of windows. */
const MAX_SPAN_DAYS = 90;

/**
 * Expand daily play hours into one absolute window per day across the
 * schedule's date span (inclusive). Returns null when the hours don't parse
 * or are inverted/empty (from must be before to — overnight windows are out
 * of scope).
 *
 * `tz` is the VENUE zone (`settings.orgTz`, #448) and is not optional: "we play
 * 09:00–18:00" means 09:00 where the matches are, and an organiser working from
 * another zone used to expand it into 09:00 where THEY are. It also fixes DST —
 * each day's hours are resolved on that day's own offset, where the previous
 * "noon anchor" trick still stepped a fixed 24 hours and walked the window an
 * hour across a transition.
 */
export function dailyHoursToWindows(
  fromHHMM: string,
  toHHMM: string,
  startIso: string,
  endIso: string | null,
  tz: string,
): IsoWindow[] | null {
  if (!HHMM.test(fromHHMM) || !HHMM.test(toHHMM)) return null;
  if (fromHHMM >= toHHMM) return null;
  const first = zonedDateInput(startIso, tz);
  if (first === "") return null;
  const last = endIso ? zonedDateInput(endIso, tz) : "";
  const days = last === "" ? DEFAULT_SPAN_DAYS : ymdSpanDays(first, last);
  const out: IsoWindow[] = [];
  for (let i = 0; i < Math.min(days, MAX_SPAN_DAYS); i++) {
    const ymd = addYmdDays(first, i);
    const from = isoFromZonedParts(ymd, fromHHMM, tz);
    const to = isoFromZonedParts(ymd, toHHMM, tz);
    if (from === null || to === null) return null;
    out.push({ from, to });
  }
  return out;
}

/**
 * The inverse, for prefilling the panel: when every window shares the same
 * wall-clock from/to ON THE VENUE CLOCK, report those hours; otherwise null
 * (hand-built windows from the constraints panel stay untouched).
 *
 * Reading these in any other zone is what makes a legitimate daily pattern look
 * "custom" across a DST boundary, and would prefill hours nobody typed.
 */
export function windowsToDailyHours(
  windows: readonly IsoWindow[],
  tz: string,
): { from: string; to: string } | null {
  if (windows.length === 0) return null;
  const from = zonedTimeInput(windows[0]!.from, tz);
  const to = zonedTimeInput(windows[0]!.to, tz);
  if (from === "" || to === "") return null;
  for (const w of windows) {
    if (zonedTimeInput(w.from, tz) !== from || zonedTimeInput(w.to, tz) !== to) return null;
  }
  return { from, to };
}
