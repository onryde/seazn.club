// UI5 item 6 (owner, 2026-11-03: "why does it saying registration open even though no registration opened in division
// level"). The org dashboard's card chip read `competitions.status` alone and printed "published" as "Registration open".
// It is now read off the competition's divisions, and `listCompetitionCardStats` (the dashboard's ONE read for every card)
// carries what the ladder needs: matches in play, whether any division's registration window is open (the SAME predicate the
// competition page's Registration count reads, `listDivisionCardStats.registration_open`), and how many divisions have
// started and finished. Archived divisions count for none of it, as for every other number on the card.
//
// The last case drives the real read into the real ladder (`competitionChipState`) for the owner's own competition.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { competitionChipState } from "@/components/ui/status-chip";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { listCompetitionCardStats, listDivisionCardStats, type CompetitionCardStats } from "../card-stats";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

async function competition(auth: AuthCtx, status = "published") {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Chip " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  await sql`update competitions set status = ${status} where id = ${comp.id}`;
  return comp;
}
const division = (auth: AuthCtx, compId: string, name: string) =>
  createDivision(auth, compId, { name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
async function window(auth: AuthCtx, divisionId: string, w: { enabled: boolean; opens_at?: string | null; closes_at?: string | null }) {
  await sql`
    insert into registration_settings (division_id, org_id, enabled, opens_at, closes_at)
    values (${divisionId}, ${auth.orgId}, ${w.enabled}, ${w.opens_at ?? null}, ${w.closes_at ?? null})
    on conflict (division_id) do update set enabled = excluded.enabled, opens_at = excluded.opens_at, closes_at = excluded.closes_at`;
}
/** A league of three: three fixtures, every side named. */
async function league(auth: AuthCtx, divisionId: string): Promise<string[]> {
  await createEntrants(auth, divisionId, ["A", "B", "C"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return fixtures.map((f) => f.id);
}
async function card(auth: AuthCtx, compId: string): Promise<CompetitionCardStats> {
  const s = (await listCompetitionCardStats(auth)).get(compId);
  expect(s, "every competition of the org has a card row").toBeTruthy();
  return s!;
}
const signals = (s: CompetitionCardStats) => ({
  inPlay: s.in_play,
  registrationOpen: s.registration_open,
  divisions: s.divisions,
  divisionsActive: s.divisions_active,
  divisionsCompleted: s.divisions_completed,
  played: s.played,
});

describe.skipIf(!HAS_DB)("card-stats: the signals the competition card's chip is read off (UI5 item 6)", () => {
  it("the empty case first: a competition with no division says nothing at all", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await competition(auth);
    expect(signals(await card(auth, comp.id))).toEqual({
      inPlay: 0, registrationOpen: false, divisions: 0, divisionsActive: 0, divisionsCompleted: 0, played: 0,
    });
  });

  it("registration_open is a division's WINDOW, the competition page's own predicate, never the competition's status", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await competition(auth, "published");
    const a = await division(auth, comp.id, "A");
    const b = await division(auth, comp.id, "B");
    expect((await card(auth, comp.id)).registration_open, "published, no window anywhere").toBe(false);

    // Each closed shape, one at a time, then the open one: the card agrees with the competition page's per-division answer
    // at every step (one predicate, two reads).
    const steps: { w: Parameters<typeof window>[2]; open: boolean; why: string }[] = [
      { w: { enabled: false }, open: false, why: "settings saved, intake off" },
      { w: { enabled: true, opens_at: at(24 * HOUR) }, open: false, why: "opens tomorrow" },
      { w: { enabled: true, closes_at: at(-HOUR) }, open: false, why: "closed an hour ago" },
      { w: { enabled: true, opens_at: at(-HOUR), closes_at: at(HOUR) }, open: true, why: "inside its window" },
      { w: { enabled: true }, open: true, why: "on, no dates" },
    ];
    let checked = 0;
    for (const step of steps) {
      await window(auth, a.id, step.w);
      expect((await card(auth, comp.id)).registration_open, step.why).toBe(step.open);
      expect((await listDivisionCardStats(auth, comp.id)).get(a.id)!.registration_open, `the page agrees: ${step.why}`).toBe(step.open);
      checked++;
    }
    expect(checked).toBe(steps.length);

    // ANY division: B open, A off.
    await window(auth, a.id, { enabled: false });
    await window(auth, b.id, { enabled: true });
    expect((await card(auth, comp.id)).registration_open, "the other division's window").toBe(true);
    // An archived division's window counts for nothing.
    await sql`update divisions set archived_at = now() where id = ${b.id}`;
    expect((await card(auth, comp.id)).registration_open, "archived").toBe(false);
  });

  it("in_play counts the matches on court now; a decided one leaves it and counts as played", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await competition(auth, "live");
    const d = await division(auth, comp.id, "A");
    const [f1, f2] = await league(auth, d.id);
    expect((await card(auth, comp.id)).in_play, "generated, nothing started").toBe(0);

    await sql`update fixtures set status = 'in_play' where id in ${sql([f1!, f2!])}`;
    expect((await card(auth, comp.id)).in_play).toBe(2);
    await sql`update fixtures set status = 'decided' where id = ${f1!}`;
    const s = await card(auth, comp.id);
    expect([s.in_play, s.played]).toEqual([1, 1]);
    // An archived division's match in play is not on this card.
    await sql`update divisions set archived_at = now() where id = ${d.id}`;
    expect((await card(auth, comp.id)).in_play, "archived").toBe(0);
  });

  it("divisions_active / divisions_completed follow each division's status; archived ones count for neither", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await competition(auth, "live");
    const a = await division(auth, comp.id, "A");
    const b = await division(auth, comp.id, "B");
    const c = await division(auth, comp.id, "C");
    await sql`update divisions set status = 'active' where id = ${a.id}`;
    await sql`update divisions set status = 'completed' where id = ${b.id}`;
    let s = await card(auth, comp.id);
    expect([s.divisions, s.divisions_active, s.divisions_completed]).toEqual([3, 1, 1]);
    // The second transition: A finishes too, and C (still in setup) is archived - every division left is completed.
    await sql`update divisions set status = 'completed' where id = ${a.id}`;
    await sql`update divisions set archived_at = now() where id = ${c.id}`;
    s = await card(auth, comp.id);
    expect([s.divisions, s.divisions_active, s.divisions_completed]).toEqual([2, 0, 2]);
  });

  it("the owner's competition, read and laddered for real: published, under way, no window - In progress", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await competition(auth, "published");
    const d = await division(auth, comp.id, "Open");
    const [f1] = await league(auth, d.id);
    await sql`update divisions set status = 'active' where id = ${d.id}`;
    await sql`update fixtures set status = 'decided' where id = ${f1!}`;
    const s = await card(auth, comp.id);
    expect(competitionChipState("published", signals(s))).toBe("in_progress");

    // Its positive pair: open the division's window and the same read now says Registration open; a match on court says Live.
    await window(auth, d.id, { enabled: true });
    expect(competitionChipState("published", signals(await card(auth, comp.id)))).toBe("registration");
    await sql`update fixtures set status = 'in_play' where id <> ${f1!} and division_id = ${d.id}`;
    expect(competitionChipState("published", signals(await card(auth, comp.id)))).toBe("live");
  });
});
