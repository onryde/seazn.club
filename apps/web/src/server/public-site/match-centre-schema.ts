// Spectator surface W1 — the match-centre document schema (design doc
// "Web view model and transport"). Names here are what the UI and the API
// use directly; keep camelCase inside the document even though the API
// field that carries it on the wire is `match_centre` (snake_case, set by
// the route that serialises this doc — not this file's concern).
import { z } from "zod";

export const MatchCentreTabId = z.enum(["summary", "scorecard", "commentary", "timeline", "sets", "info"]);
export const Msg = z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() }); // a dictionary key + params, resolved client-side with t()

export const Side = z.object({ entrantId: z.string(), name: z.string(), short: z.string(), colour: z.string().nullable(), badgeUrl: z.string().nullable() });
export const Person = z.object({ personId: z.string(), name: z.string(), masked: z.boolean() });

export const MatchCentreHeader = z.object({
  live: z.boolean(),
  status: z.enum(["scheduled", "in_play", "decided", "other"]),
  sides: z.tuple([Side, Side]),
  scoreLines: z.tuple([z.string().nullable(), z.string().nullable()]),   // "56/6" | "2" | "6-4 3-6"
  subLines: z.tuple([z.string().nullable(), z.string().nullable()]),     // "(8.0)" | null
  battingIndex: z.union([z.literal(0), z.literal(1)]).nullable(),
  statusLine: Msg.nullable(),        // "Queens need 34 from 21" / "Blue Blazers won by 12 runs" / "Starts Sat 14:00"
  rateLine: z.string().nullable(),   // "CRR 8.44 · RRR 9.71" — numbers, no copy
  // The period kernel's live pair, restored after the W1 read found both had
  // been dropped. `summary-tab.tsx` passes `suppressScorebug` for every
  // non-cricket sport (R11/C7 — the court slab must not paint twice), and the
  // suppressed block was the ONLY renderer of either: a hockey spectator lost
  // the power-play chip entirely, and the live phase survived only inside the
  // Periods tab. Both are header facts — "which period, and is someone a man
  // up" is what the top of the page is for.
  //
  // `phase` is the engine's RAW token ("P1", "ET_H2"), resolved to copy by the
  // renderer through `term.<phase>`; `strength` is a number pair ("5v4") and
  // is not copy at all. Both null unless the match is in play — a finished
  // match has no current phase and nobody is a man up.
  phase: z.string().nullable(),
  strength: z.string().nullable(),
  /**
   * Where the match currently IS, for a sport whose answer is not a term token
   * — cricket's over ("5.1 ov"). It sits after the status word in the live
   * pill, which is where `phase` already sits for the period sports, and the
   * design board's `LIVE · 12.3 OV` is this field.
   *
   * SEPARATE FROM `phase` on purpose. `phase` is the engine's raw period token
   * resolved through `term.<phase>`; setting it to "5.1 ov" would work only by
   * falling through its missing-key fallback, which would make a lookup failure
   * the mechanism rather than the safety net. An over is also not copy — it is
   * numerals and a unit, the same "numbers, no copy" `rateLine` above is.
   *
   * Null for every sport that has no such answer, and for every status but
   * in_play: a finished match is not anywhere.
   *
   * A `Msg`, not a string, because the unit is COPY — the board's "12.3 OV"
   * is a number plus a translated word, and "ov" is not "ov" in every locale.
   * Same key+params shape as `statusLine`, resolved client-side by `t()` on
   * the same tick a live push changes it.
   */
  pillNote: Msg.nullable(),
  /**
   * The one-line match identity — "8-over match · Round 1 · Garon Park".
   * Already-resolved strings joined with a separator, never copy this module
   * composes: the format label arrives pre-resolved from the caller
   * (`MatchCentreInput.formatLabel`), the round from `stage.roundLabel`, and
   * the venue is a proper noun. `null` when none of the three exists, never a
   * string of bare separators.
   */
  metaLine: z.string().nullable(),
  updatedAt: z.string(),             // ISO
});

