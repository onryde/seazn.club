// R4 sponsors on stream, S5 — the assignment writer behind the overlay's `sponsorPlan` (spec 2026-10-27 §3.2, plan P3):
// every poll plans; only a poll that hands a break its first card (or finds an unaired one undone) takes the org's
// rotation lock and writes. Real Postgres throughout; the planner is S4's own (`planSponsors`), never a double.
//
// Expectations are the spec's and the rulebook's: the dial (§3.2, "Light = every major"), the D14 org-wide cycle, P7's
// smooth weighted round robin (title 3, gold 2 — D9's weights, `SPONSOR_TIER_WEIGHTS`), the S3 name snapshot, R3, R7.
// Break kinds and sizes come from the engine's own cricket module (a REAL replay of a real T20 ledger) or are named with
// the size cricket declares for them — never from the code under test.
//
// The transitions (TEST-STRATEGY rule 1), and where each is pinned:
//   first poll writes; second poll writes nothing ............... "back to back", "nothing new"
//   two fixtures at once; two polls of one fixture ............. "concurrent"
//   a poll with nothing new takes no lock ....................... "nothing new"
//   a sponsor deleted after its break was assigned .............. "deleted sponsor"
//   a break undone (void/undo): unaired deleted, aired kept, and
//     nothing deleted from an incomplete replay (R3) ............ "undone"
//   the dial changed after a break froze ........................ "frozen"
//   unticked / pending / inactive after assignment .............. "untick"
//   the settings scopes, and the PUT ............................ "settings"
//   the short code (R7): minted once, collisions, ownership ..... "short code"
//   ownership of the write; a lost row under the lock ........... "guards"
//   empty: rotation off, no settings, no card, no breaks ........ "empty"
//   a planner refusal ........................................... "refusal"
// Two sports' breaks: cricket (a real T20 replay) and hockey (its shoot-out break, a major — S1/S2's ruling); the rest is
// single-sport on purpose: the writer reads no sport, only the breaks it is handed.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { cricket } from "@seazn/engine/sports/cricket";
import { builtinModules } from "@seazn/engine/sports";
import {
  SPONSOR_STALE_MS, SPONSOR_STYLE_BY_SIZE, sponsorMomentId,
  type BreakOpened, type SponsorAssignment, type SponsorCard, type SponsorFrequency,
} from "@/lib/sponsor-plan";
import { SPONSOR_SHORT_CODE_PATTERN, SPONSOR_SHORT_CODE_MAX_LENGTH, SPONSOR_SHORT_CODE_MIN_LENGTH } from "@/lib/sponsor-short-code";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { deleteSponsor, resolveSponsors } from "@/server/usecases/sponsors";
import { recentWindow, replayDerived } from "@/server/overlay/recent";
import { AWAY, HOME, scriptLedger } from "@/server/public-site/__tests__/cricket-ledger";
import {
  SponsorAssignmentWriteError, assignmentsFor, loadFixtureSponsorPlan, loadSponsorPlan, lockSponsorRotation, sponsorContextOf,
  sponsorRotationLockKey, sponsorScopeOf, writeAssignments,
} from "../assign";
import { sponsorsTableCardSource, type SponsorCardSource } from "../card-source";
import { operatorLogFor } from "../operator-log";
import { SHORT_CODE_DRAWS_PER_LENGTH, ShortCodeExhaustedError, ShortCodeOwnershipError, drawShortCode, mintShortCode } from "../short-codes";
import { putStreamSettings, resolveStreamSettings } from "../stream-settings";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const SEC = 1000;

/** Cricket's declared sizes (engine 1.1.0): read off the module, so a re-sized kind moves the tests with it. */
const cricketSize = (kind: string) => {
  const k = cricket.naturalBreaks?.kinds.find((d) => d.kind === kind);
  if (k === undefined) throw new Error(`cricket declares no "${kind}"`);
  return k.size;
};
const hockeySize = (kind: string) => {
  const k = builtinModules.find((m) => m.key === "hockey")?.naturalBreaks?.kinds.find((d) => d.kind === kind);
  if (k === undefined) throw new Error(`hockey declares no "${kind}"`);
  return k.size;
};
const brk = (seq: number, kind: string, size: "minor" | "major", atMs: number): BreakOpened =>
  ({ seq, kind, size, at: new Date(atMs).toISOString() });
const overEnd = (seq: number, atMs: number) => brk(seq, "over_end", cricketSize("over_end"), atMs);

