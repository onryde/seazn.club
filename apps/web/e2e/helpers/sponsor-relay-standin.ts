// R4 sponsors on stream — the COMPOSITOR STAND-IN the sponsor e2e specs share (`walkthrough/sponsors-journey.spec.ts`,
// `sponsors-edge-cases.spec.ts`). The compositor is a separate program (onryde/seazn.club.compositor); in e2e it is
// stood in for at its HTTP boundary ONLY, exactly as it talks to web (spec 2026-10-27 §3.6, docs/contracts/relay-job.v1.json):
//
//   * its job token: HS256 over AUTH_SECRET, audience `seazn-relay`, `{ sid, scope: "relay-job" }` — the claim set
//     `mintRelayToken` writes (server/relay/tokens.ts, server-only so not importable here), the recipe
//     overlay-compositor.spec.ts `jobTokenFor` uses. CI sets AUTH_SECRET at job level for the server and this process alike.
//   * its overlay page: the session facts' `overlayUrl` loaded in an anonymous 1920×1080 browser, with the phase loopback
//     (`http://127.0.0.1:7419/phase`, the contract's `phaseEndpoint`) answered here, and the page's console read for the
//     `seazn:sponsor:start|end` lines (`SIGNAL_SPONSOR_*`) — what CEF hands the real compositor.
//   * its heartbeat: every body is VALIDATED against the vendored contract (`$defs/heartbeat`) BEFORE it is sent, and every
//     2xx reply against `$defs/heartbeatReply`, so a stand-in body the real compositor could not send fails here, not on
//     the server. Airings ride the heartbeat (`airings`), never a POST of their own. That holds for EVERY beat: the
//     test's own, the keep-alive's and the final `stopped` one.
//   * its keep-alive: once it has read its session, a beat every `heartbeatIntervalMs` the facts serve, for the session's
//     whole life, as the real compositor beats (compositor spec §5.3). A composed runner that has played is `lost` after
//     three missed beats (`STALE_HEARTBEAT_SECONDS_COMPOSED`), so a stand-in that only beat when a test had airings to
//     send would race the server's stale rule. A background beat cannot fail the test where it runs: each problem is
//     recorded, and `endStandInSessions` throws them once the sessions are ended.
//   * the sponsor plan: read from `GET /api/v1/public/fixtures/{id}/overlay?sid&st`, the relay door the page itself polls
//     (`overlayPollPath`, components/public-site/live-score-data.ts:152 — built by hand here, because that module's graph
//     reaches `@/lib/client` and an e2e import of it risks a collection failure: hub-knockout.spec.ts:120). The relay door
//     answers `private, no-store`; a refused sid/st silently falls through to the PUBLIC answer (overlay/route.ts), so
//     `relayPlan` asserts the header — a plan read off the wrong door would otherwise pass.
//
// This file takes NO stream-slot pool key and names no PoolHolder: each spec takes its own (`reserve` below), so the pool's
// member scan (e2e-ci-wiring.test.ts) reads one declaration per taker, under the taker's own name.
import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { TAG, apiJson, mintLoginPathBySql, seedRosteredFixture, withDb } from "../helpers";
import { grantRigPackCredits, sendEvent } from "../overlay-kit";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { disposeFakePhones, pairPhoneOnFixture } from "./fake-capture-phone";
import { FAKE_CONNECT_MS, POLL_WAIT_MS, cycleMs } from "./stream-slot-pool";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START } from "../../src/lib/overlay-compositor";
import type { SponsorPlan } from "../../src/lib/sponsor-plan";

export const EMPTY_JAR = { cookies: [], origins: [] };

/** The vendored contract: the cross-repo authority the compositor vendors byte for byte (relay-contract.test.ts pins it). */
const CONTRACT_PATH = fileURLToPath(new URL("../../../../docs/contracts/relay-job.v1.json", import.meta.url));
const CONTRACT_ID = "https://seazn.club/contracts/relay-job.v1.json";
let ajv: Ajv2020 | null = null;

