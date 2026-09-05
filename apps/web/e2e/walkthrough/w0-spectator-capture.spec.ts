// W0 — spectator surface: seed a realistic PUBLIC competition and capture every
// existing `/shared` page at 320/375/768/1280 in an ANONYMOUS context.
// Throwaway capture harness (not committed): arms only with W0_DIR set.
// Spec: docs/superpowers/specs/2026-09-04-spectator-prompts/W0-capture-and-options.md
import { test, expect, type Page, type APIRequestContext, type Browser } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiJson, activeOrg, createStageAndGenerate, setDivisionConfigSql, TAG } from "../helpers";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../../src/lib/consent";

const OUT = process.env.W0_DIR ?? "";
test.skip(!OUT, "W0 capture only runs with W0_DIR set");
test.describe.configure({ mode: "serial" });
test.setTimeout(25 * 60_000);

const WIDTHS = [
  { w: 320, h: 568 },
  { w: 375, h: 812 },
  { w: 768, h: 1024 },
  { w: 1280, h: 800 },
] as const;

type Manifest = {
  name: string;
  path: string;
  width: number;
  hscroll: number;
  title: string;
  controls: string[];
  headings: string[];
};
const manifest: Manifest[] = [];

// ---------------------------------------------------------------------------
// seeding helpers
// ---------------------------------------------------------------------------

async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; error?: unknown }> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  return { status: res.status, error: res.error };
}

async function mustPost(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const r = await postEvent(request, fixtureId, type, payload);
  if (r.status >= 300) {
    throw new Error(`${type} -> ${r.status} ${JSON.stringify(r.error)} payload=${JSON.stringify(payload)}`);
  }
}

async function createPersons(request: APIRequestContext, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const full_name of names) {
    const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name,
      consent: { public_name: true },
    });
    if (!p.data) throw new Error(`person ${full_name} -> ${p.status} ${JSON.stringify(p.error)}`);
    ids.push(p.data.id);
  }
  return ids;
}

type Team = { name: string; entrantId: string; order: string[] };

/** Seeded LCG so the ledger is reproducible run to run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

type InningsOpts = {
  ballsPerInnings: number;
  playersPerSide: number;
  target?: number;
  /** Stop after this many legal balls (leave the innings open) — the LIVE case. */
  stopAtLegalBalls?: number;
  seed: number;
};

/**
 * Drive one innings through `cricket.ball` events. over/ballInOver are
 * DERIVED from legal balls exactly as the strict fold expects
 * (cricket.ts:1226): a wide re-bowls the same ball number.
 */
