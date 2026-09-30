// The pricing table renders from plan_entitlements — these pin the pivot:
// ints/∞, bool ticks, pass-column fallback to community (the resolver's
// fall-through), and the folded entry-fee cell, across every PRICING_PLAN_KEYS
// column + the ENTITLEMENT_DOMAINS sections.
//
// Entitlements v18 (V393): the `pro_plus` column is GONE, and owner decision
// 2026-09-05 took `event_pass_l` off sale, so `PRICING_PLAN_KEYS` is three wide
// (community / event_pass / pro). `enterprise` is deliberately not a column
// (design §4: it is the Contact-us strip below the table, not a priced offer),
// and neither is a rung nobody can buy — this table's whole job is to help a
// reader CHOOSE, and a column for an offer that has no checkout is a choice
// that cannot be taken.
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPricingSections,
  PRICING_PLAN_KEYS,
  PRICING_COLUMN_LABEL_KEY,
  type MatrixData,
} from "@/lib/pricing-matrix";
import { ALL_PLAN_KEYS, HIDDEN_PASS_KEYS, SELLABLE_PASS_KEYS } from "@/lib/currency";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const cell = (int: number | null = null, bool: boolean | null = null) => ({
  int_value: int,
  bool_value: bool,
});

/**
 * Mirrors the real local-DB values for the rows under test, post-V393.
 *
 * A hand-typed fixture is right for this file — it is a test of the RENDERER
 * (formatting, fall-through, folding), and a fixture lets it run without a
 * database. But "mirrors the real values" was only ever a COMMENT, and V393
 * proved what that is worth: the fixture sat on V319's numbers, the renderer
 * tests stayed green, and every figure in them described a matrix that no
 * longer existed. `FIXTURE_MIRRORS_THE_LIVE_MATRIX` at the foot of this file
 * now enforces the claim against `plan_entitlements` whenever a DB is present.
 */
