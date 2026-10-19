/**
 * The online-play funnel end to end, against the 2026-10-09 model (T9
 * rewrite of the inherited lichess.org-mode suite), plus the OTB regression:
 *
 *   linked enroll into an onlinePlay division → division started → nothing
 *   created before the organiser opens the round (D12) → round opened → both
 *   players seated by T8's REAL seatPlayer (camera policy off, the
 *   competition default) → createGameIfReady: White's token challenges
 *   Black's username, Black's token accepts → bridge row ready.
 *
 * Every producer is real except the Lichess HTTP boundary (T3's module) and
 * the round-open write, which no task owns yet (the B2 handover's item 1).
 * The old suite's result → standings leg died with applyProviderGameUpdate
 * (the deleted mode); the new result path is T12's and is tested there.
 *
 * Single-sport by construction: online play exists only for `boardgame`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { startDivision } from "../schedule";
import { PLAY_SCOPES, upsertLichessLink } from "../external-accounts";
import { createGameIfReady } from "../external-play/create-game";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";

// A Lichess link seals the player's token (T2), so this suite needs
// LICHESS_TOKEN_KEK. Set only when nothing else did (ci.yml sets it).
process.env.LICHESS_TOKEN_KEK ??= randomBytes(32).toString("hex");

const board = vi.hoisted(() => ({ createChallengeToUser: vi.fn(), acceptChallenge: vi.fn() }));
vi.mock("@/server/external-play/lichess/board-api", () => board);

const HAS_DB = !!process.env.DATABASE_URL;
const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");
/** 10+0, in SHIP1_TIME_CONTROLS: createDivision refuses a clock outside it. */
const CLOCK = { base: 600, increment: 0 };

async function seedBoardgameSport(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
    on conflict (key) do update set module_version = excluded.module_version`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
    on conflict on constraint sport_variants_pkey do update set config = excluded.config`;
}

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`hp-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"HP Org " + suffix}, ${"hp-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

async function seedLinkedPlayer(orgId: string, name: string, lichessId: string) {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}@t.local`}, ${name}, true, 'en') returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, ${name}, ${userId}) returning id`;
  await upsertLichessLink(userId, {
    externalUserId: lichessId,
    username: lichessId,
    scopes: [...PLAY_SCOPES],
    token: `tok-${lichessId}`,
  });
  return { userId, personId, lichessId };
}

async function seedUnlinkedPerson(orgId: string, name: string) {
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name)
    values (${orgId}, ${name}) returning id`;
  return personId;
}

/** Division → two entrants → a league stage → one round-1 fixture at T. */
async function seedBoard(owner: AuthCtx, config: Record<string, unknown>, members: [string, string]) {
  const competition = await createCompetition(owner, {
    name: "Happy Path Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", clock: CLOCK, ...config },
  });
  const [home] = await createEntrants(owner, division.id, [
    { display_name: "White", kind: "individual", members: [{ person_id: members[0], is_captain: false, roles: [] }] },
  ]);
  const [away] = await createEntrants(owner, division.id, [
    { display_name: "Black", kind: "individual", members: [{ person_id: members[1], is_captain: false, roles: [] }] },
  ]);
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "league", name: "RR", config: {} });
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`hp-${randomUUID().slice(0, 6)}`},
            'scheduled', ${home!.id}, ${away!.id}, ${T})
    returning id`;
  await startDivision(owner, division.id);
  /** No usecase owns the organiser's round open yet; this is its row. */
  const openRound = () => sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
    values (${stage!.id}, ${owner.orgId}, 1, ${OPENED}, ${owner.userId})`;
  return { divisionId: division.id, fixtureId: fixture!.id, openRound };
}

let GM = "";
beforeEach(() => {
  vi.clearAllMocks();
  GM = `gm-${randomUUID().slice(0, 12)}`;
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
  board.acceptChallenge.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("external-play happy path + OTB regression", () => {
  it("linked enroll → started → round opened → both seated → game created from White, accepted by Black", async () => {
    const owner = await seedOwner();
    const white = await seedLinkedPlayer(owner.orgId, "White", `hp-w-${randomUUID().slice(0, 8)}`);
    const black = await seedLinkedPlayer(owner.orgId, "Black", `hp-b-${randomUUID().slice(0, 8)}`);
    // createEntrants refuses an unlinked player into an onlinePlay division,
    // so reaching the next line IS the linked-enroll step.
    const b = await seedBoard(owner, { onlinePlay: "lichess" }, [white.personId, black.personId]);

    // D12: paired and started, but nobody has opened the round.
    expect(await createGameIfReady(b.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();

    await b.openRound();
    expect(await createGameIfReady(b.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });

    // No pairing card ⇒ White is home. The tokens are the ones sealed at
    // link time, opened at the call.
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    expect(board.createChallengeToUser).toHaveBeenCalledWith({
      whiteToken: `tok-${white.lichessId}`,
      blackUsername: black.lichessId,
      limitSeconds: CLOCK.base,
      incrementSeconds: CLOCK.increment,
    });
    expect(board.acceptChallenge).toHaveBeenCalledWith({ blackToken: `tok-${black.lichessId}`, challengeId: GM });

    const [bridge] = await sql<{
      status: string; challenge_id: string | null; white_side: string | null;
      white_lichess_id: string | null; black_lichess_id: string | null;
    }[]>`
      select status, challenge_id, white_side, white_lichess_id, black_lichess_id
        from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(bridge).toEqual({
      status: "ready",
      challenge_id: GM,
      white_side: "home",
      white_lichess_id: white.lichessId,
      black_lichess_id: black.lichessId,
    });
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${b.fixtureId}`;
    expect(fx?.status, "the board is not started by creation — T10's first move does that").toBe("scheduled");

    // The funnel's second pass is a no-op.
    expect(await createGameIfReady(b.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
  });

  it("onlinePlay off: unlinked enroll OK, and an opened, started round creates nothing and no bridge row", async () => {
    const owner = await seedOwner();
    const whitePid = await seedUnlinkedPerson(owner.orgId, "OTB White");
    const blackPid = await seedUnlinkedPerson(owner.orgId, "OTB Black");
    const b = await seedBoard(owner, {}, [whitePid, blackPid]);
    const [division] = await sql<{ config: Record<string, unknown> }[]>`
      select config from divisions where id = ${b.divisionId}`;
    expect(division?.config.onlinePlay, "premise: an OTB division").toBeUndefined();
    // Opened and started, so online play being off is the only thing missing
    // (the case above is the positive control).
    await b.openRound();

    expect(await createGameIfReady(b.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
    expect(board.acceptChallenge).not.toHaveBeenCalled();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(n).toBe(0);
  });
});