export const CricketBattingRow = z.object({ person: Person, runs: z.number(), balls: z.number(), fours: z.number().nullable(), sixes: z.number().nullable(), strikeRate: z.string().nullable(), dismissal: Msg, notOut: z.boolean() });
export const CricketBowlingRow = z.object({ person: Person, overs: z.string(), maidens: z.number().nullable(), runs: z.number(), wickets: z.number(), economy: z.string().nullable(), wides: z.number().nullable(), noBalls: z.number().nullable() });
export const CricketInningsView = z.object({
  number: z.number(), side: Side, isSuperOver: z.boolean(),
  total: z.object({ runs: z.number(), wickets: z.number(), overs: z.string(), runRate: z.string().nullable() }),
  extrasLine: z.string().nullable(),
  batting: z.array(CricketBattingRow), didNotBat: z.array(Person), bowling: z.array(CricketBowlingRow),
  fallOfWickets: z.array(z.object({ wicket: z.number(), runs: z.number(), over: z.string(), batter: Person })),
  partnerships: z.array(z.object({ batters: z.tuple([Person, Person]), runs: z.number(), balls: z.number(), wicket: z.union([z.number(), z.literal("unbroken")]) })),
  overs: z.array(z.object({ number: z.number(), bowler: Person.nullable(), glyphs: z.array(z.string()), runs: z.number(), wickets: z.number(), scoreAfter: z.string(), lines: z.array(Msg) })), // glyph strings "1","4","W","wd","nb+2","·"
});
export const CricketView = z.object({
  band: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  toss: Msg.nullable(),
  innings: z.array(CricketInningsView),
  live: z.object({ striker: Person.nullable(), nonStriker: Person.nullable(), bowler: Person.nullable(), batters: z.array(CricketBattingRow), bowling: z.array(CricketBowlingRow), thisOver: z.array(z.string()), partnership: z.string().nullable(), lastWicket: Msg.nullable() }).nullable(),
  // `innings` (review round 1, Important #2) — WHICH innings the builder
  // (`topPerformersOf`) drew this performer from, carried straight off
  // `CricketInningsCard.number` at the point of selection. Added because the
  // component used to re-derive this by searching `innings[].batting`/
  // `bowling` for a matching `person.personId` — a person who appears in
  // BOTH a main innings and a Super Over (the same squad, drawn from twice)
  // silently resolved to whichever innings `.find()` hit first, always the
  // main one. The producer already knows the real answer; carrying it out
  // is the fix, not a smarter lookup at the consumer.
  topPerformers: z.array(
    z.object({ role: z.enum(["batter", "bowler"]), person: Person, side: Side, line: z.string(), detail: z.string().nullable(), innings: z.number() }),
  ),
});
export const TimelineLine = z.object({ seq: z.number(), at: z.string().nullable(), marker: z.string().nullable(), sideIndex: z.union([z.literal(0), z.literal(1)]).nullable(), text: Msg, emphasis: z.enum(["normal", "score", "strong"]) });
// `unit` (controller ruling, Task 7 review): what ONE column is called in the
// sport's own vocabulary — badminton and table tennis score GAMES, tennis and
// volleyball score SETS, and the period sports score PERIODS. It is optional
// so a document built before this field existed still parses; the renderer
// falls back to the raw `columns` string when it is absent.
// `columnLabels` (product ruling): the ENGINE'S OWN phase token for each column
// — "H1", "ET_H2", "OT", "P3", "SHOOTOUT" — so the renderer can print "ET 2nd
// half" rather than the ordinal fallback "Period 4". Undefined for set-based
// sports, where a set has no name beyond its number. The renderer resolves each
// token through `term.<label>` and falls back to `matchCentre.col.<unit>` when
// there is no such key, so an unbounded label (`P7`, `OT3`) still reads.
export const SetsView = z.object({ kind: z.enum(["sets", "periods"]), unit: z.enum(["set", "game", "period"]).optional(), columns: z.array(z.string()), columnLabels: z.array(z.string()).optional(), rows: z.tuple([z.array(z.string().nullable()), z.array(z.string().nullable())]), closedMask: z.array(z.boolean()) });
export const InfoView = z.object({ rows: z.array(z.object({ label: Msg, value: Msg })), calendarHref: z.string().nullable(), divisionHref: z.string(), competitionHref: z.string() });

