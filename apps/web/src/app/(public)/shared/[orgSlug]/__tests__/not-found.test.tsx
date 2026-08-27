// Defect 3 (2026-08-27 browser sweep): [orgSlug]/layout.tsx calls notFound()
// for a reserved slug or an org that doesn't resolve (doc 09 §1), and before
// this file there was NO not-found.tsx anywhere in the app to catch it — so
// it bubbled all the way to Next's bare built-in 404 ("404 This page could
// not be found", no branding, no explanation, no route forward). That is
// exactly the page every registration status link 404s to once its token
// rotates, its entry is cancelled, or old mail gets forwarded — the far more
// common way a visitor actually lands here than a hand-typed bad slug.
//
// (rid/token being wrong on an otherwise-real org/competition is a DIFFERENT,
// already-handled branch inside register/status/page.tsx's own 200 "we
// couldn't find that registration" render — status-page.test.tsx pins that
// one; this file is only the org-level miss that happens BEFORE that page
// ever runs.)
//
// Hard constraint from the layout's own doc comment ("a missing org 404s
// identically — no existence leak"): this component takes no params and
// fetches nothing, so a reserved slug and a genuinely nonexistent org are
// structurally indistinguishable here, and there is nothing to leak.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

import NotFound from "../not-found";

describe("shared/[orgSlug] not-found", () => {
  it("explains the link is invalid and gives a route forward — not the bare framework page", async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("no longer valid");
    expect(html).toMatch(/href="\/"/);
    // The framework default's own exact copy must be gone.
    expect(html).not.toContain("This page could not be found");
  });

  it("tells the reader what to do next", async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toMatch(/organiser/i);
  });

  it("leaks nothing — no confirmation any specific entity exists (takes no org/competition data at all)", async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).not.toMatch(/your registration|we found|confirmed/i);
  });
});
