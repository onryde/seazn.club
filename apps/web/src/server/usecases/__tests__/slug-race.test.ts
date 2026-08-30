// The slug pre-check is not a lock. `uniqueSlug` asks `taken()` whether a
// candidate is free and then hands it to a caller that inserts it some
// statements later — nothing holds that answer across the gap. Two concurrent
// creates of the same name in one org therefore both read "free", both insert,
// and the loser takes a raw Postgres 23505 straight into the API response,
// contradicting slugs.ts's own header ("Generated slugs never 409").
//
// These tests drive REAL concurrent transactions. A sequential double call to
// `uniqueSlug` passes today and always will — it proves nothing about the race.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createClub } from "@/server/usecases/clubs";
import { createPost } from "@/server/usecases/org-posts";
import { createFromTemplate } from "@/server/usecases/templates";
import { withUniqueSlug, SLUG_CONSTRAINT } from "@/server/usecases/slugs";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// `pro_plus` throughout: `clubs.hierarchy` is gated to that plan, and a
// PaymentRequiredError from a lower one would look like the race failing.
async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Race " + suffix}, ${"race-" + suffix})
    returning id`;
  await setOrgPlan(orgId, "pro_plus");
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

const compInput = (name: string) => ({
  name,
  visibility: "private" as const,
  branding: {},
  ends_on: "2030-12-31",
});

const divInput = (name: string) => ({
  name,
  sport_key: "generic",
  variant_key: "score",
  config: GENERIC_CONFIG,
});

/** Block until some backend is waiting on a lock we have not granted — i.e.
 *  the call under test has passed its slug pre-check and is now parked on the
 *  unique index. Polling the server beats a sleep: a sleep that is too short
 *  makes this test green for the wrong reason (no contention ever happened). */
async function waitForBlockedInsert(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks where not granted`;
    if (row!.n > 0) return;
    if (Date.now() > deadline) throw new Error("no blocked insert appeared — race not staged");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Stage the race deterministically: hold an UNCOMMITTED duplicate open while
 * `run` executes. `run`'s pre-check cannot see the held row, so it picks the
 * colliding candidate and then parks on the unique index; releasing the holder
 * is what turns that park into the 23505 the fix must absorb.
 *
 * Promise.all of two creates would NOT do this. Their interleaving is luck, and
 * the lucky order (first commits before second reads) is green against the
 * broken code — verified: the Promise.all version of this suite passed on the
 * unfixed tree.
 */
async function racingAgainst<T>(
  holdDuplicate: (tx: postgres.TransactionSql) => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const committed = new Promise<void>((r) => (release = r));
  let staged!: () => void;
  const isStaged = new Promise<void>((r) => (staged = r));

  const holder = sql.begin(async (tx) => {
    await holdDuplicate(tx as postgres.TransactionSql);
    staged();
    await committed;
  });
  await isStaged;

  const pending = run();
  try {
    await waitForBlockedInsert();
  } finally {
    release();
    await holder;
  }
  return pending;
}

