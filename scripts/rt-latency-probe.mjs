#!/usr/bin/env node
// Mint a live fixture, wait for OPEN_MS, then fire one SIX and print seq.
// Companion: browser measures fetch/DOM latency against wall clock.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3326";
const OPEN_MS = Number(process.env.PROBE_OPEN_MS ?? 8000);
const state = JSON.parse(readFileSync(new URL("./.seed-demo-state.json", import.meta.url), "utf8"));
const EMAIL = process.env.SEED_EMAIL ?? state.pro.email;
const PASSWORD = process.env.SEED_PASSWORD ?? "smokepass123";

const jar = new Map();
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jar.size ? { cookie: cookie() } : {}),
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

const list = (x) => (Array.isArray(x) ? x : (x?.items ?? []));
await call("/api/auth/login", "POST", { email: EMAIL, password: PASSWORD });
const comps = list(await call("/api/v1/competitions"));
const comp = comps.find((c) => (c.name || "").includes("Southend Premier")) ?? comps[0];
if (!comp) throw new Error("no competition — seed demo first");
const tag = Date.now().toString(36).slice(-5);
const div = await call(`/api/v1/competitions/${comp.id}/divisions`, "POST", {
  name: `RT Probe ${tag}`,
  sport_key: "cricket",
  variant_key: "t20",
});
const ents = await call(`/api/v1/divisions/${div.id}/entrants`, "POST", [
  { kind: "team", display_name: `H ${tag}`, seed: 1 },
  { kind: "team", display_name: `A ${tag}`, seed: 2 },
]);
const homeId = ents[0].id;
const awayId = ents[1].id;
const stage = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
  seq: 1,
  kind: "league",
  name: "L",
});
const gen = await call(`/api/v1/stages/${stage.id}/generate`, "POST");
await call(`/api/v1/divisions/${div.id}/start`, "POST");
const fid = gen.fixtures[0].id;

async function squad(entrantId, names) {
  const members = [];
  for (const full_name of names) {
    const person = await call("/api/v1/persons", "POST", { full_name, consent: {} });
    members.push({ person_id: person.id, is_captain: members.length === 0, roles: [] });
  }
  await call(`/api/v1/entrants/${entrantId}`, "PATCH", { members });
  const ids = members.map((m) => m.person_id);
  await call(`/api/v1/fixtures/${fid}/lineups/${entrantId}`, "PUT", {
    slots: ids.map((person_id, i) => ({
      person_id,
      slot: "starting",
      order_no: i + 1,
      roles: [],
    })),
  });
  return ids;
}

const bat = await squad(homeId, ["P1", "P2", "P3", "P4", "P5"]);
const bowl = await squad(awayId, ["B1", "B2", "B3", "B4", "B5"]);
let seq = 0;
async function post(type, payload) {
  const r = await call(`/api/v1/fixtures/${fid}/events`, "POST", {
    expected_seq: seq,
    type,
    payload,
  });
  seq = r.seq;
  return r;
}

await post("cricket.toss", { wonBy: homeId, elected: "bat" });
await post("core.start", {});

const url = `${BASE}/overlay/fixtures/${fid}?style=bar`;
writeFileSync("/tmp/seazn-env/overlay-eoo/rt-probe.json", JSON.stringify({ fid, seq, url }, null, 2));
console.log(`OPEN ${url}`);
console.log(`waiting ${OPEN_MS}ms for overlay to subscribe…`);
await sleep(OPEN_MS);

const t0 = Date.now();
await post("cricket.ball", {
  over: 0,
  ballInOver: 1,
  striker: bat[0],
  nonStriker: bat[1],
  bowler: bowl[0],
  runs: { bat: 6 },
  boundary: 6,
});
const t1 = Date.now();
writeFileSync(
  "/tmp/seazn-env/overlay-eoo/rt-probe-event.json",
  JSON.stringify({ fid, seq, postedAt: t1, postMs: t1 - t0, url }, null, 2),
);
console.log(`POSTED_SIX seq=${seq} at=${t1} postMs=${t1 - t0}`);

await sleep(2000);
await post("cricket.ball", {
  over: 0,
  ballInOver: 2,
  striker: bat[0],
  nonStriker: bat[1],
  bowler: bowl[0],
  runs: { bat: 0 },
  wicket: { kind: "bowled", bowlerCredited: true, out: bat[0] },
});
console.log(`POSTED_OUT seq=${seq} at=${Date.now()}`);
