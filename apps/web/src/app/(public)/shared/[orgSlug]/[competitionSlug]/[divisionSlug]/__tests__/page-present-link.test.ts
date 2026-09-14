// N1e e7 (review-n1d G2) — the public division page's link onto its /present
// kiosk read "Present ▸" in English whatever the org's locale. Its label is now
// the org-locale dictionary's `division.present`; the ▸ stays as an
// aria-hidden decoration, so the link's accessible name is the word alone.
//
// The page is an async server component: it is called with its data door
// mocked, and the kiosk link is found in the tree it returns (its client
// islands are never rendered here; node vitest has no DOM).
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import Link from "next/link";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import DivisionHomePage from "../page";

/** Every element anywhere in a server component's returned tree. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

const divisionData = (locale: string) => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: locale },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Test Comp",
    slug: "test-comp",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  },
  division: {
    id: "d1",
    competition_id: "c1",
    name: "Open",
    slug: "open",
    description: null,
    sport_key: "generic",
    variant_key: "score",
    status: "active",
    module_version: "1.0.0",
    tiebreakers: null,
    sport_name: null,
    entrant_count: 0,
  },
  stages: [],
  pools: [],
  fixtures: [],
  standings: [],
  entrants: [],
  tz: "UTC",
});

/** The page's link onto its /present kiosk: its markup and its label. */
async function presentLink(locale: string) {
  getPublicDivision.mockResolvedValue(divisionData(locale));
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  const links = elements(root).filter(
    (el) => el.type === Link && String((el.props as { href?: unknown }).href).endsWith("/present"),
  );
  expect(links, "the page has one link onto its kiosk").toHaveLength(1);
  const html = renderToStaticMarkup(links[0]! as ReactElement<{ children: ReactNode }>);
  const text = html.replace(/<[^>]+>/g, "");
  // The label as a whole: "Presentar" contains "Present", so a substring probe
  // cannot tell the two apart.
  return { html, text, label: text.replace("▸", "").trim() };
}

describe("public division page — the link onto its kiosk speaks the org's locale (N1e e7)", () => {
  it("es org: the label is the es dictionary's, the ▸ is decoration, and no English 'Present' is left", async () => {
    const [en, es] = await Promise.all([getDictionary("en", "public"), getDictionary("es", "public")]);
    expect(t(es, "division.present"), "the premise: es differs from en").not.toBe(t(en, "division.present"));

    const { html, text, label } = await presentLink("es");
    expect(html).toContain('href="/shared/test-org/test-comp/open/present"');
    expect(label).toBe(t(es, "division.present"));
    expect(label).not.toBe(t(en, "division.present"));
    expect(text).toContain("▸");
    expect(html).toMatch(/<span aria-hidden="true">▸<\/span>/);
  });

  it("en org (positive pair): the same probe sees the en label", async () => {
    const en = await getDictionary("en", "public");
    const { label } = await presentLink("en");
    expect(label).toBe(t(en, "division.present"));
  });
});
