// Standalone repro for a real bug found via CI on PR #576 (C5, z3 retirement
// stage B): `scripts/smoke.ts`'s "v4 AI/bracket" checks (~line 9710,
// #396/#399/#401) fail once the AI repair round is routed through the
// placement CP-SAT service instead of z3.
//
// THE SCENARIO: a 4-entrant knockout bracket with a third-place playoff.
// Two semi-finals are DECIDED (home/away known); the final and the 3rd/4th
// playoff are both TBD (null entrants) and, in the reproduced prior, are
// scheduled at the SAME instant — legal on every rule that reads named
// entrants, unsafe on the (up to) four people who could still reach either
// slot (a `person_overlap`, #396's recursive-participant check).
//
// TWO DISTINCT FINDINGS THIS SCRIPT REPRODUCES, in the order they were found:
//
//  1. (FIXED, C5 commit a59a9916) Before the fix, `buildSchedule` was asked
//     to move the free TBD fixture while its two decided semi-finals sat
//     FROZEN (non-violators under C5's "pin what stands" split). Its CP-SAT
//     encoding does not enforce a `dependsOn` edge against a fixture that is
//     frozen via `frozen`/`current` rather than genuinely `.locked` — a real,
//     C4-documented, explicitly out-of-scope-for-C4 gap
//     ("a dependency-encoding gap on a FROZEN feeder... shared with POLISH")
//     that REFLOW can never expose (it freezes EVERY already-placed card, so
//     a dependency edge is always fully inside or fully outside the frozen
//     set) but C5's violator-derived freeze can: a free dependent (the
//     playoff) with an edge to a frozen feeder (a semi-final) is exactly the
//     shape REFLOW never produces. Measured: the playoff landed hours BEFORE
//     its semi-finals finished — a genuine `order_before_feeder` breach.
//     `solveBoard`'s own re-verification correctly refused to call this
//     board "repaired", but it still reached the LLM round carrying a
//     violation the canned repair could not undo.
//     FIX: `solveBoard` now detects a dependency edge with exactly one end
//     in the violator set and the other in the frozen set, and declines the
//     solver attempt entirely before ever calling `buildSchedule`.
//
//  2. (OPEN — the reason PR #576 is parked pending C9) With the fix above,
//     the solver correctly declines this scenario and the round falls
//     through to the LLM repair path — but the LLM (the canned
//     `ai-fixture-server.ts` response, standing in for a real model call)
//     never actually resolves this clash. It never did: the smoke test's own
//     comment records that before #401 introduced ANY solver, this exact
//     clash (two TBD bracket slots reachable by overlapping people) was
//     considered structurally unrepairable by the model, and z3's DIRECT
//     participation was specifically what made it repairable. So declining
//     the solver for this shape does not merely cost latency — it reverts
//     this shape to genuinely unrepairable, the exact state #401 fixed.
//     Confirmed via this script: `repair: {engine:"llm", solver_ran:false,
//     fallback:"unrepaired"}`, `blocking` still carries all 8 `person_overlap`
//     rows (both TBD fixtures cross-referencing all 4 shared people), and
//     `diff.moved` is empty after 2 full repair rounds.
//
// C9 (docs/superpowers/specs/2026-08-12-release2-prompts/
// C9-decomposed-repair-cpsat.md) is expected to close #2: its decomposition
// keeps a dependency's two ends in the same connected component whenever one
// is frozen, so the playoff and both semis solve together — restoring both
// the solver's ability to fix this directly AND (per `disjointConflictBound`,
// which never touched z3) an honest `minimality` claim. Re-run THIS script
// once C9 lands; a clean `repair: {engine:"optimized", status:"repaired",
// moved:1}` with zero `person_overlap` in `blocking` is the acceptance
// signal for C9's own bracket case, and the smoke.ts assertions at
// `~:9768`/`~:9780` (still failing, deliberately unrelaxed — see PR #576's
// body) should be re-tightened once this script confirms the fix.
//
// USAGE (see docs/runbooks/e2e-local.md for full server setup; this needs a
// running server pointed at a real DB, with SCHEDULING_AI_BASE_URL set to
// wherever this script's OWN embedded fixture server binds — 4319 by
// default, matching `ai-fixture-server.ts`'s `AI_FIXTURE_PORT`):
//
//   SMOKE_BASE=http://127.0.0.1:3200 \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<db> \
//     node --experimental-strip-types scripts/repro-ai-bracket-frozen-feeder.ts
//
// Prints the full `/schedule/ai-plan` response plus a DIAGNOSIS block
// (repair telemetry, blocking conflicts, which fixtures actually moved) —
// deliberately more verbose than a smoke `check()`, since the point of this
// script is root-causing, not gating.
import { startAiFixtureServer } from "../apps/web/e2e/ai-fixture-server.ts";
import postgres from "postgres";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

interface Session {
  cookies: Record<string, string>;
}
const newSession = (): Session => ({ cookies: {} });
const cookieHeader = (s: Session) =>
  Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; ");

