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
//   - an empty input: a token with no claims reads nothing; a blank capture id reads nothing either, not even the bare
//     `capture:` topic (V554's nullif), and captureTopic and mintCaptureToken refuse one; no realtime schema / no
//     realtime.messages skip;
//   - after a withdrawal: the policy dropped by hand reads nothing, and a re-run restores the identical row;
//   - another surface: fixture, lobby, match-day and division tokens read no capture topic, and a capture token reads
//     none of theirs (V556 adds its own pair to this one matrix; V555's `match day code read by claim` is the second
//     policy under test, in its own describe, and its token and topic are already in the matrix);
//   - not the table's owner: the delta skips with its notice and leaves the earlier policies as they were.
//
// V555 (`match day code read by claim`, claim `md_code_id`) is held to the same cases: its own token reads only
// `match-day:A`; a blank AND a whitespace claim read nothing; every other token reads no match-day topic; the delta
// run twice is one row; a withdrawal; the empty and not-the-owner skips.
//
// V556 (`division read by claim`, claim `division_ids`, a jsonb ARRAY) is held to the same cases plus its own: a
// token for A, for B, for both and for `AB` against `division:A`, `:B`, `:C`, `:AB` and `:A:x` (exact element match:
// no prefix, no "any division token reads every division"); an empty list, a blank `[""]` and a whitespace `["  "]`
// read nothing (not even the bare `division:` topic); a scalar, an object and a null `division_ids` read nothing
// (jsonb `?` answers yes for a scalar string equal to the id and for an object KEY, so the policy also requires an
// array); and the cross-family matrix — no other family reads `division:*`, and a division token reads nothing else.
//
// Applies to another sport: N/A (no sport rules).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureTopic,
  divisionTopic,
  externalPlayLobbyTopic,
  fixtureMessage,
  matchDayTopic,
  mintCaptureToken,
  mintDivisionToken,
  mintExternalPlayLobbyToken,
  mintMatchDayToken,
  mintPublicFixtureToken,
} from "@/lib/realtime";
import { sql, type Tx } from "@/lib/db";
import { hasRealtime, readPolicies, rolledBack, stubRealtime, visibility } from "./helpers/realtime-stub";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");

/** The policy under test, as the design names it. */
const POLICY = "capture pairing read by claim";
/** The Match Day policy (V555), under test in its own describe. */
const MD_POLICY = "match day code read by claim";
/** The division policy (V556), under test in its own describe. */
const DIV_POLICY = "division read by claim";
/** The policies V403 and V452 create (V537 re-creates both). */
const EARLIER = ["external play lobby read by claim", "fixture broadcast read by claim"];
const WRAPPED = "( SELECT realtime.topic() AS topic)";
/** The claim read, wrapped in its own scalar sub-select (one evaluation per statement) and with a blank claim turned
 *  into null (it binds nothing), as pg_policies prints it. */
const claimRead = (claim: string) => `NULLIF(( SELECT (auth.jwt() ->> '${claim}'::text)), ''::text)`;
/** V556's claim read: the jsonb array itself (`->`), wrapped. */
const DIV_CLAIM = "( SELECT (auth.jwt() -> 'division_ids'::text))";
/** Each policy's whole expression as Postgres prints it, written from the design (never read back from a delta). Pinned
 *  on the stub AND on a live Supabase database, so a predicate applied there by hand cannot pass unseen (review m3). */
