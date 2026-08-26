// RS006 §C — the post-submit status page's minimal render. Same
// renderToStaticMarkup pattern as register-page-live.test.tsx (no jsdom in
// this workspace) and the same "mock the usecase, not the DB" convention.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

const groupByIdMock = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock("@/server/usecases/registrations", () => ({
  groupById: (...args: unknown[]) => groupByIdMock.impl(...args),
}));

beforeEach(() => {
  groupByIdMock.impl.mockReset();
});

import StatusPage from "../page";

const render = async (searchParams: Record<string, string>): Promise<string> =>
  renderToStaticMarkup(
    await StatusPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

const BASE_VIEW = {
  ref_code: "SZ-TEST-01",
  contact_name: "Alex Test",
  currency: "gbp",
  amount_cents: 2500,
  payment_method: "stripe" as const,
  expires_at: null,
  refunded_cents: 0,
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  created_at: "2026-08-20T10:00:00.000Z",
  entries: [
    {
      id: "reg-1",
      division_id: "div-1",
      division_name: "Mixed Doubles",
      display_name: "Team Alpha",
      status: "pending" as const,
      amount_cents: 2500,
      free_agent: false,
      join_code: "JOIN123",
      players: [{ id: "p1", full_name: "Alex Test", consent_status: "granted" as const }],
    },
    {
      id: "reg-2",
      division_id: "div-2",
      division_name: "Womens 35+",
      display_name: "Alex Test",
      status: "waitlisted" as const,
      amount_cents: 0,
      free_agent: false,
      join_code: null,
      players: [],
    },
  ],
};

describe("register status page (RS006 §C minimal render)", () => {
  it("renders the group ref and every entry's division/status/fee, given a valid rid+token", async () => {
    groupByIdMock.impl.mockResolvedValueOnce(BASE_VIEW);
    const html = await render({ rid: "g1", token: "tok" });
    expect(html).toContain("SZ-TEST-01");
    expect(html).toContain("Mixed Doubles");
    expect(html).toContain("Womens 35+");
    expect(html).toContain(">pending<");
    expect(html).toContain(">waitlisted<");
    expect(groupByIdMock.impl).toHaveBeenCalledWith("g1", "tok");
  });

  it("shows a plain not-found message, and never calls groupById, when rid/token are missing", async () => {
    const html = await render({});
    // "couldn't" renders as the HTML entity &#x27; under renderToStaticMarkup
    // — assert on a substring either side of the apostrophe, not through it.
    expect(html).toContain("find that registration");
    expect(groupByIdMock.impl).not.toHaveBeenCalled();
  });

  it("shows the SAME not-found message when groupById 404s (wrong token / nonexistent id) — never a raw error page", async () => {
    const { HttpError } = await import("@/lib/errors");
    groupByIdMock.impl.mockRejectedValueOnce(new HttpError(404, "registration not found"));
    const html = await render({ rid: "g1", token: "wrong" });
    // "couldn't" renders as the HTML entity &#x27; under renderToStaticMarkup
    // — assert on a substring either side of the apostrophe, not through it.
    expect(html).toContain("find that registration");
  });

  it("lets a non-404 error propagate rather than masking it as 'not found'", async () => {
    groupByIdMock.impl.mockRejectedValueOnce(new Error("db unreachable"));
    await expect(render({ rid: "g1", token: "tok" })).rejects.toThrow("db unreachable");
  });
});
