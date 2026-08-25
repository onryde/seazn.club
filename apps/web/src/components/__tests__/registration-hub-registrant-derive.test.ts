// RS005 W2a — pure derivations feeding the Registrants tab's table/filters:
// the status-pill style map, "is any filter active" (which empty state to
// show), and the CSV export href builder.
import { describe, expect, it } from "vitest";
import { RegistrationStatus } from "@/server/api-v1/schemas";
import {
  REGISTRANT_STATUS_STYLE,
  hasActiveFilters,
  registrantsExportHref,
} from "@/components/registration-hub-registrant-derive";
import type { RegistrantsFilters } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

const BASE: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  freeAgent: false,
  consentPending: false,
  text: "",
  sort: "newest",
};

describe("REGISTRANT_STATUS_STYLE", () => {
  // RS005 W1a's own history: a 'rejected' status was missed from a hand-kept
  // list not once but twice (the route allowlist AND the OpenAPI enum) before
  // RS005 W1b made RegistrationStatus.options the single source. A style map
  // keyed by hand is exactly that same drift class, so this iterates the real
  // enum rather than trusting a literal count.
  it("has a style entry for every real RegistrationStatus value", () => {
    for (const s of RegistrationStatus.options) {
      expect(REGISTRANT_STATUS_STYLE).toHaveProperty(s);
    }
  });

  it("declares no extra keys beyond the real status set", () => {
    expect(Object.keys(REGISTRANT_STATUS_STYLE).sort()).toEqual([...RegistrationStatus.options].sort());
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default (no filters) state", () => {
    expect(hasActiveFilters(BASE)).toBe(false);
  });

  it("is false when only sort differs from the default — sort orders, it doesn't narrow", () => {
    expect(hasActiveFilters({ ...BASE, sort: "oldest" })).toBe(false);
  });

  it("is true for each filter independently", () => {
    expect(hasActiveFilters({ ...BASE, status: "paid" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, divisionId: "d1" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, kind: "team" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, freeAgent: true })).toBe(true);
    expect(hasActiveFilters({ ...BASE, consentPending: true })).toBe(true);
    expect(hasActiveFilters({ ...BASE, text: "alex" })).toBe(true);
  });
});

describe("registrantsExportHref", () => {
  it("links straight at the /api/v1 export route — this codebase's convention, no client fetch (documents-menu.tsx)", () => {
    expect(registrantsExportHref("comp-1", BASE)).toBe(
      "/api/v1/competitions/comp-1/registrations/export?sort=newest",
    );
  });

  it("carries every active filter through, using the API's own query param names and 1/0 boolean convention", () => {
    const href = registrantsExportHref("comp-1", {
      status: "paid",
      divisionId: "div-1",
      kind: "team",
      freeAgent: true,
      consentPending: true,
      text: "Alex Smith",
      sort: "oldest",
    });
    const url = new URL(href, "https://test.local");
    expect(url.pathname).toBe("/api/v1/competitions/comp-1/registrations/export");
    expect(url.searchParams.get("status")).toBe("paid");
    expect(url.searchParams.get("division_id")).toBe("div-1");
    expect(url.searchParams.get("kind")).toBe("team");
    expect(url.searchParams.get("free_agent")).toBe("1");
    expect(url.searchParams.get("consent_pending")).toBe("1");
    expect(url.searchParams.get("q")).toBe("Alex Smith");
    expect(url.searchParams.get("sort")).toBe("oldest");
  });

  it("always includes sort, even at the default, so the export matches exactly what's on screen", () => {
    expect(registrantsExportHref("comp-1", BASE)).toContain("sort=newest");
  });
});
