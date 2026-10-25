// W2d Task 7 (B1, PS-8) — the pre-W2d pin scenario.
//
// `seed` builds one deterministic scenario over the REAL HTTP door (API v1): one complete and one active stage per
// sport family, a stage carrying the W2c `{base, bonuses, forfeit}` points shape, two pending stages, a division with
// its own tie-break list, the shoot-out/overtime/no-result/walkover/3-2 results each family's table pays for. `read`
// captures every stage's table (GET /api/v1/stages/{id}/standings) beside the ids, configs and rngSeeds, plus the
// scenario org's stored rows, as the JSON `apps/web/src/server/engine-db/__tests__/fixtures/w2d-pin-before.json`.
//
// It is run ONCE, against a server built at the pre-W2d tree (W2D_BASE e97823e4d8), on a throwaway local env — never
// against staging or production. The capture is the oracle the B1 pin is proved against: the tables the pre-W2d
// payers produced, not values typed from W2d's own code.
//
//   node --experimental-strip-types scripts/w2d/pin-scenario.ts seed
//   node --experimental-strip-types scripts/w2d/pin-scenario.ts read <out.json>
//
// Requires SMOKE_BASE (the server) and DATABASE_URL (the SAME env's database: the plan flip before any division, and
// the stored-row capture `read` writes for the seeding twin, which needs columns no API returns — the fixtures' frozen
// config snapshots, the folded match states, the event ledgers).
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const EMAIL = "delivered+w2d-pin@resend.dev";
const COMPETITIONS = ["W2D Pin Scenario One", "W2D Pin Scenario Two"];

// ---------------------------------------------------------------------------
// HTTP (the scripts/smoke-sports.ts shapes)
// ---------------------------------------------------------------------------

const cookies: Record<string, string> = {};

interface V1Res {
  status: number;
  json: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } | string };
}

async function v1(path: string, method = "GET", body?: unknown): Promise<V1Res> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: BASE,
        ...(Object.keys(cookies).length
          ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const m = sc.match(/^([^=]+)=([^;]*)/);
      if (!m) continue;
      if (m[2] === "") delete cookies[m[1]];
      else cookies[m[1]] = m[2];
    }
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
    return { status: res.status, json };
  }
}

async function must<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await v1(path, method, body);
  if (!r.json.ok) {
    const e = r.json.error;
    const detail = typeof e === "string" ? e : `${e?.code ?? ""} ${e?.message ?? ""}`;
    throw new Error(`${method} ${path} → ${r.status} ${detail}`);
  }
  return r.json.data as T;
}

/** A list read: an array, or a keyset `Page` (`{items, nextCursor}`, api-v1/http.ts) that must fit one page. */
async function list<T>(path: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const data = await must<T[] | { items: T[]; nextCursor: string | null }>(`${path}${sep}limit=200`);
  if (Array.isArray(data)) return data;
  if (data.nextCursor) throw new Error(`${path}: more than one page`);
  return data.items;
}

