// FMT5 (owner-approved mock, 2026-11-03): the division's format changes freely until the first result exists.
// `replaceStages` used to refuse FORMAT_LOCKED on ANY fixture row, which left "delete every stage, last first" as the
// only way to change a generated-but-unplayed division. Now:
//   - a result anywhere in the division (`fixtureHasResultSql`, the one played set rebuild and history read) is
//     FORMAT_LOCKED;
//   - otherwise the clear (fixtures, their schedule and setup) and the rebuild run in ONE transaction, behind the token
//     of a preview (`previewReplaceStages`, the route's `?dry_run=1`) whose counts are the rows the delete takes.
//
// Expected values are read off the rows (what existed before, what is gone after), never typed: a preview count is
// asserted equal to the number of rows the confirmed change actually deleted. Real Postgres; skipped without one.
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { FORMAT_CHANGE_REFUSALS, type FormatChangePreview } from "@/lib/format-change";
import { appendEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { applySchedule, putScheduleSettings, startDivision } from "../schedule";
import { createStages, divisionFormatLocked, generateStageFixtures, previewReplaceStages, replaceStages } from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { rigTarget } from "@/server/relay/__tests__/_session-rig";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Body = Extract<CreateStages, unknown[]>;
const league = (seq: number, name = `League ${seq}`) => ({ seq, kind: "league" as const, name, config: {}, progression: null });
const knockout = (seq: number, name = "Knockout") => ({ seq, kind: "knockout" as const, name, config: {}, progression: null });

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("fmt5-owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${"Fmt5 " + suffix}, ${"fmt5-" + suffix}, ${owner.id})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: owner.id, role: "owner", keyId: null };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  competitionId: string;
  entrantIds: string[];
}

async function seedDivision(opts: { entrants: number; sport?: string; variant?: string }): Promise<Rig> {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Fmt5 Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: opts.sport ?? "badminton",
    variant_key: opts.variant ?? "bwf",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { auth, divisionId: division.id, competitionId: comp.id, entrantIds: entrants.map((e) => e.id) };
}

/** The division as rows: its stages in board order and its fixtures. */
async function board(divisionId: string) {
  const stages = await sql<{ id: string; name: string; kind: string }[]>`
    select id, name, kind from stages where division_id = ${divisionId} order by seq`;
  const fixtures = await sql<{ id: string; scheduled_at: Date | null; court_id: string | null; status: string }[]>`
    select f.id, f.scheduled_at, f.court_id, f.status from fixtures f join stages s on s.id = f.stage_id
     where s.division_id = ${divisionId} order by f.id`;
  return { stages, fixtures, fixtureIds: fixtures.map((f) => f.id) };
}

/** The setup rows hanging off `fixtureIds`, per table, by id — what the cascade takes. */
const SETUP_TABLES = [
  "lineups",
  "fixture_officials",
  "device_links",
  "fixture_calls",
  "fixture_availability",
  "fixture_play_flags",
  "fixture_stream_settings",
  "fixture_stream_codes",
] as const;
type SetupTable = (typeof SETUP_TABLES)[number];

async function setupRows(fixtureIds: readonly string[]): Promise<Record<SetupTable, number>> {
  const out = {} as Record<SetupTable, number>;
  for (const t of SETUP_TABLES) {
    const [{ n }] = fixtureIds.length === 0
      ? [{ n: 0 }]
      : await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)} where fixture_id in ${sql(fixtureIds)}`;
    out[t] = n;
  }
  return out;
}

/** Two courts, and every placeable fixture (both seats or none decided yet, not a bye) given a time on one of them. */
async function schedule(rig: Rig, stageId: string): Promise<{ courts: string[]; placed: number }> {
  const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
  const c1 = await createCourt(rig.auth, venue.id, { name: "C1", sort: 0, tags: [] });
  const c2 = await createCourt(rig.auth, venue.id, { name: "C2", sort: 1, tags: [] });
  const rows = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stageId} and status = 'scheduled' order by fixture_no`;
  await applySchedule(rig.auth, stageId, {
    source: "manual",
    assignments: rows.map((r, i) => ({
      fixture_id: r.id,
      scheduled_at: new Date(Date.UTC(2030, 5, 1, 9 + Math.floor(i / 2))).toISOString(),
      court_id: i % 2 === 0 ? c1.id : c2.id,
    })),
  });
  return { courts: [c1.id, c2.id], placed: rows.length };
}

