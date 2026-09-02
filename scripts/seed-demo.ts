// Rich demo seeder: 5 competitions, ≥3 divisions each, every stage format
// (league, league+finals, groups+KO, swiss, knockout, double elim,
// group+stepladder), mixed entrant kinds (individual/team/pair), random
// entrant counts, and results played so standings/fixtures/brackets populate.
//
// Usage (dev server must be running on SEED_BASE, default localhost:3000):
//   npm run seed:demo:setup -- --account=pro         (or --account=community)
//   npm run seed:demo -- --account=pro
//
// Two account flavours: --account=pro gets a real pro subscription row (set
// via DATABASE_URL) and the full 5-competition plan; --account=community
// stays inside the free caps (2 competitions × 1 division) and shows the
// gated/paywalled experience. Accounts land in .seed-demo-state.json
// (gitignored). --phase=seed is resume-safe: rerunning skips competitions/
// divisions that already exist, so tweak the PLANs below and rerun.
import { writeFileSync, readFileSync } from "node:fs";
import { findOrCreateCompetition } from "./seed-resume.ts";
import { TEMPLATES } from "./seed-demo-templates.ts";

const BASE = process.env.SEED_BASE ?? "http://localhost:3000";
const STATE = new URL("./.seed-demo-state.json", import.meta.url).pathname;
const PASSWORD = process.env.SEED_PASSWORD ?? "smokepass123";