async function signIn(): Promise<string> {
  const req = await must<{ login_url?: string }>("/api/auth/magic-link", "POST", { email: EMAIL });
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  const ver = await must<{ org_id: string }>("/api/auth/magic-link/consume", "POST", { token });
  return ver.org_id;
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error("pin-scenario runs against a LOCAL database only (never staging or production)");
  }
  return postgres(url, { connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" }, ssl: false, max: 1 });
}

/** Billing lives on the group (V310) — the same flip scripts/smoke-sports.ts makes before any division exists. */
async function setPlanPro(orgId: string): Promise<void> {
  const sql = db();
  try {
    const [org] = await sql<{ subscription_id: string | null }[]>`select subscription_id from organizations where id = ${orgId}`;
    if (org?.subscription_id) {
      await sql`update subscriptions set plan_key = 'pro', status = 'active', updated_at = now() where id = ${org.subscription_id}`;
    } else {
      const [group] = await sql<{ id: string }[]>`
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce((select m.user_id from org_members m where m.org_id = o.id and m.role = 'owner'
                          order by m.created_at limit 1), o.created_by), 'pro', 'active'
          from organizations o where o.id = ${orgId}
        returning id`;
      await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

/**
 * One result, keyed by the pair it is between ("AB": A against B). "a-b" is the first-named side's score then the
 * second's — goals, runs class, sets or games, by sport. Suffixes: "so:X" the level match goes to a shoot-out X wins,
 * "ot:X" an overtime goal by X. "wo:X": X is awarded a walkover (the other side never arrives). "nr": cricket no result
 * (abandoned before a result). "abandon": an abandon after the start (a two-innings cricket draw, carrom's share).
 */
type Results = Record<string, string>;

interface StageSpec {
  name: string;
  kind: "league" | "swiss";
  target: "complete" | "active" | "pending";
  config?: Record<string, unknown>;
  results?: Results;
  /** Swiss: each round's results in the round's fixture order, home side's score first ("2-0" home wins, "1-2" away). */
  swiss?: string[][];
}

interface Family {
  key: string;
  sport: string;
  variant: string;
  entrantKind: "team" | "individual";
  entrants: number;
  config?: Record<string, unknown>;
  tiebreakers?: string[];
  stages: StageSpec[];
}

// Templates. Every stage is built to need a key past `points` somewhere in its table AND to end one group on the
// cascade's last key (a residual tie: lots, seed, or nothing left), so the capture witnesses the whole cascade.
//
// T_G (draw sports, 4 sides, complete): A and D level on points, split by a later key; B and C level on everything.
const T_G: Results = { AB: "3-0", AC: "3-0", DB: "1-0", DC: "1-0", BC: "1-1", AD: "2-2" };
const T_G_ACTIVE: Results = { AB: "3-0", AC: "3-0", DB: "1-0", DC: "1-0", BC: "1-1" };
// T6C (6 sides, complete round robin) for the sports a 4-side table cannot hold both in — no draw, or every level
// match settled by a shoot-out: B, C and D are a symmetric cycle (each beats the next by `cycle`, and meets A, E and F
// alike), so they stay level on everything; A and E are level on points by different routes, split by a later key.
const t6c = (cycle: (first: string) => string, win: string, big: string, extra: Results = {}): Results => ({
  BC: cycle("B"), CD: cycle("C"), DB: cycle("D"),
  AB: win, AC: win, AD: win, EB: win, EC: win, ED: win, BF: win, CF: win, DF: win,
  AE: big, FA: win, EF: win,
  ...extra,
});
const so = (first: string) => `1-1so:${first}`;
const by = (score: string) => () => score;
// T6 (6 sides, active — most meetings unplayed): A and B/C/D level on points, A split by a margin key; B, C and D
// never meet and win alike, so they stay level on everything.
const t6 = (big: string, win: string, extra: Results = {}): Results => ({ AE: big, BF: win, CE: win, DF: win, ...extra });

// Swiss results by round (pairings are the generator's: a result is given per seat, not per pair).
const SWISS_C = [["2-0", "2-0", "2-0"], ["2-0", "2-0", "2-0"], ["2-0", "2-0", "2-0"]];
const SWISS_A = [["2-0", "2-1", "2-0"], ["1-2", "2-0", "2-0"], ["2-0", "2-0", "2-0"]];

let rng = 7000;
const seeded = (extra: Record<string, unknown> = {}) => ({ rngSeed: ++rng, ...extra });

const FAMILIES: Family[] = [
  // Football: a played group shoot-out under the W2c split (2/1), a split whose loss is not the draw (2/0), the
  // one-key cfg the pre-W2d payer ignored (PS-8d), and a pending stage under a shoot-out division with no rule of its own.
  {
    key: "football-so", sport: "football", variant: "11-a-side", entrantKind: "team", entrants: 6,
    config: { shootout: true, points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } },
    stages: [{ name: "Group", kind: "league", target: "complete", config: seeded(), results: t6c(so, "1-0", "2-0") }],
  },
  {
    key: "football-so0", sport: "football", variant: "11-a-side", entrantKind: "team", entrants: 6,
    config: { shootout: true, points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 0 } },
    stages: [{ name: "Group", kind: "league", target: "active", config: seeded(), results: t6("3-0", "1-1so:B", { CE: "1-1so:C", DF: "1-1so:D" }) }],
  },
  {
    key: "football-onekey", sport: "football", variant: "11-a-side", entrantKind: "team", entrants: 6,
    config: { shootout: true, points: { win: 3, draw: 1, loss: 0, shootoutWin: 2 } },
    stages: [{ name: "Group", kind: "league", target: "active", config: seeded(), results: t6("3-0", "1-1so:B", { CE: "1-1so:C", DF: "1-1so:D" }) }],
  },
  {
    key: "generic-legacy", sport: "generic", variant: "score", entrantKind: "individual", entrants: 6,
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    stages: [
      {
        // The W2c `{base, bonuses, forfeit}` shape (pre-W2d margin bonuses need the generic for/against ledger —
        // football's gf/ga alias is W2d F11's), with a walkover the forfeit row pays.
        name: "League", kind: "league", target: "active",
        config: seeded({
          points: {
            base: { win: 3, draw: 1, loss: 0 },
            bonuses: [{ when: "loss_margin_lte", param: 1, points: 1 }],
            forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] },
          },
        }),
        results: t6("3-0", "1-0", { EF: "wo:E" }),
      },
      { name: "Final round", kind: "league", target: "pending", config: { points: { base: { win: 2, draw: 1, loss: 0 } } } },
    ],
  },
  {
    key: "football-pending", sport: "football", variant: "11-a-side", entrantKind: "team", entrants: 4,
    config: { shootout: true, points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } },
    stages: [{ name: "Group", kind: "league", target: "pending", config: seeded() }],
  },
  // Field hockey: the Pro League preset (shoot-out, 2/1) and outdoor draws.
  {
    key: "hockey-pro", sport: "hockey", variant: "fih-shootout", entrantKind: "team", entrants: 6,
    stages: [{ name: "Pool", kind: "league", target: "complete", config: seeded(), results: t6c(so, "1-0", "2-0") }],
  },
  {
    key: "hockey-outdoor", sport: "hockey", variant: "fih-outdoor", entrantKind: "team", entrants: 4,
    stages: [{ name: "Pool", kind: "league", target: "active", config: seeded(), results: T_G_ACTIVE }],
  },
  // Ice hockey: IIHF 3/2/1/0 with overtime and the GWS, and a cfg whose shoot-out split differs from its overtime one.
  {
    key: "icehockey-iihf", sport: "icehockey", variant: "iihf", entrantKind: "team", entrants: 6,
    stages: [{
      name: "Group", kind: "league", target: "complete", config: seeded(),
      results: t6c(so, "1-0", "2-0", { AE: "1-1ot:A", FA: "1-1ot:F", EF: "1-1ot:E" }),
    }],
  },
  {
    key: "icehockey-split", sport: "icehockey", variant: "iihf", entrantKind: "team", entrants: 6,
    config: { points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, shootoutWin: 2, shootoutLoss: 0 } },
    stages: [{ name: "Group", kind: "league", target: "active", config: seeded(), results: t6("2-2ot:A", "1-1so:B", { CE: "1-1so:C", DF: "1-1so:D" }) }],
  },
  // Cricket: ties (T20 default points), a no result under points where tie and no result differ, and two-innings
  // draws under points with no `draw` key (the pre-W2d payer paid the tie's).
  {
    key: "cricket-t20", sport: "cricket", variant: "t20", entrantKind: "team", entrants: 4,
    stages: [{ name: "Group", kind: "league", target: "complete", config: seeded(), results: T_G }],
  },
  {
    key: "cricket-nr", sport: "cricket", variant: "t20", entrantKind: "team", entrants: 6,
    config: { points: { win: 4, tie: 2, noResult: 1, loss: 0 } },
    stages: [{ name: "Group", kind: "league", target: "active", config: seeded(), results: t6("3-0", "1-0", { EF: "nr" }) }],
  },
  {
    key: "cricket-test", sport: "cricket", variant: "test", entrantKind: "team", entrants: 6,
    config: { points: { win: 12, tie: 6, noResult: 4, loss: 0 } },
    stages: [{ name: "Series", kind: "league", target: "active", config: seeded(), results: t6("3-0", "abandon") }],
  },
  // Volleyball: FIVB 3-2 = 2:1 (the complete stage's cycle is all 3-2).
  {
    key: "volleyball-c", sport: "volleyball", variant: "indoor", entrantKind: "team", entrants: 6,
    stages: [{ name: "Pool", kind: "league", target: "complete", config: seeded(), results: t6c(by("3-2"), "3-1", "3-0", { EF: "3-1" }) }],
  },
  {
    key: "volleyball-a", sport: "volleyball", variant: "indoor", entrantKind: "team", entrants: 6,
    stages: [{ name: "Pool", kind: "league", target: "active", config: seeded(), results: t6("3-0", "3-1", { EF: "3-2" }) }],
  },
  // Badminton: Swiss, as production runs it (rounds only — no rngSeed, no pairing key).
  {
    key: "badminton-swiss-c", sport: "badminton", variant: "bwf", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Swiss", kind: "swiss", target: "complete", config: { rounds: 3 }, swiss: SWISS_C }],
  },
  {
    key: "badminton-swiss-a", sport: "badminton", variant: "bwf", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Swiss", kind: "swiss", target: "active", config: { rounds: 3 }, swiss: SWISS_A }],
  },
  // Table tennis: walkovers (pre-W2d: every loss 0).
  {
    key: "tabletennis-c", sport: "tabletennis", variant: "bo5", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Group", kind: "league", target: "complete", config: seeded(), results: t6c(by("3-1"), "3-1", "3-0", { EF: "wo:E" }) }],
  },
  {
    key: "tabletennis-a", sport: "tabletennis", variant: "bo5", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Group", kind: "league", target: "active", config: seeded(), results: t6("3-0", "3-1", { EF: "wo:E" }) }],
  },
  {
    key: "tennis-c", sport: "tennis", variant: "tour", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Round robin", kind: "league", target: "complete", config: seeded(), results: t6c(by("2-1"), "2-0", "2-0", { FA: "2-1" }) }],
  },
  {
    key: "tennis-a", sport: "tennis", variant: "tour", entrantKind: "individual", entrants: 6,
    stages: [{ name: "Round robin", kind: "league", target: "active", config: seeded(), results: t6("2-0", "2-1") }],
  },
  // Chess: a league with no rngSeed (lots without one), and an active one with a draw.
  {
    key: "chess-c", sport: "boardgame", variant: "classical", entrantKind: "individual", entrants: 6,
    stages: [{ name: "League", kind: "league", target: "complete", results: t6c(by("1-0"), "1-0", "1-0") }],
  },
  {
    key: "chess-a", sport: "boardgame", variant: "rapid", entrantKind: "individual", entrants: 6,
    stages: [{
      name: "League", kind: "league", target: "active", config: seeded(),
      results: { AB: "1-0", CD: "1-0", BE: "1-0", DF: "1-1", EF: "1-1" },
    }],
  },
  // Carrom: ICF play, and the drawn-game house rule with an abandon shared as a draw.
  {
    key: "carrom-c", sport: "carrom", variant: "icf", entrantKind: "individual", entrants: 6,
    stages: [{ name: "League", kind: "league", target: "complete", config: seeded(), results: t6c(by("2-1"), "2-0", "2-0", { FA: "2-1" }) }],
  },
  {
    key: "carrom-a", sport: "carrom", variant: "icf", entrantKind: "individual", entrants: 6,
    config: { tieBoard: "draw", abandonPolicy: "share" },
    stages: [{ name: "League", kind: "league", target: "active", config: seeded(), results: t6("2-0", "2-1", { EF: "abandon" }) }],
  },
  // Generic: scores with draws, and a division with its own tie-break list.
  {
    key: "generic-c", sport: "generic", variant: "score", entrantKind: "individual", entrants: 4,
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    stages: [{ name: "League", kind: "league", target: "complete", config: seeded(), results: T_G }],
  },
  {
    key: "generic-a", sport: "generic", variant: "score", entrantKind: "individual", entrants: 4,
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    tiebreakers: ["points", "wins", "diff", "for", "lots"],
    stages: [{ name: "League", kind: "league", target: "active", config: seeded(), results: T_G_ACTIVE }],
  },
  // Football draws: no shoot-out family above draws a match, so the pin's football `draw` needs a stage of its own.
  // Last in the list, so every other family keeps its rngSeed.
  {
    key: "football-draw", sport: "football", variant: "11-a-side", entrantKind: "team", entrants: 4,
    stages: [{ name: "Group", kind: "league", target: "complete", config: seeded(), results: T_G }],
  },
];

