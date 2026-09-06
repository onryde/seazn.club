// The /orgs/new page's one decision (v17 gap #293 review).
//
// WHY THIS FILE EXISTS. The page hands `CreateOrgForm` the organisations the
// visitor can actually OPEN, and the picker builds its "buy another slot" link
// out of them. Nothing else in the stack witnesses that hand-off, so two
// one-line edits used to leave every suite green and the feature dead:
//
//   memberOrgIds={orgs.filter(…).map(…)}  ->  {[]}   the link renders for
//                                                    nobody, ever
//   drop the `role !== "scorer"` filter            a scorer-role organisation
//                                                    gets linked, requireOrgPage
//                                                    bounces to /my-matches,
//                                                    and the dead end is back
//
// Rendered as a server component: an async function returning an element tree,
// so it is awaited and walked (same shape as the Add-ons tab's page test).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { CreateOrgForm } from "@/components/create-org-form";
import type { OrgMembership } from "@/lib/types";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
// Spread the REAL module and override only the two session reads. `safeNextPath`
// has to stay real: the page's `next` hand-off (below) is reached through
// `newOrgDestination`, and a stubbed validator would make those assertions a
// fixture agreeing with itself instead of a test of the refusal.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: vi.fn(async () => ({ id: "user-1", email: "payer@example.com" })),
  getUserOrgs: vi.fn(async () => []),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", async () => {
  const runtime = await vi.importActual<typeof import("@/lib/i18n-runtime")>(
    "@/lib/i18n-runtime",
  );
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  return { getDictionary: async () => ui, t: runtime.t };
});

import { getUserOrgs } from "@/lib/auth";
import NewOrgPage from "../page";

const orgs = vi.mocked(getUserOrgs);

const membership = (id: string, role: string): OrgMembership =>
  ({ id, name: id, slug: id, role }) as unknown as OrgMembership;

async function formProps(
  memberships: OrgMembership[],
  searchParams: Record<string, string | undefined> = {},
) {
  orgs.mockResolvedValue(memberships);
  // App Router hands `searchParams` in as a promise in this Next (16.2.9).
  const tree = await NewOrgPage({ searchParams: Promise.resolve(searchParams) });
  const form = walk(tree).find((el) => el.type === CreateOrgForm);
  expect(form, "the page must still render CreateOrgForm").toBeTruthy();
  return propsOf(form!);
}

beforeEach(() => vi.clearAllMocks());

describe("/orgs/new hands the form the organisations the visitor can open", () => {
  it("passes the visitor's own organisation ids", async () => {
    const props = await formProps([membership("org-a", "owner"), membership("org-b", "admin")]);
    expect(props.memberOrgIds).toEqual(["org-a", "org-b"]);
  });

  it("withholds a scorer-role organisation — requireOrgPage bounces those", async () => {
    // The positive discriminator is in the same list: the owner org survives,
    // so this is the scorer being filtered and not an empty hand-off.
    const props = await formProps([membership("org-a", "owner"), membership("org-scorer", "scorer")]);
    expect(props.memberOrgIds).toEqual(["org-a"]);
  });

  it("passes an empty list rather than nothing when the visitor has no orgs", async () => {
    const props = await formProps([]);
    expect(props.memberOrgIds).toEqual([]);
  });
});

// W2 task 6 — the page's SECOND decision, and the one no other test can see.
//
// `safe-next-path.test.ts` pins `newOrgDestination` itself, but a pure-helper
// test is blind to whether the page CALLS it: replacing
// `newOrgDestination(await searchParams)` with `(await searchParams).next`
// leaves that suite at 12/12 (measured — the mutant survived). This walks the
// page's own rendered tree, so the hand-off is what is asserted, not the
// helper. Same reason the block above exists for `memberOrgIds`.
describe("/orgs/new honours the destination the org-less bounce carried", () => {
  it("hands the form the destination, params and all", async () => {
    const props = await formProps([], { next: "/settings?tab=account&email_change=success" });
    expect(props.next).toBe("/settings?tab=account&email_change=success");
  });

  it("hands the form null when there is none — the form then keeps /dashboard", async () => {
    expect((await formProps([], {})).next).toBeNull();
    expect((await formProps([], { next: undefined })).next).toBeNull();
    expect((await formProps([], { next: "" })).next).toBeNull();
  });

  it("refuses a smuggled origin AT THE PAGE, not only inside the helper", async () => {
    for (const evil of ["/\\evil.com", "//evil.com", "https://evil.com", "../admin"]) {
      // HAZARD: `/orgs/new` is a public URL and nothing stops anyone mailing
      // `/orgs/new?next=/\evil.com`. A browser resolves that to
      // "https://evil.com/" — the URL parser normalises the backslash to a
      // slash in the authority position, which is why a `startsWith("/")`
      // check is not origin validation. Handed to the form unvalidated, it
      // becomes a `router.push()` to a stranger's host at the end of a real
      // seazn.club sign-up: a phishing landing with a trusted approach path.
      const props = await formProps([], { next: evil });
      expect(props.next, `${evil} must never reach the form`).toBeNull();
    }
  });
});
