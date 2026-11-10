// W4 app B, B5b review I-2 (+ m-8): the public match page POLLS `/api/v1/public/fixtures/{id}` (`publicFixture`) and replaces
// the page's document wholesale with the answer. The poll's row did not select `is_final` / `third_place` /
// `joint_winners_at`, so its `match_centre` had no "Joint winners" line: the wording the page was served with vanished on
// the first settled poll, and a page already open never gained it. Real Postgres, through the usecase the route returns.
//
// Sequence, not only the feature: before the ruling (no line), declared (the line + the ruling's instant), after the Undo
// (gone again), and a semi-final of the same bracket (never a joint line).
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { playBadminton, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { publicFixture, publicSchedule } from "../public";
import { declareJointWinners, undoJointWinners } from "../joint-winners";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Poll {
  is_final?: boolean;
  third_place?: boolean;
  joint_winners_at?: string | null;
  status: string;
  match_centre: { header: { statusLine: { key: string } | null } };
}

describe.skipIf(!HAS_DB)("B5b review I-2: the public match page's poll carries a joint final", () => {
  it("no line before the ruling, 'Joint winners' + the instant while declared, gone after the Undo; a semi-final never has it", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    // The seeded competition is private; the public view serves only a public, live one.
    await sql`update competitions set visibility = 'public', status = 'live' where id = ${s.competitionId}`;
    const rows = await rowsOf(s.stageId);
    const semis = rows.filter((r) => r.home_entrant_id && r.away_entrant_id);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const [final] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and is_final and not third_place`;
    const poll = async (id: string) => (await publicFixture(id)) as Poll;

    const before = await poll(final!.id);
    expect(before.is_final, "the poll says it is the final").toBe(true);
    expect(before.joint_winners_at).toBeNull();
    expect(before.match_centre.header.statusLine).toBeNull();

    await declareJointWinners(s.auth, final!.id);
    const [db] = await sql<{ at: Date }[]>`select joint_winners_at as at from fixtures where id = ${final!.id}`;
    const during = await poll(final!.id);
    expect(during.status).toBe("decided");
    expect(during.joint_winners_at, "the ruling's instant, as ISO").toBe(db!.at.toISOString());
    expect(during.match_centre.header.statusLine).toEqual({ key: "title.joint" });

    // A semi-final of the same bracket carries the facts but never the line.
    const semi = await poll(semis[0]!.id);
    expect(semi.is_final).toBe(false);
    expect(semi.joint_winners_at).toBeNull();
    expect(semi.match_centre.header.statusLine?.key ?? null).not.toBe("title.joint");

    // m-8: the public API v1 schedule says why a decided final has no outcome.
    const [slugs] = await sql<{ o: string; c: string; d: string }[]>`
      select o.slug as o, c.slug as c, d.slug as d from divisions d
      join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${s.divisionId}`;
    const sched = async () =>
      ((await publicSchedule(slugs!.o, slugs!.c, slugs!.d)) as { fixtures: { id: string; joint_winners_at: string | null }[] }).fixtures;
    const row = (await sched()).find((f) => f.id === final!.id)!;
    expect(row.joint_winners_at, "the schedule row carries the ruling's instant").toBe(db!.at.toISOString());
    const others = (await sched()).filter((f) => f.id !== final!.id);
    expect(others.length, "anti-vacuity: other rows checked").toBeGreaterThan(0);
    for (const f of others) expect(f.joint_winners_at).toBeNull();

    await undoJointWinners(s.auth, final!.id);
    const after = await poll(final!.id);
    expect(after.joint_winners_at).toBeNull();
    expect(after.match_centre.header.statusLine).toBeNull();
  });
});
