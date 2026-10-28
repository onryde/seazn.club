// Discipline serving and confirming — two regressions, both found by driving the real doors (owner-approved fix wave,
// 2026-10-27). DB-backed; skipped without DATABASE_URL. Every score event goes through the console's own door
// (`scoreEvent`), every ban through the real reads and decision (`listSuspensions` / `decideSuspension`); the serving
// counter is read both straight off the row (the write path's fold) and through the list (the read path's).
//
// 1. A ban was "served" by the very match it was given in. `updateServing` counted any decided/finalized fixture of
//    the suspended entrant whose LATEST event postdated the confirm, so a red confirmed mid-match was served by that
//    match being played out, and a red confirmed after full time was served by a `core.finalize` on it. The rule now:
//    a fixture serves a ban only if it STARTED (its earliest recorded event) after the ban was confirmed, and a ban's
//    own trigger fixture never serves it.
// 2. A ban confirmed for a person on no entrant of the division went `active` with a null entrant, which the serving
//    counter skips for ever — a permanent ban that kept blocking lineups. Confirm now refuses it, 422
//    SUSPENSION_NO_ENTRANT, writing nothing; the organiser rosters the player (or waives the ban) instead.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SUSPENSION_NO_ENTRANT_CODE } from "@/lib/suspension-no-entrant";
import { stubOutboxEnv } from "./_invite-mail";
import { createManualSuspension, decideSuspension, listSuspensions } from "../discipline";
import { scoreEvent } from "../scoring";
import { putLineup } from "../fixtures";
import { claimPerson, makeFixture, seedFootballDivision, type FootballCtx as Ctx } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** One dismissal colour, one match. The rules are the test's INPUT; the expected counts below come from the rule
 *  being fixed (a ban of 1 is served by exactly one match that started after it), never from the counter. */
const dismissalOnly = (color: string) => ({ accumulation: [], dismissal: [{ key: color, color, ban_matches: 1 }] });

async function setRules(ctx: Ctx, rules: unknown): Promise<void> {
  await sql`
    insert into discipline_rules (org_id, division_id, enabled, rules)
    values (${ctx.orgId}, ${ctx.divisionId}, true, ${sql.json(rules as never)})
    on conflict (division_id) do update set enabled = excluded.enabled, rules = excluded.rules`;
}

async function seqOf(fx: string): Promise<number> {
  const [{ s }] = await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${fx}`;
  return s;
}
async function write(ctx: Ctx, fx: string, type: string, payload: object): Promise<unknown> {
  return scoreEvent(ctx.auth, fx, { expected_seq: await seqOf(fx), type, payload } as never);
}
async function statusOf(fx: string): Promise<string> {
  const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${fx}`;
  return status;
}
/** The ban as the WRITE path left it — the row itself, before any read re-folds it. */
async function stored(id: string): Promise<[number, string]> {
  const [r] = await sql<{ matches_served: number; status: string }[]>`select matches_served, status from suspensions where id = ${id}`;
  return [r!.matches_served, r!.status];
}
/** The ban as the READ path folds it (`listSuspensions` serves on read). */
async function listed(ctx: Ctx, id: string): Promise<[number, string]> {
  const row = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === id)!;
  return [row.matchesServed, row.status];
}
async function lineups(ctx: Ctx, fx: string): Promise<void> {
  for (const [e, p] of [[ctx.entrantA, ctx.personX], [ctx.entrantB, ctx.personY]] as const) {
    await putLineup(ctx.auth, fx, e, { slots: [{ person_id: p, slot: "starting", position_key: null, order_no: 1, roles: [] }] } as never);
  }
}

/** How each sport's match is kicked off, carded and played to a decided full time — B scores, so the result is never
 *  level and no decider is consulted. Football's whistle is `football.period`; the period family's is
 *  `<sport>.period.advance` through its regulation phases (the kernel refuses an out-of-order phase, so a wrong row here
 *  fails loudly rather than vacuously). */
