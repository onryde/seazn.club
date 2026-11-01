// R4 sponsors-on-stream S11 - the org Dashboard's Sponsors entry (OWNER RULING §6.1 "a", 2026-10-31).
//
// The top-bar Sponsors link is `hidden min-[350px]:flex` (`min-[390px]` for an org with a logo): it is gone below 350px. The ruling's other half is that the
// Dashboard carries a Sponsors entry AT EVERY WIDTH, so a phone user at 320 always has a way in. "At every width" is a
// claim about CLASSES, so it is asserted on the link's class tokens: nothing that hides it at any breakpoint
// (`hidden`, `max-*:hidden`, `sm:hidden`, `md:hidden` ...) - and the link is there for a viewer too (the hub gives a
// non-editor its read-only Overview and Sponsors) and on an EMPTY dashboard, where the page renders a different body.
//
// Rendered through react-dom/server - vitest runs `environment: "node"` and this workspace has no jsdom.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  canEdit: true,
  role: "owner" as string,
  competitions: [] as Array<{ id: string; name: string; slug: string; status: string; ends_on: string | null }>,
}));

vi.mock("@/server/page-auth", () => ({
  requireOrgPage: async () => ({
    auth: { orgId: "org-1", via: "session", userId: null, role: h.role, keyId: null },
    user: { id: "u-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: h.role },
    canEdit: h.canEdit,
  }),
}));
vi.mock("@/server/usecases/competitions", () => ({
  listCompetitions: async () => ({ items: h.competitions, next_cursor: null }),
}));
vi.mock("@/server/usecases/card-stats", () => ({
  listCompetitionCardStats: async () => new Map(),
  nextLine: () => null,
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) =>
    !Array.isArray(strings) || !("raw" in strings) ? { __fragment: strings } : Promise.resolve([]),
}));
vi.mock("@/lib/entitlements", async (orig) => ({
  ...(await orig<typeof import("@/lib/entitlements")>()),
  orgPlanKey: async () => "community",
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/components/billing-banner", () => ({ BillingBanner: () => null }));
vi.mock("@/components/ui/entity-card", () => ({ EntityCard: (p: { name: string }) => <div data-card={p.name} /> }));
vi.mock("@/components/ui/card-menu", () => ({ CardMenu: () => null }));
vi.mock("@/components/ui/view-toggle", () => ({
  ViewToggleContainer: (p: { children?: React.ReactNode }) => <div>{p.children}</div>,
}));

import Page from "../page";

const render = async (): Promise<string> =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ orgSlug: "riverside" }) }));

/** The Sponsors entry's anchor attributes, or null. Anchored on `data-testid="org-home-sponsors"` and its `="`. */
function entry(html: string): { href: string; cls: string[]; text: string } | null {
  const m = html.match(/<a\b([^>]*data-testid="org-home-sponsors"[^>]*)>([\s\S]*?)<\/a>/);
  if (!m) return null;
  return {
    href: m[1]!.match(/\bhref="([^"]*)"/)?.[1] ?? "",
    cls: (m[1]!.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean),
    text: m[2]!.replace(/<[^>]+>/g, "").trim(),
  };
}

/** Any token that can hide an element at SOME width: `hidden`, `invisible`, `sr-only`, or a variant of those
 *  (`max-md:hidden`, `sm:hidden`, `min-[350px]:hidden`). `/\bmd:hidden\b/` would also match inside `max-md:hidden`,
 *  so this splits on whole tokens and tests the last `:` segment. */
const hidesAtSomeWidth = (cls: string[]): string[] =>
  cls.filter((t) => ["hidden", "invisible", "sr-only"].includes(t.split(":").pop() ?? ""));

beforeEach(() => {
  h.canEdit = true;
  h.role = "owner";
  h.competitions = [];
});

describe("the org Dashboard's Sponsors entry", () => {
  it("is a link to the Sponsors hub, labelled Sponsors, and nothing hides it at ANY width", async () => {
    h.competitions = [{ id: "c1", name: "Summer League", slug: "summer-league", status: "live", ends_on: null }];
    const e = entry(await render());
    expect(e, "the entry exists").not.toBeNull();
    expect(e!.href).toBe("/o/riverside/sponsors");
    expect(e!.text).toBe("Sponsors");
    expect(hidesAtSomeWidth(e!.cls), "no token that hides it at any breakpoint").toEqual([]);
    // It sits in the header actions with its sibling, so it is a real button-sized target (not a text link in a paragraph).
    expect(e!.cls).toContain("btn");
  });

  it("is there on an EMPTY dashboard too (the page renders a different body when there are no competitions)", async () => {
    h.competitions = [];
    const e = entry(await render());
    expect(e).not.toBeNull();
    expect(hidesAtSomeWidth(e!.cls)).toEqual([]);
  });

  it("is there for a viewer (a non-editor): the hub gives them a read-only Overview and Sponsors, as Settings did", async () => {
    h.canEdit = false;
    h.role = "viewer";
    const e = entry(await render());
    expect(e).not.toBeNull();
    expect(e!.href).toBe("/o/riverside/sponsors");
  });

  it("the detector can fail: the top bar's Sponsors class WOULD be caught (a negative control for the 'no hidden token' check)", () => {
    expect(hidesAtSomeWidth("hidden min-[350px]:flex items-center".split(" ")).length).toBeGreaterThan(0);
    expect(hidesAtSomeWidth("btn max-md:hidden".split(" ")).length).toBeGreaterThan(0);
    expect(hidesAtSomeWidth("btn btn-ghost".split(" "))).toEqual([]);
  });
});
