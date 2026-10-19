// R2005 — the overlay page in COMPOSITOR-HOST mode, driven through its REAL producer and consumer.
//
// The producer is the composed session's `overlayUrl` (`sessionFactsForJob`, R2004 decision 5): every case here creates
// a REAL composed session through the organiser's API (a paired phone, credits, a destination — the product's own
// preconditions), then plays the compositor's part by hand — it mints a `relay-job` token with jose (HS256, audience
// `seazn-relay`, the shape `server/relay/tokens.ts` signs), GETs the session's facts with it, and opens the URL those
// facts carry, exactly as cefsrc does. Nothing here builds an overlay URL of its own. The consumer is a real browser on
// a local production build, `RELAY_DRIVERS=fake`.
//
// The phase LOOPBACK (C12, `http://127.0.0.1:7419/phase`) is played by `page.route` from a scripted state: a long poll
// that answers at once when the script's seq has moved past `after`, and otherwise holds and answers the same seq (C12's
// own stale reply). The page at `localhost:<port>` calling `127.0.0.1:7419` is cross-origin, so every fulfilled answer
// carries `Access-Control-Allow-Origin: <the page's origin>`, and an OPTIONS is answered 204 with that header plus
// `Access-Control-Allow-Private-Network: true` (review m13). These tests cannot witness Private Network Access; only
// compositor C11 Step 0 and C17 can.
//
// Every scene step asserts the score bug is VISIBLE AND ON TOP: `document.elementFromPoint` at the template's centre is
// a node inside the template (AGENTS.md class 2 — a box is paint, a hit-test is what is on top), and the scene card's
// box does not intersect the template's.
//
// The expected scene and card per (phase, slate) are the brief's A1 table, typed below from the brief (spec §4.2) —
// never imported from `overlay-scene.tsx`, the code under test.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate } from "./helpers";
import {
  grantRigPackCredits,
  seedCricketOverlayFixture,
  seedOverlayFixture,
  sendEvent,
  signInAs,
  type OverlayRig,
} from "./overlay-kit";
import { disposeFakePhones, pairPhoneOnFixture } from "./helpers/fake-capture-phone";
import { FAKE_CONNECT_MS, POLL_WAIT_MS, cycleMs, holdsStreamSlot, releaseStreamSlot, takeWholePool } from "./helpers/stream-slot-pool";
import { STREAM_POLL_MS } from "../src/lib/stream-session-view";
import {
  OVERLAY_ALIVE_EVERY_MS,
  PHASE_LOOPBACK_FAILURES_TO_FALLBACK,
  SCORE_STALE_AFTER_MS,
  SIGNAL_ALIVE,
  SIGNAL_READY,
} from "../src/lib/overlay-compositor";

/** Compositor spec 2026-10-15 §4.2: Final holds the programme `FINAL_HOLD_MS` = 10 000 ms before EOS. */
const FINAL_HOLD_MS = 10_000;
/** The phase a script serves, typed from compositor spec §4.3 (C08's `ProgrammePhase`). */
type Phase = "waiting" | "live" | "frozen" | "reconnecting" | "final";
type Card = "upcoming" | "result" | "reconnecting" | "ended" | null;
type Slate = "warming" | "live" | "ended";
/** The brief's A1 table (spec §4.2), per phase and slate: the scene on screen and the card on it. */
const A1: Record<Phase, Record<Slate, { scene: string | null; card: Card }>> = {
  waiting: { warming: { scene: "starting", card: "upcoming" }, live: { scene: "starting", card: null }, ended: { scene: "starting", card: "result" } },
  live: { warming: { scene: null, card: "upcoming" }, live: { scene: null, card: null }, ended: { scene: null, card: "result" } },
  frozen: { warming: { scene: null, card: "upcoming" }, live: { scene: null, card: null }, ended: { scene: null, card: "result" } },
  reconnecting: {
    warming: { scene: "reconnecting", card: "reconnecting" },
    live: { scene: "reconnecting", card: "reconnecting" },
    ended: { scene: "reconnecting", card: "result" },
  },
  final: { warming: { scene: "final", card: "ended" }, live: { scene: "final", card: "ended" }, ended: { scene: "final", card: "result" } },
};

/** The longest any case here holds a stream slot: one session's create and facts (a cycle), then E6's sticky window,
 *  its beat-driven scenes and the hold (each a poll plus slack), plus E7's three legs. */
const POOL_HOLD = { file: "overlay-compositor.spec.ts", holdMs: 3 * cycleMs(FAKE_CONNECT_MS) } as const;
/** A case's whole budget: the seed and the session (SEED_MS), plus its streaming hold. */
const SEED_MS = 120_000;
test.setTimeout(SEED_MS + POOL_HOLD.holdMs);

const VIEWPORT = { width: 1920, height: 1080 };

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The composed session — through the organiser's real API — and the compositor's own reads of it.
// ---------------------------------------------------------------------------------------------------------------------
interface Composed {
  rig: OverlayRig;
  sid: string;
  jobToken: string;
  /** The URL the session's facts carry, exactly as served (absolute, on the request's own origin). */
  overlayUrl: URL;
}

const sessionsThisTest: { request: Page["request"]; fixtureId: string; sid: string }[] = [];

/** Stop a session as the organiser does, then send the compositor's own last beat (`stopped`, C06's `ended` exit): a
 *  composed session's `ending` is the RUNNER's (domain/session.ts), so without its Machine's final beat it holds. */
/** `disposeFakePhones()`, minus one harness artefact. The fake phone beats every POLL_STARTING_SECONDS (5 s) through
 *  Playwright's worker-global keep-alive pool, and the server reaps an idle socket at 6 s, so now and then a background
 *  beat lands on a reaped socket and reads `ECONNRESET` before the server sees it. A real phone drops a beat the same
 *  way and the next one covers it, and this file's subject is the overlay page, not the phone's contract — so a beat
 *  lost to a reset is counted and printed, and EVERY other background error (a refused beat, a contract break) still
 *  fails the test. */