export const MatchCentreDoc = z.object({
  fixtureId: z.string(), sportKey: z.string(), header: MatchCentreHeader,
  /**
   * M1 k2 — the three facts the fixture page's subheading line is made of
   * ("20 Jul 2026, 14:30 · Riverside Sports Hall · Court 3"), carried on the
   * LIVE document so that line can re-render from a poll or a push like every
   * other part of the page (rule R10). Before this they were read once, on the
   * server, off the fixture row: after a rain-delay reschedule the court card
   * below showed the new kick-off and the line above it still showed the old
   * one — one page, two times, until the reader reloaded.
   *
   * `startTime` is ALREADY FORMATTED, by the same `startTimeText`
   * (`match-centre.ts`) that fills `matchCentre.status.startsAt`'s `{time}`
   * param. That is the point: the subheading and the court card cannot read
   * differently, because there is one formatter and one call per document. It
   * also drags the venue timezone along — the page's own `toLocaleString` had
   * no `timeZone` at all and printed the rendering SERVER's zone.
   *
   * `venueName`/`courtName` are the derived join-backed names (`venue_name`/
   * `court_name`) — the same pair `header.metaLine` and the Info tab's venue
   * row read, never the frozen `venue`/`court_label` columns.
   *
   * Here and not on `MatchCentreHeader`: these are FIXTURE facts, the company
   * `fixtureId`/`sportKey` beside them keep, not scorebug state — and the
   * header schema is reused whole by the competition hub's own card builder
   * (`competition-hub.ts`'s `hubHeader`), which has neither a locale nor a
   * venue timezone in hand and would have had to invent nulls for all three.
   *
   * OPTIONAL, not bare `.nullable()`: a document built before these fields
   * existed (a cached ISR payload, a hand-built fixture) still parses — the
   * same reason `SetsView.unit`/`columnLabels` are optional. Absent and null
   * both mean "nothing to show"; the builder always emits an explicit value.
   */
  startTime: z.string().nullable().optional(),
  venueName: z.string().nullable().optional(),
  courtName: z.string().nullable().optional(),
  tabs: z.array(MatchCentreTabId).min(1),
  cricket: CricketView.nullable(), timeline: z.array(TimelineLine).nullable(), sets: SetsView.nullable(), info: InfoView,
  // Did the timeline's DERIVED pass run to completion? `buildTimeline` replays
  // the module to find closed sets and period ends, and a ledger the module
  // refuses part-way stops that replay — the recorded lines all still render,
  // so the tab looks complete while every set-won line after the failure is
  // silently missing. `false` is how a consumer (a debug view, a monitor, a
  // future "some detail unavailable" note) can tell the two apart. Defaulted so
  // a document built before this field existed still parses, and so cricket —
  // which has no timeline and therefore nothing to derive — need not say so.
  derivedComplete: z.boolean().default(true),
});
export type MatchCentreDocT = z.infer<typeof MatchCentreDoc>;
export type MatchCentreHeaderT = z.infer<typeof MatchCentreHeader>;
// Controller ruling (task-5 dispatch): a later task consumes the tab-id
// union type directly, so it is exported alongside the other inferred types
// even though the brief's own code block did not list it.
export type MatchCentreTabIdT = z.infer<typeof MatchCentreTabId>;
export type CricketViewT = z.infer<typeof CricketView>;
export type TimelineLineT = z.infer<typeof TimelineLine>;
export type SetsViewT = z.infer<typeof SetsView>;
export type InfoViewT = z.infer<typeof InfoView>;
export type PersonT = z.infer<typeof Person>;
export type SideT = z.infer<typeof Side>;
export type MsgT = z.infer<typeof Msg>;
