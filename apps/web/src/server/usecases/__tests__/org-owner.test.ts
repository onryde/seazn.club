// The one owner lookup (phase 3 wave 2, Batch A): `orgOwnerRecipient` names the organisation's OLDEST current owner (owner ruling Q2,
// 2026-10-26) through `org_members`, never `organizations.created_by` (an ownership transfer flips the role and leaves `created_by`
// behind), and never a deleted account. Every owner-addressed notice of wave 2 reads its recipient here.
//
// Each case seeds its own organisation and states the answer from what it seeded (the ids and addresses it inserted), never from the code
// under test. Where a wrong query would still land on the right owner by accident, the case is built so it does not: the older owner is
// inserted SECOND (a query without its order reads the heap and finds the younger first), and the lower id is inserted second too.
//
// Sport: not applicable. An organisation's owner does not vary by sport.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { orgOwnerRecipient } from "../org-owner";
import { makeUser } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Owner = { userId: string; email: string };

async function user(tag: string): Promise<Owner> {
  const userId = await makeUser(`oo-${tag}`);
  made.userIds.push(userId);
  const [u] = await sql<{ email: string }[]>`select email from users where id = ${userId}`;
  return { userId, email: u!.email };
}

/** A bare organisation, made by `creator` (who is NOT made a member: the lookup must never fall back to `created_by`). */
async function org(creator: Owner): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [o] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${"Owner Org " + suffix}, ${"oo-org-" + suffix}, ${creator.userId}) returning id`;
  made.orgIds.push(o!.id);
  return o!.id;
}

async function member(orgId: string, who: Owner, role: "owner" | "admin" | "viewer", createdAt?: Date): Promise<void> {
  await sql`
    insert into org_members (org_id, user_id, role, created_at)
    values (${orgId}, ${who.userId}, ${role}, ${createdAt ?? sql`now()`})`;
}

const DAY = 24 * 60 * 60 * 1000;

/** One case: what it seeds, and the probes it leaves (an organisation and the owner the rule names for it, or null for none). */
type Case = { name: string; arrange: () => Promise<{ orgId: string; expected: Owner | null }[]> };

const CASES: Case[] = [
  {
    name: "one owner: that owner",
    arrange: async () => {
      const owner = await user("solo");
      const orgId = await org(owner);
      await member(orgId, owner, "owner");
      return [{ orgId, expected: owner }];
    },
  },
  {
    name: "two owners: the OLDER one, though it was inserted second (heap order differs from the answer)",
    arrange: async () => {
      const younger = await user("younger");
      const older = await user("older");
      const orgId = await org(younger);
      await member(orgId, younger, "owner", new Date());
      await member(orgId, older, "owner", new Date(Date.now() - DAY));
      return [{ orgId, expected: older }];
    },
  },
  {
    name: "two owners made in the same instant: the lower user id, though it was inserted second",
    arrange: async () => {
      const [lower, higher] = [await user("tie-a"), await user("tie-b")].sort((a, b) => (a.userId < b.userId ? -1 : 1)) as [Owner, Owner];
      const orgId = await org(lower);
      const at = new Date(Date.now() - DAY);
      await member(orgId, higher, "owner", at);
      await member(orgId, lower, "owner", at);
      return [{ orgId, expected: lower }];
    },
  },
  {
    name: "a deleted account is never the owner: alone it leaves none, beside a live owner the live one",
    arrange: async () => {
      // Alone: the only owner's account is deleted.
      const gone = await user("gone");
      const alone = await org(gone);
      await member(alone, gone, "owner");
      // Beside a live owner: the deleted account is the OLDER owner, so a lookup that read it would choose it.
      const goneOlder = await user("gone-older");
      const live = await user("live");
      const pair = await org(live);
      await member(pair, live, "owner", new Date());
      await member(pair, goneOlder, "owner", new Date(Date.now() - DAY));
      await sql`update users set deleted_at = now() where id = any(${[gone.userId, goneOlder.userId]}::uuid[])`;
      return [
        { orgId: alone, expected: null },
        { orgId: pair, expected: live },
      ];
    },
  },
  {
    name: "only an admin (and the creator, who is not a member): no owner",
    arrange: async () => {
      const creator = await user("creator");
      const admin = await user("admin");
      const orgId = await org(creator);
      await member(orgId, admin, "admin");
      return [{ orgId, expected: null }];
    },
  },
];

describe.skipIf(!HAS_DB)("orgOwnerRecipient: the oldest current owner, never a deleted account (DB)", () => {
  it("every case names the owner the rule names", async () => {
    let checked = 0;
    const outcomes = { owner: 0, none: 0 };
    for (const c of CASES) {
      for (const { orgId, expected } of await c.arrange()) {
        expect(await orgOwnerRecipient(sql, orgId), c.name).toEqual(expected);
        outcomes[expected === null ? "none" : "owner"] += 1;
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every case was judged").toBe(5);
    // Both outcomes are present, so neither "always null" nor "always the first member" passes.
    expect(outcomes, "the six probes: four owners, two with none").toEqual({ owner: 4, none: 2 });
  });
});
