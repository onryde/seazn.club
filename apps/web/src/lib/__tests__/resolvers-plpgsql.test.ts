// The `__org_has_feature_plpgsql.sql` delta (V537 when written; read by GLOB, never by number, so a renumber at merge
// does not orphan this file). Four claims, each pinned against a source that is NOT the delta itself:
//
//  1. The resolvers changed LANGUAGE and nothing else. org_has_feature (both arities) and stage_qualification_meta are
//     plpgsql — the per-session plan cache is the whole fix (a SECURITY DEFINER SQL function re-plans its body on every
//     statement) — and keep STABLE, SECURITY DEFINER, not-STRICT, V306's search_path, their signatures, OUT columns and
//     grants. Their bodies are the latest previous definers' queries VERBATIM (V344, V306, V475 — comments and
//     whitespace aside), read out of those files; the applied prosrc is the delta's. Behaviour parity beyond the text is
//     the parity suites' job (entitlements-sql-parity, pass-under-paid-plan, entitlements-v18-*,
//     public-stages-qualification-db, stage-qualification-db), which run unchanged against the migrated schema.
//  2. stage_qualification_meta declares `rows 1` (the one deliberate planner change).
//  3. billing_events_unprocessed_idx exists with the replay sweep's predicate, and the sweep's OWN query — read out of
//     usecases/billing-events/ledger.ts, not retyped — can be served by it.
//  4. The two Realtime policies evaluate realtime.topic() once. Neither this suite's DB nor CI's Postgres has a
//     `realtime` schema, so the delta's block is replayed against a STUB of Supabase's (topic() and jwt() bodies copied
//     from Supabase) inside a rolled-back transaction: V403 and V452 run first, then the delta's block, and the policy
//     rows and the rows each claim can read are compared before and after. On a database that does have `realtime`, the
//     live policies are read instead and the stub is skipped.
//
// No sport dimension: every claim here is catalog/DDL shape, identical for every sport, so there is no registry sweep.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql, type Tx } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const REPO = resolve(__dirname, "../../../../..");
const MIGRATIONS = resolve(REPO, "db/migration");
const DELTAS = resolve(MIGRATIONS, "deltas");
const SCHEMA = HAS_DB ? connectionOptions(process.env.DATABASE_URL!).schema : "seazn_club";

function deltaBySuffix(suffix: string): { version: number; text: string } {
  const re = new RegExp(`^V(\\d+)__${suffix}\\.sql$`);
  const hits = readdirSync(DELTAS).filter((f) => re.test(f));
  if (hits.length !== 1) throw new Error(`premise: one delta named *__${suffix}.sql, found ${hits.length}`);
  return { version: Number(re.exec(hits[0]!)![1]), text: readFileSync(resolve(DELTAS, hits[0]!), "utf8") };
}

const THIS = deltaBySuffix("org_has_feature_plpgsql");
const V344 = deltaBySuffix("org_has_feature_pass_on_any_plan");
const V306 = deltaBySuffix("entitlement_resolver_parity");
const V475 = deltaBySuffix("w2d_table_rules");
const V403 = deltaBySuffix("realtime_fixture_broadcast_policy");
const V452 = deltaBySuffix("online_chess_realtime_policy");
// W5 app PR B Task 6 (K25): a LATER definer of stage_qualification_meta - two OUT columns appended, the body otherwise V475's, in
// this delta's plpgsql form. The applied catalog is that delta's from then on; the static claims above stay about this delta.
const V538 = deltaBySuffix("w5_qualification_frozen_cut");

const HEADERS = {
  ohf3: /create (?:or replace )?function (?:\$\{flyway:defaultSchema\}\.)?org_has_feature\(\s*p_org_id uuid,\s*p_feature_key text,\s*p_competition_id uuid\s*\)/i,
  ohf2: /create (?:or replace )?function (?:\$\{flyway:defaultSchema\}\.)?org_has_feature\(\s*p_org_id uuid,\s*p_feature_key text\s*\)/i,
  sqm: /create (?:or replace )?function (?:\$\{flyway:defaultSchema\}\.)?stage_qualification_meta\(\s*p_stage_id uuid\s*\)/i,
} as const;