/** A code in the stream-code alphabet (`fixture_stream_codes_code_check`: 12 of 0-9 a-z without i, l, o, u). */
const streamCode = (): string =>
  Array.from({ length: 12 }, () => "0123456789abcdefghjkmnpqrstvwxyz"[Math.floor(Math.random() * 32)]).join("");

/** Raises the change's refusal, or returns what it raised: the error as the caller sees it. */
async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string; extra?: Record<string, unknown> }> {
  return p.then(
    () => {
      throw new Error("expected a refusal, the change went through");
    },
    (e: unknown) => e as { status?: number; code?: string; extra?: Record<string, unknown> },
  );
}

describe.skipIf(!HAS_DB)("FMT5 — a generated, unplayed division changes format in one confirmed step", () => {
  it("a 6-entrant knockout (its byes included): the preview names what the change clears, and the confirm clears exactly that", async () => {
    const rig = await seedDivision({ entrants: 6 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [knockout(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const { courts, placed } = await schedule(rig, stage!.id);
    const before = await board(rig.divisionId);
    // The differential the brief's typed status list would get wrong: a fresh knockout of 6 holds its byes as
    // `forfeited` rows, and no result.
    expect(before.fixtures.filter((f) => f.status === "forfeited").length, "premise: the draw holds byes").toBeGreaterThan(0);
    expect(placed, "premise: fixtures are on the schedule").toBeGreaterThan(0);
    expect(await divisionFormatLocked(rig.auth, rig.divisionId), "a bye is not a result").toBe(false);

    const preview = await previewReplaceStages(rig.auth, rig.divisionId, [league(1)]);
    expect(preview.stages).toEqual(before.stages.map((s) => ({ id: s.id, name: s.name })));
    expect(preview.fixtures).toBe(before.fixtures.length);
    expect(preview.slots).toBe(before.fixtures.filter((f) => f.scheduled_at !== null).length);
    expect(preview.courts).toBe(new Set(before.fixtures.map((f) => f.court_id).filter((c) => c !== null)).size);
    expect(preview.courts, "both courts carry a fixture").toBe(courts.length);
    expect(typeof preview.token).toBe("string");
    // The preview wrote nothing: the very same rows stand.
    const unchanged = await board(rig.divisionId);
    expect(unchanged.stages).toEqual(before.stages);
    expect(unchanged.fixtureIds).toEqual(before.fixtureIds);

    const rows = await replaceStages(rig.auth, rig.divisionId, [league(1)], { clear: preview.token! });
    expect(rows.map((r) => r.kind)).toEqual(["league"]);
    const after = await board(rig.divisionId);
    expect(after.stages.map((s) => s.id)).toEqual(rows.map((r) => r.id));
    // What the preview said is what went: every one of the fixtures it counted, and its schedule with it.
    const [{ left }] = await sql<{ left: number }[]>`select count(*)::int as left from fixtures where id in ${sql(before.fixtureIds)}`;
    expect(left, "the counted fixtures are gone").toBe(0);
    expect(before.fixtures.length - left).toBe(preview.fixtures);
    expect(after.fixtures).toEqual([]);

    // The structural ledger names the change, and the division's watermark moves with it.
    const [event] = await sql<{ seq: number; type: string; payload: { fixtures: number; stages: { id: string }[] } }[]>`
      select seq::int, type, payload from division_events where division_id = ${rig.divisionId} order by seq desc limit 1`;
    expect(event!.type).toBe("stages_replaced");
    expect(event!.payload.fixtures).toBe(preview.fixtures);
    expect(event!.payload.stages.map((s) => s.id)).toEqual(before.stages.map((s) => s.id));
    const [{ seq }] = await sql<{ seq: number }[]>`select seq::int from divisions where id = ${rig.divisionId}`;
    expect(seq).toBe(event!.seq);
  });

  it("no token: 409 FORMAT_CHANGE_CONFIRM with the preview; a token from before a schedule edit: FORMAT_CHANGE_STALE with the fresh one; nothing changes", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const before = await board(rig.divisionId);

    const asked = await refusal(replaceStages(rig.auth, rig.divisionId, [knockout(1)]));
    expect(asked).toMatchObject({ status: 409, code: "FORMAT_CHANGE_CONFIRM" });
    const offered = asked.extra?.preview as FormatChangePreview;
    expect(offered.fixtures).toBe(before.fixtures.length);
    expect(offered.slots, "nothing is scheduled yet").toBe(0);
    expect(await board(rig.divisionId)).toEqual(before);

    const old = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(old.token, "the preview and the refusal's preview name the same board").toBe(offered.token);
    await schedule(rig, stage!.id); // the board moves under the open confirm
    const stale = await refusal(replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: old.token! }));
    expect(stale).toMatchObject({ status: 409, code: "FORMAT_CHANGE_STALE" });
    const fresh = stale.extra?.preview as FormatChangePreview;
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.slots).toBe((await board(rig.divisionId)).fixtures.filter((f) => f.scheduled_at !== null).length);
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);

    // The positive pair: the fresh token goes through.
    await replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: fresh.token! });
    expect((await board(rig.divisionId)).stages.map((s) => s.kind)).toEqual(["knockout"]);
  });

  it("one result anywhere locks the format: the preview and the change are FORMAT_LOCKED, the board untouched", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [s1, s2] = await createStages(rig.auth, rig.divisionId, [league(1), league(2, "Second")]);
    await generateStageFixtures(rig.auth, s1!.id);
    const open = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(await divisionFormatLocked(rig.auth, rig.divisionId)).toBe(false);
    const [first] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s1!.id} order by fixture_no limit 1`;
    await appendEvent(rig.auth.orgId, first!.id, 0, { type: "core.start", payload: {} });
    const before = await board(rig.divisionId);

    expect(await divisionFormatLocked(rig.auth, rig.divisionId)).toBe(true);
    const locked = { status: 409, code: "FORMAT_LOCKED" };
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject(locked);
    expect(await refusal(replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: open.token! }))).toMatchObject(locked);
    // Division-wide: the untouched second stage is part of the same locked format.
    expect(s2).toBeDefined();
    expect(await board(rig.divisionId)).toEqual(before);
    expect(FORMAT_CHANGE_REFUSALS.FORMAT_LOCKED.message).toBe("Format is locked once scoring starts.");
  });
});

describe.skipIf(!HAS_DB)("FMT5 — what refuses the clear even with a token, and what goes with it", () => {
  /** A league of 4 with its fixtures, the token of a change to a knockout, and the board before. */
  async function ready() {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const before = await board(rig.divisionId);
    return { rig, stageId: stage!.id, before, fixtureId: before.fixtureIds[0]! };
  }
  const change = async (rig: Rig, body: Body = [knockout(1)]) => {
    const p = await previewReplaceStages(rig.auth, rig.divisionId, body);
    return replaceStages(rig.auth, rig.divisionId, body, { clear: p.token! });
  };

  it("an ACTIVE stream session refuses (FORMAT_STREAM_LIVE, naming the match), at the preview too; an ended one does not, and its record survives unbound", async () => {
    const { rig, before, fixtureId } = await ready();
    const targetId = await rigTarget(rig.auth.orgId);
    const [session] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id,
                                           division_id, entitlement_via_override)
      select f.id, ${rig.auth.orgId}, 'passthrough', 'live', ${targetId}, ${rig.auth.userId}, d.sport_key, d.competition_id,
             f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
      returning id`;
    const [{ fixture_no }] = await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${fixtureId}`;
    const live = { status: 409, code: "FORMAT_STREAM_LIVE", extra: { fixture_id: fixtureId, fixture_no } };
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject(live);
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);

    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id = ${session!.id}`;
    await change(rig);
    const [kept] = await sql<{ fixture_id: string | null }[]>`select fixture_id from fixture_stream_sessions where id = ${session!.id}`;
    expect(kept, "the session's record is kept (billing and history)").toEqual({ fixture_id: null });
  });

  it("an online game on a board refuses (ONLINE_GAME_EXISTS); the board untouched", async () => {
    const { rig, before, fixtureId } = await ready();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
      values (${fixtureId}, ${rig.auth.orgId}, now(), 'ready', ${"gm-" + randomUUID().slice(0, 12)})`;
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject({
      status: 409,
      code: "ONLINE_GAME_EXISTS",
    });
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);
  });

  it("a match with its own format refuses by name (FIXTURE_HAS_OWN_FORMAT); set back, the change goes through", async () => {
    const { rig, before, fixtureId } = await ready();
    await sql`update fixtures set rules_override = ${sql.json({ bestOf: 1 } as never)} where id = ${fixtureId}`;
    const [{ fixture_no }] = await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${fixtureId}`;
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject({
      status: 409,
      code: "FIXTURE_HAS_OWN_FORMAT",
      extra: { fixture_id: fixtureId, fixture_no },
    });
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);
    await sql`update fixtures set rules_override = null where id = ${fixtureId}`;
    await change(rig);
    expect((await board(rig.divisionId)).stages.map((s) => s.kind)).toEqual(["knockout"]);
  });

  it("a frozen schedule refuses the clear (422 SCHEDULE_LOCKED); with no fixtures the freeze has nothing to guard", async () => {
    const { rig, before } = await ready();
    await sql`update divisions set schedule_locked = true where id = ${rig.divisionId}`;
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject({
      status: 422,
      code: "SCHEDULE_LOCKED",
    });
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);
    // The empty case: a frozen division with no fixtures replaces its stages as it always has.
    const bare = await seedDivision({ entrants: 2 });
    await createStages(bare.auth, bare.divisionId, [league(1)]);
    await sql`update divisions set schedule_locked = true where id = ${bare.divisionId}`;
    const rows = await replaceStages(bare.auth, bare.divisionId, [knockout(1)]);
    expect(rows.map((r) => r.kind)).toEqual(["knockout"]);
  });

  it("setup goes with the fixtures (ON DELETE CASCADE), and the preview counts what the confirm then deletes", async () => {
    const { rig, before, stageId } = await ready();
    const { courts } = await schedule(rig, stageId);
    const [a, b] = before.fixtureIds;
    const person = async (name: string) =>
      (await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${rig.auth.orgId}, ${name}) returning id`)[0]!.id;
    const p1 = await person("Umpire");
    const p2 = await person("Player");
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${rig.auth.orgId}, ${p1}, 'Umpire', ${sql.json(["umpire"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${rig.auth.orgId}, ${a!}, ${official!.id}, 'umpire', 'accepted')`;
    const [home] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${a!}`;
    await sql`insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no)
              values (${a!}, ${home!.home_entrant_id}, ${p2}, ${rig.auth.orgId}, 'starting', 1)`;
    for (const f of [a!, b!]) {
      await sql`insert into device_links (org_id, fixture_id, token_hash, issued_by)
                values (${rig.auth.orgId}, ${f}, ${createHash("sha256").update(randomUUID()).digest("hex")}, ${rig.auth.userId})`;
    }
    const [placed] = await sql<{ court_id: string; scheduled_at: Date }[]>`select court_id, scheduled_at from fixtures where id = ${b!}`;
    await sql`insert into fixture_calls (fixture_id, org_id, court_id, called_at)
              values (${b!}, ${rig.auth.orgId}, ${placed!.court_id}, ${placed!.scheduled_at})`;
    await sql`insert into fixture_availability (fixture_id, person_id, org_id, status) values (${a!}, ${p2}, ${rig.auth.orgId}, 'in')`;
    await sql`insert into fixture_play_flags (fixture_id, org_id, kind) values (${a!}, ${rig.auth.orgId}, 'camera_lost')`;
    await sql`insert into fixture_stream_settings (fixture_id, org_id) values (${a!}, ${rig.auth.orgId})`;
    await sql`insert into fixture_stream_codes (org_id, fixture_id, code, tok_hash, issued_by)
              values (${rig.auth.orgId}, ${a!}, ${streamCode()}, ${createHash("sha256").update(randomUUID()).digest("hex")}, ${rig.auth.userId})`;

    const had = await setupRows(before.fixtureIds);
    const seeded = SETUP_TABLES.filter((t) => had[t] > 0);
    expect(seeded, "anti-vacuity: every setup table carries a row").toEqual([...SETUP_TABLES]);

    const preview = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(await setupRows(before.fixtureIds), "the preview deleted nothing").toEqual(had);
    expect(preview.courts).toBe(courts.length);
    await replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: preview.token! });
    const left = await setupRows(before.fixtureIds);
    for (const t of SETUP_TABLES) expect(left[t], `${t}: cascaded with its fixture`).toBe(0);
    // The counts the confirm named are the rows it took.
    expect(preview.officials).toBe(had.fixture_officials - left.fixture_officials);
    expect(preview.lineups).toBe(had.lineups - left.lineups);
    expect(preview.device_links).toBe(had.device_links - left.device_links);
    expect(preview.calls).toBe(had.fixture_calls - left.fixture_calls);
    // The official survives (only the appointment goes), and so does the person.
    expect(await sql`select 1 from officials where id = ${official!.id}`).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("FMT5 — one transaction; the plan gates and the billing freeze answer as before", () => {
  it("a refusal raised AFTER the clear (a progression with no source) rolls the clear back: fixtures, stages and ledger as they were", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const before = await board(rig.divisionId);
    const [{ events }] = await sql<{ events: number }[]>`select count(*)::int as events from division_events where division_id = ${rig.divisionId}`;
    const orphan = {
      seq: 1,
      kind: "knockout" as const,
      name: "Cup",
      config: {},
      progression: {
        sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: 2 }] }],
        placement: "rank_order" as const,
        timing: "on_complete" as const,
      },
    };
    // The preview runs the same body, so it raises the same refusal before any confirm is offered.
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [orphan]))).toMatchObject({ code: "SEEDING_RULES_MISSING" });
    const token = (await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)])).token!;
    expect(await refusal(replaceStages(rig.auth, rig.divisionId, [orphan], { clear: token }))).toMatchObject({
      status: 422,
      code: "SEEDING_RULES_MISSING",
    });
    expect(await board(rig.divisionId)).toEqual(before);
    const [{ after }] = await sql<{ after: number }[]>`select count(*)::int as after from division_events where division_id = ${rig.divisionId}`;
    expect(after, "no ledger row for a change that did not happen").toBe(events);
  });

  it("a plan gate (formats.double_elim denied) is 402 with fixtures on the board, preview and change alike; nothing changes", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${rig.auth.orgId}, 'formats.double_elim', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(rig.auth.orgId);
    const before = await board(rig.divisionId);
    const de = [{ seq: 1, kind: "double_elim" as const, name: "DE", config: {}, progression: null }];
    const gate = { status: 402, featureKey: "formats.double_elim" };
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, de))).toMatchObject(gate);
    const token = (await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)])).token!;
    expect(await refusal(replaceStages(rig.auth, rig.divisionId, de, { clear: token }))).toMatchObject(gate);
    expect(await board(rig.divisionId)).toEqual(before);
  });

  it("a billing-frozen competition is 402 competitions.max_active, with or without fixtures; nothing changes", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const token = (await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)])).token!;
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${rig.auth.orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0, bool_value = null`;
    await invalidateOrgEntitlements(rig.auth.orgId);
    const before = await board(rig.divisionId);
    const freeze = { status: 402, featureKey: "competitions.max_active" };
    expect(await refusal(previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]))).toMatchObject(freeze);
    expect(await refusal(replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: token }))).toMatchObject(freeze);
    expect(await board(rig.divisionId)).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("FMT5 — sequences", () => {
  it("the format changed twice: each preview names the stages the last change made", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const first = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    const [ko] = await replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: first.token! });
    await generateStageFixtures(rig.auth, ko!.id);
    const second = await previewReplaceStages(rig.auth, rig.divisionId, [league(1, "Round robin"), knockout(2, "Final")]);
    expect(second.stages).toEqual([{ id: ko!.id, name: "Knockout" }]);
    expect(second.fixtures).toBe((await board(rig.divisionId)).fixtures.length);
    expect(second.token).not.toBe(first.token);
    const rows = await replaceStages(rig.auth, rig.divisionId, [league(1, "Round robin"), knockout(2, "Final")], { clear: second.token! });
    expect(rows.map((r) => r.name)).toEqual(["Round robin", "Final"]);
    const types = await sql<{ type: string }[]>`
      select type from division_events where division_id = ${rig.divisionId} and type = 'stages_replaced'`;
    expect(types, "one ledger row per confirmed change").toHaveLength(2);
  });

  it("after a withdrawal (before Start, a plain status flip): the format still changes, and the new board leaves the withdrawn entrant out", async () => {
    const rig = await seedDivision({ entrants: 5 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const gone = rig.entrantIds[0]!;
    await withdrawEntrantCascade(rig.auth, gone);
    expect(await divisionFormatLocked(rig.auth, rig.divisionId), "a pre-Start withdrawal records no result").toBe(false);
    const p = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    const [ko] = await replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: p.token! });
    await generateStageFixtures(rig.auth, ko!.id);
    const seated = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${ko!.id} and ${gone} in (home_entrant_id, away_entrant_id)`;
    expect(seated[0]!.n).toBe(0);
    expect((await board(rig.divisionId)).fixtures.length, "the new board was drawn").toBeGreaterThan(0);
  });

  it("another sport: a started chess Swiss with round 1 paired (5 players, so a system bye) changes format; the bye is no result", async () => {
    const rig = await seedDivision({ entrants: 5, sport: "boardgame", variant: "classical" });
    const [swiss] = await createStages(rig.auth, rig.divisionId, [
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null },
    ]);
    await startDivision(rig.auth, rig.divisionId);
    await generateStageFixtures(rig.auth, swiss!.id);
    const [{ byes }] = await sql<{ byes: number }[]>`
      select count(*)::int as byes from fixtures where stage_id = ${swiss!.id} and ext_key ~ '-bye$' and home_entrant_id is not null`;
    expect(byes, "premise: round 1 seats a bye").toBeGreaterThan(0);
    expect(await divisionFormatLocked(rig.auth, rig.divisionId)).toBe(false);
    const before = await board(rig.divisionId);
    const p = await previewReplaceStages(rig.auth, rig.divisionId, [league(1, "All play all")]);
    expect(p.fixtures).toBe(before.fixtures.length);
    const rows = await replaceStages(rig.auth, rig.divisionId, [league(1, "All play all")], { clear: p.token! });
    expect(rows.map((r) => r.kind)).toEqual(["league"]);
    expect((await board(rig.divisionId)).fixtures).toEqual([]);
    // And the new stage draws on the started division.
    await generateStageFixtures(rig.auth, rows[0]!.id);
    expect((await board(rig.divisionId)).fixtures.length).toBeGreaterThan(0);
  });

  it("generated with no schedule: the preview has no slots and no courts, and the change goes through", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const p = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(p.fixtures).toBeGreaterThan(0);
    expect([p.slots, p.courts]).toEqual([0, 0]);
    await replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: p.token! });
    expect((await board(rig.divisionId)).stages.map((s) => s.kind)).toEqual(["knockout"]);
  });

  it("a schedule set up but nothing generated: no fixture to clear, so no token is asked and the stages are simply replaced", async () => {
    const rig = await seedDivision({ entrants: 4 });
    await createStages(rig.auth, rig.divisionId, [league(1)]);
    const venue = await createVenue(rig.auth, { name: "Hall", sort: 0 });
    const court = await createCourt(rig.auth, venue.id, { name: "C1", sort: 0, tags: [] });
    await putScheduleSettings(rig.auth, rig.divisionId, {
      config: {
        startAt: "2030-06-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [court.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const p = await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(p).toMatchObject({ fixtures: 0, slots: 0, courts: 0, token: null });
    const rows = await replaceStages(rig.auth, rig.divisionId, [knockout(1)]);
    expect(rows.map((r) => r.kind)).toEqual(["knockout"]);
    const types = await sql`select 1 from division_events where division_id = ${rig.divisionId} and type = 'stages_replaced'`;
    expect(types, "nothing was cleared, so nothing is ledgered").toHaveLength(0);
  });
});

/** Backends waiting on a lock `pid` holds. */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}

async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!HAS_DB)("FMT5 — a first score racing the change", () => {
  it("a score event committed while the change waits on that board's append lock is read under it: FORMAT_LOCKED, nothing deleted", async () => {
    const rig = await seedDivision({ entrants: 4 });
    const [stage] = await createStages(rig.auth, rig.divisionId, [league(1)]);
    await generateStageFixtures(rig.auth, stage!.id);
    const before = await board(rig.divisionId);
    const token = (await previewReplaceStages(rig.auth, rig.divisionId, [knockout(1)])).token!;
    const target = before.fixtureIds[0]!;
    let change!: Promise<unknown>;
    let settled = false;
    await sql.begin(async (holder) => {
      // The lock every score append takes (append-event.ts): scoring serialises on the fixture, never the division.
      await holder`select pg_advisory_xact_lock(hashtext(${"fixture:" + target}))`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      change = replaceStages(rig.auth, rig.divisionId, [knockout(1)], { clear: token });
      change.then(
        () => (settled = true),
        () => (settled = true),
      );
      await until("the change parks on the board's append lock (or finishes without waiting for it)", async () =>
        settled || (await waitersOn(held!.pid)).length === 1);
      expect(settled, "the change waits for the scorer").toBe(false);
      await holder`
        insert into score_events (fixture_id, org_id, seq, type, payload)
        values (${target}, ${rig.auth.orgId}, 1, 'core.start', '{}'::jsonb)`;
    });
    expect(await refusal(change)).toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
    expect((await board(rig.divisionId)).fixtureIds).toEqual(before.fixtureIds);
  });
});

describe.skipIf(!HAS_DB)("FMT5 — every table that points at a fixture, a stage or a pool is handled on purpose", () => {
  // The decision per foreign key (the report's FK table). `refused` names the guard that refuses the change while such a
  // row holds a result or a live thing; every other row goes with the clear. A NEW foreign key reds here until it is
  // given a decision.
  const DECLARED: Record<string, { action: "c" | "n"; handling: string }> = {
    "capture_records(fixture_id)->fixtures": { action: "c", handling: "cascade (a capture that reached the ledger is evidence: FORMAT_LOCKED)" },
    "device_links(fixture_id)->fixtures": { action: "c", handling: "cascade, counted (preview.device_links)" },
    "entrants(swiss_first_round_stage_id)->stages": { action: "n", handling: "set null: the entrant stays" },
    "event_imports(fixture_id)->fixtures": { action: "c", handling: "cascade (an import that appended is evidence: FORMAT_LOCKED)" },
    "fixture_availability(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_calls(fixture_id)->fixtures": { action: "c", handling: "cascade, counted (preview.calls)" },
    "fixture_external_play(fixture_id)->fixtures": { action: "c", handling: "refused while a game exists (ONLINE_GAME_EXISTS), else cascade" },
    "fixture_officials(fixture_id)->fixtures": { action: "c", handling: "cascade, counted (preview.officials)" },
    "fixture_play_flags(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_seat_asks(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_seat_line(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_stream_codes(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_stream_sessions(fixture_id)->fixtures": { action: "n", handling: "refused while active (FORMAT_STREAM_LIVE), else set null" },
    "fixture_stream_settings(fixture_id)->fixtures": { action: "c", handling: "cascade" },
    "fixture_video_meetings(fixture_id)->fixtures": { action: "c", handling: "cascade (its trigger parks the room for ending)" },
    "fixtures(loser_to_fixture)->fixtures": { action: "n", handling: "set null (every fixture goes)" },
    "fixtures(parent_fixture_id)->fixtures": { action: "c", handling: "cascade (every fixture goes)" },
    "fixtures(pool_id)->pools": { action: "n", handling: "set null (every fixture goes)" },
    "fixtures(stage_id)->stages": { action: "c", handling: "deleted first, counted (preview.fixtures, slots, courts)" },
    "fixtures(winner_to_fixture)->fixtures": { action: "n", handling: "set null (every fixture goes)" },
    "lineups(fixture_id)->fixtures": { action: "c", handling: "cascade, counted (preview.lineups)" },
    "match_reports(fixture_id)->fixtures": { action: "c", handling: "evidence: FORMAT_LOCKED" },
    "match_states(fixture_id)->fixtures": { action: "c", handling: "evidence (but a generator's seq-0 award): FORMAT_LOCKED" },
    "official_marks(fixture_id)->fixtures": { action: "c", handling: "evidence: FORMAT_LOCKED" },
    "officials(home_pool_id)->pools": { action: "n", handling: "set null: the official stays" },
    "online_chess_audit(fixture_id)->fixtures": { action: "c", handling: "cascade (a live game refuses first)" },
    "pools(stage_id)->stages": { action: "c", handling: "cascade with its stage" },
    "score_events(fixture_id)->fixtures": { action: "c", handling: "evidence: FORMAT_LOCKED" },
    "stage_lots_draws(stage_id,org_id)->stages": { action: "c", handling: "cascade with its stage" },
    "stage_round_court_tags(stage_id,org_id)->stages": { action: "c", handling: "cascade with its stage" },
    "stage_round_opens(stage_id,org_id)->stages": { action: "c", handling: "cascade with its stage" },
    "stage_seed_proposals(stage_id)->stages": { action: "c", handling: "cascade with its stage" },
    "standings_snapshots(stage_id)->stages": { action: "c", handling: "cascade with its stage (derived)" },
    "suspensions(fixture_id)->fixtures": { action: "n", handling: "evidence: FORMAT_LOCKED (else set null)" },
    "youtube_broadcasts(fixture_id)->fixtures": { action: "c", handling: "cascade (a live broadcast has an active session: FORMAT_STREAM_LIVE)" },
  };

  it("the catalog's foreign keys are exactly the declared ones, each with its declared delete action", async () => {
    const rows = await sql<{ fk: string; action: string }[]>`
      select regexp_replace(c.conrelid::regclass::text, '^.*\\.', '') || '(' ||
             (select string_agg(a.attname, ',' order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) || ')->' ||
             regexp_replace(c.confrelid::regclass::text, '^.*\\.', '') as fk,
             c.confdeltype as action
        from pg_constraint c
       where c.contype = 'f' and c.confrelid in ('fixtures'::regclass, 'stages'::regclass, 'pools'::regclass)
       order by 1`;
    expect(rows.length, "anti-vacuity: foreign keys checked").toBeGreaterThan(0);
    expect(Object.fromEntries(rows.map((r) => [r.fk, r.action]))).toEqual(
      Object.fromEntries(Object.entries(DECLARED).map(([k, v]) => [k, v.action])),
    );
  });
});
