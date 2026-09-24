// REGRESSION (prod, 2026-09-24): a fixture in a stage whose rules override the
// division's printed the DIVISION's preset name.
//
// southend-sports-community / badminton-2026 / boys-singles: division `short`
// ({bestOf:3, setTo:11, cap:15, …}), Swiss stage `rules` {bestOf:1, setTo:15,
// cap:21, finalSetTo:15, winBy:2}. Scoring used the overlay; the public match
// page's Info tab and header meta line (which the poster falls back to) read
// "Short (11 points)". Both loaders labelled from `division.variant_key`
// alone, which never sees the stage.
//
// Pinned THROUGH BOTH production loaders — `getPublicFixture` (the page) and
// `publicFixture` (the poll document that replaces the page's on every tick) —
// because the claim is that they agree, and a builder test cannot see a loader.
//
// Every expected string is resolved from the dictionaries the product renders
// (never retyped), and the overriding case is one whose right answer (15)
// differs from the wrong answer's constant (11) — AGENTS.md 19.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double this directory's siblings use. Real Postgres required; skipped
// without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { putStageRules } from "@/server/usecases/stage-rules";
import { publicFixture } from "@/server/usecases/public";
import type { MatchCentreDocT } from "../match-centre-schema";
import { getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

/** The prod Swiss stage's stored rules, exactly. */
const SWISS_RULES = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Seeded {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionConfig: Record<string, unknown>;
  /** A fixture of the stage that overrides the division's rules. */
  swissFixtureId: string;
  /** A fixture of the stage that does not. */
  leagueFixtureId: string;
}

/** The prod shape through the product's own writers: a public badminton
 *  `short` division with two stages, the first given the Swiss rules through
 *  `putStageRules` (the endpoint's usecase), the second left alone. */
async function seedProdShape(): Promise<Seeded> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Badminton 2026",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Boys Singles",
    sport_key: "badminton",
    variant_key: "short",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    ["Ada", "Bo", "Cy", "Di"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [swiss] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "Swiss", config: {} });
  const [league] = await createStages(auth, division.id, { seq: 2, kind: "league", name: "League", config: {} });
  await putStageRules(auth, swiss!.id, { rules: SWISS_RULES });
  const swissFixtures = await generateStageFixtures(auth, swiss!.id);
  const leagueFixtures = await generateStageFixtures(auth, league!.id);

  const [row] = await sql<
    { org_slug: string; comp_slug: string; div_slug: string; config: Record<string, unknown> }[]
  >`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  return {
    orgId: auth.orgId,
    orgSlug: row!.org_slug,
    compSlug: row!.comp_slug,
    divSlug: row!.div_slug,
    divisionConfig: row!.config,
    swissFixtureId: swissFixtures.fixtures[0]!.id,
    leagueFixtureId: leagueFixtures.fixtures[0]!.id,
  };
}

/** The Info tab's format row, as its `formatValue` param — the resolved label. */
function infoFormat(doc: MatchCentreDocT): unknown {
  const row = doc.info.rows.find((r) => r.label.key === "matchCentre.info.format");
  return row?.value.params?.format;
}

async function pageDoc(s: Seeded, fixtureId: string): Promise<MatchCentreDocT> {
  const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, fixtureId);
  expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
  return data!.matchCentre;
}

async function pollDoc(fixtureId: string): Promise<MatchCentreDocT> {
  const doc = (await publicFixture(fixtureId)) as { match_centre: MatchCentreDocT };
  return doc.match_centre;
}

describe.skipIf(!HAS_DB)("a fixture's public format label follows its STAGE's rules", () => {
  it("the overriding stage names the rules it is played at — 15 points, not the preset's 11 — on BOTH loaders", async () => {
    const s = await seedProdShape();
    const preset = msgFor("en", "variant.badminton.short");
    // The load-bearing difference: the wrong answer's number is not 15.
    expect(s.divisionConfig.setTo).not.toBe(SWISS_RULES.setTo);
    const expected = t(enPublic, "format.rules.oneGamePointsCap", {
      points: SWISS_RULES.setTo,
      cap: SWISS_RULES.cap,
    });

    for (const [loader, doc] of [
      ["getPublicFixture", await pageDoc(s, s.swissFixtureId)],
      ["publicFixture", await pollDoc(s.swissFixtureId)],
    ] as const) {
      expect(infoFormat(doc), `${loader}: Info tab format row`).toBe(expected);
      expect(doc.header.metaLine, `${loader}: header meta line`).toContain(expected);
      expect(doc.header.metaLine, `${loader}: the preset name is the defect`).not.toContain(preset);
    }
  }, 60_000);

  it("the stage beside it, with no override, keeps the preset name on both loaders — no copy change", async () => {
    const s = await seedProdShape();
    const preset = msgFor("en", "variant.badminton.short");
    for (const [loader, doc] of [
      ["getPublicFixture", await pageDoc(s, s.leagueFixtureId)],
      ["publicFixture", await pollDoc(s.leagueFixtureId)],
    ] as const) {
      expect(infoFormat(doc), `${loader}: Info tab format row`).toBe(preset);
      expect(doc.header.metaLine, `${loader}: header meta line`).toContain(preset);
    }
  }, 60_000);

  it("resolved in the ORG's locale, like the preset name it replaces", async () => {
    const s = await seedProdShape();
    await sql`update organizations set default_locale = 'es' where id = ${s.orgId}`;
    const expected = t(esPublic, "format.rules.oneGamePointsCap", {
      points: SWISS_RULES.setTo,
      cap: SWISS_RULES.cap,
    });
    expect(expected, "the Spanish line must differ from the English, or this proves nothing").not.toBe(
      t(enPublic, "format.rules.oneGamePointsCap", { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap }),
    );
    expect(infoFormat(await pageDoc(s, s.swissFixtureId))).toBe(expected);
    expect(infoFormat(await pollDoc(s.swissFixtureId))).toBe(expected);
  }, 60_000);

  it("a SCORED fixture is labelled from its frozen snapshot — the rules it was played under", async () => {
    // `resolveFixtureCfg` prefers `config_snapshot` over live config once a
    // fixture has history. A league-stage fixture frozen at Best of 5 (the
    // division edited after it was played) must say Best of 5, and the
    // untouched division fields read through the snapshot too.
    const s = await seedProdShape();
    const frozen = { ...s.divisionConfig, bestOf: 5 };
    await sql`
      update fixtures set config_snapshot = ${sql.json(frozen as never)}, config_snapshot_at = now()
      where id = ${s.leagueFixtureId}`;
    const expected = t(enPublic, "format.rules.bestOfPointsCap", {
      n: 5,
      points: s.divisionConfig.setTo as number,
      cap: s.divisionConfig.cap as number,
    });
    expect(infoFormat(await pageDoc(s, s.leagueFixtureId))).toBe(expected);
    expect(infoFormat(await pollDoc(s.leagueFixtureId))).toBe(expected);
  }, 60_000);
});
