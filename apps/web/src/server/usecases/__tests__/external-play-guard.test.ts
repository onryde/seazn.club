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

  it("missing scheduled_at ⇒ SERVED, with scheduledAt null (ruling 2026-10-10: D12 anchors on the open)", async () => {
    // Was "⇒ null" until the controller ruled that an unscheduled online
    // Swiss board is playable; its bridge basis is the round's opened_at.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await sql`update fixtures set scheduled_at = null where id = ${s.fixtureId}`;
    const f = await loadOnlinePlayFixture(s.fixtureId);
    expect(f).not.toBeNull();
    expect(f!.scheduledAt).toBeNull();
  });

  it("a NULL start time is never a reschedule: a pending, challenge-less row on ANY basis is not stale and not reset", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const basis = new Date(T.getTime() - 60 * 60_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${basis})`;
    await sql`update fixtures set scheduled_at = null where id = ${s.fixtureId}`;
    const f = (await loadOnlinePlayFixture(s.fixtureId))!;
    expect(f.bridge).not.toBeNull();
    expect(isStale(f)).toBe(false);
    expect(effectiveBridge(f)).toBe(f.bridge);
    await resetStaleBridge(f); // a no-op
    const again = (await loadOnlinePlayFixture(s.fixtureId))!;
    expect(again.bridge!.scheduled_at_basis.getTime()).toBe(basis.getTime());
    // positive pair: the moment the board gets a real time that differs from
    // the basis, the same row IS stale.
    await sql`update fixtures set scheduled_at = ${T} where id = ${s.fixtureId}`;
    expect(isStale((await loadOnlinePlayFixture(s.fixtureId))!)).toBe(true);
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
    });
    // PRE-GATE LEGACY DATA. Since T6 the division save path refuses a delay
    // clock on an online division (INVALID_TIME_CONTROL at setup), so the
    // product can no longer CREATE this row — it is written by SQL to model a
    // division saved before that gate existed. The guard must still refuse it.
    await sql`
      update divisions
         set config = jsonb_set(config, '{clock}', '{"base":900,"increment":0,"delay":5}'::jsonb)
       where id = ${s.divisionId}`;
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
      clock: { limit: 900, increment: 10 },
      bridge: null,
    });
    if (!f) throw new Error("unreachable — toMatchObject above requires non-null");
    expect(f.scheduledAt?.getTime()).toBe(T.getTime());
  });

  it(
    "effectiveBridge hides a challenge-less pending row minted for an older scheduled_at; " +
      "resetStaleBridge rebases it; live rows are never reset",
    async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });

      // Phase A: a 'pending' bridge with NO challenge, minted for an OLDER
      // scheduled_at (a reschedule happened after the mint) is stale —
      // hidden, then reset. (A row carrying a challenge is never stale:
      // fix round 1 ruling, swept below.)
      const oldBasis = new Date(T.getTime() - 60 * 60_000);
      await sql`
        insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
        values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis})`;

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

  it("resetStaleBridge does not clobber a bridge that raced to a CREATED game after the read (SQL guard)", async () => {
    // f's own snapshot says 'pending', no challenge (stale) — but between the
    // read and the call, T9 created the game and recorded it. The SQL's own
    // guard must protect the row even though `isStale(f)`, computed from the
    // stale in-memory `f`, still says true.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const challengeId = `chal-race-${randomUUID()}`;
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis})`;

    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(isStale(f)).toBe(true); // f's own (stale) view

    let checked = 0;
    for (const raced of ["pending", "ready"] as const) {
      // Race: a challenge is recorded in the database after f was read — on
      // a row still 'pending' (a legacy mint) and on a 'ready' one (T9).
      await sql`
        update fixture_external_play set status = ${raced}, challenge_id = ${challengeId}
         where fixture_id = ${s.fixtureId}`;
      await resetStaleBridge(f); // uses the STALE f — must not clobber the recorded game
      const [row] = await sql<{ status: string; challenge_id: string | null; scheduled_at_basis: Date }[]>`
        select status, challenge_id, scheduled_at_basis from fixture_external_play where fixture_id = ${s.fixtureId}`;
      if (!row) throw new Error("row vanished");
      expect(row.status, raced).toBe(raced);
      expect(row.challenge_id, raced).toBe(challengeId); // untouched, not reset to null
      expect(row.scheduled_at_basis.getTime(), raced).toBe(oldBasis.getTime());
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("resetStaleBridge does not clobber a row HELD with no challenge after the read (SQL guard: status, not only challenge_id)", async () => {
    // f read the row as stale 'pending'; before the reset, the creation queue
    // held it — an unknown create outcome records no challenge. The hold's
    // reason, its operator text and its sent marker are what an organiser
    // acts on, so the reset's own SQL must refuse every status but 'pending'.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const sentAt = new Date(T.getTime() - 61 * 60_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis})`;
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(isStale(f)).toBe(true); // f's own (stale) view

    let checked = 0;
    for (const raced of ["needs_organiser", "ready"] as const) {
      await sql`
        update fixture_external_play
           set status = ${raced}, challenge_id = null,
               needs_reason = ${raced === "needs_organiser" ? "create_outcome_unknown" : null},
               last_error = 'create:timeout: held', create_sent_at = ${sentAt},
               scheduled_at_basis = ${oldBasis}
         where fixture_id = ${s.fixtureId}`;
      await resetStaleBridge(f);
      const [row] = await sql<{ status: string; last_error: string | null; create_sent_at: Date | null; scheduled_at_basis: Date }[]>`
        select status, last_error, create_sent_at, scheduled_at_basis from fixture_external_play where fixture_id = ${s.fixtureId}`;
      if (!row) throw new Error("row vanished");
      expect(row.status, raced).toBe(raced);
      expect(row.last_error, `${raced}: the hold's operator text survives`).toBe("create:timeout: held");
      expect(row.create_sent_at?.getTime(), `${raced}: the sent marker survives`).toBe(sentAt.getTime());
      expect(row.scheduled_at_basis.getTime(), `${raced}: not rebased`).toBe(oldBasis.getTime());
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("resetStaleBridge leaves an in-flight claim alone (a reschedule cannot hand the create to a second claimant)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const claim = new Date(T.getTime() - 5_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, mint_claimed_at)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis}, ${claim})`;
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    expect(isStale(f)).toBe(true);
    await resetStaleBridge(f);
    const [row] = await sql<{ mint_claimed_at: Date | null; scheduled_at_basis: Date }[]>`
      select mint_claimed_at, scheduled_at_basis from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(row?.scheduled_at_basis.getTime(), "rebased").toBe(T.getTime());
    expect(row?.mint_claimed_at?.getTime(), "the claimant still holds its claim").toBe(claim.getTime());
  });

  it("sweep: ONLY a pending row with no challenge is stale; every other status × challenge is never hidden or reset", async () => {
    // Fix round 1 ruling (2026-10-10): a row that carries a challenge_id is
    // NEVER stale, whatever its status, and only a pending row with no
    // challenge may be reset by a reschedule. Supersedes R15, which reset a
    // needs_organiser row after a reschedule: T16's void/resolve owns that.
    // Expected value from the ruling, never from isStale.
    const statuses = ["pending", "ready", "live", "finished", "needs_organiser"] as const;
    let checked = 0;
    for (const status of statuses) {
      for (const withChallenge of [false, true]) {
        const s = await seedOnlineChessFixture({
          onlinePlay: "lichess",
          divisionStarted: true,
          scheduledAt: T,
          linked: true,
        });
        const oldBasis = new Date(T.getTime() - 60 * 60_000);
        const challengeId = withChallenge ? `chal-sweep-${randomUUID()}` : null;
        const startedAt = status === "needs_organiser" ? new Date(oldBasis.getTime() + 5 * 60_000) : null;
        await sql`
          insert into fixture_external_play
            (fixture_id, org_id, status, scheduled_at_basis, challenge_id, needs_reason, started_at)
          values (${s.fixtureId}, ${s.orgId}, ${status}, ${oldBasis}, ${challengeId},
                  ${status === "needs_organiser" ? "aborted" : null}, ${startedAt})`;
        const f = await loadOnlinePlayFixture(s.fixtureId);
        if (!f) throw new Error("guard refused a fixture the seed built to pass it");
        const label = `${status}${withChallenge ? "+challenge" : ""}`;
        const resettable = status === "pending" && !withChallenge;
        expect(isStale(f), label).toBe(resettable);
        expect(effectiveBridge(f) === null, label).toBe(resettable);
        await resetStaleBridge(f);
        const [row] = await sql<{
          status: string; challenge_id: string | null; scheduled_at_basis: Date; started_at: Date | null;
        }[]>`
          select status, challenge_id, scheduled_at_basis, started_at
            from fixture_external_play where fixture_id = ${s.fixtureId}`;
        if (!row) throw new Error("row vanished");
        expect(row.status, label).toBe(status);
        expect(row.challenge_id, label).toBe(challengeId);
        expect(row.started_at?.getTime() ?? null, label).toBe(startedAt?.getTime() ?? null);
        expect(row.scheduled_at_basis.getTime(), label).toBe(resettable ? T.getTime() : oldBasis.getTime());
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 5 statuses × with/without a challenge").toBe(10);
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

  it("loadSides renders the person's name for a singles chess entrant, never 'Entry N' or a uuid (F5)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      homeFullName: "Ada Okonkwo",
      awayFullName: "Bo Lind",
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    expect(f, "fixture loads").not.toBeNull();
    const { home, away } = await loadSides(f!);
    expect([home.displayName, away.displayName]).toEqual(["Ada Okonkwo", "Bo Lind"]);
    expect(home.members.map((m) => m.full_name)).toEqual(["Ada Okonkwo"]);
    expect([home.snapshotName, away.snapshotName], "the snapshot really differed").toEqual(["Entry 1", "Entry 2"]);
    expect(home.kind).toBe("individual");
    let checked = 0;
    for (const side of [home, away]) {
      expect(side.displayName, "never a bare entrant id").not.toMatch(/^[0-9a-f-]{36}$/i);
      checked += 1;
    }
    expect(checked, "anti-vacuity: sides checked").toBe(2);
  });

  it("loadSides: a member whose person is a merge tombstone falls back to the SNAPSHOT, never the dead person's name (F5)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      homeFullName: "Ada Okonkwo",
      awayFullName: "Bo Lind",
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("guard refused a fixture the seed built to pass it");
    await sql`update persons set merged_into = ${s.away.personId} where id = ${s.home.personId}`;
    const { home } = await loadSides(f);
    expect(home.members).toEqual([]);
    expect(home.displayName).toBe("Entry 1");
  });
});
