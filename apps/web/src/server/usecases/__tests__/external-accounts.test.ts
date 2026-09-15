import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  getLinkedAccount,
  personHasLichessLink,
  unlinkExternalAccount,
  upsertLichessLink,
} from "../external-accounts";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("external-accounts", () => {
  it("upserts, gets, and unlinks a Lichess link", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`lichess-${suffix}@test.local`}, 'Lichess User', true)
      returning id`;

    expect(await getLinkedAccount(userId, "lichess")).toBeNull();

    await upsertLichessLink(userId, {
      externalUserId: `lid-${suffix}`,
      username: `Player${suffix}`,
      accessToken: "tok-1",
    });

    const linked = await getLinkedAccount(userId, "lichess");
    expect(linked).toMatchObject({
      provider: "lichess",
      externalUserId: `lid-${suffix}`,
      username: `Player${suffix}`,
    });

    await upsertLichessLink(userId, {
      externalUserId: `lid-${suffix}`,
      username: `Renamed${suffix}`,
      accessToken: "tok-2",
    });
    expect((await getLinkedAccount(userId, "lichess"))?.username).toBe(`Renamed${suffix}`);

    await unlinkExternalAccount(userId, "lichess");
    expect(await getLinkedAccount(userId, "lichess")).toBeNull();
  });

  it("personHasLichessLink is false when person has no user_id", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`plh-${suffix}@test.local`}, 'Owner', true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"PLH " + suffix}, ${"plh-" + suffix}, ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name)
      values (${orgId}, ${"Unlinked Person"}) returning id`;

    expect(await personHasLichessLink(orgId, personId)).toBe(false);
  });

  it("personHasLichessLink is true when linked user has Lichess", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`plh2-${suffix}@test.local`}, 'Player', true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"PLH2 " + suffix}, ${"plh2-" + suffix}, ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${orgId}, ${"Linked Person"}, ${userId}) returning id`;

    expect(await personHasLichessLink(orgId, personId)).toBe(false);
    await upsertLichessLink(userId, {
      externalUserId: `lid2-${suffix}`,
      username: `U${suffix}`,
      accessToken: "tok",
    });
    expect(await personHasLichessLink(orgId, personId)).toBe(true);
  });
});
