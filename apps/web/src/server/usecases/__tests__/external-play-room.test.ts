// apps/web/src/server/usecases/__tests__/external-play-room.test.ts
//
// Task 8 — the match room usecase (spec §5 steps 6-7, §8.2, §12.1): identity
// resolution (session or signed link), a write-free GET, check-in inside the
// T-10..T+20 window, and minting exactly one open challenge outside any
// transaction behind a short row claim.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { roomPhase, windowFor } from "@/server/external-play/window";
import type { ExternalPlayAdapter } from "@/server/external-play/types";
import { mintMatchRoomToken } from "../match-room-token";
import { stampFixtureCheckIn } from "../me";
import { loadOnlinePlayFixture } from "../external-play/guard";
import {
  checkInToMatchRoom,
  mintIfReady,
  readMatchRoom,
  resolveRoomPlayer,
  type RoomDeps,
} from "../external-play/room";
import { makeUser } from "./_seed";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

// `stampFixtureCheckIn` always stamps `checked_in_at` with the DB's own
// `now()` (real wall clock) — `checkInCounts` then judges THAT stamp against
// the fixture's window (window.ts's own doc comment: "a check-in counts only
// inside the fixture's CURRENT window"). Unlike external-play-guard.test.ts
// (which never stamps a check-in), T here MUST be anchored to the real
// clock — a fixed future literal like guard.test.ts's own T would put every
// real check-in stamp hours/days "before" the window and every
// checkInCounts read would silently read false. `now` (the room's own
// SIMULATED time, passed as deps.now for the phase gate) is kept close to
// the real check-in stamps above so both independently land "open".
const T = new Date(Date.now() + 5 * 60_000);
const now = new Date();
// D12 (T9): the room's window hangs off the organiser's OPEN stamp, not the
// timetable. Every pre-existing case below opens its round AT T, so the
// window each was written against (T-10..T+20) is unchanged; the D12 cases
// at the bottom are the ones where the two anchors differ.

// `fixture_external_play.challenge_id` has a GLOBAL unique index (V405) —
// not scoped per fixture, and this test DB is not reset between vitest
// invocations — so every test that actually completes a mint needs its OWN
// distinct, never-reused id; a hardcoded literal shared across two
// "actually mints" tests (or reused across two separate `vitest run`
// invocations of this file) collides with "duplicate key value violates
// unique constraint fixture_external_play_challenge_idx" (found via a live
// run of this suite, not asserted from reading the migration alone). Every
// call gets a fresh id; tests read the actual id off the returned `id`
// field instead of hardcoding the URL.
function fakeAdapter(id: string = `ch-${randomUUID()}`): ExternalPlayAdapter & {
  id: string;
  createOpenChallenge: ReturnType<typeof vi.fn>;
  fetchGame: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    createOpenChallenge: vi.fn(async () => ({
      challengeId: id,
      urlWhite: `https://l/${id}?color=white`,
      urlBlack: `https://l/${id}?color=black`,
    })),
    fetchGame: vi.fn(async () => null),
  };
}

function deps(overrides: Partial<RoomDeps> = {}): RoomDeps {
  return { now, adapter: fakeAdapter(), publish: vi.fn(async () => {}), ...overrides };
}

async function tokenFor(s: SeedOnlineChessFixtureResult, personId: string, scheduledAt: Date) {
  return mintMatchRoomToken({
    fixtureId: s.fixtureId,
    personId,
    scheduledAt: scheduledAt.toISOString(),
  });
}

type Snapshot = { bridge: unknown[]; availability: unknown[] };

async function snapshotRows(fixtureId: string): Promise<Snapshot> {
  const bridge = await sql`select * from fixture_external_play where fixture_id = ${fixtureId}`;
  const availability = await sql`
    select * from fixture_availability where fixture_id = ${fixtureId} order by person_id`;
  return { bridge, availability };
}

// Top level, not inside the first describe: the D12 block below runs after
// it, and an end() scoped to the first block would close the pool under it.
afterAll(async () => {
  await sql.end();
});

