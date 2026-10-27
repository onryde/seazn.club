// Which matches a ban covers (owner-approved 4A, 2026-10-27) — the `coveredMatches` projection on every `Suspension`,
// the "Misses: Round 4 vs Rovers · Sat 2 Nov" line on the Discipline tab and the "You'll miss" line in the confirmation
// email. DB-backed; skipped without DATABASE_URL.
//
// The rule the projection states (and the expected values below come from IT, never from the projection's output): a
// ban covers the suspended team's next `matchesTotal - matchesServed` matches that will SERVE it — the same predicate the
// serving counter uses (`servingVerdict`): never its own trigger fixture, never a match that kicked off before the ban
// began, never another team's. In kick-off order, undated last, then by round. A team with fewer fixtures left than the
// ban has matches gets placeholders. Served and waived bans cover nothing.
//
// Football only, on purpose: the projection reads fixture statuses, entrants and ledger timestamps — never the sport —
// and `discipline-serving.test.ts` already sweeps the card producers per sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { openBody } from "@/server/email-outbox/seal";
import { stubOutboxEnv } from "./_invite-mail";
import { createManualSuspension, decideSuspension, listSuspensions, type CoveredMatch, type Suspension } from "../discipline";
import { scoreEvent } from "../scoring";
import { claimPerson, seedFootballDivision, type FootballCtx } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

type Ctx = FootballCtx & { entrantC: string };

/** 2030-11-02 is a Saturday. Every kick-off is in the future, so "has it started" is answered by the ledger alone. */
const SAT_2_NOV = "2030-11-02T14:00:00.000Z";
const SAT_9_NOV = "2030-11-09T14:00:00.000Z";
const SAT_16_NOV = "2030-11-16T14:00:00.000Z";
const FRI_1_NOV = "2030-11-01T14:00:00.000Z";

async function seed(): Promise<Ctx> {
  const ctx = await seedFootballDivision();
  const [{ id: entrantC }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${ctx.divisionId}, ${ctx.orgId}, 'team', 'Rovers', 3)
    returning id`;
  await sql`
    insert into discipline_rules (org_id, division_id, enabled, rules)
    values (${ctx.orgId}, ${ctx.divisionId}, true, ${sql.json({ accumulation: [], dismissal: [{ key: "red", color: "red", ban_matches: 1 }] } as never)})`;
  await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
  return { ...ctx, entrantC };
}

/** One league fixture in round `round` (one per round, so `seq_in_round` is 1), dated `at` or undated. */
async function fixture(ctx: Ctx, round: number, home: string | null, away: string | null, at: string | null, status = "scheduled"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, ${round}, 1, ${home}, ${away}, ${status}, ${at})
    returning id`;
  return id;
}