async function disposePhones(): Promise<void> {
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

async function endSession(s: { request: Page["request"]; fixtureId: string; sid: string }): Promise<void> {
  await stopAndBeat(s);
  await expect
    .poll(
      async () => {
        // `current` is the organiser's read, and a read TICKS the session (its runner's exit lands on it).
        await s.request.get(`/api/v1/fixtures/${s.fixtureId}/stream-sessions/current`).catch(() => null);
        return (await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${s.sid}`))[0]?.state;
      },
      { timeout: POLL_WAIT_MS, intervals: [1_000] },
    )
    .toMatch(/^(completed|failed)$/)
    .catch(() =>
      // A session that will not end never keeps its reservation. V410's end_reason_state: a session with an end
      // reason (stopped → ending) may only complete; one without fails.
      withDb((sql) => sql`update fixture_stream_sessions
                             set state = case when end_reason is null then 'failed' else 'completed' end,
                                 fail_reason = case when end_reason is null then 'unknown' else fail_reason end,
                                 ended_at = now()
                           where id = ${s.sid} and state not in ('completed', 'failed')`),
    );
  // An ENDED composed session keeps the camera's match reserved until the daily sweep's camera pass deletes its
  // recordings (`storageReservations`, R2004). The fake ingest has nothing to delete, so this case writes what that
  // pass writes, for ITS OWN session only, before it gives its keys back — or the next composed start anywhere on the
  // server is refused `storage_exhausted` for a day.
  await withDb((sql) => sql`update fixture_stream_inputs set recordings_deleted_at = now()
                             where session_id = ${s.sid} and role = 'camera' and recordings_deleted_at is null`);
}

async function stopAndBeat(s: { request: Page["request"]; fixtureId: string; sid: string }): Promise<void> {
  await s.request.post(`/api/v1/fixtures/${s.fixtureId}/stream-sessions/${s.sid}/stop`).catch(() => null);
  await s.request
    .post(`/api/internal/relay/sessions/${s.sid}/heartbeat`, {
      headers: { Authorization: `Bearer ${await jobTokenFor(s.sid)}` },
      data: { state: "stopped", exitReason: "ended" },
    })
    .catch(() => null);
}

/** The compositor's job token: HS256 over AUTH_SECRET, audience `seazn-relay`, `{ sid, scope: "relay-job" }` — the
 *  claim set `mintRelayToken` writes (server/relay/tokens.ts). The server and this process share AUTH_SECRET (CI sets
 *  it at job level; locally it is exported from the same .env.local the server reads). */
async function jobTokenFor(sid: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set for the fake compositor to mint its job token");
  return new SignJWT({ sid, scope: "relay-job" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .setAudience("seazn-relay")
    .sign(new TextEncoder().encode(secret));
}

async function fixturePathOf(rig: OverlayRig): Promise<string> {
  const [{ no }] = await withDb((sql) => sql<{ no: number }[]>`select fixture_no as no from fixtures where id = ${rig.fixtureId}`);
  return `/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/f/${no}`;
}

/** A composed session on the rig's fixture, through the organiser's own API (W5: a paired phone first), and the facts
 *  the compositor reads with its job token. `delayMs` writes the session's stored overlay delay BEFORE the facts are
 *  read, so the URL that carries it is still the producer's. */
async function composedSession(page: Page, rig: OverlayRig, opts: { themeId?: string; delayMs?: number } = {}): Promise<Composed> {
  await grantRigPackCredits(rig.orgId, 5);
  const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
    kind: "youtube",
    label: `Compositor ${randomBytes(3).toString("hex")}`,
    streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (target.status >= 300 || !target.data) throw new Error(`stream target -> ${target.status} ${JSON.stringify(target.error)}`);
  // R2004 (owner ruling 2026-10-18, option (a)): a RUNNING composed session reserves TWO matches of recording — the
  // camera's and the programme's — where the pool's slot is sized for one (`STREAM_CAPACITY`, a passthrough's). So a
  // composed case takes the WHOLE pool (every pool key), which leaves the deployment's last slot to stream-credits.
  // The credits key is never asked for (this file never touches the credits tick).
  if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
  await pairPhoneOnFixture(page, await fixturePathOf(rig));
  const made = await apiJson<{ sessionId: string }>(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-sessions`, "POST", {
    mode: "composed",
    targetId: target.data.id,
    ...(opts.themeId ? { themeId: opts.themeId } : {}),
  });
  if (made.status >= 300 || !made.data?.sessionId) throw new Error(`composed create -> ${made.status} ${JSON.stringify(made.error)}`);
  const sid = made.data.sessionId;
  sessionsThisTest.push({ request: page.request, fixtureId: rig.fixtureId, sid });
  if (opts.delayMs !== undefined) {
    await withDb((sql) => sql`update fixture_stream_sessions set overlay_delay_ms = ${opts.delayMs!} where id = ${sid}`);
  }
  const jobToken = await jobTokenFor(sid);
  let overlayUrl: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/internal/relay/sessions/${sid}`, { headers: { Authorization: `Bearer ${jobToken}` } });
        if (res.status() !== 200) return `HTTP ${res.status()}`;
        overlayUrl = ((await res.json()) as { data: { overlayUrl?: string } }).data.overlayUrl;
        return overlayUrl ? "facts" : "facts without an overlayUrl";
      },
      { message: "the composed session's facts never carried an overlayUrl", timeout: cycleMs(FAKE_CONNECT_MS), intervals: [1_000] },
    )
    .toBe("facts");
  const url = new URL(overlayUrl!);
  // The producer's own contract (R2004 decision 5), stated where this file depends on it.
  expect(url.pathname, "the URL names the session's fixture").toBe(`/overlay/fixtures/${rig.fixtureId}`);
  expect(url.searchParams.get("sid")).toBe(sid);
  expect(url.searchParams.get("host")).toBe("compositor");
  expect(url.searchParams.get("st"), "a page token rides the URL").toBeTruthy();
  return { rig, sid, jobToken, overlayUrl: url };
}

/** A beat as the compositor sends it (C07's `heartbeat_wire`), through the internal route with the job token. */
async function beat(page: Page, c: Composed, programmePhase: Phase): Promise<void> {
  const res = await page.request.post(`/api/internal/relay/sessions/${c.sid}/heartbeat`, {
    headers: { Authorization: `Bearer ${c.jobToken}` },
    data: { state: "playing", programmePhase },
  });
  expect(res.status(), `heartbeat ${programmePhase}: ${await res.text()}`).toBe(200);
}

test.afterEach(async () => {
  try {
    await disposePhones();
  } finally {
    try {
      for (const s of sessionsThisTest.splice(0)) await endSession(s);
    } finally {
      await releaseStreamSlot();
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The loopback, scripted.
// ---------------------------------------------------------------------------------------------------------------------
interface PhaseScript {
  /** Serve `phase` from now on (a new seq; every held long poll answers at once). */
  serve(phase: Phase): void;
  /** `refuse`: every request is aborted (`connectionrefused`) — the channel's failure. */
  mode: "serve" | "refuse";
  /** GET requests the handler saw (OPTIONS excluded). */
  readonly calls: number;
}

/** C12's long-poll hold, kept under the page's own abort (RELAY_PHASE_LONG_POLL_MAX_MS + the grace). */
const HOLD_MS = 8_000;

async function scriptPhase(context: BrowserContext, origin: string, first: Phase = "live"): Promise<PhaseScript> {
  let phase: Phase = first;
  // C12's seq starts past 0: the page's first ask is `after=0` (its initial seq is −1), and a reply must be NEWER.
  let seq = 1;
  let calls = 0;
  const waiters = new Set<() => void>();
  const script: PhaseScript = {
    serve(next) {
      phase = next;
      seq++;
      for (const w of [...waiters]) w();
    },
    mode: "serve",
    get calls() {
      return calls;
    },
  };
  await context.route("http://127.0.0.1:7419/phase**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": origin };
    if (req.method() === "OPTIONS") {
      await route
        .fulfill({ status: 204, headers: { ...cors, "access-control-allow-private-network": "true", "access-control-allow-methods": "GET" } })
        .catch(() => {});
      return;
    }
    calls++;
    if (script.mode === "refuse") {
      await route.abort("connectionrefused").catch(() => {});
      return;
    }
    const after = Number(new URL(req.url()).searchParams.get("after"));
    if (!(seq > after)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, HOLD_MS);
        waiters.add(done);
      });
    }
    await route
      .fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ phase, seq }) })
      .catch(() => {});
  });
  return script;
}

// ---------------------------------------------------------------------------------------------------------------------
// The compositor's browser: an anonymous 1920×1080 context, its console lines timestamped.
// ---------------------------------------------------------------------------------------------------------------------
interface Cef {
  context: BrowserContext;
  page: Page;
  lines: { at: number; text: string }[];
  linesOf(text: string): { at: number; text: string }[];
  /** What the page showed AT the instant it logged ready (null before it has). */
  readyDom(): Promise<ReadyDom | null>;
}

interface ReadyDom {
  /** The stage still waiting out the URL's delay (`data-awaiting-delay="1"`): no snapshot drawn yet. */
  awaiting: boolean;
  /** The template's own drawn elements (the `display: contents` wrapper's children). */
  template: number;
}

async function cefBrowser(browser: Browser): Promise<Cef> {
  const context = await browser.newContext({ viewport: VIEWPORT, storageState: { cookies: [], origins: [] } });
  // Brief Step 7 mutant 3: "ready" is asserted AFTER the first snapshot's DOM is present, not merely once. The page's
  // own console.info is wrapped before any of its scripts run, and the DOM is read synchronously inside the call that
  // logs ready — the one instant the claim is about. A console listener in this process would read it later.
  await context.addInitScript(() => {
    const info = console.info.bind(console);
    console.info = (...args: unknown[]) => {
      if (args[0] === "seazn:ready") {
        const root = document.querySelector('[data-testid="ovl-root"]');
        const tpl = document.querySelector('[data-testid="ovl-template"]');
        (window as unknown as { __seaznReadyDom?: unknown }).__seaznReadyDom = {
          awaiting: root?.getAttribute("data-awaiting-delay") === "1",
          template: tpl ? tpl.children.length : 0,
        };
      }
      info(...args);
    };
  });
  const page = await context.newPage();
  const lines: Cef["lines"] = [];
  page.on("console", (m) => lines.push({ at: Date.now(), text: m.text() }));
  return {
    context,
    page,
    lines,
    linesOf: (text) => lines.filter((l) => l.text === text),
    readyDom: () => page.evaluate(() => ((window as unknown as { __seaznReadyDom?: ReadyDom }).__seaznReadyDom ?? null) as ReadyDom | null),
  };
}

const pathOf = (u: URL) => `${u.pathname}${u.search}`;
const withoutHost = (u: URL) => {
  const v = new URL(u);
  v.searchParams.delete("host");
  return v;
};

// ---------------------------------------------------------------------------------------------------------------------
// What is on screen.
// ---------------------------------------------------------------------------------------------------------------------
function cardLocator(page: Page, card: Exclude<Card, null>) {
  if (card === "reconnecting" || card === "ended") return page.locator(`[data-testid="ovl-slate"][data-card="${card}"]`);
  // The card layer's own two cards carry no `data-card`: `data-slate-state` names them (warming = upcoming).
  const state = card === "upcoming" ? "warming" : "ended";
  return page.locator(`[data-testid="ovl-slate"][data-slate-state="${state}"]:not([data-card])`);
}

async function expectScene(page: Page, want: { scene: string | null; card: Card }, step: string): Promise<void> {
  // A delayed page draws no template until its seed matures (`awaitingDelay`): wait for the scorebug first.
  await expect(page.getByTestId("ovl-root"), `${step}: the stage is past its delay`).not.toHaveAttribute("data-awaiting-delay", "1", { timeout: 15_000 });
  const scene = page.getByTestId("ovl-scene");
  if (want.scene === null) await expect(scene, `${step}: no scene`).toHaveCount(0);
  else await expect(scene, `${step}: scene ${want.scene}`).toHaveAttribute("data-scene", want.scene);
  if (want.card === null) await expect(page.getByTestId("ovl-slate"), `${step}: no card`).toHaveCount(0);
  else {
    await expect(cardLocator(page, want.card), `${step}: the ${want.card} card`).toBeVisible();
    await expectCardFits(page, step);
  }
  await expectBugOnTop(page, step);
}

/** The card on screen fits its region by LAYOUT, never by clipping (`.ovl-slate-card` is `overflow: hidden`, max-height
 *  100%): it hides none of its content, and no line in it — the context pill, the headline, the status — is cut
 *  short vertically. A seed's long entrant names (E4's cricket teams are 38 characters) are what reach this: a
 *  three-line headline once squeezed the context pill to half its height. Every line read is counted. */
async function expectCardFits(page: Page, step: string): Promise<void> {
  const fit = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="ovl-slate-card"]');
    if (card === null) return { lines: 0, cut: ["no card element"] };
    const cut: string[] = [];
    if (card.scrollHeight > card.clientHeight + 1) cut.push(`the card hides ${card.scrollHeight - card.clientHeight}px of content`);
    // The card's KIND from its own attributes, never from the class under test: an "A vs B" card is the Upcoming one
    // (`data-slate-state="warming"`) or the Reconnecting scene card.
    const slate = card.closest('[data-testid="ovl-slate"]');
    const pairingCard = slate?.getAttribute("data-card") === "reconnecting" || (!slate?.hasAttribute("data-card") && slate?.getAttribute("data-slate-state") === "warming");
    let lines = 0;
    for (const el of card.querySelectorAll<HTMLElement>("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!own) continue;
      lines++;
      const cs = getComputedStyle(el);
      // Review round 1, item 2: ONE clamp is a fit — the headline of an "A vs B" card, the yield that card is built
      // around, with its own ellipsis. Any other clamped box is a cut, hiding text or not: a Result headline is the
      // outcome sentence and is never clamped, whatever class it carries.
      const clamp = (cs as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
      const clamped = clamp !== undefined && clamp !== "" && clamp !== "none";
      if (clamped && pairingCard && el.getAttribute("data-testid") === "ovl-slate-headline") continue;
      if (clamped) cut.push(`"${(el.textContent ?? "").slice(0, 32)}" is line-clamped (${clamp}), and only the pairing may be`);
      else if (el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== "visible") {
        cut.push(`"${(el.textContent ?? "").slice(0, 32)}" is cut to ${el.clientHeight}px of ${el.scrollHeight}px`);
      }
    }
    return { lines, cut };
  });
  expect(fit.lines, `${step}: anti-vacuity — the card's text lines read`).toBeGreaterThan(0);
  expect(fit.cut, `${step}: the card fits by layout, not by clipping`).toEqual([]);
}

/** The score bug is on top: a hit-test at the centre of the template's first element lands inside the template, and
 *  the scene card's box (when one is up) does not intersect the template's — the union of the `display: contents`
 *  wrapper's CHILDREN, the box `overlay-gallery.spec.ts` check 4 measures. */
async function expectBugOnTop(page: Page, step: string): Promise<void> {
  const r = await page.evaluate(() => {
    const tpl = document.querySelector('[data-testid="ovl-template"]');
    if (!tpl) return { error: "no template" };
    const boxes = [...tpl.children]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0);
    if (boxes.length === 0) return { error: "the template painted nothing" };
    const root = (tpl.firstElementChild as HTMLElement).getBoundingClientRect();
    const cx = root.left + root.width / 2;
    const cy = root.top + root.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const union = boxes.reduce(
      (u, b) => ({ l: Math.min(u.l, b.left), t: Math.min(u.t, b.top), r: Math.max(u.r, b.right), b: Math.max(u.b, b.bottom) }),
      { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity },
    );
    const card = document.querySelector('[data-testid="ovl-slate-card"]')?.getBoundingClientRect() ?? null;
    const overlap = card ? !(card.right <= union.l || card.left >= union.r || card.bottom <= union.t || card.top >= union.b) : false;
    return {
      inside: hit !== null && tpl.contains(hit),
      hit: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "nothing",
      overlap,
      union,
      card: card ? { l: card.left, t: card.top, r: card.right, b: card.bottom } : null,
    };
  });
  expect("error" in r ? r.error : null, `${step}: the template is there`).toBeNull();
  expect((r as { inside: boolean }).inside, `${step}: the score bug is on top (hit ${(r as { hit: string }).hit})`).toBe(true);
  expect((r as { overlap: boolean }).overlap, `${step}: the scene card clears the template (${JSON.stringify(r)})`).toBe(false);
}

/** A1's sequence for one slate, step by step: the script serves the phase, the screen shows the table's row. */
async function walk(page: Page, script: PhaseScript, slate: Slate, phases: Phase[], label: string): Promise<number> {
  let steps = 0;
  for (const phase of phases) {
    script.serve(phase);
    await expectScene(page, A1[phase][slate], `${label} ${phase}`);
    steps++;
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rigs.
// ---------------------------------------------------------------------------------------------------------------------
/** A LIVE badminton fixture in a public competition on pro (streaming.overlay), one rally in — the bug's sport. */
async function seedBadmintonOverlayFixture(page: Page): Promise<OverlayRig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ovlb-${tag}@resend.dev`;
  const orgSlug = `ovlb-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Badminton Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"Overlay Badminton " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  const request = page.request;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Badminton ${tag}`,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`badminton rig: competition -> ${comp.status}`);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "short",
    config: {},
  });
  if (div.status >= 300 || !div.data) throw new Error(`badminton rig: division -> ${div.status} ${JSON.stringify(div.error)}`);
  const ents = await addEntrantsViaApi(request, div.data.id, [`Kento ${tag}`, `Viktor ${tag}`]);
  if (ents.ids.length !== 2) throw new Error(`badminton rig: entrants -> ${ents.status}`);
  const { fixtureIds } = await createStageAndGenerate(request, div.data.id);
  await apiJson(request, `/api/v1/divisions/${div.data.id}/start`, "POST");
  const fixtureId = fixtureIds[0]!;
  const [fx] = await withDb((sql) => sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`);
  await sendEvent(request, fixtureId, "core.start", {});
  await sendEvent(request, fixtureId, "badminton.rally", { wonBy: fx!.home });
  return {
    orgId,
    orgSlug,
    ownerEmail,
    competitionId: comp.data.id,
    compSlug: comp.data.slug,
    divisionId: div.data.id,
    divSlug: div.data.slug,
    fixtureId,
    homeEntrantId: fx!.home,
    awayEntrantId: fx!.away,
    offenderIds: [],
  };
}

/** Full time on the seeded hockey fixture, through the real reducer — `stream-overlay.spec.ts`'s own ladder walk: the
 *  phase ladder is READ OFF THE ENGINE (`summary.detail.nextAdvance`), one goal first so a level score cannot send it
 *  to a shoot-out. */
async function decideHockey(page: Page, rig: OverlayRig): Promise<void> {
  await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
  for (let guard = 0; guard < 10; guard++) {
    const state = await apiJson<{ status: string; summary: { detail?: { nextAdvance?: string | null } } | null }>(
      page.request,
      `/api/v1/fixtures/${rig.fixtureId}/state`,
    );
    if (state.data?.status === "decided" || state.data?.status === "finalized") return;
    const next = state.data?.summary?.detail?.nextAdvance;
    if (!next) throw new Error(`decideHockey: status ${state.data?.status} and no nextAdvance`);
    await sendEvent(page.request, rig.fixtureId, "hockey.period.advance", { to: next });
  }
  throw new Error("decideHockey: ten advances and the fixture is still not decided");
}

// ---------------------------------------------------------------------------------------------------------------------
// E1 / E2 — the sequence, on the hockey rig (a live, scored fixture: slate `live`).
// ---------------------------------------------------------------------------------------------------------------------
test("E1 sequence: live → frozen → reconnecting → live → final, each step the A1 row, the bug on top", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    const res = await cef.page.goto(pathOf(c.overlayUrl));
    expect(res?.status(), "the compositor's page loads through the relay door").toBe(200);
    await expect(cef.page.getByTestId("ovl-root")).toBeAttached();
    await expect.poll(() => cef.linesOf(SIGNAL_READY).length, { message: "the page signals ready" }).toBe(1);
    const atReady = await cef.readyDom();
    expect(atReady, "ready was logged with the first snapshot drawn: not awaiting, the template on the page").toEqual({
      awaiting: false,
      template: expect.any(Number),
    });
    expect(atReady!.template, "the template had drawn elements when ready was logged").toBeGreaterThan(0);
    const steps = await walk(cef.page, script, "live", ["live", "frozen", "reconnecting", "live", "final"], "E1");
    console.log(`E1 steps checked: ${steps}`);
    expect(steps).toBe(5);
    expect(cef.linesOf("seazn:phase-channel=loopback"), "a run where the loopback answers logs its channel once").toHaveLength(1);
    expect(cef.linesOf("seazn:phase-channel=web"), "and never falls back").toHaveLength(0);
  } finally {
    await cef.context.close();
  }
});

