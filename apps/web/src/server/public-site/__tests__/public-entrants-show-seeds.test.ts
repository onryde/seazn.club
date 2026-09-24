// `divisions.show_seeds` (V416) — an organiser can keep seed numbers off every
// public surface, against real Postgres.
//
// Seeds are an organiser's working data: a club night seeds by last season's
// ladder, a charity draw seeds nobody on purpose, and some organisers simply do
// not want "Seed 4" printed beside a paying entrant. Hiding the chip in CSS is
// not hiding it — the hub document, the division page's data, the embed and the
// anonymous `/api/v1/public/.../entrants` document all carry the number to
// anyone who asks. So the redaction lives at the ONE place every public reader
// shares: `public_entrants_v`, which publishes `seed` only while the entrant's
// division says so.
//
// And the ORDER leaks it too. Every public entrant reader sorts `seed nulls
// last, display_name`, so a list that printed no numbers but still came back
// in seed order would publish the seeding one line at a time. With the view's
// `seed` null, that sort falls through to the name. Both halves are asserted
// per surface: the number is gone AND the order is alphabetical.
//
// The scene makes the two orders DISAGREE — seed order is the reverse of
// alphabetical, with one unseeded entrant who sorts last by seed and second by
// name — so neither assertion can pass on the other's behalf. Every surface is
// asked about both divisions: `Shown` (the column's default, never written)
// proves the positive pair and the default in one, `Hidden` the redaction.
//
// Real Postgres required; skipped without DATABASE_URL, the same convention as
// `public-entrants-departed.test.ts`, whose seeding shape this reuses.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double, or one
// division's answer could be served for the other's.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants, listEntrants } from "@/server/usecases/entrants";
import { publicEntrants } from "@/server/usecases/public";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { loadCompetitionHub } from "../competition-hub";
import { getPublicDivision } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

/** Seed order is the REVERSE of alphabetical, and the unseeded entrant sits
 *  last by seed but second by name — so a surface that kept the seed sort
 *  while dropping the numbers cannot match `BY_NAME`. */
const SEATS = [
  { name: "Zara Top", seed: 1 },
  { name: "Mo Middle", seed: 2 },
  { name: "Abe Bottom", seed: 3 },
  { name: "Kai Unseeded", seed: null },
] as const;

type Seat = { name: string; seed: number | null };
const cmpName = (a: Seat, b: Seat) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** `order by seed nulls last, display_name`, spelled out here rather than read
 *  back from the database under test. */
const BY_SEED: Seat[] = [...SEATS].sort((a, b) =>
  a.seed === b.seed ? cmpName(a, b) : a.seed === null ? 1 : b.seed === null ? -1 : a.seed - b.seed,
);
const BY_NAME: Seat[] = [...SEATS].sort(cmpName);

interface Scene {
  auth: AuthCtx;
  orgId: string;
  orgSlug: string;
  compSlug: string;
  shown: { id: string; slug: string };
  hidden: { id: string; slug: string };
}

let scene: Scene;

