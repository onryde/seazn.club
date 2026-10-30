import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// The client-safe vocabulary the app itself imports (no imports of its own, so it loads under `--experimental-strip-types`):
// the scope and consent version a connection row carries, Google's policy links, and the watch-URL builder.
import {
  GOOGLE_PRIVACY_URL, GOOGLE_THIRD_PARTY_ACCESS_URL, YOUTUBE_CONSENT_VERSION, YOUTUBE_SCOPE, YOUTUBE_TOS_URL, youtubeWatchUrl,
} from "../../../apps/web/src/lib/youtube.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, setPlan, smokeDb, html, timedFixture, v1, v1data,
} from "../harness.ts";

/**
 * YouTube Connect (spec 2026-10-27, plan T21) over real HTTP, against a server on the FAKE YouTube (YOUTUBE_DRIVER=fake, ENV_NAME ci
 * or local) and the fake relay: ELEVEN probes, each a surface a customer or the cron Worker reaches, so a PR that breaks one is red at
 * PR time (e2e runs on a push to main only). The probes, in order, each under the name its owning task cites:
 *   1 stream-tick answers (T1, T13-T15)          6 fake control route answers in fake mode (T5)
 *   2 relay-sweep answers (T17)                  7 Streaming page renders Connect YouTube (T9)
 *   3 connect without consent is refused (T7)    8 public match page lists parts (T16)
 *   4 reconnect-needed refusal (T2, T10-T12)     9 disconnect unknown -> 404 (T18)
 *   5 list shape (T3, T8)                       10 /legal/privacy names YouTube API Services (T19)
 *                                               11 a made-for-kids replay links out (owner 2026-10-29)
 *
 * ANTI-VACUITY. The suite reports `probes === 11` and fails on fewer; a probe that made no check fails; a probe that THREW is a red
 * line naming only its class (or its own premise message), never a response body. Nothing here skips: a missing CRON_SECRET or
 * DATABASE_URL is a red check, because a skip would read as a pass. Every negative has its positive pair (a 400 beside the 303 the
 * same request earns with consent; a 404 beside the 200 a real disconnect earns) so a route that refuses everything cannot pass.
 *
 * SEEDS. Own two fresh Pro orgs, purged by cleanup(). Channels that must WORK are connected through the REAL flow over HTTP (start ->
 * fake Google -> callback: the producer of a sealed token). Probe 4 then moves its channel to `reconnect_needed` through the smoke's
 * postgres handle - the update the app's own `markReconnectNeeded` makes - so the status is the ONLY thing that can refuse Go live (the
 * token opens, the fake would accept it) and moving it back is the pair that proves it. The rows probes 5, 7, 8 and 9 only LIST are written
 * through the same handle with a token that opens nothing, always as `reconnect_needed`: the daily pass health-checks only `connected`
 * rows, so such a seed can never turn probe 2's own-row check red (that probe reads its own connection row, never the pass's server-wide counters). No token, key or KEK is ever printed.
 *
 * ONE SPORT (generic), by design: nothing under server/youtube/ or the connect panel reads a sport (the walkthrough's header says the
 * same). SMOKE_ONLY=youtubeConnect runs it alone (SELECTABLE_SUITES).
 */
const PROBES = [
  "stream-tick answers",
  "relay-sweep answers",
  "connect without consent is refused",
  "reconnect-needed refusal",
  "list shape",
  "fake control route answers in fake mode",
  "Streaming page renders Connect YouTube",
  "public match page lists parts",
  "disconnect unknown -> 404",
  "/legal/privacy names YouTube API Services",
  "a made-for-kids replay links out",
] as const;
type ProbeName = (typeof PROBES)[number];
const EXPECTED_PROBES = PROBES.length;

/** A premise that did not hold: thrown with a message THIS file wrote (never a response), so a probe's red line may print it. */
class PremiseError extends Error {}
const premise = (cond: boolean, message: string): void => {
  if (!cond) throw new PremiseError(message);
};

