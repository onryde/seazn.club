// Per-stage match rules, Task 3 (design 2026-09-17 §T2) — the six writers that
// rewrite a stage's WHOLE config from a JS-side read must merge server-side
// instead, or a concurrent `rules` write landing inside their read-modify-write
// window is silently lost: no error, no conflict, just a reverted override.
//
// Reproducing that window needs a real interleave, not a sequential write. Two
// of the six sites read `stages.config` and only THEN take
// `pg_advisory_xact_lock('division:…')` — so holding that lock from a second
// connection parks the usecase at a known point, AFTER its read. Writing
// `rules` while it is parked, then releasing, drives the exact race. A test
// that merely writes `rules` first and calls the usecase proves nothing: the
// usecase would read the rules key along with everything else and spread it
// straight back, green on the broken code.
//
// The other four sites (seedNextStage, confirmSeedProposal, and onDecided's two)
// take no lock at that point, so no deterministic park exists for them; the
// shape audit at the bottom is what keeps them converted.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, overrideStandings } from "../stages";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sca " + suffix}, ${"sca-" + suffix})
    returning id`;
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
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedStage(auth: AuthCtx): Promise<{ stageId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Sca Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 3 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
    progression: null,
  });
  return { stageId: stage!.id, entrants: entrants.map((e) => e.id) };
}

/** Resolves once the usecase under test is PARKED on the advisory lock — i.e.
 *  it has already read the stage config. Polling `pg_locks` rather than
 *  sleeping keeps the interleave deterministic instead of timing-dependent. */
async function waitForBlockedAdvisoryLock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await sql<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_locks
      where locktype = 'advisory' and not granted`;
    if (waiting > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("usecase never parked on the advisory lock — the race was not reproduced");
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("stage config writes merge server-side (design §T2)", () => {
  it("keeps a concurrently written rules key when overrideStandings sets another key", async () => {
    const { auth } = await seedOrg();
    const { stageId, entrants } = await seedStage(auth);
    const [{ division_id: divisionId }] = await sql<{ division_id: string }[]>`
      select division_id from stages where id = ${stageId}`;
    await sql`update stages set config = config || ${sql.json({ rounds: 5 })} where id = ${stageId}`;

    let landed!: () => void;
    const rulesWritten = new Promise<void>((r) => (landed = r));
    let parked!: () => void;
    const holderHasLock = new Promise<void>((r) => (parked = r));

    // Second connection: take the division lock, then hand control back.
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      parked();
      await rulesWritten;
      await tx`
        update stages set config = config || ${tx.json({ rules: { bestOf: 3 } })}
        where id = ${stageId}`;
    });
    await holderHasLock;

    // overrideStandings now reads the config (no `rules` in it yet) and parks
    // on the lock the holder is sitting on.
    const call = overrideStandings(auth, stageId, {
      rows: [{ entrant_id: entrants[0]!, rank: 1, reason: "placement game" }],
    });
    await waitForBlockedAdvisoryLock();

    // The rules write lands and commits while the usecase is parked mid-window.
    landed();
    await holder;
    await call;

    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      select config from stages where id = ${stageId}`;
    // A JS-side spread writes the pre-lock snapshot back and erases `rules`.
    expect(row!.config.rules).toEqual({ bestOf: 3 });
    // …while still doing its own job, and without dropping the untouched key.
    expect(row!.config.rank_overrides).toEqual([{ entrant_id: entrants[0]!, rank: 1 }]);
    expect(row!.config.rounds).toBe(5);
  }, 30_000);

  // The behavioural test above can only park the two sites that lock after
  // their read. This keeps the other four converted: every `update stages set
  // config` in these two files must merge server-side (`config || …`), never
  // re-write a spread of a value read into JS. Deleting a site is fine; turning
  // one back into a spread is not.
  it("leaves no read-modify-write stage-config writer in stages.ts or scoring.ts", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const file of ["src/server/usecases/stages.ts", "src/server/usecases/scoring.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/update stages\s+set config\s*=\s*\$\{/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
      // The write is often split across lines; catch the spread form too.
      const flat = src.replace(/\s+/g, " ");
      for (const m of flat.matchAll(/update stages set config = \$\{[^}]*\.\.\./g))
        offenders.push(`${file}: spread form — ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