async function playInnings(
  request: APIRequestContext,
  fixtureId: string,
  batting: Team,
  bowling: Team,
  opts: InningsOpts,
): Promise<{ runs: number; wickets: number; legalBalls: number }> {
  const rand = rng(opts.seed);
  const bowlers = bowling.order.slice(-4); // last four in the order bowl
  let legalBalls = 0;
  let runs = 0;
  let wickets = 0;
  let striker = batting.order[0]!;
  let nonStriker = batting.order[1]!;
  let nextIn = 2;
  const allOutAt = opts.playersPerSide - 1;

  const swap = () => {
    const t = striker;
    striker = nonStriker;
    nonStriker = t;
  };

  while (
    legalBalls < opts.ballsPerInnings &&
    wickets < allOutAt &&
    (opts.target === undefined || runs < opts.target) &&
    (opts.stopAtLegalBalls === undefined || legalBalls < opts.stopAtLegalBalls)
  ) {
    const over = Math.floor(legalBalls / 6);
    const ballInOver = (legalBalls % 6) + 1;
    const bowler = bowlers[over % bowlers.length]!;
    const base = { over, ballInOver, striker, nonStriker, bowler };
    const r = rand();
    let payload: Record<string, unknown>;
    let legal = true;
    let batRuns = 0;
    let odd = false;
    if (r < 0.05) {
      // wide
      payload = { ...base, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } };
      runs += 1;
      legal = false;
    } else if (r < 0.08) {
      // bye
      payload = { ...base, runs: { bat: 0, extras: { kind: "bye", runs: 1 } } };
      runs += 1;
      odd = true;
    } else if (r < 0.14 && nextIn <= batting.order.length) {
      // wicket
      const kinds = ["bowled", "caught", "lbw", "runout", "stumped"] as const;
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      const fielders = bowling.order.filter((p) => p !== bowler);
      const fielder = fielders[Math.floor(rand() * fielders.length)]!;
      const wicket: Record<string, unknown> = {
        kind,
        out: striker,
        bowlerCredited: kind !== "runout",
      };
      if (kind === "caught" || kind === "stumped" || kind === "runout") wicket.fielder = fielder;
      const incoming = batting.order[nextIn];
      if (incoming) wicket.incoming = incoming;
      payload = { ...base, runs: { bat: 0 }, wicket };
      wickets += 1;
      if (incoming) {
        striker = incoming;
        nextIn += 1;
      }
    } else if (r < 0.44) {
      payload = { ...base, runs: { bat: 0 } };
    } else if (r < 0.74) {
      batRuns = 1;
      payload = { ...base, runs: { bat: 1 } };
      odd = true;
    } else if (r < 0.82) {
      batRuns = 2;
      payload = { ...base, runs: { bat: 2 } };
    } else if (r < 0.84) {
      batRuns = 3;
      payload = { ...base, runs: { bat: 3 } };
      odd = true;
    } else if (r < 0.95) {
      batRuns = 4;
      payload = { ...base, runs: { bat: 4 }, boundary: 4 };
    } else {
      batRuns = 6;
      payload = { ...base, runs: { bat: 6 }, boundary: 6 };
    }
    runs += batRuns;
    await mustPost(request, fixtureId, "cricket.ball", payload);
    if (legal) {
      legalBalls += 1;
      if (odd) swap();
      if (legalBalls % 6 === 0) swap(); // end of over
    }
    if (opts.target !== undefined && runs >= opts.target) break;
  }
  return { runs, wickets, legalBalls };
}

async function fixtureSides(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ home: string; away: string }> {
  const fx = await apiJson<{ home_entrant_id: string; away_entrant_id: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  if (!fx.data) throw new Error(`fixture ${fixtureId} -> ${fx.status}`);
  return { home: fx.data.home_entrant_id, away: fx.data.away_entrant_id };
}

async function putLineups(request: APIRequestContext, fixtureId: string, teams: Team[]): Promise<void> {
  for (const t of teams) {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/lineups/${t.entrantId}`, "PUT", {
      slots: t.order.map((person_id, i) => ({ person_id, slot: "starting", order_no: i + 1, roles: [] })),
    });
    if (res.status >= 300) throw new Error(`lineup ${t.name} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

async function setScheduledAt(fixtureId: string, iso: string | null): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : "prefer",
    max: 1,
  });
  try {
    await sql`update fixtures set scheduled_at = ${iso}::timestamptz where id = ${fixtureId}`;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// capture helpers
// ---------------------------------------------------------------------------

async function armCookieBypass(page: Page): Promise<void> {
  await page.addInitScript(
    (args: { k: string; vk: string; v: string }) => {
      try {
        window.localStorage.setItem(args.k, "rejected");
        window.localStorage.setItem(args.vk, args.v);
      } catch {
        /* storage disabled — banner may render */
      }
    },
    { k: CONSENT_KEY, vk: CONSENT_VERSION_KEY, v: COOKIE_POLICY_VERSION },
  );
}

async function controlSet(page: Page): Promise<{ controls: string[]; headings: string[] }> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const label = (el: Element) =>
      (
        el.getAttribute("data-testid") ||
        el.getAttribute("aria-label") ||
        (el as HTMLElement).innerText ||
        el.textContent ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 48);
    const controls = [...document.querySelectorAll('a[href],button,[role="tab"],input,select,summary')]
      .filter(visible)
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""}:${label(el)}`);
    const headings = [...document.querySelectorAll("h1,h2,h3")].filter(visible).map((el) => `${el.tagName.toLowerCase()}:${label(el)}`);
    return { controls, headings };
  });
}

async function capture(browser: Browser, name: string, path: string, after?: (page: Page) => Promise<void>): Promise<void> {
  for (const { w, h } of WIDTHS) {
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      isMobile: w < 768,
      hasTouch: w < 768,
    });
    const page = await ctx.newPage();
    await armCookieBypass(page);
    const res = await page.goto(path, { waitUntil: "load", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    expect(res?.status(), `${name} ${path} at ${w}`).toBeLessThan(400);
    if (after) await after(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${name}-${w}.png`), fullPage: true });
    await page.screenshot({ path: join(OUT, `${name}-${w}-fold.png`), fullPage: false });
    const hscroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const { controls, headings } = await controlSet(page);
    manifest.push({ name, path, width: w, hscroll, title: await page.title(), controls, headings });
    await ctx.close();
  }
}

