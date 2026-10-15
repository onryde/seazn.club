// Panels whose first read is keyed on a prop (ESLint L3). The read used to be
// `void load()` straight out of the effect, with no way to tell an answer for
// the CURRENT prop from one for the previous prop. Each effect now owns its
// request and ignores it once superseded. The sequence pinned here, per panel:
// mount on A (request in flight), switch to B, B answers, THEN A's late answer
// arrives — and must not overwrite B. Expected rows are the fixtures' own
// values, never read back from the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

type Deferred = { url: string; resolve: (v: unknown) => void };
const net = vi.hoisted(() => ({ pending: [] as Deferred[] }));
const later = (url: string) =>
  new Promise((resolve) => {
    net.pending.push({ url, resolve });
  });
/** Answer the in-flight request for `url` (exactly one must be waiting). */
const answer = (url: string, value: unknown) => {
  const hits = net.pending.filter((d) => d.url === url);
  expect(hits.map((d) => d.url), `one request in flight for ${url}`).toEqual([url]);
  net.pending = net.pending.filter((d) => d.url !== url);
  hits[0]!.resolve(value);
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn((url: string) => later(url)),
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: vi.fn((url: string) => later(url)),
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { OrgTeam } from "@/components/org-team";
import { ApiKeysPanel } from "@/components/api-keys";
import { SponsorPackages } from "@/components/sponsor-packages";

/** Macrotask turns: each await in a chain lands on its own turn. */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  net.pending = [];
  vi.stubGlobal("window", { location: { origin: "https://x.example" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const hasTestId = (tree: ReactElement[], id: string) =>
  tree.some((el) => propsOf(el)["data-testid"] === id);

describe("a superseded first read never lands on the panel that replaced it", () => {
  it("DeviceLinkPanel: fixture f1's late link does not appear on fixture f2", async () => {
    const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
    const props = { fixtureId: "f1", sportKey: "badminton", viewerPlan: "pro" as const };
    const island = renderIsland(DeviceLinkPanel, props);
    island.rerender({ ...props, fixtureId: "f2" });

    answer("/api/v1/fixtures/f2/device-links", null);
    await flush();
    expect(hasTestId(island.tree(), "device-link-mint"), "f2 has no link: the create button").toBe(true);

    answer("/api/v1/fixtures/f1/device-links", {
      id: "dl-f1",
      label: null,
      expires_at: FUTURE,
      created_at: FUTURE,
    });
    await flush();
    expect(hasTestId(island.tree(), "device-link-show"), "f1's link must not show on f2").toBe(false);
    expect(hasTestId(island.tree(), "device-link-mint")).toBe(true);
  });

  it("OrgTeam: org A's late members do not replace org B's", async () => {
    const member = (name: string) => ({
      user_id: `u-${name}`,
      email: `${name}@example.test`,
      display_name: name,
      avatar_url: null,
      role: "admin",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const props = { orgId: "org-a", role: "owner" as const, currentUserId: "me" };
    const island = renderIsland(OrgTeam, props);
    island.rerender({ ...props, orgId: "org-b" });

    answer("/api/orgs/org-b/members", [member("ZqBeatrice")]);
    answer("/api/orgs/org-b/invites", []);
    await flush();
    expect(island.text()).toContain("ZqBeatrice");

    answer("/api/orgs/org-a/members", [member("ZqAlbert")]);
    answer("/api/orgs/org-a/invites", []);
    await flush();
    expect(island.text()).toContain("ZqBeatrice");
    expect(island.text()).not.toContain("ZqAlbert");
  });

  it("ApiKeysPanel: org A's late keys do not replace org B's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        later(url).then((data) => ({ ok: true, json: async () => ({ ok: true, data }) })),
      ),
    );
    const key = (name: string) => ({
      id: `k-${name}`,
      name,
      prefix: "sk_x",
      scopes: ["read"],
      competition_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    });
    const island = renderIsland(ApiKeysPanel, { orgId: "org-a", competitions: [] });
    island.rerender({ orgId: "org-b", competitions: [] });

    answer("/api/v1/orgs/org-b/api-keys", [key("ZqBravoKey")]);
    await flush();
    expect(island.text()).toContain("ZqBravoKey");

    answer("/api/v1/orgs/org-a/api-keys", [key("ZqAlphaKey")]);
    await flush();
    expect(island.text()).toContain("ZqBravoKey");
    expect(island.text()).not.toContain("ZqAlphaKey");
  });

  it("SponsorPackages: no read without the feature (empty case); org A's late packages do not replace org B's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        later(url).then((data) => ({ ok: true, json: async () => ({ data }) })),
      ),
    );
    const pkg = (name: string) => ({
      id: `p-${name}`,
      competition_id: null,
      name,
      description: null,
      price_cents: 1000,
      currency: "gbp",
      tier: "gold",
      active: true,
    });
    const props = { orgId: "org-a", competitions: [], hasMonetize: false, billingHref: "/billing" };
    const island = renderIsland(SponsorPackages, props);
    await flush();
    expect(net.pending, "a plan without the feature reads nothing").toEqual([]);

    island.rerender({ ...props, hasMonetize: true });
    island.rerender({ ...props, hasMonetize: true, orgId: "org-b" });
    answer("/api/v1/orgs/org-b/sponsor-packages", [pkg("ZqBravoPack")]);
    answer("/api/v1/orgs/org-b/sponsor-orders", []);
    await flush();
    expect(island.text()).toContain("ZqBravoPack");

    answer("/api/v1/orgs/org-a/sponsor-packages", [pkg("ZqAlphaPack")]);
    answer("/api/v1/orgs/org-a/sponsor-orders", []);
    await flush();
    expect(island.text()).toContain("ZqBravoPack");
    expect(island.text()).not.toContain("ZqAlphaPack");
  });
});