type Db = ReturnType<typeof smokeDb>;
async function withDb<T>(fn: (sql: Db) => Promise<T>): Promise<T> {
  const sql = smokeDb();
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

interface Org {
  s: Session;
  orgId: string;
  orgSlug: string;
  userId: string;
}
/** A fresh owner on a fresh Pro org (a monthly credit to spend, the relay and the Streaming page offered). */
async function openOrg(label: string): Promise<Org> {
  const s = newSession();
  const email = `delivered+${label}_${tag}@resend.dev`;
  const ver = await signIn(s, email);
  await setPlan(ver.org_id, "pro", s);
  const orgs = (await call(s, "/api/orgs")) as { id: string; slug: string }[];
  const mine = orgs.find((o) => o.id === ver.org_id);
  const [user] = await withDb((sql) => sql<{ id: string }[]>`select id from users where email = ${email}`);
  premise(!!mine && !!user, `${label}: the signed-in owner's org and user rows were not found`);
  return { s, orgId: ver.org_id, orgSlug: mine?.slug ?? "", userId: user?.id ?? "" };
}

/** A started generic league of two: one fixture, in a division of its own. */
async function genericFixture(o: Org, compId: string, name: string): Promise<{ fixtureId: string; divisionId: string }> {
  const fx = await timedFixture(o.s, compId, {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    entrants: [
      { kind: "individual", display_name: `YT A ${tag}`, seed: 1 },
      { kind: "individual", display_name: `YT B ${tag}`, seed: 2 },
    ],
  });
  return { fixtureId: fx.fixtureId, divisionId: fx.divisionId };
}

/** A channel row the way the app writes one, minus the sealed token: the bytes are random and open under no key (the schema only wants
 *  them present while the row is not revoked), its destination row beside it. `reconnect_needed` on purpose - see the header. */
async function seedChannel(o: Org, title: string): Promise<{ connectionId: string; targetId: string; channelId: string }> {
  const channelId = `UC${randomBytes(11).toString("hex")}`;
  return withDb(async (sql) => {
    const [c] = await sql<{ id: string }[]>`
      insert into org_youtube_connections
        (org_id, channel_id, channel_title, refresh_token_enc, granted_scope, consent_by, consent_at, consent_version, status, last_error_code, created_by)
      values (${o.orgId}, ${channelId}, ${title}, ${randomBytes(48)}, ${YOUTUBE_SCOPE}, ${o.userId}, now(), ${YOUTUBE_CONSENT_VERSION},
              'reconnect_needed', 'youtube_reconnect_needed', ${o.userId})
      returning id`;
    premise(!!c, "the seeded connection row was not returned");
    const [t] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, youtube_connection_id)
      values (${o.orgId}, 'youtube', ${title}, ${c?.id ?? null})
      returning id`;
    premise(!!t, "the seeded destination row was not returned");
    return { connectionId: c?.id ?? "", targetId: t?.id ?? "", channelId };
  });
}

/** A connection's status, moved the way the app moves it: `markReconnectNeeded` (a dead grant seen in use) and a reconnect's save. */
const setStatus = (connectionId: string, status: "connected" | "reconnect_needed"): Promise<unknown> =>
  withDb((sql) => sql`
    update org_youtube_connections
       set status = ${status}, status_since = now(), last_error_code = ${status === "connected" ? null : "youtube_reconnect_needed"}
     where id = ${connectionId}`);

type StreamTargetRow = {
  id: string;
  kind: string;
  label: string;
  keyHint: string | null;
  inUse: unknown;
  youtube: { connectionId: string; channelId: string; channelTitle: string; status: string } | null;
};
const listTargets = async (o: Org): Promise<StreamTargetRow[]> =>
  v1data<StreamTargetRow[]>(await v1(o.s, `/api/v1/orgs/${o.orgId}/stream-targets`)) ?? [];

/** The fake YouTube's control route (a JSON POST, no auth, 404 unless the process runs the fake on a named environment). */
async function fakeOp(body: unknown): Promise<{ status: number; text: string; json: { ok?: boolean; data?: Record<string, unknown> } | null }> {
  const res = await fetch(`${BASE}/api/internal/youtube/fake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { ok?: boolean; data?: Record<string, unknown> } | null = null;
  try {
    json = JSON.parse(text) as { ok?: boolean; data?: Record<string, unknown> };
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/** One YouTube connect, start to landing, with `fetch` standing in for the browser: the consent form's POST, the fake Google's authorize
 *  hop, the callback. The cookies the start sets (state and PKCE verifier) ride the next two requests, as a browser would send them. */
async function connectOverHttp(o: Org, channel: { id: string; title: string }): Promise<{ connectionId: string; targetId: string }> {
  const jar: Record<string, string> = {};
  const take = (res: Response): void => {
    for (const c of res.headers.getSetCookie()) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m?.[1] !== undefined) jar[m[1]] = m[2] ?? "";
    }
  };
  const cookies = (): string => [cookieHeader(o.s), ...Object.entries(jar).map(([k, v]) => `${k}=${v}`)].filter((x) => x !== "").join("; ");
  const start = await fetch(`${BASE}/api/youtube/connect`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookies(), "content-type": "application/x-www-form-urlencoded" },
    // Both consent boxes, as the form posts them ticked: the terms (`consent`) and YouTube's under-16 rule (`consentMinors`).
    body: new URLSearchParams({ orgId: o.orgId, privacy: "unlisted", consent: "1", consentMinors: "1" }),
  });
  take(start);
  premise(start.status === 303, `the connect start answered ${start.status}, not the 303 to the authorize hop`);
  const authorize = new URL(start.headers.get("location") ?? "", BASE);
  const state = authorize.searchParams.get("state");
  premise(!!state, "the connect start's Location carried no OAuth state");
  const offered = await fakeOp({ op: "setChannels", channels: [channel], state });
  premise(offered.status === 200, `the fake YouTube refused the channel offer (${offered.status})`);
  const hop = await fetch(`${BASE}${authorize.pathname}${authorize.search}`, { redirect: "manual", headers: { cookie: cookies() } });
  take(hop);
  premise(hop.status === 303, `the authorize hop answered ${hop.status}, not the 303 back to the callback`);
  const back = new URL(hop.headers.get("location") ?? "", BASE);
  const callback = await fetch(`${BASE}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: cookies() } });
  const landed = callback.headers.get("location") ?? "";
  premise(callback.status === 303 && landed.includes("youtube=connected"), `the callback answered ${callback.status} landing "${landed.replace(/[?&](code|state)=[^&]*/g, "")}", not a connected channel`);
  const row = (await listTargets(o)).find((t) => t.youtube?.channelId === channel.id);
  premise(!!row?.youtube, "the connected channel is not in the destination list");
  return { connectionId: row?.youtube?.connectionId ?? "", targetId: row?.id ?? "" };
}

/** A phone paired to the fixture's stream code and answering now: Go live's W5 gate (`phone_not_paired`) outranks the YouTube prepare. */
async function pairPhone(o: Org, fixtureId: string): Promise<void> {
  const minted = await v1(o.s, `/api/v1/fixtures/${fixtureId}/stream-code`, "POST");
  const qr = (minted.json.data as { qr?: { code: string; slot: number; tok: string } } | undefined)?.qr;
  premise(minted.status === 200 && !!qr, `minting the stream code answered ${minted.status}`);
  if (!qr) return;
  const res = await fetch(`${BASE}/api/v1/capture/codes/${qr.code}/beats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qr.tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      code: qr.code, slot: qr.slot, phone: randomBytes(16).toString("hex"), claim: "new", device: { model: "Smoke phone" }, sid: null,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), state: "paired", cause: null, notReady: null,
      startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown",
      deliveredLagS: null, audioOk: null, battery: { percent: 80, charging: false, drainPctPerHour: null }, thermal: 0,
      dataUsedMB: 0, appVersion: "1.4.0",
    }),
  });
  const answer = (await res.json().catch(() => null)) as { state?: string } | null;
  premise(res.status === 200 && answer?.state === "waiting", `the phone's claim answered ${res.status}, not a paired phone waiting`);
}

