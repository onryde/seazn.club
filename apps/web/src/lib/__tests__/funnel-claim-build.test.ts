// The emailed claim builds what the organiser chose on /start (start-wizard redesign, plan 2026-11-13 Task 2): the format
// card they picked as its stage graph, the field they sized as name-only entrants seeded 1..N, and — when they opened
// Planning — one venue with that many courts. Before this the claim built a bare division for every format (P1, measured).
//
// Driven through the REAL claim path: createFunnelDraft → consumeFunnelDraft → createFromDraft, read back from the tables.
// Expected values never come from the claim: the stage kinds are the rulebook's (typed below), the template key is
// detectTemplate's reading of the rows, each stage is the one the format cards counted (lib/funnel-formats.ts — the card
// and the built event must not disagree), the entrant kind is the engine's declaration for the variant, every name is the
// dictionary file on disk, and the cap is the live plan resolver's.
// Real Postgres required — skipped without DATABASE_URL (test-infra recipe).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { getLimit } from "@/lib/entitlements";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { consumeFunnelDraft, createFromDraft, createFunnelDraft, funnelEntrantCap, type FunnelPayload } from "@/lib/funnel";
import { FUNNEL_FORMATS, FUNNEL_MORE_FORMATS, funnelFormatMin, funnelFormatStages, type FunnelFormat } from "@/lib/funnel-formats";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import { detectTemplate, type StageDraft } from "@/lib/format-templates";
import { swissRoundsGuidance } from "@/lib/swiss-rounds";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { generateStageFixturesUnpublished } from "@/server/usecases/stages";
import { archiveVenue, createCourt, createVenue } from "@/server/usecases/venues";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fcb-${randomUUID().slice(0, 8)}`;

const ALL_FORMATS: readonly FunnelFormat[] = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];

/** The rulebook: the stages each format card stands for, in play order. */
const RULEBOOK_KINDS: Record<FunnelFormat, string[]> = {
  league: ["league"],
  "groups-knockout": ["group", "knockout"],
  knockout: ["knockout"],
  swiss: ["swiss"],
  double_elim: ["double_elim"],
};
/** The one-click template each format is (format-templates.ts STAGE_TEMPLATES), as detectTemplate names a stored graph. */
const TEMPLATE_OF: Record<FunnelFormat, string> = {
  league: "league",
  "groups-knockout": "groups_ko",
  knockout: "knockout",
  swiss: "swiss",
  double_elim: "double_elim",
};
const NAME_KEY: Record<EntrantKind, string> = {
  individual: "funnel.claim.entrant.individual",
  pair: "funnel.claim.entrant.pair",
  team: "funnel.claim.entrant.team",
};

// ── Dictionaries, read off disk ────────────────────────────────────────────────────────────────────────────────────────
const uiDicts = new Map<Locale, Record<string, string>>();
function ui(locale: Locale, key: string, n?: number): string {
  let d = uiDicts.get(locale);
  if (!d) {
    d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
    uiDicts.set(locale, d);
  }
  const s = d[key];
  if (typeof s !== "string") throw new Error(`${locale}/ui.json has no ${key}`);
  return n === undefined ? s : s.replaceAll("{n}", String(n));
}

// ── The claim path and its read-backs ──────────────────────────────────────────────────────────────────────────────────
const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@example.com`;

async function seedUser(email: string = address()): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Funnel Claimant', true) returning id`;
  return u!.id;
}

interface Claimed {
  userId: string;
  orgId: string;
  competitionId: string;
  divisionId: string;
  token: string;
}

