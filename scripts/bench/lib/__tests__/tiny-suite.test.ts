// Unit coverage for the `_tiny` suite (lib/suites/tiny.ts) — the pack stage
// that runs before anything is created over HTTP, PLUS (T4) the suite's move
// onto the shared seeding layer (`buildSeedPlan`/`seedSuite`) and its new
// `--keep` idempotence guard.
//
// The full HTTP flow is exercised two ways here, on purpose:
//   * The pre-network paths (pack refusal, network-unreachable) need no
//     server at all — CI's DB-free job runs these.
//   * The `--keep` idempotence tests DO drive `runTinySuite` end to end, but
//     through an injected `SeedTransport` fake (`TinySuiteInput.transport`),
//     never `global.fetch` — same DI shape `lib/__tests__/seed.test.ts` uses
//     for `seedSuite` itself.
//
// The things this file pins, in order:
//  * The run SUCCEEDS on a pack carrying warnings, and still surfaces them.
//    `_tiny` permanently carries two `*.not_derived` warnings by design. A
//    stage that gated on "any finding at all" would red forever and the
//    honest warning would be deleted to make it pass — which is the wrong
//    repair.
//  * Every number the suite asserts against the live API is DERIVED from the
//    pack. The fixture count in particular: it was hardcoded `!== 1`, the
//    pack later declared `legs: 3`, and the assertion went on passing for a
//    shape the pack no longer had. T4 re-pins the SAME property against the
//    new N-division `SeedPlan` shape.
//  * `tinyPlan`'s one-division-one-stage refusal is GONE: the pack stage now
//    builds its plan through `buildSeedPlan`, which accepts N divisions.
//  * `--keep`'s reuse guard is proven from BOTH directions (AGENTS.md
//    recurring-failure class 13): a matching pack hash short-circuits and
//    creates no duplicate competition; a DIFFERENT hash does not
//    short-circuit; `--wipe` never even attempts the lookup, proven against a
//    store that WOULD match if the lookup ran.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { BenchHttpError, newSession, type Session } from "../http.ts";
import { loadPackValue } from "../pack-io.ts";
import { hashPack } from "../pack-hash.ts";
import { buildSeedPlan, type SeedPlan } from "../seed-plan.ts";
import type { SeedTransport } from "../seed.ts";
import {
  fixtureCountIssue,
  findExistingSeed,
  KEEP_BRANDING_KEY,
  runTinySuite,
  TINY_PACK_PATH,
  tinyPackStage,
} from "../suites/tiny.ts";
import type { Pack } from "../pack-schema.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_TEXT = readFileSync(TINY_PACK_PATH, "utf8");

function tinyPack(): Pack {
  const load = loadPackValue(JSON.parse(TINY_TEXT) as unknown, TINY_PACK_PATH);
  if (!load.ok) throw new Error("the committed _tiny.json no longer loads");
  return load.pack;
}

/** Writes `text` to a freshly minted temp dir as `_tiny.json` — the basename
 *  has to be exactly this: `loadPackFile`'s suite/filename check refuses any
 *  pack whose declared `suite` disagrees with the file it was read from
 *  (`suiteKeyFromPackPath`), and every pack this file writes declares
 *  `"suite": "_tiny"`. Caller removes the returned `dir` when done. */
function writeTinyPack(text: string): { packPath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-tiny-suite-"));
  const packPath = path.join(dir, "_tiny.json");
  writeFileSync(packPath, text, "utf8");
  return { packPath, dir };
}