// ---------------------------------------------------------------------------
// Playing a result
// ---------------------------------------------------------------------------

interface Ev {
  type: string;
  payload: unknown;
}
interface Fx {
  id: string;
  home_entrant_id: string;
  away_entrant_id: string;
}
interface FixtureState {
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; method?: string } | null;
  last_seq: number;
  state: { phase?: string } | null;
}

const state = (id: string) => must<FixtureState>(`/api/v1/fixtures/${id}/state`);

async function append(fx: Fx, evs: Ev[]): Promise<FixtureState> {
  let seq = (await state(fx.id)).last_seq;
  for (const ev of evs) {
    const r = await v1(`/api/v1/fixtures/${fx.id}/events`, "POST", { expected_seq: seq, type: ev.type, payload: ev.payload });
    if (!r.json.ok) {
      const e = r.json.error;
      throw new Error(`${ev.type} ${JSON.stringify(ev.payload)} → ${r.status} ${typeof e === "string" ? e : `${e?.code} ${e?.message}`}`);
    }
    seq = (r.json.data as { seq: number }).seq;
  }
  return state(fx.id);
}

interface Parsed {
  kind: "score" | "wo" | "nr" | "abandon";
  home: number;
  away: number;
  so?: "home" | "away";
  ot?: "home" | "away";
  wo?: "home" | "away";
}

