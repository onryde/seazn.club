// The getting-started read (/start "Sent stepper" wave T1, owner-approved 2026-11-14): for one competition, has the organiser
// renamed the organisation the claim named, how many entrants against the field they chose, have fixtures been generated, is
// one on the schedule. The stepper (T2) words it; this pins what it reads.
//
// Driven through the REAL producers: the funnel's own draft → consume → claim (lib/funnel.ts), then the organiser's own
// use-cases (createEntrants, withdrawEntrantCascade, Generate). Expected values never come from the read: the target is the size
// the test chose (held to the live plan resolver's cap), the default organisation name is the dictionary on disk, counts are the
// test's own arithmetic. Sequences: a second call after each step, a withdrawal and a disqualification, the empty competition,
// another language, another organisation, and every funnel sport.
// Real Postgres required — skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Pass-through spies (every call runs the real code): the landing's read (`funnelGettingStarted`) is counted, so its early
// return for a competition no /start draft built is witnessed doing no tenant read, no plan read and no dictionary work.
const spied = vi.hoisted(() => ({ withTenant: 0, getDictionary: 0, getLimit: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, withTenant: ((...a: Parameters<typeof real.withTenant>) => (spied.withTenant++, real.withTenant(...a))) as typeof real.withTenant };
});
vi.mock("@/lib/i18n", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/i18n")>();
  return { ...real, getDictionary: ((...a: Parameters<typeof real.getDictionary>) => (spied.getDictionary++, real.getDictionary(...a))) as typeof real.getDictionary };
});
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/entitlements")>();
  return { ...real, getLimit: ((...a: Parameters<typeof real.getLimit>) => (spied.getLimit++, real.getLimit(...a))) as typeof real.getLimit };
});
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { consumeFunnelDraft, createFromDraft, createFunnelDraft, type FunnelPayload } from "@/lib/funnel";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { archiveDivision, restoreDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { funnelGettingStarted, gettingStarted } from "@/server/usecases/getting-started";
import { generateStageFixturesUnpublished } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import type { CreateCompetition } from "@/server/api-v1/schemas";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `gs-${randomUUID().slice(0, 8)}`;
const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@example.com`;

const uiDicts = new Map<Locale, Record<string, string>>();
function ui(locale: Locale, key: string): string {
  let d = uiDicts.get(locale);
  if (!d) {
    d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
    uiDicts.set(locale, d);
  }
  const s = d[key];
  if (typeof s !== "string") throw new Error(`${locale}/ui.json has no ${key}`);
  return s;
}
/** The organisation name the claim gives, as the dictionary words it. */
const defaultOrgName = (locale: Locale, eventName: string): string => ui(locale, "funnel.claim.orgName").replaceAll("{name}", eventName);

async function seedUser(email: string = address()): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Getting Started', true) returning id`;
  return u!.id;
}

