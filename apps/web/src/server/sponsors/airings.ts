import "server-only";
// server/sponsors/airings.ts — R4 sponsors on stream, S8: proof of play (spec 2026-10-27 §3.6.4). The compositor's
// heartbeat carries the overlay page's `seazn:sponsor:start|end` lines as `airings` (RelayAiring, api-v1/schemas.ts);
// `heartbeat` (usecases/stream-sessions.ts) hands them here inside the beat's own transaction, under the session row's
// lock, and the session's end closes whatever is still open (`closeOpenAirings`, from the one transition writer).
//
// PRIVILEGED path: app_user cannot write sponsor_airings (V483 grants it SELECT only); this runs on the relay's `sql`
// client like the rest of heartbeat handling. The database checks no cross-org reference (V483 has no composite FKs),
// so every read below is scoped to the session's org, and the session's fixture is checked to be that org's.
//
// Rules, per item, in order:
//   1. The clock: an item whose `at` is more than AIRING_CLOCK_SKEW_MS from the server's time is refused (counted).
//   2. start, scene (`source: "scene"`): the sponsor is the CARD's (`sponsorIdOfCard`), a sponsor row of this org, its
//      name read at ingest; break_kind null (a scene is not a break).
//   3. start, any other source: the sponsor, its name snapshot, the source (rotation | operator — ruling R5: the page
//      sends `rotation` for every break card), the break kind and the style are the fixture's ASSIGNMENT for the moment
//      (sponsor_assignments, S5). A sponsor deleted since keeps its assignment's name (sponsor_id null): Review Focus 4.
//   4. A start already recorded for (session, moment) keeps the FIRST row — never its card or sponsor overwritten. The
//      same sponsor again is a re-send after a lost 2xx (neither written nor refused); another one is refused, counted
//      (a compositor page reload inside a carousel showing's 10 s bucket, S7's note).
//   5. end: closes the open row (ended_at, cut_short). No row ⇒ refused (its start was dropped by the compositor's
//      64-item cap, or refused itself); an already ended row ⇒ a re-send; an end earlier than its start ⇒ refused, and
//      the row stays open for the session end to close.
// CROSS-PLAN SEAM for console C3: `skipped` is set from the operator log (`operatorLogFor`, S5); S8 writes false.
import type { Tx } from "@/lib/db";
import { SCENE_CAROUSEL_MS, SPONSOR_STYLE_BY_SIZE } from "@/lib/sponsor-plan";
import type { RelayAiring } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";

/** Spec §3.6.4: "Times > 10 min from server time are refused." Exactly 10 min is written. */
export const AIRING_CLOCK_SKEW_MS = 600_000;

/** Why an item was not recorded. A re-send of a recorded item is neither written nor refused. */
export type AiringRefusal =
  | "clock_skew"        // `at` more than AIRING_CLOCK_SKEW_MS from the server's clock
  | "foreign_fixture"   // the session's fixture is not the session's org's (cannot happen; refused by name if it does)
  | "unknown_card"      // a scene start whose card is no sponsor of this org (or not a sponsor id at all)
  | "no_assignment"     // a break start with no assignment of this org's fixture for the moment
  | "another_card"      // a second start for a recorded moment, naming another sponsor: the first row stands
  | "no_start"          // an end with no recorded start
  | "end_before_start"; // an end earlier than its start

export interface AiringsRecorded {
  written: number;
  refused: number;
  /** One entry per refused item, in item order. */
  why: AiringRefusal[];
}

/** Who the airing is for: the session row's own ids, read under its lock. `fixtureId` is null once the fixture was deleted
 *  mid-session (V410 `on delete set null`): a break card then has no assignment to name its sponsor. */
