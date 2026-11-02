// Match Day PB2 (owner 2026-11-02, "apply rec", option A): a BILLING-frozen competition — over its organisation's
// `competitions.max_active` after a downgrade — ALLOWS scoring. `assertEntitledToScore` (scoring.ts) no longer asks the freeze,
// so the pad, the scorer QR's device link and the organiser's own session all record on a frozen competition, while every
// other write the freeze guards (a Match Day call and its Undo, a schedule edit) still answers its 402.
//
// Every write here goes through the REAL door against real Postgres: the scorer QR's device link POSTs to the events route
// (`POST /api/v1/fixtures/{id}/events`, `requireFixtureActor` then `scoreEvent`), and the organiser calls `scoreEvent`, the
// function that route calls. The freeze itself is the product's own selector (`frozenCompetitionIds`), reached the way a
// downgrade reaches it: the plan drops to community and newer competitions take the active slots (raw SQL fillers, because
// `createCompetition` enforces the quota itself — scoring-engine-epoch.test.ts 13c, match-day-call.test.ts "the billing freeze").
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSportAsync } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { POST as eventsRoute } from "@/app/api/v1/fixtures/[id]/events/route";
import { createDeviceLink } from "../device-links";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { patchCompetition } from "../competitions";
import { moveFixture } from "../schedule";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Seeded {
  auth: AuthCtx;
  competitionId: string;
  fixtureId: string;
  entrants: [string, string];
}

/** A started knockout of `sport` with a seated fixture, through the usecases. The variant is the sport's FIRST declared one —
 *  an engine declaration, never a guessed key. */
async function seed(sport: string): Promise<Seeded> {
  const m = builtinModules.find((x) => x.key === sport);
  if (m === undefined) throw new Error(`no builtin sport ${sport}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${sport} declares no variant`);
  const s = await seedBracket({ sport, variant: declaredVariant(sport, variant), stageKind: "knockout", entrants: 4 });
  const fixtureId = s.fixtureIds[0]!;
  const [row] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
    select home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
  return { auth: s.auth, competitionId: s.competitionId, fixtureId, entrants: [row!.home_entrant_id, row!.away_entrant_id] };
}

/** Puts the org over its active-competition ceiling so exactly the seeded competition freezes, and proves it.
 *  - "downgrade" (the real way there): the plan drops to community and `limit` newer competitions take the active slots;
 *  - "ceiling": the org keeps its plan and an entitlement override pins the ceiling at 0 (pool-nesting-tripwire.test.ts's
 *    pin). Used where the test needs a Pro capability on the frozen competition: `scoring.device_links` is Pro's, so a
 *    downgraded org could not mint the scorer QR's link at all — a plan gate, not the freeze this file is about. */
async function freeze(s: Seeded, how: "downgrade" | "ceiling" = "downgrade"): Promise<void> {
  if (how === "downgrade") {
    await setOrgPlan(s.auth.orgId, "community");
    await invalidateOrgEntitlements(s.auth.orgId);
    const limit = await getLimit(s.auth.orgId, "competitions.max_active");
    expect(limit, "premise: the community plan has a competitions ceiling").not.toBeNull();
    for (let i = 0; i < (limit as number); i++) {
      const suffix = randomUUID().slice(0, 8);
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${s.auth.orgId}, ${"Filler " + suffix}, ${"filler-" + suffix}, 'draft')`;
    }
  } else {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${s.auth.orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0, bool_value = null`;
    await invalidateOrgEntitlements(s.auth.orgId);
  }
  expect([...(await frozenCompetitionIds(s.auth.orgId))], "premise: exactly the seeded competition is frozen").toEqual([
    s.competitionId,
  ]);
}

async function rows(fixtureId: string): Promise<Array<{ seq: number; type: string; device_link_id: string | null }>> {
  return sql<{ seq: number; type: string; device_link_id: string | null }[]>`
    select seq, type, device_link_id from score_events where fixture_id = ${fixtureId} order by seq`;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e;
  }
  throw new Error("expected the write to be refused, but it was accepted");
}