/** A result from the pair's own orientation onto the fixture's home/away. */
function orient(results: Results, letterOf: Map<string, string>, fx: Fx): Parsed | null {
  const h = letterOf.get(fx.home_entrant_id)!;
  const a = letterOf.get(fx.away_entrant_id)!;
  const key = results[h + a] !== undefined ? h + a : results[a + h] !== undefined ? a + h : null;
  if (key === null) return null;
  const spec = results[key];
  const flipped = key !== h + a; // the spec's first side is the fixture's AWAY side
  const side = (letter: string): "home" | "away" => (letter === h ? "home" : "away");
  if (spec === "nr") return { kind: "nr", home: 0, away: 0 };
  if (spec === "abandon") return { kind: "abandon", home: 0, away: 0 };
  if (spec.startsWith("wo:")) return { kind: "wo", home: 0, away: 0, wo: side(spec.slice(3)) };
  const m = spec.match(/^(\d+)-(\d+)(?:(so|ot):([A-Z]))?$/);
  if (!m) throw new Error(`bad result spec ${spec}`);
  const [first, second] = [Number(m[1]), Number(m[2])];
  const out: Parsed = { kind: "score", home: flipped ? second : first, away: flipped ? first : second };
  if (m[3] === "so") out.so = side(m[4]);
  if (m[3] === "ot") out.ot = side(m[4]);
  return out;
}

const START: Ev = { type: "core.start", payload: {} };
const sideId = (fx: Fx, side: "home" | "away") => (side === "home" ? fx.home_entrant_id : fx.away_entrant_id);
const other = (side: "home" | "away"): "home" | "away" => (side === "home" ? "away" : "home");

/** Shoot-out attempts, home first, the winner scoring every one and the loser none, until the fold decides. */
async function shootout(fx: Fx, type: string, winner: "home" | "away", payloadOf: (by: string, scored: boolean) => unknown): Promise<FixtureState> {
  let st = await state(fx.id);
  for (let round = 0; round < 12 && st.outcome === null; round++) {
    for (const side of ["home", "away"] as const) {
      if (st.outcome !== null) break;
      st = await append(fx, [{ type, payload: payloadOf(sideId(fx, side), side === winner) }]);
    }
  }
  return st;
}

/** The period kernel's next marker (`periodLabels` / `otLabels`): Q1..Q4, H1..H2 or P1..Pn, then FT; OT then FT. */
function nextMarker(phase: string, periods: number): string {
  const m = phase.match(/^([QHP])(\d)$/);
  if (m) return Number(m[2]) < periods ? `${m[1]}${Number(m[2]) + 1}` : "FT";
  if (/^OT\d*$/.test(phase)) return "FT";
  throw new Error(`no advance from phase ${phase}`);
}

const goalsEvents = (fx: Fx, type: string, p: Parsed, extra: (i: number) => Record<string, unknown>): Ev[] => [
  ...Array.from({ length: p.home }, (_, i) => ({ type, payload: { by: fx.home_entrant_id, ...extra(i) } })),
  ...Array.from({ length: p.away }, (_, i) => ({ type, payload: { by: fx.away_entrant_id, ...extra(p.home + i) } })),
];

