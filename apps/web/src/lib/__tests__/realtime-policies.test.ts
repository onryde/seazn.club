// Realtime push-nudges T1.1 — the `capture pairing read by claim` policy on realtime.messages (V554 when written; the
// delta is found by the policy it creates, never by number or file name, so a renumber at rebase orphans nothing).
//
// A capture phone joins its pairing's private topic with the token `mintCaptureToken` mints. Neither this suite's DB
// nor CI's Postgres has a `realtime` schema, so the deltas run against a STUB of Supabase's (helpers/realtime-stub.ts)
// inside a rolled-back transaction, in Flyway's order: V403, V452, V537's realtime block, then the delta. The tokens
// are the REAL mints (`mintCaptureToken`, `mintPublicFixtureToken`, `mintExternalPlayLobbyToken`) decoded, and the
// topics the REAL builders (`captureTopic`, `fixtureMessage`, `externalPlayLobbyTopic`) — so this proves the claim the
// app mints is the claim the policy reads, not two fixtures that agree. The capture claim's name is read out of the
// minted token, never retyped. On a database that does have `realtime`, the live policy is read instead.
//
// Expected values come from the design, not the delta: the policy name, `to authenticated`, SELECT, and V403's guard
// notices (`V<n>: …`); the readable pairs are the one-claim-per-family rule (the V452 rule).
//
// Sequence cases:
//   - a second call: the delta run twice is one row and the "already present" notice;
//   - an empty input: a token with no claims reads nothing, and no realtime schema / no realtime.messages skip;
//   - after a withdrawal: the policy dropped by hand reads nothing, and a re-run restores the identical row;
//   - another surface: fixture and lobby tokens read no capture topic, and a capture token reads neither of theirs;
//   - not the table's owner: the delta skips with its notice and leaves the earlier policies as they were.
//
// Applies to another sport: N/A (no sport rules).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureTopic,
  externalPlayLobbyTopic,
  fixtureMessage,
  mintCaptureToken,
  mintExternalPlayLobbyToken,
  mintPublicFixtureToken,
} from "@/lib/realtime";
import { sql, type Tx } from "@/lib/db";
import { hasRealtime, readPolicies, rolledBack, stubRealtime, visibility } from "./helpers/realtime-stub";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");

/** The policy under test, as the design names it. */
const POLICY = "capture pairing read by claim";
/** The policies V403 and V452 create (V537 re-creates both). */
const EARLIER = ["external play lobby read by claim", "fixture broadcast read by claim"];
const WRAPPED = "( SELECT realtime.topic() AS topic)";

type Delta = { file: string; version: number; text: string };
const DELTA_FILES = readdirSync(DELTAS).filter((f) => /^V\d+__.+\.sql$/.test(f));
const read = (file: string): Delta => ({
  file,
  version: Number(/^V(\d+)__/.exec(file)![1]),
  text: readFileSync(resolve(DELTAS, file), "utf8"),
});

/** One delta by its name suffix. Throws inside the test that asks, never at collection. */
function bySuffix(suffix: string): Delta {
  const hits = DELTA_FILES.filter((f) => new RegExp(`^V\\d+__${suffix}\\.sql$`).test(f));
  if (hits.length !== 1) throw new Error(`premise: one delta named *__${suffix}.sql, found ${hits.length}`);
  return read(hits[0]!);
}

/** The one delta that creates `POLICY`. Throws inside the test that asks, so a missing delta is a red test. */
function theDelta(): Delta {
  const creates = new RegExp(`create\\s+policy\\s+"${POLICY}"`, "i");
  const hits = DELTA_FILES.filter((f) => creates.test(readFileSync(resolve(DELTAS, f), "utf8")));
  if (hits.length !== 1) throw new Error(`premise: one delta creates "${POLICY}", found ${hits.length}`);
  return read(hits[0]!);
}

/** V537's realtime block, exactly as Flyway runs it (the rest of V537 carries Flyway placeholders). */
function v537Block(): string {
  const hits = bySuffix("org_has_feature_plpgsql").text.match(/do \$migrate\$[\s\S]*?\$migrate\$;/g) ?? [];
  if (hits.length !== 1) throw new Error(`premise: one realtime do-block in V537, found ${hits.length}`);
  return hits[0]!;
}

/** The deltas that precede this one on realtime.messages, in Flyway's order. */
async function earlierPolicies(tx: Tx): Promise<void> {
  await tx.unsafe(bySuffix("realtime_fixture_broadcast_policy").text).simple();
  await tx.unsafe(bySuffix("online_chess_realtime_policy").text).simple();
  await tx.unsafe(v537Block()).simple();
}

/** V403's guard notices, for delta `v`. */
const notice = (v: number) => ({
  noSchema: `V${v}: no realtime schema — skip (non-Supabase database)`,
  noTable: `V${v}: realtime.messages missing — skip`,
  present: `V${v}: policy already present — skip`,
  notOwner: `V${v}: insufficient privilege on realtime.messages — skip (not owner)`,
});

// ── Tokens: the real mints, decoded ──────────────────────────────────────────

