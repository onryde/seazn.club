// Discipline on the competition desk (owner-approved 3A, 2026-10-27): a division with pending bans to review raises an
// AMBER `bans_waiting` attention — but ONLY when the organiser opted in (`discipline_rules.enabled`) AND the org is
// entitled to `discipline.enforced` for THIS competition (plan or Event Pass). Discipline stays opt-in and
// organiser-approved: the desk prompts a review, it never confirms anything. Real Postgres; skipped without DATABASE_URL.
//
// Every expected count below is the number of `pending` rows the test wrote — never read back from the desk.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { getCompetitionDesk } from "../competition-desk";
import { countBansToReview } from "../discipline";
import { seedFootballDivision, type FootballCtx } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function competitionOf(ctx: FootballCtx): Promise<string> {
  const [{ competition_id }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${ctx.divisionId}`;
  return competition_id;
}
async function rules(ctx: FootballCtx, divisionId: string, enabled: boolean): Promise<void> {
  await sql`
    insert into discipline_rules (org_id, division_id, enabled, rules)
    values (${ctx.orgId}, ${divisionId}, ${enabled}, ${sql.json({ accumulation: [], dismissal: [{ key: "red", color: "red", ban_matches: 1 }] } as never)})
    on conflict (division_id) do update set enabled = excluded.enabled`;
}
/** A pending ban, written as the detector writes one — raw, so a Community org (which the manual door 402s) can hold one. */
async function pendingBan(ctx: FootballCtx, divisionId: string, status = "pending"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into suspensions (org_id, division_id, person_id, status, source, rule_key, bucket, reason, matches_total)
    values (${ctx.orgId}, ${divisionId}, ${ctx.personX}, ${status}, 'auto_dismissal', ${"red:" + randomUUID()}, 0, 'Red card', 1)
    returning id`;
  return id;
}
/** The bans_waiting count the desk shows for a division, or null when it raises none. */
async function bansOnDesk(ctx: FootballCtx, divisionId: string): Promise<number | null> {
  const desk = await getCompetitionDesk(ctx.auth, await competitionOf(ctx));
  const d = desk.divisions.get(divisionId);
  expect(d, "rig: the division is on the desk").toBeDefined();
  const a = d!.attention.find((x) => x.kind === "bans_waiting");
  return a && a.kind === "bans_waiting" ? a.count : null;
}
/** A second division in the same competition, its own stage — the per-division scope's witness. */
async function sibling(ctx: FootballCtx): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    select competition_id, org_id, 'Reserves', ${"reserves-" + randomUUID().slice(0, 6)}, sport_key, variant_key, config, module_version
    from divisions where id = ${ctx.divisionId}
    returning id`;
  await sql`insert into stages (division_id, org_id, seq, kind, name) values (${id}, ${ctx.orgId}, 1, 'league', 'League')`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("competition desk — bans_waiting (discipline 3A)", () => {
  it("empty case first: rules on, entitled, nothing pending ⇒ no attention; then one, then two pending ⇒ the count", async () => {
    const ctx = await seedFootballDivision("pro");
    await rules(ctx, ctx.divisionId, true);
    expect(await bansOnDesk(ctx, ctx.divisionId), "nothing pending").toBeNull();
    await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId)).toBe(1);
    await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId)).toBe(2);
  }, 60_000);

  it("only PENDING bans count: an active, served or waived one is not waiting on the organiser", async () => {
    const ctx = await seedFootballDivision("pro");
    await rules(ctx, ctx.divisionId, true);
    for (const status of ["active", "served", "waived"]) await pendingBan(ctx, ctx.divisionId, status);
    expect(await bansOnDesk(ctx, ctx.divisionId)).toBeNull();
    // Reviewed down to zero: a pending ban confirmed leaves the desk.
    const id = await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId)).toBe(1);
    await sql`update suspensions set status = 'active', decided_at = now() where id = ${id}`;
    expect(await bansOnDesk(ctx, ctx.divisionId), "after the review").toBeNull();
  }, 60_000);

  it("rules OFF ⇒ no attention though bans are pending (discipline is opt-in); switched on ⇒ it appears", async () => {
    const ctx = await seedFootballDivision("pro");
    await rules(ctx, ctx.divisionId, false);
    await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId), "rules off").toBeNull();
    await rules(ctx, ctx.divisionId, true);
    expect(await bansOnDesk(ctx, ctx.divisionId), "positive pair: rules on").toBe(1);
  }, 60_000);

  it("no discipline rules row at all ⇒ no attention", async () => {
    const ctx = await seedFootballDivision("pro");
    await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId)).toBeNull();
  }, 60_000);

  it("NOT entitled (Community, no pass) ⇒ no attention; an Event Pass on THIS competition entitles it", async () => {
    const ctx = await seedFootballDivision("community");
    await rules(ctx, ctx.divisionId, true);
    await pendingBan(ctx, ctx.divisionId);
    expect(await bansOnDesk(ctx, ctx.divisionId), "community, no pass").toBeNull();
    await sql`insert into competition_passes (competition_id, org_id) values (${await competitionOf(ctx)}, ${ctx.orgId})`;
    await invalidateOrgEntitlements(ctx.orgId);
    expect(await bansOnDesk(ctx, ctx.divisionId), "positive pair: the pass entitles this competition").toBe(1);
  }, 60_000);

  it("the count is per division: a sibling's pending bans are not this division's, and its rules are its own", async () => {
    const ctx = await seedFootballDivision("pro");
    const reserves = await sibling(ctx);
    await rules(ctx, ctx.divisionId, true);
    await rules(ctx, reserves, false);
    await pendingBan(ctx, reserves);
    await pendingBan(ctx, reserves);
    expect(await bansOnDesk(ctx, ctx.divisionId), "the open division has none of its own").toBeNull();
    expect(await bansOnDesk(ctx, reserves), "the sibling's rules are off").toBeNull();
    await rules(ctx, reserves, true);
    expect(await bansOnDesk(ctx, reserves)).toBe(2);
    expect(await bansOnDesk(ctx, ctx.divisionId), "still none leaks across").toBeNull();
  }, 60_000);

  // The division page's tab dot reads `countBansToReview`; the desk reads card-stats. Two queries for one fact, so they
  // are held to agree at every step of one sequence (the entitlement is each caller's own question — Pro here).
  it("the division tab's count agrees with the desk's at every step: none, rules off, pending, reviewed", async () => {
    const ctx = await seedFootballDivision("pro");
    const both = async () => [await countBansToReview(ctx.auth, ctx.divisionId), (await bansOnDesk(ctx, ctx.divisionId)) ?? 0];
    const steps: number[][] = [];
    steps.push(await both()); // no rules row, nothing pending
    await rules(ctx, ctx.divisionId, false);
    const first = await pendingBan(ctx, ctx.divisionId);
    await pendingBan(ctx, ctx.divisionId, "active");
    steps.push(await both()); // rules off: pending but not counted
    await rules(ctx, ctx.divisionId, true);
    await pendingBan(ctx, ctx.divisionId);
    steps.push(await both()); // two pending, one active
    await sql`update suspensions set status = 'waived', decided_at = now() where id = ${first}`;
    steps.push(await both()); // one reviewed
    expect(steps).toEqual([[0, 0], [0, 0], [2, 2], [1, 1]]);
  }, 60_000);
});