/** The dollar-quoted body after `header` in `text` — the text Postgres stores as prosrc. */
function bodyAfter(text: string, header: RegExp): string {
  const m = header.exec(text);
  if (!m) throw new Error(`premise: ${header} not found`);
  const open = text.indexOf("$$", m.index);
  const close = text.indexOf("$$", open + 2);
  if (open < 0 || close < 0) throw new Error(`premise: no $$ body after ${header}`);
  return text.slice(open + 2, close);
}

/** Comments dropped, whitespace collapsed: what is left is what the parser sees. */
const norm = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

/** Every migration file in the tree, with its version, that defines `header`. */
function definers(header: RegExp): number[] {
  const out: number[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^V\d+__.*\.sql$/.test(e.name) && header.test(readFileSync(p, "utf8"))) {
        out.push(Number(/^V(\d+)__/.exec(e.name)![1]));
      }
    }
  };
  walk(MIGRATIONS);
  return out.sort((a, b) => a - b);
}

/** The delta's Realtime block, exactly as Flyway runs it. */
const REALTIME_BLOCK = (() => {
  const hits = THIS.text.match(/do \$migrate\$[\s\S]*?\$migrate\$;/g) ?? [];
  if (hits.length !== 1) throw new Error(`premise: one realtime do-block in the delta, found ${hits.length}`);
  return hits[0]!;
})();

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe("the delta's bodies are the previous definers' queries, verbatim", () => {
  it("V344 / V306 / V475 are the latest definers below this delta (the copy's premise)", () => {
    const latestBelow = (h: RegExp) => definers(h).filter((v) => v < THIS.version).at(-1);
    expect(latestBelow(HEADERS.ohf3)).toBe(V344.version);
    expect(latestBelow(HEADERS.ohf2)).toBe(V306.version);
    expect(latestBelow(HEADERS.sqm)).toBe(V475.version);
  });

  it("each body is its source's query wrapped for plpgsql, and nothing else", () => {
    const WRAP = "#variable_conflict use_column begin";
    const cases: [string, string, string][] = [
      ["org_has_feature/3", bodyAfter(THIS.text, HEADERS.ohf3), `${WRAP} return ( ${norm(bodyAfter(V344.text, HEADERS.ohf3))} ); end`],
      [
        "org_has_feature/2",
        bodyAfter(THIS.text, HEADERS.ohf2),
        `${WRAP} return ${norm(bodyAfter(V306.text, HEADERS.ohf2)).replace(/^select /, "")}; end`,
      ],
      ["stage_qualification_meta", bodyAfter(THIS.text, HEADERS.sqm), `${WRAP} return query ${norm(bodyAfter(V475.text, HEADERS.sqm))}; end`],
    ];
    let checked = 0;
    for (const [name, body, expected] of cases) {
      expect(norm(body), name).toBe(expected);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

type ProcRow = {
  sig: string;
  lanname: string;
  prosecdef: boolean;
  provolatile: string;
  proisstrict: boolean;
  proretset: boolean;
  prorows: number;
  ret: string;
  proargnames: string[] | null;
  modes: string[] | null;
  proconfig: string[] | null;
  acl: string[] | null;
  prosrc: string;
};

// Typed from the sources' own headers (V306 search_path; V344/V306/V475 signatures and OUT columns; V475's grants;
// V228 never touched org_has_feature's ACL) and the brief's `rows 1`, never read back from the delta.
const EXPECTED: { sig: string; args: string[]; modes: string[] | null; ret: string; retset: boolean; rows: number; header: RegExp; source?: { text: string } }[] = [
  { sig: "org_has_feature(uuid,text)", args: ["p_org_id", "p_feature_key"], modes: null, ret: "boolean", retset: false, rows: 0, header: HEADERS.ohf2 },
  {
    sig: "org_has_feature(uuid,text,uuid)",
    args: ["p_org_id", "p_feature_key", "p_competition_id"],
    modes: null,
    ret: "boolean",
    retset: false,
    rows: 0,
    header: HEADERS.ohf3,
  },
  {
    sig: "stage_qualification_meta(uuid)",
    // V538 appends `qualify_best_nth`, `qualified` (W5 Task 6)
    args: ["p_stage_id", "qualify_count", "qualify_per_group", "next_stage_name", "swiss_rounds", "points_rule", "has_rank_overrides", "qualify_best_nth", "qualified"],
    modes: ["i", "t", "t", "t", "t", "t", "t", "t", "t"],
    ret: "record",
    retset: true,
    rows: 1,
    header: HEADERS.sqm,
    source: V538,
  },
];

describe.skipIf(!HAS_DB)("the applied resolvers (real Postgres)", () => {
  it("are plpgsql, STABLE, SECURITY DEFINER, not STRICT, with V306's search_path and unchanged signatures and grants", async () => {
    const rows = await sql<ProcRow[]>`
      select p.proname || '(' || array_to_string(p.proargtypes::regtype[]::text[], ',') || ')' as sig,
             l.lanname, p.prosecdef, p.provolatile::text as provolatile, p.proisstrict, p.proretset,
             p.prorows::float8 as prorows, p.prorettype::regtype::text as ret, p.proargnames,
             p.proargmodes::text[] as modes, p.proconfig, p.proacl::text[] as acl, p.prosrc
        from pg_proc p
        join pg_language l on l.oid = p.prolang
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = ${SCHEMA} and p.proname in ('org_has_feature', 'stage_qualification_meta')
       order by 1`;
    expect(rows.map((r) => r.sig)).toEqual(EXPECTED.map((e) => e.sig));
    let checked = 0;
    for (const e of EXPECTED) {
      const r = rows.find((x) => x.sig === e.sig)!;
      expect(r.lanname, e.sig).toBe("plpgsql");
      expect(r.prosecdef, e.sig).toBe(true);
      expect(r.provolatile, e.sig).toBe("s");
      expect(r.proisstrict, e.sig).toBe(false);
      expect(r.proretset, e.sig).toBe(e.retset);
      expect(r.prorows, e.sig).toBe(e.rows);
      expect(r.ret, e.sig).toBe(e.ret);
      expect(r.proargnames, e.sig).toEqual(e.args);
      expect(r.modes, e.sig).toEqual(e.modes);
      expect(r.proconfig, e.sig).toEqual([`search_path=${SCHEMA}, pg_temp`]);
      // What is applied is the latest definer's body (this delta's, or V538's for stage_qualification_meta), not a stale or
      // hand-edited one.
      expect(norm(r.prosrc), e.sig).toBe(norm(bodyAfter((e.source ?? THIS).text, e.header)));
      checked++;
    }
    expect(checked).toBe(3);

    // Grants survive CREATE OR REPLACE: V475 revoked stage_qualification_meta from PUBLIC and granted app_user; nothing
    // ever narrowed org_has_feature's default (PUBLIC execute).
    const sqm = rows.find((r) => r.sig === "stage_qualification_meta(uuid)")!;
    expect(sqm.acl?.some((a) => a.startsWith("=")), "PUBLIC regained execute").toBe(false);
    expect(sqm.acl?.some((a) => a.startsWith("app_user=X/")), "app_user lost execute").toBe(true);
    for (const r of rows.filter((x) => x.sig.startsWith("org_has_feature"))) expect(r.acl, r.sig).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("billing_events_unprocessed_idx (real Postgres)", () => {
  it("exists with the sweep's predicate, and the sweep's own query can be served by it", async () => {
    const idx = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = ${SCHEMA} and tablename = 'billing_events' and indexname = 'billing_events_unprocessed_idx'`;
    expect(idx.map((r) => r.indexdef)).toEqual([
      `CREATE INDEX billing_events_unprocessed_idx ON ${SCHEMA}.billing_events USING btree (received_at) WHERE ((processed_at IS NULL) AND (replay_attempts < 4))`,
    ]);

    // The REAL query, out of sweepStuckEvents — so a predicate edit there that stops matching the index reds here.
    const ledger = readFileSync(resolve(REPO, "apps/web/src/server/usecases/billing-events/ledger.ts"), "utf8");
    const queries = ledger.match(/select id, type, replay_attempts from billing_events[\s\S]*?limit \$\{limit\}/g) ?? [];
    expect(queries, "the sweep's query was not found in ledger.ts").toHaveLength(1);
    const sweep = queries[0]!.replace("${limit}", "25");

    // enable_seqscan off: on a test DB the table is tiny and a scan would win on cost, so this asks whether the index
    // is APPLICABLE (the planner can prove the sweep's predicate implies the index's), not whether stats pick it today.
    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const [row] = await tx.unsafe<{ "QUERY PLAN": unknown }[]>(`explain (format json) ${sweep}`);
      return JSON.stringify(row!["QUERY PLAN"]);
    });
    expect(plan).toContain(`"Index Name":"billing_events_unprocessed_idx"`);
  });
});

// ── Realtime policies ────────────────────────────────────────────────────────

type Policy = { policyname: string; cmd: string; roles: string[]; permissive: string; qual: string; with_check: string | null };
const POLICY_NAMES = ["external play lobby read by claim", "fixture broadcast read by claim"];
const WRAPPED = "( SELECT realtime.topic() AS topic)";

async function readPolicies(tx: Tx | typeof sql): Promise<Policy[]> {
  return tx<Policy[]>`
    select policyname, cmd, roles::text[] as roles, permissive, qual, with_check
      from pg_policies
     where schemaname = 'realtime' and tablename = 'messages' and policyname = any(${POLICY_NAMES}::text[])
     order by policyname`;
}

const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
async function rolledBack<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<{ value: T; notices: string[] }> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: SCHEMA },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx, notices);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return { value: value as T, notices };
}

async function hasRealtime(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`;
  return r!.n > 0;
}

/** Supabase's Realtime surface, as far as these two policies touch it. topic() and jwt() are Supabase's own bodies. */
async function stubRealtime(tx: Tx): Promise<void> {
  await tx.unsafe(`
    create schema realtime;
    create table realtime.messages (topic text not null, extension text not null, payload jsonb);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as
      $f$ select nullif(current_setting('realtime.topic', true), '')::text $f$;
    create schema if not exists auth;
    create or replace function auth.jwt() returns jsonb language sql stable as
      $f$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                          nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
    do $r$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $r$;
    grant usage on schema realtime, auth to authenticated;
    grant select on realtime.messages to authenticated;
    insert into realtime.messages (topic, extension) values ('any', 'broadcast'), ('any', 'presence');
  `).simple();
}

const TOPICS = ["fixture:A", "fixture:B", "external-play:A", "external-play:B", ""];
const CLAIMS = [{ fixture_id: "A" }, { lobby_fixture_id: "A" }, {}];

/** For every (channel topic, token claims) pair: how many rows an `authenticated` subscriber can read. */
async function visibility(tx: Tx): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const topic of TOPICS) {
    for (const claims of CLAIMS) {
      await tx`select set_config('realtime.topic', ${topic}, true), set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      await tx`set local role authenticated`;
      const [r] = await tx<{ n: number }[]>`select count(*)::int as n from realtime.messages`;
      await tx`reset role`;
      out[`${topic} | ${JSON.stringify(claims)}`] = r!.n;
    }
  }
  return out;
}

describe.skipIf(!HAS_DB)("the Realtime policies evaluate realtime.topic() once", () => {
  it("on a database WITH Supabase Realtime: both live policies wrap topic()", async ({ skip }) => {
    if (!(await hasRealtime())) return skip();
    const live = await readPolicies(sql);
    expect(live.map((p) => p.policyname)).toEqual(POLICY_NAMES);
    for (const p of live) expect(p.qual, p.policyname).toContain(WRAPPED);
  });

  // The empty cases first: the block must skip, cleanly, wherever there is nothing to rewrite.
  it("no realtime schema: the block skips with its notice and creates nothing", async ({ skip }) => {
    if (await hasRealtime()) return skip();
    const { value, notices } = await rolledBack(async (tx) => {
      await tx.unsafe(REALTIME_BLOCK).simple();
      return (await tx<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`)[0]!.n;
    });
    expect(value).toBe(0);
    expect(notices).toContain(`V${THIS.version}: no realtime schema — skip (non-Supabase database)`);
  });

  it("realtime schema without messages: the block skips with its notice", async ({ skip }) => {
    if (await hasRealtime()) return skip();
    const { notices } = await rolledBack(async (tx) => {
      await tx`create schema realtime`;
      await tx.unsafe(REALTIME_BLOCK).simple();
    });
    expect(notices).toContain(`V${THIS.version}: realtime.messages missing — skip`);
  });

  it("after V403 + V452: topic() is wrapped, all else is identical, every claim reads the same rows, and a re-run changes nothing", async ({
    skip,
  }) => {
    if (await hasRealtime()) return skip();
    const { value } = await rolledBack(async (tx) => {
      await stubRealtime(tx);
      await tx.unsafe(V403.text).simple();
      await tx.unsafe(V452.text).simple();
      const before = await readPolicies(tx);
      const seenBefore = await visibility(tx);
      await tx.unsafe(REALTIME_BLOCK).simple();
      const after = await readPolicies(tx);
      const seenAfter = await visibility(tx);
      await tx.unsafe(REALTIME_BLOCK).simple();
      const again = await readPolicies(tx);
      return { before, after, again, seenBefore, seenAfter };
    });
    const { before, after, again, seenBefore, seenAfter } = value;

    // Premise: the stub reproduces the lint — V403/V452 as written call topic() bare.
    expect(before.map((p) => p.policyname)).toEqual(POLICY_NAMES);
    for (const p of before) {
      expect(p.qual, p.policyname).toContain("realtime.topic()");
      expect(p.qual, p.policyname).not.toContain(WRAPPED);
    }

    // The rewrite is exactly the wrap: the expected policy is V403/V452's own row with topic() replaced, nothing else.
    let checked = 0;
    for (const b of before) {
      const a = after.find((p) => p.policyname === b.policyname);
      expect(a, b.policyname).toEqual({ ...b, qual: b.qual.replace("realtime.topic()", WRAPPED) });
      checked++;
    }
    expect(checked).toBe(2);
    expect(again).toEqual(after);

    // Same answer: every (topic, claims) pair reads the same rows before and after. Non-vacuous: 15 pairs, and exactly
    // the two the policies exist to admit (a token for fixture A on fixture:A; a lobby token for A on external-play:A)
    // read anything — the broadcast row and never the presence one.
    expect(Object.keys(seenAfter)).toHaveLength(TOPICS.length * CLAIMS.length);
    expect(seenAfter).toEqual(seenBefore);
    expect(Object.entries(seenAfter).filter(([, n]) => n > 0)).toEqual([
      [`fixture:A | ${JSON.stringify({ fixture_id: "A" })}`, 1],
      [`external-play:A | ${JSON.stringify({ lobby_fixture_id: "A" })}`, 1],
    ]);
  });

  it("not the table's owner: the block skips with its notice and V403/V452's policies are left as they were", async ({ skip }) => {
    if (await hasRealtime()) return skip();
    const { value, notices } = await rolledBack(async (tx) => {
      await stubRealtime(tx);
      await tx.unsafe(V403.text).simple();
      await tx.unsafe(V452.text).simple();
      const before = await readPolicies(tx);
      await tx`grant usage on schema realtime to app_user`;
      await tx`set local role app_user`;
      await tx.unsafe(REALTIME_BLOCK).simple();
      await tx`reset role`;
      return { before, after: await readPolicies(tx) };
    });
    expect(notices).toContain(`V${THIS.version}: insufficient privilege on realtime.messages — skip (not owner)`);
    expect(value.before).toHaveLength(2);
    expect(value.after).toEqual(value.before);
  });
});
