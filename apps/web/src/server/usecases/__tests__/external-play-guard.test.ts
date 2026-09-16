// apps/web/src/server/usecases/__tests__/external-play-guard.test.ts
//
// Task 7 — the ONE guard fronting every online-play entry point (spec §6),
// plus side/player loading, colour, and lazy stale-row reset (spec §7.2).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { seedOrg, seedFutureDivision } from "./_seed";
import { seedOnlineChessFixture } from "./_external-play-seed";
import {
  effectiveBridge,
  ensureBridgeRow,
  isStale,
  loadOnlinePlayFixture,
  loadSides,
  resetStaleBridge,
  whiteSideOf,
} from "../external-play/guard";
import { startDivision } from "../schedule";

const T = new Date("2026-10-01T12:10:00.000Z");

describe.skipIf(!process.env.DATABASE_URL)("loadOnlinePlayFixture (the online-play guard)", () => {
  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------
  // Each guard predicate below gets a test that fails when ONLY that SQL
  // line is removed (mutation checks recorded in the commit body).
  // ---------------------------------------------------------------------

  it("empty case: online play off ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "off",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("unstarted division ⇒ null (scoreEvent would refuse)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: false,
      scheduledAt: T,
      linked: true,
    });
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("finalized fixture ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await sql`update fixtures set status = 'finalized' where id = ${s.fixtureId}`;
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("non-boardgame sport with onlinePlay forced into config ⇒ null", async () => {
    // `assertOnlinePlayValue` (server/external-play/online-play.ts) refuses
    // 'lichess' for a non-boardgame sport through the normal create/patch
    // path — this can only happen via a raw config write, exactly what a
    // migration-era or hand-edited row could look like. A `clock` is forced
    // in alongside `onlinePlay` so every OTHER guard predicate (including the
    // post-query clock-mappable check) is satisfied too — otherwise the
    // clock-mappable guard would independently return null and this test
    // could not tell the `sport_key = 'boardgame'` predicate apart from it
    // (confirmed: without the `clock`, deleting the sport_key predicate does
    // not fail this test — a real survivor caught during mutation testing).
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedFutureDivision(auth);
    await sql`
      update divisions
         set config = config || '{"onlinePlay":"lichess","clock":{"base":900,"increment":0}}'::jsonb
       where id = ${division.id}`;
    await startDivision(auth, division.id);
    const [fixture] = fixtures;
    if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
    expect(await loadOnlinePlayFixture(fixture.id)).toBeNull();
  });

  it("missing scheduled_at ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await sql`update fixtures set scheduled_at = null where id = ${s.fixtureId}`;
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("missing home entrant ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await sql`update fixtures set home_entrant_id = null where id = ${s.fixtureId}`;
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("missing away entrant ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await sql`update fixtures set away_entrant_id = null where id = ${s.fixtureId}`;
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("clock not mappable (delay unsupported) ⇒ null", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      clock: { base: 900, increment: 0, delay: 5 },
    });
    expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
  });

  it("guarded fixture loads with clock in seconds and no bridge", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    expect(f).toMatchObject({
      fixtureId: s.fixtureId,
      orgId: s.orgId,
      homeEntrantId: s.home.entrantId,
      awayEntrantId: s.away.entrantId,
      clock: { limit: 900, increment: 0 },
      bridge: null,
    });
    if (!f) throw new Error("unreachable — toMatchObject above requires non-null");
    expect(f.scheduledAt.getTime()).toBe(T.getTime());
  });

  it(
    "effectiveBridge hides a row minted for an older scheduled_at; " +
      "resetStaleBridge clears it; live rows are never reset",
    async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });

      // Phase A: a 'pending' bridge minted for an OLDER scheduled_at (a
      // reschedule happened after the mint) is stale — hidden, then reset.
      const oldBasis = new Date(T.getTime() - 60 * 60_000);
      await sql`
        insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id)
        values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis}, ${`chal-old-${randomUUID()}`})`;

      const f1 = await loadOnlinePlayFixture(s.fixtureId);
      if (!f1 || !f1.bridge) throw new Error("guard/bridge unexpectedly missing after insert");
      expect(f1.bridge.scheduled_at_basis).toBeInstanceOf(Date); // jsonb string revived
      expect(f1.bridge.scheduled_at_basis.getTime()).toBe(oldBasis.getTime());
      expect(isStale(f1)).toBe(true);
      expect(effectiveBridge(f1)).toBeNull();

      await resetStaleBridge(f1);
      const f2 = await loadOnlinePlayFixture(s.fixtureId);
      if (!f2 || !f2.bridge) throw new Error("reset should not have deleted the row");
      expect(f2.bridge).toMatchObject({ status: "pending", challenge_id: null });
      expect(f2.bridge.scheduled_at_basis.getTime()).toBe(T.getTime());
      expect(effectiveBridge(f2)).not.toBeNull();

      // Phase B: a 'live' bridge with a mismatched basis is NOT stale — the
      // game already exists and a later reschedule cannot un-happen it.
      const olderBasis = new Date(T.getTime() - 2 * 60 * 60_000);
      await sql`
        update fixture_external_play
           set status = 'live', scheduled_at_basis = ${olderBasis}
         where fixture_id = ${s.fixtureId}`;
      const f3 = await loadOnlinePlayFixture(s.fixtureId);
      if (!f3 || !f3.bridge) throw new Error("live row unexpectedly missing");
      expect(f3.bridge.status).toBe("live");
      expect(isStale(f3)).toBe(false);
      expect(effectiveBridge(f3)).toBe(f3.bridge); // not hidden despite basis mismatch

      await resetStaleBridge(f3); // must be a no-op
      const f4 = await loadOnlinePlayFixture(s.fixtureId);
      if (!f4 || !f4.bridge) throw new Error("live row unexpectedly missing");
      expect(f4.bridge.status).toBe("live");
      expect(f4.bridge.scheduled_at_basis.getTime()).toBe(olderBasis.getTime()); // untouched
    },
  );

  it("resetStaleBridge does not clobber a bridge that raced to live after the read (status guard)", async () => {
    // f's own snapshot says 'pending' (stale) — but between the read and the
    // call, something else (a poll job) marked the row 'live'. The SQL's own
    // `status in (...)` clause must protect it even though `isStale(f)`,
    // computed from the STALE in-memory `f`, still says true.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const challengeId = `chal-race-${randomUUID()}`;
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis}, ${challengeId})`;

    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(isStale(f)).toBe(true); // f's own (stale) view

    // Race: the row moves to 'live' in the database after f was read.
    await sql`update fixture_external_play set status = 'live' where fixture_id = ${s.fixtureId}`;

    await resetStaleBridge(f); // uses the STALE f — must not clobber the now-live row

    const [row] = await sql<{ status: string; challenge_id: string | null }[]>`
      select status, challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
    if (!row) throw new Error("row vanished");
    expect(row.status).toBe("live");
    expect(row.challenge_id).toBe(challengeId); // untouched, not reset to null
  });

  it("ensureBridgeRow inserts a pending row once; a second call does not clobber an existing one", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(f.bridge).toBeNull();

    await ensureBridgeRow(f);
    const [row1] = await sql<{ status: string }[]>`
      select status from fixture_external_play where fixture_id = ${s.fixtureId}`;
    if (!row1) throw new Error("ensureBridgeRow did not insert a row");
    expect(row1.status).toBe("pending");

    await sql`update fixture_external_play set status = 'ready' where fixture_id = ${s.fixtureId}`;
    await ensureBridgeRow(f); // on conflict do nothing
    const [row2] = await sql<{ status: string }[]>`
      select status from fixture_external_play where fixture_id = ${s.fixtureId}`;
    if (!row2) throw new Error("row vanished");
    expect(row2.status).toBe("ready"); // not clobbered back to 'pending'
  });

  it("whiteSideOf: home by default with no pairing event recorded (Swiss's own default)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(await whiteSideOf(f)).toBe("home");
  });

  it("whiteSideOf: away when a pairing event made home Black", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    await appendEvent(s.orgId, s.fixtureId, 0, {
      type: "boardgame.pairing",
      payload: { white: s.away.entrantId },
    });
    expect(await whiteSideOf(f)).toBe("away");
  });

  it("loadSides resolves person/user/lichess identity and recipients for both sides", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    const { home, away } = await loadSides(f);

    expect(home).toMatchObject({
      side: "home",
      entrantId: s.home.entrantId,
      displayName: "White",
      personId: s.home.personId,
      userId: s.home.userId,
      lichess: { id: s.home.lichessId, username: s.home.lichessId },
    });
    expect(home.recipients).toHaveLength(1);
    expect(home.recipients[0].email).toContain(s.home.lichessId);

    expect(away).toMatchObject({
      side: "away",
      entrantId: s.away.entrantId,
      displayName: "Black",
      personId: s.away.personId,
      userId: s.away.userId,
      lichess: { id: s.away.lichessId, username: s.away.lichessId },
    });
  });

  it("loadSides: personId/userId still resolve but lichess is null when nobody is Lichess-linked", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: false,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    const { home } = await loadSides(f);
    expect(home.personId).toBe(s.home.personId);
    expect(home.userId).toBe(s.home.userId);
    expect(home.lichess).toBeNull();
  });

  it("loadSides: a member whose person is a merge tombstone resolves no identity, only displayName", async () => {
    // `merged_into` (V349) marks a person absorbed into another, live person.
    // `loadSide`'s join excludes tombstoned persons (`p.merged_into is null`)
    // — the row still carries the entrant's own `display_name`, but no
    // person/user/lichess identity should resolve through the dead person.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");

    await sql`update persons set merged_into = ${s.away.personId} where id = ${s.home.personId}`;

    const { home } = await loadSides(f);
    expect(home.displayName).toBe("White");
    expect(home.personId).toBeNull();
    expect(home.userId).toBeNull();
    expect(home.lichess).toBeNull();
  });

  it("resetStaleBridge also clears started_at/finished_at (a reschedule is a new game)", async () => {
    // Ruling R15 (review fix round 1): a bridge can reach
    // needs_organiser/aborted AFTER the game went live (started_at stamped,
    // possibly finished_at too). If that fixture is then rescheduled, the
    // reset must treat it as a brand-new game — clearing started_at and
    // finished_at, not just status/needs_reason.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const startedAt = new Date(oldBasis.getTime() + 5 * 60_000);
    const finishedAt = new Date(oldBasis.getTime() + 25 * 60_000);
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, needs_reason, started_at, finished_at)
      values
        (${s.fixtureId}, ${s.orgId}, 'needs_organiser', ${oldBasis}, 'aborted', ${startedAt}, ${finishedAt})`;

    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(isStale(f)).toBe(true);

    await resetStaleBridge(f);

    const [row] = await sql<
      { status: string; needs_reason: string | null; started_at: Date | null; finished_at: Date | null }[]
    >`
      select status, needs_reason, started_at, finished_at
        from fixture_external_play where fixture_id = ${s.fixtureId}`;
    if (!row) throw new Error("row vanished");
    expect(row.status).toBe("pending");
    expect(row.needs_reason).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.finished_at).toBeNull();
  });
});
