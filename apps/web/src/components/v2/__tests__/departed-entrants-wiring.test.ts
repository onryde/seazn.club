// Two seams this workspace cannot drive, guarded at the source.
//
// `apps/web` vitest is `environment: "node"`: there is no jsdom, no
// @testing-library, and `renderToStaticMarkup` runs no handlers — so the
// ladder panel's catch block and an RSC page's own derivation are both
// unreachable from a unit test. Both were found UNTESTED by the re-review's
// mutation campaign (N21, N22), and both have real behaviour tests in
// Playwright (`e2e/ladder-withdrawn-challenge.spec.ts`,
// `e2e/withdrawn-entrant-seeding.spec.ts`) — but e2e triggers on push to
// `main` only, so on a pull request these scans are the only thing standing
// between a deleted seam and a green gate.
//
// What a scan can and cannot do: it kills "the call was removed" and "the
// argument was hardcoded". It cannot tell you the result reaches a screen.
// Neither claim is made beyond that; the e2e specs named above are what prove
// the behaviour, and if one of these ever disagrees with the other, the
// browser wins.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the ladder panel localises a challenge refusal (N21)", () => {
  const source = read("components/v2/ladder-panel.tsx");

  it("routes an ApiV1Error through ladderErrorMessage rather than err.message", () => {
    expect(source).toContain('import { ladderErrorMessage } from "@/lib/ladder-error"');
    // The call, with the component's `locale` prop as the locale — not a
    // literal. A hardcoded "en" renders English copy to a French organiser
    // and passes every English assertion there is.
    expect(source).toMatch(/setError\(\s*ladderErrorMessage\(\s*locale\s*,/);
    // The negative pair: no branch sets the raw server prose as the error for
    // an ApiV1Error. `err.message` survives only as the FALLBACK argument to
    // the resolver above, and in the non-ApiV1Error branch.
    expect(source).not.toMatch(/setError\(\s*err\.message\s*\)/);
  });

  it("takes its locale as a prop, because it renders outside a DictProvider", () => {
    expect(source).toMatch(/locale:\s*Locale;/);
  });
});

describe("the division page treats a disqualification as a departure (N22)", () => {
  const source = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx");

  it("derives departedEntrantIds from the shared vocabulary, not a status literal", () => {
    const match = source.match(/const departedEntrantIds = [\s\S]{0,300}?\.map\(/);
    expect(match, "departedEntrantIds is no longer derived on this page").not.toBeNull();
    const derivation = match![0];
    // This assertion USED to be `toContain('"withdrawn"')` plus the same for
    // `"disqualified"`, which was right about the intent and wrong about where
    // to look: `standings-withdrawn-wiring.test.ts` forbids this page spelling
    // the vocabulary at all, because a page that names one status will miss
    // the next one added — and the two guards then contradicted each other.
    //
    // The intent it was protecting (a DISQUALIFICATION narrows the pickers
    // exactly as a withdrawal does — the half a mutation dropped with nothing
    // going red) has not been weakened, it has MOVED to where it can no longer
    // be satisfied by a page-local literal: `DEPARTED_STATUSES` is pinned to
    // the schema's own status list in
    // `public-site/__tests__/departed-vocabulary-is-single-sourced.test.ts`.
    // Narrowing that set to `withdrawn` alone reds there.
    expect(derivation).toContain("DEPARTED_STATUSES.has");
    expect(
      derivation,
      "the page restates the departed vocabulary — read it from DEPARTED_STATUSES instead",
    ).not.toMatch(/"(withdrawn|disqualified)"/);
    // And it is imported from the one place that owns it, not redeclared here.
    expect(source).toMatch(/import\s*\{[^}]*DEPARTED_STATUSES[^}]*\}\s*from\s*"@\/server\/usecases\/entrants"/);
  });

  it("hands that list to every panel whose pickers must not offer her", () => {
    // LadderPanel and ProgressionPanel both receive it; a new panel that
    // renders an entrant picker and does not is the next instance of this
    // defect.
    const passes = [...source.matchAll(/departedEntrantIds=\{departedEntrantIds\}/g)];
    expect(passes.length).toBeGreaterThanOrEqual(2);
  });
});
