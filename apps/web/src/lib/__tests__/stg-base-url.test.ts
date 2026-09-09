import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The staging origin was written out FIVE times in the workflows (the cron
// jobs' BASE_URL) until #757 moved those eight files to
// onryde/seazn.club.workflow — this repo now carries ZERO workflow copies —
// and THREE times in fly.stg.toml (runtime [env] twice —
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
    // MOVED 2026-09-09 (#757): the eight scheduled ops workflows carried every
    // one of this repo's workflow BASE_URLs, and they now live in
    // onryde/seazn.club.workflow. The floor that used to sit here (">= 5", and
    // a matching staging floor at the end) counted files this repo no longer
    // has, so it could only ever fail from now on.
    //
    // The floor is not simply lowered to zero, which would leave the regex
    // untested and the whole check vacuous — a renamed key would then pass by
    // finding nothing. It is proven against a fixture instead, so the scan
    // above still has teeth even while the real answer is empty.
    const PROBE = [
      "    BASE_URL: https://stg.seazn.club",
      "      PLAYWRIGHT_BASE: https://seazn.club",
      "# BASE_URL: https://commented-out.example",
    ].join("\n");
    const probed = [...PROBE.matchAll(/^\s*(?:BASE_URL|PLAYWRIGHT_BASE):\s*(https:\/\/\S+)/gm)].map(
      (m) => m[1],
    );
    // Two, not three: the commented line is skipped, which is itself worth
    // pinning — this scan runs over files whose headers discuss base URLs at
    // length, so a regex that matched prose would report hosts nobody set.
    expect(probed).toEqual([STG_ORIGIN, PROD_ORIGIN]);

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

    // The staging floor went with the same eight files. What survives is the
    // property that mattered — no workflow in this repo points at a host
    // nobody meant — plus the fly.stg.toml agreement above, which is now the
    // only place a half-done domain change can still be caught HERE. The
    // workflow half of that guard belongs beside the workflows, in the repo
    // that now holds them.
    expect(hits.filter(([, url]) => url === STG_ORIGIN).length).toBeGreaterThanOrEqual(0);
  });
});
