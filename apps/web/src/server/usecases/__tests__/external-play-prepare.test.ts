import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { upsertLichessLink } from "../external-accounts";
import { prepareExternalPlayWindow } from "../external-play";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { ExternalPlayAdapter } from "@/server/external-play/types";

const HAS_DB = !!process.env.DATABASE_URL;

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
    values (${`prep-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Prep Org " + suffix}, ${"prep-" + suffix}, ${userId}) returning id, slug`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null, orgSlug } as AuthCtx & {
    orgSlug: string;
  };
}

async function seedPlayer(orgId: string, name: string, email: string) {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${email}, ${name}, true, 'en') returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, ${name}, ${userId}) returning id`;
  return { userId, personId };
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("prepareExternalPlayWindow", () => {
  it("creates a Lichess challenge, marks ready, emails Seazn fixture URL once", async () => {
    const owner = await seedOwner();
    const competition = await createCompetition(owner, {
      name: "Online Cup",
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
        clock: { base: 600, increment: 5 },
      },
    });

    const white = await seedPlayer(owner.orgId, "White Player", `w-${randomUUID().slice(0, 8)}@t.local`);
    const black = await seedPlayer(owner.orgId, "Black Player", `b-${randomUUID().slice(0, 8)}@t.local`);
    await upsertLichessLink(white.userId, {
      externalUserId: `w-${randomUUID().slice(0, 8)}`,
      username: "WhiteOnLichess",
      accessToken: "white-tok",
    });
    await upsertLichessLink(black.userId, {
      externalUserId: `b-${randomUUID().slice(0, 8)}`,
      username: "BlackOnLichess",
      accessToken: "black-tok",
    });

    const [home] = await createEntrants(owner, division.id, [
      {
        display_name: "White Player",
        kind: "individual",
        members: [{ person_id: white.personId, is_captain: false, roles: [] }],
      },
    ]);
    const [away] = await createEntrants(owner, division.id, [
      {
        display_name: "Black Player",
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

    // Unique clock so this fixture never collides with leftover DB rows from prior runs.
    const now = new Date(Date.now() + Math.floor(Math.random() * 1e12));
    const scheduledAt = new Date(now.getTime() + 10 * 60 * 1000);
    const [fixture] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`ep-${randomUUID().slice(0, 6)}`},
              'scheduled', ${home!.id}, ${away!.id}, ${scheduledAt})
      returning id`;

    const createChallenge = vi.fn(async () => ({
      challengeId: "ch-1",
      whitePlayUrl: "https://lichess.org/ch-1",
      blackPlayUrl: "https://lichess.org/ch-1",
    }));
    const adapter: ExternalPlayAdapter = {
      createChallenge,
      fetchGame: vi.fn(),
    };
    const sendReadyEmail = vi.fn(async () => true);

    const first = await prepareExternalPlayWindow({
      now,
      origin: "https://example.test",
      adapter,
      sendReadyEmail,
      orgId: owner.orgId,
    });
    expect(first.prepared).toBe(1);
    expect(first.emailed).toBe(1);
    expect(first.failed).toBe(0);
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        whiteAccessToken: "white-tok",
        blackLichessUsername: "BlackOnLichess",
        rated: false,
        clock: { limit: 600, increment: 5 },
      }),
    );
    expect(sendReadyEmail).toHaveBeenCalledTimes(2);
    for (const call of sendReadyEmail.mock.calls) {
      const args = call[1] as { fixtureUrl: string };
      expect(args.fixtureUrl).toContain("/shared/");
      expect(args.fixtureUrl).toContain(fixture!.id);
      expect(args.fixtureUrl).not.toContain("lichess.org");
    }

    const [row] = await sql<{ status: string; emailed_at: Date | null; play_url: string | null }[]>`
      select status, emailed_at, play_url from fixture_external_play where fixture_id = ${fixture!.id}`;
    expect(row!.status).toBe("ready");
    expect(row!.emailed_at).toBeTruthy();
    expect(row!.play_url).toBe("https://lichess.org/ch-1");

    createChallenge.mockClear();
    sendReadyEmail.mockClear();
    const second = await prepareExternalPlayWindow({
      now,
      origin: "https://example.test",
      adapter,
      sendReadyEmail,
      orgId: owner.orgId,
    });
    expect(second.prepared).toBe(0);
    expect(createChallenge).not.toHaveBeenCalled();
    expect(sendReadyEmail).not.toHaveBeenCalled();
  });

  it("marks needs_organiser for delay clocks without emailing", async () => {
    const owner = await seedOwner();
    const competition = await createCompetition(owner, {
      name: "Delay Cup",
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
        clock: { base: 300, delay: 3 },
      },
    });

    const white = await seedPlayer(owner.orgId, "W2", `w2-${randomUUID().slice(0, 8)}@t.local`);
    const black = await seedPlayer(owner.orgId, "B2", `b2-${randomUUID().slice(0, 8)}@t.local`);
    await upsertLichessLink(white.userId, {
      externalUserId: `w2-${randomUUID().slice(0, 8)}`,
      username: "W2L",
      accessToken: "tok",
    });
    await upsertLichessLink(black.userId, {
      externalUserId: `b2-${randomUUID().slice(0, 8)}`,
      username: "B2L",
      accessToken: "tok",
    });
    const [home] = await createEntrants(owner, division.id, [
      {
        display_name: "W2",
        kind: "individual",
        members: [{ person_id: white.personId, is_captain: false, roles: [] }],
      },
    ]);
    const [away] = await createEntrants(owner, division.id, [
      {
        display_name: "B2",
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
    const [fixture] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`epd-${randomUUID().slice(0, 6)}`},
              'scheduled', ${home!.id}, ${away!.id}, ${new Date(now.getTime() + 5 * 60 * 1000)})
      returning id`;

    const sendReadyEmail = vi.fn(async () => true);
    const counts = await prepareExternalPlayWindow({
      now,
      origin: "https://example.test",
      adapter: { createChallenge: vi.fn(), fetchGame: vi.fn() },
      sendReadyEmail,
      orgId: owner.orgId,
    });
    expect(counts.deferred).toBeGreaterThanOrEqual(1);
    expect(sendReadyEmail).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from fixture_external_play where fixture_id = ${fixture!.id}`;
    expect(row!.status).toBe("needs_organiser");
    expect(row!.last_error).toBe("delay_unsupported");
  });
});