// ---------------------------------------------------------------------------------------------------------------
// Rigs.
// ---------------------------------------------------------------------------------------------------------------
interface Rig {
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  orgId: string;
  competitionId: string;
  fixtureIds: string[];
}
async function rig(o: { plan?: "pro" | "community"; fixtures?: 1 | 2 } = {}): Promise<Rig> {
  const { auth } = await seedOrg(o.plan ?? "pro");
  const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, o.fixtures === 2 ? { fixtures: 2 } : {});
  const [d] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${divisionId}`;
  return { auth, orgId: auth.orgId, competitionId: d!.competition_id, fixtureIds };
}
async function sponsor(
  orgId: string, name: string,
  o: { tier?: string; url?: string | null; onStream?: boolean; status?: string; competitionId?: string | null; logo?: string | null } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, url, logo_path, tier, status, on_stream)
    values (${orgId}, ${o.competitionId ?? null}, ${name}, ${o.url === undefined ? `https://${name.toLowerCase().replace(/\W+/g, "-")}.example` : o.url},
            ${o.logo ?? null}, ${o.tier ?? "partner"}, ${o.status ?? "active"}, ${o.onStream ?? true})
    returning id`;
  return row!.id;
}
async function settings(orgId: string, competitionId: string | null, enabled: boolean, frequency: SponsorFrequency) {
  await sql`
    insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency) values (${orgId}, ${competitionId}, ${enabled}, ${frequency})
    on conflict on constraint sponsor_stream_settings_scope_key do update set enabled = excluded.enabled, frequency = excluded.frequency`;
}
const rowsOf = (fixtureId: string) => sql<{
  moment_id: string; seq: number; sponsor_id: string | null; sponsor_name: string; position: number | null; source: string;
  break_kind: string; style: string; hold_ms: number;
}[]>`
  select moment_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms
    from sponsor_assignments where fixture_id = ${fixtureId} order by seq, moment_id`;

/** The widest seq: by default a poll's fold saw every seq a test names (a fresh door). */
const ALL_SEQS = 2 ** 31 - 1;
function poll(
  r: Rig, fixtureId: string, breaks: BreakOpened[],
  o: {
    now: number; complete?: boolean; windowSeqs?: number[]; source?: SponsorCardSource; draw?: (n: number) => string; orgId?: string;
    foldedThrough?: number | null; readOnly?: boolean;
  },
) {
  return loadSponsorPlan(
    {
      fixtureId, orgId: o.orgId ?? r.orgId, competitionId: r.competitionId, breaks, windowSeqs: o.windowSeqs ?? breaks.map((b) => b.seq),
      complete: o.complete ?? true, foldedThrough: o.foldedThrough === undefined ? ALL_SEQS : o.foldedThrough,
    },
    { now: o.now, source: o.source, draw: o.draw, readOnly: o.readOnly },
  );
}
const codesOf = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_short_codes where fixture_id = ${fixtureId}`)[0]!.n;
/** The sponsor each airing shows, by moment. */
const airedBy = (plan: Awaited<ReturnType<typeof loadSponsorPlan>>) =>
  Object.fromEntries((plan?.airings ?? []).map((a) => [a.momentId, plan!.cards.find((c) => c.id === a.cardId)?.sponsorId ?? "?"]));

/** A REAL T20 ledger (the engine's own t20 variant; eight a side so the rig's lineups fit): the first innings all out for 0 (seven wickets),
 *  the reply two dot balls in (a single would win it). Replayed through the overlay's own `replayDerived`, stamped `ago` ms before `now`. */
function t20Breaks(now: number, ago = 2 * SEC) {
  const L = scriptLedger({
    cfg: { ...(cricket.variants.t20 as object), playersPerSide: 8 },
    home: HOME, away: AWAY, tossWonBy: "home", elected: "bat",
    innings: [
      { batting: "home", bowlers: ["a1", "a2"], deliveries: Array.from({ length: 7 }, () => ({ out: "bowled" as const })), close: "all_out" },
      { batting: "away", bowlers: ["h1", "h2"], deliveries: [{ bat: 0 }, { bat: 0 }], leaveOpen: true },
    ],
  });
  const at = new Date(now - ago).toISOString();
  const events = L.events.map((e) => ({ ...e, recordedAt: at }));
  const r = replayDerived({ sportKey: "cricket", module: cricket as never, cfg: L.cfg, lineups: L.lineups, active: events });
  expect(r.breaksComplete, "premise: the T20 replays whole").toBe(true);
  return { breaks: r.breaks, windowSeqs: recentWindow(events).map((e) => e.seq) };
}

