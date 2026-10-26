// Owner ruling 2026-10-26: chess divisions are INDIVIDUAL-ONLY — online and
// over-the-board. No pair, team or free-agent (solo sign-up) entry.
//
// Every writer that can SET an entrant kind / entrant model / allow_free_agents
// for a division is driven here through its real usecase against a real
// Postgres (RLS, the config column, the registration_settings upsert):
//
//   1. putRegistrationSettings   — registration_settings.entrant_kind / allow_free_agents
//   2. createDivision            — config.entrants (the entrant-shape override)
//   3. patchDivision             — config.entrants
//   4. createEntrants            — entrants.kind
//   5. commitImport (+ the plan) — the CSV import hard-codes kind 'team'
//   6. generateStageFixtures (americano / mexicano) — mints `pair` entrants for every rotation
//
// Each writer has a refusal (chess), a positive pair (a sport that DOES take
// teams/pairs, swept across the registry from the engine's own declarations),
// and the sequence cases the house test strategy asks for: a second call, the
// empty case, and a legacy row. `WRITERS` is the ledger — a writer that is
// listed but never exercised, or exercised but never listed, fails the last
// test, so "I covered every writer" is a checked claim rather than a comment.
//
// Skipped without DATABASE_URL (same convention as entrants.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { EntrantKind } from "@/server/api-v1/schemas";
import {
  CHESS_INDIVIDUAL_ONLY,
  CHESS_SPORT_KEY,
  entrantsOverrideWidensBeyondIndividual,
  isChessSport,
} from "@/lib/chess-individual-only";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants, listEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { commitImport, createImport } from "../imports";
import { getRegistrationSettings, publicRegistrationInfo, putRegistrationSettings } from "../registrations";
import { asOwner, makeUser } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ---------------------------------------------------------------------------
// The writer ledger
// ---------------------------------------------------------------------------

const WRITERS = [
  "putRegistrationSettings",
  "createDivision",
  "patchDivision",
  "createEntrants",
  "commitImport",
  "generateStageFixtures",
] as const;
type Writer = (typeof WRITERS)[number];
/** Writer -> how many chess refusals this file actually drove through it. */
const refused = new Map<Writer, number>();
const noteRefusal = (w: Writer) => refused.set(w, (refused.get(w) ?? 0) + 1);

// ---------------------------------------------------------------------------
// What the engine itself declares (never typed into the test)
// ---------------------------------------------------------------------------

const MODULES: readonly AnySportModule[] = builtinModules;
const CHESS = MODULES.find((m) => m.key === CHESS_SPORT_KEY)!;
/** The kinds the API contract knows, minus individual: the things chess must refuse. */
const NON_INDIVIDUAL: readonly string[] = EntrantKind.options.filter((k) => k !== "individual");
/** Every non-chess sport, with the non-individual kinds ITS OWN module declares
 *  (`generic` declares no model, so effectiveEntrantModel gives it every kind). */
const NON_CHESS = MODULES.filter((m) => m.key !== CHESS_SPORT_KEY).map((m) => ({
  key: m.key,
  kinds: effectiveEntrantModel(m.entrantModel ?? null).kinds.filter((k) => k !== "individual"),
}));
const NON_CHESS_PAIRS = NON_CHESS.flatMap((s) => s.kinds.map((kind) => ({ sport: s.key, kind })));

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** Seed the REAL module catalog for a sport (never an empty stub: the shared
 *  test DB must stay usable by sibling suites) and return a variant to use. */