test("E0 score stale: the feed cut off reads stale within the rule plus one poll, and fresh again once it returns", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  // The compositor spec §6 line, typed here (C11's `ScoreStale(bool)`), never imported from the code under test.
  const STALE = "seazn:score-stale=true";
  const FRESH = "seazn:score-stale=false";
  try {
    await scriptPhase(cef.context, c.overlayUrl.origin);
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    await expect.poll(() => cef.linesOf(SIGNAL_READY).length, { message: "ready" }).toBe(1);
    // The first value is the change from "unknown": a fresh feed at ready.
    await expect.poll(() => cef.linesOf(FRESH).length, { message: "the first stale value, at ready, is false" }).toBe(1);
    expect(cef.linesOf(STALE), "nothing stale while the feed answers").toHaveLength(0);

    // Cut the live-data feed: every overlay poll (the page's own route, with its relay access) now fails.
    let blocked = 0;
    await cef.context.route("**/api/v1/public/fixtures/*/overlay**", async (route) => {
      blocked++;
      await route.abort("connectionrefused").catch(() => {});
    });
    const cutAt = Date.now();
    await expect
      .poll(() => cef.linesOf(STALE).length, { message: "stale within the rule plus one poll", timeout: SCORE_STALE_AFTER_MS + STREAM_POLL_MS + 3_000, intervals: [250] })
      .toBe(1);
    const staleAt = cef.linesOf(STALE)[0]!.at;
    console.log(`E0 stale after ${staleAt - cutAt} ms of a cut feed (${blocked} poll(s) refused)`);
    expect(blocked, "the cut reached the page's polls").toBeGreaterThan(0);
    // Never sooner than the rule allows: the last success was at or before the cut.
    expect(staleAt - cutAt, "not before the rule").toBeGreaterThanOrEqual(SCORE_STALE_AFTER_MS - STREAM_POLL_MS - 1_000);

    // Restore it: the next successful poll flips it back, once.
    await cef.context.unroute("**/api/v1/public/fixtures/*/overlay**");
    await expect
      .poll(() => cef.linesOf(FRESH).length, { message: "fresh again on the next success", timeout: STREAM_POLL_MS + 3_000, intervals: [250] })
      .toBe(2);
    expect(cef.linesOf(STALE), "one stale edge, logged once").toHaveLength(1);
  } finally {
    await cef.context.close();
  }
});

