// Owner ruling 2026-10-26: chess divisions are INDIVIDUAL-ONLY. The usecase
// refusals are proven in server/usecases/__tests__/chess-individual-only.test.ts;
// THIS file is the wire: each public route that reaches one of those writers
// answers 422 with `error.code = CHESS_INDIVIDUAL_ONLY` (not a 500, not the
// older ENTRANT_KIND_NOT_ALLOWED), and the same body on a team sport still
// succeeds. Driven through the real route handlers (request parsing, authz,
// the v1 error envelope) against a real Postgres; skipped without DATABASE_URL.
//
//   PUT   /divisions/{id}/registration-settings   -> putRegistrationSettings
//   POST  /competitions/{id}/divisions            -> createDivision
//   PATCH /divisions/{id}                         -> patchDivision
//   POST  /divisions/{id}/entrants                -> createEntrants
//   POST  /divisions/{id}/entrants (multipart)    -> import preview (pinned alias)
//   POST  /imports/{id}/commit                    -> commitImport
import { afterAll, describe, expect, it, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { CHESS_INDIVIDUAL_ONLY, CHESS_SPORT_KEY } from "@/lib/chess-individual-only";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision, getDivision } from "@/server/usecases/divisions";
import { asOwner, seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { PUT as putSettingsRoute } from "@/app/api/v1/divisions/[id]/registration-settings/route";
import { PATCH as patchDivisionRoute } from "@/app/api/v1/divisions/[id]/route";
import { POST as postEntrantsRoute } from "@/app/api/v1/divisions/[id]/entrants/route";
import { POST as postDivisionRoute } from "@/app/api/v1/competitions/[id]/divisions/route";
import { POST as commitImportRoute } from "@/app/api/v1/imports/[id]/commit/route";

// --- what the engine itself declares (never typed into the test) ----------
// The sport this file proves the positive pair on: a non-chess sport whose own
// module declares the `team` kind (generic declares no model at all, so it is
// excluded — it would prove nothing about a declared rule).
const TEAM_SPORT = builtinModules.find(
  (m) =>
    m.key !== CHESS_SPORT_KEY &&
    m.entrantModel !== undefined &&
    effectiveEntrantModel(m.entrantModel ?? null).kinds.includes("team"),
)!;

async function ensureSport(key: string): Promise<string> {
  const m = builtinModules.find((x) => x.key === key)!;
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

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonReq(method: string, path: string, body: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown> | Record<string, unknown>[] | null;
  error?: { code: string; message: string; rows?: number[] };
}
async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function signedInOwner(): Promise<{ owner: AuthCtx }> {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  return { owner: asOwner(orgId, ownerId) };
}

async function seedDivision(owner: AuthCtx, sport: string, slug: string) {
  const variant = await ensureSport(sport);
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Wire Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, comp.id, {
    name: "Open",
    slug,
    sport_key: sport,
    variant_key: variant,
    config: {},
  } as never);
  return { comp, division };
}

const SETTINGS = { enabled: true, fee_cents: 0, payment_method: "offline" };

/** Which routes actually answered the refusal on the wire (anti-vacuity). */
const refusedOnWire = new Set<string>();
async function expectWireRefusal(res: Response, route: string) {
  const { status, body } = await read(res);
  expect(status, route).toBe(422);
  expect(body.ok, route).toBe(false);
  expect(body.error?.code, route).toBe(CHESS_INDIVIDUAL_ONLY);
  refusedOnWire.add(route);
  return body;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ROUTES = [
  "PUT registration-settings",
  "POST competitions/divisions",
  "PATCH divisions",
  "POST divisions/entrants",
  "POST imports/commit",
] as const;

describe.skipIf(!HAS_DB)("chess individual-only on the wire", () => {
  it("the team sport used for the positive pairs is a real, non-chess sport that declares team", () => {
    expect(TEAM_SPORT).toBeDefined();
    expect(TEAM_SPORT.key).not.toBe(CHESS_SPORT_KEY);
  });

  it("PUT registration-settings: chess team / free agents / solo fee -> 422 CHESS_INDIVIDUAL_ONLY; individual and a team sport still 200", async () => {
    const { owner } = await signedInOwner();
    const chess = await seedDivision(owner, CHESS_SPORT_KEY, "knights");
    const team = await seedDivision(owner, TEAM_SPORT.key, "reds");

    for (const body of [
      { ...SETTINGS, entrant_kind: "team" },
      { ...SETTINGS, entrant_kind: "pair" },
      { ...SETTINGS, entrant_kind: "team", allow_free_agents: true },
      { ...SETTINGS, entrant_kind: "individual", allow_free_agents: true },
    ]) {
      await expectWireRefusal(
        await putSettingsRoute(jsonReq("PUT", `/divisions/${chess.division.id}/registration-settings`, body), ctx(chess.division.id)),
        "PUT registration-settings",
      );
    }

    const ok = await read(
      await putSettingsRoute(
        jsonReq("PUT", `/divisions/${chess.division.id}/registration-settings`, { ...SETTINGS, entrant_kind: "individual" }),
        ctx(chess.division.id),
      ),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ entrant_kind: "individual", allow_free_agents: false });

    // Positive pair: the same team body on a sport that takes teams.
    const teamOk = await read(
      await putSettingsRoute(
        jsonReq("PUT", `/divisions/${team.division.id}/registration-settings`, {
          ...SETTINGS,
          entrant_kind: "team",
          allow_free_agents: true,
        }),
        ctx(team.division.id),
      ),
    );
    expect(teamOk.status).toBe(200);
    expect(teamOk.body.data).toMatchObject({ entrant_kind: "team", allow_free_agents: true });
  });

  it("POST competitions/{id}/divisions: a widened chess config -> 422; the same config on a team sport -> 201", async () => {
    const { owner } = await signedInOwner();
    const comp = await createCompetition(owner, {
      ends_on: "2030-12-31",
      name: "Wire Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
    });
    const chessVariant = await ensureSport(CHESS_SPORT_KEY);
    const teamVariant = await ensureSport(TEAM_SPORT.key);
    const widened = { entrants: { kinds: ["individual", "team"], defaultKind: "team" } };

    await expectWireRefusal(
      await postDivisionRoute(
        jsonReq("POST", `/competitions/${comp.id}/divisions`, {
          name: "Chess Open",
          slug: "chess-open",
          sport_key: CHESS_SPORT_KEY,
          variant_key: chessVariant,
          config: widened,
        }),
        ctx(comp.id),
      ),
      "POST competitions/divisions",
    );
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from divisions where competition_id = ${comp.id}`;
    expect(n).toBe(0);

    const ok = await read(
      await postDivisionRoute(
        jsonReq("POST", `/competitions/${comp.id}/divisions`, {
          name: "Team Open",
          slug: "team-open",
          sport_key: TEAM_SPORT.key,
          variant_key: teamVariant,
          config: widened,
        }),
        ctx(comp.id),
      ),
    );
    expect(ok.status).toBe(201);
  });

  it("PATCH divisions/{id}: widening a chess division -> 422 and the stored config is untouched; a team sport accepts it", async () => {
    const { owner } = await signedInOwner();
    const chess = await seedDivision(owner, CHESS_SPORT_KEY, "knights");
    const team = await seedDivision(owner, TEAM_SPORT.key, "reds");
    const widened = { entrants: { kinds: ["individual", "team"] } };
    const chessBefore = (await getDivision(owner, chess.division.id)).config;
    const teamBefore = (await getDivision(owner, team.division.id)).config as Record<string, unknown>;

    await expectWireRefusal(
      await patchDivisionRoute(
        jsonReq("PATCH", `/divisions/${chess.division.id}`, { config: { ...(chessBefore as object), ...widened } }),
        ctx(chess.division.id),
      ),
      "PATCH divisions",
    );
    expect((await getDivision(owner, chess.division.id)).config).toEqual(chessBefore);

    const ok = await read(
      await patchDivisionRoute(
        jsonReq("PATCH", `/divisions/${team.division.id}`, { config: { ...teamBefore, ...widened } }),
        ctx(team.division.id),
      ),
    );
    expect(ok.status).toBe(200);
  });

  it("POST divisions/{id}/entrants: a chess team (single and bulk) -> 422; chess individual and a team-sport team -> 201", async () => {
    const { owner } = await signedInOwner();
    const chess = await seedDivision(owner, CHESS_SPORT_KEY, "knights");
    const team = await seedDivision(owner, TEAM_SPORT.key, "reds");
    const path = (id: string) => `/divisions/${id}/entrants`;

    await expectWireRefusal(
      await postEntrantsRoute(jsonReq("POST", path(chess.division.id), { kind: "team", display_name: "Blunders FC", members: [] }), ctx(chess.division.id)),
      "POST divisions/entrants",
    );
    await expectWireRefusal(
      await postEntrantsRoute(
        jsonReq("POST", path(chess.division.id), [
          { kind: "individual", display_name: "Fine Player", members: [] },
          { kind: "pair", display_name: "Not Fine", members: [] },
        ]),
        ctx(chess.division.id),
      ),
      "POST divisions/entrants",
    );
    // The bulk request is one transaction: the individual before the pair was not kept.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${chess.division.id}`;
    expect(n).toBe(0);

    const individual = await read(
      await postEntrantsRoute(jsonReq("POST", path(chess.division.id), { kind: "individual", display_name: "Solo Player", members: [] }), ctx(chess.division.id)),
    );
    expect(individual.status).toBe(201);
    expect(individual.body.data).toMatchObject({ kind: "individual" });

    const teamOk = await read(
      await postEntrantsRoute(jsonReq("POST", path(team.division.id), { kind: "team", display_name: "Reds FC", members: [] }), ctx(team.division.id)),
    );
    expect(teamOk.status).toBe(201);
    expect(teamOk.body.data).toMatchObject({ kind: "team" });
  });

  it("CSV: the pinned-alias upload previews the chess row as a blocking issue, and POST imports/{id}/commit -> 422 with the rows named", async () => {
    const { owner } = await signedInOwner();
    const chess = await seedDivision(owner, CHESS_SPORT_KEY, "knights");
    const team = await seedDivision(owner, TEAM_SPORT.key, "reds");
    const upload = async (divisionId: string, slug: string, row: string) => {
      const form = new FormData();
      form.set(
        "file",
        new File([["Club,Team,Player,Division", row].join("\r\n")], "import.csv", { type: "text/csv" }),
      );
      const res = await postEntrantsRoute(
        new Request(`https://test.local/api/v1/divisions/${divisionId}/entrants`, { method: "POST", body: form }),
        ctx(divisionId),
      );
      void slug;
      return read(res);
    };

    const preview = await upload(chess.division.id, "knights", "Acme SC,Acme Chess,Ada One,knights");
    expect(preview.status).toBe(201);
    const data = preview.body.data as unknown as { importId: string; plan: { issues: { code: string; rowNo: number }[] } };
    expect(data.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY)).toHaveLength(1);

    const body = await expectWireRefusal(
      await commitImportRoute(jsonReq("POST", `/imports/${data.importId}/commit`, {}), ctx(data.importId)),
      "POST imports/commit",
    );
    expect(body.error?.rows).toEqual([2]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${chess.division.id}`;
    expect(n).toBe(0);

    // Positive pair: the same upload into a team sport has no chess issue and commits.
    const teamPreview = await upload(team.division.id, "reds", "Borough FC,Borough Reds,Bo Two,reds");
    const teamData = teamPreview.body.data as unknown as { importId: string; plan: { issues: { code: string }[] } };
    expect(teamData.plan.issues.filter((i) => i.code === CHESS_INDIVIDUAL_ONLY)).toEqual([]);
    const committed = await read(
      await commitImportRoute(jsonReq("POST", `/imports/${teamData.importId}/commit`, {}), ctx(teamData.importId)),
    );
    expect(committed.status).toBe(201);
  });

  it("every public route in the ledger answered the chess refusal on the wire (anti-vacuity)", () => {
    expect(ROUTES.length).toBe(5);
    expect([...refusedOnWire].sort()).toEqual([...ROUTES].sort());
  });
});
