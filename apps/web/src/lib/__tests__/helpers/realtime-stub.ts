// A stub of Supabase's Realtime surface for the realtime.messages policy suites (moved verbatim out of
// resolvers-plpgsql.test.ts; `visibility` and `readPolicies` now take their topics, claims and policy names). Neither a
// local label's DB nor CI's Postgres has a `realtime` schema, so a policy delta is replayed against this stub inside a
// transaction that is always rolled back: topic() and jwt() are Supabase's own bodies.
import postgres from "postgres";
import { expect } from "vitest";
import { connectionOptions, sql, type Tx } from "@/lib/db";

export type Policy = { policyname: string; cmd: string; roles: string[]; permissive: string; qual: string; with_check: string | null };

/** The realtime.messages policies named in `names`, as pg_policies shows them, in name order. */
export async function readPolicies(tx: Tx | typeof sql, names: readonly string[]): Promise<Policy[]> {
  return tx<Policy[]>`
    select policyname, cmd, roles::text[] as roles, permissive, qual, with_check
      from pg_policies
     where schemaname = 'realtime' and tablename = 'messages' and policyname = any(${names as string[]}::text[])
     order by policyname`;
}

const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
export async function rolledBack<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<{ value: T; notices: string[] }> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
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

export async function hasRealtime(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`;
  return r!.n > 0;
}

/** Supabase's Realtime surface, as far as these policies touch it. topic() and jwt() are Supabase's own bodies. */
export async function stubRealtime(tx: Tx): Promise<void> {
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

/** For every (channel topic, token claims) pair: how many rows an `authenticated` subscriber can read. */
export async function visibility(
  tx: Tx,
  topics: readonly string[],
  claims: readonly Record<string, unknown>[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const topic of topics) {
    for (const c of claims) {
      await tx`select set_config('realtime.topic', ${topic}, true), set_config('request.jwt.claims', ${JSON.stringify(c)}, true)`;
      await tx`set local role authenticated`;
      const [r] = await tx<{ n: number }[]>`select count(*)::int as n from realtime.messages`;
      await tx`reset role`;
      out[`${topic} | ${JSON.stringify(c)}`] = r!.n;
    }
  }
  return out;
}
