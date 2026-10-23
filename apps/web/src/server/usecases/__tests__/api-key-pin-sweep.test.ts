// API-key competition pins, swept at runtime over EVERY pinned key route.
//
// auth.ts resolves a pinned key's competition by looking the URL's resource id
// up in the table the key-route row's `pin` names. A miss is null, and null
// falls through by design: the handler 404s a missing row, so the pin adds no
// existence oracle. A row that declares the WRONG kind therefore misses on
// every lookup, and a key pinned to competition A reads or writes competition
// B. key-scopes.test.ts pins each row's declaration statically; this file
// proves the behaviour with real rows and the real resolver:
//
//  1. the auth door, every pinned row: B's resource is refused by the pin, A's
//     is let through (the positive pair), and B is refused again afterwards;
//  2. the REAL route handler, every pinned row: B's resource is never served
//     and nothing of B's is written. Handlers that parse the body before they
//     authenticate answer 400 to the empty body instead — told apart from a
//     pin that let B through by a control call with a key that does not exist
//     — and are counted, not hidden; their pin is the one (1) proves;
//  3. the sequence: a withdrawn entrant, a withdrawn registration and an
//     archived division in B still resolve to B — "withdrawn" is not "missing".
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

const HAS_DB = !!process.env.DATABASE_URL;

/** auth.ts's refusal, verbatim — a 403 for any other reason is not the pin. */
const PIN_REFUSAL = "This key is pinned to a different competition.";

const PINNED = KEY_ROUTE_RULES.filter((r) => r.pin);

/** Well-formed (`sc_` prefix, so it reaches the key lookup) and unknown. */
const NO_SUCH_KEY = `sc_${"0".repeat(43)}`;

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

function keyed(secret: string, method: string, path: string): Request {
  const withBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(withBody ? { "content-type": "application/json" } : {}),
    },
    ...(withBody ? { body: "{}" } : {}),
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
    expect(refusedByPin.length, "anti-vacuity: handlers that reached the pin").toBeGreaterThan(0);
    expect(refusedByPin.length + refusedBeforeAuth.length).toBe(PINNED.length);
  });

  it("withdrawn / archived is not missing: B's withdrawn entrant and registration and archived division stay refused", async () => {
    const C = await seedWorld(auth, "C");
    await sql`update entrants set status = 'withdrawn' where id = ${C.entrant}`;
    await sql`update registrations set status = 'withdrawn', withdrawn_at = now() where id = ${C.registration}`;
    await sql`update divisions set archived_at = now() where id = ${C.division}`;
    const secret = await pinnedToA("pin sweep withdrawn");
    let checked = 0;
    for (const kind of ["entrant", "registration", "division"]) {
      const rule = PINNED.find((r) => addressedKind(r.method, r.path).kind === kind);
      expect(rule, `a pinned row addresses a ${kind}`).toBeDefined();
      const { idSegment } = addressedKind(rule!.method, rule!.path);
      await expect(
        requireOrgAuth(keyed(secret, rule!.method, concretePath(rule!.path, idSegment, C[kind]!)), auth.orgId, "read"),
        `${rule!.method} ${rule!.path}`,
      ).rejects.toMatchObject({ status: 403, message: PIN_REFUSAL });
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