async function playFootball(fx: Fx, p: Parsed): Promise<FixtureState> {
  await append(fx, [
    START,
    ...goalsEvents(fx, "football.goal", p, (i) => ({ minute: 10 + i * 3 })),
    { type: "football.period", payload: { phase: "HT" } },
    { type: "football.period", payload: { phase: "FT" } },
  ]);
  if (p.so) return shootout(fx, "football.shootout.kick", p.so, (by, scored) => ({ by, scored }));
  return state(fx.id);
}

async function playPeriod(fx: Fx, p: Parsed, sport: string, periods: number): Promise<FixtureState> {
  let st = await append(fx, [START, ...goalsEvents(fx, `${sport}.goal`, p, () => ({}))]);
  // Regulation, then (ice hockey) the overtime the level score opens.
  while (st.outcome === null && st.state?.phase !== "SHOOTOUT") {
    const phase = st.state?.phase ?? "";
    if (/^OT\d*$/.test(phase) && p.ot) {
      st = await append(fx, [{ type: `${sport}.goal`, payload: { by: sideId(fx, p.ot) } }]);
      continue;
    }
    st = await append(fx, [{ type: `${sport}.period.advance`, payload: { to: nextMarker(phase, periods) } }]);
  }
  if (st.outcome === null && p.so) {
    return shootout(fx, `${sport}.shootout.attempt`, p.so, (by, scored) => ({ by, scored }));
  }
  return st;
}

async function playCricket(fx: Fx, p: Parsed, twoInnings: boolean): Promise<FixtureState> {
  if (p.kind === "nr" || p.kind === "abandon") {
    return append(fx, [START, { type: "core.abandon", payload: { reason: "rain" } }]);
  }
  if (p.home === p.away) {
    // A tie: home bats first (no toss), both sides 140 off the full quota.
    return append(fx, [
      START,
      { type: "cricket.innings.summary", payload: { runs: 140, wickets: 6, legalBalls: 120 } },
      { type: "cricket.innings.summary", payload: { runs: 140, wickets: 9, legalBalls: 120 } },
    ]);
  }
  const winner = p.home > p.away ? "home" : "away";
  if (twoInnings) {
    // A two-innings win: the winner bats first and leads after each pair of innings (no follow-on: lead < 200).
    return append(fx, [
      { type: "cricket.toss", payload: { wonBy: sideId(fx, winner), elected: "bat" } },
      START,
      { type: "cricket.innings.summary", payload: { runs: 300, wickets: 10, legalBalls: 540 } },
      { type: "cricket.innings.summary", payload: { runs: 250, wickets: 10, legalBalls: 480 } },
      { type: "cricket.innings.summary", payload: { runs: 200, wickets: 10, legalBalls: 420 } },
      { type: "cricket.innings.summary", payload: { runs: 150, wickets: 10, legalBalls: 360 } },
    ]);
  }
  const big = Math.abs(p.home - p.away) >= 2;
  // The winner wins the toss and bats first, so both margin classes read the same from either side.
  return append(fx, [
    { type: "cricket.toss", payload: { wonBy: sideId(fx, winner), elected: "bat" } },
    START,
    { type: "cricket.innings.summary", payload: big ? { runs: 180, wickets: 4, legalBalls: 120 } : { runs: 150, wickets: 6, legalBalls: 120 } },
    { type: "cricket.innings.summary", payload: big ? { runs: 120, wickets: 10, legalBalls: 100 } : { runs: 145, wickets: 8, legalBalls: 120 } },
  ]);
}

const SET_SCORES: Record<string, { type: string; win: [number, number]; last: [number, number] }> = {
  volleyball: { type: "volleyball.set.summary", win: [25, 20], last: [15, 10] },
  badminton: { type: "badminton.game.summary", win: [21, 15], last: [21, 15] },
  tabletennis: { type: "tabletennis.game.summary", win: [11, 7], last: [11, 7] },
  tennis: { type: "tennis.set_summary", win: [6, 3], last: [6, 3] },
};

/** Sets alternating winner/loser from the winner, the winner always taking the last; the deciding set (best of 5:
 *  the fifth) scored to its own target. */
function setSequence(p: Parsed): ("home" | "away")[] {
  const winner = p.home > p.away ? "home" : "away";
  const [w, l] = winner === "home" ? [p.home, p.away] : [p.away, p.home];
  const seq: ("home" | "away")[] = [];
  let ww = 0;
  let ll = 0;
  while (ww < w || ll < l) {
    if (ll < l && (ww >= w - 1 || seq.length % 2 === 1)) {
      seq.push(other(winner));
      ll++;
    } else {
      seq.push(winner);
      ww++;
    }
  }
  return seq;
}

async function playSets(fx: Fx, p: Parsed, sport: string): Promise<FixtureState> {
  const def = SET_SCORES[sport];
  const seq = setSequence(p);
  const total = p.home + p.away;
  const evs = seq.map((won, i) => {
    const deciding = sport === "volleyball" && i === 4 && total === 5;
    const [a, b] = deciding ? def.last : def.win;
    return { type: def.type, payload: won === "home" ? { home: a, away: b } : { home: b, away: a } };
  });
  return append(fx, [START, ...evs]);
}

async function playCarrom(fx: Fx, p: Parsed): Promise<FixtureState> {
  if (p.kind === "abandon") return append(fx, [START, { type: "core.abandon", payload: { reason: "power cut" } }]);
  const games = setSequence(p);
  const boards: Ev[] = games.flatMap((won) =>
    Array.from({ length: 3 }, () => ({
      type: "carrom.board.summary",
      payload: { winner: sideId(fx, won), opponentCoinsLeft: 9, queenTo: sideId(fx, won) },
    })),
  );
  return append(fx, [START, ...boards]);
}

