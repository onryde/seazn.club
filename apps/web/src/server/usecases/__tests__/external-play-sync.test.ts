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
import { createStages } from "../stages";
import { startDivision } from "../schedule";
import { upsertLichessLink } from "../external-accounts";
import { applyProviderGameUpdate } from "../external-play";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { LichessGameSnapshot } from "@/server/external-play/types";

const HAS_DB = !!process.env.DATABASE_URL;
const FIXTURE_DIR = join(
  process.cwd(),
  "src/server/external-play/__fixtures__/lichess",
);

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

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`sync-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Sync Org " + suffix}, ${"sync-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

async function seedPlayer(orgId: string, name: string, lichessId: string) {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}-${randomUUID().slice(0, 6)}@t.local`}, ${name}, true, 'en') returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, ${name}, ${userId}) returning id`;
  await upsertLichessLink(userId, {
    externalUserId: lichessId,
    username: lichessId,
    accessToken: `tok-${lichessId}`,
  });
  return { userId, personId };
}

async function seedReadyFixture() {
  const homeLichess = `lichess-home-${randomUUID().slice(0, 8)}`;
  const awayLichess = `lichess-away-${randomUUID().slice(0, 8)}`;
  const owner = await seedOwner();
  const competition = await createCompetition(owner, {
    name: "Sync Cup",
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
  const white = await seedPlayer(owner.orgId, "White", homeLichess);
  const black = await seedPlayer(owner.orgId, "Black", awayLichess);
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
  const gameKey = `g-${randomUUID().slice(0, 8)}`;
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`sx-${randomUUID().slice(0, 6)}`},
            'scheduled', ${home!.id}, ${away!.id}, ${new Date("2026-10-01T12:10:00.000Z")})
    returning id`;
  await sql`
    insert into fixture_external_play (
      fixture_id, org_id, provider, status, external_challenge_id, play_url
    ) values (
      ${fixture!.id}, ${owner.orgId}, 'lichess', 'ready', ${gameKey}, ${`https://lichess.org/${gameKey}`}
    )`;
  await startDivision(owner, division.id);
  return {
    owner,
    divisionId: division.id,
    fixtureId: fixture!.id,
    homeId: home!.id,
    awayId: away!.id,
    gameKey,
    homeLichess,
    awayLichess,
  };
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("applyProviderGameUpdate", () => {
  it("applies a mate finish through scoreEvent and marks finished", async () => {
    const rig = await seedReadyFixture();
    const snap = loadSnap("game-mate-white.json");
    snap.id = rig.gameKey;
    snap.players.white.userId = rig.homeLichess;
    snap.players.black.userId = rig.awayLichess;

    const first = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: rig.gameKey,
      snapshot: snap,
    });
    expect(first).toBe("finished");

    const [fx] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${rig.fixtureId}`;
    expect(fx!.status).toBe("decided");
    expect(fx!.outcome).toMatchObject({ kind: "win" });

    const [ep] = await sql<{ status: string; external_game_id: string | null }[]>`
      select status, external_game_id from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("finished");
    expect(ep!.external_game_id).toBe(rig.gameKey);

    const events = await sql<{ type: string }[]>`
      select type from score_events where fixture_id = ${rig.fixtureId} order by seq`;
    expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);

    const second = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: rig.gameKey,
      snapshot: snap,
    });
    expect(second).toBe("ignored");
  });

  it("queues needs_organiser on account mismatch without appending", async () => {
    const rig = await seedReadyFixture();
    const snap = loadSnap("game-mismatch.json");
    snap.id = rig.gameKey;
    snap.players.white.userId = "wrong-white";
    snap.players.black.userId = rig.awayLichess;

    const result = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: rig.gameKey,
      snapshot: snap,
    });
    expect(result).toBe("needs_organiser");

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${rig.fixtureId}`;
    expect(n).toBe(0);

    const [ep] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("needs_organiser");
    expect(ep!.last_error).toBe("account_mismatch");
  });

  it("queues needs_organiser on abort", async () => {
    const rig = await seedReadyFixture();
    const snap = loadSnap("game-abort.json");
    snap.id = rig.gameKey;
    snap.players.white.userId = rig.homeLichess;
    snap.players.black.userId = rig.awayLichess;

    const result = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: rig.gameKey,
      snapshot: snap,
    });
    expect(result).toBe("needs_organiser");

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${rig.fixtureId}`;
    expect(n).toBe(0);
  });

  it("marks live for an unfinished started game", async () => {
    const rig = await seedReadyFixture();
    const snap = loadSnap("game-started.json");
    snap.id = rig.gameKey;
    snap.players.white.userId = rig.homeLichess;
    snap.players.black.userId = rig.awayLichess;

    const result = await applyProviderGameUpdate({
      provider: "lichess",
      gameId: rig.gameKey,
      snapshot: snap,
      adapter: { createChallenge: vi.fn(), fetchGame: vi.fn() },
    });
    expect(result).toBe("live");

    const [fx] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${rig.fixtureId}`;
    expect(fx!.status).toBe("in_play");

    const events = await sql<{ type: string }[]>`
      select type from score_events where fixture_id = ${rig.fixtureId} order by seq`;
    expect(events.map((e) => e.type)).toEqual(["core.start"]);

    const [ep] = await sql<{ status: string }[]>`
      select status from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("live");
  });
});
