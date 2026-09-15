// The /orgs/new page's one decision (v17 gap #293 review).
//
// WHY THIS FILE EXISTS. The page hands `CreateOrgForm` the organisations the
// visitor can actually OPEN, and the picker builds its "buy another slot" link
// out of them. Nothing else in the stack witnesses that hand-off, so a
// one-line edit used to leave every suite green and the feature dead:
//
//   memberOrgIds={orgs.filter(…).map(…)}  ->  {[]}   the link renders for
//                                                    nobody, ever
//
// Rendered as a server component: an async function returning an element tree,
// so it is awaited and walked (same shape as the Add-ons tab's page test).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { CreateOrgForm } from "@/components/create-org-form";
import type { OrgMembership } from "@/lib/types";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
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

  it("passes an empty list rather than nothing when the visitor has no orgs", async () => {
    const props = await formProps([]);
    expect(props.memberOrgIds).toEqual([]);
  });
});

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
      const props = await formProps([], { next: evil });
      expect(props.next, `${evil} must never reach the form`).toBeNull();
    }
  });
});
