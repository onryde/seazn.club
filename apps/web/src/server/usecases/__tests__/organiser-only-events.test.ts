// W2a Task 9 (spec §5.4.5, ruling 77 widened by owner ruling D-O1, X-ST-2): settle, forfeit, abandon — and every
// sport event that records a forfeit or walkover — are organiser-only on the server, per event × per authority.
//
// The sport half is DERIVED from the engine's own declarations, never typed here: every module's `eventSchemas`
// enum values in the forfeit vocabulary are the candidates, and a candidate is organiser-only iff applying it at a
// live state the module's own `arbitraryEvent` walk reaches DECIDES the match as that forfeit (the outcome names the
// value as its method, or is an award). The derived list must equal lib/organiser-only-events.ts's table.
//
// Authorities are the AuthCtx shapes the real doors produce: a device link minted and resolved through
// `requireFixtureActor` (the dl_ door itself), session officials as `scorers.test.ts` seeds them (an accepted
// fixture_officials row), and the organiser shapes (owner, admin, a write-scoped API key).
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MatchOutcome } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import {
  isOrganiserOnlyEvent,
  ORGANISER_ONLY,
  ORGANISER_ONLY_EVENT_TYPES,
  ORGANISER_ONLY_SPORT_EVENTS,
} from "@/lib/organiser-only-events";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { createDeviceLink } from "@/server/usecases/device-links";
import { scoreEvent } from "@/server/usecases/scoring";
import { subjectToScorerCapabilityGates } from "@/server/usecases/scorers";

// Every mint seals (scorer sheets §4.1): a throwaway key of this file's own, never an ambient .env.local one.
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;

/** The core types ruling 77 names (rule row X-ST-2) — the RULING, not the constant under test, so a type dropped
 *  from `ORGANISER_ONLY_EVENT_TYPES` still has its rows here and reds the matrix. */
const RULED_CORE_TYPES = ["core.settle", "core.forfeit", "core.abandon"] as const;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------
// The derivation (D-O1 item 2).
type Def = Record<string, unknown>;
type AnyModule = (typeof builtinModules)[number];
const defOf = (s: unknown) => (s as { _zod?: { def?: Def } })?._zod?.def;
const WRAPPERS = new Set(["optional", "nullable", "default", "readonly", "prefault", "catch"]);
function unwrap(s: unknown): unknown {
  let x = s;
  while (WRAPPERS.has(defOf(x)?.type as string)) x = defOf(x)!.innerType;
  return x;
}
/** The words a rulebook uses for a match lost without (all of) its play. A candidate filter only — the FOLD decides. */
const FORFEIT_VOCABULARY = /forfeit|walkover|default|disqualif/i;

/** A payload for `type` with `field = value`: the side keys name `side`, every other required key its first legal
 *  value. Built from the schema, so it is a payload the module's own validation accepts. */
function payloadFrom(schema: unknown, field: string, value: string, side: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defOf(unwrap(schema))!.shape as Def)) {
    const optional = defOf(v)?.type === "optional";
    if (k === field) out[k] = value;
    else if (k === "by" || k === "winner") out[k] = side;
    else if (optional) continue;
    else {
      const inner = defOf(unwrap(v))!;
      if (inner.type === "enum") out[k] = Object.values(inner.entries as object)[0];
      else if (inner.type === "number") out[k] = 0;
      else if (inner.type === "boolean") out[k] = false;
      else if (inner.type === "string") out[k] = "x";
    }
  }
  return out;
}

interface Candidate { sport: string; type: string; field: string; value: string; verdict: "forfeit" | "not-a-forfeit" | "unreached" }
const SEEDS = [1, 2, 3, 4, 5];
const decidesAsForfeit = (o: MatchOutcome | null, value: string) =>
  o !== null && (o.kind === "award" || (o as { method?: string }).method === value);

