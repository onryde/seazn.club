// Match Day PB2, review C1 (owner 2026-11-02, option A): V489 stores the competitions frozen TODAY before the deploy, so the
// app's first read after it finds the set already chosen. The migration restates the app's limit for `competitions.max_active`
// in SQL (lib/entitlements.ts's `getLimit` has no SQL twin), so this suite holds the two together: the migration's OWN block,
// read from the file by glob, runs against seeded organisations in each billing state the resolver distinguishes, inside a
// transaction that is always rolled back and scoped to one organisation as the app's tenant role (RLS shows it that org's
// rows alone, so the shared test DB's other organisations neither feed nor feel it). Its choice is compared with the APP's own:
// `frozenCompetitionIds` on the same untouched organisation, whose first read chooses with the resolver's limit and the
// selector's ranking. The expected side is never the SQL under test.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql, type Tx } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { builtinModules } from "@seazn/engine/sports";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { frozenCompetitionIds } from "../usecases/entitlement-freeze";
import { scoreEvent } from "../usecases/scoring";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__competition_frozen_at\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
const BLOCK = /do \$\$[\s\S]*?end \$\$;/.exec(text.replace(/--.*$/gm, ""))?.[0];
const NOTICE = /^V489 competitions frozen today, stored: competitions=(\d+) organisations=(\d+)$/;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ROLLBACK = new Error("rollback");

/** The migration's block, as `orgId`'s tenant, on a one-connection client, always rolled back: the competitions it marked
 *  and the count it announced. */
async function backfillChoice(orgId: string): Promise<{ marked: string[]; announced: number }> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let out: { marked: string[]; announced: number } | undefined;
  try {
    await client.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      // The migrating role reads `org_addons`; the tenant role is not granted it (the app reads add-ons on its pooled,
      // owner connection). Granted here, inside this transaction only, so the block reads what it reads in the migration.
      await tx`grant select on org_addons to app_user`;
      await tx`select set_config('app.current_org', ${orgId}, true)`;
      await tx`set local role app_user`;
      // Untouched before the block: the organisation holds no mark the block could be mistaken for.
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from competitions where frozen_at is not null`;
      if (n !== 0) throw new Error(`premise: ${n} competitions already marked before the backfill`);
      await tx.unsafe(BLOCK!);
      const marked = (await tx<{ id: string }[]>`select id from competitions where frozen_at is not null order by id`).map(
        (r) => r.id,
      );
      const m = notices.map((x) => NOTICE.exec(x)).find((x) => x !== null);
      if (!m) throw new Error(`the block announced nothing it stored: ${JSON.stringify(notices)}`);
      out = { marked, announced: Number(m[1]) };
      throw ROLLBACK;
    });
    throw new Error("the backfill committed");
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  } finally {
    await client.end();
  }
  return out!;
}

async function bareOrg(label: string): Promise<string> {
  const s = randomUUID().slice(0, 8);
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`Backfill ${label} ${s}`}, ${`backfill-${label}-${s}`}) returning id`;
  return id;
}

/** `n` draft competitions, one minute apart, oldest first: a ranking with no ties. */
async function competitions(orgId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = randomUUID().slice(0, 8);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, status, created_at)
      values (${orgId}, ${"C " + s}, ${"c-" + s}, 'draft', now() - make_interval(mins => ${60 - i})) returning id`;
    ids.push(id);
  }
  return ids;
}

async function override(orgId: string, int: number | null, expiresAt: string | null): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, expires_at)
    values (${orgId}, 'competitions.max_active', ${int}, ${expiresAt})
    on conflict (org_id, feature_key) do update set int_value = excluded.int_value, expires_at = excluded.expires_at`;
}

interface Case {
  name: string;
  /** Builds the organisation; returns its id. */
  build: () => Promise<string>;
}