async function playChess(fx: Fx, p: Parsed): Promise<FixtureState> {
  const payload = p.home === p.away
    ? { winner: null, method: "agreement" }
    : { winner: sideId(fx, p.home > p.away ? "home" : "away") };
  return append(fx, [START, { type: "boardgame.result", payload }]);
}

async function playGeneric(fx: Fx, p: Parsed): Promise<FixtureState> {
  return append(fx, [START, { type: "generic.result", payload: { p1Score: p.home, p2Score: p.away } }]);
}

async function play(sport: string, fx: Fx, p: Parsed, variant = ""): Promise<FixtureState> {
  if (p.kind === "wo") {
    return append(fx, [{ type: "core.forfeit", payload: { by: sideId(fx, other(p.wo!)), reason: "walkover" } }]);
  }
  switch (sport) {
    case "football": return playFootball(fx, p);
    case "hockey": return playPeriod(fx, p, "hockey", 4);
    case "icehockey": return playPeriod(fx, p, "icehockey", 3);
    case "cricket": return playCricket(fx, p, variant === "test");
    case "volleyball":
    case "badminton":
    case "tabletennis":
    case "tennis": return playSets(fx, p, sport);
    case "carrom": return playCarrom(fx, p);
    case "boardgame": return playChess(fx, p);
    case "generic": return playGeneric(fx, p);
  }
  throw new Error(`no player for ${sport}`);
}

