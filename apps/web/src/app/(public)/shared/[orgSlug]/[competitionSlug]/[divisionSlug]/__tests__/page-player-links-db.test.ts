// Spectator W2 — the division page's Entrants tab links a player's name to
// their public card on EXACTLY the hub Teams tab's terms (owner ruling
// 2026-09-17, finding D1):
//   * the view published the person's id — `public_entrants_v` does that only
//     with the person's public-name consent AND the org's player-page
//     entitlement (`org_has_feature('dashboard.player_profiles')`), so that
//     column is the gate read, and this page adds no second one;
//   * the division shows FULL names — a masked name with a link is the full
//     name one click away.
// Both surfaces go through `playerLinkId` (lib/name-display.ts).
//
// Against real Postgres, with the page's own data door (`getPublicDivision`)
// unmocked, because the refusal lives in the view: a doubled reader would
// prove the double. Skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Passthrough, never memoising: the granted and denied reads below must each
// hit the database — a cached division read across them is the stale render
// the finding was first reported from.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import Link from "next/link";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import DivisionHomePage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Scene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  /** Full names. Entrant "Alpha", member Sam Carter (consent public_name). */
  openSlug: string;
  samId: string;
  /** `player_name_display = 'first_initial'`. Entrant "Bravo", member Kit
   *  Young (consent public_name) — the view publishes Kit's id; the name is
   *  masked to "Kit Y.". */
  maskedSlug: string;
  kitId: string;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `div-links-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Div Links " + suffix}, ${orgSlug})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  // `createCompetition` silently downgrades an over-cap public competition to
  // private; lift the cap so "public" is what was asked for.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;

  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Links Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = (slug: string) =>
    createDivision(auth, competition.id, {
      name: slug,
      slug,
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
  const open = await division("open");
  const masked = await division("masked");
  await sql`update divisions set player_name_display = 'first_initial' where id = ${masked.id}`;

  await createEntrants(auth, open.id, [{ kind: "team", display_name: "Alpha", seed: 1, members: [] }]);
  await createEntrants(auth, masked.id, [{ kind: "team", display_name: "Bravo", seed: 1, members: [] }]);
  const entrantId = async (divisionId: string) =>
    (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId}`)[0]!.id;
  const person = async (fullName: string) =>
    (await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, ${fullName}, ${sql.json({ public_name: true })}) returning id`)[0]!.id;
  const samId = await person("Sam Carter");
  const kitId = await person("Kit Young");
  await sql`
    insert into entrant_members (entrant_id, person_id, org_id, squad_number)
    values (${await entrantId(open.id)}, ${samId}, ${orgId}, 7),
           (${await entrantId(masked.id)}, ${kitId}, ${orgId}, 1)`;

  return { orgId, orgSlug, compSlug: competition.slug, openSlug: open.slug, samId, maskedSlug: masked.slug, kitId };
}

/** An explicit player-pages answer for the seeded org. */
async function setPlayerPages(value: boolean): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${scene.orgId}, 'dashboard.player_profiles', ${value}, 'test')
    on conflict (org_id, feature_key) do update set bool_value = excluded.bool_value`;
  await invalidateOrgEntitlements(scene.orgId);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Every element anywhere in a server component's returned tree (props
 *  included — the Entrants panel is handed to the client `Tabs` as a prop). */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

const textOf = (el: ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, "");

/** The division page's player links and the markup of the member line that
 *  carries `name`. */
async function renderDivision(divisionSlug: string, name: string) {
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: scene.orgSlug, competitionSlug: scene.compSlug, divisionSlug }),
  });
  const all = elements(root);
  const playerLinks = all
    .filter((el) => el.type === Link && String((el.props as { href?: unknown }).href).includes("/players/"))
    .map((el) => ({ href: String((el.props as { href?: unknown }).href), text: textOf(el) }));
  // The member line: the innermost <li> whose text is the name (plus squad number).
  const line = all.filter((el) => el.type === "li" && textOf(el).includes(name)).at(-1);
  return { playerLinks, lineHtml: line ? renderToStaticMarkup(line) : "(no line)" };
}

describe.skipIf(!HAS_DB)("division page Entrants tab — a name links to the player card on the hub's terms", () => {
  it("GRANTED, full names: the name links to the player's card", async () => {
    await setPlayerPages(true);
    const { playerLinks, lineHtml } = await renderDivision(scene.openSlug, "Sam Carter");
    const href = `/shared/${scene.orgSlug}/${scene.compSlug}/players/${scene.samId}`;
    expect(playerLinks).toEqual([{ href, text: "Sam Carter" }]);
    expect(lineHtml).toContain(`href="${href}"`);
  });

  it("DENIED: the same name is plain text — no card link anywhere on the page, and no href or player id on its member line", async () => {
    await setPlayerPages(false);
    try {
      const { playerLinks, lineHtml } = await renderDivision(scene.openSlug, "Sam Carter");
      expect(playerLinks).toEqual([]);
      expect(lineHtml).toContain(">Sam Carter<");
      expect(lineHtml).not.toContain('href="');
      expect(lineHtml).not.toContain(scene.samId);
    } finally {
      await setPlayerPages(true);
    }
  });

  it("GRANTED but the division masks names: 'Kit Y.' is plain text, never a link to the full name", async () => {
    await setPlayerPages(true);
    const { playerLinks, lineHtml } = await renderDivision(scene.maskedSlug, "Kit Y.");
    expect(lineHtml, "premise: the division masks the name").toContain(">Kit Y.<");
    expect(playerLinks).toEqual([]);
    expect(lineHtml).not.toContain('href="');
    expect(lineHtml).not.toContain(scene.kitId);
  });
});