export interface AiringSession {
  sessionId: string;
  orgId: string;
  fixtureId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sponsor a scene card names. The MVP card source (spec §3.3) reads `sponsors`, one card per sponsor, and the
 * card's id IS the sponsor's id — so a card id that is not a uuid names no sponsor (null, never a cast error inside the
 * beat's transaction). SEAM for S5: `sponsorsTableCardSource` must serve `card.id === card.sponsorId`; its test should
 * assert `sponsorIdOfCard(card.id) === card.sponsorId` for every card it serves, or every scene airing is refused here.
 */
export function sponsorIdOfCard(cardId: string): string | null {
  return UUID.test(cardId) ? cardId.toLowerCase() : null;
}

type Outcome = "written" | "resent" | AiringRefusal;

/** The airing's sponsor and shape for a start, or why there is none. */
type StartFacts = { sponsorId: string | null; sponsorName: string; source: string; breakKind: string | null; style: string };

async function startFacts(tx: Tx, s: AiringSession, item: Extract<RelayAiring, { kind: "start" }>): Promise<StartFacts | AiringRefusal> {
  if (item.source === "scene") {
    const id = sponsorIdOfCard(item.cardId);
    if (id === null) return "unknown_card";
    const [sp] = await tx<{ id: string; name: string }[]>`select id, name from sponsors where id = ${id} and org_id = ${s.orgId}`;
    if (!sp) return "unknown_card";
    return { sponsorId: sp.id, sponsorName: sp.name, source: "scene", breakKind: null, style: item.style };
  }
  if (s.fixtureId === null) return "no_assignment";
  const [a] = await tx<{ sponsor_id: string | null; sponsor_name: string; source: string; break_kind: string; style: string }[]>`
    select sponsor_id, sponsor_name, source, break_kind, style from sponsor_assignments
     where fixture_id = ${s.fixtureId} and moment_id = ${item.momentId} and org_id = ${s.orgId}`;
  if (!a) return "no_assignment";
  return { sponsorId: a.sponsor_id, sponsorName: a.sponsor_name, source: a.source, breakKind: a.break_kind, style: a.style };
}

async function recordStart(tx: Tx, s: AiringSession, item: Extract<RelayAiring, { kind: "start" }>, at: Date): Promise<Outcome> {
  const facts = await startFacts(tx, s, item);
  if (typeof facts === "string") return facts;
  const inserted = await tx`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style, started_at, skipped)
    values (${s.orgId}, ${facts.sponsorId}, ${facts.sponsorName}, ${s.fixtureId}, ${s.sessionId}, ${item.momentId}, ${facts.source},
            ${facts.breakKind}, ${facts.style}, ${at}, false)
    on conflict (session_id, moment_id) do nothing
    returning id`;
  if (inserted.length === 1) return "written";
  // Rule 4: the first row stands. A re-send names the sponsor it named; anything else is another card.
  const [first] = await tx<{ sponsor_id: string | null }[]>`
    select sponsor_id from sponsor_airings where session_id = ${s.sessionId} and moment_id = ${item.momentId}`;
  return first !== undefined && first.sponsor_id === facts.sponsorId ? "resent" : "another_card";
}

async function recordEnd(tx: Tx, s: AiringSession, item: Extract<RelayAiring, { kind: "end" }>, at: Date): Promise<Outcome> {
  const closed = await tx`
    update sponsor_airings set ended_at = ${at}, cut_short = ${item.cutShort}
     where session_id = ${s.sessionId} and moment_id = ${item.momentId} and org_id = ${s.orgId}
       and ended_at is null and started_at <= ${at}
    returning id`;
  if (closed.length === 1) return "written";
  const [row] = await tx<{ ended_at: Date | null }[]>`
    select ended_at from sponsor_airings where session_id = ${s.sessionId} and moment_id = ${item.momentId} and org_id = ${s.orgId}`;
  if (!row) return "no_start";
  return row.ended_at !== null ? "resent" : "end_before_start";
}

/**
 * Records one beat's proof-of-play items (spec §3.6.4). Runs on the caller's transaction (the beat's, under the session
 * row's lock, inside a savepoint the caller owns): a database error is thrown, never swallowed here. An empty list reads
 * nothing. Returns what it wrote and what it refused, and why.
 */
export async function recordAirings(tx: Tx, s: AiringSession, items: readonly RelayAiring[], now: Date): Promise<AiringsRecorded> {
  const out: AiringsRecorded = { written: 0, refused: 0, why: [] };
  if (items.length === 0) return out;
  // "Cannot happen" as a guard: the session's fixture is the session's org's (the DB does not check it, V483 note).
  if (s.fixtureId !== null) {
    const [f] = await tx<{ org_id: string }[]>`select org_id from fixtures where id = ${s.fixtureId}`;
    if (f !== undefined && f.org_id !== s.orgId) {
      log.error({ sid: s.sessionId, orgId: s.orgId, fixtureId: s.fixtureId, items: items.length }, "sponsor airings: the session's fixture belongs to another org — every item refused");
      return { written: 0, refused: items.length, why: items.map(() => "foreign_fixture") };
    }
  }
  for (const item of items) {
    const atMs = Date.parse(item.at);
    let outcome: Outcome;
    if (!(Math.abs(atMs - now.getTime()) <= AIRING_CLOCK_SKEW_MS)) outcome = "clock_skew";
    else if (item.kind === "start") outcome = await recordStart(tx, s, item, new Date(atMs));
    else outcome = await recordEnd(tx, s, item, new Date(atMs));
    if (outcome === "written") out.written++;
    else if (outcome !== "resent") {
      out.refused++;
      out.why.push(outcome);
    }
  }
  if (out.refused > 0) {
    log.warn({ sid: s.sessionId, orgId: s.orgId, written: out.written, refused: out.refused, why: out.why }, "sponsor airings: items refused — not recorded; the beat is answered");
  }
  return out;
}

/** The hold of the slot an airing filled, from the declarations the page holds by (S6/S7): a scene carousel showing is
 *  SCENE_CAROUSEL_MS; a break card is its style's hold in SPONSOR_STYLE_BY_SIZE (lower third 8 s, banner 15 s). */
function holdOfStyle(style: "lower_third" | "banner"): number {
  const found = Object.values(SPONSOR_STYLE_BY_SIZE).filter((look) => look.style === style);
  // A guard, not a comment: each style is ONE break size's, or "the card's hold" would be ambiguous.
  if (found.length !== 1) throw new Error(`sponsor airings: style ${style} is declared by ${found.length} break sizes — want exactly 1`);
  return found[0]!.holdMs;
}
export const AIRING_HOLD_MS = {
  scene: SCENE_CAROUSEL_MS,
  lower_third: holdOfStyle("lower_third"),
  banner: holdOfStyle("banner"),
} as const;

/**
 * Spec §3.6.4: "An airing with no `end` by session end closes at the last beat and is flagged `ended_estimated`" — and,
 * coordinator addendum (SC1 review): TRUTHFULLY. A start with no end is a crashed page or compositor (a retired page
 * sends its own `end`, cutShort), so the card left the screen no later than its hold ran out: the end is the EARLIER of
 * `sessionEndAt` (the last beat received) and the start plus its slot's hold (AIRING_HOLD_MS), never before the start
 * itself, and the row is marked cut_short (it did not end as the page meant it to). Called once, from the transition that
 * ends the session. Returns how many it closed.
 */
export async function closeOpenAirings(tx: Tx, sessionId: string, sessionEndAt: Date): Promise<number> {
  const closed = await tx`
    update sponsor_airings
       set ended_at = greatest(started_at, least(${sessionEndAt}::timestamptz, started_at + make_interval(secs => (
             case when source = 'scene' then ${AIRING_HOLD_MS.scene}::int
                  when style = 'lower_third' then ${AIRING_HOLD_MS.lower_third}::int
                  when style = 'banner' then ${AIRING_HOLD_MS.banner}::int end) / 1000.0))),
           ended_estimated = true, cut_short = true
     where session_id = ${sessionId} and ended_at is null
    returning id`;
  return closed.length;
}
