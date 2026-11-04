// The division page's `robots` metadata — link-only pages keep crawlers out
// (doc 09 §1). Owner decision 2026-09-27: a DRAFT is unlisted until published,
// so a draft's division page is link-only exactly as an unlisted
// competition's is, and takes the same value. A published or archived public
// competition's page stays indexable.
//
// Same harness as `page-share-dict.test.ts`: the data door mocked, the real
// dictionaries behind it.
import { describe, expect, it, vi } from "vitest";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));

import { generateMetadata } from "../page";

const divisionData = (competition: { visibility: string; status: string }) => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Test Comp",
    slug: "test-comp",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    ...competition,
  },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open" },
});

const robotsFor = async (competition: { visibility: string; status: string }) => {
  getPublicDivision.mockResolvedValue(divisionData(competition));
  const m = await generateMetadata({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  return m.robots;
};

describe("division page generateMetadata — link-only robots", () => {
  it("keeps a public DRAFT's division out of the index like an unlisted one", async () => {
    expect(await robotsFor({ visibility: "public", status: "draft" })).toEqual({ index: false, follow: false });
    expect(await robotsFor({ visibility: "unlisted", status: "published" })).toEqual({ index: false, follow: false });
  });

  it("leaves a published or archived public competition's division indexable (the positive pair)", async () => {
    expect(await robotsFor({ visibility: "public", status: "published" })).toBeUndefined();
    expect(await robotsFor({ visibility: "public", status: "archived" })).toBeUndefined();
  });
});
