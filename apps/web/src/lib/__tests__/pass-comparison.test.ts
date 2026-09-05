// The upgrade page's comparison table (spec D10 — "naming real limits").
//
// The page it replaced quoted its limits from the dictionary, and one of them
// was flatly wrong: `upgrade.includes.entrants` promised "32 entrants per
// division (Free: 16)" while the live matrix grants the pass 64 and already
// gives Community 32. The offer undersold itself by half and libelled the free
// plan, in four languages, and no test could notice because the claim and the
// grant lived in different systems.
//
// Two halves here. The pure half pins how a cell is rendered — the difference
// between a missing NUMBER row (no ceiling was configured: unlimited) and a
// missing FLAG row (nobody granted it: off) is the whole reason `compareCell`
// takes a kind. The DB-backed half pins the SHAPE of today's matrix, so a key
// that quietly loses its row cannot slip onto the page as "Unlimited".
//
// Real Postgres required for the second half; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  PASS_COMPARE_FEATURES,
  PASS_COMPARE_ROWS,
  compareCell,
  rowCovers,
} from "@/lib/pass-comparison";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("compareCell", () => {
  it("prints an integer limit as itself", () => {
    expect(compareCell("number", { bool: null, int: 64 })).toEqual({ type: "value", text: "64" });
  });

  it("prints a percentage with its sign", () => {
    expect(compareCell("percent", { bool: null, int: 5 })).toEqual({ type: "value", text: "5%" });
  });

  it("reads a missing numeric row as unlimited, not as nothing", () => {
    // `getLimit` reads a null int_value (and, for this renderer, an absent row)
    // as "no ceiling configured". Rendering a blank would tell a buyer the plan
    // offers least in a row where it offers most. Enterprise is where the
    // unlimited caps live after V392; no cell this table renders is unlimited
    // any more, which is why the branch is pinned here rather than from the DB.
    expect(compareCell("number", undefined)).toEqual({ type: "unlimited" });
    expect(compareCell("number", { bool: null, int: null })).toEqual({ type: "unlimited" });
  });

  it("reads a missing flag row as off", () => {
    // Absence is the opposite claim for a boolean: a feature nobody granted is
    // not granted. Sharing one rule across both kinds would either hide Pro's
    // unlimited divisions or promise every plan every feature.
    expect(compareCell("flag", undefined)).toEqual({ type: "no" });
    expect(compareCell("flag", { bool: false, int: null })).toEqual({ type: "no" });
    expect(compareCell("flag", { bool: true, int: null })).toEqual({ type: "yes" });
  });

  it("never renders an unknown fee as a promise", () => {
    // "Unlimited platform fee" is not a thing, and a blank fee cell would read
    // as free. An unreadable rate says nothing at all.
    expect(compareCell("percent", undefined)).toEqual({ type: "no" });
  });
});