const CASES: Case[] = [
  {
    name: "community, two over its limit",
    build: async () => {
      const org = await bareOrg("community");
      await setOrgPlan(org, "community");
      await competitions(org, 5);
      return org;
    },
  },
  {
    name: "community, exactly at its limit (nothing freezes)",
    build: async () => {
      const org = await bareOrg("at-limit");
      await setOrgPlan(org, "community");
      await invalidateOrgEntitlements(org);
      await competitions(org, (await getLimit(org, "competitions.max_active"))!);
      return org;
    },
  },
  {
    name: "pro",
    build: async () => {
      const org = await bareOrg("pro");
      await setOrgPlan(org, "pro");
      await competitions(org, 5);
      return org;
    },
  },
  {
    name: "a staff override pinning the ceiling at 0",
    build: async () => {
      const org = await bareOrg("pin0");
      await setOrgPlan(org, "pro");
      await override(org, 0, null);
      await competitions(org, 3);
      return org;
    },
  },
  {
    name: "a live override raising community to 4",
    build: async () => {
      const org = await bareOrg("ov4");
      await setOrgPlan(org, "community");
      await override(org, 4, null);
      await competitions(org, 6);
      return org;
    },
  },
  {
    name: "an EXPIRED override (falls through to the plan)",
    build: async () => {
      const org = await bareOrg("ovexp");
      await setOrgPlan(org, "community");
      await override(org, 50, "2020-01-01T00:00:00Z");
      await competitions(org, 5);
      return org;
    },
  },
  {
    name: "a live override with a null int (unlimited)",
    build: async () => {
      const org = await bareOrg("ovnull");
      await setOrgPlan(org, "community");
      await override(org, null, null);
      await competitions(org, 6);
      return org;
    },
  },
  {
    name: "a suspended organisation on pro (resolves community)",
    build: async () => {
      const org = await bareOrg("suspended");
      await setOrgPlan(org, "pro");
      await sql`update organizations set status = 'suspended' where id = ${org}`;
      await competitions(org, 5);
      return org;
    },
  },
  {
    name: "a pro subscription cancelled with no comp (resolves community)",
    build: async () => {
      const org = await bareOrg("canceled");
      await setOrgPlan(org, "pro", "canceled");
      await competitions(org, 5);
      return org;
    },
  },
  {
    name: "community plus a granted add-on of one",
    build: async () => {
      const org = await bareOrg("addon");
      const wallet = await setOrgPlan(org, "community");
      await sql`
        insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
        values (${wallet}, ${org}, 'competitions.max_active', 1, 1, 'granted')`;
      await competitions(org, 6);
      return org;
    },
  },
  {
    name: "community, an Event Pass buying the oldest competition out",
    build: async () => {
      const org = await bareOrg("pass");
      await setOrgPlan(org, "community");
      const ids = await competitions(org, 5);
      await sql`insert into competition_passes (competition_id, org_id) values (${ids[0]!}, ${org})`;
      return org;
    },
  },
  {
    name: "community, the OLDEST competition scored just now (activity outranks creation)",
    build: async () => {
      const variant = Object.keys(builtinModules.find((m) => m.key === "badminton")!.variants)[0]!;
      const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", variant), stageKind: "knockout", entrants: 4 });
      await sql`update competitions set created_at = now() - interval '90 days' where id = ${s.competitionId}`;
      await setOrgPlan(s.auth.orgId, "community");
      await competitions(s.auth.orgId, 4);
      await scoreEvent(s.auth, s.fixtureIds[0]!, { expected_seq: 0, type: "core.start", payload: {} });
      return s.auth.orgId;
    },
  },
];

describe.skipIf(!HAS_DB)("V489's backfill stores the competitions frozen today, as the app chooses them", () => {
  it("the migration is one file with one block that announces what it stored", () => {
    expect(files, "exactly one V*__competition_frozen_at.sql").toHaveLength(1);
    expect(BLOCK, "a do block").toBeDefined();
    expect(text).toMatch(/alter table competitions add column frozen_at timestamptz null;/);
  });

  it("every billing state: the backfill marks exactly the competitions the app's own first read freezes (counted, both empty and non-empty)", async () => {
    let checked = 0;
    let nonEmpty = 0;
    let empty = 0;
    for (const c of CASES) {
      const org = await c.build();
      await invalidateOrgEntitlements(org);
      const fromMigration = await backfillChoice(org);
      expect(fromMigration.announced, `${c.name}: the notice counts what it marked`).toBe(fromMigration.marked.length);
      const fromApp = [...(await frozenCompetitionIds(org))].sort();
      expect(fromMigration.marked, c.name).toEqual(fromApp);
      checked++;
      if (fromApp.length > 0) nonEmpty++;
      else empty++;
    }
    expect(checked, "every case ran").toBe(CASES.length);
    expect(nonEmpty, "cases where something freezes").toBeGreaterThanOrEqual(7);
    expect(empty, "cases where nothing freezes").toBeGreaterThanOrEqual(3);
  }, 240_000);
});