const jar = new Map<string, string>();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false)
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`,
    );
  return json.data ?? json;
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const coin = () => Math.random() < 0.5;

// ── name pools ──────────────────────────────────────────────────────────────
const FIRST = [
  "Aarav",
  "Meera",
  "Ishaan",
  "Priya",
  "Rohan",
  "Anaya",
  "Kabir",
  "Diya",
  "Vihaan",
  "Sara",
  "Arjun",
  "Nisha",
  "Ravi",
  "Tara",
  "Dev",
  "Lila",
];
const LAST = [
  "Sharma",
  "Patel",
  "Khan",
  "Nguyen",
  "Iyer",
  "Fernandes",
  "Das",
  "Reddy",
  "Mehta",
  "Bose",
  "Kapoor",
  "Joshi",
  "Rao",
  "Menon",
  "Gill",
  "Nair",
];
const CLUBS = [
  "Riverside",
  "Lakeside",
  "Northfield",
  "Summit",
  "Harbour",
  "Valley",
  "Meadow",
  "Crestwood",
  "Oakwood",
  "Brookfield",
  "Hillcrest",
  "Seaview",
  // P7: the t20-super8 template needs 16 team entrants — every existing
  // caller of entrantsFor("team", n) stayed at n<=8, so 12 was enough until
  // now.
  "Kingswood",
  "Fairview",
  "Ashgrove",
  "Milbrook",
];
let nameCursor = 0;
const person = () => `${FIRST[nameCursor % 16]} ${LAST[(nameCursor++ * 7 + 3) % 16]}`;

function entrantsFor(kind: "individual" | "team" | "pair", n: number) {
  if (kind === "team")
    return CLUBS.slice(0, n).map((c, i) => ({
      kind,
      display_name: `${c} ${coin() ? "FC" : "CC"}`,
      seed: i + 1,
    }));
  if (kind === "pair")
    return Array.from({ length: n }, (_, i) => ({
      kind,
      display_name: `${person().split(" ")[0]} / ${person().split(" ")[0]}`,
      seed: i + 1,
    }));
  return Array.from({ length: n }, (_, i) => ({
    kind,
    display_name: person(),
    seed: i + 1,
  }));
}

// ── per-sport result events (winner side chosen by us) ─────────────────────
type Ev = { type: string; payload: unknown };
// v6 scenario counters — the first ice/FIH/tennis fixtures walk a fixed
// ladder (OT, GWS, PP goal · draw+cards · MTB) so the demo reliably shows
// every new surface; later fixtures randomize.
let iceSeeded = 0;
let fihSeeded = 0;
let tennisSeeded = 0;
// W1 (entitlements v18, owner ruling 2026-08-30): `seedIsPro` is GONE, with
// its four call sites. It existed for exactly one reason — suspension/card
// events were tier-2/3 behind `scoring.match_timeline`, so the community seed
// had to keep its FIH draw and skip the cards or the appends would 402. V390
// deleted that key and the same wave deleted its gate, so the community demo
// org now gets the identical card ladder the pro one does, which is the point:
// the demo is what a prospect looks at to decide whether the free plan can
// score their sport.
function resultEvents(
  sport: string,
  variant: string,
  fx: { home: string; away: string },
  homeWins: boolean,
): Ev[] {
  const w = homeWins ? fx.home : fx.away;
  const l = homeWins ? fx.away : fx.home;
  const events: Ev[] = [{ type: "core.start", payload: {} }];
  switch (sport) {
    case "football": {
      const wg = 1 + rnd(4),
        lg = rnd(wg);
      for (let i = 0; i < wg; i++)
        events.push({
          type: "football.goal",
          payload: { by: w, minute: 5 + rnd(85) },
        });
      for (let i = 0; i < lg; i++)
        events.push({
          type: "football.goal",
          payload: { by: l, minute: 5 + rnd(85) },
        });
      events.push({ type: "football.period", payload: { phase: "HT" } });
      events.push({ type: "football.period", payload: { phase: "FT" } });
      return events;
    }
    case "cricket": {
      // Innings quota per variant: t20 120 balls, hundred 100, odi 300.
      const quota = variant === "hundred" ? 100 : variant === "odi" ? 300 : 120;
      const bpo = variant === "hundred" ? 5 : 6;
      const first = 100 + rnd(80);
      // home wins the toss and bats; homeWins ⇒ chase falls short. Toss must
      // precede core.start, and a progressive innings needs a real open innings.
      events.unshift({
        type: "cricket.toss",
        payload: { wonBy: fx.home, elected: "bat" },
      });
      const chase = homeWins ? first - (5 + rnd(40)) : first + 1 + rnd(20);
      // Over-by-over: a few progressive innings.summary updates (engine
      // enforces monotone growth) — the same event the over-by-over pad emits
      // — then close. Stepped in quarters to keep the seed fast.
      const overBuild = (total: number, wkts: number) => {
        for (let step = 1; step <= 4; step++) {
          events.push({
            type: "cricket.innings.summary",
            payload: {
              runs: Math.round((total * step) / 4),
              wickets: Math.round((wkts * step) / 4),
              legalBalls: Math.round((quota * step) / 4 / bpo) * bpo,
              // progressive; the final step reaches the quota and auto-closes
              // the innings (overs done) — the next innings opens on demand.
              partial: step < 4,
            },
          });
        }
      };
      overBuild(first, 3 + rnd(7));
      overBuild(Math.max(chase, 10), homeWins ? 10 : 3 + rnd(6));
      return events;
    }
    case "boardgame":
      events.push({
        type: "boardgame.result",
        payload: { winner: w, method: coin() ? "checkmate" : "resign" },
      });
      return events;
    case "tennis": {
      // v6/00 §5 demo richness: straight-set wins, with a 7–6 tie-break set
      // now and then; the doubles-noad-mtb10 variant banks a real match
      // tie-break decider ([6–4, 4–6, 10–7]).
      const set = (h: number, a: number, tb?: { home: number; away: number }) =>
        events.push({
          type: "tennis.set_summary",
          payload: { home: h, away: a, ...(tb ? { tb } : {}) },
        });
      const winnerHome = homeWins;
      if (variant === "doubles-noad-mtb10" && tennisSeeded++ % 2 === 0) {
        set(winnerHome ? 6 : 4, winnerHome ? 4 : 6);
        set(winnerHome ? 4 : 6, winnerHome ? 6 : 4);
        set(winnerHome ? 10 : 7, winnerHome ? 7 : 10); // MTB decider
        return events;
      }
      const tbSet = tennisSeeded++ % 3 === 0;
      if (tbSet) {
        set(
          winnerHome ? 7 : 6,
          winnerHome ? 6 : 7,
          winnerHome ? { home: 7, away: 5 } : { home: 5, away: 7 },
        );
      } else {
        // Loser holds 0–4 games: 6–5 is not a terminal score (winBy 2).
        set(winnerHome ? 6 : rnd(5), winnerHome ? rnd(5) : 6);
      }
      set(winnerHome ? 6 : rnd(5), winnerHome ? rnd(5) : 6);
      return events;
    }
    case "icehockey": {
      // Deterministic scenario ladder so the demo always shows an OT game, a
      // GWS game and a 5v4 power-play goal (v6/00 §5), then random ones.
      const scenario = iceSeeded++;
      const goal = (by: string, extra?: Record<string, unknown>) =>
        events.push({
          type: "icehockey.goal",
          payload: { by, ...(extra ?? {}) },
        });
      const adv = (to: string) =>
        events.push({ type: "icehockey.period.advance", payload: { to } });
      if (scenario === 0) {
        // Sudden-death OT winner.
        goal(w);
        goal(l);
        adv("P2");
        goal(l);
        adv("P3");
        goal(w);
        adv("FT");
        goal(w);
        return events;
      }
      if (scenario === 1) {
        // Scoreless OT → GWS decided 3–0 after six attempts.
        goal(w);
        goal(l);
        adv("P2");
        adv("P3");
        adv("FT");
        adv("FT");
        for (let i = 0; i < 3; i++) {
          events.push({
            type: "icehockey.shootout.attempt",
            payload: { by: w, scored: true },
          });
          events.push({
            type: "icehockey.shootout.attempt",
            payload: { by: l, scored: false },
          });
        }
        return events;
      }
      if (scenario === 2) {
        // 5v4 power play: minor, PP goal, scorer-released minor.
        events.push({
          type: "icehockey.suspension.start",
          payload: { by: l, class: "minor" },
        });
        goal(w, { kind: "pp" });
        events.push({
          type: "icehockey.suspension.end",
          payload: { by: l, class: "minor" },
        });
        goal(w);
        adv("P2");
        goal(l);
        adv("P3");
        adv("FT");
        return events;
      }
      const wg = 2 + rnd(3),
        lg = rnd(wg);
      goal(w);
      adv("P2");
      for (let i = 1; i < wg; i++) goal(w, rnd(3) === 0 ? { kind: "sh" } : undefined);
      for (let i = 0; i < lg; i++) goal(l);
      adv("P3");
      adv("FT");
      return events;
    }
    case "hockey": {
      // First FIH game: a draw with a green + yellow card (team-short both
      // times) so the demo shows cards and a drawn league row.
      const scenario = fihSeeded++;
      const goal = (by: string, extra?: Record<string, unknown>) =>
        events.push({ type: "hockey.goal", payload: { by, ...(extra ?? {}) } });
      const adv = (to: string) => events.push({ type: "hockey.period.advance", payload: { to } });
      if (scenario === 0) {
        goal(w, { kind: "pc" });
        events.push({ type: "hockey.suspension.start", payload: { by: l, class: "green" } });
        adv("Q2");
        events.push({ type: "hockey.suspension.end", payload: { by: l, class: "green" } });
        goal(l);
        adv("Q3");
        events.push({ type: "hockey.suspension.start", payload: { by: l, class: "yellow" } });
        adv("Q4");
        events.push({ type: "hockey.suspension.end", payload: { by: l, class: "yellow" } });
        adv("FT"); // level ⇒ draw
        return events;
      }
      const wg = 1 + rnd(3),
        lg = rnd(wg);
      for (let i = 0; i < wg; i++) goal(w, rnd(3) === 0 ? { kind: "pc" } : undefined);
      adv("Q2");
      for (let i = 0; i < lg; i++) goal(l);
      adv("Q3");
      adv("Q4");
      adv("FT");
      return events;
    }
    case "generic":
      events.push({
        type: "generic.result",
        payload: homeWins
          ? { p1Score: 2 + rnd(3), p2Score: rnd(2) }
          : { p1Score: rnd(2), p2Score: 2 + rnd(3) },
      });
      return events;
    default: {
      // Set-based — targets depend on sport AND variant; straight sets keep us
      // clear of deciding-set target differences (e.g. beach final set to 15).
      const params: Record<string, { setTo: number; need: number }> = {
        "volleyball:indoor": { setTo: 25, need: 3 },
        "volleyball:beach": { setTo: 21, need: 2 },
        "badminton:bwf": { setTo: 21, need: 2 },
        "badminton:short": { setTo: 11, need: 2 },
        "tabletennis:bo5": { setTo: 11, need: 3 },
        "tabletennis:bo7": { setTo: 11, need: 4 },
        "tabletennis:hardbat-21": { setTo: 21, need: 3 },
      };
      const { setTo, need } = params[`${sport}:${variant}`] ?? {
        setTo: 21,
        need: 2,
      };
      const evType = sport === "volleyball" ? "volleyball.set.summary" : `${sport}.game.summary`;
      for (let i = 0; i < need; i++) {
        const losing = Math.max(0, setTo - 2 - rnd(setTo - 2));
        events.push({
          type: evType,
          payload: homeWins ? { home: setTo, away: losing } : { home: losing, away: setTo },
        });
      }
      return events;
    }
  }
}

async function decideFixture(
  fixtureId: string,
  sport: string,
  variant: string,
  fx: { home: string; away: string },
) {
  let seq = 0;
  for (const ev of resultEvents(sport, variant, fx, coin())) {
    const r = await call(`/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type: ev.type,
      payload: ev.payload,
    });
    seq = r.seq;
  }
}