test("E2 second camera loss: live → reconnecting → live → reconnecting → live — the card appears and clears twice", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    let appeared = 0;
    let cleared = 0;
    for (const phase of ["live", "reconnecting", "live", "reconnecting", "live"] as const) {
      script.serve(phase);
      await expectScene(cef.page, A1[phase].live, `E2 ${phase}`);
      if (phase === "reconnecting") appeared++;
      else if (appeared > cleared) cleared++;
    }
    console.log(`E2 card appeared ${appeared}, cleared ${cleared}`);
    expect([appeared, cleared]).toEqual([2, 2]);
  } finally {
    await cef.context.close();
  }
});

test("E4 another sport — cricket (template=bar) and badminton (template=bug): E1's sequence, each row, the bug on top", async ({ page, browser }) => {
  test.setTimeout(2 * (SEED_MS + POOL_HOLD.holdMs));
  let sports = 0;
  for (const [sport, seed, template] of [
    ["cricket", seedCricketOverlayFixture, "bar"],
    ["badminton", seedBadmintonOverlayFixture, "bug"],
  ] as const) {
    const rig = await seed(page);
    const c = await composedSession(page, rig, { themeId: template });
    expect(c.overlayUrl.searchParams.get("template"), `${sport}: the producer resolved the session's template`).toBe(template);
    const cef = await cefBrowser(browser);
    try {
      const script = await scriptPhase(cef.context, c.overlayUrl.origin);
      expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status(), sport).toBe(200);
      await expect(cef.page.getByTestId("ovl-template"), sport).toHaveAttribute("data-template", template);
      const steps = await walk(cef.page, script, "live", ["live", "frozen", "reconnecting", "live", "final"], `E4 ${sport}`);
      expect(steps, sport).toBe(5);
      sports++;
    } finally {
      await cef.context.close();
    }
    // One session at a time on the pool: end this sport's before the next one's, and give the pool back between them
    // so no hold here outlasts POOL_HOLD (the next sport's `composedSession` takes it again).
    for (const s of sessionsThisTest.splice(0)) await endSession(s);
    await disposePhones();
    await releaseStreamSlot();
  }
  console.log(`E4 sports checked: ${sports}`);
  expect(sports).toBe(2);
});