interface Claimed {
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  name: string;
}
/** The funnel path, start to claim, as the emailed link runs it. */
async function claim(over: Partial<FunnelPayload> & { entrants: number }, opts: { userId?: string; locale?: Locale | null } = {}): Promise<Claimed> {
  const email = address();
  const userId = opts.userId ?? (await seedUser(email));
  const name = `${RUN} ${randomUUID().slice(0, 6)}`;
  const { token } = await createFunnelDraft(email, { name, sport: "Badminton", format: "league", ...over } as FunnelPayload, sql, opts.locale ?? null);
  const draft = await consumeFunnelDraft(token);
  expect(draft, "claimable").not.toBeNull();
  const { orgId } = await createFromDraft(userId, draft!);
  const [row] = await sql<{ competition_id: string; division_id: string }[]>`
    select c.id as competition_id, d.id as division_id from competitions c join divisions d on d.competition_id = c.id
     where c.org_id = ${orgId} and c.name = ${name}`;
  expect(row, "the claim built one competition").toBeTruthy();
  const [{ role }] = await sql<{ role: AuthCtx["role"] }[]>`select role from org_members where org_id = ${orgId} and user_id = ${userId}`;
  return {
    auth: { orgId, via: "session", userId, role, keyId: null },
    orgId,
    competitionId: row!.competition_id,
    divisionId: row!.division_id,
    name,
  };
}
/** The kind a division of this sport and variant takes by default: the engine module's own declaration. */
const kindOf = async (divisionId: string): Promise<EntrantKind> => {
  const [d] = await sql<{ sport_key: string; variant_key: string }[]>`select sport_key, variant_key from divisions where id = ${divisionId}`;
  const mod = builtinModules.find((m) => m.key === d!.sport_key);
  if (!mod) throw new Error(`premise: the engine registers ${d!.sport_key}`);
  return effectiveEntrantModel(mod.entrantModel ?? null, ((mod.variants ?? {}) as Record<string, unknown>)[d!.variant_key]).defaultKind;
};
async function addEntrants(c: Claimed, n: number, from = 1): Promise<string[]> {
  const kind = await kindOf(c.divisionId);
  const made = await createEntrants(
    c.auth,
    c.divisionId,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `${RUN} entrant ${from + i}`, seed: from + i, members: [] })),
  );
  return made.map((e) => e.id);
}
const firstStage = async (divisionId: string): Promise<string> =>
  (await sql<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq limit 1`)[0]!.id;

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from funnel_drafts where email like ${`${RUN}-%`}`;
  await sql`delete from org_entitlement_overrides where reason like ${`${RUN}%`}`;
  const ids = (await sql<{ id: string }[]>`select id from users where email like ${`${RUN}-%`}`).map((u) => u.id);
  await sql`delete from courts where org_id in (select id from organizations where created_by = any(${ids}::uuid[]))`;
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("gettingStarted: the first steps of a competition the funnel built (DB)", () => {
  it("every funnel sport, step by step: claimed → entrants added → one withdrawn → generated → one scheduled", async () => {
    let checked = 0;
    for (const sport of FUNNEL_SPORTS) {
      const n = 6;
      const c = await claim({ sport: sport.name, entrants: n, format: "league" });
      const label = sport.key;
      // Just claimed: the claim seeds no one (owner, 2026-11-14), the target is the size chosen.
      expect(await gettingStarted(c.auth, c.competitionId), `${label}: claimed`).toEqual({
        orgRenamed: false,
        entrants: { count: 0, target: n },
        fixturesGenerated: false,
        fixtureScheduled: false,
      });
      // A second call reads the same: a pure read.
      expect((await gettingStarted(c.auth, c.competitionId)).entrants, `${label}: a second call`).toEqual({ count: 0, target: n });

      const ids = await addEntrants(c, n);
      expect((await gettingStarted(c.auth, c.competitionId)).entrants, `${label}: the field filled`).toEqual({ count: n, target: n });
      await withdrawEntrantCascade(c.auth, ids[0]!);
      expect((await gettingStarted(c.auth, c.competitionId)).entrants, `${label}: a withdrawal leaves the field`).toEqual({
        count: n - 1,
        target: n,
      });

      await generateStageFixturesUnpublished(c.auth, await firstStage(c.divisionId));
      const generated = await gettingStarted(c.auth, c.competitionId);
      expect([generated.fixturesGenerated, generated.fixtureScheduled], `${label}: generated, none timed`).toEqual([true, false]);

      const [one] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${c.divisionId} order by fixture_no limit 1`;
      await sql`update fixtures set scheduled_at = now() + interval '3 days' where id = ${one!.id}`;
      expect((await gettingStarted(c.auth, c.competitionId)).fixtureScheduled, `${label}: one on the schedule`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: every funnel sport was walked").toBe(FUNNEL_SPORTS.length);
  });

  it("a disqualified entrant leaves the field too; the target never moves", async () => {
    const c = await claim({ entrants: 4 });
    const ids = await addEntrants(c, 4);
    await withdrawEntrantCascade(c.auth, ids[1]!, { as: "disqualified" });
    expect((await gettingStarted(c.auth, c.competitionId)).entrants).toEqual({ count: 3, target: 4 });
  });

  it("an archived division drops out of every count — entrants, generated, scheduled — and a restore brings it back", async () => {
    const c = await claim({ entrants: 4 });
    await addEntrants(c, 4);
    await generateStageFixturesUnpublished(c.auth, await firstStage(c.divisionId));
    await sql`update fixtures set scheduled_at = now() + interval '3 days' where division_id = ${c.divisionId}`;
    const live = { orgRenamed: false, entrants: { count: 4, target: 4 }, fixturesGenerated: true, fixtureScheduled: true };
    expect(await gettingStarted(c.auth, c.competitionId), "premise: the live division counts").toEqual(live);
    await archiveDivision(c.auth, c.divisionId);
    expect(await gettingStarted(c.auth, c.competitionId), "archived: nothing of it counts").toEqual({
      orgRenamed: false,
      entrants: { count: 0, target: 4 },
      fixturesGenerated: false,
      fixtureScheduled: false,
    });
    await restoreDivision(c.auth, c.divisionId);
    expect(await gettingStarted(c.auth, c.competitionId), "restored").toEqual(live);
  });

  it("renamed: false under the claim's name, true once changed, false again when changed back; the event's own rename is not it", async () => {
    const c = await claim({ entrants: 4 });
    const [{ name: orgName }] = await sql<{ name: string }[]>`select name from organizations where id = ${c.orgId}`;
    expect(orgName, "premise: the claim named it from the dictionary").toBe(defaultOrgName("en", c.name));
    const steps: { label: string; run: () => Promise<unknown>; renamed: boolean }[] = [
      { label: "renamed", run: () => sql`update organizations set name = ${`${RUN} Harbourvale Badminton Club`} where id = ${c.orgId}`, renamed: true },
      { label: "renamed back", run: () => sql`update organizations set name = ${orgName} where id = ${c.orgId}`, renamed: false },
      // The default is the name the CLAIM gave (the event's name then), not one remade from the event's name now.
      { label: "the event renamed", run: () => sql`update competitions set name = ${`${RUN} Autumn Open`} where id = ${c.competitionId}`, renamed: false },
    ];
    let checked = 0;
    for (const s of steps) {
      await s.run();
      expect((await gettingStarted(c.auth, c.competitionId)).orgRenamed, s.label).toBe(s.renamed);
      checked++;
    }
    expect(checked).toBe(steps.length);
  });

  it("renamed is measured in the draft's language: every shipped language's default reads as not renamed", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const c = await claim({ entrants: 4 }, { locale });
      const [{ name }] = await sql<{ name: string }[]>`select name from organizations where id = ${c.orgId}`;
      expect(name, `${locale}: premise — named in the draft's language`).toBe(defaultOrgName(locale, c.name));
      expect((await gettingStarted(c.auth, c.competitionId)).orgRenamed, locale).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: every language").toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => defaultOrgName(l, "X"))).size, "premise: each language names it its own way").toBe(LOCALES.length);
  });

  it("a claim into an organisation the claimant already owns: renamed (the claim never named it)", async () => {
    const userId = await seedUser();
    const own = await createOrgForUser(userId, `${RUN} Riverside Club`);
    const c = await claim({ entrants: 4 }, { userId });
    expect(c.orgId, "premise: the claim built into the owned organisation").toBe(own.id);
    expect((await gettingStarted(c.auth, c.competitionId)).orgRenamed).toBe(true);
  });

  it("the target is the chosen size held to the plan's cap — read live, so an unlimited override lifts it to the choice", async () => {
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `${RUN} capped`);
    const cap = await getLimit(org.id, "entrants.per_division.max");
    expect(cap, "premise: the free plan caps a division's field").not.toBeNull();
    const ask = cap! + 5;
    expect(ask, "premise: the ask is inside the funnel's 2..256").toBeLessThanOrEqual(256);
    const c = await claim({ entrants: ask }, { userId });
    expect((await gettingStarted(c.auth, c.competitionId)).entrants.target, "held to the cap").toBe(cap);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${org.id}, 'entrants.per_division.max', null, ${`${RUN} unlimited`})`;
    expect(await getLimit(org.id, "entrants.per_division.max"), "premise: the override reads unlimited").toBeNull();
    expect((await gettingStarted(c.auth, c.competitionId)).entrants.target, "the choice, once unlimited").toBe(ask);
  });

  it("an Event Pass on the competition lifts the target: the cap is read for THIS competition (review m3)", async () => {
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `${RUN} passed`);
    const freeCap = await getLimit(org.id, "entrants.per_division.max");
    expect(freeCap, "premise: the free plan caps a division's field").not.toBeNull();
    const ask = freeCap! + 5;
    const c = await claim({ entrants: ask }, { userId });
    expect((await gettingStarted(c.auth, c.competitionId)).entrants.target, "no pass: held to the plan's cap").toBe(freeCap);
    // The pass, as a purchase writes it (pass_key from the column's default), and its cap from the plan matrix.
    const [pass] = await sql<{ pass_key: string }[]>`
      insert into competition_passes (competition_id, org_id) values (${c.competitionId}, ${c.orgId}) returning pass_key`;
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements where plan_key = ${pass!.pass_key} and feature_key = 'entrants.per_division.max'`;
    const passCap = row?.int_value ?? null;
    expect(passCap === null || passCap > freeCap!, "premise: the pass lifts the field above the free cap").toBe(true);
    expect(passCap === null || ask <= passCap, "premise: the ask fits under the pass").toBe(true);
    await invalidateOrgEntitlements(c.orgId);
    expect((await gettingStarted(c.auth, c.competitionId)).entrants.target, "the pass lifts it to the choice").toBe(ask);
    // The pair: another competition of the same organisation has no pass and stays capped.
    expect(await getLimit(c.orgId, "entrants.per_division.max"), "the organisation's own cap is unmoved").toBe(freeCap);
  });

  it("a competition no funnel built: no target; renamed against the claim's name of the event in any language; empty reads empty", async () => {
    const eventName = `${RUN} Hand-made Cup`;
    const cases = [
      { label: "an English default", orgName: defaultOrgName("en", eventName), renamed: false },
      { label: "a French default", orgName: defaultOrgName("fr", eventName), renamed: false },
      { label: "a name of its own", orgName: `${RUN} Northside Club`, renamed: true },
    ];
    let checked = 0;
    for (const k of cases) {
      const userId = await seedUser(); // one organisation each: the free plan owns one
      const org = await createOrgForUser(userId, k.orgName);
      const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: "owner", keyId: null };
      const comp = await createCompetition(auth, { name: eventName, visibility: "private", branding: {} } as CreateCompetition);
      expect(await gettingStarted(auth, comp.id), k.label).toEqual({
        orgRenamed: k.renamed,
        entrants: { count: 0, target: null },
        fixturesGenerated: false,
        fixtureScheduled: false,
      });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("another organisation's competition, or none, is a 404 — nothing of it is read", async () => {
    const mine = await claim({ entrants: 4 });
    const theirs = await claim({ entrants: 4 });
    await expect(gettingStarted(mine.auth, theirs.competitionId), "another organisation's").rejects.toMatchObject({ status: 404 });
    await expect(gettingStarted(mine.auth, randomUUID()), "none").rejects.toMatchObject({ status: 404 });
    // The pair: each reads its own.
    expect((await gettingStarted(theirs.auth, theirs.competitionId)).entrants.target).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("funnelGettingStarted: the landing's read stops at the draft (review I2)", () => {
  beforeEach(() => {
    spied.withTenant = 0;
    spied.getDictionary = 0;
    spied.getLimit = 0;
  });

  it("a competition no /start draft built (the empty case): null, and no tenant read, no plan read, no dictionary", async () => {
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `${RUN} Hand-made Club`);
    const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: "owner", keyId: null };
    const comp = await createCompetition(auth, { name: `${RUN} Hand-made Cup`, visibility: "private", branding: {} } as CreateCompetition);
    const cases: [string, string][] = [
      ["the caller's own hand-made competition", comp.id],
      ["no competition at all", randomUUID()],
    ];
    let checked = 0;
    for (const [label, id] of cases) {
      spied.withTenant = spied.getDictionary = spied.getLimit = 0;
      expect(await funnelGettingStarted(auth, id), label).toBeNull();
      expect(spied, `${label}: nothing past the draft read`).toEqual({ withTenant: 0, getDictionary: 0, getLimit: 0 });
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The pair: the full read of the same competition does all three kinds of work (so the counters can see them).
    await gettingStarted(auth, comp.id);
    expect(spied.withTenant, "the full read's tenant read is counted").toBeGreaterThan(0);
    expect(spied.getDictionary, "…and its dictionary work").toBeGreaterThan(0);
  });

  it("a competition a /start draft built: the full read, the same answer as gettingStarted, after a step too", async () => {
    const c = await claim({ entrants: 6 });
    const first = await funnelGettingStarted(c.auth, c.competitionId);
    expect(spied.withTenant, "the tenant read ran").toBeGreaterThan(0);
    expect(spied.getLimit, "the plan's cap was read").toBeGreaterThan(0);
    expect(first).toEqual(await gettingStarted(c.auth, c.competitionId));
    expect(first!.entrants).toEqual({ count: 0, target: 6 });
    await addEntrants(c, 2);
    expect((await funnelGettingStarted(c.auth, c.competitionId))!.entrants, "a second call reads the field again").toEqual({ count: 2, target: 6 });
  });

  it("another organisation's /start competition is still a 404: the draft read never answers for the tenant read", async () => {
    const mine = await claim({ entrants: 4 });
    const theirs = await claim({ entrants: 4 });
    await expect(funnelGettingStarted(mine.auth, theirs.competitionId)).rejects.toMatchObject({ status: 404 });
    expect((await funnelGettingStarted(theirs.auth, theirs.competitionId))!.entrants.target, "the pair: its own").toBe(4);
  });
});