async function seqOf(fx: string): Promise<number> {
  const [{ s }] = await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${fx}`;
  return s;
}
async function write(ctx: Ctx, fx: string, type: string, payload: object): Promise<void> {
  await scoreEvent(ctx.auth, fx, { expected_seq: await seqOf(fx), type, payload } as never);
}
const kickOff = (ctx: Ctx, fx: string) => write(ctx, fx, "core.start", {});
/** The home side scores, so the result is never level and no decider is consulted. */
async function playOut(ctx: Ctx, fx: string): Promise<void> {
  const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${fx}`;
  for (const [type, payload] of [
    ["football.goal", { by: home }],
    ["football.period", { phase: "HT" }],
    ["football.period", { phase: "FT" }],
  ] as const) {
    await write(ctx, fx, type, payload);
  }
  const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${fx}`;
  expect(status, "rig: played out to a decided result").toBe("decided");
}

async function banFor(ctx: Ctx, matchesTotal: number, personId = ctx.personX): Promise<Suspension> {
  return createManualSuspension(ctx.auth, ctx.divisionId, { personId, matchesTotal, reason: "violent conduct" });
}
async function read(ctx: Ctx, id: string): Promise<Suspension> {
  return (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === id)!;
}
const ids = (c: CoveredMatch[]) => c.map((m) => m.fixtureId);
const PLACEHOLDER: CoveredMatch = { fixtureId: null, roundRole: null, opponentName: null, scheduledAt: null };

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("coveredMatches — which matches a ban still covers", () => {
  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("empty case: no fixtures left ⇒ placeholders only; a waived ban covers nothing", async () => {
    const ctx = await seed();
    const ban = await banFor(ctx, 2);
    const active = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    expect(active.status).toBe("active");
    expect(active.coveredMatches, "two matches to miss, none scheduled: two placeholders").toEqual([PLACEHOLDER, PLACEHOLDER]);

    const other = await banFor(ctx, 1);
    await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const waived = await decideSuspension(ctx.auth, other.id, { kind: "waive" });
    expect(waived.status).toBe("waived");
    expect(waived.coveredMatches, "a waived ban covers nothing").toEqual([]);
    expect((await read(ctx, other.id)).coveredMatches, "the list agrees").toEqual([]);
  }, 60_000);

  it("names the team's next matches by KICK-OFF (not round number), undated last, never another team's — round, opponent, date", async () => {
    const ctx = await seed();
    await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, null, "decided"); // played before the ban; nothing recorded ⇒ never served
    await fixture(ctx, 2, ctx.entrantB, ctx.entrantC, FRI_1_NOV); // not A's — the earliest date in the division
    const r3 = await fixture(ctx, 3, ctx.entrantA, ctx.entrantC, null); // A's, undated
    const r4 = await fixture(ctx, 4, ctx.entrantB, ctx.entrantA, SAT_16_NOV); // A away
    const r5 = await fixture(ctx, 5, ctx.entrantA, ctx.entrantB, SAT_2_NOV); // A's earliest kick-off, latest round
    const ban = await banFor(ctx, 3);
    const confirmed = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    // League rounds are plain rounds named by their place in the stage (rounds 1-5 all exist): `plain_round_N`.
    expect(confirmed.coveredMatches).toEqual([
      { fixtureId: r5, roundRole: "plain_round_5", opponentName: "B", scheduledAt: SAT_2_NOV },
      { fixtureId: r4, roundRole: "plain_round_4", opponentName: "B", scheduledAt: SAT_16_NOV },
      { fixtureId: r3, roundRole: "plain_round_3", opponentName: "Rovers", scheduledAt: null },
    ]);
    // A second read (the list, which folds serving first) states the same thing.
    expect((await read(ctx, ban.id)).coveredMatches).toEqual(confirmed.coveredMatches);
  }, 60_000);

  it("a ban's own trigger fixture is never covered — though it has not kicked off (positive pair: the same match is covered by a ban it did not trigger)", async () => {
    const ctx = await seed();
    const g = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const h = await fixture(ctx, 2, ctx.entrantA, ctx.entrantC, SAT_9_NOV);
    // A report-raised ban names its fixture; written raw, as a report writes it (no producer raises one on an
    // unstarted fixture — the rule is a guard, and this is the test that reaches it).
    const [{ id: triggered }] = await sql<{ id: string }[]>`
      insert into suspensions (org_id, division_id, person_id, status, source, rule_key, bucket, reason, matches_total, fixture_id)
      values (${ctx.orgId}, ${ctx.divisionId}, ${ctx.personX}, 'pending', 'report', ${"report:" + randomUUID()}, 0, 'violent conduct', 1, ${g})
      returning id`;
    expect(ids((await read(ctx, triggered)).coveredMatches), "pending: G is its own trigger, so H").toEqual([h]);
    expect(ids((await decideSuspension(ctx.auth, triggered, { kind: "confirm" })).coveredMatches), "active: still H").toEqual([h]);

    const manual = await banFor(ctx, 1, ctx.personY); // Y plays for B, whose next match is G too
    expect(ids((await read(ctx, manual.id)).coveredMatches), "no trigger: G is the next match").toEqual([g]);
  }, 60_000);

  it("a match kicked off before the ban is not covered; one kicked off AFTER and still live is, ahead of every dated one; served ⇒ nothing", async () => {
    const ctx = await seed();
    const g = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const h = await fixture(ctx, 2, ctx.entrantA, ctx.entrantC, SAT_16_NOV);
    const i = await fixture(ctx, 3, ctx.entrantA, ctx.entrantB, SAT_9_NOV);
    await kickOff(ctx, g);
    const ban = await banFor(ctx, 1);
    expect(ids((await read(ctx, ban.id)).coveredMatches), "pending, projected from now: G is under way already").toEqual([i]);
    const confirmed = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    expect(ids(confirmed.coveredMatches), "G kicked off before the confirm: the earliest dated match after it, I").toEqual([i]);

    await kickOff(ctx, h); // H, the LATEST dated, kicks off first — it is the match the ban is being served in now
    expect(ids((await read(ctx, ban.id)).coveredMatches), "the match under way since the confirm").toEqual([h]);
    await playOut(ctx, h);
    const done = await read(ctx, ban.id);
    expect([done.matchesServed, done.status], "rig: H served it").toEqual([1, "served"]);
    expect(done.coveredMatches, "served: nothing left to miss").toEqual([]);
  }, 60_000);

  it("an abandoned next match is not missed — the ban covers the one after", async () => {
    const ctx = await seed();
    const g = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const h = await fixture(ctx, 2, ctx.entrantA, ctx.entrantC, SAT_9_NOV);
    const ban = await banFor(ctx, 1);
    expect(ids((await decideSuspension(ctx.auth, ban.id, { kind: "confirm" })).coveredMatches)).toEqual([g]);
    // Called off before a ball was kicked: the status is what the projection reads, so it is written as the row stores it.
    await sql`update fixtures set status = 'abandoned' where id = ${g}`;
    const after = await read(ctx, ban.id);
    expect([after.matchesServed, after.status], "an abandoned match serves nothing").toEqual([0, "active"]);
    expect(ids(after.coveredMatches), "so the ban moves on to H").toEqual([h]);
  }, 60_000);

  it("an undecided opponent is null (TBD), an undated match has no date, and a short fixture list pads with placeholders", async () => {
    const ctx = await seed();
    const g = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const tbd = await fixture(ctx, 2, null, ctx.entrantA, null);
    const ban = await banFor(ctx, 3);
    const confirmed = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    expect(confirmed.coveredMatches).toEqual([
      { fixtureId: g, roundRole: "plain_round_1", opponentName: "B", scheduledAt: SAT_2_NOV },
      { fixtureId: tbd, roundRole: "plain_round_2", opponentName: null, scheduledAt: null },
      PLACEHOLDER,
    ]);
  }, 60_000);

  it("a PENDING ban says what it would miss, through the entrant a confirm would stamp; a player on no entrant here would miss nothing", async () => {
    const ctx = await seed();
    const g = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const pending = await banFor(ctx, 1);
    const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`select entrant_id from suspensions where id = ${pending.id}`;
    expect(entrant_id, "rig: the pending row carries no entrant — the projection must resolve it").toBeNull();
    expect(pending.status).toBe("pending");
    expect(ids(pending.coveredMatches), "X plays for A: A's next match").toEqual([g]);

    const [{ id: personZ }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${ctx.orgId}, 'Zara Unrostered') returning id`;
    const orphan = await banFor(ctx, 1, personZ);
    expect(orphan.coveredMatches, "no entrant here: nothing to miss (a confirm would refuse it)").toEqual([]);
    // Positive pair: rostered onto C, the same ban would miss C's next match.
    const c = await fixture(ctx, 2, ctx.entrantC, ctx.entrantB, SAT_9_NOV);
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${ctx.entrantC}, ${personZ}, ${ctx.orgId})`;
    expect(ids((await read(ctx, orphan.id)).coveredMatches)).toEqual([c]);
  }, 60_000);

  // A person on two entrants of one division (nothing in the schema forbids it): the confirm, the serving pass and the
  // projection all resolve through ONE resolver, and it picks the entrant created FIRST (then by id) — a stated order,
  // never whichever row the planner happens to return. D is created a day before A but X joins it AFTER joining A, so
  // a resolver with no order (scan order: A's membership row first) names the wrong team.
  it("a player on two entrants: the pending projection, the confirm's stamp and the active projection all name the earliest-created one", async () => {
    const ctx = await seed();
    const [{ id: entrantD }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed, created_at)
      values (${ctx.divisionId}, ${ctx.orgId}, 'team', 'Dynamo', 4, now() - interval '1 day')
      returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantD}, ${ctx.personX}, ${ctx.orgId})`;
    const memberships = await sql<{ entrant_id: string; created_at: Date }[]>`
      select em.entrant_id, e.created_at from entrant_members em join entrants e on e.id = em.entrant_id
      where em.person_id = ${ctx.personX} and e.division_id = ${ctx.divisionId}`;
    expect(memberships.map((m) => m.entrant_id).sort(), "rig: X is on A and D").toEqual([ctx.entrantA, entrantD].sort());
    const earliest = [...memberships].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0]!.entrant_id;
    expect(earliest, "rig: D was created first").toBe(entrantD);

    const gA = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const gD = await fixture(ctx, 2, entrantD, ctx.entrantC, SAT_9_NOV);
    const pending = await banFor(ctx, 1);
    expect(ids(pending.coveredMatches), "pending: D's next match").toEqual([gD]);
    const active = await decideSuspension(ctx.auth, pending.id, { kind: "confirm" });
    expect([active.entrantId, ids(active.coveredMatches)], "confirmed: stamped D, still D's match").toEqual([entrantD, [gD]]);
    expect(ids(active.coveredMatches)).not.toContain(gA);
  }, 60_000);

  it("SEQUENCE: a two-match ban — the line moves on as each match is served, agreeing with matchesServed at every step, and is empty when done", async () => {
    const ctx = await seed();
    const r1 = await fixture(ctx, 1, ctx.entrantA, ctx.entrantB, SAT_2_NOV);
    const r2 = await fixture(ctx, 2, ctx.entrantC, ctx.entrantA, SAT_9_NOV);
    const r3 = await fixture(ctx, 3, ctx.entrantA, ctx.entrantB, SAT_16_NOV);
    const ban = await banFor(ctx, 2);
    const steps: [number, string, (string | null)[]][] = [];
    const step = (s: Suspension) => {
      // The invariant at EVERY step: one named match per match still to serve (enough fixtures exist throughout).
      if (s.status === "active") expect(s.coveredMatches.length, `${s.matchesServed} served`).toBe(s.matchesTotal - s.matchesServed);
      steps.push([s.matchesServed, s.status, ids(s.coveredMatches)]);
    };
    step(await decideSuspension(ctx.auth, ban.id, { kind: "confirm" }));
    step(await read(ctx, ban.id)); // a second read changes nothing
    await kickOff(ctx, r1);
    await playOut(ctx, r1);
    step(await read(ctx, ban.id));
    await kickOff(ctx, r2);
    await playOut(ctx, r2);
    step(await read(ctx, ban.id));
    expect(steps).toEqual([
      [0, "active", [r1, r2]],
      [0, "active", [r1, r2]],
      [1, "active", [r2]],
      [2, "served", []],
    ]);
    expect(steps.flatMap((s) => s[2]), "R3 is after the ban: never named").not.toContain(r3);
  }, 90_000);

  it("the confirmation email names the matches the player will miss, in the venue's zone — through the outbox", async () => {
    const ctx = await seed();
    await sql`update organizations set timezone = 'Europe/Paris' where id = ${ctx.orgId}`;
    await claimPerson(ctx.personX, `covered-${randomUUID().slice(0, 8)}@test.local`);
    await fixture(ctx, 1, ctx.entrantA, ctx.entrantC, SAT_2_NOV);
    const ban = await banFor(ctx, 2);
    await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    const rows = await sql<{ body_sealed: Uint8Array | null }[]>`
      select body_sealed from email_outbox where kind = 'suspension_confirmed' and ref_type = 'suspension' and ref_id = ${ban.id}`;
    expect(rows, "one confirmation queued").toHaveLength(1);
    const body = openBody(rows[0]!.body_sealed!);
    // 14:00Z on Saturday 2 Nov 2030 is 15:00 in Paris (CET); the second match has no fixture yet.
    expect(body.text).toContain("You'll miss: Round 1 vs Rovers · Sat 2 Nov, 15:00 (Europe/Paris), Next match (not scheduled yet)");
    expect(body.html).toContain("Round 1 vs Rovers · Sat 2 Nov, 15:00 (Europe/Paris)");
  }, 60_000);
});
