// A cron workflow file that never actually targets the sweep endpoint, never
// carries the secret, or fails silently on a missing secret is
// indistinguishable from a working one: it sits in .github/workflows/,
// "looks scheduled" (a cron entry, a name in the Actions tab), and nothing
// proves it ever calls sweepRegistrations. Before registrations-sweep.yml
// existed, NOTHING called POST /api/cron/registrations in either
// environment — see sweepRegistrations' own doc comment
// (apps/web/src/server/usecases/registrations.ts) — so this pins the
// properties that keep that fixed rather than trusting the file's own prose.
//
// Same shape and reasoning as its siblings — db-suite-ci-wiring.test.ts,
// e2e-ci-wiring.test.ts, stg-base-url.test.ts (comments stripped before
// asserting on the executable YAML, not the prose describing it): pure (no
// DB, no network), so it runs in every job and can never self-skip, which is
// the property that makes a wiring guard worth having at all. Not folded
// into any of those three: none of them pins "does THIS cron workflow POST
// to THIS endpoint with THIS auth header and THIS skip-on-missing-secret
// shape" — a genuinely different claim from "is this file's tree covered by
// a CI job" (db-suite-ci-wiring) or "is this spec selected by a Playwright
// project" (e2e-ci-wiring) or "does every staging workflow agree on one
// origin" (stg-base-url).
//
// MOVED 2026-09-09 (#757): the eight scheduled ops workflows, this one among
// them, now live in onryde/seazn.club.workflow. They ran identical schedules
// against the same endpoints from both repos, so every cron double-fired.
// This repo can no longer read that file, and a guard cannot assert on a file
// it cannot see — so the suite below splits in two.
//
// What stays here is what THIS repo still owns: the endpoint the sweep calls,
// and its auth. What moves is everything about the workflow's own shape; if
// that guard is wanted, it belongs beside the workflow, in the repo that now
// holds it. The property assertions are kept rather than deleted, behind a
// runIf, so that a copy re-added here is still held to them instead of
// arriving unguarded.
//
// Since then the schedule moved again, to apps/cron-worker/src/schedule.ts (the
// Cloudflare cron Worker). The onryde/seazn.club.workflow legs fire the
// endpoint only until each environment's GitHub schedule is switched off.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** apps/web/src/lib/__tests__ — five levels up reaches the repo root (same
 *  climb as db-suite-ci-wiring.test.ts / e2e-ci-wiring.test.ts). */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOW = join(REPO_ROOT, ".github/workflows/registrations-sweep.yml");

/** YAML's actual comment rule (`#` at line start or after whitespace) — a
 *  raw substring search would be satisfied by the header prose alone, which
 *  is exactly the failure this guard exists to catch. Same helper, same
 *  reasoning, as the sibling wiring guards. */
const stripComments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

const PRESENT = existsSync(WORKFLOW);
const ROUTE = join(
  REPO_ROOT,
  "apps/web/src/app/api/cron/registrations/route.ts",
);

describe("registrations sweep — what this repo still owns", () => {
  it("the workflow is NOT here: it moved to onryde/seazn.club.workflow (#757)", () => {
    // Reds if a copy comes back, which is the point: two repos scheduling the
    // same cron is what #757 removed, and it would come back silently.
    // Re-adding one here is then a decision someone has to make out loud —
    // either delete it again, or delete this line and let the runIf block
    // below hold it to every property it used to have.
    expect(PRESENT).toBe(false);
  });

  it("the endpoint the sweep calls still exists, and still demands the secret", () => {
    // The half this repo can actually prove. A workflow in another repo POSTs
    // here with x-cron-secret; if this route ever stops checking it, the sweep
    // becomes an unauthenticated write path and no guard in EITHER repo would
    // have noticed — the workflow's own tests only prove it sends the header.
    const route = readFileSync(ROUTE, "utf8");
    expect(route).toMatch(/process\.env\.CRON_SECRET/);
    expect(route).toMatch(/x-cron-secret/);
    expect(route).toMatch(/401/);
    // Unset secret must refuse rather than accept anything: a missing env var
    // that read as "no auth required" is the shape this asserts against.
    expect(route).toMatch(/503/);
    expect(route).toMatch(/sweepRegistrations/);
  });
});