const DATA: MatrixData = {
  "competitions.max_active": {
    // V393 (R6): community 10 -> 3. Still no pass row — a passed competition
    // leaves the ACTIVE COUNT (server/usecases/competitions.ts) instead of
    // raising the org-wide cap, which is why §2 writes the pass cells as "+1"
    // and the table renders prose there rather than a number.
    community: cell(3),
    pro: cell(null),
  },
  "divisions.per_competition.max": {
    community: cell(4),
    event_pass: cell(10),
    // V341: L lifts the division headroom to 20. V393 brought PRO down to the
    // same 20 (R2: "bounded; 20 is a federation"), so L and Pro now agree here
    // and the L column's job is to beat M, not to beat Pro.
    event_pass_l: cell(20),
    pro: cell(20),
  },
  "entrants.per_division.max": {
    community: cell(64),
    event_pass: cell(128),
    // V393: L's ∞ becomes a FINITE 512. This is the cap the pass ladder copy
    // used to call "unlimited" — see the v18 plan's T8b table.
    event_pass_l: cell(512),
    pro: cell(256),
  },
  "schedule.checkpoints.max": {
    // V393 gave BOTH pass rungs their own row (5), where they used to fall
    // through to community. Pro rose 5 -> 10.
    community: cell(2),
    event_pass: cell(5),
    event_pass_l: cell(5),
    pro: cell(10),
  },
  // V319 ungate (#253): manual officials are included on every plan.
  // officials.per_fixture.max is not rendered — V393 deleted the key outright.
  "officials.roles_multi": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // V393: AI officials are GRANTED on both pass rungs. They used to be the
  // "honest differentiator" this file asserted the passes did NOT buy; the
  // pass is competition-scoped, so granting it there is scoped too (W2 T6
  // makes the officials gates resolve against the competition).
  "officials.auto": {
    community: cell(null, false),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  "officials.marks": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // V310 (D18/D19/D20): charging entry fees is free for everyone; the pass and
  // the paid plans buy a CHEAPER cut, not the ability itself.
  "registration.paid": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // V398 re-cut this ladder for the additive-fee model: community 8 -> 5, both
  // pass rungs 5 -> 4. Pro and enterprise were already pure margin and did not
  // move.
  "registration.fee_percent": {
    community: cell(5),
    event_pass: cell(4),
    // Flat across rungs by decision (#294): L buys size, not a cheaper cut.
    event_pass_l: cell(4),
    pro: cell(2),
  },
  // W3-A (2026-09-06, V399): the per-division RECORD is free on every plan —
  // community caught up. Kept in the fixture (an all-true row still renders,
  // same precedent as formats.double_elim) rather than dropped.
  "stats.player": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // W3-A: the NEW key for the split-off leverage half — the cross-division
  // CAREER ROLLUP. Carries forward exactly the cells `stats.player` held
  // before the split (V393: the pass lifts it, community stays denied).
  "stats.player.career": {
    community: cell(null, false),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // V393 granted the public player card on COMMUNITY; V396 (W2 T15, owner
  // ruling 2026-09-03) took it back — it is one of the three share loops that
  // went paid — so it is once again the headline thing an Event Pass lifts.
  "dashboard.player_profiles": {
    community: cell(null, false),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
  },
  // Register caps render as NUMBERS, ∞ for unlimited — never a bare ✓/—.
  // V393: pro clubs 20 -> 25, teams 40 -> 100, squad ∞ -> 40. No pass rows on
  // any of the three (org-wide caps a competition-scoped pass can never lift),
  // so all three exercise the pass columns' fall-through to community.
  "clubs.max": {
    community: cell(5),
    pro: cell(25, true),
  },
  "teams.max": {
    community: cell(8),
    pro: cell(100, true),
  },
  "teams.squad_max": {
    // V393 DROPPED the pass rows here — they were 20, identical to community,
    // so they lifted nothing (design §2: "Pass rows (20 = Free) were no-ops
    // and are dropped"). V395 then raised community 20 -> 23, the engine's own
    // largest matchday squad (football 11 + 12 bench, icehockey 6 + 17).
    community: cell(23, true),
    pro: cell(40, true),
  },
  // W3 fix round 2, item 3: the one row where every purchasable-plan cell is
  // dashed. Values mirror the live matrix exactly (checked directly against
  // `entw3`'s plan_entitlements, 2026-09-06): denied on every self-serve plan,
  // granted only on enterprise, which is why it earns the routing note below
  // rather than reading as a flat "no" with nowhere to send the reader.
  "api.write": {
    community: cell(null, false),
    pro: cell(null, false),
    enterprise: cell(null, true),
  },
};

// Keys with NO pass row in the fixture above — competitions.max_active,
// clubs.max, teams.max, teams.squad_max — are deliberate: they exercise both
// rungs' fall-through to community, the resolver behaviour a fifth column
// silently rendering "—" would break.

describe("buildPricingSections — the /pricing pivot", () => {
  const sections = buildPricingSections(DATA);
  const allRows = sections.flatMap((s) => s.rows);
  const row = (labelKey: string) => allRows.find((r) => r.labelKey === labelKey)!;
  const cells = (labelKey: string) => row(labelKey).cells;

  it("returns one section per ENTITLEMENT_DOMAINS entry, in domain order", () => {
    expect(sections).toHaveLength(8);
    expect(sections.map((s) => s.labelKey)).toEqual(
      ENTITLEMENT_DOMAINS.map((d) => `pricing.matrix.section.${d.slug}`),
    );
  });

  // The anti-gap guard. The bug this whole task exists to close was a table
  // whose shape allowed exactly ONE pass column, so a second rung had nowhere
  // to render and quietly inherited the first one's numbers. `cells` is keyed
  // by PRICING_PLAN_KEYS, so a plan added to that tuple without a value here
  // fails LOUDLY — naming the row and the plan — instead of vanishing.
  it("gives every row a non-empty cell for every PRICING_PLAN_KEYS column", () => {
    for (const r of allRows) {
      for (const plan of PRICING_PLAN_KEYS) {
        expect(r.cells[plan], `${r.labelKey} / ${plan}`).toBeTruthy();
      }
      expect(Object.keys(r.cells).sort().join(","), r.labelKey).toBe(
        [...PRICING_PLAN_KEYS].sort().join(","),
      );
    }
  });

  // The columns are the PURCHASABLE offers, and nothing else. Enumerated
  // against the authority in lib/currency.ts rather than typed here, so this
  // asks the same question the page does instead of restating today's answer.
  it("is every purchasable plan — no enterprise, and no rung that is off sale", () => {
    // The positive half first: this table must not quietly lose a column.
    expect([...PRICING_PLAN_KEYS]).toEqual(
      ALL_PLAN_KEYS.filter(
        (k) => k !== "enterprise" && !(HIDDEN_PASS_KEYS as readonly string[]).includes(k),
      ),
    );
    expect(PRICING_PLAN_KEYS).toContain("community");
    expect(PRICING_PLAN_KEYS).toContain("pro");
    for (const sellable of SELLABLE_PASS_KEYS) expect(PRICING_PLAN_KEYS).toContain(sellable);
    // …then the negative, which is what the change is for.
    for (const hidden of HIDDEN_PASS_KEYS) {
      expect(PRICING_PLAN_KEYS, `${hidden} is off sale`).not.toContain(hidden);
    }
    expect(PRICING_PLAN_KEYS).not.toContain("enterprise");
    // Anti-vacuity: the hidden rung is a REAL plan row, so the exclusion above
    // is a filter and not a statement about a key that never existed.
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
    for (const hidden of HIDDEN_PASS_KEYS) expect(ALL_PLAN_KEYS).toContain(hidden);
  });

  // Every column needs a heading, and each must be its own — two plans sharing
  // a label is how a reader ends up comparing "Event Pass" against
  // "Event Pass" and concluding the rungs are the same product.
  it("names a distinct heading key for every column", () => {
    const labels = PRICING_PLAN_KEYS.map((p) => PRICING_COLUMN_LABEL_KEY[p]);
    expect(labels.filter(Boolean)).toHaveLength(PRICING_PLAN_KEYS.length);
    expect(new Set(labels).size).toBe(PRICING_PLAN_KEYS.length);
  });

  it("renders the prose quota row for competitions.max_active", () => {
    // V393 (R6): the free tier drops to 3 active competitions. BOTH rungs read
    // the prose cell: a pass IS one competition, at either size.
    expect(cells("pricing.matrix.competitions.max_active")).toMatchObject({
      community: "3",
      event_pass: "pricing.matrix.passedEvent",
      pro: "∞",
    });
  });

  it("renders ∞ for unlimited ints, never the word Unlimited", () => {
    // The ∞ WITNESS. V393 made every other int cap in this fixture finite —
    // Pro divisions 20, entrants 256, clubs 25, teams 100, squad 40, save
    // points 10 — so competitions.max_active is the only row left that renders
    // an infinity at all. Without this assertion the case would keep its name
    // while proving nothing about unlimited rendering.
    expect(cells("pricing.matrix.competitions.max_active").pro).toBe("∞");
    const rendered = JSON.stringify(sections);
    expect(rendered).not.toMatch(/unlimited/i);
    expect(rendered).toContain("∞");
  });

  it("renders the scale ladders as numbers — V393 made Pro finite on both", () => {
    // Pro's ∞ on these two rows is what the design bought back: R2 bounds
    // divisions at 20 (a federation) and entrants at 256. L reaching 512 is
    // the only place a PASS column beats Pro, and it is finite too — the pass
    // ladder copy calling it "unlimited" is the T8b defect.
    expect(cells("pricing.matrix.divisions.per_competition.max")).toMatchObject({
      community: "4",
      event_pass: "10",
      pro: "20",
    });
    expect(cells("pricing.matrix.entrants.per_division.max")).toMatchObject({
      community: "64",
      event_pass: "128",
      pro: "256",
    });
  });

  it("renders the clubs/teams/squad caps as numbers, never a bare tick", () => {
    // No pass row on any of the three, so BOTH pass columns fall through to
    // community. V393: pro clubs 20 -> 25, teams 40 -> 100, squad ∞ -> 40.
    expect(cells("pricing.matrix.clubs.max")).toMatchObject({
      community: "5",
      event_pass: "5",
      pro: "25",
    });
    expect(cells("pricing.matrix.teams.max")).toMatchObject({
      community: "8",
      event_pass: "8",
      pro: "100",
    });
    expect(cells("pricing.matrix.teams.squad_max")).toMatchObject({
      community: "23",
      event_pass: "23",
      pro: "40",
    });
  });

  it("falls BOTH pass columns through to community when neither rung has a row", () => {
    // ANTI-VACUITY FIRST. This case used to ride on schedule.checkpoints.max,
    // and V393 gave that key its own pass rows (5) — at which point the
    // assertion was reading a real pass value and no longer testing
    // fall-through at all, while still passing and still called this. The
    // vehicle now has to PROVE it has no pass row before the fall-through
    // assertion means anything.
    const KEY = "clubs.max";
    expect(DATA[KEY]!.event_pass, `${KEY} grew a pass row — pick another vehicle`).toBeUndefined();
    expect(DATA[KEY]!.event_pass_l, `${KEY} grew an L row — pick another vehicle`).toBeUndefined();
    expect(DATA[KEY]!.community, `${KEY} must differ from pro, or "falls through" is unobservable`)
      .not.toEqual(DATA[KEY]!.pro);

    // Only the columns the table actually renders — the L rung is off sale
    // (2026-09-05) and has no column any more, so asserting on its cell here
    // would assert on `undefined` and pass for the wrong reason. The rule it
    // used to witness — a pass rung with no row falls through to community —
    // is a fact about the RESOLVER, and `entitlements-sql-parity.test.ts`
    // holds it for both rungs against the live matrix.
    const c = cells(`pricing.matrix.${KEY}`);
    expect(c.event_pass).toBe(c.community);
    expect(c.pro).not.toBe(c.community);
  });

  // #244: scorers retired from ALL marketing/comparison copy. The DB key and
  // role code stay, but no scorer row may appear anywhere in the pricing table.
  it("renders no scorer row anywhere (retired from marketing, #244)", () => {
    const haystack = JSON.stringify(sections).toLowerCase();
    expect(haystack).not.toContain("scorer");
  });

  // V319 ungate (#253): officials are included on every plan. The comparison
  // must not read as a paywall — roles_multi and marks tick across all four
  // columns; only officials.auto (AI officials) is a Pro/Pro-Plus differentiator.
  it("shows officials as included on every plan, not a paywalled row", () => {
    const tick = { community: "✓", event_pass: "✓", pro: "✓" };
    expect(cells("pricing.matrix.officials.roles_multi")).toMatchObject(tick);
    expect(cells("pricing.matrix.officials.marks")).toMatchObject(tick);
    // V393 REVERSED this row. AI officials used to be the one officials line a
    // pass did NOT buy ("L is a bigger event, not a cheaper Pro"); §2 now
    // grants officials.auto on both rungs, and W2 T6 makes the gate resolve
    // against the competition so the grant is scoped to the passed event
    // rather than lifting the org. Community is the only column still denied,
    // which is what keeps the row a differentiator at all.
    expect(cells("pricing.matrix.officials.auto")).toMatchObject({
      community: "—",
      event_pass: "✓",
      pro: "✓",
    });
  });

  // The all-∞ trap: officials.per_fixture.max is ∞ on every plan after V319, so
  // it must not be rendered — a mystery ∞/∞/∞/∞ row tells no story.
  it("does not render the undifferentiated officials.per_fixture.max row", () => {
    const labelKeys = allRows.map((r) => r.labelKey);
    expect(labelKeys).not.toContain("pricing.matrix.officials.per_fixture.max");
  });

  it("folds registration.paid + fee_percent into one entry-fee cell, keyed pricing.matrix.fees", () => {
    // V310 as re-cut by V398: every column charges; the ladder is what differs,
    // now 5/4/2/1 rather than 8/5/2/1.
    // #294: the fee is FLAT across rungs — L buys size, not a cheaper cut.
    // Equal cells on the two pass columns are the assertion that keeps that
    // honest, so they move together or not at all.
    expect(cells("pricing.matrix.fees")).toMatchObject({
      community: "✓ 5%",
      event_pass: "✓ 4%",
      pro: "✓ 2%",
    });
    // The 1% rung did not disappear with pro_plus — it moved to `enterprise`,
    // which is not a /pricing column by design (§4: Contact-us, not a priced
    // offer). `entitlements-v18-matrix.test.ts` pins the row itself.
  });

  it("charges every column — no plan is barred from taking entry fees", () => {
    for (const plan of PRICING_PLAN_KEYS) {
      expect(cells("pricing.matrix.fees")[plan], plan).not.toBe("—");
    }
  });

  // W3 fix round 2, item 6 (controller extension): the fees row must disclose
  // that our cut is ADDITIVE — V398 made the percentage pure margin, so the
  // club's connected account also pays Stripe's own processing on top. Same
  // noteKey mechanism `orgsRow` already uses, not a second facility.
  it("carries the additive-fee disclosure note on the fees row", () => {
    expect(row("pricing.matrix.fees").noteKey).toBe("pricing.matrix.fees.note");
  });

  // dashboard.player_profiles is a row the Event Pass lifts that /pricing used
  // to omit entirely (classed as vestigial — see the banned-list test below);
  // it is a live gate, so the matrix has to price it. The AI run cap row that
  // used to sit alongside it was retired in v17 Phase 2 Task 5 (V322): the
  // credit wallet meters spend now, not a plan-graded per-division count.
  // BOTH halves of this pair inverted in V393, in opposite directions, and the
  // case is kept rather than deleted because the pair is the story: which of
  // the two adjacent scoring rows a pass buys is exactly what /pricing has to
  // get right. V396 (W2 T15) then inverted profiles BACK — the share loops
  // went paid — so the two rows now read identically and both sell the pass,
  // which is the third state this case has held and the reason it is written
  // as two explicit expectations rather than a shared one.
  it("renders profiles and the career rollup both as pass-lifted", () => {
    // W3-A (2026-09-06): `stats.player` (the per-division record) left the
    // pass-lifted pair here — it is free on every plan now, so the story this
    // case was built to tell moved onto `stats.player.career`, its split-off
    // leverage half. `dashboard.player_profiles` is unchanged.
    expect(cells("pricing.matrix.dashboard.player_profiles")).toMatchObject({
      community: "—",
      event_pass: "✓",
      pro: "✓",
    });
    expect(cells("pricing.matrix.stats.player.career")).toMatchObject({
      community: "—",
      event_pass: "✓",
      pro: "✓",
    });
  });

  // W3-A: the sibling of the case above. `stats.player` (the RECORD) is now
  // included on every plan, community included — the split's whole point.
  it("renders the player-stats record as included on every plan (W3-A)", () => {
    expect(cells("pricing.matrix.stats.player")).toMatchObject({
      community: "✓",
      event_pass: "✓",
      pro: "✓",
    });
  });

  it("never renders domains.custom or any D9 vestigial key", () => {
    // `dashboard.player_profiles` was on this list and is NOT any more. It is
    // not vestigial: server/public-site/data.ts gates the public player card on
    // it, and V308 grants it to the Event Pass — so hiding it from /pricing hid
    // a thing customers pay $29 for. The rest below really are dead keys.
    // V393 added three more to this list by deleting the keys outright:
    // support.priority, officials.per_fixture.max and stats.club_championship
    // (already here). A comparison row for a key with no rows on any plan
    // renders "—" in every column — a paywall tick for something nobody sells.
    const banned = [
      "domains.custom",
      "public_pages",
      "eligibility.enforced",
      "stats.club_championship",
      "support.priority",
      "officials.per_fixture.max",
    ];
    const labelKeys = allRows.map((r) => r.labelKey);
    for (const key of banned) {
      expect(labelKeys.some((lk) => lk.includes(key))).toBe(false);
    }
  });
});

// W3 fix round 2, item 3: "Write API access" is the one row of 56 where every
// purchasable-plan cell reads "—" — the single self-serve-unreachable feature
// (design §4: only `api.write` qualifies). It reads as a flat "no" with no
// hint that anyone can get it. DERIVED from the matrix — a row qualifies when
// every PRICING_PLAN_KEYS plan denies it AND enterprise grants it — never a
// hardcoded "api.write" check, so a key becoming (or ceasing to be)
// enterprise-only later moves the treatment with it automatically.
describe("enterprise-only rows get a routing note, derived from the matrix (W3 fix round 2)", () => {
  it("api.write — denied everywhere purchasable, granted only on enterprise — carries the note", () => {
    const rows = buildPricingSections(DATA).flatMap((s) => s.rows);
    const apiWrite = rows.find((r) => r.labelKey === "pricing.matrix.api.write")!;
    expect(apiWrite, "the row must exist").toBeTruthy();
    // The premise, read from the fixture rather than assumed.
    for (const plan of PRICING_PLAN_KEYS) expect(apiWrite.cells[plan], plan).toBe("—");
    expect(apiWrite.noteKey).toBe("pricing.matrix.enterpriseOnly.note");
  });

  it("does not tag a row enterprise-only just because it is enterprise-only AND some plan also grants it", () => {
    // A row every self-serve plan denies but ALSO enterprise denies is a plain
    // "no", not a routing opportunity — no plan sells it. A row where a
    // purchasable plan already grants it is reachable by buying, so it must
    // not print a Contact-us note either.
    const data: MatrixData = {
      "api.write": {
        community: { bool_value: false, int_value: null },
        // Now Pro grants it too — reachable without Enterprise.
        event_pass: { bool_value: false, int_value: null },
        pro: { bool_value: true, int_value: null },
        enterprise: { bool_value: true, int_value: null },
      },
    };
    const row = buildPricingSections(data)
      .flatMap((s) => s.rows)
      .find((r) => r.labelKey === "pricing.matrix.api.write")!;
    expect(row.noteKey).toBeUndefined();
  });

  it("does not tag a row nobody grants at all — enterprise denies it too", () => {
    const data: MatrixData = {
      "api.write": {
        community: { bool_value: false, int_value: null },
        pro: { bool_value: false, int_value: null },
        enterprise: { bool_value: false, int_value: null },
      },
    };
    const row = buildPricingSections(data)
      .flatMap((s) => s.rows)
      .find((r) => r.labelKey === "pricing.matrix.api.write")!;
    expect(row.noteKey).toBeUndefined();
  });

  it("is exactly one row of the whole table — not a blanket treatment", () => {
    const rows = buildPricingSections(DATA).flatMap((s) => s.rows);
    const noted = rows.filter((r) => r.noteKey === "pricing.matrix.enterpriseOnly.note");
    expect(noted.map((r) => r.labelKey)).toEqual(["pricing.matrix.api.write"]);
  });

  it("leaves the orgs.max_owned and fees rows' own notes untouched", () => {
    const rows = buildPricingSections(DATA).flatMap((s) => s.rows);
    expect(rows.find((r) => r.labelKey === "pricing.matrix.orgs.max_owned")?.noteKey).toBe(
      "pricing.matrix.orgs.max_owned.note",
    );
    expect(rows.find((r) => r.labelKey === "pricing.matrix.fees")?.noteKey).toBe(
      "pricing.matrix.fees.note",
    );
  });
});

// V310 (D18/D19/D20) — the packaging decision itself, asserted against the live
// matrix rather than the fixture above. A fixture can be edited to say anything;
// this is the row that has to exist for /pricing and the resolver to agree.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("V310 packaging: logos + paid entry for everyone", () => {
  const load = async (key: string) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, bool_value, int_value from plan_entitlements where feature_key = ${key}`;
    return (plan: string) => rows.find((r) => r.plan_key === plan);
  };

  it("grants org logos (branding) on every plan, community included", async () => {
    const get = await load("branding");
    for (const plan of ["community", "event_pass", "pro", "enterprise"]) {
      expect(get(plan)?.bool_value, plan).toBe(true);
    }
  });

  it("grants registration.paid on every plan, community included", async () => {
    const get = await load("registration.paid");
    for (const plan of ["community", "event_pass", "pro", "enterprise"]) {
      expect(get(plan)?.bool_value, plan).toBe(true);
    }
  });

  // The community row must EXIST and be > 0. `feePercentFor`
  // (server/usecases/registrations.ts) falls back to platformFeeDefault() when
  // getLimit returns null OR <= 0. Without a real row the pass would discount
  // nothing.
  //
  // WHY EXISTENCE IS ASSERTED DIRECTLY AND NOT VIA THE FALLBACK'S VALUE. This
  // test used to prove the row was there by showing the resolved rate differed
  // from `platformFeeDefault()` — sound while community was 8 and the default
  // was 5. V398 cut community to 5, which is EXACTLY the platform default, so
  // that proof collapsed: delete the community row today and `feePercentFor`
  // still answers 5, from the fallback, and the value-inequality check cannot
  // tell the two apart. Value inequality was only ever a PROXY for existence;
  // `toBeDefined()` on the row itself is the thing we actually mean, and it
  // keeps working whatever the two numbers do next.
  it("ladders registration.fee_percent 5/4/2/1 with an EXPLICIT community row", async () => {
    const get = await load("registration.fee_percent");
    expect(get("community"), "community needs a real row, not the env fallback").toBeDefined();
    expect(get("community")?.int_value).toBe(5);
    expect(get("event_pass")?.int_value).toBe(4);
    expect(get("event_pass_l")?.int_value).toBe(4);
    expect(get("pro")?.int_value).toBe(2);
    // V393 moved the 1% floor from pro_plus onto enterprise. The LADDER is the
    // assertion, not the plan name: each step must be strictly cheaper than
    // the one before, or a customer pays more for buying more.
    expect(get("enterprise")?.int_value).toBe(1);
    expect(get("community")!.int_value!).toBeGreaterThan(0);
  });

  // Deliberate: logos are table stakes, removing OUR badge is not. V396 (W2
  // T15, owner ruling 2026-09-03) moved it off Pro as well — the badge is
  // shown on every self-serve plan now, so this is an enterprise-only row and
  // no longer the Pro differentiator D7 called it.
  it("leaves dashboard.branding denied to every self-serve plan — enterprise only", async () => {
    const get = await load("dashboard.branding");
    expect(get("community")?.bool_value).toBe(false);
    expect(get("event_pass")?.bool_value).toBe(false);
    expect(get("event_pass_l")?.bool_value).toBe(false);
    expect(get("pro")?.bool_value).toBe(false);
    expect(get("enterprise")?.bool_value).toBe(true);
  });

  // Consequence the guard depends on: branding and registration.paid must stop
  // being "lifted by the pass" (community now equals event_pass), while
  // fee_percent stays lifted at 8 vs 5.
  it("drops branding + registration.paid from the pass-lifted set, keeps fee_percent", async () => {
    const lifted = await sql<{ feature_key: string }[]>`
      select ep.feature_key
      from plan_entitlements ep
      left join plan_entitlements c
        on c.plan_key = 'community' and c.feature_key = ep.feature_key
      where ep.plan_key = 'event_pass'
        and (ep.bool_value is distinct from c.bool_value
             or ep.int_value is distinct from c.int_value)`;
    const keys = lifted.map((r) => r.feature_key);
    expect(keys).not.toContain("branding");
    expect(keys).not.toContain("registration.paid");
    expect(keys).toContain("registration.fee_percent");
  });
});

// The scale ladder, asserted against the LIVE matrix rather than the fixture
// above, because a fixture can be edited to say anything and the resolver
// reads the table. V319 raised the free tier to 64 entrants / 10 competitions;
// V393 (R6) took the competition cap back to 3 while LEAVING the entrant cap
// at 64 — the free tier still runs big per competition, it just runs fewer of
// them. That split is the packaging decision and is what these cases pin.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("scale caps: community 64 entrants, 3 competitions (V319 + V393)", () => {
  const load = async (key: string) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, bool_value, int_value from plan_entitlements where feature_key = ${key}`;
    return (plan: string) => rows.find((r) => r.plan_key === plan);
  };

  it("ladders entrants.per_division.max 64 / 128 / 256 / 512 / ∞", async () => {
    const get = await load("entrants.per_division.max");
    expect(get("community")?.int_value).toBe(64);
    // The pass MUST rise above community. With community at 64 a pass stuck on
    // 64 would lift nothing — the key would drop out of the pass-lifted set and
    // the pass purchase would buy no extra entrants at all.
    expect(get("event_pass")?.int_value).toBe(128);
    expect(get("pro")?.int_value).toBe(256);
    // V393: L is a FINITE 512, not the old ∞. It is the one place a pass rung
    // legitimately outruns Pro, and the number the pass ladder copy has to
    // stop calling "unlimited".
    expect(get("event_pass_l")?.int_value).toBe(512);
    expect(get("enterprise"), "enterprise must keep a row").toBeDefined();
    expect(get("enterprise")?.int_value, "null int_value is unlimited").toBeNull();
  });

  it("keeps entrants.per_division.max in the pass-lifted set (64 vs 128)", async () => {
    const get = await load("entrants.per_division.max");
    expect(get("event_pass")?.int_value).not.toBe(get("community")?.int_value);
  });

  it("lowers community competitions.max_active to 3; pro/enterprise stay unlimited", async () => {
    const get = await load("competitions.max_active");
    // V393 R6: 10 -> 3. The row must EXIST and be finite — a deleted row
    // resolves to 0 (`const base = row ? row.int_value : 0`), which would bar
    // a free org from running any competition at all rather than three.
    expect(get("community"), "community must keep a row — a missing one denies, it does not free").toBeDefined();
    expect(get("community")?.int_value).toBe(3);
    expect(get("pro"), "pro must keep a row").toBeDefined();
    expect(get("pro")?.int_value, "Pro's headline is \"unlimited competitions\"").toBeNull();
    expect(get("enterprise"), "enterprise must keep a row").toBeDefined();
    expect(get("enterprise")?.int_value).toBeNull();
  });

  it("raises community divisions.per_competition.max to 4", async () => {
    const get = await load("divisions.per_competition.max");
    expect(get("community")?.int_value).toBe(4);
  });

  // Deliberate absence, not an oversight. A passed competition is already
  // excluded from the active count (server/usecases/competitions.ts) — that is
  // the mechanism. An event_pass row here would additionally raise the ORG-WIDE
  // cap for any org holding one pass, which is not what the pass sells.
  it("adds no event_pass row for competitions.max_active", async () => {
    const get = await load("competitions.max_active");
    expect(get("event_pass")).toBeUndefined();
  });
});