/** The part of a page from `marker` to the first `</section>` after it ("" when the marker is not there). */
function sectionFrom(body: string, marker: string): string {
  const at = body.indexOf(marker);
  if (at < 0) return "";
  const end = body.indexOf("</section>", at);
  return end < 0 ? body.slice(at) : body.slice(at, end);
}

const EN_UI = JSON.parse(readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, string>;
/** An English dictionary line with its `{vars}` filled in - the copy the page renders, read from the dictionary, not typed here. */
function en(key: string, vars: Record<string, string | number> = {}): string {
  const raw = EN_UI[key];
  premise(raw !== undefined, `ui.json has no ${key}`);
  return (raw ?? "").replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? `{${v}}`));
}

type CronBody = { ok?: boolean; data?: Record<string, unknown> } | null;
async function cronPost(path: string, secret: string): Promise<{ status: number; body: CronBody }> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "x-cron-secret": secret } });
  return { status: res.status, body: (await res.json().catch(() => null)) as CronBody };
}
const allNumbers = (o: Record<string, unknown> | undefined, keys: readonly string[]): boolean => !!o && keys.every((k) => typeof o[k] === "number");

export async function youtubeConnectSuite(): Promise<void> {
  let probes = 0;
  let checks = 0;
  const ran = new Set<ProbeName>();
  /** One probe: counted, its checks counted, and a throw is ONE red line (the premise's own words, else the class) - the rest still run. */
  const probe = async (name: ProbeName, body: (step: (label: string, cond: boolean) => void) => Promise<void>): Promise<void> => {
    probes++;
    ran.add(name);
    let mine = 0;
    const step = (label: string, cond: boolean): void => {
      mine++;
      checks++;
      check(`youtube: ${name} - ${label}`, cond);
    };
    try {
      await body(step);
    } catch (e) {
      step(`did not complete (${e instanceof PremiseError ? e.message : e instanceof Error ? e.name : typeof e})`, false);
    }
    if (mine === 0) check(`youtube: ${name} - made at least one check`, false);
  };

  // The environment this suite needs. A red check, not a skip: a skipped probe reads as a pass.
  const secret = process.env.CRON_SECRET ?? "";
  if (!process.env.DATABASE_URL) {
    check("youtube: this suite needs DATABASE_URL (it seeds rows through the smoke's postgres handle)", false);
    return;
  }

  const a = await openOrg("ytconnect");
  const b = await openOrg("ytconnect_b");
  const comp = v1data<{ id: string; slug: string }>(
    await v1(a.s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `YouTube Connect ${tag}`, visibility: "public" }),
  );

  // The one channel connected through the REAL producer. A failure is held and read by the probes that need the channel, so the
  // others still run; the message is this file's own.
  let real: { connectionId: string; targetId: string; channelId: string } | null = null;
  let realFailure = "";
  const realChannel = { id: `UC${randomBytes(11).toString("hex")}`, title: `Smoke Channel ${tag}` };
  try {
    real = { ...(await connectOverHttp(a, realChannel)), channelId: realChannel.id };
  } catch (e) {
    realFailure = e instanceof PremiseError ? e.message : `the real connect threw ${e instanceof Error ? e.name : typeof e}`;
  }

  // --- 1. stream-tick answers (T1, T13, T14, T15) ---------------------------------------------------------------------------
  await probe("stream-tick answers", async (step) => {
    premise(secret !== "", "CRON_SECRET is not in the smoke env, so the right-secret answer cannot be read (the server and the smoke must share it)");
    const wrong = await fetch(`${BASE}/api/cron/stream-tick`, { method: "POST", headers: { "x-cron-secret": "definitely-wrong-youtube-tick" } });
    step(`a wrong secret is refused 401 (got ${wrong.status})`, wrong.status === 401);
    // The tick is GLOBAL (every organisation's broadcasts), so its `failed` is not this suite's to pin at 0 on a database other runs
    // have used. What it CAN bound is the rows it may fail: one count per broadcast that was open when the tick began, so the count
    // is read BEFORE (a row the tick finalizes `failed` is no longer open afterwards). Only the rows of organisations that are not
    // this suite's: on a clean database that is 0, i.e. the strict `failed === 0`.
    const othersOpen = await withDb(async (sql) => {
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from youtube_broadcasts
         where state in ('created', 'bound', 'reserved', 'live', 'ending') and org_id <> ${a.orgId} and org_id <> ${b.orgId}`;
      return r?.n;
    });
    premise(typeof othersOpen === "number", "the count of other organisations' open broadcasts was not returned");
    const right = await cronPost("/api/cron/stream-tick", secret);
    const yt = right.body?.data?.youtube as Record<string, unknown> | undefined;
    step(`the right secret answers 200 (got ${right.status})`, right.status === 200 && right.body?.ok === true);
    // The cron Worker reads data.failed AND data.youtube.failed; a renamed or dropped counter reads as "unreadable", i.e. degraded.
    step(
      "data.youtube carries a number for ended, neverLive, orphans, failed and deferred, and data.failed is a number",
      allNumbers(yt, ["ended", "neverLive", "orphans", "failed", "deferred"]) && typeof right.body?.data?.failed === "number",
    );
    step(
      `data.youtube.failed is at most the ${String(othersOpen)} open broadcast(s) of other organisations (got ${String(yt?.failed)}): the end step ran, and a whole-step failure (answered failed: 1) shows on a database holding none`,
      typeof yt?.failed === "number" && typeof othersOpen === "number" && yt.failed <= othersOpen,
    );
  });

  // --- 2. relay-sweep answers (T17) -------------------------------------------------------------------------------------------
  await probe("relay-sweep answers", async (step) => {
    premise(secret !== "", "CRON_SECRET is not in the smoke env");
    premise(real !== null, `the channel this probe's health check must visit was not connected: ${realFailure}`);
    const ownRow = (): Promise<{ status: string; last_health_at: Date | null; last_error_code: string | null } | undefined> =>
      withDb(async (sql) => {
        const [r] = await sql<{ status: string; last_health_at: Date | null; last_error_code: string | null }[]>`
          select status, last_health_at, last_error_code from org_youtube_connections where id = ${real?.connectionId ?? ""}`;
        return r;
      });
    // The witness is OUR row, not the pass's server-wide counters (a database other runs used holds rows this suite never made, sealed
    // under keys this server no longer has: they count `failed` and `checked` whatever this suite does). A connection is saved with
    // last_health_at NULL and only a SUCCESSFUL health check stamps it, so non-null afterwards is the sweep reaching this row, opening
    // its sealed token under the server's key and getting an answer from the (fake) YouTube. Asserted null BEFORE, or "stamped" proves nothing.
    const before = await ownRow();
    premise(before?.status === "connected" && before.last_health_at === null, "the channel did not start connected and never health-checked");
    const wrong = await fetch(`${BASE}/api/cron/relay-sweep`, { method: "POST", headers: { "x-cron-secret": "definitely-wrong-youtube-sweep" } });
    step(`a wrong secret is refused 401 (got ${wrong.status})`, wrong.status === 401);
    const right = await cronPost("/api/cron/relay-sweep", secret);
    const yt = right.body?.data?.youtube as Record<string, unknown> | undefined;
    step(`the right secret answers 200 (got ${right.status})`, right.status === 200 && right.body?.ok === true);
    step(
      "data.youtube carries a number for checked, reconnectNeeded, refreshed, removed, keysRemoved, purged, failed and deferred",
      allNumbers(yt, ["checked", "reconnectNeeded", "refreshed", "removed", "keysRemoved", "purged", "failed", "deferred"]),
    );
    const after = await ownRow();
    step(
      `this probe's own channel was health-checked: still connected, last_health_at stamped (got ${String(after?.status)}, ${after?.last_health_at ? "stamped" : "not stamped"})`,
      after?.status === "connected" && after.last_health_at instanceof Date,
    );
    step(
      `...and the check found nothing wrong with it: last_error_code is null (got ${String(after?.last_error_code)})`,
      after?.last_error_code === null,
    );
  });

  // --- 3. connect without consent is refused (T7) -----------------------------------------------------------------------------
  await probe("connect without consent is refused", async (step) => {
    // The consent is two boxes (PO 2026-10-30): the terms (`consent`) and YouTube's under-16 rule (`consentMinors`). Only both is a consent.
    const send = (boxes: { terms: boolean; minors: boolean }): Promise<Response> =>
      fetch(`${BASE}/api/youtube/connect`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: cookieHeader(a.s), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ orgId: a.orgId, privacy: "unlisted", ...(boxes.terms ? { consent: "1" } : {}), ...(boxes.minors ? { consentMinors: "1" } : {}) }),
      });
    const refused = await send({ terms: false, minors: false });
    step(`the form without either consent box is refused 400 (got ${refused.status})`, refused.status === 400);
    const termsOnly = await send({ terms: true, minors: false });
    step(`the form with only the terms box is refused 400 (got ${termsOnly.status})`, termsOnly.status === 400);
    const minorsOnly = await send({ terms: false, minors: true });
    step(`the form with only the under-16 box is refused 400 (got ${minorsOnly.status})`, minorsOnly.status === 400);
    // The pair: the same request with both boxes ticked is what sends the person on, to the authorize hop (the fake Google in CI).
    const ticked = await send({ terms: true, minors: true });
    const where = new URL(ticked.headers.get("location") ?? "", BASE);
    step(
      `the same form with consent=1 and consentMinors=1 is sent on: 303 to the fake authorize hop (got ${ticked.status} ${where.pathname})`,
      ticked.status === 303 && where.pathname === "/api/youtube/connect/fake-authorize" && where.searchParams.has("state"),
    );
  });

  // --- 4. reconnect-needed refusal (T2, T10, T11, T12) ------------------------------------------------------------------------
  await probe("reconnect-needed refusal", async (step) => {
    // A channel connected for real: its token opens and the fake YouTube would take it, so only its STATUS can refuse Go live. (A seed
    // whose token opens nothing is refused for that too: two guards covering for each other, each untested.)
    const channel = { id: `UC${randomBytes(11).toString("hex")}`, title: `Dead Channel ${tag}` };
    const dead = await connectOverHttp(a, channel);
    const fx = await genericFixture(a, comp.id, "Refusal");
    await pairPhone(a, fx.fixtureId);
    const goLive = (): Promise<Awaited<ReturnType<typeof v1>>> =>
      v1(a.s, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", { mode: "passthrough", targetId: dead.targetId });

    await setStatus(dead.connectionId, "reconnect_needed");
    const live = await goLive();
    // Typed by annotation, not assertion: the wire envelope's declared error has no `connectionId`, the refusal's `extra` carries it.
    const err: { code?: string; connectionId?: string } | undefined = live.json.error;
    step(`Go live on a reconnect_needed channel is 409 youtube_reconnect_needed (got ${live.status} ${err?.code ?? ""})`, live.status === 409 && err?.code === "youtube_reconnect_needed");
    step("the refusal names the connection so the panel can link its fix", err?.connectionId === dead.connectionId);
    const [rows] = await withDb((sql) => sql<{ sessions: number; broadcasts: number }[]>`
      select (select count(*)::int from fixture_stream_sessions where fixture_id = ${fx.fixtureId}) as sessions,
             (select count(*)::int from youtube_broadcasts where fixture_id = ${fx.fixtureId}) as broadcasts`);
    step(`no session row and no broadcast row was written (sessions ${rows?.sessions}, broadcasts ${rows?.broadcasts})`, rows?.sessions === 0 && rows?.broadcasts === 0);

    // The pair: the same destination, the same phone, the same fixture, the channel connected again - and Go live is admitted. Without
    // it the 409 above could be any 409; with it the status is what refused.
    await setStatus(dead.connectionId, "connected");
    const admitted = await goLive();
    const sessionId = (admitted.json.data as { sessionId?: string } | undefined)?.sessionId;
    step(`the same channel, connected again, is admitted: 201 with a session (got ${admitted.status} ${admitted.json.error?.code ?? ""})`, admitted.status === 201 && !!sessionId);
    if (sessionId) {
      const stopped = await v1(a.s, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions/${sessionId}/stop`, "POST");
      step(`...and its session is stopped again, leaving nothing running (got ${stopped.status})`, stopped.status === 200);
    }
  });

  // --- 5. list shape (T3, T8) -------------------------------------------------------------------------------------------------
  await probe("list shape", async (step) => {
    premise(real !== null, `the connected channel this probe compares against was not connected: ${realFailure}`);
    const seed = await seedChannel(a, `Listed Channel ${tag}`);
    const pasted = await v1(a.s, `/api/v1/orgs/${a.orgId}/stream-targets`, "POST", { kind: "twitch", label: `pasted ${tag}`, streamKey: `live_1_${randomBytes(12).toString("hex")}` });
    const pastedId = (pasted.json.data as { id?: string } | undefined)?.id;
    premise(pasted.status === 201 && !!pastedId, `adding a pasted destination answered ${pasted.status}`);
    const list = await listTargets(a);
    const dead = list.find((t) => t.id === seed.targetId);
    step(
      `the API row carries youtube.status reconnect_needed, with that connection and channel (got ${dead?.youtube?.status})`,
      dead?.kind === "youtube" && dead.youtube?.status === "reconnect_needed" && dead.youtube.connectionId === seed.connectionId && dead.youtube.channelId === seed.channelId,
    );
    step(`...keyHint is null and inUse is null (got ${String(dead?.keyHint)} and ${String(dead?.inUse)})`, dead?.keyHint === null && dead.inUse === null);
    // The differentials: the same list tells the three kinds of row apart.
    const connected = list.find((t) => t.id === real?.targetId);
    step(`the REAL connected channel in the same list reads connected (got ${connected?.youtube?.status})`, connected?.youtube?.status === "connected");
    const key = list.find((t) => t.id === pastedId);
    step(
      "a pasted-key destination has youtube null and a 3-character keyHint",
      key !== undefined && key.youtube === null && typeof key.keyHint === "string" && key.keyHint.length === 3,
    );
    const removed = await v1(a.s, `/api/v1/orgs/${a.orgId}/stream-targets/${pastedId}`, "DELETE");
    step(`the pasted destination is removed again (got ${removed.status})`, removed.status === 200);
  });

  // --- 6. fake control route answers in fake mode (T5) ------------------------------------------------------------------------
  await probe("fake control route answers in fake mode", async (step) => {
    premise(real !== null, `the connected channel whose grant the route must name was not connected: ${realFailure}`);
    const fx = await genericFixture(a, comp.id, "Control");
    // Pinned to the real channel: with no saved choice the route resolves the org's oldest destination, which this order does not own.
    const pinned = await v1(a.s, `/api/v1/fixtures/${fx.fixtureId}/stream-settings`, "PUT", { targetId: real?.targetId });
    premise(pinned.status === 200, `pinning the fixture's destination answered ${pinned.status}`);
    const state = await fakeOp({ op: "state", fixtureId: fx.fixtureId });
    const data = state.json?.data;
    step(`{op:"state"} answers 200 (got ${state.status})`, state.status === 200 && state.json?.ok === true);
    step(
      "it names the fixture's connection and a token HANDLE, and no broadcasts yet",
      data?.connectionId === real?.connectionId && typeof data?.tokenHandle === "string" && data.tokenHandle !== "" && Array.isArray(data?.broadcasts) && data.broadcasts.length === 0,
    );
    // "No token or key": the answer holds exactly these three keys, no Google refresh token (they begin 1//), no stream key or ingest URL.
    const keys = Object.keys(data ?? {}).sort().join(",");
    step(`the body holds only {broadcasts, connectionId, tokenHandle} (got ${keys})`, keys === "broadcasts,connectionId,tokenHandle");
    step("the body carries no refresh token, stream key, ingest URL or secret", !state.text.includes("1//") && !/rtmp|streamkey|ingest|refresh|secret|password/i.test(state.text));
    const unknown = await fakeOp({ op: "state", fixtureId: randomUUID() });
    step(`an unknown fixture is 404 (got ${unknown.status})`, unknown.status === 404);
    const bad = await fakeOp({ op: "not-an-op" });
    step(`a body that is not one of the ops is 400 (got ${bad.status})`, bad.status === 400);
  });

  // --- 7. the Streaming page renders Connect YouTube (T9; the Directory's tab moved to /streaming in B6) -----------------------
  await probe("Streaming page renders Connect YouTube", async (step) => {
    // A fresh org with no destination: the empty card offers Connect YouTube; the button of the populated page is not there.
    const empty = await html(b.s, "/streaming");
    step(
      `an org with no destination: GET /streaming renders the empty card with youtube-connect-empty (got ${empty.status})`,
      empty.status === 200 && empty.body.includes('data-testid="stream-destinations"') && empty.body.includes('data-testid="youtube-connect-empty"') && !empty.body.includes('data-testid="youtube-connect"'),
    );
    // The same org with one channel: the button moves beside "Add destination" and the channel is a row, with Reconnect for a dead grant.
    const title = `Page Channel ${tag}`;
    const seed = await seedChannel(b, title);
    const page = await html(b.s, "/streaming");
    step(
      `with a channel: youtube-connect renders and the empty variant is gone (got ${page.status})`,
      page.status === 200 && page.body.includes('data-testid="youtube-connect"') && !page.body.includes('data-testid="youtube-connect-empty"'),
    );
    step(
      "the channel is a row naming its connection and destination, titled",
      page.body.includes('data-testid="youtube-channel-row"') && page.body.includes(`data-connection-id="${seed.connectionId}"`) && page.body.includes(`data-target-id="${seed.targetId}"`) && page.body.includes(title),
    );
    step(
      "a reconnect_needed channel offers Reconnect, a form posting to the connect route",
      page.body.includes('data-testid="youtube-reconnect-form"') && page.body.includes('action="/api/youtube/connect"') && page.body.includes('data-testid="youtube-reconnect"'),
    );
  });

  // --- 8. the public match page lists parts (T16) -----------------------------------------------------------------------------
  await probe("public match page lists parts", async (step) => {
    const fx = await genericFixture(a, comp.id, "Replay");
    const seed = await seedChannel(a, `Replay Channel ${tag}`);
    const id = () => `smk${randomBytes(4).toString("hex")}`;   // 11 characters: the shape of a video id
    const first = id();
    const second = id();
    const hidden = id();
    const HOUR = 3_600_000;
    const at = (hoursAgo: number): Date => new Date(Date.now() - hoursAgo * HOUR);
    // Three complete broadcasts on ONE fixture. The parts are numbered by START (created_at), so `first` is Part 1 though it FINISHED
    // after `second` (the order differs from the completion order, or the numbering could not be told apart). `hidden` is private on
    // YouTube and STARTED BETWEEN the two others, so it is not the public's to see AND the public's numbers close up over it
    // (Part 1, Part 2 - a view that numbered before it filtered would read Part 1, Part 3, and one that did not filter would show three).
    await withDb(async (sql) => {
      for (const [video, privacy, started, finished] of [
        [first, "unlisted", at(5), at(0.5)],
        [second, "public", at(2), at(1.5)],
        [hidden, "private", at(3.5), at(0.2)],
      ] as const) {
        await sql`
          insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, created_at, completed_at)
          values (false, ${a.orgId}, ${seed.connectionId}, ${fx.fixtureId}, ${video}, ${`Smoke part ${tag}`}, ${privacy}, 'complete', ${started}, ${finished})`;
      }
    });
    const divSlug = v1data<{ slug: string }>(await v1(a.s, `/api/v1/divisions/${fx.divisionId}`)).slug;
    const path = `/shared/${a.orgSlug}/${comp.slug}/${divSlug}/fixtures/${fx.fixtureId}`;
    const page = await html(newSession(), path);   // anonymous: a spectator's view
    const replay = sectionFrom(page.body, 'data-testid="replay-embed"');
    step(`the public page renders the replay region (got ${page.status})`, page.status === 200 && replay !== "");
    const tabs = [...replay.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1] ?? "");
    step(
      `two parts (the private one in between is not a third), as two tabs read from the dictionary: ${JSON.stringify([en("streaming.youtube.part", { n: 1 }), en("streaming.youtube.part", { n: 2 })])} (got ${JSON.stringify(tabs)})`,
      tabs.length === 2 && tabs[0] === en("streaming.youtube.part", { n: 1 }) && tabs[1] === en("streaming.youtube.part", { n: 2 }),
    );
    step(
      "Part 1 is the broadcast that STARTED first: its click-to-play facade and its Open-on-YouTube link name it",
      replay.includes('data-testid="replay-facade"') && replay.includes(`data-testid="replay-open"`) && replay.includes(`href="${youtubeWatchUrl(first)}"`) && !replay.includes(second),
    );
    step("click-to-play: no player iframe is in the page before a tap", !replay.includes("<iframe"));
    step("a broadcast that is private on YouTube, started between the two visible parts, is not on the page at all", !page.body.includes(hidden));
  });

  // --- 9. disconnect unknown -> 404 (T18) -------------------------------------------------------------------------------------
  await probe("disconnect unknown -> 404", async (step) => {
    const unknown = await v1(a.s, `/api/v1/orgs/${a.orgId}/youtube-connections/${randomUUID()}`, "DELETE");
    step(
      `a connection id nobody has is 404 with an error code, not a missing route (got ${unknown.status} ${unknown.json.error?.code ?? ""})`,
      unknown.status === 404 && unknown.json.ok === false && typeof unknown.json.error?.code === "string" && unknown.json.error.code !== "",
    );
    // The positives: a real connection IS disconnected; another organisation's id is the same 404 (no oracle), asked BEFORE the
    // disconnect so the 404 cannot be "already gone".
    const seed = await seedChannel(a, `Leaving Channel ${tag}`);
    const foreign = await v1(b.s, `/api/v1/orgs/${b.orgId}/youtube-connections/${seed.connectionId}`, "DELETE");
    step(`another organisation's connection id is the same 404 (got ${foreign.status})`, foreign.status === 404);
    const stillThere = (await listTargets(a)).some((t) => t.id === seed.targetId);
    step("...and it did not disconnect anything: the connection is still listed", stillThere);
    const gone = await v1(a.s, `/api/v1/orgs/${a.orgId}/youtube-connections/${seed.connectionId}`, "DELETE");
    const out = v1data<{ revokeOutcome?: string; purged?: { broadcasts?: number } } | undefined>(gone);
    // The seed's token opens under no key, so no revoke could be sent: a channel is never undeletable for it (disconnect.ts).
    step(
      `the owner's disconnect is 200, purges nothing it never had, and says the revoke was not confirmed (got ${gone.status} ${String(out?.revokeOutcome)})`,
      gone.status === 200 && out?.revokeOutcome === "not_confirmed" && out.purged?.broadcasts === 0,
    );
    step("...the channel leaves the list", !(await listTargets(a)).some((t) => t.id === seed.targetId));
    const again = await v1(a.s, `/api/v1/orgs/${a.orgId}/youtube-connections/${seed.connectionId}`, "DELETE");
    step(`a second disconnect of it is 404 (got ${again.status})`, again.status === 404);
  });

  // --- 10. /legal/privacy names YouTube API Services (T19) --------------------------------------------------------------------
  await probe("/legal/privacy names YouTube API Services", async (step) => {
    const page = await html(newSession(), "/legal/privacy");
    const section = sectionFrom(page.body, 'id="youtube-api-services"');
    step(`the page has the YouTube section, anchored (got ${page.status})`, page.status === 200 && section !== "");
    step("the section names YouTube API Services", section.includes("YouTube API Services"));
    // Google's API Services policy asks for these links by name; each must sit IN the section, not elsewhere on the page.
    step("it links the YouTube Terms of Service", section.includes(`href="${YOUTUBE_TOS_URL}"`));
    step("it links Google's privacy policy", section.includes(`href="${GOOGLE_PRIVACY_URL}"`));
    step("it links Google's third-party access settings, where a person revokes", section.includes(`href="${GOOGLE_THIRD_PARTY_ACCESS_URL}"`));
  });

  // --- 11. a made-for-kids replay links out (owner 2026-10-29; Google Developer Policies III.E.4.j) --------------------------
  // A page that embeds a video made for kids may not track, and the root layout runs consent-gated analytics, so a made-for-kids replay
  // is a link to YouTube and never a player. The flag is the BROADCAST's own (youtube_broadcasts.made_for_kids), so the two rows below
  // differ only in it; the walkthrough (youtube-connect.spec.ts) is what makes the rows through the real Go live / end step.
  await probe("a made-for-kids replay links out", async (step) => {
    const seed = await seedChannel(a, `Kids Channel ${tag}`);
    const id = () => `smk${randomBytes(4).toString("hex")}`;
    const kidsVideo = id();
    const plainVideo = id();
    const [kidsFx, plainFx] = [await genericFixture(a, comp.id, "Kids replay"), await genericFixture(a, comp.id, "Plain replay")];
    await withDb(async (sql) => {
      for (const [fixtureId, video, kids] of [[kidsFx.fixtureId, kidsVideo, true], [plainFx.fixtureId, plainVideo, false]] as const) {
        await sql`
          insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, created_at, completed_at)
          values (${kids}, ${a.orgId}, ${seed.connectionId}, ${fixtureId}, ${video}, ${`Smoke kids ${tag}`}, 'unlisted', 'complete', now() - interval '2 hours', now() - interval '1 hour')`;
      }
    });
    const replayOf = async (fx: { fixtureId: string; divisionId: string }) => {
      const divSlug = v1data<{ slug: string }>(await v1(a.s, `/api/v1/divisions/${fx.divisionId}`)).slug;
      const page = await html(newSession(), `/shared/${a.orgSlug}/${comp.slug}/${divSlug}/fixtures/${fx.fixtureId}`);   // anonymous
      return { status: page.status, replay: sectionFrom(page.body, 'data-testid="replay-embed"') };
    };
    const kids = await replayOf(kidsFx);
    step(`the made-for-kids match's public page renders the replay region (got ${kids.status})`, kids.status === 200 && kids.replay !== "");
    step("it is the link-out card", kids.replay.includes('data-testid="replay-linkout"'));
    // The link's attributes are read one by one, never as one literal: React serialises props in source order, so a harmless reorder of
    // the JSX must not red this check (it asserts what the link is, not how the tag is spelled). `rel` is compared as a token set.
    const openTag = (kids.replay.match(/<a\b[^>]*\bdata-testid="replay-linkout-open"[^>]*>/) ?? [""])[0];
    const attr = (name: string): string | null => (openTag.match(new RegExp(`\\s${name}="([^"]*)"`)) ?? [])[1] ?? null;
    const relTokens = new Set((attr("rel") ?? "").split(/\s+/).filter(Boolean));
    step(
      "the one link is to the video on YouTube, in a new tab, without the opener",
      openTag !== "" &&
        attr("href") === youtubeWatchUrl(kidsVideo) &&
        attr("target") === "_blank" &&
        relTokens.has("noopener") && relTokens.has("noreferrer") &&
        (kids.replay.match(/<a /g) ?? []).length === 1,
    );
    step(`the link reads the dictionary's "${en("streaming.youtube.replay.watch")}" and the page says why: "${en("streaming.youtube.replay.madeForKids")}"`,
      kids.replay.includes(en("streaming.youtube.replay.watch")) && kids.replay.includes(en("streaming.youtube.replay.madeForKids")));
    step("no player markup: no iframe, no facade play button", !kids.replay.includes("<iframe") && !kids.replay.includes('data-testid="replay-facade"'));
    step("nothing is fetched from Google's hosts: no thumbnail, no embed host", !kids.replay.includes("ytimg.com") && !kids.replay.includes("youtube-nocookie.com") && !kids.replay.includes("<img"));
    // The positive pair: the same page for a broadcast that was NOT made for kids is the player's facade - so the checks above are
    // not true of every replay, they are true of this one.
    const plain = await replayOf(plainFx);
    step(`...whereas the not-made-for-kids match's replay is the click-to-play facade with its thumbnail (got ${plain.status})`,
      plain.status === 200 && plain.replay.includes('data-testid="replay-facade"') && plain.replay.includes("ytimg.com") && !plain.replay.includes('data-testid="replay-linkout"'));
  });

  console.log(`youtube connect smoke: ${probes} probes, ${checks} checks`);
  check(`youtube connect smoke: all ${EXPECTED_PROBES} probes ran (ran ${probes})`, probes === EXPECTED_PROBES);
  check(`youtube connect smoke: each probe ran once, by name (${ran.size} distinct)`, ran.size === EXPECTED_PROBES && PROBES.every((p) => ran.has(p)));
}