interface GenFx {
  id: string;
  round_no?: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/** Decide fixtures round by round, refetching feeds (brackets fill as rounds decide). */
async function playStage(stageId: string, sport: string, variant: string, ratio: number) {
  const gen = await call(`/api/v1/stages/${stageId}/generate`, "POST");
  let fixtures: GenFx[] = gen.fixtures;
  const total = fixtures.length;
  const target = Math.ceil(total * ratio);
  let played = 0;
  const rounds = [...new Set(fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
  for (const round of rounds) {
    for (const f of fixtures.filter((x) => (x.round_no ?? 0) === round)) {
      if (played >= target) return { total, played };
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & {
        status: string;
      };
      if (!cur.home_entrant_id || !cur.away_entrant_id) continue; // unresolved feed / bye
      if (cur.status !== "scheduled") continue; // bye already awarded
      await decideFixture(f.id, sport, variant, {
        home: cur.home_entrant_id,
        away: cur.away_entrant_id,
      });
      played++;
    }
  }
  return { total, played };
}

// ── competition plan ────────────────────────────────────────────────────────
interface DivPlan {
  name: string;
  sport: string;
  variant: string;
  kind: "individual" | "team" | "pair";
  n: number;
  template: keyof typeof TEMPLATES;
  q?: number;
  ratio: number;
  config?: Record<string, unknown>;
}
const GENERIC_CFG = {
  resultMode: "score",
  allowDraws: false,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Pro account: the full spread — every format, mixed kinds, 5 competitions.
const PLAN_PRO: { name: string; divisions: DivPlan[] }[] = [
  {
    name: "Spring Football League",
    divisions: [
      {
        name: "Premier Division",
        sport: "football",
        variant: "11-a-side",
        kind: "team",
        n: 6 + rnd(3),
        template: "league",
        ratio: 1,
      },
      {
        name: "U16 Cup",
        sport: "football",
        variant: "youth",
        kind: "team",
        n: 8,
        template: "league_ko",
        q: 4,
        ratio: 1,
      },
      {
        name: "Sunday 5s",
        sport: "football",
        variant: "small-sided",
        kind: "team",
        n: 5 + rnd(3),
        template: "league",
        ratio: 0.5,
      },
    ],
  },
  {
    name: "Racquet Masters",
    divisions: [
      {
        name: "Badminton Singles",
        sport: "badminton",
        variant: "bwf",
        kind: "individual",
        n: 7 + rnd(4),
        template: "league",
        ratio: 0.7,
      },
      {
        name: "TT Doubles",
        sport: "tabletennis",
        variant: "bo5",
        kind: "pair",
        n: 8,
        template: "groups_ko",
        q: 4,
        ratio: 1,
      },
      {
        name: "Badminton Juniors",
        sport: "badminton",
        variant: "short",
        kind: "individual",
        n: 8,
        template: "knockout",
        ratio: 1,
      },
      // v6: tennis on the nested kernel — tour singles (TB sets in the mix)
      // and the ITF doubles norm with a seeded match-tie-break decider.
      {
        name: "Tennis Singles",
        sport: "tennis",
        variant: "tour",
        kind: "individual",
        n: 6,
        template: "league",
        ratio: 0.8,
      },
      {
        name: "Tennis Doubles",
        sport: "tennis",
        variant: "doubles-noad-mtb10",
        kind: "pair",
        n: 4,
        template: "league",
        ratio: 1,
      },
    ],
  },
  // v6: ice hockey on the period kernel — the scenario ladder seeds an OT
  // game, a GWS game and a 5v4 power-play goal (v6/00 §5).
  {
    name: "Winter Ice Classic",
    divisions: [
      {
        name: "IIHF Division",
        sport: "icehockey",
        variant: "iihf",
        kind: "team",
        n: 6,
        template: "league",
        ratio: 1,
      },
      // FIH with the full card ladder (draw + green/yellow). Recording the
      // cards is free on every plan since W1 (entitlements v18); what is still
      // Pro is `discipline.enforced` — the ledger, thresholds and automatic
      // suspensions built ON those cards — so the discipline demo lives here.
      {
        name: "FIH Outdoor Cup",
        sport: "hockey",
        variant: "fih-outdoor",
        kind: "team",
        n: 6,
        template: "league",
        ratio: 0.8,
      },
    ],
  },
  {
    name: "Chess Open 2026",
    divisions: [
      {
        name: "Open Swiss",
        sport: "boardgame",
        variant: "classical",
        kind: "individual",
        n: 10 + rnd(3),
        template: "swiss",
        ratio: 0.6,
      },
      {
        name: "Blitz Knockout",
        sport: "boardgame",
        variant: "blitz",
        kind: "individual",
        n: 8,
        template: "knockout",
        ratio: 0.8,
      },
      {
        name: "Rapid League",
        sport: "boardgame",
        variant: "rapid",
        kind: "individual",
        n: 5 + rnd(3),
        template: "league",
        ratio: 1,
      },
    ],
  },
  {
    name: "Cricket Cup",
    divisions: [
      {
        name: "T20 Groups",
        sport: "cricket",
        variant: "t20",
        kind: "team",
        n: 8,
        template: "groups_ko",
        q: 4,
        ratio: 1,
      },
      {
        name: "Village League",
        sport: "cricket",
        variant: "t20",
        kind: "team",
        n: 5,
        template: "league",
        ratio: 0.8,
      },
      {
        name: "Hundred Bash",
        sport: "cricket",
        variant: "hundred",
        kind: "team",
        n: 6,
        template: "league",
        ratio: 0.4,
      },
    ],
  },
  {
    name: "Community Games",
    divisions: [
      {
        name: "Carrom Ladder",
        sport: "generic",
        variant: "score",
        kind: "individual",
        n: 6,
        template: "group_stepladder",
        q: 4,
        ratio: 1,
        config: GENERIC_CFG,
      },
      {
        name: "Darts Double Elim",
        sport: "generic",
        variant: "score",
        kind: "individual",
        n: 8,
        template: "double_elim",
        ratio: 0.7,
        config: GENERIC_CFG,
      },
      {
        name: "Volleyball League",
        sport: "volleyball",
        variant: "indoor",
        kind: "team",
        n: 6,
        template: "league_ko",
        q: 4,
        ratio: 1,
      },
      {
        name: "Beach Pairs",
        sport: "volleyball",
        variant: "beach",
        kind: "pair",
        n: 5 + rnd(3),
        template: "league",
        ratio: 0.6,
      },
    ],
  },
  // Jul3/08 new formats (triple RR here; americano + ladder seeded separately
  // by seedAdvancedFormats since they need linked persons / on-demand fixtures).
  {
    name: "Padel & Ladder Club",
    divisions: [
      {
        name: "Triple Round Robin",
        sport: "generic",
        variant: "score",
        kind: "individual",
        n: 4,
        template: "triple_rr",
        ratio: 1,
        config: GENERIC_CFG,
      },
    ],
  },
];

// Community account: stays INSIDE the free caps (2 active competitions,
// 1 division each, ≤16 entrants, ≤2 stages, no double elim) — shows the real
// free experience including the Pro badges on gated controls.
const PLAN_COMMUNITY: { name: string; divisions: DivPlan[] }[] = [
  // v6: the community org shows FIH hockey — a drawn game with green/yellow
  // cards seeds first (demo-richness rule). Fresh community seeds get this;
  // accounts seeded before v6 keep their football league (resume skips).
  {
    name: "Friday Night Hockey",
    divisions: [
      {
        name: "FIH Outdoor League",
        sport: "hockey",
        variant: "fih-outdoor",
        kind: "team",
        n: 6,
        template: "league",
        ratio: 0.7,
      },
    ],
  },
  {
    name: "Office Table Tennis",
    divisions: [
      {
        name: "Singles Championship",
        sport: "tabletennis",
        variant: "bo5",
        kind: "individual",
        n: 8,
        template: "league_ko",
        q: 4,
        ratio: 1,
      },
    ],
  },
];

function loadState(): Record<string, { email: string }> {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const phase = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "seed";
  const account = (process.argv.find((a) => a.startsWith("--account="))?.split("=")[1] ?? "pro") as
    "community" | "pro";
  const PLAN = account === "community" ? PLAN_COMMUNITY : PLAN_PRO;

  if (phase === "setup") {
    const email = `smoke-${account}-${1000 + rnd(9000)}@example.com`;
    const reg = await call("/api/auth/signup", "POST", {
      email,
      password: PASSWORD,
    });
    await call("/api/auth/verify-email", "POST", { token: reg.verify_token });
    await call("/api/onboarding/complete", "POST");
    await call("/api/tour", "POST");
    writeFileSync(STATE, JSON.stringify({ ...loadState(), [account]: { email } }));
    console.log(`${account} account: ${email} / ${PASSWORD}`);

    // Pro account gets a real pro subscription row — entitlements resolve from
    // plan_entitlements exactly like a paying org (no piecemeal overrides).
    if (account === "pro") {
      if (!process.env.DATABASE_URL) {
        console.log(
          "DATABASE_URL not set — set the org's subscription to 'pro' manually before seeding",
        );
        return;
      }
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : "require",
        max: 1,
        prepare: !process.env.DATABASE_URL.includes(":6543"),
      });
      // Billing lives on the GROUP (V310): reprice the group this org bills
      // through. Demo orgs are created through the app, so the group exists.
      const [org] = await sql<{ id: string; subscription_id: string | null }[]>`
        select o.id, o.subscription_id
          from org_members m
          join users u on u.id = m.user_id
          join organizations o on o.id = m.org_id
         where u.email = ${email} limit 1`;
      if (!org) throw new Error(`seed-demo: no org for ${email}`);
      if (org.subscription_id) {
        await sql`
          update subscriptions set plan_key = 'pro', status = 'active', updated_at = now()
           where id = ${org.subscription_id}`;
      } else {
        const [group] = await sql<{ id: string }[]>`
          insert into subscriptions (owner_user_id, plan_key, status)
          select coalesce(
                   (select m.user_id from org_members m
                     where m.org_id = o.id and m.role = 'owner'
                     order by m.created_at limit 1),
                   o.created_by),
                 'pro', 'active'
            from organizations o where o.id = ${org.id}
          returning id`;
        await sql`update organizations set subscription_id = ${group!.id} where id = ${org.id}`;
      }
      await sql.end();
      console.log("subscription set to pro/active");
    }
    return;
  }

  const state = loadState();
  const email = state[account]?.email;
  if (!email)
    throw new Error(
      `no ${account} account in ${STATE} — run --phase=setup --account=${account} first`,
    );
  await call("/api/auth/login", "POST", { email, password: PASSWORD });

  for (const comp of PLAN) {
    // Resume-safe by NAME, checked before creating — NOT by catching a 409.
    // A create without an explicit slug can never 409 (the server suffixes the
    // collision away), so the old catch was dead code and every rerun made a
    // second "<name>-2" competition. See scripts/seed-resume.ts.
    const c = await findOrCreateCompetition(call, comp.name, { ends_on: "2030-12-31" });
    if (!c) continue;
    const existingRes = await call(`/api/v1/competitions/${c.id}/divisions`);
    const existingArr: { name: string }[] = Array.isArray(existingRes)
      ? existingRes
      : (existingRes.items ?? []);
    const existingNames = new Set(existingArr.map((x) => x.name));
    for (const d of comp.divisions) {
      if (existingNames.has(d.name)) {
        console.log(`${comp.name} / ${d.name}: exists, skipped`);
        continue;
      }
      const div = await call(`/api/v1/competitions/${c.id}/divisions`, "POST", {
        name: d.name,
        sport_key: d.sport,
        variant_key: d.variant,
        ...(d.config ? { config: d.config } : {}),
      });
      await call(`/api/v1/divisions/${div.id}/entrants`, "POST", entrantsFor(d.kind, d.n));
      const specs = TEMPLATES[d.template](d.q ?? 4).map((s, i) => ({
        ...s,
        seq: i + 1,
      }));
      const created = await call(`/api/v1/divisions/${div.id}/stages`, "POST", specs);
      const stages: { id: string; kind: string; seq: number }[] = Array.isArray(created)
        ? created
        : [created];
      stages.sort((a, b) => a.seq - b.seq);

      const first = await (async () => {
        const gen = await playStageAfterStart(div.id, stages[0].id, d.sport, d.variant, d.ratio);
        return gen;
      })();
      let note = `${first.played}/${first.total}`;
      // Second stage only when the first fully decided. Completing stage 1
      // FIRST is what resolves progression (rankRange/picks) into the next
      // stage's config.qualified — generating without it would bracket every
      // division entrant instead of the qualifiers.
      if (stages[1] && first.played === first.total) {
        await call(`/api/v1/stages/${stages[0].id}/complete`, "POST");
        const second = await playStage(stages[1].id, d.sport, d.variant, 0.6 + Math.random() * 0.4);
        note += ` + ${stages[1].kind} ${second.played}/${second.total}`;
      }
      console.log(
        `${comp.name} / ${d.name} (${d.sport}, ${d.kind}×${d.n}, ${d.template}): ${note}`,
      );
    }
  }

  // Jul3/08 formats that need bespoke seeding (linked persons / on-demand
  // fixtures) — only on the Pro account, into the Padel & Ladder Club.
  if (account === "pro") await seedAdvancedFormats();

  // P7 (D1b): a template-instantiated competition — Pro-only, see the
  // function for why.
  if (account === "pro") await seedTemplateCompetition();

  // RS010 closeout: the four public-registration demo states — Pro-only,
  // see the function for why.
  if (account === "pro") await seedRegistrationDemo();

  // #376's `closed` state — community only, see the function.
  if (account === "community") await seedClosedCompetition();

  // #376 part D: the invisible half of the divisions quota. Both accounts, so
  // the demo carries the state on the plan where it BITES (community) as well
  // as the one where it merely shows the warning (pro).
  await seedArchivedSlotHolder(PLAN[0].name);

  console.log("done");
}

/**
 * A finished competition that never held an Event Pass (#376) — the state where
 * the header must offer no pass and the upgrade page must sell nothing.
 *
 * COMMUNITY ONLY, and that is not a preference. `passState` (the competition
 * layout) empties `sellableRungs` the moment the competition is locked, so a
 * PAID org resolves `paid_plan` and the closed chip never renders at all; the
 * demo would show an empty header and prove nothing. The community account is
 * the only place the state is reachable.
 *
 * `terminal`, not `past_ends_on`: a `completed` status is the arm an organiser
 * actually arrives at, and it stays put — a `past_ends_on` seed would need a
 * date the demo has to keep moving past. `starts_on`/`ends_on` are spelled out
 * anyway because an end date is about to be mandatory, and a seed without one
 * would break then rather than now.
 *
 * Resume-safe like the PLAN loop above: found by NAME before creating, and the
 * status PATCH is idempotent.
 */
async function seedClosedCompetition(): Promise<void> {
  const name = "Winter 2024 (finished)";
  const comp = await findOrCreateCompetition(call, name, {
    starts_on: "2024-11-01",
    ends_on: "2024-12-15",
  });
  if (!comp) return;
  await call(`/api/v1/competitions/${comp.id}`, "PATCH", { status: "completed" });
  console.log(`${name}: completed, no pass — #376 closed state`);
}

/**
 * One competition holding an archived-and-PLAYED division (V354).
 *
 * The state this seeds is the whole point of #376 part D and is otherwise
 * impossible to demo: an archived division with recorded results keeps its
 * `divisions.per_competition.max` slot forever, so the org sees fewer
 * divisions than its plan allows AND a paywall — the two surfaces that now
 * explain themselves (the danger-zone warning before the archive, the
 * archived-slots line under the 402).
 *
 * Deliberately joins an EXISTING plan competition rather than creating one:
 * `competitions.max_active` is 2 on community, and burning a competition slot
 * to demonstrate a division slot would trade one gap in the demo for another.
 * A played division is the requirement — an unplayed archived one frees its
 * slot and would show nothing.
 *
 * Resume-safe by name, like every other step in this seeder: archived
 * divisions do not come back from the divisions list, so the check is the
 * competition's archived list.
 */
async function seedArchivedSlotHolder(competitionName: string): Promise<void> {
  const comps = await call("/api/v1/competitions?limit=100");
  const comp = ((comps.items ?? comps) as { id: string; name: string }[]).find(
    (c) => c.name === competitionName,
  );
  if (!comp) return;
  const NAME = "Retired Grade";

  const archived = await call(`/api/v1/competitions/${comp.id}/divisions?archived=1`);
  const archivedNames = new Set(
    ((archived.items ?? archived) as { name: string }[]).map((d) => d.name),
  );
  if (archivedNames.has(NAME)) {
    console.log(`${competitionName} / ${NAME}: exists, skipped`);
    return;
  }

  let div: { id: string };
  try {
    div = await call(`/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: NAME,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CFG,
    });
  } catch (e) {
    // Already at the ceiling (a re-seed against an account that holds other
    // archived slots) — the state is already demonstrated, so skip rather than
    // abort the run.
    if (/cap|limit|payment/i.test(String(e))) {
      console.log(`${competitionName} / ${NAME}: skipped (division cap on this account)`);
      return;
    }
    throw e;
  }

  await call(`/api/v1/divisions/${div.id}/entrants`, "POST", entrantsFor("individual", 4));
  const created = await call(`/api/v1/divisions/${div.id}/stages`, "POST", [
    { ...TEMPLATES.league(4)[0], seq: 1 },
  ]);
  const stage = (Array.isArray(created) ? created[0] : created) as { id: string };
  const { played, total } = await playStageAfterStart(div.id, stage.id, "generic", "score", 1);

  // Registration must be closed before archive (v3/09 §4).
  await call(`/api/v1/divisions/${div.id}/registration-settings`, "PUT", { enabled: false });
  await call(`/api/v1/divisions/${div.id}/archive`, "POST");
  console.log(
    `${competitionName} / ${NAME}: ${played}/${total} played, archived — holds a quota slot`,
  );
}

/**
 * P7 (D1b): a competition created FROM a catalog template — the demo
 * dataset previously built every competition by hand, so the three P7
 * templates (`euro24`, `t20-super8`, `league-playoff`) were only ever visible
 * in unit/e2e/smoke fixtures, never in a seeded org a human actually opens.
 *
 * Drives `/api/v1/competitions/from-template` — the SAME endpoint the
 * wizard's "start from a famous format" step calls (templates.ts's
 * `createFromTemplate`) — never a direct DB insert, so the demo proves the
 * real instantiation path rather than a shape the route could silently
 * drift from. `t20-super8` (4 groups -> Super 8 -> knockout, 3 stages) is
 * PRO-ONLY: 3 stages exceeds Community's `stages.per_division.max` of 2
 * (catalog.test.ts pins this).
 *
 * Generates fixtures for STAGE 1 ONLY and decides none of them — the whole
 * point of seeding this is the CONTRAST between real group fixtures and the
 * later two stages still sitting in their TBD/seeded state. Instantiation
 * itself never generates fixtures for ANY stage (P7 ruling — see
 * templates.ts's comment on `stageResults.push`: a setup-timing
 * (propose/confirm) stage mints synthetic entrants at generate time, so
 * generating eagerly at instantiation, before real entrants exist, would
 * format-lock the division at birth). Fixtures come from the existing
 * Generate action
 * (`playStageAfterStart` below), same as every other division in this file.
 *
 * Resume-safe by NAME, checked before creating — unlike the PLAN loop's
 * competition step above (which catches an "already in use" 409 that a
 * caller-supplied `slug` collision throws), neither `/api/v1/competitions`
 * nor `/api/v1/competitions/from-template` are ever called with an explicit
 * slug here, and `uniqueSlug` (slugs.ts) auto-suffixes a colliding slug
 * rather than 409ing — a catch-based resume would silently create a second,
 * differently-slugged competition with the same name on every rerun. Check-
 * first, like seedArchivedSlotHolder/seedAdvancedFormats below.
 */
async function seedTemplateCompetition(): Promise<void> {
  const NAME = "T20 Super League";
  const existing = await call("/api/v1/competitions?limit=100");
  let comp = ((existing.items ?? existing) as { id: string; name: string }[]).find(
    (c) => c.name === NAME,
  );
  if (comp) {
    console.log(`${NAME}: exists, resuming`);
  } else {
    try {
      const created = (await call("/api/v1/competitions/from-template", "POST", {
        template_key: "t20-super8",
        name: NAME,
        ends_on: "2030-12-31",
      })) as { competitionId: string };
      comp = { id: created.competitionId, name: NAME };
    } catch (e) {
      // Same escape the PLAN loop above takes: a plan cap is a skip, not an
      // abort of the whole seed run.
      if (/cap|limit|payment/i.test(String(e))) {
        console.log(`${NAME}: skipped (plan cap on this account)`);
        return;
      }
      throw e;
    }
  }

  const divisionsRes = await call(`/api/v1/competitions/${comp.id}/divisions`);
  const divisions = (
    Array.isArray(divisionsRes) ? divisionsRes : (divisionsRes.items ?? [])
  ) as { id: string; name: string }[];
  const division = divisions[0];
  if (!division) {
    console.log(`${NAME}: no division found on an existing competition, skipping`);
    return;
  }

  const entrantsRes = await call(`/api/v1/divisions/${division.id}/entrants`);
  const entrants = Array.isArray(entrantsRes) ? entrantsRes : (entrantsRes.items ?? []);
  if (entrants.length === 0) {
    await call(`/api/v1/divisions/${division.id}/entrants`, "POST", entrantsFor("team", 16));
  }

  const stagesRes = await call(`/api/v1/divisions/${division.id}/stages`);
  const stages = (
    Array.isArray(stagesRes) ? stagesRes : (stagesRes.items ?? [])
  ) as { id: string; seq: number; status: string }[];
  stages.sort((a, b) => a.seq - b.seq);
  const stage1 = stages[0];
  if (!stage1) {
    console.log(`${NAME}: division has no stages, skipping`);
    return;
  }
  if (stage1.status === "pending") {
    // ratio 0: generate + publish the schedule, decide nothing. Stage 1
    // shows real fixtures; stages 2/3 stay TBD off their setup-timing
    // progression rules.
    const { total } = await playStageAfterStart(division.id, stage1.id, "cricket", "t20", 0);
    console.log(
      `${NAME} / ${division.name} (from template t20-super8): ${stages.length} stages, stage 1 generated ${total} fixtures, 0 played`,
    );
  } else {
    console.log(`${NAME} / ${division.name}: stage 1 already generated, skipped`);
  }
}

/**
 * RS010 closeout: `seed-demo.ts` never created a single registration row
 * before this — the file touched `/registration-settings` PUT exactly once
 * (`seedArchivedSlotHolder` above, only to CLOSE a division before archiving
 * it), and nothing anywhere called `submitRegistrationGroup`. RS010's brief
 * is a fresh org owner touring the redesign end to end: an OPEN division
 * nobody has entered yet, a real TEAM entry with an open roster slot (a
 * demoable join_code/join link), a division sitting AT CAPACITY with a
 * genuine WAITLISTED entrant, and a division whose entry sits PENDING an
 * organiser's approval.
 *
 * "Manual division" (brief's own wording) resolves to `approval: "manual"`
 * on `registration_settings` (RS004/V364) — the ONLY manual-shaped mode this
 * settings model has (registrations.ts's `RegistrationSettingsRow` /
 * schemas.ts's `PutRegistrationSettings` both declare exactly `approval:
 * "auto" | "manual"`, nothing else). There is no second "organiser-only, no
 * public link" mode to pick instead — an `approval: "manual"` entry submits
 * through the SAME public link as every other division and simply stops at
 * `pending` instead of auto-confirming (registration-submit.ts's own
 * `!waitlisted && live.approval === "auto" && feeCents === 0` gate), which
 * is as literally "manual" as this model gets.
 *
 * PRO ONLY, same reason `seedAdvancedFormats`/`seedTemplateCompetition`
 * above are: PLAN_COMMUNITY already spends the community plan's entire
 * `competitions.max_active` (2) and its 1-division-per-competition budget,
 * so a third competition here would be silently caught by
 * `findOrCreateCompetition`'s own PLAN_CAP skip. Reusing an EXISTING
 * competition instead is not viable either direction (checked first, per
 * the brief): every PLAN_PRO/PLAN_COMMUNITY division already has entrants
 * POSTed directly and stages generated/played by the loop above BEFORE this
 * function ever runs — opening registration on top of an already-full,
 * already-played division would show the tour capacity/waitlist numbers
 * that contradict what is already on screen (a division simultaneously
 * "closed" from the direct-entrant side and "open" from the registration
 * side is not a state a real organiser can reach). A fresh, dedicated
 * competition is the only shape that demos registration without
 * contradicting a division seeded by the PLAN loop for something else.
 *
 * Drives the REAL public submit surface — `POST /api/v1/public/orgs/{org}/
 * competitions/{comp}/register`, the SAME route the public stepper calls —
 * rather than inserting `registrations` rows directly, so this proves the
 * actual instantiation path rather than a shape the route could silently
 * drift from (same reasoning `seedTemplateCompetition`'s own doc comment
 * gives for `/api/v1/competitions/from-template`). The authenticated
 * cookie jar is still attached on these calls — this file has no
 * unauthenticated-call helper, and the route accepts a signed-in caller
 * fine (registration-submit.ts's own `sessionUser?.id ?? null`); the only
 * observable effect is `registration_groups.user_id` pointing at the
 * organiser's own demo account, harmless for a demo cart, and it never
 * fires the self-link path since none of these entries set
 * `registering_self`.
 *
 * `visibility: "unlisted"` on the competition, not "public": every other
 * competition this file creates defaults to "private" (`CreateCompetition`'s
 * own schema default) and never clears `submitRegistrationGroup`'s /
 * `publicRegistrationInfo`'s `visibility in ('public','unlisted')` gate.
 * This competition needs to clear that gate to be registrable at all, but
 * "public" would additionally make it the first demo competition this file
 * has ever listed on seazn.club's own public discovery surface —
 * "unlisted" clears the identical registration gate while staying
 * reachable only by the direct link, which is all a product tour needs.
 *
 * Org slug resolved via `GET /api/orgs` (`getUserOrgs`, lib/auth.ts) — the
 * one authenticated endpoint in this app that actually returns the caller's
 * own org slug; no `/api/v1/competitions*` response carries an org join
 * (`CompetitionRow` has `org_id`, never a slug), so nothing already called
 * elsewhere in this file exposes it.
 *
 * Football (11-a-side, already used by PLAN_PRO's "Premier Division") gives
 * the TEAM state a concrete, demoable roster cap: `lineup.size: 11 +
 * benchMax: 12` (football.ts) via `rosterCapExpr` — 23 spots total, 1 filled
 * by the submitted captain, 22 genuinely open for the join_code to fill.
 *
 * Resume-safe by NAME throughout, like every other function in this file:
 * the competition and each division are found-before-created, and each
 * state's own registration submit is gated behind a
 * `GET .../divisions/{id}/registrations` read so a rerun never double-
 * submits or drifts a division past the entrant count its state depends on
 * — an extra confirmed entry on the capacity=1 division would flip the
 * SECOND entrant from waitlisted to confirmed and quietly stop demoing a
 * waitlist at all.
 */
async function seedRegistrationDemo(): Promise<void> {
  const orgs = (await call("/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs[0]?.slug;
  if (!orgSlug) {
    console.log("Registration demo: no org for this account, skipped");
    return;
  }

  const COMP_NAME = "Autumn Open Registration";
  const comp = await findOrCreateCompetition(call, COMP_NAME, {
    ends_on: "2030-12-31",
    visibility: "unlisted",
  });
  if (!comp) return;
  const compId = comp.id;

  const compsRes = await call("/api/v1/competitions?limit=100");
  const compRow = (
    (compsRes.items ?? compsRes) as { id: string; name: string; slug: string }[]
  ).find((c) => c.id === compId);
  const compSlug = compRow?.slug;
  if (!compSlug) {
    console.log(`${COMP_NAME}: could not resolve its own slug, skipping registration demo`);
    return;
  }

  const existingRes = await call(`/api/v1/competitions/${compId}/divisions`);
  const existingArr: { id: string; name: string }[] = Array.isArray(existingRes)
    ? existingRes
    : (existingRes.items ?? []);
  const byName = new Map(existingArr.map((d) => [d.name, d]));

  async function ensureDivision(
    name: string,
    sport: string,
    variant: string,
    config?: Record<string, unknown>,
  ): Promise<{ id: string; name: string }> {
    const found = byName.get(name);
    if (found) return found;
    const div = (await call(`/api/v1/competitions/${compId}/divisions`, "POST", {
      name,
      sport_key: sport,
      variant_key: variant,
      ...(config ? { config } : {}),
    })) as { id: string; name: string };
    byName.set(name, div);
    return div;
  }

  async function regsFor(divisionId: string): Promise<{ id: string; status: string }[]> {
    const res = await call(`/api/v1/divisions/${divisionId}/registrations`);
    return (Array.isArray(res) ? res : (res.items ?? [])) as { id: string; status: string }[];
  }

  const contact = () => {
    const name = person();
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}${rnd(9000)}@example.com`;
    return { name, email };
  };

  // `who` is the caller's own — never generated in here — so a caller
  // building `extra.players` off the SAME contact (the team captain, the
  // solo entrant) names one real person once, not two different ones.
  async function submit(
    who: { name: string; email: string },
    divisionId: string,
    entrantKind: "individual" | "team",
    extra: Record<string, unknown>,
  ) {
    return call(`/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
      contact: who,
      privacy_consent: true,
      entries: [{ division_id: divisionId, entrant_kind: entrantKind, ...extra }],
    });
  }

  // (a) OPEN: enabled, generous capacity, nothing submitted — the owner runs
  // the public stepper live.
  const openDiv = await ensureDivision("Open Enrolment", "generic", "score", GENERIC_CFG);
  await call(`/api/v1/divisions/${openDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 40,
    fee_cents: 0,
    approval: "auto",
  });
  console.log(`${COMP_NAME} / ${openDiv.name}: open, 0 submitted`);

  // (b) TEAM, part-filled roster — 1 of 23 football spots (11 + 12 bench)
  // filled; the join_code is real and still joinable.
  const teamDiv = await ensureDivision("Sunday League Squads", "football", "11-a-side");
  await call(`/api/v1/divisions/${teamDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    capacity: 12,
    fee_cents: 0,
    approval: "auto",
  });
  const teamRegs = await regsFor(teamDiv.id);
  if (teamRegs.length === 0) {
    const captain = contact();
    const result = await submit(captain, teamDiv.id, "team", {
      team_name: `${CLUBS[rnd(CLUBS.length)]} ${coin() ? "FC" : "CC"}`,
      players: [{ full_name: captain.name, is_captain: true }],
    });
    const joinCode = result.entries?.[0]?.join_code ?? "(none)";
    console.log(`${COMP_NAME} / ${teamDiv.name}: 1 team, 1/23 roster filled, join_code ${joinCode}`);
  } else {
    console.log(`${COMP_NAME} / ${teamDiv.name}: exists, skipped`);
  }

  // (c) AT CAPACITY + WAITLISTED — capacity 1; entrant #1 confirms and takes
  // the only spot, entrant #2 waitlists.
  const waitDiv = await ensureDivision("Members' Quiz Night", "generic", "score", GENERIC_CFG);
  await call(`/api/v1/divisions/${waitDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 1,
    fee_cents: 0,
    approval: "auto",
  });
  let waitRegs = await regsFor(waitDiv.id);
  for (let i = 0; i < 5 && waitRegs.length < 2; i++) {
    const p = contact();
    await submit(p, waitDiv.id, "individual", { players: [{ full_name: p.name }] });
    waitRegs = await regsFor(waitDiv.id);
  }
  console.log(
    `${COMP_NAME} / ${waitDiv.name}: ` +
      `${waitRegs.filter((r) => r.status === "confirmed").length} confirmed, ` +
      `${waitRegs.filter((r) => r.status === "waitlisted").length} waitlisted`,
  );

  // (d) MANUAL approval — approval='manual'; the one entry submitted sits
  // 'pending', awaiting an organiser's POST /api/v1/registrations/{id}/approve.
  const manualDiv = await ensureDivision("Advanced Coaching Group", "generic", "score", GENERIC_CFG);
  await call(`/api/v1/divisions/${manualDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 20,
    fee_cents: 0,
    approval: "manual",
  });
  const manualRegs = await regsFor(manualDiv.id);
  if (manualRegs.length === 0) {
    const p = contact();
    await submit(p, manualDiv.id, "individual", { players: [{ full_name: p.name }] });
    console.log(`${COMP_NAME} / ${manualDiv.name}: 1 entry pending approval`);
  } else {
    console.log(`${COMP_NAME} / ${manualDiv.name}: exists, skipped`);
  }
}

/** Seed an americano stage (needs individual entrants backed by persons) and a
 *  ladder stage with a couple of played challenges (reorders the ladder). Both
 *  under the "Padel & Ladder Club" competition created by the main PLAN loop. */
async function seedAdvancedFormats(): Promise<void> {
  const comps = await call("/api/v1/competitions?limit=100");
  const club = ((comps.items ?? comps) as { id: string; name: string }[]).find(
    (c) => c.name === "Padel & Ladder Club",
  );
  if (!club) return;
  const existing = await call(`/api/v1/competitions/${club.id}/divisions`);
  const names = new Set(((existing.items ?? existing) as { name: string }[]).map((d) => d.name));

  // --- Americano: 8 individuals backed by persons, one round played ---
  if (!names.has("Americano Night")) {
    const div = await call(`/api/v1/competitions/${club.id}/divisions`, "POST", {
      name: "Americano Night",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CFG,
    });
    const players = [];
    for (let i = 0; i < 8; i++) {
      const p = (await call("/api/v1/persons", "POST", {
        full_name: person(),
        consent: {},
      })) as { id: string };
      players.push({
        kind: "individual",
        display_name: `P${i + 1}`,
        seed: i + 1,
        members: [{ person_id: p.id, is_captain: false, roles: [] }],
      });
    }
    await call(`/api/v1/divisions/${div.id}/entrants`, "POST", players);
    const st = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "americano",
      name: "Americano",
      config: { mode: "americano", courtCount: 2, rounds: 5 },
    });
    const gen = await call(`/api/v1/stages/${st.id}/generate`, "POST");
    await call(`/api/v1/divisions/${div.id}/start`, "POST");
    let played = 0;
    for (const f of (gen.fixtures as GenFx[]).filter((x) => (x.round_no ?? 0) === 1)) {
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & {
        status: string;
      };
      if (cur.home_entrant_id && cur.away_entrant_id && cur.status === "scheduled") {
        await decideFixture(f.id, "generic", "score", {
          home: cur.home_entrant_id,
          away: cur.away_entrant_id,
        });
        played++;
      }
    }
    console.log(
      `Padel & Ladder Club / Americano Night (generic, individual×8, americano): ${played}/${gen.fixtures.length} round 1`,
    );
  }

  // --- Ladder: 6 individuals; play two in-range challenges ---
  if (!names.has("Club Ladder")) {
    const div = await call(`/api/v1/competitions/${club.id}/divisions`, "POST", {
      name: "Club Ladder",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CFG,
    });
    const ents = (await call(
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      Array.from({ length: 6 }, (_, i) => ({
        kind: "individual",
        display_name: person(),
        seed: i + 1,
      })),
    )) as { id: string }[];
    const st = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "ladder",
      name: "Ladder",
      config: { challengeRange: 2 },
    });
    await call(`/api/v1/divisions/${div.id}/start`, "POST").catch(() => null);
    // #3 challenges #1 (in range 2), plays and wins → takes the top spot.
    let challenges = 0;
    for (const [ci, oi] of [
      [2, 0],
      [4, 2],
    ] as const) {
      try {
        const ch = (await call(`/api/v1/stages/${st.id}/challenges`, "POST", {
          challenger_id: ents[ci].id,
          opponent_id: ents[oi].id,
        })) as { fixture_id: string };
        await decideFixture(ch.fixture_id, "generic", "score", {
          home: ents[ci].id,
          away: ents[oi].id,
        });
        challenges++;
      } catch {
        /* range/ordering may reject after the first swap */
      }
    }
    console.log(
      `Padel & Ladder Club / Club Ladder (generic, individual×6, ladder): ${challenges} challenge(s) played`,
    );
  }
}

async function playStageAfterStart(
  divId: string,
  stageId: string,
  sport: string,
  variant: string,
  ratio: number,
) {
  const gen = await call(`/api/v1/stages/${stageId}/generate`, "POST");
  await call(`/api/v1/divisions/${divId}/start`, "POST");
  let fixtures: GenFx[] = gen.fixtures;
  const total = fixtures.length;
  const target = Math.ceil(total * ratio);
  let played = 0;
  const rounds = [...new Set(fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
  for (const round of rounds) {
    for (const f of fixtures.filter((x) => (x.round_no ?? 0) === round)) {
      if (played >= target) return { total, played };
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & {
        status: string;
      };
      if (!cur.home_entrant_id || !cur.away_entrant_id) continue;
      if (cur.status !== "scheduled") continue;
      await decideFixture(f.id, sport, variant, {
        home: cur.home_entrant_id,
        away: cur.away_entrant_id,
      });
      played++;
    }
  }
  return { total, played };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