test("E5 OBS: the same URL without host=compositor — no scene ever, and the loopback is never called", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin, "reconnecting");
    expect((await cef.page.goto(pathOf(withoutHost(c.overlayUrl))))?.status(), "the relay door still opens it").toBe(200);
    await expect(cef.page.getByTestId("ovl-root")).toBeAttached();
    // Watch for longer than one steady poll and one loopback hold: a scene would have come by now.
    let samples = 0;
    const until = Date.now() + STREAM_POLL_MS + 3_000;
    while (Date.now() < until) {
      expect(await cef.page.getByTestId("ovl-scene").count(), "no scene on an OBS page").toBe(0);
      samples++;
      await cef.page.waitForTimeout(250);
    }
    console.log(`E5 samples checked: ${samples}`);
    expect(samples).toBeGreaterThan(0);
    expect(script.calls, "the loopback handler is never called").toBe(0);
    expect(cef.lines.filter((l) => l.text.startsWith("seazn:")), "and nothing is signalled").toEqual([]);
  } finally {
    await cef.context.close();
  }
});

test("E6 fallback B: 3 refusals switch to web for good; the beat's phase arrives by the poll; the hold survives a reload", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    script.mode = "refuse";
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    await expect.poll(() => cef.linesOf("seazn:phase-channel=web").length, { message: "the channel falls back to web" }).toBe(1);
    expect(script.calls, `exactly ${PHASE_LOOPBACK_FAILURES_TO_FALLBACK} refusals before the fallback`).toBe(PHASE_LOOPBACK_FAILURES_TO_FALLBACK);
    // Sticky: the loopback starts answering, and the page never asks it again.
    script.mode = "serve";
    script.serve("final");
    await cef.page.waitForTimeout(15_000);
    expect(script.calls, "the handler count stays where the fallback left it").toBe(PHASE_LOOPBACK_FAILURES_TO_FALLBACK);
    await expectScene(cef.page, A1.live.live, "E6 before any beat: the web phase is absent, no scene");

    // The phase now comes from the compositor's beat, through the internal route and the overlay route's relay answer.
    await beat(page, c, "reconnecting");
    await expect(cef.page.getByTestId("ovl-scene"), "the Reconnecting scene arrives by the poll").toHaveAttribute("data-scene", "reconnecting", {
      timeout: STREAM_POLL_MS + 3_000,
    });
    await expectScene(cef.page, A1.reconnecting.live, "E6 reconnecting by the beat");

    // (I5) The hold under fallback B: the organiser stops, the session goes `ending`, the final beat says `final`.
    const stop = await page.request.post(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/${c.sid}/stop`);
    expect(stop.status(), await stop.text()).toBe(200);
    const [{ state }] = await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${c.sid}`);
    expect(state, "the stop leaves the composed session in its final hold").toBe("ending");
    await beat(page, c, "final");
    await expect(cef.page.getByTestId("ovl-scene"), "the Final scene arrives by the poll").toHaveAttribute("data-scene", "final", {
      timeout: STREAM_POLL_MS + 3_000,
    });
    await expectScene(cef.page, A1.final.live, "E6 final by the beat");
    const reload = await cef.page.reload();
    expect(reload?.status(), "a CEF reload during the hold loads").toBe(200);
    await expect(cef.page.getByTestId("ovl-scene"), "and shows the Final scene again").toHaveAttribute("data-scene", "final", {
      timeout: STREAM_POLL_MS + 3_000 + (PHASE_LOOPBACK_FAILURES_TO_FALLBACK + 1) * 2_000,
    });
  } finally {
    await cef.context.close();
  }
});

/** The moment slab's first visible instant, sampled every 100 ms, or null if it never shows inside `windowMs`. */
async function slabSeenAt(page: Page, windowMs: number): Promise<number | null> {
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    if (await page.getByTestId("overlay-moment").isVisible().catch(() => false)) return Date.now();
    await page.waitForTimeout(100);
  }
  return null;
}

test("E7 moments by scene: Reconnecting airs the slab after the delay, Starting soon airs it, Final drops it", async ({ page, browser }) => {
  const DELAY_MS = 3_000;
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig, { delayMs: DELAY_MS });
  expect(c.overlayUrl.searchParams.get("delay"), "the producer carries the session's delay").toBe(String(DELAY_MS));
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    await expect(cef.page.getByTestId("ovl-root")).not.toHaveAttribute("data-awaiting-delay", "1", { timeout: DELAY_MS + 5_000 });
    // The delayed page is where "ready on mount" and "ready after the first snapshot" differ: at mount it is awaiting.
    await expect.poll(() => cef.linesOf(SIGNAL_READY).length, { message: "the delayed page signals ready" }).toBe(1);
    const atReady = await cef.readyDom();
    expect(atReady?.awaiting, "ready waited out the URL's delay").toBe(false);
    expect(atReady?.template ?? 0, "and the template had drawn when it was logged").toBeGreaterThan(0);
    const latest = DELAY_MS + STREAM_POLL_MS + 2_000;

    // Leg 1 — Reconnecting.
    script.serve("reconnecting");
    await expectScene(cef.page, A1.reconnecting.live, "E7 reconnecting");
    const t0 = Date.now();
    await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
    const seen0 = await slabSeenAt(cef.page, latest + 1_000);
    expect(seen0, "the slab airs during Reconnecting").not.toBeNull();
    expect(seen0! - t0, "no sooner than the URL's delay").toBeGreaterThanOrEqual(DELAY_MS);
    expect(seen0! - t0, "and no later than the delay, one poll and slack").toBeLessThanOrEqual(latest);
    // Once fully out (its `hold` phase — mid-fold it is still sliding from under the scorebug), the slab is on top.
    await expect(cef.page.getByTestId("overlay-moment")).toHaveAttribute("data-phase", "hold");
    const onTop = await cef.page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="overlay-moment"]')!;
      const slot = document.querySelector<HTMLElement>('[data-testid="ovl-moment-slot"]')!;
      const slab = el.getBoundingClientRect();
      // The slot is `pointer-events: none` (it must never eat a click in a browser source), and a hit-test SKIPS such
      // a box — it would report whatever paints beneath. Made hit-testable for the one probe, then put back, so the
      // probe reads PAINT order, which is what "on top" means.
      const saved = [slot.style.pointerEvents, el.style.pointerEvents];
      slot.style.pointerEvents = "auto";
      el.style.pointerEvents = "auto";
      const hit = document.elementFromPoint(slab.left + slab.width / 2, slab.top + slab.height / 2);
      [slot.style.pointerEvents, el.style.pointerEvents] = saved as [string, string];
      const card = document.querySelector('[data-testid="ovl-slate-card"]')?.getBoundingClientRect() ?? null;
      return {
        on: hit !== null && el.contains(hit),
        hit: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "nothing",
        slab: { l: slab.left, t: slab.top, r: slab.right, b: slab.bottom },
        card: card ? { l: card.left, t: card.top, r: card.right, b: card.bottom } : null,
      };
    });
    expect(onTop.on, `the slab is on top of the scene: ${JSON.stringify(onTop)}`).toBe(true);
    await expect(cef.page.getByTestId("overlay-moment"), "the slab folds away").toHaveCount(0, { timeout: 30_000 });

    // Leg 2 — Starting soon, on a fixture already in play (D14: Starting soon shows the moment).
    script.serve("waiting");
    await expectScene(cef.page, A1.waiting.live, "E7 starting");
    const t1 = Date.now();
    await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.awayEntrantId });
    const seen1 = await slabSeenAt(cef.page, latest + 1_000);
    expect(seen1, "the slab airs over Starting soon").not.toBeNull();
    expect(seen1! - t1).toBeGreaterThanOrEqual(DELAY_MS);
    expect(seen1! - t1).toBeLessThanOrEqual(latest);
    await expect(cef.page.getByTestId("overlay-moment")).toHaveCount(0, { timeout: 30_000 });

    // Leg 3 — Final drops the moment: over the whole hold, nothing attaches.
    script.serve("final");
    await expectScene(cef.page, A1.final.live, "E7 final");
    await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
    let samples = 0;
    const until = Date.now() + FINAL_HOLD_MS;
    while (Date.now() < until) {
      expect(await cef.page.getByTestId("overlay-moment").count(), "Final drops the moment").toBe(0);
      samples++;
      await cef.page.waitForTimeout(250);
    }
    console.log(`E7 final-hold samples checked: ${samples}`);
    expect(samples).toBeGreaterThan(0);
  } finally {
    await cef.context.close();
  }
});