describe("rowCovers", () => {
  it("matches a ceiling key to the row that describes it", () => {
    const formats = PASS_COMPARE_ROWS.find((r) => r.labelKey === "upgrade.limit.formats")!;
    // One line to a reader, two keys to the resolver — a ceiling arriving on
    // either must light the same row.
    expect(rowCovers(formats, "formats.advanced")).toBe(true);
    expect(rowCovers(formats, "formats.double_elim")).toBe(true);
    expect(rowCovers(formats, "realtime")).toBe(false);
  });

  it("lights nothing when no feature key came in", () => {
    expect(rowCovers(PASS_COMPARE_ROWS[0], null)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("the table's rows against the live matrix", () => {
  const cells = async () => {
    const rows = await sql<
      { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`
      select plan_key, feature_key, bool_value, int_value
      from plan_entitlements
      where plan_key in ('community', 'event_pass', 'pro')
        and feature_key in ${sql(PASS_COMPARE_FEATURES)}`;
    expect(rows.length).toBeGreaterThan(0);
    return new Map(rows.map((r) => [`${r.plan_key}|${r.feature_key}`, r]));
  };

  it("reports a figure for every plan/row pair the matrix defines", async () => {
    // The guard against silent drift: if a row loses its entry the table would
    // start printing "Unlimited" for a plan that grants nothing.
    const seen = await cells();
    for (const row of PASS_COMPARE_ROWS) {
      for (const plan of ["community", "event_pass", "pro"]) {
        const key = `${plan}|${row.features[0]}`;
        expect(seen.has(key), `${key} has no plan_entitlements row`).toBe(true);
      }
    }
  });

  it("renders every numeric cell from the row the matrix actually holds", async () => {
    // Until V392 Pro's `divisions.per_competition.max` was a present-but-null
    // "no ceiling" row and this case pinned the unlimited branch from the DB.
    // V392 gave Pro a finite 20, so no cell this table renders is unlimited any
    // more — the branch is pinned by the pure `compareCell` case above, and
    // what the live matrix can still prove is that each numeric cell prints the
    // number the row holds rather than a blank.
    const seen = await cells();
    for (const plan of ["community", "event_pass", "pro"]) {
      const cap = seen.get(`${plan}|divisions.per_competition.max`);
      expect(cap, `${plan} divisions row`).toBeDefined();
      expect(cap!.int_value, `${plan} divisions must be a finite ceiling`).toBeTypeOf("number");
      expect(compareCell("number", { bool: cap!.bool_value, int: cap!.int_value })).toEqual({
        type: "value",
        text: String(cap!.int_value),
      });
    }
  });

  it("only claims the pass improves on Community where the matrix says so", async () => {
    // Every row on this table exists to justify $29. A row where the pass
    // equals Community is padding on a price page, and the entrants row was
    // exactly that lie in reverse.
    const seen = await cells();
    for (const row of PASS_COMPARE_ROWS) {
      const free = seen.get(`community|${row.features[0]}`);
      const pass = seen.get(`event_pass|${row.features[0]}`);
      expect(pass, `${row.features[0]} has no event_pass row`).toBeDefined();
      const differs =
        free?.bool_value !== pass?.bool_value || free?.int_value !== pass?.int_value;
      expect(differs, `${row.labelKey} shows the same thing on Free and the pass`).toBe(true);
    }
  });

  it("still names the share loop V395 put back behind the pass", async () => {
    // The row this table lost and had to be given back.
    //
    // V392 retired `dashboard.player_profiles` from the table on a true
    // premise — community had caught up, so the row showed the same tick on
    // both sides. V395 (owner ruling 2026-09-03) REVERSED that: the three
    // share loops became paid on Free again while both pass rungs kept them.
    // `lib/pass-features.ts` re-entered the key into `PASS_LIFTED_FEATURES` in
    // that same wave, and this table did not follow — so for a wave the
    // comparison a buyer reads to justify $29 was silent about one of the
    // things the $29 buys, and the paywall was offering a pass for a key the
    // comparison never mentioned.
    //
    // Nothing above could see it. Every rule in this block iterates
    // `PASS_COMPARE_ROWS`, so a row that is ABSENT is absent from the check
    // too — the omission is invisible to a guard shaped as "each row I have is
    // honest". This is the missing direction: a grant the pass really lifts
    // must have a row.
    //
    // Both halves are read from the live matrix rather than asserted on faith.
    // If community ever catches up for real, this fails and the row should
    // leave a SECOND time — which is the outcome we want, because the same
    // reasoning that removed it in V392 was sound on the matrix of the day.
    const [free] = await sql<{ bool_value: boolean | null }[]>`
      select bool_value from plan_entitlements
       where plan_key = 'community' and feature_key = 'dashboard.player_profiles'`;
    const [pass] = await sql<{ bool_value: boolean | null }[]>`
      select bool_value from plan_entitlements
       where plan_key = 'event_pass' and feature_key = 'dashboard.player_profiles'`;
    expect(free?.bool_value, "community must still be DENIED player profiles").toBe(false);
    expect(pass?.bool_value, "the pass must still GRANT player profiles").toBe(true);

    const row = PASS_COMPARE_ROWS.find((r) => r.features.includes("dashboard.player_profiles"));
    expect(row, "the pass comparison has no public-player-profiles row").toBeDefined();
    expect(row!.kind, "a grant is a flag, not a figure").toBe("flag");
    // The label has to exist for the page to render it; it survived V392's
    // removal in all four dictionaries precisely so this restore is copy-free.
    expect(row!.labelKey).toBe("upgrade.limit.profiles");
  });

  it("keeps the entrants row honest — the claim this table was built to fix", async () => {
    // The dictionary said "32 entrants per division (Free: 16)". The matrix
    // now says 64 free and 128 on the pass (V319). Pinned by name because it is
    // the exact bug, not a hypothetical one.
    const seen = await cells();
    expect(seen.get("community|entrants.per_division.max")?.int_value).toBe(64);
    expect(seen.get("event_pass|entrants.per_division.max")?.int_value).toBe(128);
    expect(seen.get("pro|entrants.per_division.max")?.int_value).toBe(256);
  });
});
