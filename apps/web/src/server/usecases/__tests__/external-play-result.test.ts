// Write the result (chess in-page board design §3.6, Task 12). A finished
// Lichess game becomes OUR fixture's result, written under organiser
// authority. Every expected value below comes from the spec's §3.6 table, the
// controller's addenda, Lichess's own source (lila / scalachess, pinned where
// cited) or the engine's declarations — never from result.ts or map-result.ts.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`), so the one other-sport case below is
// the guard's refusal, not a second write path.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.runIf(HAS_DB)("fixture_external_play.needs_reason accepts this task's reasons", () => {
  const REASONS = ["token_revoked", "provider_error", "double_walkover_blocked", "tiebreak_owed"] as const;

  it("accepts every reason this task writes, and refuses a free-text one", async () => {
    const { seedOnlineChessFixture } = await import("./_external-play-seed");
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(Date.now() - 60_000),
      linked: true,
    });
    let checked = 0;
    for (const reason of REASONS) {
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, needs_reason)
        values (${s.fixtureId}, ${s.orgId}, now(), 'needs_organiser', ${reason})
        on conflict (fixture_id) do update set status = 'needs_organiser', needs_reason = ${reason}`;
      const [row] = await sql<{ needs_reason: string }[]>`
        select needs_reason from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row!.needs_reason, reason).toBe(reason);
      checked++;
    }
    expect(checked, "reasons checked").toBe(REASONS.length);

    await expect(sql`
      update fixture_external_play set needs_reason = 'the dog ate it'
       where fixture_id = ${s.fixtureId}`).rejects.toMatchObject({
      code: "23514",
      constraint_name: "fixture_external_play_needs_reason_check",
    });
  });
});
