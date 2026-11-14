// An old organiser URL keeps its page after a rename (review I3, /start "Sent stepper"): renaming the organisation is the
// stepper's step 2, and it regenerates the org slug (`PATCH /api/orgs/[id]`). The old URL of a division — the claim's
// landing, a bookmark — used to 308 to the org's HOME, losing the competition, the division, the tab and the query: the
// org layout redirected with the only param a layout has, and the page-auth chain dropped the path below the org. Now the
// layout leaves a renamed org to the page (as the /present kiosk layout does, slug-resolve `sharedRenameTarget`), and every
// level of the chain hands the rest of its path down, so the redirect keeps it at whichever depth was renamed.
//
// Driven through the REAL slug resolution over Postgres: the rename is the route's own two writes (the slug, then
// `recordSlugHistory`, then the cache drop), as slug-resolve.test.ts does. Only the session (`getCurrentUser`,
// `getUserOrgs`) and Next's navigation throws are stand-ins. Expected URLs are typed here from the URL scheme
// (/o/{org}/c/{comp}/d/{div}…), never built by the code under test.
// Sport: not applicable — slugs are sport-agnostic (the division is the generic module's).
// Real Postgres required — skipped without DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  permanentRedirect: (to: string) => {
    throw new Redirected(to);
  },
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new NotFound("not found");
  },
}));
const session = vi.hoisted(() => ({ userId: "", orgs: [] as { id: string; role: string; slug: string; name: string }[] }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => ({ id: session.userId }),
  getUserOrgs: async () => session.orgs,
  getActiveOrgId: async () => null,
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { recordSlugHistory } from "@/server/usecases/slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";
import {
  requireCompetitionPage,
  requireDivisionPage,
  requireBillingPage,
  requireFixturePage,
  requireOrgPage,
} from "@/server/page-auth";
import { searchOf } from "@/lib/routes";
import OrgLayout from "@/app/o/[orgSlug]/layout";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `pat-${randomUUID().slice(0, 8)}`;
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** Where a call redirected to, or a red naming what it did instead. */
async function redirectOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    if (e instanceof Redirected) return e.to;
    throw e;
  }
  throw new Error("no redirect");
}

interface Chain {
  orgId: string;
  oldOrg: string;
  newOrg: string;
  comp: string;
  div: string;
}
let chain: Chain;

beforeAll(async () => {
  if (!HAS_DB) return;
  const oldOrg = `${RUN}-club`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${`${RUN} Club`}, ${oldOrg}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `${RUN} Cup`, visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  // The rename, as PATCH /api/orgs/[id] writes it.
  const newOrg = `${oldOrg}-renamed`;
  await sql`update organizations set slug = ${newOrg} where id = ${orgId}`;
  await recordSlugHistory(sql, "org", null, oldOrg, orgId);
  await invalidateSlugCache("org", null, oldOrg, newOrg);
  chain = { orgId, oldOrg, newOrg, comp: comp.slug, div: div.slug };
});

beforeEach(() => {
  if (!HAS_DB) return;
  session.userId = randomUUID();
  session.orgs = [{ id: chain.orgId, role: "owner", slug: chain.newOrg, name: `${RUN} Club` }];
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});

describe("searchOf: a page's query, as the redirect carries it", () => {
  it("serialises every value (repeats too), drops an absent one, and is empty for no query", () => {
    expect(searchOf({ tab: "entrants", x: ["a", "b"], gone: undefined })).toBe("?tab=entrants&x=a&x=b");
    expect(searchOf({ q: "a&b c" }), "encoded, so a value cannot add a param").toBe("?q=a%26b+c");
    expect(searchOf({})).toBe("");
    expect(searchOf({ gone: undefined })).toBe("");
  });
});

