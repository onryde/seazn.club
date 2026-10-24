// API-key competition pins, swept at runtime over EVERY pinned key route.
//
// auth.ts resolves a pinned key's competition by looking the URL's resource id
// up in the table the key-route row's `pin` names, and it FAILS CLOSED: a
// lookup that finds nothing is refused exactly like a foreign competition.
// (Until 2026-10-23 a miss fell through, so a row declaring the WRONG kind, or
// a resolver join bug, missed on every lookup and let a key pinned to
// competition A read or write competition B.) key-scopes.test.ts pins each
// row's declaration statically, api-key-pin-fail-closed.test.ts pins the null
// branch without a DB, and this file proves it with real rows and the real
// resolver:
//
//  1. the auth door, every pinned row: B's resource is refused by the pin, A's
//     is let through, and B is refused again afterwards. Under fail-closed the
//     POSITIVE half is the one a wrong kind or a broken join reds — as a
//     lockout of A's own resources rather than a leak of B's;
//  2. the REAL route handler, every pinned row: B's resource is never served
//     and nothing of B's is written. Handlers that parse the body before they
//     authenticate answer 400 to the empty body instead — told apart from a
//     pin that let B through by a control call with a key that does not exist
//     — and are pinned as an EXACT list, so a handler that drops or moves its
//     auth call is caught; their pin is the one (1) proves;
//  3. the sequence: a withdrawn entrant, a withdrawn registration and an
//     archived division still resolve — the key pinned to their competition
//     still reaches them, a key pinned elsewhere is still refused;
//  4. the one pinned route whose handler does not look its own resource up
//     first (POST /pools/:id/clear-entrants, requireAuth) answers a missing
//     pool and another org's pool alike — no existence oracle.
//
// The resource each row is probed with is created by the kind its URL
// ADDRESSES (addressedKind), never by the row's declared pin: seeding the
// declared kind would make a wrong declaration agree with itself.
//
// One sport (generic) on purpose: the pin reads no sport column — it resolves
// ids through the divisions/stages/pools joins every sport shares.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { requireOrgAuth, type AuthCtx } from "@/server/api-v1/auth";
import { KEY_ROUTE_RULES } from "@/server/api-v1/key-scopes";
import { addressedKind, routeFileFor } from "@/server/api-v1/__tests__/_key-route-addressing";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { seedRegistration } from "./_registration-fixtures";
import { POST as clearPoolEntrantsPOST } from "@/app/api/v1/pools/[id]/clear-entrants/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** auth.ts's refusal, verbatim — a 403 for any other reason is not the pin. */
const PIN_REFUSAL = "This key is pinned to a different competition.";

const PINNED = KEY_ROUTE_RULES.filter((r) => r.pin);

/** Well-formed (`sc_` prefix, so it reaches the key lookup) and unknown. */
const NO_SUCH_KEY = `sc_${"0".repeat(43)}`;

/**
 * Pinned handlers that answer an empty body 400 BEFORE they authenticate
 * (the #376 ordering — routed, not fixed here). Exact, so a handler that drops
 * or reorders its auth call is caught: leaving this list means its 400 became
 * a 403 (moved auth first — delete the line), joining it means its auth moved
 * after the parse (or went away).
 */