/** Claims every family carries; anything else in a payload is the family's own claim. */
const COMMON = ["aud", "exp", "iat", "role", "sub"];
type Token = { name: string; claims: Record<string, unknown> };

async function tokens(): Promise<Token[]> {
  const until = new Date(Date.now() + 10 * 60_000);
  const decoded = async (t: Promise<string>) => ({ ...decodeJwt(await t) }) as Record<string, unknown>;
  return [
    { name: "capture A", claims: await decoded(mintCaptureToken("A", until)) },
    { name: "capture B", claims: await decoded(mintCaptureToken("B", until)) },
    { name: "fixture A", claims: await decoded(mintPublicFixtureToken("A")) },
    { name: "lobby A", claims: await decoded(mintExternalPlayLobbyToken("A", "person:p-1", until)) },
    { name: "no claims", claims: {} },
  ];
}

/** The capture family's own claim, read out of the token `mintCaptureToken` mints. */
async function captureClaim(): Promise<string> {
  const [capture] = await tokens();
  const own = Object.keys(capture!.claims).filter((k) => !COMMON.includes(k));
  expect(own, "a capture token carries exactly one claim of its own").toHaveLength(1);
  return own[0]!;
}

/** Channel topics, from the real builders; the last three are the empty and near-miss cases. */
const TOPICS: { name: string; topic: string }[] = [
  { name: "capture:A", topic: captureTopic("A") },
  { name: "capture:B", topic: captureTopic("B") },
  { name: "fixture:A", topic: fixtureMessage("A", "event").topic },
  { name: "external-play:A", topic: externalPlayLobbyTopic("A") },
  { name: "capture:AB", topic: captureTopic("AB") },
  { name: "capture:", topic: captureTopic("") },
  { name: "(none)", topic: "" },
];

