// Privacy hotfix (2026-09-16) — the division page's Entrants tab linked every
// squad member with a `person_id` to their player card, while it printed that
// member under the division's MASKED name ("Arun K."). The card printed the
// full name, so the link undid the mask. A member is linked only when the name
// the page shows is the full name.
//
// DB-backed: the page is called with the REAL `getPublicDivision` (and the real
// suspensions read); only `unstable_cache` is a pass-through. The server
// component's returned tree is walked for its player-card links and its
// Entrants panel, which are server-only markup (no client island is rendered).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import Link from "next/link";
import DivisionHomePage from "../page";
import {
  closeSql,
  OPEN_FULL,
  seedYouthNameScene,
  YOUTH_MASKED,
  type YouthNameScene,
} from "@/server/public-site/__tests__/_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function renderDivision(s: YouthNameScene, divisionSlug: string) {
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: s.orgSlug, competitionSlug: s.compSlug, divisionSlug }),
  });
  const all = elements(root);
  const playerLinks = all
    .filter((el) => el.type === Link && String((el.props as { href?: unknown }).href).includes("/players/"))
    .map((el) => renderToStaticMarkup(el));
  const panels = all.filter(
    (el) => el.type === "ul" && (el.props as { className?: unknown }).className === "grid gap-3 sm:grid-cols-2",
  );
  expect(panels, "the page renders one Entrants panel").toHaveLength(1);
  return { playerLinks, panel: renderToStaticMarkup(panels[0]!) };
}

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("public division page — a member is linked to the player card only when shown in full", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  it("youth division: the member shows the masked name and carries NO player-card link", async () => {
    const { playerLinks, panel } = await renderDivision(s, s.youth.divisionSlug);
    expect(playerLinks, `player-card links rendered: ${playerLinks.join(" | ")}`).toEqual([]);
    expect(panel).not.toContain(`href="/shared/${s.orgSlug}/${s.compSlug}/players/`);
    expect(panel).toContain(`<span>${YOUTH_MASKED}</span>`);
    expect(panel).not.toContain("Kumar");
  });

  it("open division (positive pair): the consented member is linked to their card under the full name", async () => {
    const { playerLinks, panel } = await renderDivision(s, s.open.divisionSlug);
    const href = `href="/shared/${s.orgSlug}/${s.compSlug}/players/${s.open.personId}"`;
    expect(panel).toContain(href);
    expect(playerLinks).toHaveLength(1);
    expect(playerLinks[0]).toContain(href);
    expect(playerLinks[0]).toContain(`>${OPEN_FULL}</a>`);
  });
});