describe("TINY_PACK_PATH", () => {
  it("points at the committed micro-pack, resolved from this module rather than from cwd", () => {
    expect(TINY_PACK_PATH).toBe(path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json"));
  });
});

// ---------------------------------------------------------------------------
// tinyPackStage
// ---------------------------------------------------------------------------

describe("tinyPackStage — warnings are reportable, never fatal", () => {
  it("SUCCEEDS on the committed pack and still surfaces its two warnings", async () => {
    const stage = await tinyPackStage(TINY_PACK_PATH);
    // The run proceeds…
    expect(stage.ok).toBe(true);
    if (!stage.ok) throw new Error(`refused: ${stage.errors.join(" | ")}`);
    // …and the warnings reach the report rather than being swallowed.
    expect(stage.warnings).toHaveLength(2);
    expect(stage.warnings.join(" | ")).toContain("leaderboards.not_derived");
    expect(stage.warnings.join(" | ")).toContain("champions.not_derived");
    // Each says what was NOT checked and who owes it, not merely that
    // something happened.
    expect(stage.warnings.join(" | ")).toContain("NOT checked offline");
    // T4: the stage now ALSO carries the raw pack and its content hash — the
    // two facts `findExistingSeed`/`seedSuite` need that `SeedPlan` alone
    // cannot supply (streams/venues, and the `--keep` marker).
    expect(stage.pack.suite).toBe("_tiny");
    expect(stage.packHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REFUSES, with no plan, when the pack itself is wrong", async () => {
    const stage = await tinyPackStage(path.join(REPO_ROOT, "scripts/bench/packs/_absent.json"));
    expect(stage.ok).toBe(false);
    if (stage.ok) throw new Error("unreachable");
    expect(stage.errors.join(" | ")).toContain("pack.unreadable");
    expect(Object.prototype.hasOwnProperty.call(stage, "plan")).toBe(false);
  });

  it("REFUSES the SAME BYTES under another filename — the pack/filename check reaches the runner", async () => {
    // Addendum 2's proof, driven through the runner's own call site rather
    // than through the validator directly: `expectedSuite` is derived from the
    // path the bytes came from, so `_tiny`'s content under a different name is
    // refused. A call site that dropped the argument, or passed the pack's own
    // `suite`, or passed a constant `"_tiny"`, would load this green.
    const dir = mkdtempSync(path.join(tmpdir(), "bench-tiny-"));
    const misnamed = path.join(dir, "wimbledon-2019.json");
    writeFileSync(misnamed, TINY_TEXT, "utf8");
    const stage = await tinyPackStage(misnamed);
    expect(stage.ok).toBe(false);
    if (stage.ok) throw new Error("unreachable");
    const said = stage.errors.join(" | ");
    expect(said).toContain("pack.suite_mismatch");
    // BOTH values, never just the code: `undefined` vs `"_tiny"` also raises
    // `pack.suite_mismatch`, so a code-only assertion proves nothing.
    expect(said).toContain('pack declares suite "_tiny"');
    expect(said).toContain('the caller expected "wimbledon-2019"');
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a pack with MORE than one division — tinyPlan's one-division refusal is gone (T4)", async () => {
    // `tinyPlan` used to throw "the _tiny suite drives a pack with exactly
    // one division" for exactly this shape. `buildSeedPlan` (B03) has no such
    // refusal — this pins that the pack STAGE actually calls it now, not
    // just that `buildSeedPlan` itself tolerates N divisions (already proven
    // exhaustively by seed-plan.test.ts).
    const raw = {
      schemaVersion: 1,
      suite: "_tiny",
      org: { name: "Two Division Club", slug: "two-division-club", timezone: "UTC" },
      competition: { name: "Two Sport Series", slug: "two-sport-series", endsOn: "2099-01-03" },
      divisions: [
        {
          ref: "d-football",
          name: "Football Open",
          sportKey: "football",
          variantKey: "outdoor11",
          moduleVersion: "1.0.0",
          cfgOverrides: { allowDraws: true },
          stages: [{ ref: "st-football", seq: 1, kind: "league", name: "Regular Season", config: { legs: 1 } }],
        },
        {
          ref: "d-cricket",
          name: "Cricket T20",
          sportKey: "cricket",
          variantKey: "t20",
          moduleVersion: "1.0.0",
          cfgOverrides: { oversPerInnings: 20 },
          stages: [{ ref: "st-cricket", seq: 1, kind: "league", name: "Group Stage", config: { legs: 1 } }],
        },
      ],
      persons: [
        { ref: "p-morgan", fullName: "Morgan Ito", lane: "player" },
        { ref: "p-noor", fullName: "Noor Haddad", lane: "player" },
        { ref: "p-farid", fullName: "Farid Bakr", lane: "player" },
        { ref: "p-gia", fullName: "Gia Torres", lane: "player" },
      ],
      entrants: [
        {
          ref: "e-lions",
          divisionRef: "d-football",
          kind: "team",
          displayName: "Lions",
          seed: 1,
          roster: [{ person: "p-morgan", squadNumber: 7, captain: true }],
        },
        {
          ref: "e-tigers",
          divisionRef: "d-football",
          kind: "team",
          displayName: "Tigers",
          seed: 2,
          roster: [{ person: "p-noor", squadNumber: 15, captain: true }],
        },
        {
          ref: "e-eagles",
          divisionRef: "d-cricket",
          kind: "team",
          displayName: "Eagles",
          seed: 1,
          roster: [{ person: "p-farid", squadNumber: 11, captain: true }],
        },
        {
          ref: "e-falcons",
          divisionRef: "d-cricket",
          kind: "team",
          displayName: "Falcons",
          seed: 2,
          roster: [{ person: "p-gia", squadNumber: 21, captain: true }],
        },
      ],
      expected: {},
      meta: { synthetic: true },
    };
    const { packPath, dir } = writeTinyPack(JSON.stringify(raw));
    const stage = await tinyPackStage(packPath);
    expect(stage.ok).toBe(true);
    if (!stage.ok) throw new Error(`refused: ${stage.errors.join(" | ")}`);
    expect(stage.plan.divisions).toHaveLength(2);
    expect(stage.plan.divisions.map((d) => d.ref)).toEqual(["d-football", "d-cricket"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// fixtureCountIssue — adapted to SeedPlan's N-division shape
// ---------------------------------------------------------------------------

describe("fixtureCountIssue — addendum 1's comparison, on the testable side of the network", () => {
  // This is the ONE line the addendum exists for, and in situ on the HTTP path
  // it was unreachable: the review inverted `!==` to `===` and the whole suite
  // stayed green. Both arms are driven here.
  const plan = (): SeedPlan => buildSeedPlan(tinyPack());

  it("is null when the generator minted exactly what the pack implies", () => {
    // `_tiny` implies three from d-tiny's league PLUS one from d-badminton's
    // (B03 T5) — four, summed across BOTH league stages, since `actual` at
    // the real call site is a pool-wide count spanning every division.
    expect(fixtureCountIssue(4, plan())).toBeNull();
  });

  it("names BOTH numbers and a per-division breakdown when the count is short", () => {
    const issue = fixtureCountIssue(1, plan());
    expect(issue).toContain("expected 4 fixture(s) total across 2 league stage(s)");
    expect(issue).toContain("got 1");
    // Each division's own arithmetic is named, not just the total — a reader
    // has to be able to tell WHICH stage's count is off.
    expect(issue).toContain('"d-tiny": 3 fixture(s) from the pack\'s 2-entrant league over 3 leg(s)');
    expect(issue).toContain('"d-badminton": 1 fixture(s) from the pack\'s 2-entrant league over 1 leg(s)');
  });

  it("names both numbers when the count is LONG too — the inverted operator", () => {
    // The direction matters: an inversion reports a mismatch as a match and a
    // match as a mismatch, so an arm that only ever sees `actual < expected`
    // cannot witness it.
    const issue = fixtureCountIssue(6, plan());
    expect(issue).toContain("expected 4 fixture(s) total across 2 league stage(s)");
    expect(issue).toContain("got 6");
  });

  it("degrades to the ORIGINAL single-entry sentence for a one-league-stage pack — no shape change for every pack before T5", () => {
    const pack = tinyPack();
    const singleDivision = { ...pack, divisions: [pack.divisions[0]] } as Pack;
    const issue = fixtureCountIssue(1, buildSeedPlan(singleDivision));
    expect(issue).toBe("expected 3 fixture(s) from the pack's 2-entrant league over 3 leg(s), got 1");
  });

  it("moves with the plan rather than with a constant", () => {
    const pack = tinyPack();
    const fiveLegs = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [{ ...(pack.divisions[0]?.stages[0] as object), config: { legs: 5 } }],
        },
      ],
    } as Pack;
    // Three fixtures is now the DEFECT and five is correct — the reverse of
    // the case above, so a hardcoded expectation cannot satisfy both.
    expect(fixtureCountIssue(5, buildSeedPlan(fiveLegs))).toBeNull();
    expect(fixtureCountIssue(3, buildSeedPlan(fiveLegs))).toContain("expected 5 fixture(s)");
  });

  it("names the pack's absence of a league stage rather than silently no-op'ing", () => {
    const pack = tinyPack();
    const noLeague = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [{ ...(pack.divisions[0]?.stages[0] as object), kind: "knockout" }],
        },
      ],
    } as Pack;
    const issue = fixtureCountIssue(3, buildSeedPlan(noLeague));
    expect(issue).toContain("no league-stage fixture-count expectation");
  });
});

// ---------------------------------------------------------------------------
// runTinySuite — pre-network paths
// ---------------------------------------------------------------------------

describe("runTinySuite — what the SuiteReport carries", () => {
  // Two paths, both reachable with no server: the pack stage refusing before
  // anything is created, and the HTTP half failing after it. Neither is the
  // live run — that needs a database and is the owner's to drive — but both
  // are the report SHAPE, and the shape is where a warning goes missing.
  const silent = pino({ level: "silent" });

  it("refuses BEFORE the network when the pack is wrong, and says so in the report", async () => {
    const report = await runTinySuite({
      // A base that would fail loudly if anything reached it.
      base: "http://127.0.0.1:1",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath: path.join(REPO_ROOT, "scripts/bench/packs/_absent.json"),
    });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("pack.unreadable");
    // `requestedEngine` still records what the CLI asked for, even on the
    // path that never got as far as the solver.
    expect(report.solver?.requestedEngine).toBe("optimized");
  });

  it("carries the pack's warnings into the report even when the HTTP half fails", async () => {
    const report = await runTinySuite({
      base: "http://127.0.0.1:1",
      engine: "greedy",
      keep: false,
      log: silent,
      packPath: TINY_PACK_PATH,
    });
    // The network is unreachable, so the gate is red for THAT reason…
    expect(report.gate).toBe("red");
    expect(report.errors ?? []).not.toHaveLength(0);
    // …and the pack's two permanent warnings still reached the report rather
    // than being dropped on the way through the run.
    expect(report.warnings ?? []).toHaveLength(2);
    expect((report.warnings ?? []).join(" | ")).toContain("leaderboards.not_derived");
  });
});

// ---------------------------------------------------------------------------
// findExistingSeed — the --keep reuse lookup, in isolation
// ---------------------------------------------------------------------------

interface FindCall {
  path: string;
}

function pageTransport(pages: { items: { id: string; org_id: string; slug: string; branding: Record<string, unknown> }[]; nextCursor: string | null }[]): {
  transport: SeedTransport;
  calls: FindCall[];
} {
  let n = 0;
  const calls: FindCall[] = [];
  return {
    calls,
    transport: {
      async signIn() {
        throw new Error("findExistingSeed never signs in — it is handed an already-authenticated session");
      },
      async request<T>(_base: string, _s: Session, requestPath: string) {
        calls.push({ path: requestPath });
        const page = pages[n++];
        if (page === undefined) throw new Error("fake: no more scripted pages");
        return page as unknown as T;
      },
    },
  };
}

const LOOKUP_PLAN: SeedPlan = {
  org: { name: "Bench Tiny Club", slug: "bench-tiny-club", timezone: "UTC" },
  competition: { name: "Bench Tiny Series", slug: "bench-tiny-series", endsOn: "2099-01-03" },
  divisions: [],
  persons: [],
  entrants: [],
  officialPersonRefs: [],
  officials: [],
  claimInvites: [],
  expectedFixtureCounts: [],
};

describe("findExistingSeed — the --keep reuse lookup", () => {
  it("returns null immediately, with NO request at all, when the pack declares no explicit competition slug", async () => {
    const { transport, calls } = pageTransport([]);
    const noSlugPlan: SeedPlan = { ...LOOKUP_PLAN, competition: { ...LOOKUP_PLAN.competition, slug: undefined } };
    const result = await findExistingSeed("http://x", newSession(), transport, noSlugPlan, "hash-a");
    expect(result).toEqual({ kind: "absent" });
    expect(calls).toHaveLength(0);
  });

  it("finds a row matching BOTH the pack's slug and its hash", async () => {
    const { transport } = pageTransport([
      {
        items: [{ id: "c1", org_id: "org-1", slug: "bench-tiny-series", branding: { [KEEP_BRANDING_KEY]: "hash-a" } }],
        nextCursor: null,
      },
    ]);
    const result = await findExistingSeed("http://x", newSession(), transport, LOOKUP_PLAN, "hash-a");
    expect(result).toEqual({ kind: "reuse", orgId: "org-1", competitionId: "c1" });
  });

  it("reports STALE — not absent — when the slug matches but the hash differs", async () => {
    const { transport } = pageTransport([
      {
        items: [{ id: "c1", org_id: "org-1", slug: "bench-tiny-series", branding: { [KEEP_BRANDING_KEY]: "hash-OLD" } }],
        nextCursor: null,
      },
    ]);
    const result = await findExistingSeed("http://x", newSession(), transport, LOOKUP_PLAN, "hash-NEW");
    // The distinction this test exists for: an earlier cut returned `null`
    // here, the same answer it gives for "no such competition". They are
    // opposite situations — (org_id, slug) is unique, so this row cannot be
    // seeded past, and reporting `absent` bought a 409 several calls later
    // with nothing in the message about the cause.
    expect(result).toEqual({ kind: "stale", competitionId: "c1", heldHash: "hash-OLD" });
  });

  it("does NOT match when the hash matches but the slug differs", async () => {
    const { transport } = pageTransport([
      {
        items: [{ id: "c1", org_id: "org-1", slug: "some-other-series", branding: { [KEEP_BRANDING_KEY]: "hash-a" } }],
        nextCursor: null,
      },
    ]);
    const result = await findExistingSeed("http://x", newSession(), transport, LOOKUP_PLAN, "hash-a");
    expect(result).toEqual({ kind: "absent" });
  });

  it("pages through the cursor rather than assuming the match is on page one", async () => {
    const { transport, calls } = pageTransport([
      // Page one holds OTHER competitions accumulated by earlier runs. It
      // deliberately does NOT repeat the target slug: (org_id, slug) is
      // unique, so two rows sharing a slug in one org is a state the database
      // forbids, and a fixture built that way proves nothing about a real org.
      { items: [{ id: "c-other", org_id: "org-1", slug: "some-earlier-series", branding: {} }], nextCursor: "cursor-2" },
      {
        items: [{ id: "c-match", org_id: "org-1", slug: "bench-tiny-series", branding: { [KEEP_BRANDING_KEY]: "hash-a" } }],
        nextCursor: null,
      },
    ]);
    const result = await findExistingSeed("http://x", newSession(), transport, LOOKUP_PLAN, "hash-a");
    expect(result).toEqual({ kind: "reuse", orgId: "org-1", competitionId: "c-match" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toContain("cursor=cursor-2");
  });
});

// ---------------------------------------------------------------------------
// runTinySuite — --keep idempotence, end to end through a fake transport
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** Content-addressed id assignment, matching seed.test.ts's own fake — a
 *  test can predict every id up front rather than capturing it off a
 *  response. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

interface FakeCompetitionRow {
  id: string;
  org_id: string;
  slug: string;
  branding: Record<string, unknown>;
  created_at: string;
}

/**
 * A fake server covering `_tiny.json`'s ENTIRE HTTP surface — sign-in,
 * `--keep`'s lookup, venue/court, org/competition/division/persons/entrants/
 * stage/generate (`seedSuite`'s own calls), and scheduling. One instance is
 * shared across TWO `runTinySuite` invocations in the tests below, which is
 * what lets a "second --keep run" be simulated in-process: `competitions`
 * persists what the first invocation created for the second to find.
 *
 * Org identity: `sameOrgForAll` mirrors the ONE thing this fake cannot get
 * from a real backend without it — a real Postgres-backed sign-in returns the
 * SAME org for the SAME (previously-seen) email and a NEW org for a new one;
 * `orgByEmail` reproduces exactly that. `sameOrgForAll` overrides it to a
 * single fixed org for the one test that needs a pre-existing row to be
 * reachable regardless of which email a (possibly wrongly-gated) lookup used.
 */
function makeFakeServer(opts: { sameOrgForAll?: boolean } = {}): {
  transport: SeedTransport;
  calls: RecordedCall[];
  competitions: FakeCompetitionRow[];
} {
  const calls: RecordedCall[] = [];
  const competitions: FakeCompetitionRow[] = [];
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  const orgByEmail = new Map<string, string>();
  const orgBySession = new WeakMap<Session, string>();
  let orgCounter = 0;
  let compCounter = 0;
  const FIXED_ORG = "org-fixed";

  const transport: SeedTransport = {
    async signIn(_base, s, email) {
      calls.push({ method: "SIGNIN", path: email, body: undefined });
      const orgId = opts.sameOrgForAll
        ? FIXED_ORG
        : (orgByEmail.get(email) ?? `org-${++orgCounter}`);
      orgByEmail.set(email, orgId);
      orgBySession.set(s, orgId);
      return { has_org: true, org_id: orgId, redirect: "/dashboard" };
    },
    async request<T>(_base: string, s: Session, rawPath: string, reqOpts?: { method?: string; body?: unknown }) {
      const method = reqOpts?.method ?? "GET";
      const body = reqOpts?.body;
      const routePath = rawPath.split("?")[0]!;
      calls.push({ method, path: rawPath, body });
      const orgId = orgBySession.get(s) ?? "org-unknown";

      if (method === "GET" && routePath === "/api/v1/competitions") {
        return { items: competitions.filter((c) => c.org_id === orgId), nextCursor: null } as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(routePath)) {
        return { id: `venue-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues\/[^/]+\/courts$/.test(routePath)) {
        return { id: `court-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && routePath === "/api/v1/persons") {
        return { id: `person-${slug((body as { full_name: string }).full_name)}` } as T;
      }
      if (method === "POST" && routePath === "/api/v1/competitions") {
        const b = body as { name: string; slug?: string; branding?: Record<string, unknown> };
        const wantSlug = b.slug ?? slug(b.name);
        // `competitions_org_id_slug_key` is UNIQUE (org_id, slug), and
        // `createCompetition` turns an EXPLICIT slug collision into a 409
        // rather than suffixing it. Modelling that here is the point: without
        // it this fake accepted two competitions on one slug in one org — a
        // row the database forbids — and a test asserting "the changed pack
        // seeded a fresh competition" passed against a state production can
        // never reach.
        if (competitions.some((c) => c.org_id === orgId && c.slug === wantSlug)) {
          throw new BenchHttpError(routePath, 409, {
            ok: false,
            error: { code: "CONFLICT", message: `slug '${wantSlug}' is already taken` },
          });
        }
        const id = `comp-${++compCounter}`;
        competitions.push({
          id,
          org_id: orgId,
          slug: wantSlug,
          branding: b.branding ?? {},
          created_at: new Date(2000, 0, compCounter).toISOString(),
        });
        return { id } as T;
      }
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(routePath)) {
        return { id: `div-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/stages$/.test(routePath)) {
        const stages = body as { name: string }[];
        return stages.map((st) => ({ id: `stage-${slug(st.name)}` })) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/entrants$/.test(routePath)) {
        const rows = body as { display_name: string }[];
        return rows.map((e) => ({ id: `entrant-${slug(e.display_name)}` })) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(routePath)) {
        // STAGE-AWARE, because `_tiny.json` now declares TWO league stages
        // (B03 T5 — the badminton division) and `seedSuite` calls `/generate`
        // once per stage (lib/seed.ts): d-tiny's mints three round-robin
        // fixtures (2 entrants, 3 legs), d-badminton's mints one (2 entrants,
        // 1 leg). A single hardcoded response here would hand d-badminton
        // three UNCLAIMED fixtures and leave its own stream unmatched —
        // `bindStreamFixtures`'s two anti-vacuity checks (lib/seed.ts:184-185)
        // exist precisely to catch that.
        const stageId = routePath.split("/")[4];
        if (stageId === "stage-badminton-league") {
          return { fixtures: [{ id: "fx-bm-1", ext_key: "rr-r1-c1" }] } as unknown as T;
        }
        return {
          fixtures: [
            { id: "fx-1", ext_key: "rr-r1-c1" },
            { id: "fx-2", ext_key: "rr-r2-c1" },
            { id: "fx-3", ext_key: "rr-r3-c1" },
          ],
        } as unknown as T;
      }
      if (method === "PUT" && /^\/api\/v1\/divisions\/[^/]+\/schedule-settings$/.test(routePath)) {
        return {} as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/schedule\/auto$/.test(routePath)) {
        return {
          assignments: [
            { fixture_id: "fx-1", scheduled_at: "2099-01-01T00:00:00.000Z", court_id: "court-court-1" },
            { fixture_id: "fx-2", scheduled_at: "2099-01-01T01:00:00.000Z", court_id: "court-court-1" },
            { fixture_id: "fx-3", scheduled_at: "2099-01-01T02:00:00.000Z", court_id: "court-court-1" },
          ],
          conflicts: [],
          solver: { engine: "greedy", status: "ok" },
        } as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/schedule\/apply$/.test(routePath)) {
        return {} as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/schedule\/validate$/.test(routePath)) {
        return { conflicts: [] } as unknown as T;
      }
      // ---- officials + claim invites (B03 T6). These exist here because
      // wiring `seedOfficialsAndClaims` into `seedSuite` made `_tiny`'s own
      // officials reach this fake for the first time. That is the point of
      // the wiring: an unwired step cannot change what a real run does, and
      // two tests in this file went red the moment it could.
      if (method === "POST" && routePath === "/api/v1/officials") {
        const b = body as { display_name: string };
        return { id: `official-${slug(b.display_name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/officials\/[^/]+\/availability$/.test(routePath)) {
        return { date: (body as { date: string }).date } as T;
      }
      // B03 T6b — the official's OWN claim invite, same shared claim-invite
      // map as the pack's player invites below (a distinct GET, never this
      // POST's own echo, is what the driver trusts either way).
      const officialInviteMatch = /^\/api\/v1\/officials\/([^/]+)\/invite$/.exec(routePath);
      if (method === "POST" && officialInviteMatch) {
        const officialId = officialInviteMatch[1]!;
        const personId = `invited-${officialId}`;
        const row = { id: personId, person_id: personId, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return { person_id: personId } as T;
      }
      if (method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+\/officials$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        fixtureOfficials.set(fixtureId, (body as { set: unknown[] }).set);
        return { ok: true } as T;
      }
      if (method === "GET" && /^\/api\/v1\/fixtures\/[^/]+$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        return { id: fixtureId, officials: fixtureOfficials.get(fixtureId) ?? [] } as T;
      }
      if (method === "POST" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        const row = { person_id: personId, token: `pc_${personId}`, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return row as T;
      }
      if (method === "GET" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        return (claimInvites.get(personId) ?? null) as T;
      }

      throw new Error(`fake server: unhandled ${method} ${routePath}`);
    },
  };
  return { transport, calls, competitions };
}

function competitionPosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && c.path === "/api/v1/competitions");
}

describe("runTinySuite — --keep idempotence (T4)", () => {
  const silent = pino({ level: "silent" });

  it("a second --keep run against the SAME pack short-circuits: no duplicate competition, reuses the prior run's ids", async () => {
    const server = makeFakeServer();
    const { packPath, dir } = writeTinyPack(TINY_TEXT);

    const report1 = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath,
      transport: server.transport,
    });
    expect(report1.gate).toBe("green");
    expect(competitionPosts(server.calls)).toHaveLength(1);

    const report2 = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath, // the SAME pack content — same hash
      transport: server.transport,
    });
    expect(report2.gate).toBe("green");
    expect((report2.warnings ?? []).join(" | ")).toContain("--keep reused existing seed");
    // The load-bearing assertion: still exactly ONE competition ever created.
    expect(competitionPosts(server.calls)).toHaveLength(1);
    expect(server.competitions).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("a --keep run whose pack content CHANGED refuses with the cause and creates NOTHING", async () => {
    const server = makeFakeServer();
    const { packPath: packPathA, dir: dirA } = writeTinyPack(TINY_TEXT);

    const report1 = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath: packPathA,
      transport: server.transport,
    });
    expect(report1.gate).toBe("green");

    // A content edit that keeps the pack's DECLARED competition slug the same
    // (the guard matches on slug — see tiny.ts's header comment) but changes
    // its hash.
    const raw = JSON.parse(TINY_TEXT) as { competition: { description: string } };
    raw.competition = { ...raw.competition, description: `${raw.competition.description} (edited for T4's test)` };
    const editedText = JSON.stringify(raw);
    const packB = loadPackValue(JSON.parse(editedText) as unknown, TINY_PACK_PATH);
    if (!packB.ok) throw new Error("fixture bug: the edited pack no longer loads");
    expect(hashPack(packB.pack)).not.toBe(hashPack(tinyPack()));
    const { packPath: packPathB, dir: dirB } = writeTinyPack(editedText);

    const report2 = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath: packPathB,
      transport: server.transport,
    });
    // NOT green, and not a duplicate seed either. This test asserted both of
    // those before, and passed — because the fake server accepted two
    // competitions on one slug in one org, which `competitions_org_id_slug_key`
    // forbids. Against the real API the second create is a 409 several calls
    // in, and the suite reported it as an opaque HTTP failure rather than
    // "your pack changed".
    expect(report2.gate).toBe("red");
    expect((report2.warnings ?? []).join(" | ")).not.toContain("--keep reused existing seed");
    const refusal = (report2.errors ?? []).join(" | ");
    expect(refusal).toContain("--keep cannot reuse competition");
    expect(refusal).toContain("bench-tiny-series");
    expect(refusal).toContain("--wipe");
    // The load-bearing assertions: the FIRST run seeded, the second created
    // nothing at all — no second POST, so no 409 to explain.
    expect(competitionPosts(server.calls)).toHaveLength(1);
    expect(server.competitions).toHaveLength(1);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("a real run DRIVES the officials/claims seam — not merely defines it", async () => {
    // AGENTS.md recurring failure class 1, the inert seam: code declared,
    // typed and unit-green that nothing in production ever calls. It has
    // shipped six times in this repo, and `seedOfficialsAndClaims` was the
    // seventh — fully tested against its own fake and wired into nothing,
    // deferred because ONE of its five steps (auto-assign) is Pro-gated.
    //
    // Its own unit tests cannot see this: they call the function directly, so
    // they pass identically whether or not `seedSuite` ever invokes it. Only a
    // test that drives the REAL producer can tell the difference, which is
    // what this one does.
    const server = makeFakeServer();
    const { packPath, dir } = writeTinyPack(TINY_TEXT);

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "greedy",
      keep: false,
      log: silent,
      packPath,
      transport: server.transport,
    });
    expect(report.gate).toBe("green");

    const hit = (method: string, re: RegExp) =>
      server.calls.filter((c) => c.method === method && re.test(c.path.split("?")[0]!));

    // `_tiny` declares two officials and one claim invite (T6). Every count
    // below is derived from the pack rather than typed in, so editing the
    // pack moves the expectation with it instead of leaving a stale literal.
    const pack = tinyPack();
    const officials = pack.officials ?? [];
    const invites = pack.claimInvites ?? [];
    const blackouts = officials.flatMap((o) => o.unavailable);
    const manual = officials.filter((o) => o.assignments.length > 0);
    expect(officials.length, "fixture guard: the pack must declare officials").toBeGreaterThan(0);
    expect(blackouts.length, "fixture guard: at least one blackout").toBeGreaterThan(0);
    expect(manual.length, "fixture guard: at least one NAMED assignment").toBeGreaterThan(0);
    expect(invites.length, "fixture guard: at least one claim invite").toBeGreaterThan(0);

    expect(hit("POST", /^\/api\/v1\/officials$/)).toHaveLength(officials.length);
    expect(hit("POST", /^\/api\/v1\/officials\/[^/]+\/availability$/)).toHaveLength(blackouts.length);
    expect(hit("PATCH", /^\/api\/v1\/fixtures\/[^/]+\/officials$/).length).toBeGreaterThan(0);
    expect(hit("POST", /^\/api\/v1\/persons\/[^/]+\/claim-invites$/)).toHaveLength(invites.length);

    // The blackout's DATE, not merely that a blackout call happened — a
    // reachability assertion is satisfied by ANY value.
    const sentDates = hit("POST", /^\/api\/v1\/officials\/[^/]+\/availability$/)
      .map((c) => (c.body as { date: string }).date)
      .sort();
    expect(sentDates).toEqual(blackouts.map((u) => u.date).sort());

    // And auto-assign must NOT have run: it is the one Pro-gated step, and
    // `seedSuite` leaves it off until plan provisioning exists (B03 T7).
    expect(hit("POST", /^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/)).toHaveLength(0);
    expect(hit("POST", /^\/api\/v1\/divisions\/[^/]+\/officials\/apply$/)).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("a --wipe run never even ATTEMPTS the reuse lookup, even when a matching competition already exists", async () => {
    // `sameOrgForAll` is what makes this a real test of the GATE rather than
    // a coincidence: every sign-in (this run's random-tagged one included)
    // lands in the SAME org as the pre-seeded row below, so a lookup that ran
    // even once under `--wipe` WOULD find it and wrongly short-circuit.
    //
    // That device also makes the run UNABLE to finish, and this test now says
    // so instead of pretending otherwise. The pre-seeded row holds the pack's
    // own declared slug, `(org_id, slug)` is unique, so a fresh create in that
    // org must collide — the earlier version of this test asserted a green
    // gate and two competitions on one slug in one org, which the database
    // forbids, and it only passed because the fake accepted the illegal row.
    // Production never reaches this state: a non-`--keep` run signs in under a
    // random-tagged email (`runTag = keep ? "keep" : randomUUID()`) and lands
    // in a FRESH org, so there is no slug to collide with. The assertion that
    // carries this test is the absence of the lookup, not the gate colour.
    const server = makeFakeServer({ sameOrgForAll: true });
    const { packPath, dir } = writeTinyPack(TINY_TEXT);
    const hash = hashPack(tinyPack());
    server.competitions.push({
      id: "comp-preexisting",
      org_id: "org-fixed",
      slug: "bench-tiny-series",
      branding: { [KEEP_BRANDING_KEY]: hash },
      created_at: new Date(1999, 0, 1).toISOString(),
    });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "greedy",
      keep: false,
      log: silent,
      packPath,
      transport: server.transport,
    });
    expect((report.warnings ?? []).join(" | ")).not.toContain("--keep reused existing seed");

    // THE load-bearing assertion: the reuse lookup was never issued. A `--keep`
    // gate that leaked into a `--wipe` run would have found the pre-seeded row
    // and short-circuited, and this is what proves it did not.
    expect(server.calls.some((c) => c.method === "GET" && c.path.startsWith("/api/v1/competitions"))).toBe(false);

    // It got as far as ATTEMPTING the create — one POST — and failed on the
    // slug collision, which is the honest outcome of the same-org device above.
    expect(competitionPosts(server.calls)).toHaveLength(1);
    expect(server.competitions).toHaveLength(1);
    expect(report.gate).toBe("red");
    const why = (report.errors ?? []).join(" | ");
    // Failed at the CREATE, not through the `--keep` refusal path — the
    // difference between "the gate was skipped" (correct) and "the gate ran
    // and refused" (the bug this test is here to catch).
    expect(why).toContain("409");
    expect(why).not.toContain("--keep cannot reuse");

    rmSync(dir, { recursive: true, force: true });
  });
});
