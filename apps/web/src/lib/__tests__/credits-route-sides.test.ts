// Settings → Credits has two sides, and since 2026-11-11 the bare URL opens STREAMING (owner: streaming credits come first).
// A link whose context is AI credits therefore has to name the AI side (`routes.creditsAi`) — the bare `routes.credits`
// would now land an owner who clicked "Manage AI credits" on match credits.
//
// Two things are pinned here:
//   1. each route helper lands on the side its name promises, as the Credits PAGE's own parser (`creditsKindOf`) reads the
//      URL — not as this file reads it;
//   2. every production call site of the three helpers is classified below. A new call site fails until someone decides
//      which side its context is; a classified one that moved helper fails too. The AI-labelled link on the billing page is
//      additionally checked against its own label.
//
// Mutant table (each applied once by hand):
//   S1 default side   `routes.credits` → `?kind=ai` / `creditsKindOf` default "ai"   → "each helper lands on the side its name promises"
//   S2 billing link   the billing page's "Manage AI credits" back to `routes.credits` → "the billing page's AI-credits link names the AI side"
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { routes } from "@/lib/routes";
import { creditsKindOf } from "@/components/credits-kind-switch";

const SRC = path.join(process.cwd(), "src");

/** The side the Credits page opens for `href`, read by the page's own parser. */
function sideOf(href: string): "ai" | "stream" {
  const url = new URL(href, "https://seazn.test");
  expect(url.pathname).toBe("/o/riverside/settings/credits");
  const kinds = url.searchParams.getAll("kind");
  return creditsKindOf(kinds.length > 1 ? kinds : kinds[0]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "dictionaries" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

type Helper = "credits" | "creditsAi" | "creditsStream";

/** Every production call site, by file (relative to src/) and helper → how many, and why that side. */
const CLASSIFIED: Record<string, Partial<Record<Helper, { n: number; why: string }>>> = {
  "app/o/[orgSlug]/settings/_components/settings-nav.tsx": {
    credits: { n: 2, why: "the rail's Credits item (side-neutral, opens the default) and its streaming-balance link" },
  },
  "components/credits-kind-switch.tsx": {
    credits: { n: 1, why: "the switch's Streaming item: the default side's canonical URL" },
    creditsAi: { n: 1, why: "the switch's AI item" },
  },
  "app/o/[orgSlug]/settings/billing/page.tsx": {
    creditsAi: { n: 1, why: "\"Manage AI credits\" on the billing page" },
  },
  "app/api/billing/relay-checkout/route.ts": {
    creditsStream: { n: 1, why: "the match-credit checkout's return appends &checkout=…, so it needs a URL with a query" },
  },
  "components/billing-stream-credits.tsx": {
    creditsStream: { n: 2, why: "the Streaming history pager: Older appends &before=…, Latest is its pair" },
  },
};

describe("Settings → Credits: which side each link opens", () => {
  it("each helper lands on the side its name promises (S1)", () => {
    expect(sideOf(routes.credits("riverside")), "the bare URL is the Streaming side").toBe("stream");
    expect(sideOf(routes.creditsAi("riverside"))).toBe("ai");
    expect(sideOf(routes.creditsStream("riverside")), "links made while AI was the default still open Streaming").toBe("stream");
  });

  it("every production call site of the Credits route helpers is classified, and none moved (S2 lives here too)", () => {
    const found: Record<string, Partial<Record<Helper, number>>> = {};
    let sites = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      for (const m of text.matchAll(/routes\.(credits|creditsAi|creditsStream)\(/g)) {
        const helper = m[1] as Helper;
        (found[rel] ??= {})[helper] = (found[rel]![helper] ?? 0) + 1;
        sites++;
      }
    }
    const want = Object.fromEntries(
      Object.entries(CLASSIFIED).map(([f, hs]) => [f, Object.fromEntries(Object.entries(hs).map(([h, v]) => [h, v!.n]))]),
    );
    expect(sites, "anti-vacuity: the scan found call sites").toBeGreaterThan(0);
    expect(found, "an unclassified or moved call site: decide whether its context is AI credits (creditsAi) or streaming").toEqual(want);
  });

  it("the billing page's AI-credits link names the AI side (S2)", () => {
    const text = readFileSync(path.join(SRC, "app/o/[orgSlug]/settings/billing/page.tsx"), "utf8");
    const at = text.indexOf('"billing.credits.link"');
    expect(at, "the link's label is still on the page").toBeGreaterThan(-1);
    // The <Link> that carries the label: from its opening tag to the label.
    const open = text.lastIndexOf("<Link", at);
    expect(open).toBeGreaterThan(-1);
    const link = text.slice(open, at);
    expect(link).toContain("routes.creditsAi(orgSlug)");
    expect(link).not.toMatch(/routes\.credits\(/);
  });
});
