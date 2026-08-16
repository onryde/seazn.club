// The competition-scoped route error boundary (`c/[compSlug]/error.tsx`).
//
// It exists because the ROOT boundary unmounts every layout below `app/`, so a
// client throw on a division page took the whole competition shell with it —
// no breadcrumb, no tab strip, nothing to click but Back. That was the staging
// symptom behind #575.
//
// What a render can prove is this file's own contract: the copy comes from the
// dictionaries (NOT hardcoded English like the root boundary, which cannot use
// them because the provider may be the thing that failed), the digest is
// surfaced when present and the line is absent when it is not, and the retry
// control is rendered.
//
// Deliberately NOT asserted here: that `reset()` fires on click, and which
// layouts survive. The first needs a real mount (no jsdom in this workspace)
// and the second is Next's own segment semantics — the same trade
// `datetime-split-field.test.tsx` documents, with e2e as the backstop.
//
// Rendered through react-dom/server. `useEffect` is a no-op under SSR, so the
// Sentry module is mocked only to keep the import graph out of the real SDK.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

const { default: CompetitionError } = await import("../error");

describe("competition error boundary", () => {
  it("renders the localized copy, never a hardcoded English string of its own", () => {
    const html = renderToStaticMarkup(
      <CompetitionError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />,
    );
    // Compared against the dictionary VALUES, not retyped literals — that is
    // what makes this fail if the component ever inlines copy instead of
    // reading a key. `useMsg()` falls back to the shipped en catalog outside a
    // DictProvider (dict-provider.tsx), so this is the real shipped string.
    expect(html).toContain(en["routeError.title"]);
    expect(html).toContain(en["routeError.body"]);
    expect(html).toContain(en["routeError.retry"]);
  });

  it("surfaces the digest — the only handle a user can quote back to support", () => {
    const html = renderToStaticMarkup(
      <CompetitionError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />,
    );
    expect(html).toContain("Reference: abc123");
  });

  it("omits the reference line entirely when there is no digest", () => {
    const html = renderToStaticMarkup(<CompetitionError error={new Error("boom")} reset={() => {}} />);
    expect(html).not.toContain("Reference:");
    // …but still offers the escape hatch.
    expect(html).toContain(en["routeError.retry"]);
    expect(html).toContain('type="button"');
  });

  it("keeps the main landmark, which in this tree belongs to the PAGE it replaces", () => {
    // Verified, not assumed: no layout under `app/o/` opens a <main> — every
    // one of these routes opens it in the page body itself
    // (`d/[divSlug]/page.tsx:202`, `c/[compSlug]/page.tsx:61`). This boundary
    // renders instead of that page, so a <div>/<section> here would leave the
    // document with no main landmark at all while the competition chrome above
    // it still renders.
    const html = renderToStaticMarkup(<CompetitionError error={new Error("boom")} reset={() => {}} />);
    expect(html).toMatch(/^<main[\s>]/);
  });
});