/** Holds the org's rotation lock in an open transaction until released — the observable for "takes no lock". */
async function holdTheLock(orgId: string) {
  let release!: () => void;
  const released = new Promise<void>((res) => (release = res));
  let held!: () => void;
  const isHeld = new Promise<void>((res) => (held = res));
  const tx = sql.begin(async (t: Tx) => {
    await lockSponsorRotation(t, orgId);
    held();
    await released;
  });
  await isHeld;
  return { release: async () => { release(); await tx; } };
}
/** Sessions waiting on THIS org's rotation lock (pg_locks: an advisory lock on a 32-bit key keeps it in objid). */
async function waitersOn(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and not granted and objid::bigint = (hashtext(${sponsorRotationLockKey(orgId)})::bigint & 4294967295)`;
  return row!.n;
}
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ done: true as const, v })), new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), ms))]);

describe.skipIf(!HAS_DB)("S5: the sponsor assignment writer", () => {
  it("back to back (D14): on Light a T20's single innings break airs TITLE in match 1 and GOLD in match 2 — one org cycle, match 2's position is match 1's + 1", async () => {
    const r = await rig({ fixtures: 2 });
    await settings(r.orgId, null, true, "light");
    const title = await sponsor(r.orgId, "Title Co", { tier: "title" });
    const gold = await sponsor(r.orgId, "Gold Co", { tier: "gold" });
    const now = Date.now();
    const m1 = t20Breaks(now);
    // Premise, from the engine: the T20 opened over ends (minors) and exactly ONE major, the innings break.
    expect(m1.breaks.filter((b) => b.size === "major").map((b) => b.kind)).toEqual(["innings_break"]);
    expect(m1.breaks.some((b) => b.kind === "over_end"), "premise: the minors exist, so Light has something to skip").toBe(true);
    const ib = m1.breaks.find((b) => b.kind === "innings_break")!;
    const id = sponsorMomentId(ib.seq, ib.kind);

    const p1 = await poll(r, r.fixtureIds[0]!, m1.breaks, { now, windowSeqs: m1.windowSeqs });
    // P7's smooth weighted round robin over title 3 + gold 2 opens T, G, …: position 0 is the title.
    expect(airedBy(p1)).toEqual({ [id]: title });
    const m2 = t20Breaks(now + 60 * 60 * SEC);
    const p2 = await poll(r, r.fixtureIds[1]!, m2.breaks, { now: now + 60 * 60 * SEC, windowSeqs: m2.windowSeqs });
    expect(airedBy(p2), "match 2 continues the org's cycle instead of restarting it").toEqual({ [id]: gold });

    const [a1] = await rowsOf(r.fixtureIds[0]!);
    const [a2] = await rowsOf(r.fixtureIds[1]!);
    expect(a1).toMatchObject({ moment_id: id, sponsor_id: title, sponsor_name: "Title Co", position: 0, source: "rotation", break_kind: "innings_break",
      style: SPONSOR_STYLE_BY_SIZE.major.style, hold_ms: SPONSOR_STYLE_BY_SIZE.major.holdMs });
    expect(a2).toMatchObject({ moment_id: id, sponsor_id: gold, sponsor_name: "Gold Co", position: a1!.position! + 1 });
    expect((await rowsOf(r.fixtureIds[0]!)).length, "Light: the over ends got nothing").toBe(1);
    // A second poll of match 1 (the same breaks): served from the frozen row, nothing new.
    expect(airedBy(await poll(r, r.fixtureIds[0]!, m1.breaks, { now, windowSeqs: m1.windowSeqs }))).toEqual({ [id]: title });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
  });

  it("hockey's shoot-out break is a MAJOR: Light assigns it, and the same dial skips the restart after a goal", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "light");
    const a = await sponsor(r.orgId, "Acme");
    const now = Date.now();
    const breaks = [brk(3, "after_goal", hockeySize("after_goal"), now - 3 * SEC), brk(7, "shootout_break", hockeySize("shootout_break"), now - SEC)];
    expect(airedBy(await poll(r, r.fixtureIds[0]!, breaks, { now }))).toEqual({ [sponsorMomentId(7, "shootout_break")]: a });
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => [x.break_kind, x.style])).toEqual([["shootout_break", SPONSOR_STYLE_BY_SIZE.major.style]]);
  });

  it("concurrent: two fixtures of one org polled at once both commit, with DISTINCT positions", async () => {
    const r = await rig({ fixtures: 2 });
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const b = await sponsor(r.orgId, "Bolt");
    const now = Date.now();
    const plans = await Promise.all(r.fixtureIds.map((f) => poll(r, f, [overEnd(6, now - SEC)], { now })));
    const rows = [...(await rowsOf(r.fixtureIds[0]!)), ...(await rowsOf(r.fixtureIds[1]!))];
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.position).sort()).toEqual([0, 1]);
    // Two positions of a two-card cycle: each sponsor once, whichever fixture won the lock.
    expect(rows.map((x) => x.sponsor_id).sort()).toEqual([a, b].sort());
    expect(plans.map((p) => Object.values(airedBy(p))[0]).sort()).toEqual([a, b].sort());
  });

  it("concurrent: two polls of ONE fixture leave exactly one assignment per moment, and serve the same card", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    await sponsor(r.orgId, "Bolt");
    const now = Date.now();
    const breaks = [overEnd(6, now - 200 * SEC), overEnd(12, now - SEC)];
    const [p, q] = await Promise.all([poll(r, r.fixtureIds[0]!, breaks, { now }), poll(r, r.fixtureIds[0]!, breaks, { now })]);
    const rows = await rowsOf(r.fixtureIds[0]!);
    // seq 6 is past the 20 s freshness cut (R2): only seq 12 is assignable.
    expect(rows.map((x) => x.moment_id)).toEqual([sponsorMomentId(12, "over_end")]);
    expect(airedBy(p)).toEqual(airedBy(q));
    expect(Object.keys(airedBy(p))).toEqual([sponsorMomentId(12, "over_end")]);
    const [codes] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_short_codes where fixture_id = ${r.fixtureIds[0]!}`;
    expect(codes!.n, "one code per (sponsor, fixture), both polls minting at once").toBe(2);
  });

  it("nothing new takes NO lock: a poll whose breaks are all assigned resolves while the lock is held; a poll with a new break waits for it", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    const now = Date.now();
    const first = [overEnd(6, now - 2 * SEC)];
    await poll(r, r.fixtureIds[0]!, first, { now });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);

    const lock = await holdTheLock(r.orgId);
    try {
      const again = await within(poll(r, r.fixtureIds[0]!, first, { now }), 5 * SEC);
      expect(again.done, "the poll with nothing new never asked for the rotation lock").toBe(true);
      expect(await waitersOn(r.orgId)).toBe(0);

      // The positive pair: a NEW break (seq 12, 100 s after the first — past the minor cooldown) must wait.
      const later = now + 100 * SEC;
      const pending = poll(r, r.fixtureIds[0]!, [...first, overEnd(12, later - SEC)], { now: later });
      let waiting = 0;
      for (let i = 0; i < 50 && waiting === 0; i++) {
        waiting = await waitersOn(r.orgId);
        if (waiting === 0) await new Promise((res) => setTimeout(res, 100));
      }
      expect(waiting, "the poll with a new break is queued on the org's rotation lock").toBe(1);
      expect((await within(pending, 300)).done).toBe(false);
      await lock.release();
      await pending;
      expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(2);
    } finally {
      await lock.release();
    }
  });

  it("deleted sponsor: its assignment stays (the break is never handed on) but drops from cards and airings; the others keep their positions", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const b = await sponsor(r.orgId, "Bolt");
    const now = Date.now();
    // 100 s apart (past the minor cooldown), each fresh when its poll ran.
    const b1 = overEnd(6, now - SEC);
    await poll(r, r.fixtureIds[0]!, [b1], { now });
    const b2 = overEnd(12, now + 100 * SEC - SEC);
    await poll(r, r.fixtureIds[0]!, [b1, b2], { now: now + 100 * SEC });
    const before = await rowsOf(r.fixtureIds[0]!);
    expect(before.map((x) => [x.sponsor_id, x.position])).toEqual([[a, 0], [b, 1]]);

    await deleteSponsor(r.auth, b);
    const plan = await poll(r, r.fixtureIds[0]!, [b1, b2], { now: now + 101 * SEC });
    expect(airedBy(plan)).toEqual({ [sponsorMomentId(6, "over_end")]: a });
    expect(plan!.cards.map((c) => c.sponsorId)).toEqual([a]);
    const after = await rowsOf(r.fixtureIds[0]!);
    expect(after.map((x) => [x.moment_id, x.sponsor_id, x.sponsor_name, x.position])).toEqual([
      [before[0]!.moment_id, a, "Acme", 0],
      [before[1]!.moment_id, null, "Bolt", 1],
    ]);
  });

  it("undone: a break gone from a COMPLETE replay deletes its unaired assignment and keeps the aired one; an incomplete replay deletes nothing (R3)", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const now = Date.now();
    const b1 = overEnd(6, now - SEC);
    await poll(r, r.fixtureIds[0]!, [b1], { now });
    const b2 = overEnd(12, now + 100 * SEC - SEC);
    await poll(r, r.fixtureIds[0]!, [b1, b2], { now: now + 100 * SEC });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(2);
    // seq 6 aired (proof of play), seq 12 did not.
    await sql`
      insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at)
      values (${r.orgId}, ${a}, 'Acme', ${r.fixtureIds[0]!}, ${sponsorMomentId(6, "over_end")}, 'rotation', 'over_end', 'lower_third', now())`;

    // Both breaks undone, but the replay stopped part-way: nothing is proven gone.
    await poll(r, r.fixtureIds[0]!, [], { now: now + 101 * SEC, complete: false });
    expect(await rowsOf(r.fixtureIds[0]!), "R3: an incomplete replay deletes nothing").toHaveLength(2);

    const plan = await poll(r, r.fixtureIds[0]!, [], { now: now + 102 * SEC });
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.moment_id)).toEqual([sponsorMomentId(6, "over_end")]);
    expect(plan!.airings, "an undone break airs nothing").toEqual([]);
    // A second complete poll: nothing left to delete, nothing written.
    await poll(r, r.fixtureIds[0]!, [], { now: now + 103 * SEC });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
  });

  it("frozen: a break assigned on Busy still airs after the dial goes to Light; a NEW minor on Light gets nothing", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const now = Date.now();
    const b1 = overEnd(6, now - SEC);
    await poll(r, r.fixtureIds[0]!, [b1], { now });
    await settings(r.orgId, null, true, "light");
    const b2 = overEnd(12, now + 100 * SEC - SEC);
    const plan = await poll(r, r.fixtureIds[0]!, [b1, b2], { now: now + 100 * SEC });
    expect(airedBy(plan)).toEqual({ [sponsorMomentId(6, "over_end")]: a });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
  });

  it("untick / pending / inactive: an unticked sponsor's frozen break still airs (card onStream false, never on the carousel); a pending or inactive one airs nothing", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const b = await sponsor(r.orgId, "Bolt");
    const c = await sponsor(r.orgId, "Cove");
    const now = Date.now();
    const breaks = [overEnd(6, now - 300 * SEC), overEnd(12, now - 200 * SEC), overEnd(18, now - SEC)];
    // Three polls, each when its break was fresh: positions 0, 1, 2 → Acme, Bolt, Cove.
    await poll(r, r.fixtureIds[0]!, breaks.slice(0, 1), { now: now - 300 * SEC + SEC });
    await poll(r, r.fixtureIds[0]!, breaks.slice(0, 2), { now: now - 200 * SEC + SEC });
    await poll(r, r.fixtureIds[0]!, breaks, { now });
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.sponsor_id)).toEqual([a, b, c]);

    await sql`update sponsors set on_stream = false where id = ${a}`;
    await sql`update sponsors set status = 'pending' where id = ${b}`;
    let plan = await poll(r, r.fixtureIds[0]!, breaks, { now });
    expect(airedBy(plan)).toEqual({ [sponsorMomentId(6, "over_end")]: a, [sponsorMomentId(18, "over_end")]: c });
    expect(plan!.cards.map((x) => [x.sponsorId, x.onStream])).toEqual([[c, true], [a, false]]);
    await sql`update sponsors set status = 'inactive' where id = ${a}`;
    plan = await poll(r, r.fixtureIds[0]!, breaks, { now });
    expect(airedBy(plan)).toEqual({ [sponsorMomentId(18, "over_end")]: c });
    // Every card's id IS its sponsor's (S8's contract: proof of play resolves the sponsor from the card id).
    for (const card of plan!.cards) expect(card.id).toBe(card.sponsorId);
  });

  it("empty: no settings ⇒ null; rotation off ⇒ null; no card at all ⇒ null; cards and no breaks ⇒ the carousel's cards, no airings", async () => {
    const r = await rig();
    const now = Date.now();
    expect(await poll(r, r.fixtureIds[0]!, [], { now })).toBeNull();
    await settings(r.orgId, null, true, "busy");
    expect(await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now }), "on, but nothing ticked").toBeNull();
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
    const a = await sponsor(r.orgId, "Acme", { logo: "https://cdn.example/acme.png" });
    await sponsor(r.orgId, "Unticked", { onStream: false });
    const plan = await poll(r, r.fixtureIds[0]!, [], { now });
    expect(plan).toEqual({
      cards: [{ id: a, sponsorId: a, name: "Acme", logoUrl: "https://cdn.example/acme.png", tier: "partner", onStream: true, shortCode: expect.stringMatching(SPONSOR_SHORT_CODE_PATTERN) }],
      airings: [],
    });
    await settings(r.orgId, null, false, "busy");
    expect(await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now })).toBeNull();
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
  });

  it("tiers (R13): an org without `sponsors.tiers` gets every card as partner — its leftover title row carries no title weight", async () => {
    const r = await rig({ plan: "community" });
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Was Title", { tier: "title" });
    await sponsor(r.orgId, "Was Gold", { tier: "gold" });
    const plan = await poll(r, r.fixtureIds[0]!, [], { now: Date.now() });
    expect(plan!.cards.map((c) => [c.name, c.tier])).toEqual([["Was Title", "partner"], ["Was Gold", "partner"]]);
    // The positive pair: the same rows on a Pro org keep their tiers, in resolveSponsors' tier order.
    const p = await rig();
    await sponsor(p.orgId, "Gold Co", { tier: "gold" });
    await sponsor(p.orgId, "Title Co", { tier: "title" });
    expect((await sponsorsTableCardSource.cardsFor(p.orgId, { competitionId: p.competitionId })).map((c) => [c.name, c.tier]))
      .toEqual([["Title Co", "title"], ["Gold Co", "gold"]]);
  });

  it("refusal: a card source that hands one sponsor two cards is refused by the planner — no plan, a log line, nothing written", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const card = (id: string): SponsorCard => ({ id, sponsorId: a, name: "Acme", logoUrl: null, tier: "partner", onStream: true });
    const twoCards: SponsorCardSource = { cardsFor: async () => [card(a), card(randomUUID())] };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      const now = Date.now();
      expect(await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now, source: twoCards })).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ fixtureId: r.fixtureIds[0] }), expect.stringContaining("refused"));
    } finally {
      warn.mockRestore();
    }
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("S5: guards", () => {
  it("a write for a fixture that is not the org's is refused by name, and writes nothing", async () => {
    const r = await rig();
    const other = await rig();
    await settings(other.orgId, null, true, "busy");
    await sponsor(other.orgId, "Other Co");
    const now = Date.now();
    await expect(
      loadSponsorPlan({ fixtureId: r.fixtureIds[0]!, orgId: other.orgId, competitionId: r.competitionId, breaks: [overEnd(6, now - SEC)], windowSeqs: [6], complete: true, foldedThrough: ALL_SEQS }, { now }),
    ).rejects.toBeInstanceOf(SponsorAssignmentWriteError);
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
    // The competition must match too: the right org with another competition's id.
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    await expect(
      loadSponsorPlan({ fixtureId: r.fixtureIds[0]!, orgId: r.orgId, competitionId: other.competitionId, breaks: [overEnd(6, now - SEC)], windowSeqs: [6], complete: true, foldedThrough: ALL_SEQS }, { now }),
    ).rejects.toBeInstanceOf(SponsorAssignmentWriteError);
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
    // The positive pair: the fixture's own scope writes.
    expect(await sponsorScopeOf(sql, r.fixtureIds[0]!)).toEqual({ orgId: r.orgId, competitionId: r.competitionId });
    await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
  });

  it("an insert that loses a row under the lock is refused, never dropped silently, and rolls back the rest", async () => {
    const r = await rig();
    const a = await sponsor(r.orgId, "Acme");
    const row = (seq: number, position: number): SponsorAssignment => ({
      momentId: sponsorMomentId(seq, "over_end"), seq, sponsorId: a, sponsorName: "Acme", position, source: "rotation", breakKind: "over_end",
      style: SPONSOR_STYLE_BY_SIZE.minor.style, holdMs: SPONSOR_STYLE_BY_SIZE.minor.holdMs, operatorChoiceAt: null,
    });
    const scope = { fixtureId: r.fixtureIds[0]!, orgId: r.orgId };
    expect(await sql.begin((tx: Tx) => writeAssignments(tx, scope, [row(6, 0)]))).toBe(1);
    await expect(sql.begin((tx: Tx) => writeAssignments(tx, scope, [row(12, 1), row(6, 2)]))).rejects.toBeInstanceOf(SponsorAssignmentWriteError);
    expect((await assignmentsFor(sql, scope.fixtureId, r.orgId)).map((x) => x.seq), "seq 12 rolled back with it").toEqual([6]);
    expect(await sql.begin((tx: Tx) => writeAssignments(tx, scope, []))).toBe(0);
  });

  it("operatorLogFor answers [] and reads nothing (the cross-plan seam, rewritten by console C3)", async () => {
    const r = await rig();
    const before = statementCount();
    expect(await operatorLogFor(sql, r.fixtureIds[0]!)).toEqual([]);
    expect(statementCount() - before).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("S5: stream settings", () => {
  it("the competition's row overrides the org's — enabled included; no competition row ⇒ the org's; neither ⇒ null", async () => {
    const r = await rig();
    expect(await resolveStreamSettings(sql, r.orgId, r.competitionId)).toBeNull();
    expect(await resolveStreamSettings(sql, r.orgId, null)).toBeNull();
    await settings(r.orgId, null, true, "busy");
    expect(await resolveStreamSettings(sql, r.orgId, r.competitionId)).toEqual({ enabled: true, frequency: "busy" });
    await settings(r.orgId, r.competitionId, false, "light");
    expect(await resolveStreamSettings(sql, r.orgId, r.competitionId)).toEqual({ enabled: false, frequency: "light" });
    expect(await resolveStreamSettings(sql, r.orgId, null), "the org question still reads the org row").toEqual({ enabled: true, frequency: "busy" });
    // Another org's rows are never read.
    const other = await rig();
    expect(await resolveStreamSettings(sql, other.orgId, r.competitionId)).toBeNull();
    // A fixture of the switched-off competition gets no plan though the org is on.
    await sponsor(r.orgId, "Acme");
    expect(await poll(r, r.fixtureIds[0]!, [], { now: Date.now() })).toBeNull();
  });

  it("putStreamSettings upserts one row per scope, and refuses another org, another org's competition and an unknown frequency", async () => {
    const r = await rig();
    const other = await rig();
    await putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "normal" });
    await putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "busy" });
    await putStreamSettings(r.auth, r.orgId, { competitionId: r.competitionId, enabled: false, frequency: "light" });
    const rows = await sql<{ competition_id: string | null; enabled: boolean; frequency: string; updated_by: string }[]>`
      select competition_id, enabled, frequency, updated_by from sponsor_stream_settings where org_id = ${r.orgId} order by competition_id nulls first`;
    expect(rows).toEqual([
      { competition_id: null, enabled: true, frequency: "busy", updated_by: r.auth.userId },
      { competition_id: r.competitionId, enabled: false, frequency: "light", updated_by: r.auth.userId },
    ]);
    await expect(putStreamSettings(r.auth, other.orgId, { competitionId: null, enabled: true, frequency: "busy" })).rejects.toMatchObject({ status: 404 });
    await expect(putStreamSettings(r.auth, r.orgId, { competitionId: other.competitionId, enabled: true, frequency: "busy" })).rejects.toMatchObject({ status: 404 });
    await expect(putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "loud" as never })).rejects.toBeInstanceOf(HttpError);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_stream_settings where org_id in ${sql([r.orgId, other.orgId])}`;
    expect(n!.n, "the refusals wrote nothing").toBe(2);
  });
});

describe.skipIf(!HAS_DB)("S5: the short code (R7)", () => {
  it("is minted once per (sponsor, fixture): a second poll serves the same code; another fixture gets its own; a sponsor with no URL gets none", async () => {
    const r = await rig({ fixtures: 2 });
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const n = await sponsor(r.orgId, "No Link", { url: null });
    const now = Date.now();
    const p1 = await poll(r, r.fixtureIds[0]!, [], { now });
    const code = p1!.cards.find((c) => c.sponsorId === a)!.shortCode!;
    expect(code).toMatch(SPONSOR_SHORT_CODE_PATTERN);
    expect(p1!.cards.find((c) => c.sponsorId === n)).not.toHaveProperty("shortCode");
    const p2 = await poll(r, r.fixtureIds[0]!, [], { now });
    expect(p2!.cards.find((c) => c.sponsorId === a)!.shortCode).toBe(code);
    const other = await poll(r, r.fixtureIds[1]!, [], { now });
    expect(other!.cards.find((c) => c.sponsorId === a)!.shortCode).not.toBe(code);
    const rows = await sql<{ code: string; fixture_id: string }[]>`select code, fixture_id from sponsor_short_codes where sponsor_id in ${sql([a, n])}`;
    expect(rows).toHaveLength(2);
  });

  it("a draw that collides with another pair's code is drawn again; every draw colliding is refused by name — and costs the card its link, never the plan", async () => {
    const r = await rig({ fixtures: 2 });
    const a = await sponsor(r.orgId, "Acme");
    const b = await sponsor(r.orgId, "Bolt");
    const taken = await mintShortCode({ orgId: r.orgId, sponsorId: b, fixtureId: r.fixtureIds[1]! });
    expect(taken).toMatch(SPONSOR_SHORT_CODE_PATTERN);
    const draws: number[] = [];
    // A random longest-length code: a fixed literal would collide with itself on a database a previous run left behind.
    const fresh = drawShortCode(SPONSOR_SHORT_CODE_MAX_LENGTH);
    expect(await mintShortCode({ orgId: r.orgId, sponsorId: a, fixtureId: r.fixtureIds[0]! }, (len) => (draws.push(len), draws.length === 1 ? taken! : fresh))).toBe(fresh);
    expect(draws, "the collision was drawn again at the same length").toEqual([SPONSOR_SHORT_CODE_MIN_LENGTH, SPONSOR_SHORT_CODE_MIN_LENGTH]);

    const always: number[] = [];
    await expect(mintShortCode({ orgId: r.orgId, sponsorId: a, fixtureId: r.fixtureIds[1]! }, (len) => (always.push(len), taken!)))
      .rejects.toBeInstanceOf(ShortCodeExhaustedError);
    expect(always.length).toBe((SPONSOR_SHORT_CODE_MAX_LENGTH - SPONSOR_SHORT_CODE_MIN_LENGTH + 1) * SHORT_CODE_DRAWS_PER_LENGTH);
    expect(always.at(-1), "the code grew to the longest length before giving up").toBe(SPONSOR_SHORT_CODE_MAX_LENGTH);

    await settings(r.orgId, null, true, "busy");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      const plan = await poll(r, r.fixtureIds[1]!, [], { now: Date.now(), draw: () => taken! });
      expect(plan!.cards.find((c) => c.sponsorId === a)).not.toHaveProperty("shortCode");
      expect(plan!.cards.find((c) => c.sponsorId === b)!.shortCode, "the minted one is still served").toBe(taken);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a sponsor or a fixture of another org by name, writing nothing", async () => {
    const r = await rig();
    const other = await rig();
    const a = await sponsor(r.orgId, "Acme");
    const foreign = await sponsor(other.orgId, "Foreign");
    await expect(mintShortCode({ orgId: r.orgId, sponsorId: foreign, fixtureId: r.fixtureIds[0]! })).rejects.toBeInstanceOf(ShortCodeOwnershipError);
    await expect(mintShortCode({ orgId: r.orgId, sponsorId: a, fixtureId: other.fixtureIds[0]! })).rejects.toBeInstanceOf(ShortCodeOwnershipError);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_short_codes where sponsor_id in ${sql([a, foreign])}`;
    expect(n!.n).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("S5 fix round 1", () => {
  const air = (r: Rig, fixtureId: string, sponsorId: string, momentId: string) => sql`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at)
    values (${r.orgId}, ${sponsorId}, 'Aired', ${fixtureId}, ${momentId}, 'rotation', 'over_end', 'lower_third', now())`;

  it("I1 a STALE door (folded through 6) never undoes the fresher door's seq-12 assignment, and opens no transaction for it; folded through 12, a complete poll deletes it", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    const now = Date.now();
    await poll(r, r.fixtureIds[0]!, [overEnd(12, now - SEC)], { now, foldedThrough: 12 });
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.seq)).toEqual([12]);

    const lock = await holdTheLock(r.orgId);
    try {
      const stale = await within(poll(r, r.fixtureIds[0]!, [], { now, foldedThrough: 6 }), 5 * SEC);
      expect(stale.done, "an absence past the fold's tip is not proof: no transaction").toBe(true);
    } finally {
      await lock.release();
    }
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.seq), "kept").toEqual([12]);
    await poll(r, r.fixtureIds[0]!, [], { now, foldedThrough: null });
    expect(await rowsOf(r.fixtureIds[0]!), "nothing folded: nothing proven gone").toHaveLength(1);
    // The positive pair: a fold that reached seq 12 and lost the break proves it gone.
    await poll(r, r.fixtureIds[0]!, [], { now, foldedThrough: 12 });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
  });

  it("I1 inside the transaction too: a stale door that assigns its OWN new break keeps the fresher door's seq 12", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    const now = Date.now();
    const major = (seq: number) => brk(seq, "innings_break", cricketSize("innings_break"), now - SEC);
    await poll(r, r.fixtureIds[0]!, [major(12)], { now, foldedThrough: 12 });
    await poll(r, r.fixtureIds[0]!, [major(8)], { now, foldedThrough: 8 });
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.seq)).toEqual([8, 12]);
  });

  it("I2 two ACTIVE rows with one name (a paid renewal inserts a new row): only the later is ticked — its card is served, never hidden behind the first", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme", { onStream: false });
    const renewed = await sponsor(r.orgId, "Acme");
    expect((await sponsorsTableCardSource.cardsFor(r.orgId, { competitionId: r.competitionId })).map((c) => c.id)).toEqual([renewed]);
    const plan = await poll(r, r.fixtureIds[0]!, [], { now: Date.now() });
    expect(plan!.cards.map((c) => c.id)).toEqual([renewed]);
  });

  it("I2 an unticked COMPETITION row named like a ticked ORG row: the org row is served", async () => {
    const r = await rig();
    await sponsor(r.orgId, "Acme", { competitionId: r.competitionId, onStream: false });
    const orgRow = await sponsor(r.orgId, "Acme");
    expect((await sponsorsTableCardSource.cardsFor(r.orgId, { competitionId: r.competitionId })).map((c) => c.id)).toEqual([orgRow]);
    // The board (no on-stream question) still shows the competition's own row, as it always has.
    expect((await resolveSponsors(r.orgId, r.competitionId)).map((s) => s.id)).not.toContain(orgRow);
  });

  it("I2 the stream asks the TABLE only: an org whose sponsors live in the branding blob has none on stream; the board still reads the blob", async () => {
    const r = await rig();
    await sql`update organizations set branding = ${sql.json({ sponsors: [{ name: "Blob Co", url: "https://blob.example" }] })} where id = ${r.orgId}`;
    expect(await resolveSponsors(r.orgId, r.competitionId, { onStream: true })).toEqual([]);
    expect((await resolveSponsors(r.orgId, r.competitionId)).map((s) => [s.id, s.name])).toEqual([[null, "Blob Co"]]);
  });

  it("m2 rotation off: ONE statement and no plan — an undone row survives while it is off; settings handed in by the caller cost none", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    await sponsor(r.orgId, "Acme");
    const now = Date.now();
    await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now });
    await settings(r.orgId, null, false, "busy");
    let before = statementCount();
    expect(await poll(r, r.fixtureIds[0]!, [], { now })).toBeNull();
    expect(statementCount() - before, "the settings read, nothing else").toBe(1);
    expect(await rowsOf(r.fixtureIds[0]!), "the undone row waits for the rotation to come back").toHaveLength(1);
    before = statementCount();
    const off = await loadSponsorPlan(
      { fixtureId: r.fixtureIds[0]!, orgId: r.orgId, competitionId: r.competitionId, breaks: [], windowSeqs: [], complete: true, foldedThrough: ALL_SEQS,
        settings: { enabled: false, frequency: "busy" } },
      { now },
    );
    expect(off).toBeNull();
    expect(statementCount() - before).toBe(0);
  });

  it("m3a a direct mint for a sponsor with NO URL returns null and writes no row", async () => {
    const r = await rig();
    const n = await sponsor(r.orgId, "No Link", { url: null });
    expect(await mintShortCode({ orgId: r.orgId, sponsorId: n, fixtureId: r.fixtureIds[0]! })).toBeNull();
    expect(await codesOf(r.fixtureIds[0]!)).toBe(0);
  });

  it("m3b a code minted while the sponsor had a URL is not served once the URL is cleared (its row stays)", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const first = await poll(r, r.fixtureIds[0]!, [], { now: Date.now() });
    expect(first!.cards[0]!.shortCode).toMatch(SPONSOR_SHORT_CODE_PATTERN);
    await sql`update sponsors set url = null where id = ${a}`;
    const second = await poll(r, r.fixtureIds[0]!, [], { now: Date.now() });
    expect(second!.cards[0]).not.toHaveProperty("shortCode");
    expect(await codesOf(r.fixtureIds[0]!)).toBe(1);
  });

  it("m5 the overlay's context — org, competition and the settings in force — is ONE statement; rotation off costs nothing more", async () => {
    const r = await rig();
    let before = statementCount();
    expect(await sponsorContextOf(sql, r.fixtureIds[0]!)).toEqual({ orgId: r.orgId, competitionId: r.competitionId, settings: null });
    expect(statementCount() - before).toBe(1);
    await settings(r.orgId, null, true, "busy");
    expect((await sponsorContextOf(sql, r.fixtureIds[0]!))?.settings).toEqual({ enabled: true, frequency: "busy" });
    await settings(r.orgId, r.competitionId, false, "light");
    expect((await sponsorContextOf(sql, r.fixtureIds[0]!))?.settings, "the competition's row wins").toEqual({ enabled: false, frequency: "light" });
    expect(await sponsorContextOf(sql, randomUUID())).toBeNull();
    const args = { fixtureId: r.fixtureIds[0]!, breaks: [], windowSeqs: [], complete: true, foldedThrough: ALL_SEQS };
    before = statementCount();
    expect(await loadFixtureSponsorPlan(args, { now: Date.now() })).toBeNull();
    expect(statementCount() - before, "rotation off: the one context statement").toBe(1);
    // On: the same plan the org-scoped loader serves.
    await settings(r.orgId, r.competitionId, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const plan = await loadFixtureSponsorPlan(args, { now: Date.now() });
    expect(plan!.cards.map((c) => c.id)).toEqual([a]);
    expect(await poll(r, r.fixtureIds[0]!, [], { now: Date.now() })).toEqual(plan);
  });

  it("m7 the stored rows carry `aired`; an AIRED undone row costs no transaction and stays, an unaired one waits for the lock and goes", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const now = Date.now();
    await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC)], { now });
    await air(r, r.fixtureIds[0]!, a, sponsorMomentId(6, "over_end"));
    expect((await assignmentsFor(sql, r.fixtureIds[0]!, r.orgId)).map((x) => [x.seq, x.aired])).toEqual([[6, true]]);

    const lock = await holdTheLock(r.orgId);
    try {
      const again = await within(poll(r, r.fixtureIds[0]!, [], { now }), 5 * SEC);
      expect(again.done, "an aired undone row is never deleted, so it opens nothing").toBe(true);
    } finally {
      await lock.release();
    }
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);

    // The positive pair: an UNAIRED undone row (seq 12) does queue on the lock, and goes.
    const later = now + 100 * SEC;
    await poll(r, r.fixtureIds[0]!, [overEnd(6, now - SEC), overEnd(12, later - SEC)], { now: later });
    expect((await assignmentsFor(sql, r.fixtureIds[0]!, r.orgId)).map((x) => [x.seq, x.aired])).toEqual([[6, true], [12, false]]);
    const lock2 = await holdTheLock(r.orgId);
    let pending: Promise<unknown> | null = null;
    try {
      pending = poll(r, r.fixtureIds[0]!, [], { now: later });
      expect((await within(pending, 1500)).done).toBe(false);
    } finally {
      await lock2.release();
    }
    await pending;
    expect((await rowsOf(r.fixtureIds[0]!)).map((x) => x.seq)).toEqual([6]);
  });

  it("m6 read-only (the console preview): plans the card a writing poll would hand out, and writes no assignment, no code and no delete", async () => {
    const r = await rig();
    await settings(r.orgId, null, true, "busy");
    const a = await sponsor(r.orgId, "Acme");
    const b = await sponsor(r.orgId, "Bolt");
    const now = Date.now();
    const breaks = [overEnd(6, now - SEC)];
    const ro = await poll(r, r.fixtureIds[0]!, breaks, { now, readOnly: true });
    expect(airedBy(ro)).toEqual({ [sponsorMomentId(6, "over_end")]: a });
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(0);
    expect(await codesOf(r.fixtureIds[0]!)).toBe(0);
    expect(ro!.cards.every((c) => c.shortCode === undefined), "no code minted for a preview").toBe(true);
    // The writing poll hands out the same card, and mints.
    const rw = await poll(r, r.fixtureIds[0]!, breaks, { now });
    expect(airedBy(rw)).toEqual(airedBy(ro));
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
    expect(await codesOf(r.fixtureIds[0]!)).toBe(2);
    // A preview after it serves the frozen card and the minted codes — and deletes nothing it finds undone.
    const ro2 = await poll(r, r.fixtureIds[0]!, [], { now, readOnly: true });
    expect(ro2!.cards.map((c) => c.shortCode).sort()).toEqual(rw!.cards.map((c) => c.shortCode).sort());
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
    // The NEXT break previews from the org's real next position (1 → Bolt), not from 0 (which would name Acme again).
    const later = now + 100 * SEC;
    const next = [...breaks, overEnd(12, later - SEC)];
    const ro3 = await poll(r, r.fixtureIds[0]!, next, { now: later, readOnly: true });
    expect(airedBy(ro3)[sponsorMomentId(12, "over_end")]).toBe(b);
    expect(await rowsOf(r.fixtureIds[0]!)).toHaveLength(1);
    expect(airedBy(await poll(r, r.fixtureIds[0]!, next, { now: later })), "the writing poll agrees").toEqual(airedBy(ro3));
  });
});

describe("S5: the freshness premise the tests above lean on", () => {
  it("a break 200 s old is past the planner's freshness cut and a 1 s old one is not (R2)", () => {
    expect(200 * SEC).toBeGreaterThan(SPONSOR_STALE_MS);
    expect(SEC).toBeLessThan(SPONSOR_STALE_MS);
  });
});
