// Shared DB-backed seed helpers for the chess Lichess external-play guard
// suite (Task 7) and its downstream tasks (8/9/10/13). Boardgame sport/owner/
// player seeding adapted from the pre-redesign `external-play-sync.test.ts`
// (`seedBoardgameSport`/`seedOwner`/`seedPlayer`) — that file's fixture row
// used the OLD V404-era `fixture_external_play` columns and is being
// superseded task-by-task (R1); these helpers target the CURRENT schema.
import { randomBytes, randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CameraPolicy } from "@/lib/camera-policy";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { startDivision } from "../schedule";
import { PLAY_SCOPES, upsertLichessLink } from "../external-accounts";

// A linked seed now seals a REAL token (T2), so `upsertLichessLink` needs
// LICHESS_TOKEN_KEK in the process. Set here, once, rather than in each of the
// fourteen suites that reach this helper — and only when nothing else set it,
// so a suite that pins its own key (external-accounts.test.ts) still wins, and
// a CI job or .env.local value is never overwritten. Test-only file; the
// production path reads the key from the environment as always.
process.env.LICHESS_TOKEN_KEK ??= randomBytes(32).toString("hex");

export async function seedBoardgameSport(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
    on conflict (key) do update set module_version = excluded.module_version`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
    on conflict on constraint sport_variants_pkey do update set config = excluded.config`;
}

export async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`ep7-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"EP7 Org " + suffix}, ${"ep7-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

export type SeedPlayer = { personId: string; userId: string; lichessId: string };

/** `linked: false` seeds the person/user but skips `upsertLichessLink` — for
 *  cases that need an entrant with no Lichess identity. */
export async function seedPlayer(
  orgId: string,
  name: string,
  lichessId: string,
  linked: boolean,
): Promise<SeedPlayer> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}-${randomUUID().slice(0, 6)}@t.local`}, ${name}, true, 'en') returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, ${name}, ${userId}) returning id`;
  if (linked) {
    // The link now carries a sealed token (T2), so every suite that seeds a
    // linked player needs LICHESS_TOKEN_KEK in its process.
    await upsertLichessLink(userId, {
      externalUserId: lichessId,
      username: lichessId,
      scopes: [...PLAY_SCOPES],
      token: `lio_seed_${lichessId}`,
    });
  }
  return { userId, personId, lichessId };
}

export type SeedOnlineChessFixtureOpts = {
  onlinePlay: "off" | "lichess";
  divisionStarted: boolean;
  scheduledAt: Date;
  linked: boolean;
  /** Defaults to 15+10 (900s base, 10s increment) — a ship-1 curated control
   *  (time-controls.ts), because createDivision now REFUSES an online clock
   *  outside the catalogue (T6). The default used to be 15+0, which the
   *  gate refused until the owner ruled it onto the list (2026-10-09); the
   *  default stays 15+10. A clock the gate refuses (a delay, 1+0) can no
   *  longer be built through this helper with onlinePlay 'lichess': write it
   *  by SQL after a valid create, and say it models pre-gate legacy data. */
  clock?: { base: number; increment?: number; delay?: number };
  /** `divisions.camera_policy`, written by createDivision. Omitted ⇒ null
   *  (inherit), which is what every pre-existing division looks like. */
  cameraPolicy?: CameraPolicy;
  /** `stages.camera_policy`, the nearest level. Omitted ⇒ null (inherit). */
  stageCameraPolicy?: CameraPolicy;
  /** `competitions.camera_policy`, the NOT NULL floor. Omitted ⇒ the column
   *  default 'off'. */
  competitionCameraPolicy?: CameraPolicy;
  /** D12: inserts the `stage_round_opens` row for the fixture's round (1),
   *  opened by the seeded owner. Omitted ⇒ the round has never been opened,
   *  which is the DEFAULT state of a freshly paired round. */
  roundOpenedAt?: Date;
};

export type SeedOnlineChessFixtureResult = {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The seeded org owner — the actor for patchDivision / the round open. */
  ownerUserId: string;
  fixtureId: string;
  home: { entrantId: string; personId: string; userId: string; lichessId: string };
  away: { entrantId: string; personId: string; userId: string; lichessId: string };
};

/** One boardgame division, two individual entrants (White/Black — each with
 *  their own person + user, optionally Lichess-linked), one fixture. Mirrors
 *  the old `seedReadyFixture` shape but returns identity ids the guard suite
 *  needs (`loadSides`/`whiteSideOf`), not a bridge row (callers that need one
 *  insert it themselves — `ensureBridgeRow` or a raw SQL insert). */
export async function seedOnlineChessFixture(
  opts: SeedOnlineChessFixtureOpts,
): Promise<SeedOnlineChessFixtureResult> {
  const owner = await seedOwner();
  const ownerUserId = owner.userId;
  if (!ownerUserId) throw new Error("seedOwner returned a session with no userId");
  const competition = await createCompetition(owner, {
    name: "EP7 Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  // `createEntrants` refuses to attach an unlinked person to a division whose
  // config ALREADY reads onlinePlay 'lichess' (entrants.ts:385,
  // `assertPersonIdsLinkedForOnlinePlay`) — a real product guard, not this
  // task's to relax. `linked: false` + `onlinePlay: 'lichess'` is still a
  // reachable state in production (a roster built before online play was
  // turned on, or a player who later unlinked), so it is built the same way
  // here: create the division 'off', attach the (unlinked) entrants, THEN
  // flip the config — mirroring the "forced into config" bypass the
  // non-boardgame guard test already uses.
  const deferOnlinePlay = opts.onlinePlay === "lichess" && !opts.linked;
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: {
      variant: "classical",
      onlinePlay: deferOnlinePlay ? "off" : opts.onlinePlay,
      clock: opts.clock ?? { base: 900, increment: 10 },
    },
    // Through the product path (T6), not a raw UPDATE: the division's own
    // camera requirement is what createDivision stores.
    ...(opts.cameraPolicy ? { camera_policy: opts.cameraPolicy } : {}),
  });
  if (opts.competitionCameraPolicy) {
    await sql`update competitions set camera_policy = ${opts.competitionCameraPolicy}
               where id = ${competition.id}`;
  }
  const homeLichess = `w-${randomUUID().slice(0, 8)}`;
  const awayLichess = `b-${randomUUID().slice(0, 8)}`;
  const white = await seedPlayer(owner.orgId, "White", homeLichess, opts.linked);
  const black = await seedPlayer(owner.orgId, "Black", awayLichess, opts.linked);
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
  if (deferOnlinePlay) {
    await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${division.id}`;
  }
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`ep7-${randomUUID().slice(0, 6)}`},
            'scheduled', ${home.id}, ${away.id}, ${opts.scheduledAt})
    returning id`;
  if (opts.stageCameraPolicy) {
    await sql`update stages set camera_policy = ${opts.stageCameraPolicy} where id = ${stage.id}`;
  }
  if (opts.roundOpenedAt) {
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${stage.id}, ${owner.orgId}, 1, ${opts.roundOpenedAt}, ${ownerUserId})`;
  }
  if (opts.divisionStarted) {
    await startDivision(owner, division.id);
  }
  return {
    orgId: owner.orgId,
    competitionId: competition.id,
    divisionId: division.id,
    stageId: stage.id,
    ownerUserId,
    fixtureId: fixture.id,
    home: { entrantId: home.id, personId: white.personId, userId: white.userId, lichessId: white.lichessId },
    away: { entrantId: away.id, personId: black.personId, userId: black.userId, lichessId: black.lichessId },
  };
}