describe.runIf(PRESENT)("registrations sweep workflow (only if re-added here)", () => {
  const raw = PRESENT ? readFileSync(WORKFLOW, "utf8") : "";
  const yml = stripComments(raw);

  it("finds the workflow file this guard reads", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it("runs on a schedule and supports a manual dispatch for testing", () => {
    expect(yml).toContain("schedule:");
    expect(yml).toContain("cron:");
    expect(yml).toContain("workflow_dispatch:");
  });

  it("targets the registrations sweep endpoint, once per leg", () => {
    const hits = yml.match(/\/api\/cron\/registrations/g) ?? [];
    // Losing a leg (or pointing one at the wrong route) drops this below 2 —
    // vacuity-guarded below by requiring two DIFFERENT hosts as well.
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("covers both staging and production, on two different hosts", () => {
    const urls = [...yml.matchAll(/BASE_URL:\s*(https:\/\/\S+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    // A copy-paste that leaves both legs pointed at the same host would
    // satisfy every other assertion here while sweeping only one
    // environment twice.
    expect(new Set(urls).size).toBeGreaterThanOrEqual(2);
    expect(urls).toContain("https://stg.seazn.club");
    expect(urls).toContain("https://seazn.club");
  });

  it("authenticates with x-cron-secret sourced from secrets.CRON_SECRET", () => {
    expect(yml).toContain("secrets.CRON_SECRET");
    expect(yml).toContain("x-cron-secret");
  });

  it("skips with a warning rather than failing when the secret is missing, for every leg", () => {
    const warnSteps = yml.match(/::warning::/g) ?? [];
    // NOT anchored on a leading `if:` — the production leg's condition is
    // compound (see the PROD_SWEEP_ENABLED gate below), so an `if:`-anchored
    // regex would silently count only the staging leg and pass at 1.
    const guardedSkips = yml.match(/env\.CRON_SECRET\s*==\s*''/g) ?? [];
    const guardedPosts = yml.match(/env\.CRON_SECRET\s*!=\s*''/g) ?? [];
    // One pair of guards per leg (skip step + gated POST step) — a leg
    // missing either half either fails hard on a missing secret (filling
    // the Actions tab with red) or silently never posts at all.
    expect(warnSteps.length).toBeGreaterThanOrEqual(3);
    expect(guardedSkips.length).toBeGreaterThanOrEqual(2);
    expect(guardedPosts.length).toBeGreaterThanOrEqual(2);
  });

  it("gates the production leg, and says out loud what to flip", () => {
    // The seazn-club-prod Fly app did not exist when this shipped (prod.yml's
    // header, owner-confirmed 2026-08-11), so an ungated production leg would
    // fail loud hourly — 24 red runs a day — drowning the runs that matter.
    // A gate is only acceptable because it ANNOUNCES itself; a silently
    // disabled leg is the "seam left for later" that ships inert.
    expect(yml).toContain("vars.PROD_SWEEP_ENABLED");
    expect(yml).toMatch(/env\.PROD_SWEEP\s*!=\s*'true'/);
    expect(yml).toMatch(/env\.PROD_SWEEP\s*==\s*'true'/);
    // The warning must name the variable, or "why is prod not sweeping?"
    // costs someone an afternoon in the workflow file.
    expect(raw).toMatch(/::warning::[^"]*PROD_SWEEP_ENABLED/);
    expect(raw).toMatch(/gh variable set PROD_SWEEP_ENABLED/);
  });

  it("does NOT gate the staging leg — staging exists and must sweep", () => {
    // The gate is scoped to the production job only. A copy-paste that gated
    // both would leave the money path exactly as dead as it was before this
    // workflow existed, while every other assertion here still passed.
    const stagingJob = yml.slice(
      yml.indexOf("sweep-staging:"),
      yml.indexOf("sweep-production:"),
    );
    expect(stagingJob.length).toBeGreaterThan(0);
    expect(stagingJob).not.toContain("PROD_SWEEP");
  });

  it("fails loud on a non-200 rather than swallowing it", () => {
    // curl's --fail-with-body (not bare --fail): the response body still
    // reaches the log before the step fails — same choice every other cron
    // workflow in this repo makes.
    const hits = yml.match(/--fail-with-body/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("documents that the secret must be mirrored into BOTH Fly apps' own config", () => {
    // The RAW (comment-included) text — this is prose, deliberately checked
    // in the file that still carries its comments.
    expect(raw).toMatch(/flyctl secrets set/);
    expect(raw).toMatch(/fly\.stg\.toml/);
    expect(raw).toMatch(/fly\.toml/);
  });
});
