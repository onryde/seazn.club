import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { startDivision } from "../schedule";
import { upsertLichessLink } from "../external-accounts";
import {
  escalateStaleExternalPlay,
  resolveExternalPlay,
} from "../external-play";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`esc-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Esc Org " + suffix}, ${"esc-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
    on conflict (key) do update set module_version = excluded.module_version`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
    on conflict on constraint sport_variants_pkey do update set config = excluded.config`;
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

async function seedReadyPastGrace(owner: AuthCtx, scheduledAt: Date) {
  const competition = await createCompetition(owner, {
    name: "Esc Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 300 } },
  });
  const mkPlayer = async (name: string) => {
    const lid = `${name}-${randomUUID().slice(0, 6)}`;
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`${lid}@t.local`}, ${name}, true) returning id`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${owner.orgId}, ${name}, ${userId}) returning id`;
    await upsertLichessLink(userId, {
      externalUserId: lid,
      username: lid,
      accessToken: "tok",
    });
    return personId;
  };
  const whitePid = await mkPlayer("W");
  const blackPid = await mkPlayer("B");
  const [home] = await createEntrants(owner, division.id, [
    {
      display_name: "W",
      kind: "individual",
      members: [{ person_id: whitePid, is_captain: false, roles: [] }],
    },
  ]);
  const [away] = await createEntrants(owner, division.id, [
    {
      display_name: "B",
      kind: "individual",
      members: [{ person_id: blackPid, is_captain: false, roles: [] }],
    },
  ]);
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, 1, ${`e-${randomUUID().slice(0, 6)}`},
            'scheduled', ${home!.id}, ${away!.id}, ${scheduledAt})
    returning id`;
  await sql`
    insert into fixture_external_play (fixture_id, org_id, provider, status, external_challenge_id)
    values (${fixture!.id}, ${owner.orgId}, 'lichess', 'ready', ${`ch-${randomUUID().slice(0, 6)}`})`;
  await startDivision(owner, division.id);
  return { fixtureId: fixture!.id, homeId: home!.id, awayId: away!.id, divisionId: division.id };
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("escalate + resolve external play", () => {
  it("escalates ready fixtures past T+20 to needs_organiser", async () => {
    const owner = await seedOwner();
    const scheduledAt = new Date("2020-01-01T12:00:00.000Z");
    const rig = await seedReadyPastGrace(owner, scheduledAt);
    const now = new Date("2020-01-01T12:25:00.000Z"); // 25 min after start
    const out = await escalateStaleExternalPlay({ now });
    expect(out.escalated).toBeGreaterThanOrEqual(1);
    const [ep] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("needs_organiser");
    expect(ep!.last_error).toBe("no_show_grace_elapsed");
  });

  it("does not escalate before the 20-minute grace", async () => {
    const owner = await seedOwner();
    const scheduledAt = new Date("2020-02-01T12:00:00.000Z");
    const rig = await seedReadyPastGrace(owner, scheduledAt);
    const now = new Date("2020-02-01T12:10:00.000Z"); // only 10 min past
    await escalateStaleExternalPlay({ now });
    const [ep] = await sql<{ status: string }[]>`
      select status from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("ready");
  });

  it("resolveExternalPlay writes a forfeit via scoreEvent and finishes the bridge", async () => {
    const owner = await seedOwner();
    const scheduledAt = new Date("2020-03-01T12:00:00.000Z");
    const rig = await seedReadyPastGrace(owner, scheduledAt);
    await sql`
      update fixture_external_play
         set status = 'needs_organiser', last_error = 'no_show_grace_elapsed'
       where fixture_id = ${rig.fixtureId}`;

    const out = await resolveExternalPlay(owner, rig.fixtureId, "home_forfeit");
    expect(out.status).toBe("finished");
    expect(out.score.status).toBe("decided");

    const [fx] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${rig.fixtureId}`;
    expect(fx!.status).toBe("decided");
    expect(fx!.outcome).toMatchObject({ kind: "win", winner: rig.awayId });

    const [ep] = await sql<{ status: string }[]>`
      select status from fixture_external_play where fixture_id = ${rig.fixtureId}`;
    expect(ep!.status).toBe("finished");

    await expect(resolveExternalPlay(owner, rig.fixtureId, "draw")).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_RESOLVED",
    });
  });
});