test("E3 reconnecting while decided: the Result card on the backdrop", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  await decideHockey(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    await expectScene(cef.page, A1.live.ended, "E3 decided, live phase: the Result card, no scene");
    script.serve("reconnecting");
    await expectScene(cef.page, A1.reconnecting.ended, "E3 decided, reconnecting");
    script.serve("final");
    await expectScene(cef.page, A1.final.ended, "E3 decided, final");
  } finally {
    await cef.context.close();
  }
});

test("E8 CSP enforce: E1's sequence on a server that ENFORCES its policy (the loopback is in connect-src)", async ({ page, browser }) => {
  const probe = await page.request.get("/overlay/fixtures/00000000-0000-4000-8000-000000000000");
  const enforced = probe.headers()["content-security-policy"];
  test.skip(!enforced, "this server reports its CSP only (CSP_MODE is not enforce) — E8 runs against a CSP_MODE=enforce build");
  expect(enforced, "the enforced policy names the loopback").toContain("http://127.0.0.1:7419");
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);
  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    const violations: string[] = [];
    cef.page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    const steps = await walk(cef.page, script, "live", ["live", "frozen", "reconnecting", "live", "final"], "E8");
    expect(steps).toBe(5);
    expect(script.calls, "the enforced policy let the loopback through").toBeGreaterThan(0);
    expect(violations, "no CSP violation").toEqual([]);
    expect(cef.linesOf("seazn:phase-channel=web"), "never fell back").toHaveLength(0);
  } finally {
    await cef.context.close();
  }
});

