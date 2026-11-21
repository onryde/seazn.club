// W5 B4 (stress F8; owner 2026-11-21): sign-up for a division closes once its FORMAT's max entrants is reached - the largest field
// the division's first stage can start inside the measured Start line budget (`lib/format-max-entrants.ts`). Not a parallel
// mechanism: the format's max is the third term of the cap submit already enforces (`placesLeft`, places-left.ts: min of the
// organiser's capacity and the plan's per-division limit), so past it a sign-up joins the waiting list, the public panel counts
// it, and an organiser's promotion is refused by name, confirmed or not.
//
// Expected values: the league's max from the engine's own round-robin count (`roundRobinFixtureCount`), never from the cap.
// Another sport: N/A - registration capacity is sport-agnostic (the rig's generic division).
import { afterAll, describe, expect, it } from "vitest";
import { roundRobinFixtureCount } from "@seazn/engine/scheduling";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { formatMaxEntrants, START_LINE_BUDGET } from "@/lib/format-max-entrants";
import { v1 } from "@/server/api-v1/http";
import { createStages } from "../stages";
import { publicRegistrationInfo, putRegistrationSettings } from "../registrations";
import { promoteFromWaitlist } from "../registration-approval";
import { submitRegistrationGroup } from "../registration-submit";
import { SETTINGS_BASE, asOwner, rig, seedOrg, seedRegistration } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const FEES = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
const LEAGUE = { kind: "league", config: { legs: 1 } };
/** A free entry holds its place as `pending` (manual approval) or `confirmed` (auto); either is not the waiting list. */
const PLACE_HOLDING = ["pending", "confirmed"];

async function setup(capacity: number | null, stage: { kind: string; config: Record<string, unknown> } | null = LEAGUE) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  if (stage !== null) await createStages(owner, division.id, { seq: 1, name: "Stage", progression: null, ...stage } as never);
  await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity });
  const fill = async (n: number, status: "confirmed" | "waitlisted" = "confirmed") => {
    for (let i = 0; i < n; i++) await seedRegistration(competition.id, division.id, FEES, { status, displayName: `Holder ${i + 1}` });
  };
  const signUp = async () =>
    (
      await submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: { name: "Late Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
          privacy_consent: true,
          entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Late Player" }], answers: {} }],
        },
      )
    ).entries[0]!.status;
  const remaining = async () => (await publicRegistrationInfo(orgSlug, competition.slug)).divisions.find((d) => d.division_id === division.id)!.remaining;
  const planLimit = () => getLimit(orgId, "entrants.per_division.max", competition.id);
  return { owner, competition, division, fill, signUp, remaining, planLimit };
}

describe("premise: the league's max is the engine's", () => {
  it("the largest field whose round robin fits the Start line budget", () => {
    const max = formatMaxEntrants(LEAGUE)!;
    expect(roundRobinFixtureCount(max, 1)).toBeLessThanOrEqual(START_LINE_BUDGET);
    expect(roundRobinFixtureCount(max + 1, 1)).toBeGreaterThan(START_LINE_BUDGET);
  });
});

describe.skipIf(!HAS_DB)("sign-up closes at the format's max entrants (W5 B4, F8)", () => {
  it("no capacity set: sign-up number max takes a place, number max + 1 waits; the panel counts down to 0", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const t = await setup(null);
    await t.fill(max - 1);
    expect(await t.remaining(), "one place left before the last").toBe(1);
    expect(PLACE_HOLDING, `sign-up number ${max} takes a place`).toContain(await t.signUp());
    expect(await t.remaining(), "full at the format's max").toBe(0);
    expect(await t.signUp(), `sign-up number ${max + 1}`).toBe("waitlisted");
  });

  it("a capacity above the format's max is clamped to it; one below it still binds first", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const above = await setup(max + 50);
    await above.fill(max);
    expect(await above.remaining()).toBe(0);
    expect(await above.signUp(), "past the format's max, under the organiser's capacity").toBe("waitlisted");

    const below = await setup(3);
    await below.fill(3);
    expect(await below.signUp(), "the organiser's capacity, smaller, binds first").toBe("waitlisted");
  });

  it("no format yet: the division takes sign-ups past any format's max (the empty case), to the plan's own limit", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const t = await setup(null, null);
    const plan = await t.planLimit();
    expect(plan === null || plan > max + 1, "premise: the plan leaves room past the league's max").toBe(true);
    await t.fill(max);
    expect(await t.remaining(), "only the plan counts").toBe(plan === null ? null : plan - max);
    expect(PLACE_HOLDING).toContain(await t.signUp());
  });

  it("an organiser's promotion at the format's max is refused by name, even confirmed past capacity; nothing is written", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const t = await setup(null);
    await t.fill(max);
    const { registration: waiting } = await seedRegistration(t.competition.id, t.division.id, FEES, { status: "waitlisted", displayName: "Waiting" });
    const res = await v1(() => promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting.id, confirmOverCapacity: true }));
    const json = (await res.json()) as { error?: { code: string; message?: string; max?: number; entrants?: number } };
    expect(res.status, JSON.stringify(json.error)).toBe(422);
    expect(json.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max });
    expect((await sql<{ status: string }[]>`select status from registrations where id = ${waiting.id}`)[0]!.status).toBe("waitlisted");
  });
});
