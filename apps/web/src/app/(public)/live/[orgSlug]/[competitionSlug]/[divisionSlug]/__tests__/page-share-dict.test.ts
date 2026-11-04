// T16b re-review I-r2-1 — the division page's client dictionary is only what
// its islands read.
//
// The page wraps itself in a `<DictProvider>` so `ShareButton` (the one client
// island under it that reads copy — `useMsg("share.whatsapp" | "share.copied")`)
// speaks the org's locale. It handed that provider the WHOLE ui.json (324–365
// KB, es 94 KB gzipped), and a client component's props are serialised into
// the page's flight payload — on the most-shared public page. It now hands over
// `pickDictPrefixes(ui, ["share."])`.
//
// Same harness as `page-present-link.test.ts`: the async server component is
// called with its data door mocked, and the provider is found in the tree it
// returns.
import { describe, expect, it, vi } from "vitest";
import { cloneElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { DictProvider } from "@/components/i18n/dict-provider";
import { ShareButton } from "@/components/share-button";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
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

async function render(locale: string) {
  getPublicDivision.mockResolvedValue(divisionData(locale));
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  const all = elements(root);
  const providers = all.filter((el) => el.type === DictProvider);
  const shares = all.filter((el) => el.type === ShareButton);
  expect(providers, "the page mounts one DictProvider").toHaveLength(1);
  expect(shares, "the page mounts one ShareButton").toHaveLength(1);
  return { provider: providers[0]! as ReactElement<{ dict: Record<string, string>; locale: string }>, share: shares[0]! };
}

describe("public division page — the client dictionary carries only the keys its islands read (I-r2-1)", () => {
  it("premise: ui.json is large, and the share words differ between es and en", () => {
    expect(Object.keys(es).length).toBeGreaterThan(1000);
    expect(es["share.whatsapp"]).not.toBe(en["share.whatsapp"]);
  });

  it("the provider's dict is exactly the `share.*` keys, with the org locale's values", async () => {
    const { provider } = await render("es");
    const dict = provider.props.dict;
    const shareKeys = Object.keys(es).filter((k) => k.startsWith("share."));
    expect(Object.keys(dict).sort()).toEqual(shareKeys.sort());
    expect(Object.keys(dict)).toEqual(expect.arrayContaining(["share.whatsapp", "share.copied"]));
    for (const k of shareKeys) expect(dict[k], k).toBe(es[k as keyof typeof es]);
    expect(provider.props.locale).toBe("es");
    // What reaches the flight payload is this prop, serialised.
    expect(JSON.stringify(dict).length, "serialised dict bytes").toBeLessThan(1024);
  });

  it("the ShareButton under that provider still says the org locale's word (positive pair)", async () => {
    const { provider, share } = await render("es");
    const html = renderToStaticMarkup(cloneElement(provider, undefined, share));
    expect(html).toContain(es["share.whatsapp"]);
    expect(html).not.toContain(`>${en["share.whatsapp"]}<`);
  });
});