test("E9 the alive beat: ≥ 2 beats within 5 s of ready with host, 0 without; it never gaps past 2 beats across scene changes", async ({ page, browser }) => {
  const rig = await seedOverlayFixture(page);
  const c = await composedSession(page, rig);

  // Without host: nothing, in the same window.
  const obs = await cefBrowser(browser);
  try {
    await scriptPhase(obs.context, c.overlayUrl.origin);
    expect((await obs.page.goto(pathOf(withoutHost(c.overlayUrl))))?.status()).toBe(200);
    await expect(obs.page.getByTestId("ovl-root")).toBeAttached();
    await obs.page.waitForTimeout(5_000);
    expect(obs.linesOf(SIGNAL_ALIVE), "without host: no beat").toHaveLength(0);
    expect(obs.linesOf(SIGNAL_READY), "and no ready").toHaveLength(0);
  } finally {
    await obs.context.close();
  }

  const cef = await cefBrowser(browser);
  try {
    const script = await scriptPhase(cef.context, c.overlayUrl.origin);
    expect((await cef.page.goto(pathOf(c.overlayUrl)))?.status()).toBe(200);
    await expect.poll(() => cef.linesOf(SIGNAL_READY).length).toBe(1);
    const readyAt = cef.linesOf(SIGNAL_READY)[0]!.at;
    await cef.page.waitForTimeout(5_000);
    const early = cef.linesOf(SIGNAL_ALIVE).filter((l) => l.at >= readyAt && l.at <= readyAt + 5_000);
    expect(early.length, "≥ 2 beats within 5 s of ready").toBeGreaterThanOrEqual(2);
    expect(cef.linesOf(SIGNAL_ALIVE).filter((l) => l.at < readyAt), "no beat before ready").toHaveLength(0);

    // The beat survives a scene change: each scene held ≥ 6 s.
    const HOLD = 6_000;
    const perScene: Record<string, number> = {};
    for (const phase of ["live", "reconnecting", "final"] as const) {
      script.serve(phase);
      await expectScene(cef.page, A1[phase].live, `E9 ${phase}`);
      const from = Date.now();
      await cef.page.waitForTimeout(HOLD);
      perScene[phase] = cef.linesOf(SIGNAL_ALIVE).filter((l) => l.at >= from && l.at <= from + HOLD).length;
    }
    console.log(`E9 beats per scene: ${JSON.stringify(perScene)}`);
    for (const [scene, n] of Object.entries(perScene)) expect(n, `${scene}: at least one beat`).toBeGreaterThan(0);
    const beats = cef.linesOf(SIGNAL_ALIVE).map((l) => l.at);
    let gaps = 0;
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]! - beats[i - 1]!, `beat ${i}: the gap stays inside two beats`).toBeLessThanOrEqual(2 * OVERLAY_ALIVE_EVERY_MS);
      gaps++;
    }
    console.log(`E9 gaps checked: ${gaps}`);
    expect(gaps).toBeGreaterThan(3);
  } finally {
    await cef.context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// R2006 (owner ruling 2026-10-19, "Option C") — the organiser's panel on a deployment that CAN run the score (this leg
// sets RELAY_IMAGE). Driven through the real producer (the panel, a browser) and the real consumer (the composed
// session's facts, read with the compositor's own job token): what the panel shows is what streams. The phone's own
// start and the automatic start read the same stored mode server-side; their e2e is below.
// ---------------------------------------------------------------------------------------------------------------------
const EN = JSON.parse(readFileSync(join(import.meta.dirname, "../src/dictionaries/en/ui.json"), "utf8")) as Record<string, string>;
const en = (k: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((acc, [n, v]) => acc.replaceAll(`{${n}}`, String(v)), EN[k] ?? `MISSING:${k}`);
const SETTINGS_PUT = (fixtureId: string) => (r: import("@playwright/test").Response) =>
  r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/v1/fixtures/${fixtureId}/stream-settings`;

async function streamRig(page: Page): Promise<{ rig: OverlayRig; path: string; targetId: string }> {
  const rig = await seedOverlayFixture(page);
  await grantRigPackCredits(rig.orgId, 8);
  const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
    kind: "youtube",
    label: `Option C ${randomBytes(3).toString("hex")}`,
    streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (target.status >= 300 || !target.data) throw new Error(`stream target -> ${target.status} ${JSON.stringify(target.error)}`);
  // A composed session reserves two matches of recording (R2004): this file's cases take the whole pool.
  if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
  return { rig, path: await fixturePathOf(rig), targetId: target.data.id };
}

/** The fixture page's Stream panel on its Phone tab, Ready (a paired, present phone; a destination). */
async function openReady(page: Page, path: string): Promise<void> {
  await page.goto(path);
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control).toHaveCount(1, { timeout: 30_000 });
  await control.click();
  await expect(page.getByTestId("stream-tab-phone")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("stream-go-live"), "Ready: Go live is offered").toBeEnabled({ timeout: POLL_WAIT_MS });
}

const sessionModeOf = async (sid: string) =>
  (await withDb((sql) => sql<{ mode: string; start_cause: string; theme_id: string | null; overlay_delay_ms: number }[]>`
    select mode, start_cause, theme_id, overlay_delay_ms from fixture_stream_sessions where id = ${sid}`))[0];

test("R2006 Option C: the score by default; Camera only and back; a style and timing that persist; Go live streams exactly that; live, both read-only", async ({ page }) => {
  test.setTimeout(SEED_MS + POOL_HOLD.holdMs + 60_000);
  const { rig, path, targetId } = await streamRig(page);
  await pairPhoneOnFixture(page, path);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReady(page, path);

  // 1. The DEFAULT: nothing stored — the score card (style grid + Score timing) above ONE Go live that streams the score.
  const goLive = page.getByTestId("stream-go-live");
  await expect(page.getByTestId("stream-score")).toBeVisible();
  await expect(page.getByTestId("stream-score").getByTestId("stream-template-picker")).toBeVisible();
  await expect(page.getByTestId("stream-score").getByTestId("stream-timing")).toBeVisible();
  await expect(page.getByTestId("stream-score-unavailable"), "this deployment can run the score").toHaveCount(0);
  await expect(goLive).toHaveCount(1);
  await expect(goLive).toHaveAttribute("data-mode", "composed");
  const toggle = page.getByTestId("stream-mode-toggle");
  await expect(toggle).toHaveText(en("stream.mode.cameraOnly"));

  // 2. Camera only: saved, the camera card, Go live streams the camera — and it survives a reload.
  let put = page.waitForResponse(SETTINGS_PUT(rig.fixtureId));
  await toggle.click();
  expect((await put).request().postDataJSON()).toEqual({ streamMode: "passthrough" });
  await expect(page.getByTestId("stream-camera-only")).toBeVisible();
  await expect(page.getByTestId("stream-score")).toHaveCount(0);
  await expect(goLive).toHaveAttribute("data-mode", "passthrough");
  await expect(toggle).toHaveText(en("stream.mode.addScore"));
  await openReady(page, path);
  await expect(page.getByTestId("stream-camera-only"), "Camera only, after a reload").toBeVisible();
  await expect(goLive).toHaveAttribute("data-mode", "passthrough");

  // 3. Add the score back: saved; the score card again.
  put = page.waitForResponse(SETTINGS_PUT(rig.fixtureId));
  await toggle.click();
  expect((await put).request().postDataJSON()).toEqual({ streamMode: "composed" });
  await expect(page.getByTestId("stream-score")).toBeVisible();
  await expect(goLive).toHaveAttribute("data-mode", "composed");

  // 4. A style: the other option; and Score timing: set 2.5, Reset to the default, set 2.5 again.
  const picker = page.getByTestId("stream-score").getByTestId("stream-template-picker");
  const checked = picker.locator('[role="radio"][data-template][aria-checked="true"]');
  const ids = await picker.locator('[role="radio"][data-template]').evaluateAll((els) => els.map((el) => el.getAttribute("data-template")!));
  expect(ids.length).toBeGreaterThanOrEqual(2);
  const before = await checked.getAttribute("data-template");
  const other = ids.find((id) => id !== before)!;
  // The option's own label (the last line of its text: the thumbnail above it is the overlay's own text, aria-hidden).
  const otherLabel = (await picker.locator(`[role="radio"][data-template="${other}"] span.truncate`).innerText()).trim();
  expect(otherLabel.length, "the option names its template").toBeGreaterThan(0);
  put = page.waitForResponse(SETTINGS_PUT(rig.fixtureId));
  await picker.locator(`[role="radio"][data-template="${other}"]`).click();
  expect((await put).request().postDataJSON()).toEqual({ overlayTemplate: other });
  await expect(checked).toHaveAttribute("data-template", other);
  const timing = page.getByTestId("stream-timing");
  await timing.locator("summary").click();
  await expect(page.getByTestId("stream-timing-default"), "unset: the server's default").toBeVisible();
  const input = page.getByTestId("stream-timing-input");
  const setDelay = async (text: string, want: number | null) => {
    const p = page.waitForResponse(SETTINGS_PUT(rig.fixtureId));
    if (want === null) await page.getByTestId("stream-timing-reset").click();
    else {
      await input.fill(text);
      await input.press("Enter");
    }
    const r = await p;
    expect(r.status()).toBe(200);
    expect(r.request().postDataJSON()).toEqual({ overlayDelayMs: want });
  };
  await setDelay("2.5", 2500);
  await expect(page.getByTestId("stream-timing-value")).toHaveText(en("stream.timing.value", { seconds: "2.5" }));
  await expect(page.getByTestId("stream-timing-default")).toHaveCount(0);
  await setDelay("", null);
  await expect(page.getByTestId("stream-timing-default"), "Reset: the default again").toBeVisible();
  await expect(page.getByTestId("stream-timing-reset")).toBeDisabled();
  await setDelay("2.5", 2500);
  // Out of bounds: refused inline, nothing saved.
  let refusedPuts = 0;
  const countPut = (r: import("@playwright/test").Request) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname.endsWith("/stream-settings")) refusedPuts++;
  };
  page.on("request", countPut);
  await input.fill("31");
  await input.press("Enter");
  await expect(page.getByTestId("stream-timing-invalid")).toBeVisible();
  page.off("request", countPut);
  expect(refusedPuts, "31 s is refused before it is sent").toBe(0);
  // Both survive a reload.
  await openReady(page, path);
  await expect(page.getByTestId("stream-score").getByTestId("stream-template-picker").locator('[role="radio"][data-template][aria-checked="true"]')).toHaveAttribute("data-template", other);
  await expect(page.getByTestId("stream-timing-value")).toHaveText(en("stream.timing.value", { seconds: "2.5" }));

  // 5. Go live streams what the tab shows: the score, the picked style — and the Machine's facts carry style AND timing.
  const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/v1/fixtures/${rig.fixtureId}/stream-sessions`);
  const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/fixtures/${rig.fixtureId}/stream-sessions`);
  await page.getByTestId("stream-go-live").click();
  expect((await posted).postDataJSON()).toEqual({ mode: "composed", targetId, themeId: other });
  const createdRes = await created;
  const answer = (await createdRes.json()) as { data?: { sessionId?: string } };
  // Pushed BEFORE any assertion: a failed check must still end the session, or its reservation outlives the test.
  if (answer.data?.sessionId) sessionsThisTest.push({ request: page.request, fixtureId: rig.fixtureId, sid: answer.data.sessionId });
  expect(createdRes.status(), `Go live is accepted: ${JSON.stringify(answer)}`).toBeLessThan(300);
  const sid = answer.data!.sessionId!;
  expect(await sessionModeOf(sid)).toMatchObject({ mode: "composed", start_cause: "organiser", theme_id: other, overlay_delay_ms: 2500 });
  const jobToken = await jobTokenFor(sid);
  let overlayUrl: URL | null = null;
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/internal/relay/sessions/${sid}`, { headers: { Authorization: `Bearer ${jobToken}` } });
      const url = res.status() === 200 ? ((await res.json()) as { data: { overlayUrl?: string } }).data.overlayUrl : undefined;
      overlayUrl = url ? new URL(url) : null;
      return overlayUrl !== null;
    }, { message: "the composed session's facts never carried an overlayUrl", timeout: cycleMs(FAKE_CONNECT_MS), intervals: [1_000] })
    .toBe(true);
  expect(overlayUrl!.searchParams.get("template"), "the Machine renders the picked style").toBe(other);
  expect(overlayUrl!.searchParams.get("delay"), "…at the set timing").toBe("2500");

  // 6. Live: the Machine plays; the panel says delivery is not monitored, shows the session's OWN style and timing
  // read-only, and offers neither the editor nor the mode link. A settings change now never moves the running session.
  await expect
    .poll(async () => {
      await page.request.post(`/api/internal/relay/sessions/${sid}/heartbeat`, {
        headers: { Authorization: `Bearer ${jobToken}` },
        data: { state: "playing", programmePhase: "live" },
      });
      return (await apiJson<{ state: string } | null>(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`)).data?.state;
    }, { message: "the composed session never went live on the Machine's beat", timeout: cycleMs(FAKE_CONNECT_MS), intervals: [2_000] })
    .toBe("live");
  await expect(page.getByTestId("stream-live-unmonitored")).toHaveText(en("stream.live.deliveryUnmonitored", { platform: "YouTube" }), { timeout: POLL_WAIT_MS });
  await expect(page.getByTestId("stream-live-template")).toHaveText(otherLabel);
  await expect(page.getByTestId("stream-live-timing")).toHaveText(en("stream.timing.value", { seconds: "2.5" }));
  await expect(page.getByTestId("stream-live-timing-locked")).toHaveText(en("stream.timing.lockedLive"));
  await expect(page.getByTestId("stream-timing"), "no editable timing while live").toHaveCount(0);
  await expect(page.getByTestId("stream-mode-toggle"), "no mode link while live").toHaveCount(0);
  await expect(page.locator('[data-node="dest"] [data-tone]').first(), "the destination node is neutral for a score stream").toHaveAttribute("data-tone", "slate");
  await expect(page.locator('[data-node="dest"]')).toContainText(en("stream.chain.word.sending"));
  const moved = await apiJson(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-settings`, "PUT", { overlayDelayMs: 0 });
  expect(moved.status).toBe(200);
  await page.waitForTimeout(STREAM_POLL_MS + 1_000);
  await expect(page.getByTestId("stream-live-timing"), "a running session keeps its own timing").toHaveText(en("stream.timing.value", { seconds: "2.5" }));
  expect((await sessionModeOf(sid))!.overlay_delay_ms).toBe(2500);
});

/** End a session this test started and wait until it is terminal, so the next start on the fixture is not refused. */
async function endNow(page: Page, fixtureId: string, sid: string): Promise<void> {
  const i = sessionsThisTest.findIndex((x) => x.sid === sid);
  if (i >= 0) sessionsThisTest.splice(i, 1);
  await endSession({ request: page.request, fixtureId, sid });
}

const putSettings = async (page: Page, fixtureId: string, body: Record<string, unknown>) => {
  const res = await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/stream-settings`, "PUT", body);
  expect(res.status, `PUT stream-settings ${JSON.stringify(body)}: ${JSON.stringify(res.error)}`).toBe(200);
};

test("R2006: the phone operator's own start streams the stored mode — the score by default, the camera after Camera only, the score after Add the score back", async ({ page }) => {
  test.setTimeout(SEED_MS + 3 * POOL_HOLD.holdMs);
  const { rig, path } = await streamRig(page);
  const phone = await pairPhoneOnFixture(page, path);
  // The ruling, typed from the owner's words (never from effectiveStreamMode): the stored choice → what the phone starts.
  const steps: [string, Record<string, unknown> | null, "composed" | "passthrough"][] = [
    ["never chosen", null, "composed"],
    ["Camera only", { streamMode: "passthrough" }, "passthrough"],
    ["Add the score back", { streamMode: "composed" }, "composed"],
  ];
  let checked = 0;
  for (const [name, body, want] of steps) {
    if (body) await putSettings(page, rig.fixtureId, body);
    const started = await phone.start();
    expect(started.status, `${name}: the phone's start is accepted: ${JSON.stringify(started.refusal)}`).toBe(200);
    const sid = started.ok!.sid;
    sessionsThisTest.push({ request: page.request, fixtureId: rig.fixtureId, sid });
    expect(await sessionModeOf(sid), name).toMatchObject({ mode: want });
    await endNow(page, rig.fixtureId, sid);
    checked++;
  }
  console.log(`phone start modes checked: ${checked}`);
  expect(checked).toBe(steps.length);
});

