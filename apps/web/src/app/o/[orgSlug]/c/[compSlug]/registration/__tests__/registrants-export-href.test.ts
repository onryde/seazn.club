// RS005 F3 finding 2 — `registrantsExportHrefFor` wraps the sibling-owned
// `registrantsExportHref` (registration-hub-registrant-derive.ts, this
// wave's do-not-touch list): that function's own `registrantsQueryString`
// only ever emits the "1" form of free_agent/consent_pending, because both
// fields were plain booleans everywhere until this wave. A table explicitly
// narrowed to the negative case (`?free_agent=0`) therefore produced an
// export link that silently dropped the filter — the exported CSV could
// disagree with the table the organiser was looking at.
//
// Rather than editing the owned-by-another-agent file, this wraps its
// result and appends the explicit "0" only when the table is ACTUALLY
// narrowed to the negative case (an explicit `false` — never a bare
// "unset" `null`, which must stay absent from the query string, same as
// every other filter here). Every other param (status/division_id/kind/q/
// sort, and the "1" form) stays exactly what `registrantsExportHref`
// already builds — no second hand-kept copy of that logic.
import { describe, expect, it } from "vitest";
import { registrantsExportHrefFor } from "../data";
import type { RegistrantsFilters } from "../data";

const BASE: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  freeAgent: null,
  consentPending: null,
  text: "",
  sort: "newest",
};
const COMPETITION_ID = "comp-1";
const BASE_HREF = "/api/v1/competitions/comp-1/registrations/export?sort=newest";

describe("registrantsExportHrefFor", () => {
  it("matches registrantsExportHref's own output when nothing is explicitly false — unset stays absent", () => {
    expect(registrantsExportHrefFor(COMPETITION_ID, BASE)).toBe(BASE_HREF);
  });

  it("still carries the '1' form when a filter is explicitly ON — unchanged from registrantsExportHref", () => {
    const href = registrantsExportHrefFor(COMPETITION_ID, { ...BASE, freeAgent: true, consentPending: true });
    expect(href).toContain("free_agent=1");
    expect(href).toContain("consent_pending=1");
    expect(href).not.toContain("free_agent=0");
    expect(href).not.toContain("consent_pending=0");
  });

  it("appends the explicit '0' when the table is narrowed to the negative case (RS005 F3 finding 2)", () => {
    expect(registrantsExportHrefFor(COMPETITION_ID, { ...BASE, freeAgent: false })).toBe(
      `${BASE_HREF}&free_agent=0`,
    );
  });

  it("carries both explicit negatives together", () => {
    const href = registrantsExportHrefFor(COMPETITION_ID, {
      ...BASE,
      freeAgent: false,
      consentPending: false,
    });
    expect(href).toBe(`${BASE_HREF}&free_agent=0&consent_pending=0`);
  });

  it("never emits free_agent/consent_pending at all when unset (null) — distinct from the explicit-false case", () => {
    const href = registrantsExportHrefFor(COMPETITION_ID, BASE);
    expect(href).not.toContain("free_agent");
    expect(href).not.toContain("consent_pending");
  });

  it("still carries status/division_id/kind/q/sort exactly as registrantsExportHref builds them", () => {
    const href = registrantsExportHrefFor(COMPETITION_ID, {
      ...BASE,
      status: "paid",
      divisionId: "div-1",
      kind: "team",
      text: "Alex",
      sort: "oldest",
      consentPending: false,
    });
    expect(href).toBe(
      "/api/v1/competitions/comp-1/registrations/export?" +
        "status=paid&division_id=div-1&kind=team&q=Alex&sort=oldest&consent_pending=0",
    );
  });
});