interface SportScript {
  variant: string;
  /** The dismissal colour this test bans on — checked against the module's OWN declared discipline colours. */
  card: string;
  cardEvent: (ctx: Ctx) => [string, object];
  fullTime: (ctx: Ctx) => [string, object][];
}
const SCRIPTS: Record<string, SportScript> = {
  football: {
    variant: "11-a-side",
    card: "red",
    cardEvent: (ctx) => ["football.card", { by: ctx.entrantA, person: ctx.personX, color: "red" }],
    fullTime: (ctx) => [["football.goal", { by: ctx.entrantB }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]],
  },
  hockey: {
    variant: "fih-outdoor",
    card: "red",
    cardEvent: (ctx) => ["hockey.suspension.start", { by: ctx.entrantA, person: ctx.personX, class: "red" }],
    fullTime: (ctx) => [["hockey.goal", { by: ctx.entrantB, kind: "fg" }], ...["Q2", "Q3", "Q4", "FT"].map((to): [string, object] => ["hockey.period.advance", { to }])],
  },
  icehockey: {
    variant: "iihf",
    card: "game_misconduct",
    cardEvent: (ctx) => ["icehockey.suspension.start", { by: ctx.entrantA, person: ctx.personX, class: "game_misconduct" }],
    fullTime: (ctx) => [["icehockey.goal", { by: ctx.entrantB }], ...["P2", "P3", "FT"].map((to): [string, object] => ["icehockey.period.advance", { to }])],
  },
};
/** Every sport the engine declares a discipline model for — the sweep's universe, read off the registry. */
const DISCIPLINE_SPORTS = builtinModules.filter((m) => m.discipline !== undefined);
/** Discipline sports the sweep does not DRIVE, and why: the counter under test reads fixture statuses and ledger
 *  timestamps, never the sport, so a rally- or board-by-board script to reach a decided result in each of these would
 *  walk the same code path again. The period family is driven because its card projection is a different producer
 *  (`<sport>.suspension.start`) from football's. Named, so a new discipline sport reds the universe check below. */
const NOT_DRIVEN = ["badminton", "carrom", "tabletennis", "tennis", "volleyball"];

async function kickOff(ctx: Ctx, fx: string): Promise<void> {
  await write(ctx, fx, "core.start", {});
}
async function playOut(ctx: Ctx, sport: string, fx: string): Promise<void> {
  for (const [type, payload] of SCRIPTS[sport]!.fullTime(ctx)) await write(ctx, fx, type, payload);
}

/** A division of `sport` in a fresh Pro org: entrants A (X) and B (Y), discipline on, scoring open. Football is the
 *  shared seed; another sport is a second division in the same org, its own entrants rostering the same two people. */
async function seed(sport: string): Promise<Ctx> {
  const base = await seedFootballDivision();
  let ctx = base;
  if (sport !== "football") {
    const m = builtinModules.find((x) => x.key === sport)!;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${sport}, ${sport}, ${m.version}, ${sql.json(m.positions as never)})
      on conflict (key) do nothing`;
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${base.divisionId}`;
    const cfg = m.configSchema.parse(m.variants[SCRIPTS[sport]!.variant] ?? {});
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      values (${competition_id}, ${base.orgId}, ${sport}, ${sport + "-" + randomUUID().slice(0, 6)}, ${sport}, ${SCRIPTS[sport]!.variant},
              ${sql.json(cfg as never)}, ${m.version})
      returning id`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name) values (${divisionId}, ${base.orgId}, 1, 'league', 'League') returning id`;
    const team = async (name: string, seedNo: number, person: string) => {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${base.orgId}, 'team', ${name}, ${seedNo})
        returning id`;
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${id}, ${person}, ${base.orgId})`;
      return id;
    };
    ctx = { ...base, divisionId, stageId, entrantA: await team("A", 1, base.personX), entrantB: await team("B", 2, base.personY) };
  }
  await setRules(ctx, dismissalOnly(SCRIPTS[sport]!.card));
  await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
  return ctx;
}

/** F (A v B) kicked off and X sent off in it: the one pending dismissal ban, whose trigger fixture is F. */
async function sentOff(ctx: Ctx, sport: string, round = 1): Promise<{ fx: string; banId: string }> {
  const fx = await makeFixture(ctx, round, ctx.entrantA, ctx.entrantB);
  await lineups(ctx, fx);
  await kickOff(ctx, fx);
  const [type, payload] = SCRIPTS[sport]!.cardEvent(ctx);
  await write(ctx, fx, type, payload);
  const pending = (await listSuspensions(ctx.auth, ctx.divisionId)).filter((r) => r.source === "auto_dismissal");
  expect(pending.map((r) => [r.status, r.personId, r.matchesTotal]), `rig (${sport}): one pending dismissal for X`).toEqual([["pending", ctx.personX, 1]]);
  const [{ fixture_id }] = await sql<{ fixture_id: string }[]>`select fixture_id from suspensions where id = ${pending[0]!.id}`;
  expect(fixture_id, `rig (${sport}): the ban names F as its trigger fixture`).toBe(fx);
  return { fx, banId: pending[0]!.id };
}