/** The contract's own validator for one `$defs` shape — strict, as relay-contract.test.ts compiles it. */
export function contractValidator(def: "heartbeat" | "heartbeatReply") {
  if (ajv === null) {
    ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as object);
  }
  const validate = ajv.getSchema(`${CONTRACT_ID}#/$defs/${def}`);
  if (!validate) throw new Error(`the vendored relay-job.v1 contract has no $defs/${def}`);
  return validate;
}

/** Why `body` breaks the contract's `$defs/<def>`, or null when it keeps it. */
function contractProblem(def: "heartbeat" | "heartbeatReply", body: unknown): string | null {
  const validate = contractValidator(def);
  return validate(body) ? null : `against relay-job.v1 $defs/${def}: ${JSON.stringify(validate.errors)}`;
}

export function expectContract(def: "heartbeat" | "heartbeatReply", body: unknown, what: string): void {
  const problem = contractProblem(def, body);
  expect(problem, `${what} ${problem ?? ""}`).toBeNull();
}

/** The compositor's job token (see the header). `secret` defaults to the server's own; a test passes another to forge one. */
export async function jobTokenFor(sid: string, secret: string | undefined = process.env.AUTH_SECRET): Promise<string> {
  if (!secret) throw new Error("AUTH_SECRET must be set for the compositor stand-in to mint its job token");
  return new SignJWT({ sid, scope: "relay-job" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .setAudience("seazn-relay")
    .sign(new TextEncoder().encode(secret));
}

// ---------------------------------------------------------------------------------------------------------------------
// An organiser of their own: a fresh owner, org and Pro subscription written the way overlay-kit.ts seeds one, signed in
// in a context of its own. Never the shared Pro user: its org-creation slot is shared by every parallel worker.
// ---------------------------------------------------------------------------------------------------------------------
export interface StandInOrg {
  ctx: BrowserContext;
  page: Page;
  orgId: string;
  orgSlug: string;
  orgName: string;
  userId: string;
  email: string;
}

export async function seedStandInOrg(browser: Browser, prefix: string, opts: { orgName?: string; logoUrl?: string } = {}): Promise<StandInOrg> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+${prefix}-${tag}@resend.dev`;
  const orgSlug = `${prefix}-${tag}`;
  const orgName = opts.orgName ?? `Sponsors ${prefix} ${tag}`;
  const { orgId, userId } = await withDb(async (sql) => {
    const [{ id: uid }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${`Sponsor Owner ${tag}`}, true) returning id`;
    const [{ id: oid }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by, logo_url)
      values (${orgName}, ${orgSlug}, 'active', ${uid}, ${opts.logoUrl ?? null}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${oid}, ${uid}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${uid}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${oid}`;
    return { orgId: oid, userId: uid };
  });
  const ctx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(await mintLoginPathBySql(email));
  await page.waitForURL((u) => !u.pathname.startsWith("/magic-link") && !u.pathname.startsWith("/login"), { timeout: 30_000 });
  // An empty jar owes the cookie prompt; answered once in this origin's storage, it never covers a control this owner taps.
  await dismissCookieBanner(page);
  return { ctx, page, orgId, orgSlug, orgName, userId, email };
}

/** The sponsor rows this org wrote, then the org itself (soft-deleted, as releaseSeededOrgSql does). Safe to call twice. */
export async function releaseStandInOrg(org: StandInOrg | undefined): Promise<void> {
  if (!org) return;
  await org.ctx.close().catch(() => {});
  await withDb(async (sql) => {
    for (const table of [
      "sponsor_airing_frames",
      "sponsor_airings",
      "sponsor_clicks",
      "sponsor_short_codes",
      "sponsor_assignments",
      "sponsor_report_links",
      "sponsor_stream_settings",
      "sponsors",
    ]) {
      await sql`delete from ${sql(table)} where org_id = ${org.orgId}`;
    }
    await sql`delete from org_members where org_id = ${org.orgId} and user_id = ${org.userId}`;
    await sql`update organizations set deleted_at = now() where id = ${org.orgId} and deleted_at is null`;
  });
}

/** A fixture of its own competition, STARTED (core.start, as overlay-kit's rigs): a started fixture's slate is `live`, so
 *  the Starting soon scene carries no upcoming card beside the carousel (compositor spec §4.2, overlay-compositor.spec A1). */
export interface StandInFixture {
  competitionId: string;
  compSlug: string;
  divisionId: string;
  divSlug: string;
  fixtureId: string;
  /** The organiser's fixture page, where the Stream control lives. */
  fixturePath: string;
}

export async function seedStandInFixture(
  org: StandInOrg,
  spec: { label: string; sportKey: string; variantKey: string; home: string; away: string },
): Promise<StandInFixture> {
  const request = org.page.request;
  const seeded = await seedRosteredFixture(request, {
    label: spec.label,
    sportKey: spec.sportKey,
    variantKey: spec.variantKey,
    home: [{ fullName: spec.home }],
    away: [{ fullName: spec.away }],
    entrantKind: "team",
    skipLineups: true,
  });
  await sendEvent(request, seeded.fixtureId, "core.start", {});
  const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${seeded.competitionId}`);
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) throw new Error(`${spec.label}: slugs missing (comp ${comp.status}, div ${div.status})`);
  const [{ no }] = await withDb((sql) => sql<{ no: number }[]>`select fixture_no as no from fixtures where id = ${seeded.fixtureId}`);
  return {
    competitionId: seeded.competitionId,
    compSlug: comp.data.slug,
    divisionId: seeded.divisionId,
    divSlug: div.data.slug,
    fixtureId: seeded.fixtureId,
    fixturePath: `/o/${org.orgSlug}/c/${comp.data.slug}/d/${div.data.slug}/f/${no}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The composed session — through the organiser's real API — and the compositor's own reads and writes on it.
// ---------------------------------------------------------------------------------------------------------------------
/** What a test's cleanup needs of a session: all of it known the moment the create answers. */
export interface StandInSessionRef {
  fixtureId: string;
  sid: string;
  /** The organiser's request context (its stop) — and the compositor's (no cookie is read on the relay routes). */
  request: APIRequestContext;
}

export interface StandInSession extends StandInSessionRef {
  jobToken: string;
  /** The URL the session's facts carry, exactly as served. */
  overlayUrl: URL;
  /** The programme phase the keep-alive reports: `waiting` until a compositor page serves another (`serve`). */
  programmePhase: ProgrammePhase;
}

/**
 * A composed session on the fixture, as overlay-compositor.spec.ts `composedSession` makes one: rig credits, a YouTube
 * target, a paired phone (W5), the create, then the facts read with the job token until they carry `overlayUrl`.
 * `reserve` takes the CALLER's stream-slot pool key (a composed session reserves two matches of recording, R2004, so the
 * callers take the whole pool) — before the phone pairs and the session starts.
 *
 * `cleanup` is the caller's list for `endStandInSessions`: the session is pushed onto it the moment the create answers,
 * before any read or assert below can throw (overlay-compositor.spec.ts registers its sid at the same point). A red facts
 * poll would otherwise leak a live composed session, whose two matches of reservation refuse the next composed start
 * anywhere on the server, so the red would land on a sibling spec.
 *
 * Once the facts are read, the compositor's first beat is sent and awaited (a refused beat fails HERE, in the test), then
 * the keep-alive beats every `heartbeatIntervalMs` until `endStandInSession`.
 */
export async function composedSession(
  org: StandInOrg,
  fx: StandInFixture,
  reserve: () => Promise<void>,
  cleanup: StandInSessionRef[],
): Promise<StandInSession> {
  const request = org.page.request;
  await grantRigPackCredits(org.orgId, 5);
  const target = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/stream-targets`, "POST", {
    kind: "youtube",
    label: `Sponsors ${randomBytes(3).toString("hex")}`,
    streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (target.status >= 300 || !target.data) throw new Error(`stream target -> ${target.status} ${JSON.stringify(target.error)}`);
  await reserve();
  await pairPhoneOnFixture(org.page, fx.fixturePath);
  const made = await apiJson<{ sessionId: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", {
    mode: "composed",
    targetId: target.data.id,
  });
  if (made.status >= 300 || !made.data?.sessionId) throw new Error(`composed create -> ${made.status} ${JSON.stringify(made.error)}`);
  const ref: StandInSessionRef = { fixtureId: fx.fixtureId, sid: made.data.sessionId, request };
  cleanup.push(ref);
  const { sid } = ref;
  const jobToken = await jobTokenFor(sid);
  let facts: { overlayUrl?: string; heartbeatIntervalMs?: number } = {};
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/internal/relay/sessions/${sid}`, { headers: { Authorization: `Bearer ${jobToken}` } });
        if (res.status() !== 200) return `HTTP ${res.status()}`;
        facts = ((await res.json()) as { data: typeof facts }).data;
        return facts.overlayUrl ? "facts" : "facts without an overlayUrl";
      },
      { message: "the composed session's facts never carried an overlayUrl", timeout: cycleMs(FAKE_CONNECT_MS), intervals: [1_000] },
    )
    .toBe("facts");
  const url = new URL(facts.overlayUrl!);
  // The producer's own contract (R2004 decision 5), as overlay-compositor.spec.ts states it.
  expect(url.pathname, "the facts' overlay URL names the session's fixture").toBe(`/overlay/fixtures/${fx.fixtureId}`);
  expect(url.searchParams.get("sid")).toBe(sid);
  expect(url.searchParams.get("host"), "the page is told it runs in the compositor (spec §3.6.1: it logs airings only there)").toBe("compositor");
  expect(url.searchParams.get("st"), "a page token rides the URL").toBeTruthy();
  const intervalMs = facts.heartbeatIntervalMs;
  expect(Number.isInteger(intervalMs) && intervalMs! > 0, `the composed facts serve the beat cadence (heartbeatIntervalMs ${intervalMs})`).toBe(true);
  const s: StandInSession = { ...ref, jobToken, overlayUrl: url, programmePhase: "waiting" };
  await beatOk(s, { state: "playing", programmePhase: s.programmePhase }, "the compositor's first beat, once it has read its session");
  startKeepAlive(s, intervalMs!);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// The keep-alive (see the header). One per session, keyed by sid; `endStandInSession` silences it before the final beat.
// ---------------------------------------------------------------------------------------------------------------------
interface KeepAlive {
  timer: ReturnType<typeof setInterval>;
  wire: {
    /** The beat on the wire, if any: awaited before the final beat, so the final is the last one sent. */
    inFlight: Promise<void> | null;
    sent: number;
  };
}
const keepAlives = new Map<string, KeepAlive>();
/** Every background or final beat that broke the contract or was refused, for `endStandInSessions` to throw. */
const beatProblems: string[] = [];

/** The one harness artefact a background request may meet (overlay-compositor.spec.ts `disposePhones`): a keep-alive
 *  socket the server reaped (read ECONNRESET). Logged and tolerated; every other failure is a problem. */
function isReapedSocket(err: unknown): boolean {
  return /apiRequestContext\.post: read ECONNRESET/.test(err instanceof Error ? err.message : String(err));
}

/**
 * One beat sent where no test can see it fail: its body through the contract BEFORE it is sent, and the reply through it
 * after. `accept410` is the final beat's: the organiser's stop may already have ended the session, and the contract's
 * answer for that is 410 SESSION_ENDED. Never throws; a problem is recorded.
 */
async function backgroundBeat(s: StandInSessionRef, token: string, body: Record<string, unknown>, what: string, accept410 = false): Promise<void> {
  const tag = `session ${s.sid.slice(0, 8)}, ${what}`;
  const bodyProblem = contractProblem("heartbeat", body);
  if (bodyProblem !== null) {
    beatProblems.push(`${tag}: the body ${bodyProblem}`);
    return;
  }
  try {
    const res = await s.request.post(`/api/internal/relay/sessions/${s.sid}/heartbeat`, { headers: { Authorization: `Bearer ${token}` }, data: body });
    const text = await res.text();
    if (res.status() === 200) {
      const replyProblem = contractProblem("heartbeatReply", (JSON.parse(text) as { data?: unknown }).data);
      if (replyProblem !== null) beatProblems.push(`${tag}: the reply ${replyProblem}`);
      return;
    }
    if (accept410 && res.status() === 410 && text.includes("SESSION_ENDED")) return;
    beatProblems.push(`${tag}: HTTP ${res.status()} ${text}`);
  } catch (err) {
    if (isReapedSocket(err)) console.log(`${tag}: lost to a reaped keep-alive socket (read ECONNRESET), tolerated`);
    else beatProblems.push(`${tag}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startKeepAlive(s: StandInSession, intervalMs: number): void {
  const wire: KeepAlive["wire"] = { inFlight: null, sent: 0 };
  const timer = setInterval(() => {
    if (wire.inFlight !== null) return; // a slow reply: the next tick beats instead, never two on the wire at once
    wire.sent++;
    wire.inFlight = backgroundBeat(s, s.jobToken, { state: "playing", programmePhase: s.programmePhase }, `keep-alive beat ${wire.sent}`).finally(() => {
      wire.inFlight = null;
    });
  }, intervalMs);
  // A worker torn down mid-test (a timeout past its afterEach) is never kept alive by this timer.
  timer.unref();
  keepAlives.set(s.sid, { timer, wire });
}

/** One heartbeat, validated against the contract BEFORE it is sent. `token: null` sends no Authorization at all. */
export async function postBeat(s: StandInSession, body: Record<string, unknown>, opts: { token?: string | null } = {}): Promise<APIResponse> {
  expectContract("heartbeat", body, "the stand-in's heartbeat body");
  const token = opts.token === undefined ? s.jobToken : opts.token;
  return s.request.post(`/api/internal/relay/sessions/${s.sid}/heartbeat`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    data: body,
  });
}

/** A beat the server must take: 200, and a reply the contract admits. Returns the reply's `data`. */
export async function beatOk(s: StandInSession, body: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
  const res = await postBeat(s, body);
  const text = await res.text();
  expect(res.status(), `${what}: ${text}`).toBe(200);
  const reply = (JSON.parse(text) as { data: Record<string, unknown> }).data;
  expectContract("heartbeatReply", reply, `${what}: the reply`);
  return reply;
}

/** The plan the compositor's page reads: its poll path (`overlayPollPath(fixtureId, { sid, st })`) on the relay door. */
export async function relayPlan(s: StandInSession): Promise<SponsorPlan | null> {
  const q = new URLSearchParams({ sid: s.overlayUrl.searchParams.get("sid")!, st: s.overlayUrl.searchParams.get("st")! });
  const res = await s.request.get(`/api/v1/public/fixtures/${s.fixtureId}/overlay?${q.toString()}`);
  expect(res.status(), "the relay door answers").toBe(200);
  expect(res.headers()["cache-control"], "the RELAY door answered (a refused sid/st falls through to the public answer)").toBe("private, no-store");
  return ((await res.json()) as { data: { sponsorPlan: SponsorPlan | null } }).data.sponsorPlan;
}

/** The console preview's read-only door (`?preview=1`): the plan the fixture page's stream preview reads — it writes no
 *  assignment and mints no short code (overlay/route.ts, R4 S5 m6). */
export async function previewPlan(request: APIRequestContext, fixtureId: string): Promise<SponsorPlan | null> {
  const res = await apiJson<{ sponsorPlan: SponsorPlan | null }>(request, `/api/v1/public/fixtures/${fixtureId}/overlay?preview=1`);
  expect(res.status, "the overlay preview door answers").toBe(200);
  return res.data!.sponsorPlan;
}

/** The ticked cards' sponsor ids a plan names, sorted (null plan ⇒ none). */
export const planSponsorIds = (plan: SponsorPlan | null): string[] => (plan === null ? [] : plan.cards.map((c) => c.sponsorId).sort());

/**
 * Silence the session's keep-alive (and let a beat on the wire land), stop it as the organiser does, then the
 * compositor's own last beat (`stopped`, C06's `ended` exit) — through the contract like every other beat — then wait for
 * it to end. A session that will not end never keeps its reservation: it is forced terminal — and a forced `failed`
 * writes `end_reason = null` (V410's end_reason_state: a session with an end reason may only complete). Its camera's
 * recordings are then marked deleted, which is what frees the pool (overlay-compositor.spec.ts `endSession`).
 * A beat's problem is recorded, not thrown: `endStandInSessions` throws once every session is ended.
 */
export async function endStandInSession(s: StandInSessionRef): Promise<void> {
  const ka = keepAlives.get(s.sid);
  if (ka !== undefined) {
    clearInterval(ka.timer);
    keepAlives.delete(s.sid);
    await ka.wire.inFlight;
  }
  await s.request.post(`/api/v1/fixtures/${s.fixtureId}/stream-sessions/${s.sid}/stop`).catch(() => null);
  try {
    await backgroundBeat(s, await jobTokenFor(s.sid), { state: "stopped", exitReason: "ended" }, "the final beat", true);
  } catch (err) {
    beatProblems.push(`session ${s.sid.slice(0, 8)}, the final beat: ${err instanceof Error ? err.message : String(err)}`);
  }
  await expect
    .poll(
      async () => {
        await s.request.get(`/api/v1/fixtures/${s.fixtureId}/stream-sessions/current`).catch(() => null);
        return (await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${s.sid}`))[0]?.state;
      },
      { timeout: POLL_WAIT_MS, intervals: [1_000] },
    )
    .toMatch(/^(completed|failed)$/)
    .catch(() =>
      withDb(async (sql) => {
        await sql`update fixture_stream_sessions set state = 'completed', ended_at = now()
                   where id = ${s.sid} and end_reason is not null and state not in ('completed', 'failed')`;
        await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'unknown', end_reason = null, ended_at = now()
                   where id = ${s.sid} and end_reason is null and state not in ('completed', 'failed')`;
      }),
    );
  await withDb((sql) => sql`update fixture_stream_inputs set recordings_deleted_at = now()
                             where session_id = ${s.sid} and role = 'camera' and recordings_deleted_at is null`);
}

/** Every session on the caller's list ended (the list emptied), THEN anything that went wrong thrown: an end that failed,
 *  and every beat problem the keep-alives and final beats recorded. One failure never leaves another session live. */
export async function endStandInSessions(list: StandInSessionRef[]): Promise<void> {
  const failures: string[] = [];
  for (const s of list.splice(0)) {
    try {
      await endStandInSession(s);
    } catch (err) {
      failures.push(`ending session ${s.sid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  failures.push(...beatProblems.splice(0));
  if (failures.length > 0) throw new Error(`the compositor stand-in:\n${failures.join("\n")}`);
}

/** `disposeFakePhones()`, tolerating the one harness artefact overlay-compositor.spec.ts `disposePhones` documents: a
 *  background beat lost to a reaped keep-alive socket (read ECONNRESET). Every other background error still throws. */
export async function disposeStandInPhones(): Promise<void> {
  try {
    await disposeFakePhones();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const entries = msg.split(/\n(?=phone [0-9a-f]{8}: )/).slice(1);
    const real = entries.filter((e) => !/: Error: apiRequestContext\.post: read ECONNRESET$/.test(e.split("\n")[0]!));
    if (entries.length === 0 || real.length > 0) throw err;
    console.log(`fake phone: ${entries.length} background beat(s) lost to a reaped keep-alive socket (read ECONNRESET), tolerated`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The compositor's browser: the overlay page at the facts' URL, its phase answered on the loopback, its console read.
// ---------------------------------------------------------------------------------------------------------------------
export type ProgrammePhase = "waiting" | "live" | "frozen" | "reconnecting" | "final";
/** One `seazn:sponsor:start|end` line, parsed: `airing` is the heartbeat item the real compositor builds from it (SC1). */
export interface SponsorLine {
  kind: "start" | "end";
  json: Record<string, unknown>;
  airing: Record<string, unknown>;
  /** Index in the page's console, so a caller can take only the lines after a mark. */
  at: number;
}

export interface CompositorPage {
  context: BrowserContext;
  page: Page;
  /** Serve `phase` from now on (a new seq: the page's held long poll answers it) — and the keep-alive reports it. */
  serve(phase: ProgrammePhase): void;
  /** How many console lines the page has printed so far (a mark for `sponsorLines(after)`). */
  mark(): number;
  sponsorLines(after?: number): SponsorLine[];
}

/** C12's long-poll hold, kept under the page's own abort (overlay-compositor.spec.ts HOLD_MS). */
export const LOOPBACK_HOLD_MS = 8_000;
const VIEWPORT = { width: 1920, height: 1080 };

export async function compositorPage(browser: Browser, s: StandInSession, first: ProgrammePhase): Promise<CompositorPage> {
  const context = await browser.newContext({ viewport: VIEWPORT, storageState: EMPTY_JAR });
  const state = { phase: first, seq: 1 };
  s.programmePhase = first;
  const origin = s.overlayUrl.origin;
  await context.route("http://127.0.0.1:7419/phase**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": origin };
    if (req.method() === "OPTIONS") {
      await route
        .fulfill({ status: 204, headers: { ...cors, "access-control-allow-private-network": "true", "access-control-allow-methods": "GET" } })
        .catch(() => {});
      return;
    }
    // C12: a reply must be NEWER than `after`; otherwise the request is held until the phase moves or the hold runs out.
    const after = Number(new URL(req.url()).searchParams.get("after"));
    const until = Date.now() + LOOPBACK_HOLD_MS;
    while (!(state.seq > after) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    await route
      .fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ phase: state.phase, seq: state.seq }) })
      .catch(() => {});
  });
  const page = await context.newPage();
  const lines: string[] = [];
  page.on("console", (m) => lines.push(m.text()));
  const res = await page.goto(s.overlayUrl.pathname + s.overlayUrl.search);
  expect(res?.status(), "the compositor's page loads through the relay door").toBe(200);
  return {
    context,
    page,
    serve(phase) {
      state.phase = phase;
      state.seq++;
      s.programmePhase = phase;
    },
    mark: () => lines.length,
    sponsorLines(after = 0) {
      return lines.flatMap((text, i) => {
        if (i < after) return [];
        for (const [signal, kind] of [[SIGNAL_SPONSOR_START, "start"], [SIGNAL_SPONSOR_END, "end"]] as const) {
          if (text.startsWith(`${signal} `)) {
            const json = JSON.parse(text.slice(signal.length + 1)) as Record<string, unknown>;
            return [{ kind, json, airing: { kind, ...json }, at: i }];
          }
        }
        return [];
      });
    },
  };
}

/** The scene starts among `lines`, by card (sponsor) id. */
export function startsByCard(lines: readonly SponsorLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) if (l.kind === "start") out.set(String(l.json.cardId), (out.get(String(l.json.cardId)) ?? 0) + 1);
  return out;
}

/** The smallest JPEG the frame route admits: the SOI marker (`ff d8 ff`, airings.ts JPEG_SOI) and an APP0 start. */
export function jpegOf(size: number): Buffer {
  const body = Buffer.alloc(size, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(body, 0);
  return body;
}