function classify(m: AnyModule, type: string, field: string, value: string): Candidate["verdict"] {
  const cfg = m.configSchema.parse(Object.values(m.variants)[0] ?? {});
  const lineups = defaultLineupPair(resolvePositions(m as never, cfg as never));
  const event = { type, payload: payloadFrom(m.eventSchemas![type], field, value, lineups.home.entrantId) };
  let reached = false;
  for (const seed of SEEDS) {
    const { states } = buildWalk(m as never, cfg as never, lineups, seed, 300);
    for (const state of states) {
      if (m.outcome(state as never) !== null) continue; // only a live match can be forfeited
      let next: unknown;
      try {
        next = m.apply(state as never, makeEnvelope(states.length, event) as never);
      } catch {
        continue; // not legal in this state; another live state may accept it
      }
      reached = true;
      if (decidesAsForfeit(m.outcome(next as never), value)) return "forfeit";
    }
  }
  return reached ? "not-a-forfeit" : "unreached";
}

const derivation = (() => {
  let modules = 0;
  let enumFields = 0;
  const candidates: Candidate[] = [];
  for (const m of builtinModules) {
    modules++;
    for (const [type, schema] of Object.entries(m.eventSchemas ?? {})) {
      const d = defOf(unwrap(schema));
      if (d?.type !== "object") continue;
      for (const [field, v] of Object.entries(d.shape as Def)) {
        const e = defOf(unwrap(v));
        if (e?.type !== "enum") continue;
        enumFields++;
        for (const value of Object.values(e.entries as object) as string[]) {
          if (FORFEIT_VOCABULARY.test(value)) candidates.push({ sport: m.key, type, field, value, verdict: classify(m, type, field, value) });
        }
      }
    }
  }
  const table: Record<string, { field: string; values: string[] }> = {};
  for (const c of candidates.filter((x) => x.verdict === "forfeit")) {
    (table[c.type] ??= { field: c.field, values: [] }).values.push(c.value);
  }
  return { modules, enumFields, candidates, table };
})();
const GATED_SPORT = derivation.candidates.filter((c) => c.verdict === "forfeit");