/** Start a draft as /api/funnel/start writes it, consume its token as the claim page does, and build it. */
async function claim(
  over: Partial<FunnelPayload> & { entrants: number },
  opts: { userId?: string; email?: string; locale?: Locale | null } = {},
): Promise<Claimed> {
  const email = opts.email ?? address();
  const userId = opts.userId ?? (await seedUser(email));
  const payload = { name: `${RUN} ${randomUUID().slice(0, 6)}`, sport: "Badminton", ...over } as FunnelPayload;
  const { token } = await createFunnelDraft(email, payload, sql, opts.locale ?? null);
  const draft = await consumeFunnelDraft(token);
  expect(draft, "the draft is claimable").not.toBeNull();
  const { orgId } = await createFromDraft(userId, draft!);
  const rows = await sql<{ competition_id: string; division_id: string }[]>`
    select c.id as competition_id, d.id as division_id
      from competitions c join divisions d on d.competition_id = c.id
     where c.org_id = ${orgId} and c.name = ${payload.name}`;
  expect(rows, "one competition with one division").toHaveLength(1);
  return { userId, orgId, competitionId: rows[0]!.competition_id, divisionId: rows[0]!.division_id, token };
}

type StoredStage = { id: string; seq: number; kind: string; name: string; config: Record<string, unknown>; progression: StageDraft["progression"] };
const stagesOf = (divisionId: string) =>
  sql<StoredStage[]>`select id, seq, kind, name, config, progression from stages where division_id = ${divisionId} order by seq`;
const entrantsOf = (divisionId: string) =>
  sql<{ id: string; kind: string; display_name: string; seed: number | null; members: number }[]>`
    select e.id, e.kind, e.display_name, e.seed,
           (select count(*)::int from entrant_members m where m.entrant_id = e.id) as members
      from entrants e where e.division_id = ${divisionId}
     order by e.seed nulls last, e.created_at, e.id`;
const venuesOf = (orgId: string) =>
  sql<{ id: string; name: string }[]>`select id, name from venues where org_id = ${orgId} and archived_at is null order by sort, name`;
const courtsOf = (orgId: string) =>
  sql<{ venue_id: string; name: string; sort: number }[]>`
    select c.venue_id, c.name, c.sort from courts c join venues v on v.id = c.venue_id
     where c.org_id = ${orgId} and c.archived_at is null and v.archived_at is null
     order by c.sort, c.name`;