test("R2006: the automatic start streams the stored mode — the score by default, the camera after Camera only", async ({ page }) => {
  test.setTimeout(2 * SEED_MS + 2 * POOL_HOLD.holdMs);
  // One fixture per mode: an organiser's Stop stamps the switch (A12), which would hold the second start back.
  const cases: [string, Record<string, unknown>, "composed" | "passthrough"][] = [
    ["never chosen", { autoStream: true }, "composed"],
    ["Camera only", { autoStream: true, streamMode: "passthrough" }, "passthrough"],
  ];
  let checked = 0;
  for (const [name, body, want] of cases) {
    const { rig, path } = await streamRig(page);
    await putSettings(page, rig.fixtureId, body);
    const phone = await pairPhoneOnFixture(page, path, { captureMode: "automatic" });
    phone.silence();
    // The rig's match is already in play (a scored hockey fixture): the phone's next beat is the one producer.
    const beat = await phone.beat();
    expect(beat.status, `${name}: the beat is answered`).toBe(200);
    const [row] = await withDb((sql) => sql<{ id: string; mode: string; start_cause: string }[]>`
      select id, mode, start_cause from fixture_stream_sessions where fixture_id = ${rig.fixtureId} order by created_at desc limit 1`);
    expect(row, `${name}: the beat started a broadcast`).toBeDefined();
    sessionsThisTest.push({ request: page.request, fixtureId: rig.fixtureId, sid: row!.id });
    expect(row, name).toMatchObject({ start_cause: "automatic", mode: want });
    await endNow(page, rig.fixtureId, row!.id);
    checked++;
  }
  console.log(`automatic start modes checked: ${checked}`);
  expect(checked).toBe(cases.length);
});

// I3 (PR #987 review, routed to R2006): the organiser's style-grid thumbnail names the sides as the overlay AIRS them. A
// person pair's aired codes come from its surnames (the overlay page's disambiguation); the panel used to re-code bare
// names as teams (first three letters). The expected codes are read off the AIRED page — OBS's own URL, anonymous —
// never off the preview.
test("I3: a person pair's thumbnail codes are the codes the overlay page airs, not the names re-coded as teams", async ({ page, browser }) => {
  const rig = await seedBadmintonOverlayFixture(page);
  const obs = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const anon = await obs.newPage();
    await anon.setViewportSize(VIEWPORT);
    await anon.goto(`/overlay/fixtures/${rig.fixtureId}?template=bug`);
    const code = (p: Page, scope: string, side: "home" | "away") => p.locator(`${scope} [data-testid="ovl-side-${side}"] .ovl-bug-code`).first();
    await expect(code(anon, "", "home")).toBeVisible({ timeout: 30_000 });
    const aired = [(await code(anon, "", "home").innerText()).trim(), (await code(anon, "", "away").innerText()).trim()];
    const names = (await withDb((sql) => sql<{ name: string }[]>`
      select e.display_name as name from fixtures f join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
       where f.id = ${rig.fixtureId} order by e.id = f.home_entrant_id desc`)).map((r) => r.name);
    // The premise that makes this a witness: the team rule (first three letters) would read differently for this pair.
    const teamRule = names.map((n) => n.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase());
    expect(aired, `premise: the pair airs person codes (${names.join(" v ")})`).not.toEqual(teamRule);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await fixturePathOf(rig));
    const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
    await expect(control).toHaveCount(1, { timeout: 30_000 });
    await control.click();
    await page.getByTestId("stream-tab-obs").click();
    const thumb = '[data-testid="stream-template-picker"] [data-testid="stream-template-bug"]';
    await expect(code(page, thumb, "home")).toBeAttached({ timeout: 30_000 });
    const previewed = [(await code(page, thumb, "home").innerText()).trim(), (await code(page, thumb, "away").innerText()).trim()];
    expect(previewed, "the thumbnail's codes are the aired codes").toEqual(aired);
  } finally {
    await obs.close();
  }
});