/** The team's NEXT match, kicked off after the confirm and played to full time: the positive pair. */
async function nextMatch(ctx: Ctx, sport: string, round: number): Promise<string> {
  const fx = await makeFixture(ctx, round, ctx.entrantA, ctx.entrantB);
  await kickOff(ctx, fx);
  await playOut(ctx, sport, fx);
  expect(await statusOf(fx), `rig (${sport}): the next match is decided`).toBe("decided");
  return fx;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("serving: only a match that STARTED after the confirm serves a ban, never its own trigger fixture", () => {
  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a red in F, F played to full time, the ban confirmed, then F finalized: 0 served; the team's next match serves it (1/1)", async () => {
    const ctx = await seed("football");
    const { fx, banId } = await sentOff(ctx, "football");
    await playOut(ctx, "football", fx);
    expect(await statusOf(fx), "rig: F is decided before the confirm").toBe("decided");

    const confirmed = await decideSuspension(ctx.auth, banId, { kind: "confirm" });
    expect([confirmed.matchesServed, confirmed.status], "right after confirm").toEqual([0, "active"]);

    // A post-decision event on the trigger fixture: its LATEST event now postdates the confirm.
    await write(ctx, fx, "core.finalize", {});
    expect(await statusOf(fx), "rig: F is finalized after the confirm").toBe("finalized");
    expect(await stored(banId), "the finalize's own fold: F does not serve its own ban").toEqual([0, "active"]);
    expect(await listed(ctx, banId), "the read path agrees").toEqual([0, "active"]);

    await nextMatch(ctx, "football", 2);
    expect(await stored(banId), "positive pair: the next match, kicked off after the confirm, serves it").toEqual([1, "served"]);
    expect(await listed(ctx, banId)).toEqual([1, "served"]);
  }, 60_000);

  it("a red in F confirmed MID-MATCH: F played out serves nothing; the team's next match serves it (1/1)", async () => {
    const ctx = await seed("football");
    const { fx, banId } = await sentOff(ctx, "football");
    expect(await statusOf(fx), "rig: F is still live at the confirm").not.toBe("decided");

    const confirmed = await decideSuspension(ctx.auth, banId, { kind: "confirm" });
    expect([confirmed.matchesServed, confirmed.status], "right after confirm").toEqual([0, "active"]);
    await playOut(ctx, "football", fx);
    expect(await statusOf(fx), "rig: F is decided after the confirm").toBe("decided");
    expect(await stored(banId), "F's deciding write: the match the red was given in does not serve it").toEqual([0, "active"]);
    expect(await listed(ctx, banId)).toEqual([0, "active"]);

    await nextMatch(ctx, "football", 2);
    expect(await stored(banId), "positive pair: the next match serves it").toEqual([1, "served"]);
    expect(await listed(ctx, banId)).toEqual([1, "served"]);
  }, 60_000);

  // Isolates the START rule from the trigger-fixture rule: a manual ban names no fixture, so only "did G start after
  // the confirm?" can keep G from serving it.
  it("a match already kicked off when a ban was confirmed does not serve it, though it is decided after — the next one, kicked off after, does", async () => {
    const ctx = await seed("football");
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "violent conduct" });
    const [{ fixture_id }] = await sql<{ fixture_id: string | null }[]>`select fixture_id from suspensions where id = ${manual.id}`;
    expect(fixture_id, "rig: a manual ban names no trigger fixture").toBeNull();

    const g = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    await kickOff(ctx, g);
    expect((await decideSuspension(ctx.auth, manual.id, { kind: "confirm" })).status).toBe("active");
    await playOut(ctx, "football", g);
    expect(await statusOf(g), "rig: G, under way at the confirm, is decided after it").toBe("decided");
    expect(await stored(manual.id), "G started before the ban existed: it does not serve it").toEqual([0, "active"]);
    expect(await listed(ctx, manual.id)).toEqual([0, "active"]);

    await nextMatch(ctx, "football", 2);
    expect(await stored(manual.id), "positive pair: H, kicked off after the confirm, serves it").toEqual([1, "served"]);
  }, 60_000);

  it("empty case: a decided fixture with nothing recorded has never started, so it serves nothing — a played one does", async () => {
    const ctx = await seed("football");
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "violent conduct" });
    expect((await decideSuspension(ctx.auth, manual.id, { kind: "confirm" })).status).toBe("active");
    const bare = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB, "decided");
    expect(await seqOf(bare), "rig: no ledger at all").toBe(0);
    expect(await listed(ctx, manual.id), "an unplayed 'decided' row is not a match served").toEqual([0, "active"]);

    await nextMatch(ctx, "football", 2);
    expect(await stored(manual.id), "positive pair: a match kicked off and decided after the confirm serves it").toEqual([1, "served"]);
  }, 60_000);

  // Isolates the trigger-fixture rule from the START rule. No producer raises a ban whose trigger fixture has nothing
  // recorded before the confirm (a card or a report always precedes it), so the row is written raw, as a report would
  // write it; the rule is a guard, and this is the test that reaches it.
  it("a ban is never served by its own trigger fixture — even one with nothing recorded before the confirm (raw row, defence in depth)", async () => {
    const ctx = await seed("football");
    const g = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into suspensions (org_id, division_id, person_id, status, source, rule_key, bucket, reason, matches_total, fixture_id)
      values (${ctx.orgId}, ${ctx.divisionId}, ${ctx.personX}, 'pending', 'report', ${"report:" + randomUUID()}, 0, 'violent conduct', 1, ${g})
      returning id`;
    expect(await seqOf(g), "rig: nothing recorded on G before the confirm").toBe(0);
    expect((await decideSuspension(ctx.auth, id, { kind: "confirm" })).status).toBe("active");

    await kickOff(ctx, g);
    await playOut(ctx, "football", g);
    expect(await statusOf(g), "rig: G started and was decided after the confirm").toBe("decided");
    expect(await stored(id), "G is the ban's own fixture: it does not serve it").toEqual([0, "active"]);
    expect(await listed(ctx, id)).toEqual([0, "active"]);

    await nextMatch(ctx, "football", 2);
    expect(await stored(id), "positive pair: another match, kicked off after the confirm, serves it").toEqual([1, "served"]);
  }, 60_000);

  it("the period family (hockey, ice hockey): a dismissal confirmed mid-match is not served by that match; the next match serves it (counted)", async () => {
    // The universe is the registry's; a new discipline sport that is neither scripted nor named in NOT_DRIVEN reds here.
    expect(DISCIPLINE_SPORTS.map((m) => m.key).sort(), "every discipline sport is driven or named as not driven").toEqual(
      [...Object.keys(SCRIPTS), ...NOT_DRIVEN].sort(),
    );
    const others = DISCIPLINE_SPORTS.filter((m) => m.key !== "football" && m.key in SCRIPTS);
    const seen: Record<string, [number, string][]> = {};
    for (const m of others) {
      expect(m.discipline!.colors.map((c) => c.key), `${m.key} declares the dismissal colour this test bans on`).toContain(SCRIPTS[m.key]!.card);
      const ctx = await seed(m.key);
      const { fx, banId } = await sentOff(ctx, m.key);
      await decideSuspension(ctx.auth, banId, { kind: "confirm" });
      await playOut(ctx, m.key, fx);
      expect(await statusOf(fx), `rig (${m.key}): F is decided after the confirm`).toBe("decided");
      const afterTrigger = await stored(banId);
      await nextMatch(ctx, m.key, 2);
      seen[m.key] = [afterTrigger, await stored(banId)];
    }
    expect(Object.keys(seen).sort(), "sports checked: the period family, both of it").toEqual(["hockey", "icehockey"]);
    expect(seen, JSON.stringify(seen)).toEqual(Object.fromEntries(others.map((m) => [m.key, [[0, "active"], [1, "served"]]])));
  }, 120_000);
});

// 3. A start is an ACTIVE event. The rule read a fixture's start as its earliest recorded event, voided ones included —
//    and a lone `core.start` (or a lone `core.forfeit`) is voidable, which puts the fixture back to `scheduled`. So a
//    kick-off undone BEFORE the confirm made the match, really played after it, read as "under way when the ban began":
//    it never served, and the "Misses:" line skipped it. The voided event and its `core.void` are not a start.
describe.skipIf(!HAS_DB)("serving: a kick-off or forfeit VOIDED before the confirm is not a start", () => {
  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("SEQUENCE start → void → confirm → start → full time: the confirm names G as the match to miss, and G played serves the ban (1/1); a voided forfeit likewise", async () => {
    const PRODUCERS: [string, (ctx: Ctx) => object][] = [
      ["core.start", () => ({})],
      ["core.forfeit", (ctx) => ({ by: ctx.entrantA, reason: "walkover" })],
    ];
    // Every producer read before any is judged, so one red names every one that moved.
    const seen: Record<string, { covered: (string | null)[]; stored: [number, string]; listed: [number, string] }> = {};
    const want: typeof seen = {};
    for (const [type, payload] of PRODUCERS) {
      const ctx = await seed("football");
      const manual = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "violent conduct" });
      const g = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
      const done = (await write(ctx, g, type, payload(ctx))) as { event_id: string };
      await write(ctx, g, "core.void", { event_id: done.event_id });
      expect(await statusOf(g), `rig (${type}): voided, G is unplayed again`).toBe("scheduled");
      expect(await seqOf(g), `rig (${type}): the ledger keeps both rows`).toBe(2);

      const confirmed = await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
      expect(confirmed.status).toBe("active");
      await kickOff(ctx, g);
      await playOut(ctx, "football", g);
      expect(await statusOf(g), `rig (${type}): G kicked off after the confirm and decided`).toBe("decided");
      seen[type] = { covered: confirmed.coveredMatches.map((m) => m.fixtureId), stored: await stored(manual.id), listed: await listed(ctx, manual.id) };
      want[type] = { covered: [g], stored: [1, "served"], listed: [1, "served"] };
    }
    expect(Object.keys(seen).length, "producers checked").toBe(PRODUCERS.length);
    expect(seen, JSON.stringify(seen)).toEqual(want);
  }, 120_000);
});

// 4. A legacy ACTIVE ban with no entrant — confirmed before the refusal below existed. The counter skipped it for ever,
//    while the "Misses:" projection resolved an entrant for it and named matches that would never end it. The serving
//    pass now resolves the entrant the way a confirm does, stamps it, and serves the ban from its `decided_at`; the
//    projection reads the stamped entrant, so the two cannot name different teams.
describe.skipIf(!HAS_DB)("serving: a legacy ACTIVE ban with no entrant is stamped by the serving pass, then served", () => {
  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** The legacy shape, written raw: active, decided, no entrant. Z is on no entrant of the division yet. */
  async function legacyBan(ctx: Ctx): Promise<{ personZ: string; banId: string }> {
    const [{ id: personZ }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${ctx.orgId}, 'Zara Legacy') returning id`;
    const [{ id: banId }] = await sql<{ id: string }[]>`
      insert into suspensions (org_id, division_id, person_id, status, source, reason, matches_total, decided_at)
      values (${ctx.orgId}, ${ctx.divisionId}, ${personZ}, 'active', 'manual', 'violent conduct', 1, now())
      returning id`;
    return { personZ, banId };
  }
  const entrantOf = async (id: string) => (await sql<{ entrant_id: string | null }[]>`select entrant_id from suspensions where id = ${id}`)[0]!.entrant_id;
  const row = async (ctx: Ctx, id: string) => (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === id)!;

  it("unrostered: stays active, nothing stamped, covers nothing; rostered: the read's serving pass stamps A, names A's next match, and that match played serves it", async () => {
    const ctx = await seed("football");
    const { personZ, banId } = await legacyBan(ctx);
    const g = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);

    // Empty case first: Z is on no entrant here, so there is no team to serve through.
    const orphan = await row(ctx, banId);
    expect([orphan.status, orphan.entrantId, orphan.matchesServed, orphan.coveredMatches], "unrostered: untouched, covers nothing").toEqual(["active", null, 0, []]);
    expect(await entrantOf(banId), "nothing stamped").toBeNull();

    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${ctx.entrantA}, ${personZ}, ${ctx.orgId})`;
    const stamped = await row(ctx, banId);
    expect([stamped.status, stamped.entrantId, stamped.matchesServed], "rostered: the read's serving pass stamps A").toEqual(["active", ctx.entrantA, 0]);
    expect(await entrantOf(banId), "stored").toBe(ctx.entrantA);
    expect(stamped.coveredMatches.map((m) => m.fixtureId), "the projection names A's next match").toEqual([g]);

    await kickOff(ctx, g);
    await playOut(ctx, "football", g);
    expect(await stored(banId), "G, kicked off after decided_at, serves it").toEqual([1, "served"]);
  }, 60_000);

  it("the write path alone: rostered and never read, the deciding write's fold stamps the entrant and serves the ban", async () => {
    const ctx = await seed("football");
    const { personZ, banId } = await legacyBan(ctx);
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${ctx.entrantA}, ${personZ}, ${ctx.orgId})`;
    expect(await entrantOf(banId), "rig: no read since rostering — still unstamped").toBeNull();
    await nextMatch(ctx, "football", 1);
    expect(await entrantOf(banId), "the decided write's fold stamped A").toBe(ctx.entrantA);
    expect(await stored(banId)).toEqual([1, "served"]);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("confirm refuses a ban that could never be served (no entrant in the division)", () => {
  beforeEach(() => {
    stubOutboxEnv();
    transport.deliver.mockReset();
    transport.deliver.mockImplementation(async () => ({ ok: true, providerId: `re_test_${randomUUID()}` }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** The stored row, every column a confirm writes. */
  const row = async (id: string) =>
    (await sql<{ status: string; entrant_id: string | null; decided_at: Date | null; decided_by: string | null }[]>`
      select status, entrant_id, decided_at, decided_by from suspensions where id = ${id}`)[0];
  const confirmedNotices = async (id: string) =>
    sql`select id from email_outbox where kind = 'suspension_confirmed' and ref_type = 'suspension' and ref_id = ${id}`;

  it("a player on no entrant here is refused 422 SUSPENSION_NO_ENTRANT and nothing is written; rostered, the same confirm goes active with the entrant stamped", async () => {
    const ctx = await seedFootballDivision();
    const [{ id: personZ }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${ctx.orgId}, 'Zara Unrostered') returning id`;
    await claimPerson(personZ, `unrostered-${randomUUID().slice(0, 8)}@test.local`);
    // Z IS on an entrant — in a sibling division of the same competition. The serving entrant is this division's, so
    // that one must not be stamped (it plays none of this division's fixtures).
    const [{ id: sibling }] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      select competition_id, org_id, 'Sibling', ${"sibling-" + randomUUID().slice(0, 6)}, sport_key, variant_key, config, module_version
      from divisions where id = ${ctx.divisionId}
      returning id`;
    const [{ id: elsewhere }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed) values (${sibling}, ${ctx.orgId}, 'team', 'Elsewhere', 1) returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${elsewhere}, ${personZ}, ${ctx.orgId})`;
    const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: personZ, matchesTotal: 1, reason: "violent conduct" });
    expect(ban.status).toBe("pending");

    const refused = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused, "confirm is refused").toBeInstanceOf(HttpError);
    expect({ status: (refused as HttpError).status, code: (refused as HttpError).code }).toEqual({ status: 422, code: "SUSPENSION_NO_ENTRANT" });
    expect(SUSPENSION_NO_ENTRANT_CODE, "the shared constant is the wire code").toBe("SUSPENSION_NO_ENTRANT");
    expect(await row(ban.id), "nothing written: still pending, no entrant, undecided").toEqual({
      status: "pending",
      entrant_id: null,
      decided_at: null,
      decided_by: null,
    });
    expect(await confirmedNotices(ban.id), "no confirmed notice for a ban that did not go live (Z is claimed)").toEqual([]);

    // Second call, after the organiser rosters Z on A: the same confirm now succeeds and stamps A.
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${ctx.entrantA}, ${personZ}, ${ctx.orgId})`;
    const active = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
    expect([active.status, active.entrantId], "rostered: active, serving through A").toEqual(["active", ctx.entrantA]);
    expect((await row(ban.id))!.entrant_id).toBe(ctx.entrantA);
    expect(await confirmedNotices(ban.id), "and its one confirmed notice").toHaveLength(1);
  }, 60_000);

  it("the refusal leaves the organiser's way out: an unservable pending ban can still be waived", async () => {
    const ctx = await seedFootballDivision();
    const [{ id: personZ }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${ctx.orgId}, 'Zara Unrostered') returning id`;
    const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: personZ, matchesTotal: 1, reason: "violent conduct" });
    await expect(decideSuspension(ctx.auth, ban.id, { kind: "confirm" })).rejects.toMatchObject({ status: 422, code: SUSPENSION_NO_ENTRANT_CODE });
    const waived = await decideSuspension(ctx.auth, ban.id, { kind: "waive" });
    expect(waived.status).toBe("waived");
  }, 60_000);
});
