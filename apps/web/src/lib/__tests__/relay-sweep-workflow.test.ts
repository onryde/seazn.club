// Sibling of registrations-sweep-workflow.test.ts (#757): the scheduled ops workflows live in
// onryde/seazn.club.workflow, so this repo must NOT schedule the relay sweep. Two repos scheduling one cron would run
// retention and the orphan pass twice a day — and a Machine retry that fires twice is two Machines on one stream key.
// The schedule there is DAILY (owner 2026-09-14); naming it for the owner is Task 17's.
//
// Swept by BEHAVIOUR, not by filename (AGENTS.md class 16): a copy re-added under any other name would pass a
// `relay-sweep.yml`-only check. The claim is "no workflow here SCHEDULES a POST to the relay-sweep endpoint" — so a
// workflow that carries a `schedule:` trigger AND names the endpoint in executable YAML (comments stripped: prose that
// mentions the route schedules nothing) is an offender, as is a file named for it. A manual `workflow_dispatch` that
// drives the route (a smoke leg, say) schedules nothing and is allowed.
//
// The scanner is a function of a directory so its positive pair runs against a planted temporary tree: without that,
// a scanner that finds nothing anywhere would pass on this repo's clean tree forever (TEST-STRATEGY: anti-vacuity).
// What this repo CAN prove about the endpoint's auth (503 unset BEFORE 401 mismatch) is proven by BEHAVIOUR in
// app/api/cron/relay-sweep/route.test.ts, not by reading the route's text.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");
const ROUTE = join(REPO_ROOT, "apps/web/src/app/api/cron/relay-sweep/route.ts");
const ENDPOINT = /\/api\/cron\/relay-sweep\b/;

/** YAML's comment rule (`#` at line start or after whitespace) — the sibling guards' helper. */
const stripComments = (text: string) => text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).join("\n");

function scanWorkflows(dir: string): { scanned: number; offenders: string[] } {
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.ya?ml$/.test(f)).sort();
  const offenders: string[] = [];
  for (const f of files) {
    const yml = stripComments(readFileSync(join(dir, f), "utf8"));
    const named = /^relay-sweep\.ya?ml$/.test(basename(f));
    const schedulesTheRoute = /^\s*schedule\s*:/m.test(yml) && ENDPOINT.test(yml);
    if (named || schedulesTheRoute) offenders.push(f);
  }
  return { scanned: files.length, offenders };
}

const planted = mkdtempSync(join(tmpdir(), "relay-sweep-wf-"));
afterAll(() => rmSync(planted, { recursive: true, force: true }));

describe("relay sweep — what this repo owns (#757)", () => {
  it("NO workflow here schedules the relay sweep, by name or by behaviour — and the scan read every workflow file", () => {
    const { scanned, offenders } = scanWorkflows(WORKFLOWS);
    const expected = readdirSync(WORKFLOWS, { recursive: true }).filter((f) => /\.ya?ml$/.test(String(f))).length;
    expect(scanned, "the scan reads the tree it claims to").toBe(expected);
    expect(scanned, "zero workflow files scanned is a vacuous pass").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    expect(existsSync(join(WORKFLOWS, "relay-sweep.yml"))).toBe(false);
  });

  it("the scanner's positive pair: a file named for the sweep and a SCHEDULED POST to it are both caught; a manual dispatch and a comment-only mention are not", () => {
    writeFileSync(join(planted, "relay-sweep.yml"), "on:\n  workflow_dispatch:\n");
    writeFileSync(join(planted, "nightly-ops.yml"),
      "on:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  sweep:\n    steps:\n      - run: curl -fsS -X POST \"$BASE_URL/api/cron/relay-sweep\" -H \"x-cron-secret: $S\"\n");
    writeFileSync(join(planted, "smoke.yml"),
      "on:\n  workflow_dispatch:\njobs:\n  smoke:\n    steps:\n      - run: curl -X POST \"$BASE_URL/api/cron/relay-sweep\"\n");
    writeFileSync(join(planted, "prose.yml"),
      "# the relay sweep (/api/cron/relay-sweep) is scheduled in onryde/seazn.club.workflow\non:\n  schedule:\n    - cron: '0 4 * * *'\njobs:\n  other:\n    steps:\n      - run: echo hi\n");
    const { scanned, offenders } = scanWorkflows(planted);
    expect(scanned).toBe(4);
    expect(offenders).toEqual(["nightly-ops.yml", "relay-sweep.yml"]);
  });

  it("the endpoint the other repo's workflow POSTs to exists here and calls the sweep", () => {
    const route = readFileSync(ROUTE, "utf8");
    expect(route).toMatch(/export async function POST/);
    expect(route).toMatch(/sweepStreamSessions/);
    expect(route).toMatch(/x-cron-secret/);
  });
});
