// W5 app-A Task 23 (X-CU-7, X-CU-8, X-CU-11; R24 pick 7A, owner 2026-11-16): what the desk SAYS after a late player joins a
// running ROOT league or group — "Add late player" on the Entrants tab, the waiting strip's "Add to the table", a Reinstate.
//
// The server's answer is `TableLateEntryResult` (api-v1/schemas/entrants.ts, Task 4/5/6), one of four wire cases:
//   catch_up        the newcomer owes a match against every member and each was written as a line (a bye slot in a round
//                   nobody started, or an appended catch-up round), UNSCHEDULED (RB5-L13) — said with the rounds it landed in;
//   rebuild_offered nothing in the stage has started: the catch-up lines were written all the same (the default) — said as a
//                   catch-up (the Rebuild choice is offered BEFORE the tap, on the waiting strip; fix round 1 I1). With
//                   `reason: "rebuilt"` the add asked for the redraw (`prefer_rebuild`) and got it: no catch-up lines;
//   refused         a named refusal (`reason`: the RR_LATE_ENTRY_* code), said in the refusal's own words;
//   waiting         an automatic arrival held for the organiser's tap, counted once on one line (the desk row's sentence).
// The copy never promises that no opponent repeats (R24 pick 7: two legs can pair the same opponents back to back).
//
// Pure and client-safe: the Entrants tab and the waiting strip both render these lines, and `apps/web` vitest has no DOM, so
// every decision about WHAT is said lives here. `lib/swiss-late-entry-notice.ts`'s `lateEntryNotice` hands every league /
// group result to `tableLateEntryLines` (the one notice block, three formats) — this file never imports that one at runtime.
import type { TableLateEntryResult } from "@/server/api-v1/schemas";
import type { MessageKey } from "@/lib/messages";
import { isRoundRobinRefusalCode, roundRobinRefusalKey } from "@/lib/roundrobin-refusals";

/** The plain keys this module emits — tied to the English catalog by `satisfies`, so a missing key is a tsc error. */
export const TABLE_LATE_ENTRY_MESSAGE_KEYS = [
  "roundrobin.lateEntry.joinedPool",
  "roundrobin.lateEntry.tellOpponents",
  "roundrobin.lateEntry.rebuilt",
  "roundrobin.refusal.RR_LATE_ENTRY_NOT_UNDOABLE",
  "roundrobin.refusal.RR_LATE_ENTRY_STAGE_COMPLETE",
  "roundrobin.refusal.RR_LATE_ENTRY_NOTHING_TO_ADD",
  "roundrobin.refusal.RR_LATE_ENTRY_NOT_WAITING",
  "roundrobin.refusal.RR_LATE_ENTRY_ALREADY_PLACED",
  "roundrobin.refusal.RR_LATE_ENTRY_UNKNOWN_POOL",
] as const satisfies readonly MessageKey[];
export type TableLateEntryMessageKey = (typeof TABLE_LATE_ENTRY_MESSAGE_KEYS)[number];

/** The plural bases (`.one` / `.other` in every locale) this module emits. */
export const TABLE_LATE_ENTRY_PLURAL_KEYS = [
  "roundrobin.lateEntry.catchUp",
  "roundrobin.lateEntry.unscheduled",
  // The desk row's own sentence ("1 late player waiting — add to the table"), for a `waiting` answer.
  "roundrobin.lateWaiting",
] as const;
export type TableLateEntryPluralKey = (typeof TABLE_LATE_ENTRY_PLURAL_KEYS)[number];

type Params = Record<string, string | number>;
type Tone = "done" | "todo";
/** One line — the same shape as `LateEntryNoticeLine`, narrowed to this module's keys. */
export type TableLateEntryLine =
  | { key: TableLateEntryMessageKey; params: Params; tone: Tone }
  | { plural: TableLateEntryPluralKey; count: number; params: Params; tone: Tone };