const QUAL = {
  // V554: the topic is `capture:` and the claim, a blank claim nulled.
  [POLICY]: `((extension = 'broadcast'::text) AND (${WRAPPED} = ('capture:'::text || ${claimRead("capture_pairing_id")})))`,
  // V555: the same, for `match-day:` and md_code_id.
  [MD_POLICY]: `((extension = 'broadcast'::text) AND (${WRAPPED} = ('match-day:'::text || ${claimRead("md_code_id")})))`,
  // V556: the broadcast extension; the `division:` prefix; an ARRAY claim (jsonb_typeof); exact element membership (`?`)
  // of the id after the prefix, with a blank id nulled.
  [DIV_POLICY]: `((extension = 'broadcast'::text) AND (${WRAPPED} ~~ 'division:%'::text) AND (jsonb_typeof(${DIV_CLAIM}) = 'array'::text) AND (${DIV_CLAIM} ? NULLIF(substr(${WRAPPED}, 10), ''::text)))`,
} as const;
/** Every column of a policy row but `qual`, as each delta writes it. */
const rowOf = (policyname: string) => ({ policyname, cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", with_check: null });

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

/** The one delta that creates `policy` (the capture one by default). Throws inside the test that asks, so a missing delta is a red test. */
function theDelta(policy: string = POLICY): Delta {
  const creates = new RegExp(`create\\s+policy\\s+"${policy}"`, "i");
  const hits = DELTA_FILES.filter((f) => creates.test(readFileSync(resolve(DELTAS, f), "utf8")));
  if (hits.length !== 1) throw new Error(`premise: one delta creates "${policy}", found ${hits.length}`);
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

/** …and the capture delta too: what the Match Day delta runs after. */
async function priorPolicies(tx: Tx): Promise<void> {
  await earlierPolicies(tx);
  await tx.unsafe(theDelta().text).simple();
}

/** …and the Match Day delta too: what the division delta runs after. */
async function beforeDivision(tx: Tx): Promise<void> {
  await priorPolicies(tx);
  await tx.unsafe(theDelta(MD_POLICY).text).simple();
}

/** V403's guard notices, for delta `v`. */
const notice = (v: number) => ({
  noSchema: `V${v}: no realtime schema — skip (non-Supabase database)`,
  noTable: `V${v}: realtime.messages missing — skip`,
  present: `V${v}: policy already present — skip`,
  notOwner: `V${v}: insufficient privilege on realtime.messages — skip (not owner)`,
});

// ── Tokens: the real mints, decoded ──────────────────────────────────────────

/** Division ids: mintDivisionToken takes only a lowercase uuid (as Postgres prints one), so the matrix's "A", "B" and
 *  "C" are these. Each holds letters, so its uppercase spelling is a different string (the case near-miss). */
const DIV = {
  A: "a0000000-0000-4000-8000-00000000000a",
  B: "b0000000-0000-4000-8000-00000000000b",
  C: "c0000000-0000-4000-8000-00000000000c",
} as const;

/** Claims every family carries; anything else in a payload is the family's own claim. */
const COMMON = ["aud", "exp", "iat", "role", "sub"];
type Token = { name: string; claims: Record<string, unknown> };

/** A minted token's claims with the family's own claim blanked: the token a mint would make for a blank id, which
 *  every family's mint now refuses (review m2). An array claim (division_ids) becomes `[""]`. */
const blanked = (claims: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(claims).map(([k, v]) => [k, COMMON.includes(k) ? v : Array.isArray(v) ? [""] : ""]));

async function tokens(): Promise<Token[]> {
  const until = new Date(Date.now() + 10 * 60_000);
  const decoded = async (t: Promise<string>) => ({ ...decodeJwt(await t) }) as Record<string, unknown>;
  const captureA = await decoded(mintCaptureToken("A", until));
  const matchDayA = await decoded(mintMatchDayToken("A", until));
  const divisionA = await decoded(mintDivisionToken("C", [DIV.A], until));
  return [
    { name: "capture A", claims: captureA },
    { name: "capture B", claims: await decoded(mintCaptureToken("B", until)) },
    { name: "fixture A", claims: await decoded(mintPublicFixtureToken("A")) },
    { name: "lobby A", claims: await decoded(mintExternalPlayLobbyToken("A", "person:p-1", until)) },
    { name: "match day A", claims: matchDayA },
    { name: "match day B", claims: await decoded(mintMatchDayToken("B", until)) },
    { name: "division A", claims: divisionA },
    { name: "division B", claims: await decoded(mintDivisionToken("C", [DIV.B], until)) },
    { name: "division A+B", claims: await decoded(mintDivisionToken("C", [DIV.A, DIV.B], until)) },
    // Typed: the mint refuses a non-uuid. The id that is A's prefix-extension (topic division:AB).
    { name: "division AB", claims: { ...divisionA, division_ids: [DIV.A + DIV.B] } },
    // The mint accepts an empty list (T0.1's ruling): a token that authorises no topic.
    { name: "division empty list", claims: await decoded(mintDivisionToken("C", [], until)) },
    { name: "capture blank id", claims: blanked(captureA) },
    { name: "match day blank id", claims: blanked(matchDayA) },
    // The token a mint would make for a whitespace id (every mint refuses one): a claim of spaces, which `nullif(…, '')`
    // does NOT null, so it can only ever bind a topic that literally ends in spaces.
    { name: "match day whitespace id", claims: { ...matchDayA, md_code_id: "   " } },
    { name: "division blank id", claims: blanked(divisionA) },
    { name: "division whitespace id", claims: { ...divisionA, division_ids: ["  "] } },
    // Typed: the mint only takes a list. jsonb `?` answers yes for a scalar string equal to the id ('"A"' ? 'A') and
    // for an object KEY ('{"A":true}' ? 'A'), so these read division:A unless the policy requires an array.
    { name: "division scalar", claims: { ...divisionA, division_ids: DIV.A } },
    { name: "division object", claims: { ...divisionA, division_ids: { [DIV.A]: true } } },
    { name: "division null", claims: { ...divisionA, division_ids: null } },
    // Typed: an array whose element is not a top-level string. `?` matches only top-level string elements.
    { name: "division [[A]]", claims: { ...divisionA, division_ids: [[DIV.A]] } },
    { name: "division [1]", claims: { ...divisionA, division_ids: [1] } },
    { name: "no claims", claims: {} },
  ];
}

/** The division-family tokens in the matrix (every token whose own claim is `division_ids`). */
const isDivisionToken = (t: Token) => t.name.startsWith("division ");

/** The capture family's own claim, read out of the token `mintCaptureToken` mints. */
async function captureClaim(): Promise<string> {
  const [capture] = await tokens();
  const own = Object.keys(capture!.claims).filter((k) => !COMMON.includes(k));
  expect(own, "a capture token carries exactly one claim of its own").toHaveLength(1);
  return own[0]!;
}

/** Channel topics, from the real builders; the near-miss (prefix: AB, bare, whitespace) and empty cases are typed or built from them. The bare family topics
 *  are typed: every family's builder refuses a blank id (review m2), so none can make them. */
const TOPICS: { name: string; topic: string }[] = [
  { name: "capture:A", topic: captureTopic("A") },
  { name: "capture:B", topic: captureTopic("B") },
  { name: "fixture:A", topic: fixtureMessage("A", "event").topic },
  { name: "external-play:A", topic: externalPlayLobbyTopic("A") },
  { name: "match-day:A", topic: matchDayTopic("A") },
  { name: "match-day:B", topic: matchDayTopic("B") },
  { name: "division:A", topic: divisionTopic(DIV.A) },
  { name: "division:B", topic: divisionTopic(DIV.B) },
  { name: "division:C", topic: divisionTopic(DIV.C) },
  { name: "capture:AB", topic: captureTopic("AB") },
  { name: "match-day:AB", topic: matchDayTopic("AB") },
  { name: "division:AB", topic: divisionTopic(DIV.A + DIV.B) },
  // A prefix-extension of division:A past a separator: a token for A must not read it.
  { name: "division:A:x", topic: divisionTopic(`${DIV.A}:x`) },
  // Near misses of division:A (review m5): another case, a trailing space, a trailing slash.
  { name: "division:A-upper", topic: divisionTopic(DIV.A.toUpperCase()) },
  { name: "division:A+space", topic: `${divisionTopic(DIV.A)} ` },
  { name: "division:A/", topic: `${divisionTopic(DIV.A)}/` },
  // The topic `[1]` would name if `?` compared numbers (it compares top-level strings only).
  { name: "division:1", topic: divisionTopic("1") },
  // Another 9-character prefix with A after it: `substr(topic, 10)` is A's id, so only V556's `like 'division:%'` keeps
  // a token for A off it (typed: no builder makes it).
  { name: "division-A", topic: `division-${DIV.A}` },
  { name: "capture:", topic: "capture:" },
  { name: "match-day:", topic: "match-day:" },
  // Typed: matchDayTopic refuses a whitespace id. The one topic a whitespace claim can bind (nullif only nulls '').
  { name: "match-day:   ", topic: "match-day:   " },
  { name: "division:", topic: "division:" },
  // Typed: divisionTopic refuses a whitespace id. The one topic `["  "]` can bind.
  { name: "division:  ", topic: "division:  " },
  { name: "(none)", topic: "" },
];

type Matrix = { pairs: number; tokens: number; reads: [string, number][] };

/** Every (topic, token) pair an `authenticated` subscriber can read, as "topic <- token", with how many rows. */
async function readable(tx: Tx, ts: Token[]): Promise<Matrix> {
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
  return { pairs: Object.keys(seen).length, tokens: ts.length, reads };
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

  it("premise: exactly one delta creates the match day policy, and it runs after the capture one", () => {
    expect(theDelta(MD_POLICY).version).toBeGreaterThan(theDelta().version);
  });

  it("premise: exactly one delta creates the division policy, it runs after the match day one, and its file name stays out of the stream fold", () => {
    const d = theDelta(DIV_POLICY);
    expect(d.version).toBeGreaterThan(theDelta(MD_POLICY).version);
    // relay/__tests__/_stream-migration.ts folds every delta whose name matches /stream|capture|youtube|seazn/, and
    // rls-static asserts that fold holds no `create policy` (Task 3's rename).
    expect(d.file).not.toMatch(/stream|capture|youtube|seazn/);
  });

  describe.skipIf(!HAS_DB)("against a stub of Supabase Realtime (rolled back)", () => {
    /** The whole read matrix after V403, V452, V537, V554, V555 and V556 — computed once, asserted case by case. */
    let matrix: Promise<Matrix> | undefined;
    const afterAllDeltas = () =>
      (matrix ??= (async () => {
        const ts = await tokens();
        const { value } = await rolledBack(async (tx) => {
          await stubRealtime(tx);
          await beforeDivision(tx);
          await tx.unsafe(theDelta(DIV_POLICY).text).simple();
          return readable(tx, ts);
        });
        return value;
      })());

    it("anti-vacuity: every (topic, token) pair was read, and exactly the own-family pairs read anything", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { pairs, tokens: n, reads } = await afterAllDeltas();
      expect(n, "tokens in the matrix").toBe(22);
      expect(TOPICS.length, "topics in the matrix").toBe(24);
      expect(pairs, "pairs checked").toBe(TOPICS.length * n);
      // One row each — the broadcast row, never the presence one. No blank-id token reads anything (V554's, V555's and
      // V556's nullif), and no non-array division_ids reads anything (V556's jsonb_typeof).
      expect(reads).toEqual([
        ["capture:A <- capture A", 1],
        ["capture:B <- capture B", 1],
        ["fixture:A <- fixture A", 1],
        ["external-play:A <- lobby A", 1],
        ["match-day:A <- match day A", 1],
        ["match-day:B <- match day B", 1],
        ["division:A <- division A", 1],
        ["division:A <- division A+B", 1],
        ["division:B <- division B", 1],
        ["division:B <- division A+B", 1],
        ["division:AB <- division AB", 1],
        // The documented accepted cases: a whitespace claim binds exactly its own spaces and nothing else.
        ["match-day:    <- match day whitespace id", 1],
        ["division:   <- division whitespace id", 1],
      ]);
    });

    it("a capture token reads its own pairing's topic, and not another pairing's", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const of = (token: string) => reads.filter(([k]) => k.endsWith(`<- ${token}`)).map(([k]) => k);
      expect(of("capture A")).toEqual(["capture:A <- capture A"]);
      expect(of("capture B")).toEqual(["capture:B <- capture B"]);
    });

    it("another surface: a capture token reads neither fixture:A nor external-play:A", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const keys = reads.map(([k]) => k);
      for (const k of ["fixture:A <- capture A", "external-play:A <- capture A"]) expect(keys, k).not.toContain(k);
    });

    it("another surface: a fixture_id token and a lobby token read no capture topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const leaks = reads.map(([k]) => k).filter((k) => k.startsWith("capture:") && !k.includes("<- capture "));
      expect(leaks).toEqual([]);
      expect(reads.map(([k]) => k)).not.toContain("capture:A <- fixture A");
    });

    // Review m3: the families V555 and V556 bind. They extend this matrix rather than build a second one.
    it("another surface: a capture token reads neither match-day: nor division:, and their tokens read no capture topic", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const keys = reads.map(([k]) => k);
      const captureOnTheirs = keys.filter((k) => /^(match-day|division):/.test(k) && k.includes("<- capture "));
      const theirsOnCapture = keys.filter((k) => k.startsWith("capture:") && /<- (match day|division) /.test(k));
      expect(captureOnTheirs).toEqual([]);
      expect(theirsOnCapture).toEqual([]);
      // Non-vacuous: both sides of the check are in the matrix.
      expect(TOPICS.filter((t) => /^(match-day|division):/.test(t.topic))).toHaveLength(16);
      expect((await tokens()).filter((t) => /^(match day|division) /.test(t.name))).toHaveLength(16);
    });

    it("empty input: a token with no claims reads nothing, on any topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      expect(reads.filter(([k]) => k.endsWith("<- no claims"))).toEqual([]);
    });

    // Review m2 (controller ruling): refused at BOTH layers. At the database, V554's nullif turns a blank claim into
    // null, so `'capture:' || null` matches no topic — not even the bare `capture:`, which `'capture:' || ''` would.
    // In the app, captureTopic and mintCaptureToken throw on a blank id.
    it("empty input: a blank capture id reads nothing, not even the bare capture: topic, and no builder or mint makes one", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      expect(TOPICS.map((t) => t.topic), "the bare topic is in the matrix").toContain("capture:");
      expect(reads.filter(([k]) => k.endsWith("<- capture blank id"))).toEqual([]);
      expect(() => captureTopic("")).toThrow(/^Realtime capture: /);
      await expect(mintCaptureToken(" ", new Date(Date.now() + 60_000))).rejects.toThrow(/^Realtime capture: /);
    });

    it("the row: SELECT, to authenticated, permissive, no WITH CHECK, topic() and the claim each wrapped, keyed on the capture claim; earlier policies untouched", async ({
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
      expect(qual).toContain(claimRead(claim));
      expect(qual).toContain("extension = 'broadcast'");
      // The whole expression, so the `=` operator and the 'capture:' literal are pinned too.
      expect(qual).toBe(QUAL[POLICY]);
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

    // ── V555: `match day code read by claim` (claim md_code_id) ────────────────────────────────────────────────────
    // The matrix above already holds the md tokens and the `match-day:` topics; these cases read the V555 column out of it.
    const mdKeys = (reads: [string, number][]) => reads.map(([k]) => k);

    it("match day: md A reads match-day:A only, md B reads match-day:B only, neither reads match-day:AB; one broadcast row each", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      expect(reads.filter(([k]) => k.endsWith("<- match day A"))).toEqual([["match-day:A <- match day A", 1]]);
      expect(reads.filter(([k]) => k.endsWith("<- match day B"))).toEqual([["match-day:B <- match day B", 1]]);
      // Non-vacuous: AB is a topic in the matrix and a prefix-extension of A (the claim-prefix and any-md-token mutants read it).
      expect(TOPICS.map((t) => t.topic)).toContain("match-day:AB");
      expect(mdKeys(reads).filter((k) => k.startsWith("match-day:AB "))).toEqual([]);
    });

    it("match day: an md token reads neither capture:A, fixture:A, external-play:A nor division:A", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const keys = mdKeys(reads);
      for (const t of ["capture:A", "capture:B", "fixture:A", "external-play:A", "division:A"]) {
        expect(TOPICS.map((x) => x.name), `${t} is in the matrix`).toContain(t);
        expect(keys, `${t} <- match day A`).not.toContain(`${t} <- match day A`);
      }
    });

    it("match day: no other family's token reads match-day:A (capture, fixture, lobby, division)", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const theirs = (await tokens()).filter((t) => !t.name.startsWith("match day") && t.name !== "no claims");
      expect(theirs.length, "other families' tokens checked").toBeGreaterThanOrEqual(6);
      const ofTheirs = mdKeys(reads).filter((k) => theirs.some((t) => k.endsWith(`<- ${t.name}`)));
      expect(ofTheirs.filter((k) => k.startsWith("match-day:"))).toEqual([]);
      // …and no token but md A reads match-day:A, no token but md B reads match-day:B.
      expect(mdKeys(reads).filter((k) => k.startsWith("match-day:A ") && !k.endsWith("<- match day A"))).toEqual([]);
      expect(mdKeys(reads).filter((k) => k.startsWith("match-day:B ") && !k.endsWith("<- match day B"))).toEqual([]);
    });

    it("match day: a blank md_code_id reads nothing, not even the bare match-day: topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const blank = (await tokens()).find((t) => t.name === "match day blank id")!;
      expect(blank.claims.md_code_id, "premise: the token carries a blank claim").toBe("");
      expect(TOPICS.map((t) => t.topic), "the bare topic is in the matrix").toContain("match-day:");
      expect(reads.filter(([k]) => k.endsWith("<- match day blank id"))).toEqual([]);
      expect(() => matchDayTopic("")).toThrow(/^Realtime match day: /);
      await expect(mintMatchDayToken("", new Date(Date.now() + 60_000))).rejects.toThrow(/^Realtime match day: /);
    });

    it("match day: a whitespace md_code_id binds only its own spaces topic, no other token reads it, and no builder or mint makes one", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const ws = (await tokens()).find((t) => t.name === "match day whitespace id")!;
      expect((ws.claims.md_code_id as string).length, "premise: a non-empty claim").toBeGreaterThan(0);
      expect((ws.claims.md_code_id as string).trim(), "premise: of whitespace only").toBe("");
      // The accepted behaviour (controller ruling): nullif turns only '' into null, so this token reads the topic that
      // is literally `match-day:` + its spaces, and no other — not the bare `match-day:` topic, not match-day:A.
      expect(ws.claims.md_code_id).toBe("   ");
      expect(TOPICS.map((t) => t.topic)).toContain("match-day:   ");
      expect(reads.filter(([k]) => k.endsWith("<- match day whitespace id"))).toEqual([
        ["match-day:    <- match day whitespace id", 1],
      ]);
      expect(reads.filter(([k]) => k.startsWith("match-day:    <-") && !k.endsWith("<- match day whitespace id"))).toEqual([]);
      expect(() => matchDayTopic("   ")).toThrow(/^Realtime match day: /);
      await expect(mintMatchDayToken("   ", new Date(Date.now() + 60_000))).rejects.toThrow(/^Realtime match day: /);
    });

    it("match day: a token with no claims reads no match-day topic", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      expect(reads.filter(([k]) => k.startsWith("match-day:") && k.endsWith("<- no claims"))).toEqual([]);
    });

    it("match day, the row: SELECT, to authenticated, permissive, no WITH CHECK, topic() and the claim each wrapped, keyed on md_code_id; earlier policies untouched", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const [matchDay] = await tokens().then((ts) => ts.filter((t) => t.name === "match day A"));
      const own = Object.keys(matchDay!.claims).filter((k) => !COMMON.includes(k));
      expect(own, "an md token carries exactly one claim of its own").toEqual(["md_code_id"]);
      const guarded = [...EARLIER, POLICY];
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await priorPolicies(tx);
        const before = await readPolicies(tx, guarded);
        await tx.unsafe(theDelta(MD_POLICY).text).simple();
        return { before, after: await readPolicies(tx, guarded), mine: await readPolicies(tx, [MD_POLICY]) };
      });
      expect(value.before).toHaveLength(3);
      expect(value.after).toEqual(value.before);
      expect(value.mine).toHaveLength(1);
      const { qual, ...rest } = value.mine[0]!;
      expect(rest).toEqual({ policyname: MD_POLICY, cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", with_check: null });
      expect(qual).toContain(WRAPPED);
      expect(qual).toContain(claimRead(own[0]!));
      expect(qual).toContain("extension = 'broadcast'");
      // The whole expression as Postgres prints it, so the `=` operator and the 'match-day:' literal are pinned too.
      expect(qual).toBe(QUAL[MD_POLICY]);
    });

    it("match day: a second run is a no-op: one row, unchanged, and the 'already present' notice", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(MD_POLICY);
      const { value, notices } = await rolledBack(async (tx, raised) => {
        await stubRealtime(tx);
        await priorPolicies(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [MD_POLICY]);
        const before = raised.length;
        await tx.unsafe(d.text).simple();
        return { first, again: await readPolicies(tx, [MD_POLICY]), secondRun: raised.slice(before) };
      });
      expect(value.first).toHaveLength(1);
      expect(value.again).toEqual(value.first);
      expect(value.secondRun).toEqual([notice(d.version).present]);
      expect(notices.filter((n) => n === notice(d.version).present)).toHaveLength(1);
    });

    it("match day, after a withdrawal: with the policy dropped an md token reads nothing, and a re-run restores the identical row", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(MD_POLICY);
      const ts = (await tokens()).filter((t) => t.name === "match day A");
      expect(ts).toHaveLength(1);
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await priorPolicies(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [MD_POLICY]);
        await tx.unsafe(`drop policy "${MD_POLICY}" on realtime.messages`);
        const dropped = await readable(tx, ts);
        await tx.unsafe(d.text).simple();
        return { first, dropped, restored: await readable(tx, ts), again: await readPolicies(tx, [MD_POLICY]) };
      });
      expect(value.dropped.pairs).toBe(TOPICS.length);
      expect(value.dropped.reads).toEqual([]);
      expect(value.restored.reads).toEqual([["match-day:A <- match day A", 1]]);
      expect(value.again).toEqual(value.first);
    });

    it("match day: no realtime schema or no realtime.messages skips with its notice; a non-owner skips and leaves the earlier policies", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(MD_POLICY);
      const noSchema = await rolledBack(async (tx) => {
        await tx.unsafe(d.text).simple();
        return (await tx<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`)[0]!.n;
      });
      expect(noSchema.value).toBe(0);
      expect(noSchema.notices).toContain(notice(d.version).noSchema);
      const noTable = await rolledBack(async (tx) => {
        await tx`create schema realtime`;
        await tx.unsafe(d.text).simple();
      });
      expect(noTable.notices).toContain(notice(d.version).noTable);
      const guarded = [...EARLIER, POLICY];
      const notOwner = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await priorPolicies(tx);
        const before = await readPolicies(tx, guarded);
        await tx`grant usage on schema realtime to app_user`;
        await tx`set local role app_user`;
        await tx.unsafe(d.text).simple();
        await tx`reset role`;
        return { before, after: await readPolicies(tx, guarded), mine: await readPolicies(tx, [MD_POLICY]) };
      });
      expect(notOwner.notices).toContain(notice(d.version).notOwner);
      expect(notOwner.value.mine).toEqual([]);
      expect(notOwner.value.before).toHaveLength(3);
      expect(notOwner.value.after).toEqual(notOwner.value.before);
    });

    // ── V556: `division read by claim` (claim division_ids, a jsonb array) ──────────────────────────────────────────
    // The matrix above holds the division tokens and topics; these cases read the V556 column out of it.
    const ofToken = (reads: [string, number][], token: string) => reads.filter(([k]) => k.endsWith(`<- ${token}`));
    const topicNames = () => TOPICS.map((t) => t.name);

    it("division: A reads division:A only, B reads division:B only, A+B reads A and B but not C; one broadcast row each", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      for (const t of ["division:A", "division:B", "division:C"]) expect(topicNames(), `${t} is in the matrix`).toContain(t);
      expect(ofToken(reads, "division A")).toEqual([["division:A <- division A", 1]]);
      expect(ofToken(reads, "division B")).toEqual([["division:B <- division B", 1]]);
      expect(ofToken(reads, "division A+B")).toEqual([
        ["division:A <- division A+B", 1],
        ["division:B <- division A+B", 1],
      ]);
      // division:C is in no token's list: nobody reads it.
      expect(reads.filter(([k]) => k.startsWith("division:C "))).toEqual([]);
    });

    it("division, prefix: a token for A reads neither division:AB nor division:A:x, and a token for AB reads only division:AB", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      // Non-vacuous: both are prefix-extensions of division:A in the matrix (the claim-prefix mutant reads them).
      for (const t of ["division:AB", "division:A:x"]) expect(topicNames(), `${t} is in the matrix`).toContain(t);
      const keys = reads.map(([k]) => k);
      for (const token of ["division A", "division A+B"]) {
        expect(keys, `division:AB <- ${token}`).not.toContain(`division:AB <- ${token}`);
        expect(keys, `division:A:x <- ${token}`).not.toContain(`division:A:x <- ${token}`);
      }
      expect(ofToken(reads, "division AB")).toEqual([["division:AB <- division AB", 1]]);
      // No token in the matrix lists "A:x", so nobody reads that topic.
      expect(reads.filter(([k]) => k.startsWith("division:A:x "))).toEqual([]);
    });

    it("division, empty input: an empty list, a blank [\"\"] and a whitespace [\"  \"] read nothing on the bare division: topic, and no builder or mint makes one", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const ts = await tokens();
      const claimOf = (name: string) => ts.find((t) => t.name === name)!.claims.division_ids;
      expect(claimOf("division empty list"), "premise: the real mint made an empty list").toEqual([]);
      expect(claimOf("division blank id"), "premise: a blank id").toEqual([""]);
      expect(claimOf("division whitespace id"), "premise: a whitespace id").toEqual(["  "]);
      expect(topicNames(), "the bare topic is in the matrix").toContain("division:");
      expect(ofToken(reads, "division empty list")).toEqual([]);
      expect(ofToken(reads, "division blank id")).toEqual([]);
      // The bare `division:` topic is read by nobody at all — `substr('division:', 10)` is '' and V556 nulls it.
      expect(reads.filter(([k]) => k.startsWith("division: <-"))).toEqual([]);
      // The accepted case (as V555's): a whitespace id binds only the topic that literally ends in its spaces.
      expect(ofToken(reads, "division whitespace id")).toEqual([["division:   <- division whitespace id", 1]]);
      expect(reads.filter(([k]) => k.startsWith("division:   <-") && !k.endsWith("<- division whitespace id"))).toEqual([]);
      expect(() => divisionTopic("")).toThrow(/^Realtime division: /);
      expect(() => divisionTopic("  ")).toThrow(/^Realtime division: /);
      const until = new Date(Date.now() + 60_000);
      await expect(mintDivisionToken("C", [""], until)).rejects.toThrow(/^Realtime division: /);
      await expect(mintDivisionToken("C", [DIV.A, "  "], until)).rejects.toThrow(/^Realtime division: /);
    });

    it("division: a scalar, an object and a null division_ids read nothing (jsonb ? would match the first two)", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const ts = await tokens();
      const cases = [
        ["division scalar", "string"],
        ["division object", "object"],
        ["division null", "null"],
      ] as const;
      for (const [name, kind] of cases) {
        const claim = ts.find((t) => t.name === name)!.claims.division_ids;
        expect(claim === null ? "null" : typeof claim, `premise: ${name} carries a ${kind}`).toBe(kind);
        expect(Array.isArray(claim), `premise: ${name} is not an array`).toBe(false);
        expect(ofToken(reads, name), `${name} reads nothing`).toEqual([]);
      }
      expect(cases).toHaveLength(3);
      // Non-vacuous: each names division:A's id, so `?` alone would let it read division:A.
      expect(ts.find((t) => t.name === "division scalar")!.claims.division_ids).toBe(DIV.A);
      expect(Object.keys(ts.find((t) => t.name === "division object")!.claims.division_ids as object)).toEqual([DIV.A]);
    });

    // Review m5: near misses of an id the token lists, and arrays whose elements are not top-level strings.
    it("division, near misses: A's uppercase, trailing-space and trailing-slash topics, and division:1, are read by nobody; [[A]] and [1] read nothing", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const ts = await tokens();
      const near = ["division:A-upper", "division:A+space", "division:A/", "division:1"];
      const topicOf = (name: string) => TOPICS.find((t) => t.name === name)!.topic;
      let checked = 0;
      for (const name of near) {
        expect(topicNames(), `${name} is in the matrix`).toContain(name);
        expect(topicOf(name), `premise: ${name} is not division:A itself`).not.toBe(topicOf("division:A"));
        expect(reads.filter(([k]) => k.startsWith(`${name} <-`)), `${name} is read by nobody`).toEqual([]);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every near miss").toBe(4);
      // Each near miss differs from division:A by exactly what its name says.
      expect(topicOf("division:A-upper").toLowerCase()).toBe(topicOf("division:A"));
      expect(topicOf("division:A+space")).toBe(`${topicOf("division:A")} `);
      expect(topicOf("division:A/")).toBe(`${topicOf("division:A")}/`);
      // …while the tokens that list A do read division:A (the positive pair).
      expect(reads.map(([k]) => k)).toContain("division:A <- division A");
      const claimOf = (name: string) => ts.find((t) => t.name === name)!.claims.division_ids;
      expect(claimOf("division [[A]]"), "premise: A nested one level down").toEqual([[DIV.A]]);
      expect(claimOf("division [1]"), "premise: a number, not a string").toEqual([1]);
      expect(ofToken(reads, "division [[A]]")).toEqual([]);
      expect(ofToken(reads, "division [1]")).toEqual([]);
    });

    it("division, another surface: no other family's token reads any division: topic, and a division token reads nothing else", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const { reads } = await afterAllDeltas();
      const ts = await tokens();
      const ours = ts.filter(isDivisionToken);
      const theirs = ts.filter((t) => !isDivisionToken(t));
      // Every other family, with its blank and whitespace variants, and `{}`; every division variant.
      expect(theirs.map((t) => t.name), "other families' tokens checked").toEqual([
        "capture A",
        "capture B",
        "fixture A",
        "lobby A",
        "match day A",
        "match day B",
        "capture blank id",
        "match day blank id",
        "match day whitespace id",
        "no claims",
      ]);
      expect(ours, "division tokens checked").toHaveLength(12);
      const divisionTopics = TOPICS.filter((t) => t.topic.startsWith("division:"));
      const otherTopics = TOPICS.filter((t) => !t.topic.startsWith("division:"));
      expect(divisionTopics, "division topics checked").toHaveLength(11);
      expect(otherTopics, "other topics checked").toHaveLength(13);
      // Non-vacuous for the prefix guard: one other topic carries A's id at substr position 10 (1-based).
      expect(otherTopics.filter((t) => t.topic.slice(9) === DIV.A).map((t) => t.name)).toEqual(["division-A"]);
      const keys = reads.map(([k]) => k);
      const byTheirs = (k: string) => theirs.some((t) => k.endsWith(`<- ${t.name}`));
      const byOurs = (k: string) => ours.some((t) => k.endsWith(`<- ${t.name}`));
      expect(keys.filter((k) => k.startsWith("division:") && byTheirs(k)), "another family on division:*").toEqual([]);
      expect(keys.filter((k) => !k.startsWith("division:") && byOurs(k)), "a division token off division:*").toEqual([]);
      // The fixture_id token in particular (the brief's case): not division:A.
      expect(keys).not.toContain("division:A <- fixture A");
    });

    it("division, the row: SELECT, to authenticated, permissive, no WITH CHECK, the whole expression pinned; earlier policies untouched", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const [division] = (await tokens()).filter((t) => t.name === "division A");
      const own = Object.keys(division!.claims).filter((k) => !COMMON.includes(k));
      expect(own, "a division token carries exactly one claim of its own").toEqual(["division_ids"]);
      const guarded = [...EARLIER, POLICY, MD_POLICY];
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await beforeDivision(tx);
        const before = await readPolicies(tx, guarded);
        await tx.unsafe(theDelta(DIV_POLICY).text).simple();
        return { before, after: await readPolicies(tx, guarded), mine: await readPolicies(tx, [DIV_POLICY]) };
      });
      expect(value.before).toHaveLength(4);
      expect(value.after).toEqual(value.before);
      expect(value.mine).toHaveLength(1);
      const { qual, ...rest } = value.mine[0]!;
      expect(rest).toEqual({ policyname: DIV_POLICY, cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", with_check: null });
      // The whole expression as Postgres prints it (QUAL's comment); topic() and the claim each wrapped in their own
      // scalar sub-select (one evaluation per statement).
      expect(qual).toBe(QUAL[DIV_POLICY]);
    });

    it("division: a second run is a no-op: one row, unchanged, and the 'already present' notice", async ({ skip }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(DIV_POLICY);
      const { value, notices } = await rolledBack(async (tx, raised) => {
        await stubRealtime(tx);
        await beforeDivision(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [DIV_POLICY]);
        const before = raised.length;
        await tx.unsafe(d.text).simple();
        return { first, again: await readPolicies(tx, [DIV_POLICY]), secondRun: raised.slice(before) };
      });
      expect(value.first).toHaveLength(1);
      expect(value.again).toEqual(value.first);
      expect(value.secondRun).toEqual([notice(d.version).present]);
      expect(notices.filter((n) => n === notice(d.version).present)).toHaveLength(1);
    });

    it("division, after a withdrawal: with the policy dropped a division token reads nothing, and a re-run restores the identical row", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(DIV_POLICY);
      const ts = (await tokens()).filter((t) => t.name === "division A+B");
      expect(ts).toHaveLength(1);
      const { value } = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await beforeDivision(tx);
        await tx.unsafe(d.text).simple();
        const first = await readPolicies(tx, [DIV_POLICY]);
        await tx.unsafe(`drop policy "${DIV_POLICY}" on realtime.messages`);
        const dropped = await readable(tx, ts);
        await tx.unsafe(d.text).simple();
        return { first, dropped, restored: await readable(tx, ts), again: await readPolicies(tx, [DIV_POLICY]) };
      });
      expect(value.dropped.pairs).toBe(TOPICS.length);
      expect(value.dropped.reads).toEqual([]);
      expect(value.restored.reads).toEqual([
        ["division:A <- division A+B", 1],
        ["division:B <- division A+B", 1],
      ]);
      expect(value.again).toEqual(value.first);
    });

    it("division: no realtime schema or no realtime.messages skips with its notice; a non-owner skips and leaves the earlier policies", async ({
      skip,
    }) => {
      if (await hasRealtime()) return skip();
      const d = theDelta(DIV_POLICY);
      const noSchema = await rolledBack(async (tx) => {
        await tx.unsafe(d.text).simple();
        return (await tx<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'realtime'`)[0]!.n;
      });
      expect(noSchema.value).toBe(0);
      expect(noSchema.notices).toContain(notice(d.version).noSchema);
      const noTable = await rolledBack(async (tx) => {
        await tx`create schema realtime`;
        await tx.unsafe(d.text).simple();
      });
      expect(noTable.notices).toContain(notice(d.version).noTable);
      const guarded = [...EARLIER, POLICY, MD_POLICY];
      const notOwner = await rolledBack(async (tx) => {
        await stubRealtime(tx);
        await beforeDivision(tx);
        const before = await readPolicies(tx, guarded);
        await tx`grant usage on schema realtime to app_user`;
        await tx`set local role app_user`;
        await tx.unsafe(d.text).simple();
        await tx`reset role`;
        return { before, after: await readPolicies(tx, guarded), mine: await readPolicies(tx, [DIV_POLICY]) };
      });
      expect(notOwner.notices).toContain(notice(d.version).notOwner);
      expect(notOwner.value.mine).toEqual([]);
      expect(notOwner.value.before).toHaveLength(4);
      expect(notOwner.value.after).toEqual(notOwner.value.before);
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
    // Review m3: the whole row and the whole expression, pinned on the live catalog, so a predicate applied by hand on
    // stg (or anywhere the delta did not write it) reds here rather than passing on a substring.
    it("the live policy exists, its whole row and expression as V554 writes them, keyed on the capture claim", async ({ skip }) => {
      if (!(await hasRealtime())) return skip();
      expect(await captureClaim()).toBe("capture_pairing_id");
      const live = await readPolicies(sql, [POLICY]);
      expect(live).toEqual([{ ...rowOf(POLICY), qual: QUAL[POLICY] }]);
    });

    it("the live match day policy exists, its whole row and expression as V555 writes them", async ({ skip }) => {
      if (!(await hasRealtime())) return skip();
      const live = await readPolicies(sql, [MD_POLICY]);
      expect(live).toEqual([{ ...rowOf(MD_POLICY), qual: QUAL[MD_POLICY] }]);
    });

    it("the live division policy exists, its whole row and expression as V556 writes them", async ({ skip }) => {
      if (!(await hasRealtime())) return skip();
      const live = await readPolicies(sql, [DIV_POLICY]);
      expect(live).toEqual([{ ...rowOf(DIV_POLICY), qual: QUAL[DIV_POLICY] }]);
    });
  });
});
