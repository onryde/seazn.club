// Fix round 1 of N1, finding I1 — the public fixture page names a WAITING side
// with the match centre's own words, never a second resolution of its own.
//
// N1 made the match centre read "Winner of Semi-finals, match 1" for a side
// waiting on a match, while this page kept resolving the stored slot label
// through `resolveSlotLabel` — the organiser board's "Winner of R1·1". One
// waiting final then read "Winner of R1·1 vs Winner of R1·2" in its h1, its
// <title> and its share text, directly above a court card that said "Winner of
// Semi-finals, match 1". The page already holds the match-centre document, so
// it takes an unfilled side's name from there: one authority, no extra query.
//
// Driven through the REAL `getPublicFixture` (real Postgres, a real generated
// knockout), so every expected name below is read out of the loader's own
// output — the same document the court card renders — never typed in here.
// Skipped without DATABASE_URL, like every DB-backed suite here.
import { afterAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `unstable_cache` is a Next server-runtime API with no incremental cache
// outside a real request: a passthrough, never a memoising double.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
// The page's match centre reads `?tab=` client-side (`useSearchParams`); the
// rest of `next/navigation` stays real, as in `page.test.ts` beside this file.
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

import { sql } from "@/lib/db";
import { getDictionary, t } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { posterFileName } from "@/lib/poster-file-name";
import { ShareButton } from "@/components/share-button";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { getPublicFixture } from "@/server/public-site/data";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import FixturePage, { generateMetadata } from "../page";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const en = (key: Parameters<typeof msgFor>[1], vars?: Record<string, string | number>) => msgFor("en", key, vars);

/** A public, English, generated and unplayed 4-draw: its final waits on both
 *  semi-finals. Returns the slugs the page's route params carry and the final. */
async function waitingFinal() {
  const { auth } = await seedOrg("pro");
  // English on purpose: the words are derived below, but one locale keeps the
  // failure message readable.
  await sql`update organizations set default_locale = 'en' where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "I1 Waiting Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Knockout", config: {} });
  await generateStageFixtures(auth, stage!.id);
  const [final] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id} and home_entrant_id is null and away_entrant_id is null`;
  const [slugs] = await sql<{ org: string; competition: string; division: string }[]>`
    select o.slug as org, c.slug as competition, d.slug as division
    from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  return {
    params: Promise.resolve({
      orgSlug: slugs!.org,
      competitionSlug: slugs!.competition,
      divisionSlug: slugs!.division,
      fixtureId: final!.id,
    }),
    route: { ...slugs!, fixtureId: final!.id },
  };
}

function findElement(node: unknown, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement((node.props as { children?: unknown }).children, type);
}

/** An element's text as a reader sees it: tags and React's text separators gone. */
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe.skipIf(!HAS_DB)("the public fixture page — a waiting side reads the match centre's name (N1 fix round 1, I1)", () => {
  it("a final waiting on both semi-finals: <title>, description, h1, share text and poster name all use the court card's side names", async () => {
    const { params, route } = await waitingFinal();
    const data = (await getPublicFixture(route.org, route.competition, route.division, route.fixtureId))!;
    expect(data, "the generated final reaches the public page").not.toBeNull();

    // The premise, out of the loader: both sides wait, and the court card's
    // names are NOT the board's text for the same stored labels — so an
    // assertion below that passes could not have passed on the old page.
    const sides = data.matchCentre.header.sides;
    expect(sides.map((s) => s.entrantId)).toEqual(["", ""]);
    const [home, away] = sides.map((s) => s.name) as [string, string];
    const boardText = [data.fixture.home_slot_label, data.fixture.away_slot_label].map((label) =>
      resolveSlotLabel(label as SlotLabel | null, en, "schedule.tbd"),
    );
    expect([home, away]).not.toEqual(boardText);
    expect(`${home} ${away}`).not.toMatch(/R\d+·\d+/);

    const ui = await getDictionary("en", "ui");
    const meta = await generateMetadata({ params });
    expect(meta.title).toBe(t(ui, "fixture.meta.title", { home, away, division: data.division.name }));
    expect(meta.description).toBe(
      t(ui, "fixture.meta.description", { home, away, competition: data.competition.name }),
    );

    const tree = await FixturePage({ params });
    const html = renderToStaticMarkup(tree);

    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    expect(h1, "the page renders its h1").not.toBeNull();
    expect(textOf(h1![1]!)).toBe(`${home} ${en("schedule.vs")} ${away}`);

    // The court card below it says the same two names.
    const card = html.indexOf('data-testid="mc-court-card"');
    expect(card, "the match centre's court card renders").toBeGreaterThanOrEqual(0);
    const cardText = textOf(html.slice(card));
    expect(cardText).toContain(home);
    expect(cardText).toContain(away);

    // Share and poster carry the same names.
    const share = findElement(tree, ShareButton);
    expect(share, "the page mounts its ShareButton").not.toBeNull();
    expect(share!.props.title).toBe(`${home} ${en("schedule.vs")} ${away}`);
    expect(String(share!.props.text)).toContain(home);
    expect(String(share!.props.text)).toContain(away);
    expect(html).toContain(`download="${posterFileName(home, away)}"`);

    // SportsEvent JSON-LD names the same two teams.
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(ld, "the page renders its JSON-LD").not.toBeNull();
    const event = JSON.parse(ld![1]!) as { homeTeam?: { name?: string }; awayTeam?: { name?: string } };
    expect([event.homeTeam?.name, event.awayTeam?.name]).toEqual([home, away]);
  });
});