// Every organiser page hands the chain its OWN path, or a renamed slug's old URL of that page lands one level up; and a
// page that reads its query hands that on too, or the redirect drops it (a checkout return's `?checkout&session_id`,
// re-review m2). The expected tail comes from where the page FILE sits (the URL scheme: a gate at the division level keeps
// what is below `d/[divSlug]`), never from the call. A source scan, because the chain is proven above and what is left
// is that each page states its path and its query: rendering 21 pages to read one argument would prove the same thing at
// the cost of their mocks.
describe("every page under /o/{org} gives the chain its own path (review I3 sweep)", () => {
  const ORG_DIR = fileURLToPath(new URL("../../app/o/[orgSlug]/", import.meta.url));
  /** Where each gate's level sits in the tree: its tail is the page's path below this prefix. */
  const LEVEL: Record<string, string> = {
    requireOrgPage: "",
    requireBillingPage: "",
    requireCompetitionPage: "c/[compSlug]",
    requireDivisionPage: "c/[compSlug]/d/[divSlug]",
  };
  /** Pages with no gate of their own, each with the reason it needs none. */
  const UNGATED: Record<string, string> = {
    // Forwards to Connect under the slug it was given, query intact; Connect's own gate then redirects a renamed org.
    "settings/payments": "a bare redirect to settings/connect, which carries the tail",
  };

  it("names its own path as the tail, at its gate's level, and forwards its query when it reads one", () => {
    const pages = (readdirSync(ORG_DIR, { recursive: true }) as string[])
      .filter((f) => f.split(sep).at(-1) === "page.tsx")
      .map((f) => f.split(sep).slice(0, -1).join("/"));
    const seenUngated = new Set<string>();
    let checked = 0;
    let forwarded = 0;
    for (const dir of pages) {
      const src = readFileSync(`${ORG_DIR}${dir}/page.tsx`, "utf8");
      const call = /\b(require(?:Org|Billing|Competition|Division|Fixture)Page)\(([\s\S]*?)\);/.exec(src);
      if (dir in UNGATED) {
        expect(call, `${dir} is listed as ungated but calls a gate`).toBeNull();
        seenUngated.add(dir);
        continue;
      }
      expect(call, `${dir}/page.tsx calls no page-auth gate`).not.toBeNull();
      const [, gate, args] = call!;
      const tail = /\btail:\s*"([^"]*)"/.exec(args)?.[1];
      if (gate === "requireFixturePage") {
        // The fixture gate builds the match's own path itself (it settles each level with its own target).
        expect(dir, "the fixture gate serves only the match page").toBe("c/[compSlug]/d/[divSlug]/f/[no]");
        expect(tail, `${dir}: the fixture gate takes no tail`).toBeUndefined();
      } else {
        const level = LEVEL[gate];
        expect(dir === level || dir.startsWith(`${level}/`) || level === "", `${dir} sits below ${gate}'s level`).toBe(true);
        const below = level === "" ? dir : dir.slice(level.length + 1);
        expect(tail, `${dir}/page.tsx (${gate})`).toBe(below === "" ? undefined : `/${below}`);
      }
      // A page with a query hands the gate all of it, through `searchOf` (lib/routes): encoded, repeats kept.
      if (/\bsearchParams\b/.test(src)) {
        expect(/\bsearch:\s*searchOf\(/.test(args), `${dir}/page.tsx reads searchParams but does not forward them to ${gate}`).toBe(true);
        forwarded++;
      }
      checked++;
    }
    expect([...seenUngated].sort(), "every ungated exemption still names a page").toEqual(Object.keys(UNGATED).sort());
    expect(checked, "pages checked").toBe(pages.length - Object.keys(UNGATED).length);
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(forwarded, "pages whose query was checked").toBeGreaterThanOrEqual(13);
  });
});

