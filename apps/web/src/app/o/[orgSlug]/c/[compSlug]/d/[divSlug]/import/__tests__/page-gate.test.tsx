// P11 (D6) — the division import page's own gate (design doc §7, R8):
// `requireDivisionPage` for auth/org scoping, then `hasFeature(orgId,
// "import.events")` — false -> notFound(), so the surface stays invisible to
// orgs without the grant during rollout. That is deliberate (the console
// itself carries no link here either), not an oversight, so it is worth
// locking down directly rather than trusting composition alone.
//
// The route (Task 5) is the actual write-path authority and answers 402/403
// regardless of what this page does — this test only proves the page's own
// composition: the gate, and the fixture id->no map it hands the client
// island for "fixture (linked)" rows.
//
// No DB here: `requireDivisionPage`/`hasFeature`/`listDivisionFixtures` are
// each mocked, same convention as
// app/o/[orgSlug]/c/[compSlug]/registration/__tests__/page.test.tsx.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const h = vi.hoisted(() => ({
  hasFeature: true,
  fixtures: [] as { id: string; fixture_no: number }[],
}));

vi.mock("@/server/page-auth", () => ({
  requireDivisionPage: async () => ({
    auth: { orgId: "org-1", userId: "user-1", role: "owner", via: "session", keyId: null },
    user: { id: "user-1" },
    org: { id: "org-1", slug: "riverside", name: "Riverside", role: "owner" },
    canEdit: true,
    competition: { id: "comp-1", slug: "summer" },
    division: { id: "div-1", slug: "open" },
  }),
}));

vi.mock("@/lib/entitlements", () => ({
  hasFeature: async () => h.hasFeature,
}));

vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: async () => h.fixtures,
}));

import Page from "../page";
import { ImportClient } from "../ImportClient";
import { walk, propsOf } from "@/components/__tests__/_hook-harness";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer", divSlug: "open" });

beforeEach(() => {
  h.hasFeature = true;
  h.fixtures = [];
});

describe("division import page — the import.events gate", () => {
  it("404s when the org lacks the import.events entitlement", async () => {
    h.hasFeature = false;
    await expect(Page({ params })).rejects.toThrow("NOT_FOUND");
  });

  it("renders the client island, with the resolved division id and an id->no fixture map, when the entitlement is granted", async () => {
    h.hasFeature = true;
    h.fixtures = [
      { id: "fx-1", fixture_no: 3 },
      { id: "fx-2", fixture_no: 4 },
    ];
    const tree = walk(await Page({ params }));
    const client = tree.find((e) => e.type === ImportClient);
    expect(client).toBeTruthy();
    const props = propsOf(client!);
    expect(props.divisionId).toBe("div-1");
    expect(props.orgSlug).toBe("riverside");
    expect(props.compSlug).toBe("summer");
    expect(props.divSlug).toBe("open");
    expect(props.fixtureNoById).toEqual({ "fx-1": 3, "fx-2": 4 });
  });
});