export interface TableLateEntryOptions {
  /** The reader's locale: the rounds are listed with its conjunction (`Intl.ListFormat`). */
  locale: string;
  /** Whether the stage names its pools — more than one (owner R24: a one-pool division shows no pool letter). A `pool_key` on
   *  the answer of a one-pool group is never said. */
  pooled: boolean;
}

/**
 * One league / group result's lines. A case missing what its sentence names is refused by name — never a sentence with a
 * hole in it (a `catch_up` without its fixtures, a `refused` without a code this table knows). `waiting` is counted by the
 * caller (`lateEntryNotice`), never said one by one.
 */
export function tableLateEntryLines(r: TableLateEntryResult, nameOf: (id: string) => string, opts: TableLateEntryOptions): TableLateEntryLine[] {
  const name = nameOf(r.entrant_id);
  const refuse = (why: string) => new Error(`table late entry ${r.case} ${why}`);
  switch (r.case) {
    case "catch_up":
      return placedLines(r, name, opts, refuse);
    case "rebuild_offered":
      if (r.reason === "rebuilt") return [{ key: "roundrobin.lateEntry.rebuilt", params: { name }, tone: "done" }];
      // Nothing has started: the catch-up lines were written all the same (Task 5's default). Fix round 1 I1: the R24 7A sentence
      // ("Rebuild fixtures ... would draw it again") is said where its button is — the waiting strip, BEFORE the tap
      // (`roundrobin.lateEntry.rebuildOffered`, beside "Rebuild fixtures"). After a placement the player is on fixtures, so no
      // Rebuild is offered on the screen (no strip row, no drift banner): the notice points at none.
      return placedLines(r, name, opts, refuse);
    case "refused": {
      if (!isRoundRobinRefusalCode(r.reason)) throw refuse(`with ${r.reason === undefined ? "no reason" : `an unknown reason ${r.reason}`}`);
      const key = roundRobinRefusalKey(r.reason);
      if (!(TABLE_LATE_ENTRY_MESSAGE_KEYS as readonly string[]).includes(key)) throw refuse(`with a reason that is no late-entry refusal (${r.reason})`);
      return [{ key: key as TableLateEntryMessageKey, params: { name }, tone: "todo" }];
    }
    case "waiting":
      throw refuse("is counted by the caller, never said one by one");
  }
}

function placedLines(
  r: TableLateEntryResult,
  name: string,
  opts: TableLateEntryOptions,
  refuse: (why: string) => Error,
): TableLateEntryLine[] {
  const fixtures = r.fixtures;
  if (fixtures === undefined || fixtures.length === 0) throw refuse("without the fixtures it wrote");
  if (opts.pooled && r.format === "group" && r.pool_key === undefined) throw refuse("in a pooled group without its pool");
  const rounds = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  // A late player plays at most once a round (the catch-up rule seats one fixture per round), so the rounds ARE the matches.
  if (rounds.length !== fixtures.length) throw refuse("with two matches in one round");
  const list = new Intl.ListFormat(opts.locale, { style: "long", type: "conjunction" }).format(rounds.map(String));
  const unscheduled = fixtures.filter((f) => !f.scheduled).length;
  return [
    ...(opts.pooled && r.pool_key !== undefined
      ? [{ key: "roundrobin.lateEntry.joinedPool" as const, params: { name, pool: r.pool_key }, tone: "done" as const }]
      : []),
    { plural: "roundrobin.lateEntry.catchUp", count: fixtures.length, params: { name, rounds: list }, tone: "done" },
    ...(unscheduled > 0 ? [{ plural: "roundrobin.lateEntry.unscheduled" as const, count: unscheduled, params: {}, tone: "todo" as const }] : []),
    // Nobody is told by the app (no per-player notifier exists, W3 ruling I3), and the line cannot be taken back (RB5-L14).
    { key: "roundrobin.lateEntry.tellOpponents", params: {}, tone: "todo" },
    { key: "roundrobin.refusal.RR_LATE_ENTRY_NOT_UNDOABLE", params: {}, tone: "todo" },
  ];
}