/** Every (topic, token) pair an `authenticated` subscriber can read, as "topic <- token", with how many rows. */
async function readable(tx: Tx, ts: Token[]): Promise<{ pairs: number; reads: [string, number][] }> {
  const seen = await visibility(
    tx,
    TOPICS.map((t) => t.topic),
    ts.map((t) => t.claims),
  );
  const reads: [string, number][] = [];
  for (const t of TOPICS) {
    for (const k of ts) {
      const n = seen[`${t.topic} | ${JSON.stringify(k.claims)}`];
      if (n === undefined) throw new Error(`premise: no visibility row for ${t.name} <- ${k.name}`);
      if (n > 0) reads.push([`${t.name} <- ${k.name}`, n]);
    }
  }
  return { pairs: Object.keys(seen).length, reads };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe("capture pairing read by claim", () => {
  beforeEach(() => {
    // Force the HS256 shared-secret branch whatever a developer's env holds (resolveRealtimeMintKey's own precedence).
    vi.stubEnv("SUPABASE_JWT_PRIVATE_KEY", "");
    vi.stubEnv("SUPABASE_JWT_SIGNING_KEY_B64", "");
    vi.stubEnv("SUPABASE_JWT_SECRET", "x".repeat(40));
    vi.stubEnv("SUPABASE_JWT_ALG", "HS256");
    vi.stubEnv("SUPABASE_JWT_KID", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("premise: exactly one delta creates the policy, and it runs after V537", () => {
    const d = theDelta();
    expect(d.version).toBeGreaterThan(bySuffix("org_has_feature_plpgsql").version);
  });

  describe.skipIf(!HAS_DB)("against a stub of Supabase Realtime (rolled back)", () => {
    /** The whole read matrix after V403, V452, V537 and the delta — computed once, asserted case by case. */
    let matrix: Promise<{ pairs: number; reads: [string, number][] }> | undefined;
    const afterAllFour = () =>
      (matrix ??= (async () => {
        const ts = await tokens();
        const { value } = await rolledBack(async (tx) => {
          await stubRealtime(tx);
          await earlierPolicies(tx);
          await tx.unsafe(theDelta().text).simple();
          return readable(tx, ts);
        });
        return value;
      })());

    it("anti-vacuity: every (topic, token) pair was read, and exactly the four own-family pairs read anything", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { pairs, reads } = await afterAllFour();
      expect(pairs, "pairs checked").toBe(TOPICS.length * 5);
      // One row each — the broadcast row, never the presence one.
      expect(reads).toEqual([
        ["capture:A <- capture A", 1],
        ["capture:B <- capture B", 1],
        ["fixture:A <- fixture A", 1],
        ["external-play:A <- lobby A", 1],
      ]);
    });

    it("a capture token reads its own pairing's topic, and not another pairing's", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllFour();
      const of = (token: string) => reads.filter(([k]) => k.endsWith(`<- ${token}`)).map(([k]) => k);
      expect(of("capture A")).toEqual(["capture:A <- capture A"]);
      expect(of("capture B")).toEqual(["capture:B <- capture B"]);
    });

    it("another surface: a capture token reads neither fixture:A nor external-play:A", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllFour();
      const keys = reads.map(([k]) => k);
      for (const k of ["fixture:A <- capture A", "external-play:A <- capture A"]) expect(keys, k).not.toContain(k);
    });

    it("another surface: a fixture_id token and a lobby token read no capture topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllFour();
      const leaks = reads.map(([k]) => k).filter((k) => k.startsWith("capture:") && !/<- capture [AB]$/.test(k));
      expect(leaks).toEqual([]);
      expect(reads.map(([k]) => k)).not.toContain("capture:A <- fixture A");
    });

    it("empty input: a token with no claims reads nothing, on any topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllFour();
      expect(reads.filter(([k]) => k.endsWith("<- no claims"))).toEqual([]);
    });

    it("the row: SELECT, to authenticated, permissive, no WITH CHECK, topic() wrapped, keyed on the capture claim; earlier policies untouched", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const claim = await captureClaim();
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await earlierPolicies(tx);
        const before = await readPolicies(tx, EARLIER);
        await tx.unsafe(theDelta().text).simple();
        return { before, after: await readPolicies(tx, EARLIER), mine: await readPolicies(tx, [POLICY]) };
      });
      expect(value.before).toHaveLength(2);
      expect(value.after).toEqual(value.before);
      expect(value.mine).toHaveLength(1);
      const { qual, ...rest } = value.mine[0]!;
      expect(rest).toEqual({ policyname: POLICY, cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", with_check: null });
      expect(qual).toContain(WRAPPED);
      expect(qual).toContain(`auth.jwt() ->> '${claim}'`);
      expect(qual).toContain("extension = 'broadcast'");
    });

    it("a second run is a no-op: one row, unchanged, and the 'already present' notice", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta();
      const { value, notices } = await rolledBack(async (tx, raised) => {
        await stubRealtime(tx);
        await earlierPolicies(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [POLICY]);
        const before = raised.length;
        await tx.unsafe(d.text).simple();
        return { first, again: await readPolicies(tx, [POLICY]), secondRun: raised.slice(before) };
      });
      expect(value.first).toHaveLength(1);
      expect(value.again).toEqual(value.first);
      expect(value.secondRun).toEqual([notice(d.version).present]);
      expect(notices.filter((n) => n === notice(d.version).present)).toHaveLength(1);
    });

    it("after a withdrawal: with the policy dropped a capture token reads nothing, and a re-run restores the identical row", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta();
      const ts = (await tokens()).filter((t) => t.name === "capture A");
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await earlierPolicies(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [POLICY]);
        await tx.unsafe(`drop policy "${POLICY}" on realtime.messages`);
        const dropped = await readable(tx, ts);
        await tx.unsafe(d.text).simple();
        return { first, dropped, restored: await readable(tx, ts), again: await readPolicies(tx, [POLICY]) };
      });
      expect(value.dropped.pairs).toBe(TOPICS.length);
      expect(value.dropped.reads).toEqual([]);
      expect(value.restored.reads).toEqual([["capture:A <- capture A", 1]]);
      expect(value.again).toEqual(value.first);
    });

    // The empty cases: the delta must skip, cleanly, wherever there is nothing to bind.
    it("no realtime schema: the delta skips with its notice, raises nothing and creates nothing", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta();
      const { value, notices } = await rolledBack(async (tx) => {
        await tx.unsafe(d.text).simple();
        return (await tx<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`)[0]!.n;
      });
      expect(value).toBe(0);
      expect(notices).toContain(notice(d.version).noSchema);
    });

    it("realtime schema without messages: the delta skips with its notice", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta();
      const { notices } = await rolledBack(async (tx) => {
        await tx`create schema realtime`;
        await tx.unsafe(d.text).simple();
      });
      expect(notices).toContain(notice(d.version).noTable);
    });

    it("not the table's owner: the delta skips with its notice, creates nothing, and the earlier policies stay", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta();
      const { value, notices } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await earlierPolicies(tx);
        const before = await readPolicies(tx, EARLIER);
        await tx`grant usage on schema realtime to app_user`;
        await tx`set local role app_user`;
        await tx.unsafe(d.text).simple();
        await tx`reset role`;
        return { before, after: await readPolicies(tx, EARLIER), mine: await readPolicies(tx, [POLICY]) };
      });
      expect(notices).toContain(notice(d.version).notOwner);
      expect(value.mine).toEqual([]);
      expect(value.before).toHaveLength(2);
      expect(value.after).toEqual(value.before);
    });
  });

  describe.skipIf(!HAS_DB)("against a database WITH Supabase Realtime", () => {
    it("the live policy exists, to authenticated, topic() wrapped, keyed on the capture claim", async ({ skip }) => {
      if (!(await hasRealtime())) return skip();
      const claim = await captureClaim();
      const live = await readPolicies(sql, [POLICY]);
      expect(live).toHaveLength(1);
      expect(live[0]!.roles).toEqual(["authenticated"]);
      expect(live[0]!.qual).toContain(WRAPPED);
      expect(live[0]!.qual).toContain(`auth.jwt() ->> '${claim}'`);
    });
  });
});