describe.skipIf(!HAS_DB)("generated slugs under concurrency", () => {
  it("a competition whose checked slug is taken mid-flight retries instead of 23505ing", async () => {
    const { auth } = await seedOrg();

    const created = await racingAgainst(
      (tx) => tx`
        insert into competitions (org_id, name, slug, visibility, branding, ends_on)
        values (${auth.orgId}, 'Race Cup', 'race-cup', 'private', '{}', '2030-12-31')`.then(
        () => undefined,
      ),
      () => createCompetition(auth, compInput("Race Cup")),
    );
    expect(created.slug).toBe("race-cup-2");

    const rows = await sql<{ slug: string }[]>`
      select slug from competitions where org_id = ${auth.orgId} order by slug`;
    expect(rows.map((r) => r.slug)).toEqual(["race-cup", "race-cup-2"]);
  });

  it("a division whose checked slug is taken mid-flight retries within its competition", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, compInput("Div Race Cup"));

    const created = await racingAgainst(
      (tx) => tx`
        insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                               module_version)
        values (${comp.id}, 'Open', 'open', 'generic', 'score',
                ${tx.json(GENERIC_CONFIG as never)}, '1.0.0')`.then(() => undefined),
      () => createDivision(auth, comp.id, divInput("Open")),
    );
    expect(created.slug).toBe("open-2");
  });

  it("a club whose checked slug is taken mid-flight retries instead of 409ing on the NAME", async () => {
    // The pre-existing 23505 catch here reported "a club named 'X' already
    // exists", which is false under the race: no club of that name existed,
    // the SLUG was claimed a moment earlier.
    const { auth } = await seedOrg();

    // The held row carries an `external_ref` deliberately: `clubs` also has
    // `clubs_upsert_key (org_id, coalesce(external_ref, lower(trim(name))))`,
    // and without the ref this fixture would collide on the NAME too — the
    // 409 would then be correct and the slug race would go untested.
    const created = await racingAgainst(
      (tx) => tx`
        insert into clubs (org_id, name, slug, external_ref)
        values (${auth.orgId}, 'Race FC', 'race-fc', 'held-ref')`.then(() => undefined),
      () => createClub(auth, { name: "Race FC" }),
    );
    expect(created.slug).toBe("race-fc-2");
  });

  it("an org post whose checked slug is taken mid-flight retries instead of 23505ing", async () => {
    const { auth } = await seedOrg();

    const created = await racingAgainst(
      (tx) => tx`
        insert into org_posts (org_id, kind, status, slug, title, body_md)
        values (${auth.orgId}, 'news', 'draft', 'race-news', 'Race News', '')`.then(
        () => undefined,
      ),
      () => createPost(auth, auth.orgId, { title: "Race News" }),
    );
    expect(created.slug).toBe("race-news-2");
  });

  it("a competition RENAME whose checked slug is taken mid-flight retries", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, compInput("Before Rename"));

    const renamed = await racingAgainst(
      (tx) => tx`
        insert into competitions (org_id, name, slug, visibility, branding, ends_on)
        values (${auth.orgId}, 'After Rename', 'after-rename', 'private', '{}', '2030-12-31')`.then(
        () => undefined,
      ),
      () => patchCompetition(auth, comp.id, { name: "After Rename" }),
    );
    expect(renamed.slug).toBe("after-rename-2");
  });

  it("template instantiation retries the competition slug it lost mid-flight", async () => {
    const { auth } = await seedOrg();

    const result = await racingAgainst(
      (tx) => tx`
        insert into competitions (org_id, name, slug, visibility, branding, ends_on)
        values (${auth.orgId}, 'T20 Super League', 't20-super-league', 'private', '{}', '2030-12-31')`.then(
        () => undefined,
      ),
      () =>
        createFromTemplate(auth, {
          template_key: "t20-super8",
          name: "T20 Super League",
          ends_on: "2030-12-31",
          visibility: "private",
        }),
    );
    const [row] = await sql<{ slug: string }[]>`
      select slug from competitions where id = ${result.competitionId}`;
    expect(row!.slug).toBe("t20-super-league-2");
  });
});

describe.skipIf(!HAS_DB)("withUniqueSlug", () => {
  // The two failure modes a bare `catch (23505) { retry }` would ship.
  it("rethrows a 23505 raised by a DIFFERENT constraint instead of retrying it", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, compInput("Other Constraint"));
    await createDivision(auth, comp.id, divInput("Open"));

    await expect(
      withTenant(auth.orgId, (tx) =>
        withUniqueSlug(
          tx,
          {
            base: "unrelated",
            constraint: SLUG_CONSTRAINT.competitions,
            taken: async () => false,
          },
          // Violates divisions_competition_id_slug_key, not the competitions
          // one. Retrying would re-run this forever with a fresh competition
          // slug and the SAME division slug — an error no suffix can fix.
          (_slug, sp) => sp`
            insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                                   module_version)
            values (${comp.id}, 'Open', 'open', 'generic', 'score',
                    ${sp.json(GENERIC_CONFIG as never)}, '1.0.0')`,
        ),
      ),
    ).rejects.toThrow(/divisions_competition_id_slug_key/);
  });

  it("leaves the surrounding transaction usable after absorbing a conflict", async () => {
    // In Postgres a rejected statement aborts the WHOLE transaction, so a
    // retry that is not savepointed leaves every later statement failing 25P02.
    const { auth } = await seedOrg();
    await sql`
      insert into competitions (org_id, name, slug, visibility, branding, ends_on)
      values (${auth.orgId}, 'Held', 'held', 'private', '{}', '2030-12-31')`;

    const after = await withTenant(auth.orgId, async (tx) => {
      const settled = await withUniqueSlug(
        tx,
        {
          base: "held",
          constraint: SLUG_CONSTRAINT.competitions,
          // Lies, exactly as the real pre-check does under a live race.
          taken: async () => false,
        },
        async (slug, sp) => {
          await sp`
            insert into competitions (org_id, name, slug, visibility, branding, ends_on)
            values (${auth.orgId}, 'Retry', ${slug}, 'private', '{}', '2030-12-31')`;
          return slug;
        },
      );
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from competitions where org_id = ${auth.orgId}`;
      return { settled, n: row!.n };
    });

    expect(after.settled).toBe("held-2");
    expect(after.n).toBe(2);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
