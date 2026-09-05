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
  topPerformers: z.array(z.object({ role: z.enum(["batter", "bowler"]), person: Person, side: Side, line: z.string(), detail: z.string().nullable() })),
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