async function ensureSport(key: string): Promise<string> {
  const m = MODULES.find((x) => x.key === key)!;
  const variant = Object.keys(m.variants)[0]!;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${key}, ${key}, ${m.version}, ${sql.json(m.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values (${key}, ${variant}, ${variant}, ${sql.json((m.variants[variant] ?? {}) as never)}, true)
    on conflict do nothing`;
  return variant;
}

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Chess Only " + suffix}, ${"chess-only-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return asOwner(orgId, ownerId);
}

async function competitionFor(auth: AuthCtx) {
  return createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Chess Only Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
}

async function divisionOf(auth: AuthCtx, sport: string, config: Record<string, unknown> = {}, slug?: string) {
  const variant = await ensureSport(sport);
  const comp = await competitionFor(auth);
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    sport_key: sport,
    variant_key: variant,
    config,
    ...(slug ? { slug } : {}),
  } as never);
  return { comp, division };
}

const chessDivision = (auth: AuthCtx, config: Record<string, unknown> = {}, slug?: string) =>
  divisionOf(auth, CHESS_SPORT_KEY, config, slug);

const SETTINGS = {
  enabled: true,
  fee_cents: 0,
  payment_method: "offline" as const,
  form_fields: [],
};

/** Run a promise expected to be refused with the chess code; return the error. */
async function expectChessRefusal(p: Promise<unknown>, writer: Writer): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: 422, code: CHESS_INDIVIDUAL_ONLY });
  noteRefusal(writer);
}

/** A chess division saved BEFORE the ruling: the widened override is written
 *  straight into the column, the way the old Settings > Entrants save left it. */
async function widenLegacy(divisionId: string, entrants: Record<string, unknown>) {
  await sql`
    update divisions set config = config || ${sql.json({ entrants } as never)}
    where id = ${divisionId}`;
}

async function storedConfig(divisionId: string): Promise<Record<string, unknown>> {
  return (await getDivision(await ownerOfDivision(divisionId), divisionId)).config as Record<string, unknown>;
}
async function ownerOfDivision(divisionId: string): Promise<AuthCtx> {
  const [row] = await sql<{ org_id: string }[]>`
    select c.org_id from divisions d join competitions c on c.id = d.competition_id where d.id = ${divisionId}`;
  const [m] = await sql<{ user_id: string }[]>`
    select user_id from org_members where org_id = ${row!.org_id} and role = 'owner' limit 1`;
  return asOwner(row!.org_id, m!.user_id);
}

// ---------------------------------------------------------------------------
// The predicate itself, against the engine's own declaration
// ---------------------------------------------------------------------------

describe("the chess predicate and the engine agree", () => {
  it("chess is the sport named Chess, and the engine declares it individual-only", () => {
    expect(isChessSport(CHESS.key)).toBe(true);
    // The engine's own declaration of the same rule — if this ever diverges
    // from the predicate, one of the two is wrong.
    expect(effectiveEntrantModel(CHESS.entrantModel ?? null).kinds).toEqual(["individual"]);
  });

  it("sweeps the registry: the predicate holds for chess and for no other sport (anti-vacuity: counts)", () => {
    const hits = MODULES.filter((m) => isChessSport(m.key));
    expect(MODULES.length).toBeGreaterThan(1);
    expect(hits.map((m) => m.key)).toEqual([CHESS_SPORT_KEY]);
    // No OTHER module declares itself individual-only. If one ever does, the
    // refusal copy ("chess ...") needs a decision for it before it ships.
    const individualOnly = MODULES.filter(
      (m) => effectiveEntrantModel(m.entrantModel ?? null).kinds.join() === "individual",
    ).map((m) => m.key);
    expect(individualOnly).toEqual([CHESS_SPORT_KEY]);
    expect(isChessSport(undefined)).toBe(false);
    expect(isChessSport(null)).toBe(false);
  });

  it("the sweep has teeth: there are non-chess sports that take teams or pairs to be accepted", () => {
    expect(NON_INDIVIDUAL.length).toBeGreaterThan(0);
    expect(NON_CHESS_PAIRS.length).toBeGreaterThan(0);
    expect(NON_CHESS_PAIRS.some((p) => p.kind === "team")).toBe(true);
    expect(NON_CHESS_PAIRS.some((p) => p.kind === "pair")).toBe(true);
  });

  it("an entrants override 'widens' only by naming a kind that is not individual", () => {
    for (const w of [
      { kinds: ["individual", "team"] },
      { kinds: ["pair"] },
      { kinds: ["individual"], defaultKind: "team" },
      { kinds: ["individual", "pair", "team"], defaultKind: "individual" },
      { defaultKind: "pair" },
      { kinds: ["quartet"] },
    ]) {
      expect(entrantsOverrideWidensBeyondIndividual(w), JSON.stringify(w)).toBe(true);
    }
    // The empty case: nothing here names a kind, so nothing is refused.
    for (const ok of [undefined, null, {}, { kinds: [] }, { kinds: ["individual"], defaultKind: "individual" }, { captain: true, squadNumbers: false }, "team", []]) {
      expect(entrantsOverrideWidensBeyondIndividual(ok), JSON.stringify(ok)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. putRegistrationSettings
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("1. putRegistrationSettings", () => {
  it("refuses team, pair and free agents for chess; the stored row is untouched", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    // A first, compliant save: the row we expect to survive every refusal.
    await putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: "individual", capacity: 16 });

    const attempts: Array<[string, Parameters<typeof putRegistrationSettings>[2]]> = [
      ...NON_INDIVIDUAL.map((kind): [string, Parameters<typeof putRegistrationSettings>[2]] => [
        `entrant_kind ${kind}`,
        { ...SETTINGS, entrant_kind: kind as never, capacity: 16 },
      ]),
      // Individual + free agents: the generic "requires entrant_kind 'team'"
      // message would point the organiser at the very option chess forbids.
      ["individual + allow_free_agents", { ...SETTINGS, entrant_kind: "individual", allow_free_agents: true }],
      // A solo price on its own (no pool): the older "requires allow_free_agents" message would be the wrong answer.
      ["individual + solo fee", { ...SETTINGS, entrant_kind: "individual", free_agent_fee_cents: 500 }],
      ["team + allow_free_agents", { ...SETTINGS, entrant_kind: "team", allow_free_agents: true }],
      ["team + allow_free_agents + solo fee", { ...SETTINGS, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 }],
    ];
    expect(attempts.length).toBeGreaterThanOrEqual(6);
    for (const [label, input] of attempts) {
      await expect(putRegistrationSettings(owner, division.id, input), label).rejects.toMatchObject({
        status: 422,
        code: CHESS_INDIVIDUAL_ONLY,
      });
      noteRefusal("putRegistrationSettings");
    }
    const after = await getRegistrationSettings(owner, division.id);
    expect(after.entrant_kind).toBe("individual");
    expect(after.allow_free_agents).toBe(false);
    expect(after.capacity).toBe(16);
  });

  it("the first save for a division with no settings row is refused too, and writes no row (empty case)", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const before = await sql`select 1 from registration_settings where division_id = ${division.id}`;
    expect(before).toHaveLength(0);
    await expectChessRefusal(
      putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: "pair" }),
      "putRegistrationSettings",
    );
    const after = await sql`select 1 from registration_settings where division_id = ${division.id}`;
    expect(after).toHaveLength(0);
  });

  it("individual chess is accepted, with and without the other settings, and a second save still is", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const a = await putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: "individual" });
    expect(a.entrant_kind).toBe("individual");
    // Omitting entrant_kind defaults to individual (the schema default), also fine.
    const b = await putRegistrationSettings(owner, division.id, { ...SETTINGS, capacity: 8 });
    expect(b.entrant_kind).toBe("individual");
    expect(b.allow_free_agents).toBe(false);
    expect(b.capacity).toBe(8);
  });

  it("every non-chess sport accepts each non-individual kind its own module declares (registry sweep)", async () => {
    const owner = await seedOwner();
    let accepted = 0;
    for (const { sport, kind } of NON_CHESS_PAIRS) {
      const { division } = await divisionOf(owner, sport);
      const saved = await putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: kind as never });
      expect(saved.entrant_kind, `${sport}/${kind}`).toBe(kind);
      accepted += 1;
    }
    expect(accepted).toBe(NON_CHESS_PAIRS.length);
    expect(accepted).toBeGreaterThan(0);
  });

  it("a team sport still takes free agents (the positive pair for the free-agent refusal)", async () => {
    const owner = await seedOwner();
    const sport = NON_CHESS.find((s) => s.kinds.includes("team"))!;
    const { division } = await divisionOf(owner, sport.key);
    const saved = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS,
      entrant_kind: "team",
      allow_free_agents: true,
      free_agent_fee_cents: 0,
    });
    expect(saved.allow_free_agents).toBe(true);
    expect(saved.free_agent_fee_cents).toBe(0);
  });

  it("a legacy chess row (team + free agents, written before the ruling) still reads; only a new write is refused", async () => {
    const owner = await seedOwner();
    const { comp, division } = await chessDivision(owner);
    await sql`
      insert into registration_settings (division_id, enabled, entrant_kind, allow_free_agents, fee_cents, payment_method, approval, form_fields)
      values (${division.id}, true, 'team', true, 0, 'offline', 'auto', ${sql.json([])})`;

    const read = await getRegistrationSettings(owner, division.id);
    expect(read.entrant_kind).toBe("team");
    expect(read.allow_free_agents).toBe(true);

    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${owner.orgId}`;
    const info = await publicRegistrationInfo(org!.slug, comp.slug);
    const row = info.divisions.find((d) => d.division_id === division.id);
    expect(row?.entrant_kind).toBe("team");
    expect(row?.allow_free_agents).toBe(true);

    // Re-saving the legacy configuration is a new write of it: refused.
    await expectChessRefusal(
      putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: "team", allow_free_agents: true }),
      "putRegistrationSettings",
    );
    // …and moving it to individual is the way out, and it works.
    const healed = await putRegistrationSettings(owner, division.id, { ...SETTINGS, entrant_kind: "individual" });
    expect(healed.entrant_kind).toBe("individual");
    expect(healed.allow_free_agents).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. createDivision
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("2. createDivision (config.entrants)", () => {
  it("refuses an entrants override that names team or pair for chess, and creates no division", async () => {
    const owner = await seedOwner();
    const variant = await ensureSport(CHESS_SPORT_KEY);
    const comp = await competitionFor(owner);
    const overrides: Record<string, unknown>[] = [
      { kinds: ["individual", "team"], defaultKind: "individual" },
      { kinds: ["pair"] },
      { kinds: ["individual"], defaultKind: "team" },
      { kinds: ["individual", "pair", "team"] },
      ...NON_INDIVIDUAL.map((k) => ({ kinds: ["individual", k] })),
    ];
    expect(overrides.length).toBeGreaterThanOrEqual(6);
    for (const entrants of overrides) {
      await expect(
        createDivision(owner, comp.id, {
          name: "Widened",
          sport_key: CHESS_SPORT_KEY,
          variant_key: variant,
          config: { entrants },
        } as never),
        JSON.stringify(entrants),
      ).rejects.toMatchObject({ status: 422, code: CHESS_INDIVIDUAL_ONLY });
      noteRefusal("createDivision");
    }
    const rows = await sql`select 1 from divisions where competition_id = ${comp.id}`;
    expect(rows).toHaveLength(0);
  });

  it("accepts chess with no override, an individual-only override, and an empty one (empty case)", async () => {
    const owner = await seedOwner();
    for (const entrants of [undefined, { kinds: ["individual"], defaultKind: "individual" }, {}, { kinds: [] }]) {
      const { division } = await chessDivision(owner, entrants === undefined ? {} : { entrants });
      expect(division.id).toBeTruthy();
    }
  });

  it("every non-chess sport accepts an entrants override naming a kind its own module declares (registry sweep)", async () => {
    const owner = await seedOwner();
    let accepted = 0;
    for (const { sport, kind } of NON_CHESS_PAIRS) {
      const entrants = { kinds: ["individual", kind], defaultKind: "individual" };
      const { division } = await divisionOf(owner, sport, { entrants });
      expect((await storedConfig(division.id)).entrants, `${sport}/${kind}`).toEqual(entrants);
      accepted += 1;
    }
    expect(accepted).toBe(NON_CHESS_PAIRS.length);
    expect(accepted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. patchDivision
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("3. patchDivision (config.entrants)", () => {
  it("refuses widening a chess division; the stored config is untouched", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const stored = await storedConfig(division.id);
    for (const entrants of [
      { kinds: ["individual", "team"], defaultKind: "individual" },
      { kinds: ["pair"] },
      { kinds: ["individual"], defaultKind: "pair" },
    ]) {
      await expectChessRefusal(patchDivision(owner, division.id, { config: { ...stored, entrants } } as never), "patchDivision");
    }
    expect(await storedConfig(division.id)).toEqual(stored);
  });

  it("accepts individual-only, then reset (the override key dropped) — a second and third call", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const stored = await storedConfig(division.id);
    const entrants = { kinds: ["individual"], defaultKind: "individual" };
    await patchDivision(owner, division.id, { config: { ...stored, entrants } } as never);
    expect((await storedConfig(division.id)).entrants).toEqual(entrants);
    await patchDivision(owner, division.id, { config: { ...stored } } as never);
    expect((await storedConfig(division.id)).entrants).toBeUndefined();
  });

  it("a legacy widened row: re-sending it as stored is not a new write (an unrelated save still works), a different widening is refused, and Reset clears it", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const legacy = { kinds: ["individual", "team"], defaultKind: "individual" };
    await widenLegacy(division.id, legacy);
    const stored = await storedConfig(division.id);
    expect(stored.entrants).toEqual(legacy);

    // The Settings page re-sends the WHOLE stored config on every save.
    const resent = await patchDivision(owner, division.id, { name: "Renamed", config: stored } as never);
    expect((resent as { name: string }).name).toBe("Renamed");
    expect((await storedConfig(division.id)).entrants).toEqual(legacy);

    // A different widening is a new write.
    await expectChessRefusal(
      patchDivision(owner, division.id, { config: { ...stored, entrants: { kinds: ["individual", "team", "pair"] } } } as never),
      "patchDivision",
    );
    expect((await storedConfig(division.id)).entrants).toEqual(legacy);

    // Reset (the override key absent) is the way out.
    const { entrants: _dropped, ...withoutOverride } = stored;
    void _dropped;
    await patchDivision(owner, division.id, { config: withoutOverride } as never);
    expect((await storedConfig(division.id)).entrants).toBeUndefined();
  });

  it("every non-chess sport accepts widening to a kind its own module declares (registry sweep)", async () => {
    const owner = await seedOwner();
    let accepted = 0;
    for (const { sport, kind } of NON_CHESS_PAIRS) {
      const { division } = await divisionOf(owner, sport);
      const stored = await storedConfig(division.id);
      const entrants = { kinds: ["individual", kind], defaultKind: "individual" };
      await patchDivision(owner, division.id, { config: { ...stored, entrants } } as never);
      expect((await storedConfig(division.id)).entrants, `${sport}/${kind}`).toEqual(entrants);
      accepted += 1;
    }
    expect(accepted).toBe(NON_CHESS_PAIRS.length);
    expect(accepted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. createEntrants
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("4. createEntrants (entrants.kind)", () => {
  it("refuses a team or pair entrant in chess, atomically for a mixed batch", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    for (const kind of NON_INDIVIDUAL) {
      await expectChessRefusal(
        createEntrants(owner, division.id, [{ kind: kind as never, display_name: `A ${kind}`, members: [] }]),
        "createEntrants",
      );
    }
    // One compliant entrant beside a team: the whole batch goes.
    await expectChessRefusal(
      createEntrants(owner, division.id, [
        { kind: "individual", display_name: "Fine", members: [] },
        { kind: "team", display_name: "Not fine", members: [] },
      ]),
      "createEntrants",
    );
    expect(await listEntrants(owner, division.id)).toHaveLength(0);
  });

  it("accepts individual chess entrants, one call after another", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    const [a] = await createEntrants(owner, division.id, [{ kind: "individual", display_name: "Ada", members: [] }]);
    expect(a!.kind).toBe("individual");
    const [b] = await createEntrants(owner, division.id, [{ kind: "individual", display_name: "Bo", members: [] }]);
    expect(b!.kind).toBe("individual");
    expect(await listEntrants(owner, division.id)).toHaveLength(2);
  });

  it("a legacy widened chess division: its team entrant still lists, but a NEW team entrant is refused", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    await widenLegacy(division.id, { kinds: ["individual", "team"], defaultKind: "team" });
    await sql`insert into entrants (division_id, kind, display_name) values (${division.id}, 'team', 'Old Guard')`;

    const listed = await listEntrants(owner, division.id);
    expect(listed.map((e) => [e.display_name, e.kind])).toEqual([["Old Guard", "team"]]);

    await expectChessRefusal(
      createEntrants(owner, division.id, [{ kind: "team", display_name: "Newcomers", members: [] }]),
      "createEntrants",
    );
    // The widened default must not slip a team in through an omitted kind.
    await expectChessRefusal(
      createEntrants(owner, division.id, [{ display_name: "No kind given", members: [] } as never]),
      "createEntrants",
    );
    const [ok] = await createEntrants(owner, division.id, [{ kind: "individual", display_name: "Ada", members: [] }]);
    expect(ok!.kind).toBe("individual");
    expect(await listEntrants(owner, division.id)).toHaveLength(2);
  });

  it("every non-chess sport accepts each non-individual kind its own module declares (registry sweep)", async () => {
    const owner = await seedOwner();
    let accepted = 0;
    for (const { sport, kind } of NON_CHESS_PAIRS) {
      const { division } = await divisionOf(owner, sport);
      const [row] = await createEntrants(owner, division.id, [{ kind: kind as never, display_name: `${sport} ${kind}`, members: [] }]);
      expect(row!.kind, `${sport}/${kind}`).toBe(kind);
      accepted += 1;
    }
    expect(accepted).toBe(NON_CHESS_PAIRS.length);
    expect(accepted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. CSV import
// ---------------------------------------------------------------------------

const csv = (...rows: string[]) => ({
  filename: "import.csv",
  contentType: "text/csv",
  buffer: Buffer.from(["Club,Team,Player,Division", ...rows].join("\r\n"), "utf8"),
});

async function counts(orgId: string) {
  const [c] = await sql<{ entrants: number; teams: number; persons: number; clubs: number }[]>`
    select (select count(*)::int from entrants e join divisions d on d.id = e.division_id join competitions c on c.id = d.competition_id where c.org_id = ${orgId}) as entrants,
           (select count(*)::int from teams where org_id = ${orgId}) as teams,
           (select count(*)::int from persons where org_id = ${orgId}) as persons,
           (select count(*)::int from clubs where org_id = ${orgId}) as clubs`;
  return c!;
}

describe.skipIf(!HAS_DB)("5. CSV import (hard-codes entrant kind 'team')", () => {
  it("a row placing a team into a chess division is a blocking issue in the plan and refuses the commit; nothing is written", async () => {
    const owner = await seedOwner();
    await chessDivision(owner, {}, "knights");
    const before = await counts(owner.orgId);

    const preview = await createImport(owner, csv("Acme SC,Acme Chess,Ada One,knights"));
    const issues = preview.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", rowNo: 2 });

    await expectChessRefusal(commitImport(owner, preview.importId, null), "commitImport");
    expect(await counts(owner.orgId)).toEqual(before);
    // The commit did not mark the import committed either.
    const [imp] = await sql<{ status: string }[]>`select status from imports where id = ${preview.importId}`;
    expect(imp!.status).toBe("planned");
  });

  it("re-previewing the same import (a second call) still carries the issue", async () => {
    const owner = await seedOwner();
    await chessDivision(owner, {}, "knights");
    const preview = await createImport(owner, csv("Acme SC,Acme Chess,Ada One,knights"));
    const { getImport } = await import("../imports");
    const again = await getImport(owner, preview.importId);
    expect(again.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY)).toHaveLength(1);
  });

  it("a mixed file is refused as a whole and flags only the chess row", async () => {
    const owner = await seedOwner();
    await chessDivision(owner, {}, "knights");
    const teamSport = NON_CHESS.find((s) => s.kinds.includes("team") && s.key !== "generic")!;
    await divisionOf(owner, teamSport.key, {}, "reds");
    const before = await counts(owner.orgId);

    const preview = await createImport(
      owner,
      csv("Acme SC,Acme Chess,Ada One,knights", "Borough FC,Borough Reds,Bo Two,reds"),
    );
    expect(preview.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY).map((i) => i.rowNo)).toEqual([2]);
    await expectChessRefusal(commitImport(owner, preview.importId, null), "commitImport");
    expect(await counts(owner.orgId)).toEqual(before);
  });

  it("the same file into a team sport commits and creates the team entrant (positive pair)", async () => {
    const owner = await seedOwner();
    const teamSport = NON_CHESS.find((s) => s.kinds.includes("team") && s.key !== "generic")!;
    await divisionOf(owner, teamSport.key, {}, "reds");
    const preview = await createImport(owner, csv("Borough FC,Borough Reds,Bo Two,reds"));
    expect(preview.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY)).toEqual([]);
    const out = await commitImport(owner, preview.importId, null);
    expect(out.divisionIds).toHaveLength(1);
    expect((await counts(owner.orgId)).entrants).toBe(1);
  });

  it("a directory-only row (no division) into an org that has a chess division still commits: no entrant kind is set (empty case)", async () => {
    const owner = await seedOwner();
    await chessDivision(owner, {}, "knights");
    const preview = await createImport(owner, csv("Acme SC,Acme Chess,Ada One,"));
    expect(preview.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY)).toEqual([]);
    await commitImport(owner, preview.importId, null);
    const after = await counts(owner.orgId);
    expect(after.entrants).toBe(0);
    expect(after.teams).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. americano / mexicano generation (mints `pair` entrants)
// ---------------------------------------------------------------------------

async function playersFor(auth: AuthCtx, divisionId: string, n: number) {
  for (let i = 1; i <= n; i++) {
    const person = await createPerson(auth, { full_name: `Player ${i}`, consent: {}, dob: null, gender: null, external_ref: null });
    await createEntrants(auth, divisionId, [
      {
        kind: "individual",
        display_name: `Player ${i}`,
        seed: i,
        members: [{ person_id: person.id, is_captain: false, roles: [], default_position_key: null, squad_number: null }],
      },
    ]);
  }
}
const pairCount = async (divisionId: string) => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId} and kind = 'pair'`;
  return r!.n;
};

describe.skipIf(!HAS_DB)("6. generateStageFixtures (americano / mexicano mint pair entrants)", () => {
  it("refuses to generate an americano stage for chess and mints no pair; the same stage on a team sport generates", async () => {
    const owner = await seedOwner();
    const { division: chess } = await chessDivision(owner);
    await playersFor(owner, chess.id, 8);
    const [stage] = await createStages(owner, chess.id, {
      seq: 1,
      kind: "americano" as never,
      name: "Rotation",
      config: { mode: "americano", courtCount: 2, rounds: 3 },
    });
    expect(await pairCount(chess.id), "premise: no pair yet").toBe(0);
    await expect(generateStageFixtures(owner, stage!.id)).rejects.toMatchObject({ status: 422, code: CHESS_INDIVIDUAL_ONLY });
    noteRefusal("generateStageFixtures");
    expect(await pairCount(chess.id)).toBe(0);
    // A second call is refused the same way (the guard is not first-call-only).
    await expect(generateStageFixtures(owner, stage!.id)).rejects.toMatchObject({ status: 422, code: CHESS_INDIVIDUAL_ONLY });

    // Positive pair: a sport that takes pairs generates, and the rotation does mint them.
    const { division: other } = await divisionOf(owner, "generic");
    await playersFor(owner, other.id, 8);
    const [otherStage] = await createStages(owner, other.id, {
      seq: 1,
      kind: "americano" as never,
      name: "Rotation",
      config: { mode: "americano", courtCount: 2, rounds: 3 },
    });
    const { created } = await generateStageFixtures(owner, otherStage!.id);
    expect(created).toBeGreaterThan(0);
    expect(await pairCount(other.id)).toBeGreaterThan(0);
  });

  it("too few players to rotate (2 of the 4 it needs): chess is refused as chess, not as 'not ready'", async () => {
    const owner = await seedOwner();
    const { division } = await chessDivision(owner);
    await playersFor(owner, division.id, 2);
    const [stage] = await createStages(owner, division.id, {
      seq: 1,
      kind: "americano" as never,
      name: "Rotation",
      config: { mode: "americano", courtCount: 1, rounds: 3 },
    });
    await expect(generateStageFixtures(owner, stage!.id)).rejects.toMatchObject({ code: CHESS_INDIVIDUAL_ONLY });
    // Control: the same two players on a team sport hit the stage's own readiness check instead.
    const { division: other } = await divisionOf(owner, "generic");
    await playersFor(owner, other.id, 2);
    const [otherStage] = await createStages(owner, other.id, {
      seq: 1,
      kind: "americano" as never,
      name: "Rotation",
      config: { mode: "americano", courtCount: 1, rounds: 3 },
    });
    await expect(generateStageFixtures(owner, otherStage!.id)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
  });
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("every writer in the ledger refused chess at least once", () => {
  it("WRITERS and the refusals actually driven are the same set, each driven more than zero times", () => {
    expect(WRITERS.length).toBe(6);
    for (const w of WRITERS) expect(refused.get(w) ?? 0, w).toBeGreaterThan(0);
    expect([...refused.keys()].sort()).toEqual([...WRITERS].sort());
  });
});