/** Guards, not comments: a result that did not land as specified stops the seed. */
function expectLanded(sport: string, p: Parsed, st: FixtureState, fx: Fx, label: string): void {
  const fail = (why: string) => {
    throw new Error(`${label}: ${why} — status ${st.status} outcome ${JSON.stringify(st.outcome)}`);
  };
  if (p.kind === "wo") {
    if (st.outcome?.kind !== "award" || st.outcome.winner !== sideId(fx, p.wo!)) fail("walkover not awarded");
    return;
  }
  if (p.kind === "nr") {
    if (st.outcome?.kind !== "no_result") fail("no result not recorded");
    return;
  }
  if (p.kind === "abandon") {
    if (st.outcome?.kind !== "draw") fail("abandon not a draw");
    return;
  }
  if (p.so || p.ot) {
    const winner = sideId(fx, (p.so ?? p.ot)!);
    const method = p.so ? "shootout" : "extra_time";
    if (st.outcome?.kind !== "win" || st.outcome.winner !== winner || st.outcome.method !== method) fail(`not a ${method} win`);
    return;
  }
  if (p.home === p.away) {
    const level = sport === "cricket" ? "tie" : "draw";
    if (st.outcome?.kind !== level) fail(`not a ${level}`);
    return;
  }
  const winner = sideId(fx, p.home > p.away ? "home" : "away");
  if (st.outcome?.kind !== "win" || st.outcome.winner !== winner) fail("winner wrong");
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

interface Entrant {
  id: string;
  display_name: string;
}

async function seedFamily(compId: string, fam: Family): Promise<void> {
  const div = await must<{ id: string }>(`/api/v1/competitions/${compId}/divisions`, "POST", {
    name: fam.key,
    slug: fam.key,
    sport_key: fam.sport,
    variant_key: fam.variant,
    ...(fam.config ? { config: fam.config } : {}),
    ...(fam.tiebreakers ? { tiebreakers: fam.tiebreakers } : {}),
  });
  const letters = "ABCDEF".slice(0, fam.entrants).split("");
  const entrants = await must<Entrant[]>(
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    letters.map((l, i) => ({ kind: fam.entrantKind, display_name: `${l} ${fam.key}`, seed: i + 1 })),
  );
  const letterOf = new Map(entrants.map((e) => [e.id, e.display_name.split(" ")[0]]));
  const stages: { id: string; spec: StageSpec }[] = [];
  for (const [i, spec] of fam.stages.entries()) {
    const st = await must<{ id: string }>(`/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: i + 1, kind: spec.kind, name: spec.name, config: spec.config ?? {},
    });
    stages.push({ id: st.id, spec });
  }
  const first = stages[0];
  if (first.spec.target === "pending") {
    console.log(`${fam.key}: pending only`);
    return;
  }
  const gen = await must<{ fixtures: Fx[] }>(`/api/v1/stages/${first.id}/generate`, "POST");
  await must(`/api/v1/divisions/${div.id}/start`, "POST");

  if (first.spec.kind === "swiss") {
    await playSwiss(fam, div.id, first, letterOf);
  } else {
    const results = first.spec.results ?? {};
    let played = 0;
    for (const fx of gen.fixtures) {
      const p = orient(results, letterOf, fx);
      if (p === null) continue;
      const st = await play(fam.sport, fx, p, fam.variant);
      expectLanded(fam.sport, p, st, fx, `${fam.key} ${letterOf.get(fx.home_entrant_id)}-${letterOf.get(fx.away_entrant_id)}`);
      played++;
    }
    if (played !== Object.keys(results).length) {
      throw new Error(`${fam.key}: played ${played} of ${Object.keys(results).length} specified results`);
    }
  }
  await settleTarget(fam, div.id, first);
}

/** Swiss: each round's matches take the stage's `swiss` results in fixture order; the active stage stops one match
 *  short of its last round. Each round is read back from the stage's fixtures (the
 *  generator lays every round's shell up front and seats one round per call). */
async function playSwiss(fam: Family, divId: string, stage: { id: string; spec: StageSpec }, letterOf: Map<string, string>): Promise<void> {
  const rounds = Number(stage.spec.config?.rounds ?? 0);
  for (let r = 1; r <= rounds; r++) {
    // The pre-start generate laid every round's shell; each round (the first included) is seated by a generate call
    // made once the division has started.
    await must(`/api/v1/stages/${stage.id}/generate`, "POST");
    // A round's seats land after the call that opens it returns (the shells exist first): poll for them.
    let fixtures: Fx[] = [];
    for (let tries = 0; tries < 40 && fixtures.length === 0; tries++) {
      if (tries > 0) await new Promise((res) => setTimeout(res, 250));
      fixtures = (await list<Fx & { round_no: number; stage_id: string }>(`/api/v1/divisions/${divId}/fixtures`))
        .filter((f) => f.stage_id === stage.id && f.round_no === r && f.home_entrant_id !== null && f.away_entrant_id !== null);
    }
    if (fixtures.length === 0) throw new Error(`${fam.key}: round ${r} seated nobody`);
    const isLast = r === rounds;
    for (const [i, fx] of fixtures.entries()) {
      if (isLast && stage.spec.target === "active" && i === fixtures.length - 1) break;
      const spec = stage.spec.swiss?.[r - 1]?.[i];
      if (spec === undefined) throw new Error(`${fam.key}: no result for round ${r} match ${i + 1}`);
      const [home, away] = spec.split("-").map(Number) as [number, number];
      const p: Parsed = { kind: "score", home, away };
      const st = await play(fam.sport, fx, p);
      expectLanded(fam.sport, p, st, fx, `${fam.key} R${r} ${letterOf.get(fx.home_entrant_id)}-${letterOf.get(fx.away_entrant_id)}`);
    }
  }
}

async function stageStatus(divisionId: string, stageId: string): Promise<string> {
  const stages = await list<{ id: string; status: string }>(`/api/v1/divisions/${divisionId}/stages`);
  return stages.find((s) => s.id === stageId)?.status ?? "missing";
}

async function settleTarget(fam: Family, divId: string, stage: { id: string; spec: StageSpec }): Promise<void> {
  let status = await stageStatus(divId, stage.id);
  if (stage.spec.target === "complete" && status !== "complete") {
    await must(`/api/v1/stages/${stage.id}/complete`, "POST");
    status = await stageStatus(divId, stage.id);
  }
  if (status !== stage.spec.target) throw new Error(`${fam.key}: stage is ${status}, wanted ${stage.spec.target}`);
  console.log(`${fam.key}: ${stage.spec.name} ${status}`);
}

/** W2D_PIN_ONLY (comma-separated family keys): a trial of some families, under other competition names, on a
 *  throwaway database — how a template is tuned before the capture run. */
const ONLY = process.env.W2D_PIN_ONLY?.split(",") ?? null;

async function seed(): Promise<void> {
  const orgId = await signIn();
  await setPlanPro(orgId);
  if (ONLY) {
    const comp = await must<{ id: string }>("/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2D Pin Trial ${Date.now()}` });
    for (const fam of FAMILIES.filter((f) => ONLY.includes(f.key))) await seedFamily(comp.id, fam);
    return;
  }
  const existing = await list<{ name: string }>("/api/v1/competitions");
  if (existing.length > 0) throw new Error("the scenario org already has competitions: capture from a fresh database");
  const half = Math.ceil(FAMILIES.length / 2);
  for (const [ci, name] of COMPETITIONS.entries()) {
    const comp = await must<{ id: string }>("/api/v1/competitions", "POST", { ends_on: "2030-12-31", name });
    for (const fam of FAMILIES.slice(ci * half, (ci + 1) * half)) {
      await seedFamily(comp.id, fam);
    }
  }
  console.log(`seeded ${FAMILIES.length} divisions for org ${orgId}`);
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** The scenario org's stored rows, every column (`to_jsonb`), in the order the seeding twin inserts them. */
async function storedRows(orgId: string): Promise<Record<string, unknown[]>> {
  const sql = db();
  try {
    const q = async (text: string): Promise<unknown[]> =>
      (await sql.unsafe<{ row: unknown }[]>(text, [orgId])).map((r) => r.row);
    return {
      users: await q(`select to_jsonb(u) as row from users u
                       where u.id = (select created_by from organizations where id = $1)`),
      organizations: await q(`select to_jsonb(o) as row from organizations o where o.id = $1`),
      competitions: await q(`select to_jsonb(c) as row from competitions c where c.org_id = $1 order by c.created_at, c.id`),
      divisions: await q(`select to_jsonb(d) as row from divisions d where d.org_id = $1 order by d.created_at, d.id`),
      stages: await q(`select to_jsonb(s) as row from stages s where s.org_id = $1 order by s.division_id, s.seq`),
      entrants: await q(`select to_jsonb(e) as row from entrants e where e.org_id = $1 order by e.division_id, e.seed, e.id`),
      fixtures: await q(`select to_jsonb(f) as row from fixtures f where f.org_id = $1 order by f.stage_id, f.round_no, f.seq_in_round`),
      match_states: await q(`select to_jsonb(m) as row from match_states m
                              where m.fixture_id in (select id from fixtures where org_id = $1) order by m.fixture_id`),
      score_events: await q(`select to_jsonb(e) as row from score_events e
                              where e.fixture_id in (select id from fixtures where org_id = $1) order by e.fixture_id, e.seq`),
    };
  } finally {
    await sql.end();
  }
}

interface StageOut {
  id: string;
  seq: number;
  kind: string;
  name: string;
  status: string;
  config: Record<string, unknown> | null;
}

async function read(out: string): Promise<void> {
  const orgId = await signIn();
  const comps = (await list<{ id: string; name: string }>("/api/v1/competitions")).filter((c) => COMPETITIONS.includes(c.name));
  if (comps.length !== COMPETITIONS.length) throw new Error(`found ${comps.length} scenario competitions, wanted ${COMPETITIONS.length}`);
  const stages: unknown[] = [];
  for (const comp of comps.sort((a, b) => COMPETITIONS.indexOf(a.name) - COMPETITIONS.indexOf(b.name))) {
    const divisions = await list<{ id: string; slug: string; sport_key: string; variant_key: string; config: unknown; tiebreakers: unknown }>(
      `/api/v1/competitions/${comp.id}/divisions`,
    );
    for (const div of divisions) {
      const fam = FAMILIES.find((f) => f.key === div.slug);
      if (!fam) throw new Error(`unexpected division ${div.slug}`);
      const entrants = await list<{ id: string; display_name: string; seed: number | null }>(`/api/v1/divisions/${div.id}/entrants`);
      for (const st of await list<StageOut>(`/api/v1/divisions/${div.id}/stages`)) {
        const fixtures = st.status === "pending" ? [] : (await list<{ id: string; stage_id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string; round_no: number }>(
          `/api/v1/divisions/${div.id}/fixtures`,
        )).filter((f) => f.stage_id === st.id);
        const table = st.status === "pending" ? null : await must<{ rows: unknown[] }>(`/api/v1/stages/${st.id}/standings`);
        const outcomes = [];
        for (const fx of fixtures) {
          const s = await state(fx.id);
          outcomes.push({ id: fx.id, roundNo: fx.round_no, home: fx.home_entrant_id, away: fx.away_entrant_id, status: s.status, outcome: s.outcome });
        }
        stages.push({
          family: fam.key,
          competitionId: comp.id,
          divisionId: div.id,
          sport: div.sport_key,
          variant: div.variant_key,
          divisionConfig: div.config,
          divisionTiebreakers: div.tiebreakers ?? null,
          stageId: st.id,
          stageSeq: st.seq,
          kind: st.kind,
          name: st.name,
          status: st.status,
          stageConfig: st.config,
          rngSeed: (st.config as { rngSeed?: number } | null)?.rngSeed ?? null,
          entrants: entrants.map((e) => ({ id: e.id, name: e.display_name, seed: e.seed })),
          fixtures: outcomes,
          table: table?.rows ?? null,
        });
      }
    }
  }
  // Each module's own declarations, and what its config schema fills in where a stored config carries no table-points
  // object (`defaultConfig`: the first variant's config without one, parsed) or an empty one (`emptyPoints[key]`: null
  // where the schema refused it). The migration's pre-W2d payer (`w2d_pre_points`) is held to these.
  const POINTS_KEYS = ["points", "pointsMap", "scoring"] as const;
  const parsed = (m: (typeof builtinModules)[number], v: unknown): Record<string, unknown> | null => {
    const r = m.configSchema.safeParse(v);
    return r.success ? (r.data as Record<string, unknown>) : null;
  };
  const declarations = Object.fromEntries(
    builtinModules.map((m) => {
      const first = { ...((Object.values(m.variants ?? {})[0] as Record<string, unknown> | undefined) ?? {}) };
      for (const k of POINTS_KEYS) delete first[k];
      const defaultConfig = parsed(m, first);
      const emptyPoints = Object.fromEntries(
        POINTS_KEYS.filter((k) => defaultConfig !== null && k in defaultConfig).map((k) => [k, parsed(m, { ...first, [k]: {} })?.[k] ?? null]),
      );
      return [m.key, { version: m.version, defaultTiebreakers: m.defaultTiebreakers, variants: m.variants, defaultConfig, emptyPoints }];
    }),
  );
  const doc = {
    scenario: "w2d-pin v1 (scripts/w2d/pin-scenario.ts)",
    w2dBase: process.env.W2D_BASE ?? null,
    capturedAt: new Date().toISOString(),
    orgId,
    declarations,
    stages,
    rows: await storedRows(orgId),
  };
  // The tables and ids pretty-printed for a reader; the stored rows one per line (they are the twin's input, not prose).
  const { rows, ...head } = doc;
  const body = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const rowBlocks = Object.entries(rows).map(
    ([table, list]) => `    ${JSON.stringify(table)}: [\n${list.map((r) => `      ${JSON.stringify(r)}`).join(",\n")}\n    ]`,
  );
  writeFileSync(out, `${body},\n  "rows": {\n${rowBlocks.join(",\n")}\n  }\n}\n`);
  console.log(`wrote ${stages.length} stages to ${out}`);
}

const [mode, out] = process.argv.slice(2);
const run = mode === "seed" ? seed() : mode === "read" && out ? read(out) : Promise.reject(new Error("usage: pin-scenario.ts seed | read <out.json>"));
run.then(
  () => process.exit(0),
  (e: unknown) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