describe.skipIf(!HAS_DB)("a renamed organisation's old URL keeps its page (review I3)", () => {
  it("every depth of the chain, with its tail and its query", async () => {
    const { oldOrg, newOrg, comp, div } = chain;
    const cases: [string, () => Promise<unknown>, string][] = [
      ["the org home", () => requireOrgPage(oldOrg), `/o/${newOrg}`],
      ["an org page", () => requireOrgPage(oldOrg, { tail: "/settings" }), `/o/${newOrg}/settings`],
      ["the competition", () => requireCompetitionPage(oldOrg, comp), `/o/${newOrg}/c/${comp}`],
      // This one used to land on the ORG's settings: the competition tail went to the org level bare.
      ["the competition's settings", () => requireCompetitionPage(oldOrg, comp, { tail: "/settings" }), `/o/${newOrg}/c/${comp}/settings`],
      ["the competition, its query", () => requireCompetitionPage(oldOrg, comp, { search: "?finished=1" }), `/o/${newOrg}/c/${comp}?finished=1`],
      ["the division", () => requireDivisionPage(oldOrg, comp, div), `/o/${newOrg}/c/${comp}/d/${div}`],
      [
        "the division's tab (the claim's landing)",
        () => requireDivisionPage(oldOrg, comp, div, { search: searchOf({ tab: "entrants" }) }),
        `/o/${newOrg}/c/${comp}/d/${div}?tab=entrants`,
      ],
      ["a division page", () => requireDivisionPage(oldOrg, comp, div, { tail: "/schedule" }), `/o/${newOrg}/c/${comp}/d/${div}/schedule`],
      ["a match", () => requireFixturePage(oldOrg, comp, div, 3), `/o/${newOrg}/c/${comp}/d/${div}/f/3`],
      [
        "a match's checkout return",
        () => requireFixturePage(oldOrg, comp, div, 3, { search: "?checkout=success&session_id=cs_1" }),
        `/o/${newOrg}/c/${comp}/d/${div}/f/3?checkout=success&session_id=cs_1`,
      ],
      [
        "billing's checkout return (re-review m2)",
        () => requireBillingPage(oldOrg, { tail: "/settings/billing", search: "?checkout=success&session_id=cs_2" }),
        `/o/${newOrg}/settings/billing?checkout=success&session_id=cs_2`,
      ],
    ];
    let checked = 0;
    for (const [label, call, want] of cases) {
      expect(await redirectOf(call), label).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("the org layout leaves a renamed org to the page (a layout holds only the org slug), and still 404s a slug that never was", async () => {
    const children = "the page";
    const tree = (await OrgLayout({ children, params: Promise.resolve({ orgSlug: chain.oldOrg }) })) as ReactNode;
    expect(isValidElement(tree), "a shell around the page, not a redirect").toBe(true);
    const missing = OrgLayout({ children, params: Promise.resolve({ orgSlug: `${RUN}-never` }) });
    await expect(missing).rejects.toBeInstanceOf(NotFound);
  });

  it("the pair: the live slug redirects nowhere and admits the member", async () => {
    const { newOrg, comp, div } = chain;
    const page = await requireDivisionPage(newOrg, comp, div, { search: "?tab=entrants" });
    expect(page.org.id).toBe(chain.orgId);
    expect(page.division.slug).toBe(div);
  });

  // Re-review m1: a renamed COMPETITION or DIVISION used to send an old match URL to the competition's or division's
  // home, losing the match and its query. Both renames happen once, below: the division first, then its competition.
  it("a renamed competition or division keeps the match below it, and its query", async () => {
    const { orgId, newOrg } = chain;
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `${RUN} Shield`, visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Masters", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    const [oldComp, newComp, oldDiv, newDiv] = [comp.slug, `${comp.slug}-renamed`, div.slug, `${div.slug}-renamed`];
    await sql`update divisions set slug = ${newDiv} where id = ${div.id}`;
    await recordSlugHistory(sql, "division", comp.id, oldDiv, div.id);
    await invalidateSlugCache("division", comp.id, oldDiv, newDiv);
    await sql`update competitions set slug = ${newComp} where id = ${comp.id}`;
    await recordSlugHistory(sql, "competition", orgId, oldComp, comp.id);
    await invalidateSlugCache("competition", orgId, oldComp, newComp);
    const q = "?stream=open";
    const cases: [string, () => Promise<unknown>, string][] = [
      ["the division renamed", () => requireFixturePage(newOrg, newComp, oldDiv, 4, { search: q }), `/o/${newOrg}/c/${newComp}/d/${newDiv}/f/4${q}`],
      // The segment below the renamed level rides as typed (the next hop renames it), as every level of the chain does.
      ["the competition renamed", () => requireFixturePage(newOrg, oldComp, oldDiv, 4, { search: q }), `/o/${newOrg}/c/${newComp}/d/${oldDiv}/f/4${q}`],
      ["the competition renamed, a division page", () => requireDivisionPage(newOrg, oldComp, newDiv, { tail: "/schedule", search: "?tab=grid" }), `/o/${newOrg}/c/${newComp}/d/${newDiv}/schedule?tab=grid`],
    ];
    let checked = 0;
    for (const [label, call, want] of cases) {
      expect(await redirectOf(call), label).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a slug segment below the org rides the redirect encoded: it cannot add a path or a query", async () => {
    const odd = "a/b?c=d";
    const to = await redirectOf(() => requireCompetitionPage(chain.oldOrg, odd));
    expect(to).toBe(`/o/${chain.newOrg}/c/a%2Fb%3Fc%3Dd`);
    expect(new URL(to, "https://seazn.club").pathname.split("/")).toHaveLength(5);
  });
});
