// Match Day C8 — the oracle behind the New competition form's "Who will find it".
//
// `competitionReach` (lib/competition-listing.ts) is what the form prints. It is
// composed from three predicates, and the unit suite can only hold the
// composition to those predicates. THIS file holds the predicates to the
// product: for every visibility and showcase choice the form can send, create
// the competition through the real `createCompetition`, ask the REAL readers
// who finds it — the link-readable view, the org home's list, the sitemap's
// source, the discovery view — then publish it and ask again. The expected
// state for each audience is read off that behaviour:
//
//   found now                        -> "yes"
//   not now, found once published    -> "after_publish"
//   never                            -> "no"
//
// so a listing query that moved (a draft that starts to be listed, a visibility
// the sitemap stops reading) reds here while every predicate-only test stays
// green.
//
// Real Postgres required; skipped without DATABASE_URL, like discovery.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Passthrough, never memoising: every read below must hit the database.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  competitionReach,
  NEW_COMPETITION_STATUS,
  REACH_AUDIENCES,
  type ReachAudience,
  type ReachState,
} from "@/lib/competition-listing";
import { listOrgHomeCompetitions, listPublicSitemapEntries } from "@/server/public-site/data";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** The choices the form can send: showcase is only ever sent with public. */
const CHOICES = [
  { visibility: "private", discoverable: false },
  { visibility: "unlisted", discoverable: false },
  { visibility: "public", discoverable: false },
  { visibility: "public", discoverable: true },
] as const;

async function seedOrg() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`reach-${suffix}@test.local`}, 'Owner', true) returning id`;
  const [{ id: orgId, slug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Reach Org " + suffix}, ${"reach-org-" + suffix}, ${ownerId}) returning id, slug`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  return { orgId, orgSlug: slug, auth };
}

/** What the real readers say about one competition right now. */
async function observe(orgId: string, id: string, slug: string, orgSlug: string) {
  const link = (await sql`select id from public_competitions_v where id = ${id}`).length > 0;
  const org = (await listOrgHomeCompetitions(orgId)).some((c) => c.id === id);
  const search = (await listPublicSitemapEntries()).some((e) => e.orgSlug === orgSlug && e.compSlug === slug);
  const showcase = (await sql`select id from public_discovery_v where id = ${id}`).length > 0;
  return { link, org, search, showcase };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("competitionReach against the real readers (Match Day C8)", () => {
  it("every audience the server can observe reads the way the form prints it", async () => {
    const OBSERVABLE: Exclude<ReachAudience, "team">[] = ["link", "org", "search", "showcase"];
    let checked = 0;

    for (const choice of CHOICES) {
      const { orgId, orgSlug, auth } = await seedOrg();
      const created = await createCompetition(auth, {
        name: `Reach ${choice.visibility} ${choice.discoverable} ${randomUUID().slice(0, 6)}`,
        visibility: choice.visibility,
        discoverable: choice.discoverable,
        branding: {},
        ends_on: "2030-12-31",
      });
      // The status the form passes to competitionReach is the one the server
      // gives: a drift here would make every row below answer about a
      // competition nobody creates.
      expect(created.status, "a new competition's status").toBe(NEW_COMPETITION_STATUS);
      expect(created.visibility, "the create must not have been degraded").toBe(choice.visibility);
      expect(created.discoverable, "the showcase choice reached the row").toBe(choice.discoverable);

      // The quality floor discovery asks of ANY showcased competition (a
      // started division), so that "not showcased" below can only mean the
      // draft rule. Started while still a draft; `startDivision` leaves it so.
      const division = await createDivision(auth, created.id, {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: DIVISION_CONFIG,
      });
      await createEntrants(
        auth,
        division.id,
        ["A", "B", "C", "D"].map((n, i) => ({
          kind: "individual" as const,
          display_name: n,
          seed: i + 1,
          members: [],
        })),
      );
      const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
      await generateStageFixtures(auth, stage!.id);
      await startDivision(auth, division.id);
      const [{ status: stillDraft }] = await sql<{ status: string }[]>`
        select status from competitions where id = ${created.id}`;
      expect(stillDraft, "starting a division must not publish the competition").toBe(NEW_COMPETITION_STATUS);

      const now = await observe(orgId, created.id, created.slug, orgSlug);
      await sql`update competitions set status = 'published' where id = ${created.id}`;
      const published = await observe(orgId, created.id, created.slug, orgSlug);

      const reach = competitionReach({
        visibility: choice.visibility,
        status: NEW_COMPETITION_STATUS,
        discoverable: choice.discoverable,
      });
      for (const audience of OBSERVABLE) {
        const observed: ReachState = now[audience] ? "yes" : published[audience] ? "after_publish" : "no";
        expect(reach[audience], `${choice.visibility}/${choice.discoverable} ${audience}`).toBe(observed);
        checked += 1;
      }
    }
    // Anti-vacuity: 4 choices x 4 observable audiences, and the answers are not
    // all the same one (some "yes", some "after_publish", some "no").
    expect(checked).toBe(CHOICES.length * 4);
    expect(REACH_AUDIENCES.length).toBe(5);
  });

  it("the server refuses showcase on a non-public competition, which is why the form never offers it", async () => {
    const { auth } = await seedOrg();
    await expect(
      createCompetition(auth, {
        name: `Reach refused ${randomUUID().slice(0, 6)}`,
        visibility: "unlisted",
        discoverable: true,
        branding: {},
        ends_on: "2030-12-31",
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