const VALIDATES_BEFORE_AUTH = [
  "PATCH /competitions/:id",
  "POST /competitions/:id/divisions",
  "POST /competitions/:id/schedule/ai-plan",
  "POST /competitions/:id/schedule/ai-preview",
  "POST /competitions/:id/schedule/apply",
  "POST /competitions/:id/schedule/restore",
  "PATCH /divisions/:id",
  "POST /divisions/:id/checkpoints",
  "POST /divisions/:id/officials/ai-plan",
  "POST /divisions/:id/officials/apply",
  "POST /divisions/:id/officials/auto",
  "POST /divisions/:id/restore",
  "POST /divisions/:id/schedule/ai-plan",
  "POST /divisions/:id/schedule/ai-preview",
  "POST /divisions/:id/stages",
  "PUT /divisions/:id/stages",
  "PATCH /entrants/:id",
  "PATCH /fixtures/:id",
  "PUT /fixtures/:id/stream",
  // W2c Task 14: the route parses `PutFixtureRules` (a required `rules`) before `requireResourceAuth`, so an empty body
  // answers 400 first (confirmed by this sweep at the 2026-10-23 rebase onto #1006's fail-closed list).
  "PUT /fixtures/:id/rules",
  "POST /fixtures/:id/events",
  "POST /fixtures/:id/finalize",
  "PUT /fixtures/:id/lineups/:entrantId",
  "PATCH /fixtures/:id/officials",
  "POST /stages/:id/challenges",
  "POST /stages/:id/fixtures",
  "POST /stages/:id/officials/source",
  "POST /stages/:id/standings/override",
];

/** One live resource of every pin kind, all inside one competition. */
type World = Record<string, string>;