const divisionNameOf = async (divisionId: string): Promise<string> => {
  const [d] = await sql<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
  return d!.name;
};
const courtHoursOf = async (orgId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from court_hours where org_id = ${orgId}`;
  return n;
};
const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
/** The division's name as the dictionary words it: the sport's own name, or — for Other, which builds the generic module
 *  and names no sport — the claim's word for "other", not the module's "Generic". */
const divisionNameFor = (locale: Locale, moduleKey: string): string =>
  moduleKey === "generic" ? ui(locale, "funnel.claim.division.other") : ui(locale, `sport.${moduleKey}`);

/** The kind a new division of this funnel sport defaults to: the engine module's declaration, laid over by the variant the
 *  claim builds (createDivision seeds the division's config from it). Other builds the generic module. */
function engineDefaultKind(moduleKey: string, variantKey: string): EntrantKind {
  const mod = builtinModules.find((m) => m.key === moduleKey);
  if (!mod) throw new Error(`premise: the engine registers ${moduleKey}`);
  const variants = (mod.variants ?? {}) as Record<string, unknown>;
  expect(variants[variantKey], `premise: ${moduleKey} declares ${variantKey}`).toBeDefined();
  return effectiveEntrantModel(mod.entrantModel ?? null, variants[variantKey]).defaultKind;
}

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from funnel_drafts where email like ${`${RUN}-%`}`;
  await sql`delete from org_entitlement_overrides where reason like ${`${RUN} %`}`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the claim builds the chosen format, its entrants and its courts (start wizard T2)", () => {
  it("every funnel sport × every format builds the stage graph its card counted, and the graph draws the seeded field", async () => {
    // Every sport: a stage write is sport-specific (the sport's stage tables, the kinds a sport refuses), so is its Generate.
    const n = 12;
    let checked = 0;
    const pairs = FUNNEL_SPORTS.flatMap((sport) => ALL_FORMATS.map((format) => [sport, format] as const));
    for (const [sport, format] of pairs) {
      const label = `${sport.key} ${format}`;
      const c = await claim({ sport: sport.name, entrants: n, format });
      const stored = await stagesOf(c.divisionId);
      expect(stored.map((s) => s.kind), label).toEqual(RULEBOOK_KINDS[format]);
      expect(stored.map((s) => s.seq), `${label}: seq 1..`).toEqual(seeds(stored.length));
      expect(detectTemplate(stored), label).toBe(TEMPLATE_OF[format]);
      // The card's own graph (preview = build): every stage's kind, name, progression and each knob it was drafted with.
      const drafted = funnelFormatStages(format, n);
      expect(stored, `${label}: as many stages as the card counted`).toHaveLength(drafted.length);
      for (const [i, d] of drafted.entries()) {
        const s = stored[i]!;
        expect({ kind: s.kind, name: s.name, progression: s.progression }, `${label} stage ${i + 1}`).toEqual({
          kind: d.kind,
          name: d.name,
          progression: d.progression,
        });
        for (const [k, v] of Object.entries(d.config)) expect(s.config[k], `${label} stage ${i + 1} config.${k}`).toEqual(v);
      }
      if (format === "swiss") {
        expect(stored[0]!.config.rounds, "the Swiss plays the house's recommendation for the field").toBe(swissRoundsGuidance(n).recommended);
      }

      // And the consumer: the organiser's Generate draws every seeded entrant into the first stage.
      const entrants = await entrantsOf(c.divisionId);
      expect(entrants).toHaveLength(n);
      const auth: AuthCtx = { orgId: c.orgId, via: "session", userId: c.userId, role: "owner", keyId: null };
      const outcome = await generateStageFixturesUnpublished(auth, stored[0]!.id);
      expect(outcome.created, `${label}: Generate created fixtures`).toBeGreaterThan(0);
      // A Swiss's first Generate lays every round's empty lines; the next one (Pair next) seats round 1.
      if (format === "swiss") await generateStageFixturesUnpublished(auth, stored[0]!.id);
      const lines = await sql<{ home: string | null; away: string | null }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stored[0]!.id}`;
      const drawn = new Set(lines.flatMap((f) => [f.home, f.away]).filter((x): x is string => !!x));
      expect([...drawn].sort(), `${label}: every seeded entrant is drawn`).toEqual(entrants.map((e) => e.id).sort());
      checked++;
    }
    expect(checked, "anti-vacuity: every funnel sport × every funnel format was claimed").toBe(FUNNEL_SPORTS.length * ALL_FORMATS.length);
  });

  it("entrants: n seeded name-only rows of the sport's default kind, every funnel sport", async () => {
    const n = 6;
    const kinds = new Set<string>();
    let checked = 0;
    for (const s of FUNNEL_SPORTS) {
      const c = await claim({ sport: s.name, entrants: n, format: "league" });
      const want = engineDefaultKind(s.module, s.variant);
      const rows = await entrantsOf(c.divisionId);
      expect(rows.map((r) => r.seed), `${s.key}: seeds 1..${n}`).toEqual(seeds(n));
      expect(new Set(rows.map((r) => r.kind)), `${s.key}: the ${want} the engine declares`).toEqual(new Set([want]));
      expect(rows.map((r) => r.members), `${s.key}: name-only`).toEqual(rows.map(() => 0));
      expect(rows.map((r) => r.display_name), s.key).toEqual(seeds(n).map((i) => ui("en", NAME_KEY[want], i)));
      expect(await divisionNameOf(c.divisionId), `${s.key}: the division is named as the dictionary names its sport`).toBe(
        divisionNameFor("en", s.module),
      );
      kinds.add(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every funnel sport was claimed").toBe(FUNNEL_SPORTS.length);
    expect(kinds.size, "premise: the sweep holds more than one kind, so a kind written blind would red").toBeGreaterThan(1);
  });

  it("placeholder names, the venue and its courts follow the draft's language", async () => {
    // An individual sport and a team sport in every language: both name keys are read per locale.
    // Other too: it names no sport, so its division takes the funnel's own word for it, never the module's "Generic".
    const sports = ["badminton", "football", "other"].map((k) => FUNNEL_SPORTS.find((s) => s.key === k)!);
    const n = 3;
    let checked = 0;
    for (const locale of LOCALES) {
      for (const s of sports) {
        const c = await claim({ sport: s.name, entrants: n, format: "league", courts: 2 }, { locale });
        const kind = engineDefaultKind(s.module, s.variant);
        expect((await entrantsOf(c.divisionId)).map((e) => e.display_name), `${locale} ${s.key}`).toEqual(
          seeds(n).map((i) => ui(locale, NAME_KEY[kind], i)),
        );
        expect(await divisionNameOf(c.divisionId), `${locale} ${s.key}: the division`).toBe(divisionNameFor(locale, s.module));
        expect((await venuesOf(c.orgId)).map((v) => v.name), `${locale}: the venue`).toEqual([ui(locale, "funnel.claim.venue")]);
        expect((await courtsOf(c.orgId)).map((x) => x.name), `${locale}: the courts`).toEqual([1, 2].map((i) => ui(locale, "funnel.claim.court", i)));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every language × each sport").toBe(LOCALES.length * sports.length);
    // Other's word is not the module's "Generic" in any language, and each language words it its own way.
    for (const l of LOCALES) {
      expect(ui(l, "funnel.claim.division.other"), `premise: ${l} words Other apart from Generic`).not.toBe(ui(l, "sport.generic"));
    }
    expect(new Set(LOCALES.map((l) => ui(l, "funnel.claim.division.other"))).size, "premise: every language words Other its own way").toBe(
      LOCALES.length,
    );
    // Each language can be told from the fallback only while the dictionaries differ.
    expect(new Set(LOCALES.map((l) => ui(l, NAME_KEY.individual))).size, "premise: every language names a player its own way").toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => ui(l, "sport.football"))).size, "premise: the languages name football differently").toBeGreaterThan(1);

    // A draft started with no language falls to English.
    const none = await claim({ entrants: 2, format: "league" }, { locale: null });
    expect((await entrantsOf(none.divisionId)).map((e) => e.display_name)).toEqual([1, 2].map((i) => ui("en", NAME_KEY.individual, i)));
  });

  it("at the plan cap seeds every entrant; above it seeds the cap and builds the graph for the cap, not the ask", async () => {
    // A fresh organisation on the free plan: the cap is the live resolver's, never a literal.
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `${RUN} capped`);
    const cap = await getLimit(org.id, "entrants.per_division.max");
    expect(cap, "premise: the free plan caps a division's entrants").not.toBeNull();
    expect(cap!, "premise: the cap sits inside the funnel's 2..256, so the funnel can ask past it").toBeLessThan(256);
    expect(cap!, "premise: the cap can hold a Swiss").toBeGreaterThanOrEqual(funnelFormatMin("swiss"));
    expect(await funnelEntrantCap(), "the number /start quotes is the number the claim seeds").toBe(cap);
    // The Swiss round count moves with the field here, so a graph built for the ask would carry a different count.
    expect(swissRoundsGuidance(cap! + 1).recommended, "premise: cap and cap + 1 play different Swiss round counts").not.toBe(
      swissRoundsGuidance(cap!).recommended,
    );
    const info = vi.spyOn(log, "info");
    const clamped = () => info.mock.calls.filter((call) => call[1] === "funnel_claim_entrants_clamped");

    const at = await claim({ entrants: cap!, format: "swiss" }, { userId });
    expect((await entrantsOf(at.divisionId)).map((e) => e.seed), "at the cap: everyone").toEqual(seeds(cap!));
    expect(clamped(), "at the cap: nothing was clamped").toHaveLength(0);

    const above = await claim({ entrants: cap! + 1, format: "swiss" }, { userId });
    const rows = await entrantsOf(above.divisionId);
    expect(rows.map((e) => e.seed), "above the cap: the cap, seeded 1..cap").toEqual(seeds(cap!));
    const [swiss] = await stagesOf(above.divisionId);
    expect(swiss?.config.rounds, "the graph is built for the field it holds").toBe(swissRoundsGuidance(cap!).recommended);
    expect(clamped(), "the clamp is logged once").toHaveLength(1);
    expect(clamped()[0]![0]).toMatchObject({ requested: cap! + 1, cap });
  });

  it("the organisation's own cap decides: unlimited seeds every entrant; a cap of one seeds one and no stage; none seeds nothing", async () => {
    // A staff override on the claiming organisation (org_entitlement_overrides: null = unlimited), so the cap the claim
    // reads is this organisation's, not the free plan's quoted on /start.
    const freeCap = await funnelEntrantCap();
    expect(freeCap, "premise: the free plan has a cap to go past").not.toBeNull();
    const cases = [
      { label: "unlimited", override: null, ask: freeCap! + 6, entrants: freeCap! + 6, stages: RULEBOOK_KINDS.league },
      { label: "a cap of one", override: 1, ask: 4, entrants: 1, stages: [] as string[] },
      { label: "a cap of none", override: 0, ask: 4, entrants: 0, stages: [] as string[] },
    ];
    let checked = 0;
    for (const k of cases) {
      const userId = await seedUser();
      const org = await createOrgForUser(userId, `${RUN} ${k.label}`);
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
        values (${org.id}, 'entrants.per_division.max', ${k.override}, ${`${RUN} funnel claim cap`})`;
      expect(await getLimit(org.id, "entrants.per_division.max"), `${k.label}: the resolver reads the override`).toBe(k.override);
      const c = await claim({ entrants: k.ask, format: "league" }, { userId });
      expect((await entrantsOf(c.divisionId)).map((e) => e.seed), k.label).toEqual(seeds(k.entrants));
      expect((await stagesOf(c.divisionId)).map((s) => s.kind), k.label).toEqual(k.stages);
      checked++;
    }
    expect(checked, "anti-vacuity: every cap was driven").toBe(cases.length);
  });

  it("below a format's minimum builds no stage, and at it builds one; the entrants are seeded either way", async () => {
    let checked = 0;
    for (const format of ALL_FORMATS) {
      const min = funnelFormatMin(format);
      if (min <= 2) continue; // the funnel's own floor is 2: no field below it reaches the claim
      const below = await claim({ entrants: min - 1, format });
      expect(await stagesOf(below.divisionId), `${format} at ${min - 1}`).toEqual([]);
      expect((await entrantsOf(below.divisionId)).map((e) => e.seed), `${format} at ${min - 1}`).toEqual(seeds(min - 1));
      const at = await claim({ entrants: min, format });
      expect((await stagesOf(at.divisionId)).map((s) => s.kind), `${format} at ${min}`).toEqual(RULEBOOK_KINDS[format]);
      checked++;
    }
    expect(checked, "anti-vacuity: a format with a minimum above the funnel's floor was driven").toBeGreaterThan(0);
  });

  it("no format, or one the funnel does not offer, builds no stage; the entrants are seeded (old drafts keep claiming)", async () => {
    const n = 5;
    const cases: { label: string; format?: string }[] = [
      { label: "absent" },
      { label: "unknown", format: "round_robin_xl" },
      { label: "a stage kind the funnel does not offer", format: "ladder" },
    ];
    let checked = 0;
    for (const c of cases) {
      const built = await claim({ entrants: n, ...(c.format === undefined ? {} : { format: c.format }) });
      expect(await stagesOf(built.divisionId), c.label).toEqual([]);
      expect((await entrantsOf(built.divisionId)).map((e) => e.seed), c.label).toEqual(seeds(n));
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("planning courts build one venue with N courts, in court order; the hours write nothing", async () => {
    // Twelve courts as well as three: past nine, name order ("Court 10" before "Court 2") is not court order.
    let checked = 0;
    for (const n of [3, 12]) {
      const c = await claim({ entrants: 8, format: "knockout", courts: n, hours: 5 });
      const venues = await venuesOf(c.orgId);
      expect(venues.map((v) => v.name), `${n} courts`).toEqual([ui("en", "funnel.claim.venue")]);
      const courts = await courtsOf(c.orgId);
      expect(courts.map((x) => x.name), `${n} courts`).toEqual(seeds(n).map((i) => ui("en", "funnel.claim.court", i)));
      expect(courts.map((x) => x.sort), `${n} courts: sorted as numbered`).toEqual(seeds(n).map((i) => i - 1));
      expect(new Set(courts.map((x) => x.venue_id)), "every court is the one venue's").toEqual(new Set([venues[0]!.id]));
      expect(await courtHoursOf(c.orgId), "no court hours: the funnel's hours are a duration, not a clock window").toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
    expect(ui("en", "funnel.claim.court", 10) < ui("en", "funnel.claim.court", 2), "premise: by name, court 10 sorts before court 2").toBe(true);
  });

  it("an organisation whose only venue is archived gets a new active venue with the courts", async () => {
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `${RUN} archived venue`);
    const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: "owner", keyId: null };
    const old = await createVenue(auth, { name: `${RUN} old hall`, sort: 0 });
    await createCourt(auth, old.id, { name: "Old court", sort: 0, tags: [] });
    await archiveVenue(auth, old.id);
    expect(await venuesOf(org.id), "premise: no active venue").toEqual([]);

    const c = await claim({ entrants: 4, format: "league", courts: 2 }, { userId });
    expect(c.orgId).toBe(org.id);
    const venues = await venuesOf(org.id);
    expect(venues.map((v) => v.name)).toEqual([ui("en", "funnel.claim.venue")]);
    const courts = await courtsOf(org.id);
    expect(courts.map((x) => [x.venue_id, x.name])).toEqual([1, 2].map((i) => [venues[0]!.id, ui("en", "funnel.claim.court", i)]));
    const [{ archived }] = await sql<{ archived: number }[]>`
      select count(*)::int as archived from venues where org_id = ${org.id} and archived_at is not null`;
    expect(archived, "the archived venue stays archived").toBe(1);
  });

  it("no planning inputs build no venue — nor do hours without courts", async () => {
    const cases: { label: string; over: Partial<FunnelPayload> }[] = [
      { label: "neither", over: {} },
      { label: "hours only", over: { hours: 5 } as Partial<FunnelPayload> },
    ];
    let checked = 0;
    for (const k of cases) {
      const c = await claim({ entrants: 4, format: "league", ...k.over });
      expect(await venuesOf(c.orgId), k.label).toEqual([]);
      expect(await courtsOf(c.orgId), k.label).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("sequence: a second claim on the same organisation keeps its venue, builds its own division, and a used token stays used", async () => {
    const email = address();
    const userId = await seedUser(email);
    const first = await claim({ entrants: 4, format: "league", courts: 2 }, { email, userId });
    const second = await claim({ entrants: 8, format: "knockout", courts: 4 }, { email, userId });
    expect(second.orgId, "the same organisation (org-if-none)").toBe(first.orgId);

    const venues = await venuesOf(first.orgId);
    expect(venues, "still one venue").toHaveLength(1);
    expect((await courtsOf(first.orgId)).map((x) => x.name), "still the first claim's courts").toEqual(
      [1, 2].map((i) => ui("en", "funnel.claim.court", i)),
    );

    expect(second.divisionId).not.toBe(first.divisionId);
    expect((await stagesOf(first.divisionId)).map((s) => s.kind)).toEqual(RULEBOOK_KINDS.league);
    expect((await stagesOf(second.divisionId)).map((s) => s.kind)).toEqual(RULEBOOK_KINDS.knockout);
    expect((await entrantsOf(first.divisionId)).map((e) => e.seed)).toEqual(seeds(4));
    expect((await entrantsOf(second.divisionId)).map((e) => e.seed)).toEqual(seeds(8));

    expect(await consumeFunnelDraft(first.token), "the first link is spent").toBeNull();
  });

  it("a date sets ends_on to the same day; no date leaves both empty", async () => {
    const day = "2026-12-05";
    const cases = [
      { label: "dated", over: { start_date: day }, starts: day, ends: day },
      { label: "undated", over: {}, starts: null, ends: null },
    ];
    let checked = 0;
    for (const k of cases) {
      const c = await claim({ entrants: 4, format: "league", ...k.over });
      const [row] = await sql<{ starts_on: string | null; ends_on: string | null }[]>`
        select starts_on::text, ends_on::text from competitions where id = ${c.competitionId}`;
      expect(row, k.label).toEqual({ starts_on: k.starts, ends_on: k.ends });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});
