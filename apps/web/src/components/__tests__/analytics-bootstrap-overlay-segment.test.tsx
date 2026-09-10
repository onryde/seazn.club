// vitest runs `environment: "node"` here, so this drives the component
// through `renderIsland` with `next/navigation`, `posthog-js`, and
// `@/lib/analytics-identity` mocked — a source-scan test could not tell a
// resolveIdentity() call that fired from one that didn't, which is the whole
// claim: the overlay route is an OBS browser source that reloads on every
// scene change, and each reload must NOT fire a doomed, anonymous
// /api/users/me fetch (see the OVERLAY_SEGMENT comment in
// analytics-bootstrap.tsx).
//
// Pattern copied from cookie-consent-overlay-segment.test.tsx (same segment,
// same renderIsland harness): `renderIsland` returns a HANDLE, never the
// rendered element itself, so assertions read `.tree()`/`.text()`, not the
// handle.
import { describe, expect, it, vi, beforeEach } from "vitest";

const pathname = { current: "/" };
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

vi.mock("posthog-js", () => ({
  default: { __loaded: true, get_distinct_id: () => "anon", identify: () => {}, group: () => {} },
}));

const resolveIdentity = vi.fn(async () => null);
vi.mock("@/lib/analytics-identity", () => ({
  hasIdentifiedThisTab: () => false,
  markIdentifiedThisTab: () => {},
  resolveIdentity: () => resolveIdentity(),
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { AnalyticsBootstrap } from "../analytics-bootstrap";

describe("AnalyticsBootstrap on the overlay segment", () => {
  beforeEach(() => {
    resolveIdentity.mockClear();
  });

  it("never calls resolveIdentity (no /api/users/me fetch) under /overlay/", () => {
    pathname.current = "/overlay/fixtures/11111111-1111-1111-1111-111111111111";
    const island = renderIsland(AnalyticsBootstrap, {});
    expect(island.tree()).toEqual([]);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("still resolves identity on the public match page — the positive pair", () => {
    // Without this case the assertion above passes on a component that never
    // resolves identity anywhere, which is a different (and much worse) bug.
    pathname.current = "/shared/acme/summer-cup/div-a/fixtures/1";
    renderIsland(AnalyticsBootstrap, {});
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
  });
});