describe.skipIf(!process.env.DATABASE_URL)("match room usecase", () => {

  // -------------------------------------------------------------------
  // Identity resolution (spec §12.1) — every failure collapses to the same
  // 404 NOT_FOUND so a probe can't learn whether the fixture exists.
  // -------------------------------------------------------------------

  it("session identity: the fixture's own home/away user reads the room", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const player = await resolveRoomPlayer({ kind: "session", userId: s.home.userId }, f);
    expect(player?.side).toBe("home");
  });

  it("non-player session ⇒ 404 NOT_FOUND", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const stranger = await makeUser("stranger");
    await expect(
      readMatchRoom({ kind: "session", userId: stranger.id }, s.fixtureId, now),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("token minted for a DIFFERENT fixture ⇒ 404 (mutant killer: fixtureId comparison)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const other = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    // Isolate the fixtureId comparison specifically: the personId and
    // scheduledAt claims are s's OWN valid ones (would otherwise pass every
    // other check) — only the fixtureId claim points at `other`. A first
    // draft of this test used other's own personId too, which is ALSO
    // refused by the personId comparison even with the fixtureId check
    // deleted — a survivor confirmed by mutation testing (two guards
    // covering for each other; AGENTS.md recurring-failure class 3).
    const token = await tokenFor(other, s.home.personId, T);
    await expect(readMatchRoom({ kind: "token", token }, s.fixtureId, now)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("token with a stale scheduledAt (fixture rescheduled after mint) ⇒ 404 (mutant killer: sat comparison)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    // Minted for the CORRECT fixture/person, but the scheduledAt on the link
    // no longer matches — a reschedule invalidates the old link.
    const staleSat = new Date(T.getTime() - 60 * 60_000);
    const token = await tokenFor(s, s.home.personId, staleSat);
    await expect(readMatchRoom({ kind: "token", token }, s.fixtureId, now)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("token whose personId is a REAL person on a DIFFERENT fixture ⇒ 404", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const other = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    // Correct fixtureId and correct (matching) scheduledAt for s, but the
    // personId belongs to a real person who is not on THIS fixture's roster.
    const token = await tokenFor(s, other.home.personId, T);
    await expect(readMatchRoom({ kind: "token", token }, s.fixtureId, now)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("expired token ⇒ 404 NOT_FOUND (documented choice: resolveRoomPlayer collapses EVERY verifyMatchRoomToken rejection — bad signature, expired, or this room's own fixtureId/sat/personId mismatches — into the same identity-hiding 404, never a distinct 401)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    // mintMatchRoomToken pins exp = scheduledAt + 24h; a scheduledAt far in
    // the real past mints a token that is already expired against the REAL
    // wall clock jose checks against (independent of this suite's fake
    // fixture-window `now`) — proving verifyMatchRoomToken's OWN 401 throw
    // (not just this file's post-verification comparisons) is swallowed by
    // resolveRoomPlayer's `.catch(() => null)`.
    const longAgo = new Date("2000-01-01T00:00:00.000Z");
    const token = await tokenFor(s, s.home.personId, longAgo);
    await expect(readMatchRoom({ kind: "token", token }, s.fixtureId, now)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  // -------------------------------------------------------------------
  // GET never writes (spec §12.1)
  // -------------------------------------------------------------------

  it("GET never writes: reading a room with a STALE bridge twice leaves fixture_external_play and fixture_availability untouched (mutant killer: readMatchRoom must never call resetStaleBridge)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    // A bridge minted for an OLDER scheduled_at (stale — effectiveBridge
    // hides it, but only resetStaleBridge, a write, would clear it).
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis}, ${`chal-stale-${randomUUID()}`})`;
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);

    const before = await snapshotRows(s.fixtureId);
    await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
    await readMatchRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, now);
    expect(await snapshotRows(s.fixtureId)).toEqual(before);
  });

  // -------------------------------------------------------------------
  // Check-in window (spec §8.1/§8.2)
  // -------------------------------------------------------------------

  it("before T-10: check-in refused 409 CHECK_IN_CLOSED, nothing stamped (mutant killer: phase check in checkInToMatchRoom)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const early = new Date(T.getTime() - 11 * 60_000);
    await expect(
      checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: early })),
    ).rejects.toMatchObject({ status: 409, code: "CHECK_IN_CLOSED" });
    const [row] = await sql`select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId}`;
    expect(row).toBeUndefined();
  });

  it("check-in after T+20 refused even with a valid token", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const token = await tokenFor(s, s.home.personId, T);
    const afterDeadline = new Date(T.getTime() + 20 * 60_000);
    await expect(
      checkInToMatchRoom({ kind: "token", token }, s.fixtureId, deps({ now: afterDeadline })),
    ).rejects.toMatchObject({ status: 409, code: "CHECK_IN_CLOSED" });
  });

  it("first check-in stamps fixture_availability, publishes, does not mint", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const d = deps();
    const v = await checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(v.you.checkedIn).toBe(true);
    expect(v.opponent.checkedIn).toBe(false);
    expect(d.adapter?.createOpenChallenge).not.toHaveBeenCalled();
    expect(d.publish).toHaveBeenCalledWith(s.fixtureId);
    expect(v.canMint).toBe(false);
  });

  it("second check-in mints ONE open challenge White-first with expiresAt = deadline, and each player sees only their own colour", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const adapter = fakeAdapter();
    const d = deps({ adapter });
    await checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    const v = await checkInToMatchRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, d);

    expect(d.adapter?.createOpenChallenge).toHaveBeenCalledTimes(1);
    expect(d.adapter?.createOpenChallenge).toHaveBeenCalledWith({
      whiteUsername: s.home.lichessId,
      blackUsername: s.away.lichessId,
      clock: { limit: 900, increment: 10 },
      expiresAt: windowFor(T).deadline,
    });
    // V434 dropped the per-colour lichess.org links (D3); colour is what is left.
    expect(v.you.colour).toBe("black"); // away is Black by default
    const homeView = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
    expect(homeView.you.colour).toBe("white");
    expect(homeView.watchUrl).toBeNull(); // not live/finished yet
    expect(homeView.status).toBe("ready");
  });

  it("token identity checks in with no session", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    const token = await tokenFor(s, s.away.personId, T);
    const d = deps();
    const v = await checkInToMatchRoom({ kind: "token", token }, s.fixtureId, d);
    expect(v.you.side).toBe("away");
    expect(v.you.checkedIn).toBe(true);
  });

  // -------------------------------------------------------------------
  // Minting (spec §8.2)
  // -------------------------------------------------------------------

  it("unlinked player: both checked in ⇒ mintIfReady not_ready, canMint false", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: false,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const d = deps();
    expect(await mintIfReady(f, d)).toBe("not_ready");
    expect(d.adapter?.createOpenChallenge).not.toHaveBeenCalled();
    const view = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
    expect(view.canMint).toBe(false);
  });

  it("concurrent mint keeps one challenge", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const raceId = `ch-race-${randomUUID()}`;
    const adapter: ExternalPlayAdapter = {
      createOpenChallenge: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          challengeId: raceId,
          urlWhite: `https://l/${raceId}?color=white`,
          urlBlack: `https://l/${raceId}?color=black`,
        };
      }),
      fetchGame: vi.fn(async () => null),
    };
    const publish = vi.fn(async () => {});
    const results = await Promise.all([
      mintIfReady(f, { now, adapter, publish }),
      mintIfReady(f, { now, adapter, publish }),
      mintIfReady(f, { now, adapter, publish }),
    ]);
    expect(results.filter((r) => r === "minted")).toHaveLength(1);
    expect(adapter.createOpenChallenge).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ challenge_id: string | null }[]>`
      select challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(row?.challenge_id).toBe(raceId);
  });

  it("adapter failure: stays pending, last_error set, claim released, canMint true for retry", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const adapter: ExternalPlayAdapter = {
      createOpenChallenge: vi.fn(async () => {
        throw new Error("lichess is down");
      }),
      fetchGame: vi.fn(async () => null),
    };
    const result = await mintIfReady(f, { now, adapter, publish: vi.fn(async () => {}) });
    expect(result).toBe("failed");
    const [row] = await sql<{ status: string; last_error: string | null; mint_claimed_at: Date | null }[]>`
      select status, last_error, mint_claimed_at from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(row?.status).toBe("pending");
    expect(row?.last_error).toContain("lichess is down");
    expect(row?.mint_claimed_at).toBeNull();

    const view = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
    expect(view.canMint).toBe(true);
  });

  it("live never re-mints (a bridge already past pending is never a Lichess round trip)", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id)
      values (${s.fixtureId}, ${s.orgId}, 'live', ${T}, ${`chal-live-${randomUUID()}`})`;
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const d = deps();
    expect(await mintIfReady(f, d)).toBe("not_ready");
    expect(d.adapter?.createOpenChallenge).not.toHaveBeenCalled();
  });

  it("colour follows whiteSideOf: after a pairing flip, home gets the Black link and the away Lichess username mints White", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      roundOpenedAt: T,
      linked: true,
    });
    await appendEvent(s.orgId, s.fixtureId, 0, {
      type: "boardgame.pairing",
      payload: { white: s.away.entrantId },
    });
    const adapter = fakeAdapter();
    const d = deps({ adapter });
    await checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    await checkInToMatchRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, d);

    expect(d.adapter?.createOpenChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ whiteUsername: s.away.lichessId, blackUsername: s.home.lichessId }),
    );
    const homeView = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
    expect(homeView.you.colour).toBe("black");
    const awayView = await readMatchRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, now);
    expect(awayView.you.colour).toBe("white");
  });

  // -------------------------------------------------------------------
  // Claim / takeover safety (spec §8.2 — belt and suspenders on top of the
  // concurrency test above, which is decided by the mint_claimed_at
  // freshness check alone; these two isolate the OTHER predicates.)
  // -------------------------------------------------------------------

  it(
    "the claim's own status='pending' check protects a row that moved past pending behind a caller's stale in-memory snapshot " +
      "(mutant killer: drop `and status = 'pending'` from the claim query)",
    async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
      roundOpenedAt: T,
        linked: true,
      });
      await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
      await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
      // f is read BEFORE any bridge row exists (f.bridge === null) — this
      // caller's in-memory snapshot never learns what happens next.
      const f = await loadOnlinePlayFixture(s.fixtureId);
      if (!f) throw new Error("seed did not pass the guard");

      // Race: a bridge row reaches needs_organiser (a real, challenge_id-less
      // status — spec §9's no_show_both, reached without ever minting)
      // behind f's back.
      await sql`
        insert into fixture_external_play
          (fixture_id, org_id, status, scheduled_at_basis, needs_reason, challenge_id, mint_claimed_at)
        values (${s.fixtureId}, ${s.orgId}, 'needs_organiser', ${T}, 'no_show_both', null, null)`;

      const d = deps();
      const result = await mintIfReady(f, d);
      expect(result).toBe("busy");
      expect(d.adapter?.createOpenChallenge).not.toHaveBeenCalled();
      const [row] = await sql<{ status: string; challenge_id: string | null }[]>`
        select status, challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.status).toBe("needs_organiser"); // untouched — never claimed, never minted into
      expect(row?.challenge_id).toBeNull();
    },
  );

  it(
    "the ready update's own mint_claimed_at check refuses a stale-claim takeover mid-flight: returns busy, does not publish, does not overwrite the new claimant " +
      "(mutant killer: remove the conditional on the ready update)",
    async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
      roundOpenedAt: T,
        linked: true,
      });
      await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
      await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
      const f = await loadOnlinePlayFixture(s.fixtureId);
      if (!f) throw new Error("seed did not pass the guard");

      const takeoverAt = new Date(now.getTime() + 1000);
      const adapter: ExternalPlayAdapter = {
        createOpenChallenge: vi.fn(async () => {
          // Simulate a second minter's claim taking over the row (status
          // stays 'pending' — only mint_claimed_at moves) WHILE this call's
          // own HTTP round trip is in flight.
          await sql`
            update fixture_external_play
               set mint_claimed_at = ${takeoverAt}
             where fixture_id = ${s.fixtureId} and status = 'pending'`;
          return { challengeId: "ch-a", urlWhite: "https://l/ch-a?color=white", urlBlack: "https://l/ch-a?color=black" };
        }),
        fetchGame: vi.fn(async () => null),
      };
      const publish = vi.fn(async () => {});
      const result = await mintIfReady(f, { now, adapter, publish });
      expect(result).toBe("busy");
      expect(publish).not.toHaveBeenCalled();
      const [row] = await sql<{ status: string; challenge_id: string | null; mint_claimed_at: Date | null }[]>`
        select status, challenge_id, mint_claimed_at from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.status).toBe("pending");
      expect(row?.challenge_id).toBeNull(); // this call's challenge (ch-a) was NOT stored
      expect(row?.mint_claimed_at?.getTime()).toBe(takeoverAt.getTime()); // the new claimant's stamp survives
    },
  );
});

describe.skipIf(!process.env.DATABASE_URL)("D12 — the room anchors on the open stamp", () => {
  it("a paired-but-unopened round reads phase 'before', whatever the timetable says", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: true,
    });
    // Five minutes AFTER the scheduled time: schedule-anchored, this is
    // "open"; stamp-anchored, the round has not started.
    const view = await readMatchRoom(
      { kind: "session", userId: s.home.userId },
      s.fixtureId,
      new Date("2026-10-01T12:15:00.000Z"),
    );
    expect(view.phase).toBe("before");
    expect(view.canMint, "nothing to mint for a round nobody opened").toBe(false);
    // The scheduled time is what the player is SHOWN until the open.
    const scheduled = windowFor(new Date("2026-10-01T12:10:00.000Z"));
    expect(view.opensAt).toBe(scheduled.opensAt.toISOString());
    expect(view.deadline).toBe(scheduled.deadline.toISOString());
  });

  it("an opened round reads 'open' from the stamp, and its deadline is stamp + 20m", async () => {
    const opened = new Date("2026-10-01T12:00:00.000Z");
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: true,
      roundOpenedAt: opened,
    });
    const view = await readMatchRoom(
      { kind: "session", userId: s.home.userId },
      s.fixtureId,
      new Date("2026-10-01T12:05:00.000Z"),
    );
    expect(view.phase).toBe("open");
    // Derived from the window constants, never typed in, so moving
    // DEADLINE_AFTER_MS moves this test with it.
    expect(view.deadline).toBe(windowFor(opened).deadline.toISOString());
    expect(view.opensAt).toBe(windowFor(opened).opensAt.toISOString());
    expect(windowFor(opened).deadline.getTime(), "premise: the two anchors differ").not.toBe(
      windowFor(new Date("2026-10-01T12:10:00.000Z")).deadline.getTime(),
    );
  });

  it("check-in is refused on an unopened round", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: true,
    });
    await expect(
      checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, {
        now: new Date("2026-10-01T12:15:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECK_IN_CLOSED" });
    const [row] = await sql`select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId}`;
    expect(row, "nothing stamped").toBeUndefined();
  });

  it("an unopened round counts no check-in, even one inside the timetable's window", async () => {
    // Mutant Rg (2026-10-09): an unopened round falling back to the timetable
    // for check-ins survived every other case here.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    const [stamp] = await sql<{ checked_in_at: Date }[]>`
      select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId}`;
    expect(roomPhase(stamp!.checked_in_at, T), "premise: inside the timetable's window").toBe("open");
    const view = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, new Date());
    expect(view.phase).toBe("before");
    expect(view.you.checkedIn).toBe(false);
  });

  it("a check-in inside the TIMETABLE's window but outside the OPEN stamp's does not count", async () => {
    // stampFixtureCheckIn stamps the DB's real now(): the schedule (T, five
    // minutes ahead) puts that stamp inside its window, while a round opened
    // two hours ago closed its window long before it.
    const openedLongAgo = new Date(Date.now() - 2 * 60 * 60_000);
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      roundOpenedAt: openedLongAgo,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    const [stamp] = await sql<{ checked_in_at: Date }[]>`
      select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId}`;
    expect(roomPhase(stamp!.checked_in_at, T), "premise: inside the timetable's window").toBe("open");
    expect(roomPhase(stamp!.checked_in_at, openedLongAgo), "premise: outside the open stamp's").toBe("closed");
    const view = await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, new Date());
    expect(view.you.checkedIn).toBe(false);
  });

  it("the mint's expires_at is the OPEN stamp's deadline, and an unopened round mints nothing", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
    });
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const f = await loadOnlinePlayFixture(s.fixtureId);
    if (!f) throw new Error("seed did not pass the guard");
    const unopened = deps();
    expect(await mintIfReady(f, unopened)).toBe("not_ready");
    expect(unopened.adapter?.createOpenChallenge).not.toHaveBeenCalled();

    // Opened two minutes before T: both check-ins (real now) sit inside its
    // window, and its deadline differs from the timetable's.
    const opened = new Date(T.getTime() - 2 * 60_000);
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${s.stageId}, ${s.orgId}, 1, ${opened}, ${s.ownerUserId})`;
    const d = deps();
    expect(await mintIfReady(f, d)).toBe("minted");
    expect(d.adapter?.createOpenChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: windowFor(opened).deadline }),
    );
    const [row] = await sql<{ expires_at: Date }[]>`
      select expires_at from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(row?.expires_at.toISOString()).toBe(windowFor(opened).deadline.toISOString());
    expect(windowFor(opened).deadline.getTime(), "premise: the anchors differ").not.toBe(windowFor(T).deadline.getTime());
  });
});