describe("X-ST-2 / D-O1: the organiser-only set, and the sport events derived from the engine", () => {
  it("X-ST-2 empty case first: the core constant is exactly the three ruled types, and the set is that list", () => {
    expect([...ORGANISER_ONLY_EVENT_TYPES].sort()).toEqual([...RULED_CORE_TYPES].sort());
    expect([...ORGANISER_ONLY].sort()).toEqual([...ORGANISER_ONLY_EVENT_TYPES].sort());
    expect(ORGANISER_ONLY.has("core.finalize"), "finalize keeps its own, division-configurable gate").toBe(false);
  });

  it("D-O1: every module and enum field was walked, every candidate was classified, and at least one sport event is gated", () => {
    expect(derivation.modules).toBe(builtinModules.length);
    expect(derivation.modules).toBeGreaterThan(0);
    expect(derivation.enumFields).toBeGreaterThan(0);
    expect(derivation.candidates.length).toBeGreaterThan(0);
    const unreached = derivation.candidates.filter((c) => c.verdict === "unreached").map((c) => `${c.type}.${c.field}=${c.value}`);
    expect(unreached, "a candidate no live state accepted cannot be classified").toEqual([]);
    expect(GATED_SPORT.length).toBeGreaterThan(0);
  });

  it("D-O1: lib/organiser-only-events.ts's sport table is EXACTLY the derived list", () => {
    const norm = (t: Readonly<Record<string, { readonly field: string; readonly values: readonly string[] }>>) =>
      Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { field: v.field, values: [...v.values].sort() }]));
    expect(norm(ORGANISER_ONLY_SPORT_EVENTS)).toEqual(norm(derivation.table));
  });

  it("D-O1: isOrganiserOnlyEvent — the empty and malformed cases are not organiser-only; every gated pair is; ordinary values are not", () => {
    expect(isOrganiserOnlyEvent("boardgame.result", undefined)).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", null)).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", "forfeit")).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", {})).toBe(false);
    expect(isOrganiserOnlyEvent("constructor", { method: "forfeit" })).toBe(false); // no prototype key is a table row
    expect(isOrganiserOnlyEvent("generic.result", { method: "forfeit" })).toBe(false);
    let checked = 0;
    for (const t of ORGANISER_ONLY_EVENT_TYPES) {
      expect(isOrganiserOnlyEvent(t, undefined), t).toBe(true);
      checked++;
    }
    for (const c of derivation.candidates) {
      expect(isOrganiserOnlyEvent(c.type, { [c.field]: c.value }), `${c.type}.${c.field}=${c.value}`).toBe(c.verdict === "forfeit");
      checked++;
    }
    expect(checked).toBe(ORGANISER_ONLY_EVENT_TYPES.length + derivation.candidates.length);
  });

  it("X-ST-2: the authority shapes split the way the ruling says (the predicate the server reads)", () => {
    const shape = (via: AuthCtx["via"], role: AuthCtx["role"]): AuthCtx => ({ orgId: "o", via, userId: null, role, keyId: null });
    expect(subjectToScorerCapabilityGates(shape("session", null))).toBe(true);
    expect(subjectToScorerCapabilityGates(shape("session", "viewer"))).toBe(true);
    expect(subjectToScorerCapabilityGates(shape("session", "owner"))).toBe(false);
    expect(subjectToScorerCapabilityGates(shape("session", "admin"))).toBe(false);
    expect(subjectToScorerCapabilityGates(shape("api_key", null))).toBe(false);
    // A device link's AuthCtx carries role null (api-v1/auth.ts), so the scorer predicate ALREADY selects it: the
    // gate's explicit `auth.via === "device_link"` clause is defence in depth (a mutant deleting it is equivalent
    // today), kept so a later change to the scorer predicate cannot open the device door.
    expect(subjectToScorerCapabilityGates(shape("device_link", null))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The DB matrix (per gated row × per authority).
const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const fixtureStatus = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true) returning id`;
  return id;
}
/** scorers.test.ts's acceptOfficial: a person → official → ACCEPTED assignment on this fixture. */
async function acceptOfficial(orgId: string, userId: string, fixtureId: string): Promise<void> {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${orgId}, 'Official', ${userId}) returning id`;
  const [official] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${orgId}, ${person!.id}, 'Official', ${sql.json(["referee"])}) returning id`;
  await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
            values (${orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
}

/** Refused: a device link; an accepted official with no org role; an org VIEWER who is also an accepted official.
 *  Allowed: owner, admin, and a write-scoped API key (an org credential, as for finalize and void). */
const REFUSED = ["device_link", "official", "viewer_official"] as const;
const ALLOWED = ["owner", "admin", "api_key"] as const;
type Who = (typeof REFUSED)[number] | (typeof ALLOWED)[number];

async function asAuthority(s: SeededBracket, fixtureId: string, who: Who): Promise<AuthCtx> {
  const base = { orgId: s.auth.orgId, keyId: null } as const;
  switch (who) {
    case "owner":
    case "admin": {
      const userId = await makeUser(who);
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${userId}, ${who})`;
      return { ...base, via: "session", userId, role: who };
    }
    case "api_key":
      return { orgId: s.auth.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    case "official": {
      const userId = await makeUser("official");
      await acceptOfficial(s.auth.orgId, userId, fixtureId);
      return { ...base, via: "session", userId, role: null };
    }
    case "viewer_official": {
      const userId = await makeUser("viewer");
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${userId}, 'viewer')`;
      await acceptOfficial(s.auth.orgId, userId, fixtureId);
      return { ...base, via: "session", userId, role: "viewer" };
    }
    case "device_link": {
      // Minted by an editor session (issued_by), then resolved through the dl_ door — the producer's own AuthCtx.
      const ownerId = await makeUser("issuer");
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${ownerId}, 'owner')`;
      const link = await createDeviceLink({ ...base, via: "session", userId: ownerId, role: "owner" }, fixtureId, "Court phone");
      const req = new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${link.secret}` } });
      const auth = await requireFixtureActor(req, fixtureId, "score");
      expect(auth.via, "the rig: a real device-link AuthCtx").toBe("device_link");
      return auth;
    }
  }
}

/** One gated row: a core type, or a derived sport (type, field, value). */
interface Gated { label: string; sport: string; type: string; payload: (f: { home: string; away: string }) => unknown; prep?: "abandon" }
const CORE_ROWS: Gated[] = RULED_CORE_TYPES.map((type) => ({
  label: type,
  sport: "generic",
  type,
  payload: (f) => {
    if (type === "core.settle") return { winner: f.home, method: "lot" };
    if (type === "core.forfeit") return { by: f.away, reason: "walkover" };
    return { reason: "rain" };
  },
  ...(type === "core.settle" ? { prep: "abandon" as const } : {}),
}));
const SPORT_ROWS: Gated[] = GATED_SPORT.map((c) => {
  const m = builtinModules.find((x) => x.key === c.sport)!;
  return { label: `${c.type}.${c.field}=${c.value}`, sport: c.sport, type: c.type, payload: (f) => payloadFrom(m.eventSchemas![c.type], c.field, c.value, f.home) };
});
const GATED: Gated[] = [...CORE_ROWS, ...SPORT_ROWS];

/** A started 2-draw knockout of `sport` (its first declared variant); for settle, abandoned first (X-ST-1). */
async function ready(row: Pick<Gated, "sport" | "prep">) {
  const m = builtinModules.find((x) => x.key === row.sport)!;
  const s = await seedBracket({ sport: row.sport, variant: Object.keys(m.variants)[0]!, stageKind: "knockout", entrants: 2 });
  const id = s.fixtureIds[0]!;
  await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
  if (row.prep === "abandon") await scoreEvent(s.auth, id, { expected_seq: 1, type: "core.abandon", payload: { reason: "rain" } });
  const [f] = await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
  return { s, id, f: f! };
}

describe.skipIf(!HAS_DB)("X-ST-2: organiser-only on the server, per gated row × per authority (ruling 77, D-O1)", () => {
  it("X-ST-2: every gated row is refused 403 for every non-organiser authority, and nothing is written", async () => {
    let checked = 0;
    for (const row of GATED)
      for (const who of REFUSED) {
        const { s, id, f } = await ready(row);
        const auth = await asAuthority(s, id, who);
        const before = await seq(id);
        const statusBefore = await fixtureStatus(id);
        await expect(
          scoreEvent(auth, id, { expected_seq: before, type: row.type, payload: row.payload(f) }),
          `${row.label} ${who}`,
        ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Only an organiser can /) });
        expect(await seq(id), `${row.label} ${who}`).toBe(before);
        expect(await fixtureStatus(id), `${row.label} ${who}`).toBe(statusBefore);
        checked++;
      }
    expect(SPORT_ROWS.length).toBeGreaterThan(0);
    expect(checked).toBe(GATED.length * REFUSED.length);
  });

  it("X-ST-2 defence in depth: a device-link credential is refused for every gated row even when its AuthCtx carries an organiser role", async () => {
    // No producer builds such a ctx today (requireFixtureActor gives a device link role null, which the scorer
    // predicate already selects). The gate names device links on its own so a later change to that predicate
    // cannot open the device door; this is the witness for that clause.
    let checked = 0;
    for (const row of GATED) {
      const { s, id, f } = await ready(row);
      const real = await asAuthority(s, id, "device_link");
      const promoted: AuthCtx = { ...real, role: "admin" };
      const before = await seq(id);
      await expect(
        scoreEvent(promoted, id, { expected_seq: before, type: row.type, payload: row.payload(f) }),
        row.label,
      ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Only an organiser can /) });
      expect(await seq(id), row.label).toBe(before);
      checked++;
    }
    expect(checked).toBe(GATED.length);
  });

  it("X-ST-2 positive pair: owner, admin and an API key are accepted for every gated row", async () => {
    let checked = 0;
    for (const row of GATED)
      for (const who of ALLOWED) {
        const { s, id, f } = await ready(row);
        const auth = await asAuthority(s, id, who);
        const out = await scoreEvent(auth, id, { expected_seq: await seq(id), type: row.type, payload: row.payload(f) });
        const [last] = await sql<{ type: string }[]>`select type from score_events where fixture_id = ${id} order by seq desc limit 1`;
        expect(last!.type, `${row.label} ${who}`).toBe(row.type);
        expect(out.seq, `${row.label} ${who}`).toBe(await seq(id));
        checked++;
      }
    expect(checked).toBe(GATED.length * ALLOWED.length);
  });

  it("X-ST-2 / D-O1: a chess result with an ORDINARY method still passes for every non-organiser authority (the payload arm is not type-wide)", async () => {
    // checkmate and resign (decisive) and agreement (a draw): methods the derivation did NOT gate.
    const ORDINARY = [
      { winner: "home", method: "checkmate" },
      { winner: "home", method: "resign" },
      { winner: null, method: "agreement" },
    ] as const;
    let checked = 0;
    for (const o of ORDINARY) {
      expect(isOrganiserOnlyEvent("boardgame.result", { method: o.method }), o.method).toBe(false);
      for (const who of REFUSED) {
        const { s, id, f } = await ready({ sport: "boardgame" });
        const auth = await asAuthority(s, id, who);
        const before = await seq(id);
        await scoreEvent(auth, id, { expected_seq: before, type: "boardgame.result", payload: { winner: o.winner === null ? null : f.home, method: o.method } });
        expect(await seq(id), `${o.method} ${who}`).toBe(before + 1);
        checked++;
      }
    }
    expect(checked).toBe(ORDINARY.length * REFUSED.length);
  });

  it("X-ST-2: the refused authorities can still score play — the check did not swallow the scorer or device path", async () => {
    let checked = 0;
    for (const who of REFUSED) {
      const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
      const id = s.fixtureIds[0]!;
      const auth = await asAuthority(s, id, who);
      await scoreEvent(auth, id, { expected_seq: 0, type: "core.start", payload: {} });
      const out = await scoreEvent(auth, id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } });
      expect(out.status, who).toBe("decided");
      checked++;
    }
    expect(checked).toBe(REFUSED.length);
  });

  it("X-ST-2: the authority is read from the request's AuthCtx — a demotion takes effect on the NEXT request, and the demoted caller is then refused", async () => {
    // A session's role is resolved once per request (requireFixtureActor → AuthCtx); scoreEvent never re-reads
    // org_members. Demoting an admin mid-flight therefore cannot change the request already holding its AuthCtx,
    // and the next request — resolved again, now as a viewer official — is refused.
    const { s, id } = await ready({ sport: "generic" });
    const admin = await asAuthority(s, id, "admin");
    await sql`update org_members set role = 'viewer' where org_id = ${s.auth.orgId} and user_id = ${admin.userId}`;
    await acceptOfficial(s.auth.orgId, admin.userId!, id);
    const demoted: AuthCtx = { ...admin, role: "viewer" };
    const before = await seq(id);
    await expect(scoreEvent(demoted, id, { expected_seq: before, type: "core.abandon", payload: { reason: "rain" } })).rejects.toMatchObject({ status: 403 });
    expect(await seq(id)).toBe(before);
    // The request that resolved BEFORE the demotion still carries admin: it is that request's authority.
    await scoreEvent(admin, id, { expected_seq: before, type: "core.abandon", payload: { reason: "rain" } });
    expect(await seq(id)).toBe(before + 1);
  });
});
