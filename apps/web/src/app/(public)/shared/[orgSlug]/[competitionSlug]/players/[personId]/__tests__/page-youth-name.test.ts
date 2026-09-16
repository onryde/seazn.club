// Privacy hotfix (2026-09-16) — the public player card printed a youth
// player's FULL name in its <title>, its meta description and its h1, and
// showed their photo, while the division page listed the same player masked
// ("Arun K."). The mask now lives in `getPublicPlayer`, so every consumer of
// the card's data (page, metadata) reads the masked name.
//
// DB-backed: the page and `generateMetadata` run on the REAL `getPublicPlayer`;
// only `unstable_cache` is a pass-through. The card is server-only markup, so
// the whole returned tree renders to static HTML.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import PlayerCardPage, { generateMetadata } from "../page";
import {
  closeSql,
  OPEN_FULL,
  seedYouthNameScene,
  YOUTH_MASKED,
  type YouthNameScene,
} from "@/server/public-site/__tests__/_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("public player card — name and photo follow the division name policy", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  const params = (personId: string) =>
    ({ params: Promise.resolve({ orgSlug: s.orgSlug, competitionSlug: s.compSlug, personId }) });

  it("youth player: <title> and meta description carry the masked name, never the full name", async () => {
    const meta = await generateMetadata(params(s.youth.personId));
    expect(meta.title).toBe(`${YOUTH_MASKED} — ${s.compName}`);
    expect(String(meta.description)).toContain(YOUTH_MASKED);
    expect(JSON.stringify(meta)).not.toContain("Kumar");
  });

  it("youth player: the h1 is the masked name, no photo is rendered, and the full name is nowhere on the card", async () => {
    const html = renderToStaticMarkup(await PlayerCardPage(params(s.youth.personId)));
    expect(html).toMatch(new RegExp(`>${YOUTH_MASKED.replace(".", "\\.")}</h1>`));
    expect(html).not.toContain("Kumar");
    expect(html).not.toContain("<img");
    expect(html).not.toContain(`src="${s.youth.photo}"`);
  });

  it("open player (positive pair): title, h1 and photo carry the full name", async () => {
    const meta = await generateMetadata(params(s.open.personId));
    expect(meta.title).toBe(`${OPEN_FULL} — ${s.compName}`);
    const html = renderToStaticMarkup(await PlayerCardPage(params(s.open.personId)));
    expect(html).toContain(`>${OPEN_FULL}</h1>`);
    expect(html).toContain(`src="${s.open.photo}"`);
    expect(html).toContain(`alt="${OPEN_FULL}"`);
  });
});