async function openTab(page: Page, name: RegExp): Promise<void> {
  const tab = page.getByRole("tab", { name }).first();
  if (await tab.count()) {
    await tab.click();
    return;
  }
  const link = page.getByRole("link", { name }).first();
  if (await link.count()) {
    await link.click();
    await page.waitForLoadState("networkidle");
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function seedAll(page: Page, request: APIRequestContext) {
  const org = await activeOrg(page);
  const orgSlug = org.slug;

  // ---- competition -----------------------------------------------------
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Southend Premier League 2026 ${TAG}`,
    ends_on: "2026-10-31",
    visibility: "public",
  });
  if (!comp.data) throw new Error(`competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const compId = comp.data.id;
  const compSlug = comp.data.slug;

  // ---- cricket division: four teams, eight a side, 8 overs ---------------
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Men's T8",
    sport_key: "cricket",
    variant_key: "t20",
  });
  if (!div.data) throw new Error(`division -> ${div.status} ${JSON.stringify(div.error)}`);
  const divId = div.data.id;
  const divGet = await apiJson<{ slug: string; config: Record<string, unknown> }>(request, `/api/v1/divisions/${divId}`);
  const divSlug = divGet.data?.slug ?? div.data.slug;
  const BALLS = 48;
  const PLAYERS = 8;
  await setDivisionConfigSql(divId, { ...(divGet.data?.config ?? {}), ballsPerInnings: BALLS, playersPerSide: PLAYERS });

  const squads: Record<string, string[]> = {
    "Southend Blue Blazers": [
      "Arjun Mehta", "Bartholomew Ravindranath-Oyelaran-Whitaker", "Chris Adebayo", "Danny Okafor",
      "Eshan Pillai", "Farhan Qureshi", "George Whitfield", "Hamza Rauf",
    ],
    "Southend Queens": [
      "Priya Nair", "Sofia Marchetti", "Tanvi Deshmukh", "Uma Rajagopal",
      "Vicky Thompson", "Wren Castellano", "Yasmin Haddad", "Zara Okonkwo",
    ],
    "Leigh-on-Sea Lions": [
      "Ian Brooks", "Jamal Hussain", "Kieran O'Neill", "Liam Barratt",
      "Marcus Ellery", "Nikhil Sharma", "Oscar Lindqvist", "Patrick Nwosu",
    ],
    "Rochford Ramblers CC": [
      "Quentin Adeyemi", "Rahul Bose", "Sam Hartley", "Tom Fairweather",
      "Umar Siddiqui", "Vikram Chandra", "Will Pearson", "Xavier Duarte",
    ],
  };
  const teams: Team[] = [];
  const entrantBodies: Record<string, unknown>[] = [];
  const orders: string[][] = [];
  for (const [name, names] of Object.entries(squads)) {
    const ids = await createPersons(request, names);
    orders.push(ids);
    entrantBodies.push({
      kind: "team",
      display_name: name,
      seed: entrantBodies.length + 1,
      members: ids.map((person_id) => ({ person_id })),
    });
  }
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divId}/entrants`, "POST", entrantBodies);
  if (!ents.data || ents.data.length !== 4) throw new Error(`entrants -> ${ents.status} ${JSON.stringify(ents.error)}`);
  Object.keys(squads).forEach((name, i) => teams.push({ name, entrantId: ents.data![i]!.id, order: orders[i]! }));
  const byEntrant = new Map(teams.map((t) => [t.entrantId, t]));

  const { fixtureIds } = await createStageAndGenerate(request, divId);
  expect(fixtureIds.length, "4-team league = 6 fixtures").toBe(6);
  const started = await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  expect(started.status, `division start ${JSON.stringify(started.error)}`).toBeLessThan(300);

  // schedule: two played (yesterday/today), the rest across the coming days
  const now = Date.now();
  const at = (days: number, hour: number) => {
    const d = new Date(now + days * 86_400_000);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  await setScheduledAt(fixtureIds[0]!, at(-1, 14));
  await setScheduledAt(fixtureIds[1]!, at(0, 10));
  await setScheduledAt(fixtureIds[2]!, at(1, 14));
  await setScheduledAt(fixtureIds[3]!, at(1, 17));
  await setScheduledAt(fixtureIds[4]!, at(3, 14));
  await setScheduledAt(fixtureIds[5]!, at(7, 14));

  // ---- fixture 1: a finished 8-over match ---------------------------------
  const f1 = fixtureIds[0]!;
  const s1 = await fixtureSides(request, f1);
  const f1Home = byEntrant.get(s1.home)!;
  const f1Away = byEntrant.get(s1.away)!;
  await putLineups(request, f1, [f1Home, f1Away]);
  await mustPost(request, f1, "core.start", {});
  const toss1 = await postEvent(request, f1, "cricket.toss", { wonBy: f1Home.entrantId, elected: "bat" });
  const inn1 = await playInnings(request, f1, f1Home, f1Away, { ballsPerInnings: BALLS, playersPerSide: PLAYERS, seed: 11 });
  const inn2 = await playInnings(request, f1, f1Away, f1Home, {
    ballsPerInnings: BALLS,
    playersPerSide: PLAYERS,
    target: inn1.runs + 1,
    seed: 23,
  });
  const st1 = await apiJson<{ status: string; outcome: unknown }>(request, `/api/v1/fixtures/${f1}/state`);

  // ---- fixture 2: live, mid-chase ----------------------------------------
  const f2 = fixtureIds[1]!;
  const s2 = await fixtureSides(request, f2);
  const f2Home = byEntrant.get(s2.home)!;
  const f2Away = byEntrant.get(s2.away)!;
  await putLineups(request, f2, [f2Home, f2Away]);
  await mustPost(request, f2, "core.start", {});
  const toss2 = await postEvent(request, f2, "cricket.toss", { wonBy: f2Away.entrantId, elected: "bowl" });
  const inn3 = await playInnings(request, f2, f2Home, f2Away, { ballsPerInnings: BALLS, playersPerSide: PLAYERS, seed: 37 });
  const inn4 = await playInnings(request, f2, f2Away, f2Home, {
    ballsPerInnings: BALLS,
    playersPerSide: PLAYERS,
    target: inn3.runs + 1,
    stopAtLegalBalls: 27,
    seed: 41,
  });
  const st2 = await apiJson<{ status: string; outcome: unknown }>(request, `/api/v1/fixtures/${f2}/state`);

  // ---- football division: three sides, one final, two upcoming ------------
  const fdiv = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Sunday League",
    sport_key: "football",
    variant_key: "11-a-side",
  });
  if (!fdiv.data) throw new Error(`football division -> ${fdiv.status} ${JSON.stringify(fdiv.error)}`);
  const fdivId = fdiv.data.id;
  const fdivGet = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${fdivId}`);
  const fdivSlug = fdivGet.data?.slug ?? fdiv.data.slug;
  const fents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${fdivId}/entrants`, "POST", [
    { kind: "team", display_name: "Hadleigh Hawks FC", seed: 1 },
    { kind: "team", display_name: "Benfleet Town", seed: 2 },
    { kind: "team", display_name: "Canvey Island United", seed: 3 },
  ]);
  if (!fents.data || fents.data.length !== 3) throw new Error(`football entrants -> ${fents.status} ${JSON.stringify(fents.error)}`);
  const ff = await createStageAndGenerate(request, fdivId);
  expect(ff.fixtureIds.length, "3-team league = 3 fixtures").toBe(3);
  await apiJson(request, `/api/v1/divisions/${fdivId}/start`, "POST");
  await setScheduledAt(ff.fixtureIds[0]!, at(-2, 11));
  await setScheduledAt(ff.fixtureIds[1]!, at(2, 11));
  await setScheduledAt(ff.fixtureIds[2]!, at(9, 11));
  const ffx = ff.fixtureIds[0]!;
  const fs = await fixtureSides(request, ffx);
  await mustPost(request, ffx, "core.start", {});
  await mustPost(request, ffx, "football.goal", { by: fs.home });
  await mustPost(request, ffx, "football.goal", { by: fs.away });
  await mustPost(request, ffx, "football.period", { phase: "HT" });
  await mustPost(request, ffx, "football.goal", { by: fs.home });
  await mustPost(request, ffx, "football.period", { phase: "FT" });
  const stf = await apiJson<{ status: string; outcome: unknown }>(request, `/api/v1/fixtures/${ffx}/state`);

  const base = `/shared/${orgSlug}/${compSlug}`;
  const seed = {
    orgSlug,
    compId,
    compSlug,
    cricket: { divId, divSlug, fixtureIds, teams: teams.map((t) => ({ name: t.name, entrantId: t.entrantId })), toss1, toss2, inn1, inn2, inn3, inn4, st1: st1.data, st2: st2.data },
    football: { divId: fdivId, divSlug: fdivSlug, fixtureIds: ff.fixtureIds, st: stf.data },
    playerId: f1Home.order[0],
    paths: {
      orgHome: `/shared/${orgSlug}`,
      competition: base,
      division: `${base}/${divSlug}`,
      fixtureFinal: `${base}/${divSlug}/fixtures/${f1}`,
      fixtureLive: `${base}/${divSlug}/fixtures/${f2}`,
      fixtureUpcoming: `${base}/${divSlug}/fixtures/${fixtureIds[2]}`,
      footballFinal: `${base}/${fdivSlug}/fixtures/${ffx}`,
      footballUpcoming: `${base}/${fdivSlug}/fixtures/${ff.fixtureIds[1]}`,
      player: `${base}/players/${f1Home.order[0]}`,
      news: `/shared/${orgSlug}/news`,
      register: `${base}/register`,
    },
  };
  return seed;
}

test("W0 — capture every /shared page (seeds unless W0_SEED points at a seed.json)", async ({ page, request, browser }) => {
  mkdirSync(OUT, { recursive: true });
  const seed = process.env.W0_SEED
    ? (JSON.parse(readFileSync(process.env.W0_SEED, "utf8")) as Awaited<ReturnType<typeof seedAll>>)
    : await seedAll(page, request);
  writeFileSync(join(OUT, "seed.json"), JSON.stringify(seed, null, 2));

  // ---- capture, anonymous -------------------------------------------------
  await capture(browser, "org-home", seed.paths.orgHome);
  await capture(browser, "competition", seed.paths.competition);
  await capture(browser, "division-schedule", seed.paths.division);
  await capture(browser, "division-standings", seed.paths.division, (p) => openTab(p, /standings|table/i));
  await capture(browser, "division-entrants", seed.paths.division, (p) => openTab(p, /entrants|teams/i));
  await capture(browser, "fixture-cricket-final", seed.paths.fixtureFinal);
  await capture(browser, "fixture-cricket-live", seed.paths.fixtureLive);
  await capture(browser, "fixture-cricket-upcoming", seed.paths.fixtureUpcoming);
  await capture(browser, "fixture-football-final", seed.paths.footballFinal);
  await capture(browser, "fixture-football-upcoming", seed.paths.footballUpcoming);
  await capture(browser, "player", seed.paths.player);
  await capture(browser, "news", seed.paths.news);
  await capture(browser, "register", seed.paths.register);

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
});
