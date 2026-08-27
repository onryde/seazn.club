import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The staging origin is written out FIVE times in the workflows (the cron
// jobs' BASE_URL) and THREE times in fly.stg.toml (runtime [env] twice —
// OAUTH_BASE_URL drives server-side redirects, NEXT_PUBLIC_BASE_URL the
// runtime reads — plus [build.args], which is the copy baked into the client
// bundle). Nothing else compares them, so a half-done domain change ships a
// staging app that mints OAuth redirects and canonical URLs on one host while
// the cron jobs hit another.
//
// Was SIX in the workflows until e2e.yml's e2e-staging job (the one
// PLAYWRIGHT_BASE source) was removed (2026-08-11) — e2e no longer runs
// against staging at all, so there is no seventh source to bring back if this
// count ever needs to grow again; it would mean a NEW cron/workflow gained a
// BASE_URL, not e2e's return.
function repoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (!existsSync(join(dir, "fly.stg.toml"))) {
    const up = resolve(dir, "..");
    if (up === dir) throw new Error("fly.stg.toml not found above the test file");
    dir = up;
  }
  return dir;
}

const ROOT = repoRoot();
const STG_ORIGIN = "https://stg.seazn.club";
/** RS007: `registrations-sweep.yml` sweeps production as well as staging, so
 *  a workflow BASE_URL is no longer necessarily the staging one. */
const PROD_ORIGIN = "https://seazn.club";

describe("staging base URL", () => {
  const toml = readFileSync(join(ROOT, "fly.stg.toml"), "utf8");

  it("is the custom staging domain, not the fly.dev host", () => {
    // Pins the value, not just internal agreement: every copy reading
    // seazn-club-stg.fly.dev in unison is consistent AND wrong.
    expect(toml).not.toMatch(/seazn-club-stg\.fly\.dev/);
  });

  it("agrees across all three fly.stg.toml copies", () => {
    const urls = [...toml.matchAll(/^\s*(?:OAUTH_BASE_URL|NEXT_PUBLIC_BASE_URL)\s*=\s*"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(urls).toHaveLength(3);
    expect(urls).toEqual([STG_ORIGIN, STG_ORIGIN, STG_ORIGIN]);
  });

  it("matches every workflow that carries a base URL — staging or production, never a third host", () => {
    const dir = join(ROOT, ".github", "workflows");
    const hits: Array<[string, string]> = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const body = readFileSync(join(dir, file), "utf8");
      for (const m of body.matchAll(/^\s*(?:BASE_URL|PLAYWRIGHT_BASE):\s*(https:\/\/\S+)/gm)) {
        hits.push([file, m[1]]);
      }
    }
    // Guards the regex itself: a renamed key would otherwise pass vacuously.
    expect(hits.length).toBeGreaterThanOrEqual(5);

    // Until RS007 every workflow BASE_URL was the staging origin, and this
    // asserted exactly that. `registrations-sweep.yml` broke the assumption
    // legitimately: it sweeps BOTH environments, so it carries the repo's
    // first PRODUCTION base URL.
    //
    // Widened to "one of the two known origins" rather than dropped, because
    // the property worth keeping is not "everything points at staging" — it is
    // that NO workflow points at a host nobody meant, which is what a half-done
    // domain change or a typo produces. A third origin still fails here.
    expect(
      hits.filter(([, url]) => url !== STG_ORIGIN && url !== PROD_ORIGIN),
      "a workflow base URL points at neither the staging nor the production origin",
    ).toEqual([]);

    // The staging copies are still the ones that must agree with
    // fly.stg.toml, so they keep their own floor — otherwise renaming every
    // staging leg to production would satisfy the check above.
    expect(hits.filter(([, url]) => url === STG_ORIGIN).length).toBeGreaterThanOrEqual(5);
  });
});