describe.skipIf(!HAS_DB)("a billing-frozen competition scores (PB2, option A)", () => {
  it("the freeze is real (a schedule edit on the same competition answers its 402), and the organiser's score events still land: start, a point, its undo", async () => {
    const s = await seed("badminton");
    // EMPTY CASE FIRST: before the freeze, the same schedule edit goes through — so the 402 below is the freeze, not the edit.
    await moveFixture(s.auth, s.fixtureId, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    await freeze(s);
    const edit = await refusal(moveFixture(s.auth, s.fixtureId, { scheduled_at: "2030-06-01T11:00:00.000Z" }));
    expect(edit, "the control: a schedule edit on the frozen competition").toBeInstanceOf(PaymentRequiredError);
    expect([edit.status, (edit as PaymentRequiredError).featureKey]).toEqual([402, "competitions.max_active"]);

    const started = await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.seq).toBe(1);
    // A second write, the sport's own (a rally won), lands after the first.
    const point = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: s.entrants[0] },
    });
    expect(point.seq).toBe(2);
    // And the undo of that point (a `core.void` goes through the same door).
    const undone = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: 2,
      type: "core.void",
      payload: { event_id: point.event_id },
    });
    expect(undone.seq).toBe(3);
    expect((await rows(s.fixtureId)).map((r) => [r.seq, r.type])).toEqual([
      [1, "core.start"],
      [2, "badminton.rally"],
      [3, "core.void"],
    ]);
  });

  it("the scorer QR's device link, minted ON the frozen competition, scores through the real POST /fixtures/{id}/events route: 201 twice, both rows carry the link", async () => {
    const s = await seed("badminton");
    await freeze(s, "ceiling");
    vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
    // seedBracket's actor has no user (a link is minted by a signed-in organiser and records who issued it), so give it one.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`frozen-${randomUUID().slice(0, 8)}@test.local`}, 'Frozen Organiser', true) returning id`;
    // The QR Match Day hands out is this link: minting it is not a write the freeze refuses.
    const link = await createDeviceLink({ ...s.auth, userId }, s.fixtureId, "court 1");
    const bearer = { authorization: `Bearer ${link.secret}`, "content-type": "application/json" };
    const device = await requireFixtureActor(new Request("http://test.local/api/v1", { headers: bearer }), s.fixtureId, "score");
    expect([device.via, device.deviceLinkId], "premise: a real device-link actor").toEqual(["device_link", link.id]);
    const post = (body: Record<string, unknown>) =>
      eventsRoute(
        new Request(`http://test.local/api/v1/fixtures/${s.fixtureId}/events`, { method: "POST", headers: bearer, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: s.fixtureId }) },
      );

    const first = await post({ expected_seq: 0, type: "core.start", payload: {} });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await post({ expected_seq: 1, type: "badminton.rally", payload: { wonBy: s.entrants[1] } });
    expect(second.status, await second.clone().text()).toBe(201);
    expect(await rows(s.fixtureId)).toEqual([
      { seq: 1, type: "core.start", device_link_id: link.id },
      { seq: 2, type: "badminton.rally", device_link_id: link.id },
    ]);
  });

  // Review C1, fixed (owner 2026-11-02, option A: "lock in the frozen set when the org goes over its limit"). In a REAL freeze —
  // community's own limit, newer competitions in the active slots — the set is CHOSEN ONCE and stored (`competitions.frozen_at`,
  // V489): scoring a frozen competition, once or again, makes it the most recently active and still moves nothing. Room moves
  // it: archiving one running competition thaws exactly one frozen one, the most recently active (the one being scored), and
  // the idle one stays frozen. Every other test here pins the limit at 0, where nothing could ever rotate.
  it("C1: in a real community freeze the frozen set is chosen once — scoring it (twice) moves nothing, its schedule edit stays 402; archiving one running competition thaws exactly one, the most recently active", async () => {
    const s = await seed("badminton");
    // A second, IDLE competition, older than everything: the freeze takes it too, and it is the one that must stay frozen.
    const idle = randomUUID().slice(0, 8);
    const [{ id: idleId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, status, created_at)
      values (${s.auth.orgId}, ${"Idle " + idle}, ${"idle-" + idle}, 'draft', now() - interval '30 days') returning id`;
    await setOrgPlan(s.auth.orgId, "community");
    await invalidateOrgEntitlements(s.auth.orgId);
    const limit = await getLimit(s.auth.orgId, "competitions.max_active");
    expect(limit, "premise: a REAL limit, not the override pin's 0").toBeGreaterThan(0);
    const fillers: string[] = [];
    for (let i = 0; i < (limit as number); i++) {
      const suffix = randomUUID().slice(0, 8);
      const [{ id }] = await sql<{ id: string }[]>`
        insert into competitions (org_id, name, slug, status)
        values (${s.auth.orgId}, ${"Filler " + suffix}, ${"filler-" + suffix}, 'draft') returning id`;
      fillers.push(id);
    }
    const frozenNow = async () => [...(await frozenCompetitionIds(s.auth.orgId))].sort();
    const both = [s.competitionId, idleId].sort();
    expect(await frozenNow(), "the overflow freezes the two least recently active: the seeded one and the idle one").toEqual(both);
    const stored = async () =>
      (await sql<{ id: string; frozen_at: Date }[]>`
        select id, frozen_at from competitions where org_id = ${s.auth.orgId} and frozen_at is not null order by id`).map((r) => [
        r.id,
        r.frozen_at.toISOString(),
      ]);
    const chosen = await stored();
    expect(chosen.map(([id]) => id), "the choice is STORED").toEqual(both);
    // The schedule edit is asked of the competition's OTHER first-round match: the scored one is in play, and moving a match
    // in play is refused for its status whatever the freeze says — a 402 there would prove nothing.
    const [other] = await sql<{ id: string }[]>`
      select f.id from fixtures f
       where f.division_id = (select division_id from fixtures where id = ${s.fixtureId})
         and f.id <> ${s.fixtureId} and f.status = 'scheduled'
         and f.home_entrant_id is not null and f.away_entrant_id is not null
       limit 1`;
    expect(other, "premise: a second, unstarted, seated match in the same competition").toBeDefined();
    const scheduleEditRefused = async (at: string) => {
      const edit = await refusal(moveFixture(s.auth, other!.id, { scheduled_at: at }));
      expect(edit).toBeInstanceOf(PaymentRequiredError);
      expect([edit.status, (edit as PaymentRequiredError).featureKey]).toEqual([402, "competitions.max_active"]);
    };
    await scheduleEditRefused("2030-06-01T12:00:00.000Z");

    // Scored once: now the organisation's most recently active competition — and still frozen, the idle one too.
    const started = await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.seq, "premise: the frozen competition scored").toBe(1);
    expect(await frozenNow(), "a score does not move the freeze").toEqual(both);
    await scheduleEditRefused("2030-06-01T13:00:00.000Z");
    // Scored again: the same.
    const point = await scoreEvent(s.auth, s.fixtureId, { expected_seq: 1, type: "badminton.rally", payload: { wonBy: s.entrants[0] } });
    expect(point.seq).toBe(2);
    expect(await frozenNow(), "a second score does not move it either").toEqual(both);
    expect(await stored(), "nor re-stamps it: the stored choice is the first one").toEqual(chosen);
    await scheduleEditRefused("2030-06-01T14:00:00.000Z");

    // Room: one running competition archived (the real retire patch, which the freeze allows) — exactly ONE frozen competition
    // thaws, and it is the most recently active one (the seeded competition, scored twice), not the idle one.
    await patchCompetition(s.auth, fillers[0]!, { status: "archived" });
    expect(await frozenNow(), "exactly one thaws: the idle competition stays frozen").toEqual([idleId]);
    expect((await stored()).map(([id]) => id)).toEqual([idleId]);
    // ...and the thawed one runs again: its schedule edit goes through.
    await moveFixture(s.auth, other!.id, { scheduled_at: "2030-06-01T15:00:00.000Z" });
  });

  it("every sport: a frozen competition's match starts (one score event lands), counted", async () => {
    let written = 0;
    const checked = await forEachSportAsync(async ({ key }) => {
      const s = await seed(key);
      await freeze(s);
      const out = await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      expect(out.seq, key).toBe(1);
      expect((await rows(s.fixtureId)).length, key).toBe(1);
      written++;
    });
    expect(checked, "the sweep visited every builtin sport").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    expect(written).toBe(checked);
  }, 240_000);
});

// PB2 re-review 1, N1: reopening is the OTHER door into the active set. Archiving a frozen competition is allowed (the retire
// patch) and its mark goes with it; reopening it used to ask only the freeze guard — about a competition no longer in the
// active set, so it passed — and the competition came back RUNNING, thawed with no room, while the reconcile froze one the
// organiser never touched. A status patch from outside the active set into it now asks the quota, as create and template do.
describe.skipIf(!HAS_DB)("reopening a competition is a quota door (PB2 re-review 1, N1)", () => {
  /** A raw competition of the org (raw, because `createCompetition` enforces the quota itself). */
  async function raw(orgId: string, label: string, extra: { status?: string; age?: string } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, status, created_at)
      values (${orgId}, ${label + " " + suffix}, ${label.toLowerCase() + "-" + suffix}, ${extra.status ?? "draft"},
              now() - ${extra.age ?? "0 minutes"}::interval) returning id`;
    return id;
  }
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from competitions where id = ${id}`)[0]!.status;
  const quotaRefusal = async (p: Promise<unknown>) => {
    const e = await refusal(p);
    expect(e).toBeInstanceOf(PaymentRequiredError);
    expect([e.status, (e as PaymentRequiredError).featureKey]).toEqual([402, "competitions.max_active"]);
  };

  it("the probe's sequence: a frozen competition scored, archived, then reopened answers 402 and the set stays put; room taken by the frozen one keeps it 402; room left over lets the reopen through", async () => {
    const s = await seed("badminton");
    const org = s.auth.orgId;
    const idleId = await raw(org, "Idle", { age: "30 days" });
    await setOrgPlan(org, "community");
    await invalidateOrgEntitlements(org);
    const limit = (await getLimit(org, "competitions.max_active")) as number;
    expect(limit, "premise: a REAL limit").toBeGreaterThan(0);
    const fillers: string[] = [];
    for (let i = 0; i < limit; i++) fillers.push(await raw(org, "Filler"));
    const frozenNow = async () => [...(await frozenCompetitionIds(org))].sort();
    expect(await frozenNow(), "premise: the seeded and the idle competition are frozen").toEqual([s.competitionId, idleId].sort());
    await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });

    // Archived (the retire patch the freeze allows): it leaves the set, and the idle one is all that stays frozen.
    await patchCompetition(s.auth, s.competitionId, { status: "archived" });
    expect(await frozenNow()).toEqual([idleId]);
    // Reopened with no room: refused, and nothing moved — not its status, not the frozen set.
    await quotaRefusal(patchCompetition(s.auth, s.competitionId, { status: "live" }));
    expect(await statusOf(s.competitionId), "the refused reopen wrote nothing").toBe("archived");
    expect(await frozenNow(), "the frozen set is unchanged: no filler froze in its place").toEqual([idleId]);
    // The other ways back in are the same door.
    await quotaRefusal(patchCompetition(s.auth, s.competitionId, { status: "published" }));
    await quotaRefusal(patchCompetition(s.auth, s.competitionId, { status: "draft" }));

    // Room: one filler archived. The room goes to the frozen idle competition (it thaws), so the reopen is still over.
    await patchCompetition(s.auth, fillers[0]!, { status: "archived" });
    expect(await frozenNow(), "the freed place thaws the frozen competition").toEqual([]);
    await quotaRefusal(patchCompetition(s.auth, s.competitionId, { status: "live" }));
    // A second place freed: room left over, and the reopen goes through — nothing frozen afterwards.
    await patchCompetition(s.auth, fillers[1]!, { status: "archived" });
    await patchCompetition(s.auth, s.competitionId, { status: "live" });
    expect(await statusOf(s.competitionId)).toBe("live");
    expect(await frozenNow(), "at the limit, nothing over it").toEqual([]);
  }, 120_000);

  it("an organisation exactly AT its limit cannot reopen an archived competition (it would push a running one into the freeze); a completed one neither; a status patch that stays inside the set is not a door", async () => {
    const s = await seed("badminton");
    const org = s.auth.orgId;
    await setOrgPlan(org, "community");
    await invalidateOrgEntitlements(org);
    const limit = (await getLimit(org, "competitions.max_active")) as number;
    for (let i = 0; i < limit - 1; i++) await raw(org, "Filler");
    const archived = await raw(org, "Old", { status: "archived" });
    const completed = await raw(org, "Done", { status: "completed" });
    expect(await frozenCompetitionIds(org), "premise: at the limit, nothing frozen").toEqual(new Set());
    await quotaRefusal(patchCompetition(s.auth, archived, { status: "published" }));
    await quotaRefusal(patchCompetition(s.auth, completed, { status: "live" }));
    expect([await statusOf(archived), await statusOf(completed)]).toEqual(["archived", "completed"]);
    expect(await frozenCompetitionIds(org), "nothing froze").toEqual(new Set());
    // Inside the set: draft -> published on the seeded competition is no new slot.
    await patchCompetition(s.auth, s.competitionId, { status: "published" });
    expect(await statusOf(s.competitionId)).toBe("published");
  }, 120_000);

  it("a competition an Event Pass buys out of the quota reopens at the limit (it takes no slot); once its pass has lapsed it is a slot again and is refused", async () => {
    const s = await seed("badminton");
    const org = s.auth.orgId;
    await setOrgPlan(org, "community");
    await invalidateOrgEntitlements(org);
    const limit = (await getLimit(org, "competitions.max_active")) as number;
    for (let i = 0; i < limit - 1; i++) await raw(org, "Filler");
    const passed = await raw(org, "Passed", { status: "archived" });
    const lapsed = await raw(org, "Lapsed", { status: "archived" });
    await sql`update competitions set ends_on = (now() at time zone 'utc')::date - 30 where id = ${lapsed}`;
    for (const id of [passed, lapsed]) await sql`insert into competition_passes (competition_id, org_id) values (${id}, ${org})`;
    await patchCompetition(s.auth, passed, { status: "live" });
    expect(await statusOf(passed)).toBe("live");
    expect(await frozenCompetitionIds(org), "the passed competition counts for nothing").toEqual(new Set());
    await quotaRefusal(patchCompetition(s.auth, lapsed, { status: "live" }));
    expect(await statusOf(lapsed)).toBe("archived");
  }, 120_000);
});
