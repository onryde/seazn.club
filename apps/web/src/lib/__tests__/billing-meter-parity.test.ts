// A usage METER and the quota it reports on are two faces of one fact, and in
// this repo they were two implementations of it.
//
// They drifted three separate times. `assertActiveQuota` excludes Event-Passed
// competitions (v3/07 §3) and the billing meter did not, so an org with 5
// active + 1 passed saw "6 / 5" in red while enforcement was still letting it
// create another. That was patched by COPYING the clause across — and the copy
// then drifted on its own terms, because it asked whether a pass ROW EXISTS,
// which V343 retired precisely for keeping a lapsed pass exempt for ever. The
// public-dashboard count sitting beside it, meanwhile, never grew a status or
// a pass clause at all, so it metered archived seasons: a Free org (cap 2) with
// 2 live public competitions and 3 archived public ones read 5/2 in red for an
// org enforcement counted at 2 and was happily publishing for.
//
// So the fix is not a third agreeing copy. `countActiveCompetitions` and
// `countPublicDashboards` (server/usecases/entitlement-freeze.ts) are the one
// authority, and enforcement and BOTH meters call them.
//
// This file guards that from two directions, because neither half is enough:
//
//  1. STRUCTURALLY — no meter may carry a competition count of its own again.
//     The billing page is a server component with no importable query, so a
//     source scan is the only witness available for it.
//  2. BEHAVIOURALLY — against real Postgres, that the shared count means
//     `pass_applies` and not "a pass row exists". That is the clause the
//     previous copy got wrong, and no source scan can tell the two apart.
import { describe, expect, it, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { sql } from "@/lib/db";
import { countActiveCompetitions, countPublicDashboards } from "@/server/usecases/entitlement-freeze";

const SRC = path.resolve(__dirname, "../..");

const BILLING_PAGE = path.join(SRC, "app/o/[orgSlug]/settings/billing/page.tsx");
const ENTITLEMENTS_ROUTE = path.join(SRC, "app/api/orgs/[id]/entitlements/route.ts");
const QUOTA_USECASE = path.join(SRC, "server/usecases/competitions.ts");
const PREDICATE_SOURCE = path.join(SRC, "server/usecases/entitlement-freeze.ts");

/** The clause that takes passed competitions out of the tally. */
const EXCLUSION = /not exists\s*\(\s*select 1 from competition_passes/i;
/** …and the predicate it must be evaluated through, never a bare row test. */
const APPLIES = /pass_applies\(/;
/** Any hand-rolled count over the competitions table. */
const OWN_COUNT = /count\(\*\)[^;]{0,200}?from competitions/is;

const HAS_DB = !!process.env.DATABASE_URL;

describe("competition counts have ONE implementation", () => {
  // The two meters, by the function each must call. A meter that stopped
  // calling one of these would be back to answering the question itself.
  const CALLERS: [string, string, string[]][] = [
    ["the billing page", BILLING_PAGE, ["countActiveCompetitions", "countPublicDashboards"]],
    ["the entitlements route", ENTITLEMENTS_ROUTE, ["countActiveCompetitions", "countPublicDashboards"]],
    ["the write-side quota", QUOTA_USECASE, ["countActiveCompetitions", "countPublicDashboards"]],
  ];

  it.each(CALLERS)("%s reads the shared count", (_label, file, fns) => {
    const src = readFileSync(file, "utf8");
    for (const fn of fns) {
      expect(src.includes(`${fn}(`), `${file} no longer calls ${fn}`).toBe(true);
    }
  });

  it.each(CALLERS)("%s does not count competitions itself", (_label, file) => {
    // The half that actually stops the drift: calling the helper AND keeping a
    // private copy beside it is exactly the state this file exists to end.
    // Comments are stripped first — every one of these files DESCRIBES the
    // query it used to run, and the prose must stay legible.
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    expect(
      OWN_COUNT.test(src),
      `${file} counts the competitions table itself — that is the second ` +
        "implementation this invariant exists to prevent",
    ).toBe(false);
  });

  it("the shared count still carries both halves of the predicate", () => {
    // A `quotaCount` gutted to a bare `select count(*)` would satisfy every
    // call-site check above while putting archived and passed competitions
    // back into all four tallies at once.
    const src = readFileSync(PREDICATE_SOURCE, "utf8");
    const at = src.indexOf("async function quotaCount");
    expect(at, "quotaCount was not found").toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("\n}", at));
    expect(
      /liveUnpassedCompetition\(/.test(fn),
      "quotaCount no longer composes liveUnpassedCompetition — every quota and " +
        "every meter just started counting archived and passed competitions",
    ).toBe(true);

    const pAt = src.indexOf("export function liveUnpassedCompetition");
    expect(pAt, "liveUnpassedCompetition was not found").toBeGreaterThan(-1);
    const predicate = src.slice(pAt, src.indexOf("\n}", pAt));
    expect(EXCLUSION.test(predicate), "the pass exclusion is gone").toBe(true);
    expect(
      APPLIES.test(predicate),
      "the exclusion is back to asking whether a pass ROW EXISTS — V343 retired " +
        "that: a lapsed pass then keeps its exemption for ever (#347)",
    ).toBe(true);
  });
});

// ── What the source scan above cannot see ───────────────────────────────────
//
// Real Postgres required; skipped without DATABASE_URL.
async function seedOrgWith(
  rows: { visibility: string; status: string; endsOn: string | null; passed: boolean }[],
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Parity " + suffix}, ${"parity-" + suffix})
    returning id`;
  for (const [i, row] of rows.entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, status, ends_on)
      values (${orgId}, ${`C${i}`}, ${`c${i}-${suffix}`}, ${row.visibility}, ${row.status},
              ${row.endsOn})
      returning id`;
    if (row.passed) {
      await sql`insert into competition_passes (competition_id, org_id, pass_key)
                values (${id}, ${orgId}, 'event_pass')`;
    }
  }
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the shared count means pass_applies, not 'a pass row exists'", () => {
  // The grace boundary is ends_on + 7 days (V343). One row on each side of it,
  // both `live`, both holding a pass row — so the ONLY thing separating them is
  // the predicate under test.
  const day = 24 * 60 * 60 * 1000;
  const dateStr = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

  it("counts a competition whose pass has lapsed, and not one whose pass applies", async () => {
    const orgId = await seedOrgWith([
      // Ended 30 days ago: well past ends_on + 7, so the pass no longer applies
      // and the competition is back in the tally on both axes.
      { visibility: "public", status: "live", endsOn: dateStr(-30), passed: true },
      // Still running: the pass applies and buys it out of both quotas.
      { visibility: "public", status: "live", endsOn: dateStr(30), passed: true },
    ]);

    expect(
      await countActiveCompetitions(orgId),
      "a lapsed pass must not go on exempting its competition (#347)",
    ).toBe(1);
    expect(await countPublicDashboards(orgId)).toBe(1);
  });

  it("counts neither an archived season nor a private competition", async () => {
    // The status half and the visibility half, each with its own negative — a
    // count that dropped either would still pass the test above.
    const orgId = await seedOrgWith([
      { visibility: "public", status: "archived", endsOn: dateStr(-400), passed: false },
      { visibility: "public", status: "completed", endsOn: dateStr(-400), passed: false },
      { visibility: "private", status: "live", endsOn: dateStr(30), passed: false },
      { visibility: "unlisted", status: "live", endsOn: dateStr(30), passed: false },
    ]);

    // Two archived/completed are out; private and unlisted are both live, so
    // the ACTIVE tally is 2.
    expect(await countActiveCompetitions(orgId)).toBe(2);
    // …of which only the unlisted one is publicly readable.
    expect(await countPublicDashboards(orgId)).toBe(1);
  });

  it("excludeId omits exactly one row, so a lateral visibility move stays possible", async () => {
    const orgId = await seedOrgWith([
      { visibility: "public", status: "live", endsOn: dateStr(30), passed: false },
      { visibility: "unlisted", status: "live", endsOn: dateStr(30), passed: false },
    ]);
    const [{ id }] = await sql<{ id: string }[]>`
      select id from competitions where org_id = ${orgId} and visibility = 'public'`;
    expect(await countPublicDashboards(orgId)).toBe(2);
    expect(await countPublicDashboards(orgId, id)).toBe(1);
  });
});
