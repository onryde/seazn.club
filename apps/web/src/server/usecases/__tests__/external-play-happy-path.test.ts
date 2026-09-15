/**
 * Task 9 — full online-play funnel + OTB regression in one place:
 * linked enroll → prepare (mocked Lichess) → mate apply → standings;
 * onlinePlay off → unlinked enroll OK and prepare creates no bridge row.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, getStandings } from "../stages";
import { startDivision } from "../schedule";
import { upsertLichessLink } from "../external-accounts";
import { applyProviderGameUpdate, prepareExternalPlayWindow } from "../external-play";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { ExternalPlayAdapter, LichessGameSnapshot } from "@/server/external-play/types";

const HAS_DB = !!process.env.DATABASE_URL;
const FIXTURE_DIR = join(process.cwd(), "src/server/external-play/__fixtures__/lichess");

function loadSnap(name: string): LichessGameSnapshot {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as LichessGameSnapshot;
}

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

async function seedOwner(): Promise<AuthCtx & { orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`hp-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"HP Org " + suffix}, ${"hp-" + suffix}, ${userId}) returning id, slug`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null, orgSlug } as AuthCtx & {
    orgSlug: string;
  };
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
    accessToken: `tok-${lichessId}`,
  });
  return { userId, personId, lichessId };
}

async function seedUnlinkedPerson(orgId: string, name: string) {
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name)
    values (${orgId}, ${name}) returning id`;
  return personId;
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("external-play happy path + OTB regression", () => {
  it("linked enroll → prepare → mate finish → standings", async () => {
    const owner = await seedOwner();
    const homeLichess = `hp-w-${randomUUID().slice(0, 8)}`;
    const awayLichess = `hp-b-${randomUUID().slice(0, 8)}`;
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
      config: {
        variant: "classical",
        onlinePlay: "lichess",
        clock: { base: 600, increment: 0 },
      },
    });

    const white = await seedLinkedPlayer(owner.orgId, "White", homeLichess);
    const black = await seedLinkedPlayer(owner.orgId, "Black", awayLichess);
    const [home] = await createEntrants(owner, division.id, [
      {
        display_name: "White",
        kind: "individual",
        members: [{ person_id: white.personId, is_captain: false, roles: [] }],
      },
    ]);
    const [away] = await createEntrants(owner, division.id, [
      {
        display_name: "Black",
        kind: "individual",
        members: [{ person_id: black.personId, is_captain: false, roles: [] }],
      },
    ]);

    const [stage] = await createStages(owner, division.id, {
      seq: 1,
      kind: "league",
      name: "RR",
      config: {},
    });

    const now = new Date(Date.now() + Math.floor(Math.random() * 1e12));
    const scheduledAt = new Date(now.getTime() + 10 * 60 * 1000);
    const challengeId = `ch-${randomUUID().slice(0, 8)}`;
    const [fixture] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`hp-${randomUUID().slice(0, 6)}`},
              'scheduled', ${home!.id}, ${away!.id}, ${scheduledAt})
      returning id`;

    await startDivision(owner, division.id);

    const createChallenge = vi.fn(async () => ({
      challengeId,
      whitePlayUrl: `https://lichess.org/${challengeId}`,
      blackPlayUrl: `https://lichess.org/${challengeId}`,
    }));
    const adapter: ExternalPlayAdapter = {
      createChallenge,
      fetchGame: vi.fn(),
    };
    const sendReadyEmail = vi.fn(async () => true);

    const prepared = await prepareExternalPlayWindow({
      now,
      origin: "https://example.test",
      adapter,
      sendReadyEmail,
      orgId: owner.orgId,
    });
    expect(prepared.prepared).toBe(1);
    expect(prepared.emailed).toBe(1);
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        whiteAccessToken: `tok-${homeLichess}`,
        blackLichessUsername: awayLichess,
        rated: false,
      }),
    );

    const [bridge] = await sql<{ status: string; play_url: string | null }[]>`
      select status, play_url from fixture_external_play where fixture_id = ${fixture!.id}`;
    expect(bridge!.status).toBe("ready");
    expect(bridge!.play_url).toBe(`https://lichess.org/${challengeId}`);

    const snap = loadSnap("game-mate-white.json");
    snap.id = challengeId;
    snap.players.white.userId = homeLichess;
    snap.players.black.userId = awayLichess;

    const applied = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: challengeId,
      snapshot: snap,
    });
    expect(applied).toBe("finished");

    const [fx] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${fixture!.id}`;
    expect(fx!.status).toBe("decided");
    expect(fx!.outcome).toMatchObject({ kind: "win" });

    const standings = await getStandings(owner, stage!.id);
    const rows = standings.rows as {
      entrantId: string;
      played: number;
      won: number;
      lost: number;
    }[];
    const whiteRow = rows.find((r) => r.entrantId === home!.id);
    const blackRow = rows.find((r) => r.entrantId === away!.id);
    expect(whiteRow?.played).toBe(1);
    expect(whiteRow?.won).toBe(1);
    expect(blackRow?.played).toBe(1);
    expect(blackRow?.lost).toBe(1);
  });

  it("onlinePlay off: unlinked enroll OK and prepare creates no bridge", async () => {
    const owner = await seedOwner();
    const competition = await createCompetition(owner, {
      name: "OTB Cup",
      visibility: "public",
      branding: {},
      starts_on: "2026-10-01",
      ends_on: "2026-10-02",
    });
    const division = await createDivision(owner, competition.id, {
      name: "OTB",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: { base: 600 } },
    });
    expect((division.config as Record<string, unknown>).onlinePlay).toBeUndefined();

    const whitePid = await seedUnlinkedPerson(owner.orgId, "OTB White");
    const blackPid = await seedUnlinkedPerson(owner.orgId, "OTB Black");
    const [home] = await createEntrants(owner, division.id, [
      {
        display_name: "OTB White",
        kind: "individual",
        members: [{ person_id: whitePid, is_captain: false, roles: [] }],
      },
    ]);
    const [away] = await createEntrants(owner, division.id, [
      {
        display_name: "OTB Black",
        kind: "individual",
        members: [{ person_id: blackPid, is_captain: false, roles: [] }],
      },
    ]);
    expect(home!.id).toBeTruthy();
    expect(away!.id).toBeTruthy();

    const [stage] = await createStages(owner, division.id, {
      seq: 1,
      kind: "league",
      name: "RR",
      config: {},
    });
    const now = new Date(Date.now() + Math.floor(Math.random() * 1e12));
    const scheduledAt = new Date(now.getTime() + 10 * 60 * 1000);
    const [fixture] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`otb-${randomUUID().slice(0, 6)}`},
              'scheduled', ${home!.id}, ${away!.id}, ${scheduledAt})
      returning id`;

    const createChallenge = vi.fn();
    const prepared = await prepareExternalPlayWindow({
      now,
      origin: "https://example.test",
      adapter: { createChallenge, fetchGame: vi.fn() },
      sendReadyEmail: vi.fn(async () => true),
      orgId: owner.orgId,
    });
    expect(prepared.prepared).toBe(0);
    expect(createChallenge).not.toHaveBeenCalled();

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_external_play where fixture_id = ${fixture!.id}`;
    expect(n).toBe(0);
  });
});
