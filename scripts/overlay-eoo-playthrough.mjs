#!/usr/bin/env node
// Live overlay demo on the BAR theme (never slate): mint a fresh 2-team
// fixture, toss → start → two short innings packed with 6 / 4 / W ×3 each.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3326";
const GAP_MS = Number(process.env.DEMO_GAP_MS ?? 5000);
const OPEN_WAIT_MS = Number(process.env.DEMO_OPEN_WAIT_MS ?? 15000);
const PASSWORD = process.env.SEED_PASSWORD ?? "smokepass123";
const state = JSON.parse(readFileSync(new URL("./.seed-demo-state.json", import.meta.url), "utf8"));
const EMAIL = process.env.SEED_EMAIL ?? state.pro.email;

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (x) => (Array.isArray(x) ? x : (x?.items ?? []));

async function call(path, method = "GET", body) {
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
  if (!res.ok || json.ok === false) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data ?? json;
}

const log = (msg) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
};

async function step(label, fn) {
  log(label);
  if (fn) await fn();
  await sleep(GAP_MS);
}

await call("/api/auth/login", "POST", { email: EMAIL, password: PASSWORD });

const comps = list(await call("/api/v1/competitions"));
const comp = comps.find((c) => (c.name || "").includes("Southend Premier")) ?? comps[0];
if (!comp) throw new Error("no competition — seed demo first");

const tag = Date.now().toString(36).slice(-5);
const div = await call(`/api/v1/competitions/${comp.id}/divisions`, "POST", {
  name: `Overlay demo ${tag}`,
  sport_key: "cricket",
  variant_key: "t20",
});
const ents = await call(`/api/v1/divisions/${div.id}/entrants`, "POST", [
  { kind: "team", display_name: `Demo Home ${tag}`, seed: 1 },
  { kind: "team", display_name: `Demo Away ${tag}`, seed: 2 },
]);
const homeId = ents[0].id;
const awayId = ents[1].id;
const stage = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
  seq: 1,
  kind: "league",
  name: "League",
});
const gen = await call(`/api/v1/stages/${stage.id}/generate`, "POST");
await call(`/api/v1/divisions/${div.id}/start`, "POST");
const fixture = { id: gen.fixtures[0].id, home_entrant_id: homeId, away_entrant_id: awayId };

let seq = 0;
const post = async (type, payload) => {
  const r = await call(`/api/v1/fixtures/${fixture.id}/events`, "POST", {
    expected_seq: seq,
    type,
    payload,
  });
  seq = r.seq;
  return r;
};

async function squad(entrantId, names) {
  const members = [];
  for (const full_name of names) {
    const person = await call("/api/v1/persons", "POST", { full_name, consent: {} });
    members.push({ person_id: person.id, is_captain: members.length === 0, roles: [] });
  }
  await call(`/api/v1/entrants/${entrantId}`, "PATCH", { members });
  const ids = members.map((m) => m.person_id);
  await call(`/api/v1/fixtures/${fixture.id}/lineups/${entrantId}`, "PUT", {
    slots: ids.map((person_id, i) => ({
      person_id,
      slot: "starting",
      order_no: i + 1,
      roles: [],
    })),
  });
  return ids;
}

// 5 batters minimum for 3 wickets (2 at crease + 3 replacements).
const HOME = ["Ava Thorne", "Ben Okoro", "Chloe Patel", "Dan Reeves", "Ellie Marsh", "Finn Hartley"];
const AWAY = ["Grace Quinn", "Hassan Ali", "Isla Brooks", "Jack Nolan", "Kai Singh", "Lila Costa"];

log("Preparing lineups…");
const battingFirst = await squad(homeId, HOME);
const bowlingFirst = await squad(awayId, AWAY);

// BAR only — never slate.
const url = `${BASE}/overlay/fixtures/${fixture.id}?style=bar`;
writeFileSync("/tmp/seazn-env/overlay-eoo/demo-url.txt", url + "\n");
log(`OPEN THIS (bar) — ${OPEN_WAIT_MS / 1000}s then we go live:\n  ${url}`);
await sleep(OPEN_WAIT_MS);

// Short path onto the live bar: toss → start (no long pre-match slate hold).
await step("Toss — home won, elected to bat", () =>
  post("cricket.toss", { wonBy: homeId, elected: "bat" }),
);
await step("Match start", () => post("core.start", {}));

// 2 overs: six / four / out each TWICE (moment slabs), then singles to fill.
const SCRIPT_1 = ["6", "4", "W", "6", "4", "W", "1", "1", "1", "1", "1", "2"];
// Same highlights; last ball a four so the chase clears ~27.
const SCRIPT_2 = ["6", "4", "W", "6", "4", "W", "1", "1", "1", "1", "1", "4"];

async function playInnings(label, script, batting, bowling) {
  let strikerIx = 0;
  let nonStrikerIx = 1;
  let nextIn = 2;
  let legalBalls = 0;
  const cross = () => {
    [strikerIx, nonStrikerIx] = [nonStrikerIx, strikerIx];
  };

  for (const tok of script) {
    const over = Math.floor(legalBalls / 6);
    const ballInOver = (legalBalls % 6) + 1;
    const bowler = bowling[over % bowling.length];
    const striker = batting[strikerIx];
    const nonStriker = batting[nonStrikerIx];
    const base = { over, ballInOver, striker, nonStriker, bowler };

    if (tok === "W") {
      if (nextIn >= batting.length) throw new Error("no replacement batter");
      await step(`${label} · ${over}.${ballInOver} OUT`, () =>
        post("cricket.ball", {
          ...base,
          runs: { bat: 0 },
          wicket: { kind: "bowled", bowlerCredited: true, out: striker },
        }),
      );
      strikerIx = nextIn++;
      legalBalls += 1;
      if (legalBalls % 6 === 0) cross();
      continue;
    }

    const runs = tok === "." ? 0 : Number(tok);
    const boundary = runs === 4 || runs === 6 ? runs : undefined;
    await step(`${label} · ${over}.${ballInOver} ${tok}`, () =>
      post("cricket.ball", {
        ...base,
        runs: { bat: runs },
        ...(boundary !== undefined ? { boundary } : {}),
      }),
    );
    if (boundary === undefined && runs % 2 === 1) cross();
    legalBalls += 1;
    if (legalBalls % 6 === 0) cross();
  }
}

await playInnings("Inn 1", SCRIPT_1, battingFirst, bowlingFirst);
await step("Close 1st innings", () => post("cricket.innings.close", {}));
await playInnings("Inn 2", SCRIPT_2, bowlingFirst, battingFirst);

const final = await call(`/api/v1/fixtures/${fixture.id}/state`);
log(`DONE — status=${final.status} headline=${final.summary?.headline ?? "(none)"}`);
log(`Overlay: ${url}`);