// V341 (v17 #294) — the L rung, now HIDDEN (owner decision 2026-09-05). This
// describe used to prove /pricing rendered a column for it. It has been split
// along the line the decision draws, because the two halves are different kinds
// of claim and only one of them changed:
//
//   • the TABLE is a shipped selling surface, so it stops expecting L;
//   • the MATRIX is the seed, so it keeps validating L exactly as before. The
//     rung is dormant, not deleted, and a dormant rung whose numbers nobody
//     checks any more is a rung that cannot be put back on sale safely.
//
// Built by replaying the exact read `pricing/page.tsx` performs, so a plan key
// dropped from PRICING_PLAN_KEYS takes this test down with the page.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("the hidden L rung: out of the table, intact in the matrix", () => {
  const liveRows = async () => {
    const rows = await sql<
      { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`
      select plan_key, feature_key, bool_value, int_value
      from plan_entitlements where plan_key = any(${[...PRICING_PLAN_KEYS]})`;
    const data: MatrixData = {};
    for (const r of rows) {
      (data[r.feature_key] ??= {})[r.plan_key] = {
        bool_value: r.bool_value,
        int_value: r.int_value,
      };
    }
    return buildPricingSections(data).flatMap((s) => s.rows);
  };

  it("does not even SELECT the hidden rung — no column can render without the row", async () => {
    expect([...PRICING_PLAN_KEYS]).not.toContain("event_pass_l");
    // Enumerated from the rendered rows, not inferred: every row's cell set is
    // the column set, so a stray column would show up here whatever the tuple
    // said.
    const rows = await liveRows();
    expect(rows.length, "no rows rendered — the check below proves nothing").toBeGreaterThan(5);
    for (const r of rows) {
      expect(Object.keys(r.cells).sort().join(","), r.labelKey).toBe(
        [...PRICING_PLAN_KEYS].sort().join(","),
      );
    }
  });

  it("still renders M's own caps — the offer that IS on sale", async () => {
    const rows = await liveRows();
    const cells = (k: string) => rows.find((r) => r.labelKey === k)!.cells;
    expect(cells("pricing.matrix.divisions.per_competition.max").event_pass).toBe("10");
    expect(cells("pricing.matrix.entrants.per_division.max").event_pass).toBe("128");
  });

  // THE DORMANCY GUARD, moved off the rendered table and onto the matrix.
  //
  // The two failure modes it has always caught, unchanged:
  //   • L's rows fall back to M's values (the pre-#294 shape) -> the list comes
  //     back EMPTY and the assertion prints the two keys it expected;
  //   • L falls through to COMMUNITY on keys M lifts -> extra rows join the
  //     list and it prints exactly which ones.
  // Compared as a joined STRING because the JSON reporter elides array
  // elements and would name neither side.
  //
  // Read straight from `plan_entitlements` now, because the rung has no
  // rendered cells to compare. That is the point: hiding the rung must not
  // stop anyone checking that its matrix is still coherent, or the day it goes
  // back on sale it sells whatever the last unrelated migration left behind.
  // V426 (owner ruling 2026-09-29, Streaming R1 Task 14b) adds a THIRD deliberate divergence:
  // `streaming.credits.monthly` — the passes' one-off match credits, event_pass 1 · event_pass_l 5.
  it("keeps L's matrix differing from M on exactly the keys V341 and V426 override", async () => {
    const rows = await sql<
      { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`
      select plan_key, feature_key, bool_value, int_value
      from plan_entitlements where plan_key in ('event_pass', 'event_pass_l')`;
    const by = (plan: string) =>
      new Map(rows.filter((r) => r.plan_key === plan).map((r) => [r.feature_key, r]));
    const m = by("event_pass");
    const l = by("event_pass_l");
    expect(m.size, "no M rows — the diff below proves nothing").toBeGreaterThan(5);
    expect(l.size, "no L rows — the rung has lost its matrix").toBeGreaterThan(5);
    const differing = [...new Set([...m.keys(), ...l.keys()])]
      .filter((key) => {
        const a = m.get(key);
        const b = l.get(key);
        return (
          a?.bool_value !== b?.bool_value ||
          a?.int_value !== b?.int_value ||
          !a !== !b
        );
      })
      .sort()
      .join(", ");
    expect(differing).toBe(
      "divisions.per_competition.max, entrants.per_division.max, streaming.credits.monthly",
    );
  });
});