async function seed(): Promise<Scene> {
  // Pro: `embedDivisionData` answers `not_entitled` without `embeds.enabled`.
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const suffix = randomUUID().slice(0, 8);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Seedless Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = async (name: string) => {
    const d = await createDivision(auth, competition.id, {
      name,
      slug: `${name.toLowerCase()}-${suffix}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      d.id,
      SEATS.map((s) => ({ kind: "individual" as const, display_name: s.name, seed: s.seed, members: [] })),
    );
    return { id: d.id, slug: d.slug };
  };
  const shown = await division("Shown");
  const hidden = await division("Hidden");
  // Written straight onto the row: this file is about what the READERS publish,
  // and PATCH /api/v1/divisions/{id} carrying `show_seeds` has its own suite
  // (`app/api/v1/divisions/[id]/__tests__/show-seeds-route.test.ts`). `Shown`
  // is never written at all, so it stands on the column's default.
  await sql`update divisions set show_seeds = false where id = ${hidden.id}`;
  return { auth, orgId: auth.orgId, orgSlug, compSlug: competition.slug, shown, hidden };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // Best effort: this suite's rows are its own org, and leaving them behind
  // inflates a shared local test database until unrelated suites time out.
  if (scene?.orgId) {
    await sql`delete from organizations where id = ${scene.orgId}`.catch(() => undefined);
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The two answers every surface owes, as `[name, seed]` pairs in the order it
 *  published them. One `toEqual` per division pins membership, order and every
 *  seed together. */
const expectedFor = (division: "shown" | "hidden"): [string, number | null][] =>
  division === "shown" ? BY_SEED.map((s) => [s.name, s.seed]) : BY_NAME.map((s) => [s.name, null]);

describe.skipIf(!HAS_DB)("V416 — show_seeds", () => {
  it("premise: the two orders disagree, and a new division shows its seeds by default", async () => {
    expect(BY_SEED.map((s) => s.name)).not.toEqual(BY_NAME.map((s) => s.name));
    const [{ show_seeds }] = await sql<{ show_seeds: boolean }[]>`
      select show_seeds from divisions where id = ${scene.shown.id}`;
    expect(show_seeds).toBe(true);
  });

  it("public_entrants_v publishes seed only for a division that shows it", async () => {
    for (const division of ["shown", "hidden"] as const) {
      const rows = await sql<{ display_name: string; seed: number | null }[]>`
        select display_name, seed from public_entrants_v
        where division_id = ${scene[division].id}
        order by seed nulls last, display_name`;
      expect(
        rows.map((r) => [r.display_name, r.seed]),
        `${division}: the view's rows`,
      ).toEqual(expectedFor(division));
    }
  });

  it("the organiser's own entrant list keeps every seed, hidden or not", async () => {
    // The negative's positive pair on the ADMIN side: the setting redacts what
    // the public reads, never the data itself.
    const rows = await listEntrants(scene.auth, scene.hidden.id);
    expect(
      rows.map((r) => [r.display_name, r.seed]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    ).toEqual(BY_NAME.map((s) => [s.name, s.seed]));
  });

  it("getPublicDivision() — the division page, calendar and poster data", async () => {
    for (const division of ["shown", "hidden"] as const) {
      const data = await getPublicDivision(scene.orgSlug, scene.compSlug, scene[division].slug);
      expect(data, `${division}: no public division`).toBeTruthy();
      expect(
        data!.entrants.map((e) => [e.display_name, e.seed]),
        `${division}: the page's entrants`,
      ).toEqual(expectedFor(division));
    }
  });

  it("loadCompetitionHub() — the hub document's Teams cards", async () => {
    const doc = await loadCompetitionHub(scene.orgSlug, scene.compSlug);
    expect(doc, "no hub document").toBeTruthy();
    for (const division of ["shown", "hidden"] as const) {
      const cards = doc!.teams.filter((t) => t.divisionId === scene[division].id);
      expect(
        cards.map((t) => [t.name, t.seed]),
        `${division}: the hub's team cards`,
      ).toEqual(expectedFor(division));
    }
  });

  it("publicEntrants() — the anonymous /api/v1/public entrants document", async () => {
    for (const division of ["shown", "hidden"] as const) {
      const payload = (await publicEntrants(scene.orgSlug, scene.compSlug, scene[division].slug)) as {
        entrants: { display_name: string; seed: number | null }[];
      };
      expect(
        payload.entrants.map((e) => [e.display_name, e.seed]),
        `${division}: the API's entrants`,
      ).toEqual(expectedFor(division));
    }
  });

  it("embedDivisionData() — the website embed", async () => {
    for (const division of ["shown", "hidden"] as const) {
      const res = await embedDivisionData(scene[division].id);
      expect(res.ok, `${division}: embed refused`).toBe(true);
      if (!res.ok) continue;
      expect(
        res.data.entrants.map((e) => [e.display_name, e.seed]),
        `${division}: the embed's entrants`,
      ).toEqual(expectedFor(division));
    }
  });
});
