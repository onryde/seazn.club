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

  // Review C1 (HELD for the owner's fix shape — PB2 fix round 1): in a REAL freeze (community's own limit, newer competitions
  // in the active slots), one score on the frozen competition makes it the organisation's most recently active, and the
  // activity ranking (`entitlement-freeze.ts`, `last_active`) thaws it and freezes an idle competition instead. Every other
  // test here freezes with the override pin (limit 0), where nothing can rotate. `it.fails` until C1 lands: the fix flips it to
  // `it`, and it must then pass as written. (Run as a plain `it` on this tree, it fails at the "frozen set" assertion below,
  // after the score has landed — the rotation, not a broken rig.)
  it.fails("C1 (held): in a real community freeze, scoring the frozen competition leaves the freeze where it was — the same competition frozen, its schedule edit still 402", async () => {
    const s = await seed("badminton");
    await freeze(s, "downgrade");
    const limit = await getLimit(s.auth.orgId, "competitions.max_active");
    expect(limit, "premise: a REAL limit, not the override pin's 0").toBeGreaterThan(0);
    const before = [...(await frozenCompetitionIds(s.auth.orgId))];
    expect(before, "premise: the seeded competition is the frozen one").toEqual([s.competitionId]);

    const out = await scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    expect(out.seq, "premise: the frozen competition scored").toBe(1);

    expect([...(await frozenCompetitionIds(s.auth.orgId))], "C1: a score on the frozen competition moved the freeze").toEqual(before);
    const edit = await refusal(moveFixture(s.auth, s.fixtureId, { scheduled_at: "2030-06-01T12:00:00.000Z" }));
    expect(edit).toBeInstanceOf(PaymentRequiredError);
    expect([edit.status, (edit as PaymentRequiredError).featureKey], "the frozen competition's schedule edit is still refused").toEqual([
      402,
      "competitions.max_active",
    ]);
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