// FIXTURE_MIRRORS_THE_LIVE_MATRIX — the guard that was missing.
//
// `DATA` at the top of this file has always claimed to "mirror the real
// local-DB values", and for three migrations that claim was only a comment.
// V393 moved thirteen of its cells; every renderer case above stayed GREEN
// while asserting a matrix that no longer existed, because a fixture is
// perfectly consistent with itself. The renderer tests are still worth having
// as pure tests (they run without a DB, and they test formatting rather than
// data) — they are only worth having if the fixture is true.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("the fixture above still mirrors the live matrix", () => {
  it("matches plan_entitlements cell for cell, absences included", async () => {
    const keys = Object.keys(DATA);
    // Anti-vacuity: an empty DATA (or an empty query result) satisfies a
    // cell-by-cell comparison trivially.
    expect(keys.length, "DATA is empty \u2014 the comparison below proves nothing").toBeGreaterThan(10);

    const rows = await sql<
      { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`select plan_key, feature_key, bool_value, int_value from plan_entitlements`;
    expect(rows.length, "plan_entitlements is empty").toBeGreaterThan(100);

    const live = new Map<string, { bool_value: boolean | null; int_value: number | null }>();
    for (const r of rows) live.set(`${r.feature_key} ${r.plan_key}`, r);

    const drift: string[] = [];
    for (const key of keys) {
      for (const plan of PRICING_PLAN_KEYS) {
        const fixture = DATA[key]![plan];
        const db = live.get(`${key} ${plan}`);
        // An ABSENT row is a value: the resolver reads no-row as 0 for an int
        // and as denied for a bool, and the pricing pivot falls a pass column
        // through to community. So absence is compared, not skipped \u2014 that is
        // what catches a pass row appearing or disappearing under the fixture,
        // which is exactly what V393 did to schedule.checkpoints.max and
        // teams.squad_max in opposite directions.
        if (!fixture && !db) continue;
        if (!fixture || !db) {
          drift.push(`${key}/${plan}: fixture ${fixture ? "has" : "has NO"} cell, db ${db ? "has" : "has NO"} row`);
          continue;
        }
        if (fixture.int_value !== db.int_value) {
          drift.push(`${key}/${plan}: fixture int=${fixture.int_value}, db int=${db.int_value}`);
        }
        if (fixture.bool_value !== db.bool_value) {
          drift.push(`${key}/${plan}: fixture bool=${fixture.bool_value}, db bool=${db.bool_value}`);
        }
      }
    }
    expect(drift, `the DATA fixture has drifted from plan_entitlements:\n${drift.join("\n")}`).toEqual([]);
  });
});