async function seedWorld(auth: AuthCtx, label: string): Promise<World> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Pin ${label} ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: `Open ${label}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["1", "2", "3", "4"].map((n, i) => ({
      kind: "individual" as const,
      display_name: `${label}${n}`,
      seed: i + 1,
      members: [],
    })),
  );
  // A two-pool group stage, so generate also mints the pools.
  const [stage] = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
  ]);
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const [pool] = await sql<{ id: string }[]>`
    select id from pools where stage_id = ${stage!.id} order by key limit 1`;
  const { registration } = await seedRegistration(comp.id, division.id, {
    fee_cents: 0,
    currency: "EUR",
    payment_method: "offline",
  });
  const world: World = {
    competition: comp.id,
    division: division.id,
    stage: stage!.id,
    pool: pool!.id,
    fixture: fixtures[0]!.id,
    entrant: entrants[0]!.id,
    registration: registration.id,
  };
  for (const [kind, id] of Object.entries(world)) {
    if (typeof id !== "string") throw new Error(`seedWorld(${label}): no ${kind} was created`);
  }
  return world;
}

/** Non-id slots a handler validates BEFORE it authenticates; a valid value lets
 *  the handler call reach the pin. (exports/[kind]/route.ts parses `kind` first.) */
const SLOT_VALUES: Record<string, string> = { ":kind": "roster" };

/** The row's template with its resource id slot filled; any other slot gets a
 *  fresh uuid (the pin only ever reads the resource id slot). */
function concretePath(path: string, idSegment: number, id: string): string {
  return path
    .split("/")
    .map((s, i) => (i === idSegment ? id : s.startsWith(":") ? (SLOT_VALUES[s] ?? randomUUID()) : s))
    .join("/");
}

function keyed(secret: string, method: string, path: string, body: unknown = {}): Request {
  const withBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(withBody ? { "content-type": "application/json" } : {}),
    },
    ...(withBody ? { body: JSON.stringify(body) } : {}),
  });
}

function describeError(e: unknown): string {
  if (e instanceof HttpError) return `${e.status} ${e.message}`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Every row of competition B's tree that a pinned route could write, hashed —
 *  so "refused" also means "nothing written". `n` keeps it non-vacuous. */
async function fingerprint(competitionId: string): Promise<{ n: number; h: string }> {
  const [r] = await sql<{ n: number; h: string }[]>`
    with d as (select id from divisions where competition_id = ${competitionId}),
         s as (select id from stages where division_id in (select id from d)),
         f as (select id from fixtures where division_id in (select id from d)),
         e as (select id from entrants where division_id in (select id from d)),
         rows as (
           select 'competitions' t, to_jsonb(x)::text j from competitions x where id = ${competitionId}
           union all select 'competition_events', to_jsonb(x)::text from competition_events x where competition_id = ${competitionId}
           union all select 'registration_groups', to_jsonb(x)::text from registration_groups x where competition_id = ${competitionId}
           union all select 'divisions', to_jsonb(x)::text from divisions x where id in (select id from d)
           union all select 'division_events', to_jsonb(x)::text from division_events x where division_id in (select id from d)
           union all select 'division_checkpoints', to_jsonb(x)::text from division_checkpoints x where division_id in (select id from d)
           union all select 'schedule_settings', to_jsonb(x)::text from schedule_settings x where division_id in (select id from d)
           union all select 'registration_settings', to_jsonb(x)::text from registration_settings x where division_id in (select id from d)
           union all select 'registrations', to_jsonb(x)::text from registrations x where division_id in (select id from d)
           union all select 'stages', to_jsonb(x)::text from stages x where id in (select id from s)
           union all select 'pools', to_jsonb(x)::text from pools x where stage_id in (select id from s)
           union all select 'stage_seed_proposals', to_jsonb(x)::text from stage_seed_proposals x where stage_id in (select id from s)
           union all select 'stage_round_court_tags', to_jsonb(x)::text from stage_round_court_tags x where stage_id in (select id from s)
           union all select 'standings_snapshots', to_jsonb(x)::text from standings_snapshots x where stage_id in (select id from s)
           union all select 'fixtures', to_jsonb(x)::text from fixtures x where id in (select id from f)
           union all select 'score_events', to_jsonb(x)::text from score_events x where fixture_id in (select id from f)
           union all select 'match_states', to_jsonb(x)::text from match_states x where fixture_id in (select id from f)
           union all select 'lineups', to_jsonb(x)::text from lineups x where fixture_id in (select id from f)
           union all select 'fixture_officials', to_jsonb(x)::text from fixture_officials x where fixture_id in (select id from f)
           union all select 'entrants', to_jsonb(x)::text from entrants x where id in (select id from e)
           union all select 'entrant_members', to_jsonb(x)::text from entrant_members x where entrant_id in (select id from e)
         )
    select count(*)::int as n, md5(coalesce(string_agg(t || ':' || j, '|' order by t, j), '')) as h from rows`;
  return r!;
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("API-key competition pins hold on every pinned key route", () => {
  let auth: AuthCtx;
  let A: World;
  let B: World;

  /** A manage key (every scope passes, so only the pin can refuse) pinned to A. */
  const pinnedToA = async (name: string) =>
    (await createApiKey(auth, { name, scopes: ["manage"], competition_id: A.competition })).secret;

  beforeAll(async () => {
    ({ auth } = await seedOrg("pro"));
    // `pro` carries api.access but not api.write; a manage key needs it.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'api.write', true, 'test')
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(auth.orgId);
    // Same org on purpose: the pin is then the ONLY thing between A's key and B.
    A = await seedWorld(auth, "A");
    B = await seedWorld(auth, "B");
  });

  it("auth door: B's resource is refused by the pin, A's is not — every pinned row, both ways", async () => {
    const failures: string[] = [];
    const kinds = new Set<string>();
    let checked = 0;
    for (const rule of PINNED) {
      const label = `${rule.method} ${rule.path}`;
      const { kind, idSegment } = addressedKind(rule.method, rule.path);
      const own = A[kind];
      const foreign = B[kind];
      if (!own || !foreign) {
        failures.push(`${label}: addresses a '${kind}' and seedWorld makes none — extend seedWorld`);
        continue;
      }
      // A key per row: the positive calls count against its rate-limit window.
      const secret = await pinnedToA(`pin sweep ${checked}`);
      const refuseB = async (when: string) => {
        try {
          await requireOrgAuth(keyed(secret, rule.method, concretePath(rule.path, idSegment, foreign)), auth.orgId, "read");
          failures.push(`${label}: competition B's ${kind} was let through ${when} — the pin FAILS OPEN`);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 403 && e.message === PIN_REFUSAL)) {
            failures.push(`${label}: B's ${kind} refused ${when} for the wrong reason: ${describeError(e)}`);
          }
        }
      };
      await refuseB("on the first call");
      try {
        const ctx = await requireOrgAuth(
          keyed(secret, rule.method, concretePath(rule.path, idSegment, own)),
          auth.orgId,
          "read",
        );
        if (ctx.via !== "api_key" || ctx.orgId !== auth.orgId) {
          failures.push(`${label}: A's ${kind} authenticated as ${ctx.via}/${ctx.orgId}`);
        }
      } catch (e) {
        failures.push(`${label}: competition A's OWN ${kind} was refused: ${describeError(e)}`);
      }
      // Second call: a key that just passed on A is still refused on B.
      await refuseB("after the key passed on A");
      kinds.add(kind);
      checked += 1;
    }
    console.info(`api-key-pin-sweep auth door — pinned rows: ${checked}/${PINNED.length}, kinds: ${[...kinds].sort().join(",")}`);
    expect(failures, failures.join("\n")).toEqual([]);
    expect(checked, "anti-vacuity: pinned rows swept at the auth door").toBeGreaterThan(0);
    expect(checked, "every pinned row was swept").toBe(PINNED.length);
    // Every branch of resolvePinCompetition ran both ways — and seedWorld makes
    // nothing no row addresses.
    expect([...kinds].sort(), "pin kinds swept").toEqual(Object.keys(A).sort());
  });

  it("route handlers: B's resource is never served and nothing of B's is written — every pinned row", async () => {
    const secret = await pinnedToA("pin sweep handlers");
    const failures: string[] = [];
    const refusedByPin: string[] = [];
    const refusedBeforeAuth: string[] = [];
    let rowsFingerprinted = 0;
    for (const rule of PINNED) {
      const label = `${rule.method} ${rule.path}`;
      const { kind, idSegment } = addressedKind(rule.method, rule.path);
      const foreign = B[kind];
      const route = routeFileFor(rule.path);
      if (!foreign || !route) {
        failures.push(`${label}: ${!route ? "no route.ts serves this template" : `no seeded ${kind}`}`);
        continue;
      }
      const handler = ((await import(route.file)) as Record<string, unknown>)[rule.method];
      if (typeof handler !== "function") {
        failures.push(`${label}: ${route.file} exports no ${rule.method}`);
        continue;
      }
      const path = concretePath(rule.path, idSegment, foreign);
      const segs = path.split("/");
      const params = Object.fromEntries(route.params.map((p) => [p.name, segs[p.segment]!]));
      const call = async (token: string) => {
        const res = await (handler as Handler)(keyed(token, rule.method, path), { params: Promise.resolve(params) });
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        return { status: res.status, body };
      };
      const before = await fingerprint(B.competition);
      const pinned = await call(secret);
      // The control: a key that does not exist. A handler that authenticates
      // first answers it 401; only one that validates the body first answers
      // it 400. Without it a 400 to the pinned key could be a pin that LET B
      // THROUGH and then failed validation — which is not a refusal.
      const control = await call(NO_SUCH_KEY);
      const after = await fingerprint(B.competition);
      if (before.n === 0) failures.push(`${label}: competition B's fingerprint is empty (vacuous)`);
      if (after.h !== before.h || after.n !== before.n) {
        failures.push(`${label}: competition B CHANGED (${before.n} → ${after.n} rows) — answered ${pinned.status}`);
      }
      rowsFingerprinted += 1;
      const isValidation = (r: typeof pinned) => r.status === 400 && r.body?.error?.code === "VALIDATION";
      if (pinned.status === 403 && pinned.body?.error?.message === PIN_REFUSAL) {
        refusedByPin.push(label);
      } else if (isValidation(pinned) && isValidation(control)) {
        refusedBeforeAuth.push(label);
      } else {
        failures.push(
          `${label}: competition B's ${kind} answered ${pinned.status} ${JSON.stringify(pinned.body?.error ?? pinned.body)}` +
            ` (a key that does not exist got ${control.status})`,
        );
      }
    }
    console.info(
      `api-key-pin-sweep handlers — rows: ${rowsFingerprinted}/${PINNED.length}, refused by the pin: ${refusedByPin.length}, ` +
        `refused by body validation before auth (pin proven at the auth door): ${refusedBeforeAuth.length}`,
    );
    expect(failures, failures.join("\n")).toEqual([]);
    expect(rowsFingerprinted, "every handler call was bracketed by a fingerprint").toBe(PINNED.length);
    const exact = new Set(VALIDATES_BEFORE_AUTH);
    expect([...refusedBeforeAuth].sort(), "validate-before-auth handlers, exactly").toEqual([...exact].sort());
    expect(
      [...refusedByPin].sort(),
      "every other pinned handler reaches the pin",
    ).toEqual(PINNED.map((r) => `${r.method} ${r.path}`).filter((l) => !exact.has(l)).sort());
  });

  it("withdrawn / archived is not missing: C's own key still reaches its withdrawn entrant and registration and archived division; A's key is still refused", async () => {
    const C = await seedWorld(auth, "C");
    await sql`update entrants set status = 'withdrawn' where id = ${C.entrant}`;
    await sql`update registrations set status = 'withdrawn', withdrawn_at = now() where id = ${C.registration}`;
    await sql`update divisions set archived_at = now() where id = ${C.division}`;
    const foreignKey = await pinnedToA("pin sweep withdrawn, A");
    const ownKey = (await createApiKey(auth, { name: "pin sweep withdrawn, C", scopes: ["manage"], competition_id: C.competition }))
      .secret;
    let checked = 0;
    for (const kind of ["entrant", "registration", "division"]) {
      const rule = PINNED.find((r) => addressedKind(r.method, r.path).kind === kind);
      expect(rule, `a pinned row addresses a ${kind}`).toBeDefined();
      const { idSegment } = addressedKind(rule!.method, rule!.path);
      const path = concretePath(rule!.path, idSegment, C[kind]!);
      // Fail-closed turns a resolver that skips withdrawn rows into a lockout:
      // the OWN key is the half that sees it.
      const ctx = await requireOrgAuth(keyed(ownKey, rule!.method, path), auth.orgId, "read");
      expect(ctx.via, `${rule!.method} ${rule!.path}: C's own key`).toBe("api_key");
      await expect(
        requireOrgAuth(keyed(foreignKey, rule!.method, path), auth.orgId, "read"),
        `${rule!.method} ${rule!.path}: A's key`,
      ).rejects.toMatchObject({ status: 403, message: PIN_REFUSAL });
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("POST /pools/:id/clear-entrants answers a missing pool and another org's pool alike — no existence oracle", async () => {
    // The one pinned route whose handler authenticates with requireAuth (org
    // from the key) instead of looking its own resource up first, so the pin
    // is the first thing that sees the id. The resolver's lookups are not
    // org-scoped: fail-open answered another org's pool 403 and a missing one
    // 404 — telling a pinned key which uuids exist anywhere.
    const other = await seedOrg("pro");
    const X = await seedWorld(other.auth, "X");
    const secret = await pinnedToA("pin sweep oracle");
    const ask = async (poolId: string) => {
      const res = await clearPoolEntrantsPOST(keyed(secret, "POST", `/pools/${poolId}/clear-entrants`, { confirm: true }), {
        params: Promise.resolve({ id: poolId }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      return { status: res.status, message: body.error?.message ?? null };
    };
    const before = await fingerprint(X.competition);
    const foreignOrg = await ask(X.pool);
    const missing = await ask(randomUUID());
    const after = await fingerprint(X.competition);
    expect(foreignOrg, "another org's pool").toEqual({ status: 403, message: PIN_REFUSAL });
    expect(missing, "a pool that does not exist answers the same").toEqual(foreignOrg);
    expect(before.n).toBeGreaterThan(0);
    expect(after, "nothing of the other org's was written").toEqual(before);
  });
});
