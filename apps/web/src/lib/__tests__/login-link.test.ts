// Unit coverage for passwordless sign-in tokens (lib/login-link.ts): consume
// returns the user id and verifies the email, single-use, unknown/expired
// tokens are rejected, and issuing a new link invalidates the previous one.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createLoginLink, consumeLoginLink, issueLoginLink, LOGIN_LINK_TTL_MS } from "@/lib/login-link";
import emails from "@/dictionaries/en/emails.json";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(verified = false): Promise<string> {
  const email = `magic-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Magic', ${verified})
    returning id`;
  return id;
}

describe.skipIf(!HAS_DB)("login-link (passwordless sign-in tokens)", () => {
  const created: string[] = [];
  const track = async (verified = false) => {
    const id = await makeUser(verified);
    created.push(id);
    return id;
  };

  afterAll(async () => {
    if (!HAS_DB) return;
    if (created.length) await sql`delete from users where id in ${sql(created)}`;
    await sql.end();
  });

  it("consume returns the user id and marks the email verified", async () => {
    const userId = await track(false);
    const token = await createLoginLink(userId);
    expect(await consumeLoginLink(token)).toBe(userId);
    const [{ email_verified }] = await sql<{ email_verified: boolean }[]>`
      select email_verified from users where id = ${userId}`;
    expect(email_verified).toBe(true);
  });

  it("is single-use", async () => {
    const userId = await track();
    const token = await createLoginLink(userId);
    expect(await consumeLoginLink(token)).toBe(userId);
    expect(await consumeLoginLink(token)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await consumeLoginLink(`nope-${randomUUID()}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const userId = await track();
    const token = `expired-${randomUUID()}`;
    await sql`
      insert into login_links (user_id, token, expires_at)
      values (${userId}, ${token}, now() - interval '1 minute')`;
    expect(await consumeLoginLink(token)).toBeNull();
  });

  it("issuing a new link invalidates the previous unused one", async () => {
    const userId = await track();
    const first = await createLoginLink(userId);
    const second = await createLoginLink(userId);
    expect(await consumeLoginLink(first)).toBeNull();
    expect(await consumeLoginLink(second)).toBe(userId);
  });

  // -------------------------------------------------------------------------
  // issueLoginLink (email outbox, Task 6): the same delete + insert as createLoginLink, on the handle it is given, so the
  // sign-in route can write the token and the outbox row in ONE transaction.
  // -------------------------------------------------------------------------
  const liveRows = (userId: string) =>
    sql<{ token: string; expires_at: Date; used: boolean }[]>`
      select token, expires_at, used from login_links where user_id = ${userId} order by created_at, id`;

  it("issueLoginLink returns the token and the expiry it stored: the row holds exactly them, TTL ahead of the clock", async () => {
    const userId = await track();
    const t0 = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    let issued: { token: string; expiresAt: Date };
    try {
      issued = await sql.begin((tx) => issueLoginLink(userId, tx));
    } finally {
      vi.useRealTimers();
    }
    expect(issued.expiresAt.getTime()).toBe(t0.getTime() + LOGIN_LINK_TTL_MS);
    const rows = await liveRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(issued.token);
    expect(rows[0]!.expires_at.getTime()).toBe(issued.expiresAt.getTime());
    expect(rows[0]!.used).toBe(false);
    expect(await consumeLoginLink(issued.token)).toBe(userId);
  });

  it("issueLoginLink on the pool is the same: issuing twice keeps only the newer unused link", async () => {
    const userId = await track();
    const first = await issueLoginLink(userId, sql);
    const second = await issueLoginLink(userId, sql);
    expect(first.token).not.toBe(second.token);
    expect((await liveRows(userId)).map((r) => r.token)).toEqual([second.token]);
  });

  it("a rolled-back transaction leaves nothing new AND keeps the older unused link (the delete rolls back too)", async () => {
    const userId = await track();
    const older = await createLoginLink(userId);
    const boom = new Error("boom");
    await expect(
      sql.begin(async (tx) => {
        await issueLoginLink(userId, tx);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await liveRows(userId)).map((r) => r.token)).toEqual([older]);
    expect(await consumeLoginLink(older)).toBe(userId);
  });

  it("a link issued inside a transaction is invisible to other connections until it commits", async () => {
    const userId = await track();
    let seenInside: number | undefined;
    await sql.begin(async (tx) => {
      await issueLoginLink(userId, tx);
      seenInside = (await liveRows(userId)).length; // the pool, a different connection
    });
    expect(seenInside).toBe(0);
    expect(await liveRows(userId)).toHaveLength(1);
  });

  it("createLoginLink keeps its signature: it resolves to the token string alone", async () => {
    const userId = await track();
    const token = await createLoginLink(userId);
    expect(typeof token).toBe("string");
    expect((await liveRows(userId)).map((r) => r.token)).toEqual([token]);
  });
});

describe("the sign-in link's lifetime", () => {
  it("is the number of minutes the email promises (read from the copy, not from the code)", () => {
    const promised = /expires in (\d+) minutes/.exec(emails["magicLink.body" as keyof typeof emails] as string);
    expect(promised, "the dictionary names a number of minutes").not.toBeNull();
    expect(LOGIN_LINK_TTL_MS).toBe(Number(promised![1]) * 60_000);
  });
});