async function raw(s: Session, path: string, method = "GET", body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    if (m[2] === "") delete s.cookies[m[1]];
    else s.cookies[m[1]] = m[2];
  }
  const json = await res.json().catch(() => ({ ok: false, error: "no json" }));
  return { status: res.status, json };
}
async function call(s: Session, path: string, method = "GET", body?: unknown) {
  const { json } = await raw(s, path, method, body);
  if ((json).ok === false) throw new Error(`${path}: ${(json).error}`);
  return (json).data;
}
async function signIn(s: Session, email: string) {
  const req = (await call(s, "/api/auth/magic-link", "POST", { email })) as { login_url?: string };
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  return (await call(s, "/api/auth/magic-link/consume", "POST", { token })) as {
    has_org: boolean;
    org_id: string;
    redirect: string;
  };
}
async function v1(s: Session, path: string, method = "GET", body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false }));
  return { status: res.status, json };
}
const v1data = (r: any) => r.json.data;

async function setPlan(orgId: string, plan: string): Promise<void> {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, {
    connection: { search_path: "seazn_club" },
    ssl: false,
    max: 1,
  });
  try {
    const [org] = await sql`select subscription_id from organizations where id = ${orgId}`;
    if (org?.subscription_id) {
      await sql`update subscriptions set plan_key = ${plan}, status = 'active', updated_at = now() where id = ${org.subscription_id}`;
    } else {
      const [group] = await sql`
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(
                 (select m.user_id from org_members m where m.org_id = o.id and m.role = 'owner' order by m.created_at limit 1),
                 o.created_by),
               ${plan}, 'active'
          from organizations o where o.id = ${orgId}
        returning id`;
      await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
}

const tag = "repro" + Date.now().toString(36);

async function seedBracketAiDivision(s: Session, label: string) {
  const comp = v1data(await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }));
  const div = v1data(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const personIds: string[] = [];
  const entrants: unknown[] = [];
  for (const [i, n] of ["A", "B", "C", "D"].entries()) {
    const person = v1data(await v1(s, "/api/v1/persons", "POST", { full_name: `${label} Player ${n} ${tag}`, consent: {} }));
    personIds.push(person.id);
    entrants.push({ kind: "individual", display_name: `${label} ${n}${tag}`, seed: i + 1, members: [{ person_id: person.id }] });
  }
  await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", entrants);
  const stage = v1data(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: { thirdPlace: true } }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-08T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = v1data(await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"));
  return { divId: div.id, personIds, fixtures: gen.fixtures };
}

async function main() {
  console.log("Starting AI fixture server on 4319...");
  const fixture = await startAiFixtureServer();
  try {
    // `pro`, mirroring v4AiSuite: V393 (entitlements v18) deleted `pro_plus`
    // from `plans`, and `plan_key` carries a live FK, so the old literal made
    // this script die on its first write.
    const paid = newSession();
    const paidOrg = (await signIn(paid, `smoke-ai-pro-${tag}@example.com`)).org_id;
    await setPlan(paidOrg, "pro");
    console.log("Session + org ready:", paidOrg);

    const bracket = await seedBracketAiDivision(paid, "AI Bracket");
    console.log("Bracket fixtures:", JSON.stringify(bracket.fixtures, null, 2));

    const tbdIds = new Set(
      bracket.fixtures.filter((f: any) => f.home_entrant_id === null && f.away_entrant_id === null).map((f: any) => f.id),
    );
    const decided = bracket.fixtures.filter((f: any) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    console.log("tbdIds:", [...tbdIds]);
    console.log("decided count:", decided.length);

    const clashingPrior = [
      ...decided.map((f: any, i: number) => ({
        fixture_id: f.id,
        scheduled_at: "2026-10-08T09:00:00.000Z",
        court_label: i === 0 ? "A" : "B",
      })),
      ...[...tbdIds].map((id: any, i: number) => ({
        fixture_id: id,
        scheduled_at: "2026-10-08T09:30:00.000Z",
        court_label: i === 0 ? "A" : "B",
      })),
    ];
    console.log("clashingPrior:", JSON.stringify(clashingPrior, null, 2));

    const refinedRes = await v1(paid, `/api/v1/divisions/${bracket.divId}/schedule/ai-plan`, "POST", {
      instruction: "keep these kick-off times, they suit the venue",
      mode: "refine",
      prior: { instruction: "the organiser's own timetable", assignments: clashingPrior },
    });
    console.log("=== FULL RESPONSE ===");
    console.log("status:", refinedRes.status);
    console.log(JSON.stringify(refinedRes.json, null, 2));

    const refined = refinedRes.json.data;
    const placedTbd = (refined?.proposal ?? []).filter((a: any) => tbdIds.has(a.fixture_id));
    console.log("=== DIAGNOSIS ===");
    console.log("tbdIds.size:", tbdIds.size);
    console.log("placedTbd.length:", placedTbd.length);
    console.log("repair:", JSON.stringify(refined?.repair));
    console.log("blocking:", JSON.stringify(refined?.blocking));
    console.log("warnings:", JSON.stringify(refined?.warnings));
    console.log("diff.moved:", JSON.stringify(refined?.diff?.moved));
    console.log("fixture.calls phases:", fixture.calls?.map((c: any) => c.phase));
  } finally {
    await fixture.close?.();
  }
}

await main();
