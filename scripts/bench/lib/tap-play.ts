// B07a T10 — tap mode, wired: the organiser hands a real device link over, a
// scorer plays the match on the real pad by tapping, and the organiser signs
// it off. `drivers/scorer.ts` (Task 9) plays ONE match once it is handed two
// pages and a device URL; this module is everything around that call — the
// browser lifecycle, the hand-over, the parallelism — behind one injectable
// seam (`TapPlayerFactory`) that `run-suite.ts` defaults to the real browser.
//
// Nothing here writes to the product over HTTP. Every write is a side effect
// of a real tap; the only HTTP this module makes itself is the magic-link
// REQUEST (the browser performs the consume) and the ledger READS the
// core.start wait polls.
//
// Strip-types safe (`strip-types-loadable.test.ts` loads every shipped
// module): no enums, namespaces or parameter properties, and every relative
// import carries `.ts`.
import { chromium } from "playwright";
import { call, newSession, type Session } from "./http.ts";
import { fetchFixtureLedger, type LedgerTransport } from "./ledger.ts";
import {
  FINALIZE_TESTID,
  FORFEIT_TESTID,
  ORGANISER_VIEWPORT,
  START_MATCH_TESTID,
  playMatchByTaps,
  selectorForTapStep,
  type PadLocator,
  type PadPage,
  type PlayMatchResult,
  type PlayMatchStream,
  type TapAdapter,
} from "./drivers/scorer.ts";
import { genericAdapter } from "./drivers/adapters/generic.ts";

// ---------------------------------------------------------------------------
// The cookie-consent pre-answer (R45). MIRRORED from
// `apps/web/src/lib/consent.ts` rather than imported — the bench never imports
// out of `apps/web` (`lib/http.ts`'s header) — and pinned equal to it by
// `tap-play.test.ts`, so a renamed key or a bumped policy version reds a test
// instead of silently putting the banner back over the pad.
//
// "rejected", never "accepted": `analyticsConsented()` is true only for an
// accepted choice, and an accepted one would send the bench's taps to the
// LIVE PostHog project a local server is configured with.
// ---------------------------------------------------------------------------
export const CONSENT_KEY = "seazn_cookie_consent";
export const CONSENT_VERSION_KEY = "seazn_cookie_consent_version";
export const COOKIE_POLICY_VERSION = "2026-07-09";
export const CONSENT_CHOICE = "rejected";

export interface ConsentSeed {
  readonly consentKey: string;
  readonly versionKey: string;
  readonly version: string;
  readonly choice: string;
}

export const CONSENT_SEED: ConsentSeed = {
  consentKey: CONSENT_KEY,
  versionKey: CONSENT_VERSION_KEY,
  version: COOKIE_POLICY_VERSION,
  choice: CONSENT_CHOICE,
};

/** Runs INSIDE the page (Playwright serialises it via `addInitScript`), so it
 *  must be self-contained: no closure over anything in this module. */
export function seedConsent(seed: ConsentSeed): void {
  try {
    const storage = (globalThis as unknown as { localStorage?: { setItem(k: string, v: string): void } }).localStorage;
    storage?.setItem(seed.consentKey, seed.choice);
    storage?.setItem(seed.versionKey, seed.version);
  } catch {
    // Storage blocked: the banner shows, and the first blocked tap says so.
  }
}

/** R45 — the scorer's phone. */
export const SCORER_VIEWPORT = { width: 390, height: 844 } as const;

/** Tailwind `md`. The desktop hand-over is `max-md:hidden`
 *  (`fixture-console.tsx:851`), so an organiser page narrower than this has no
 *  tappable hand-over at all — its phone twin (`:716`) is a different control. */
export const MD_BREAKPOINT_PX = 768;

/** `fixture-console.tsx:847`. */
export const DEVICE_HANDOVER_SELECTOR = '[data-role="device-handover"]';
/** `device-link-panel.tsx:156`/`:162` (the panel mounts one or the other). */
export const DEVICE_LINK_MINT_TESTID = "device-link-mint";

/** How long a console page gets to render its hand-over, and the panel its
 *  mint button, after navigation — a page load, not a tap, so wider than the
 *  driver's own per-tap `TAP_WAIT_TIMEOUT_MS`. */
export const CONSOLE_WAIT_TIMEOUT_MS = 15_000;
/** How long the mint response gets after the mint tap. */
export const MINT_RESPONSE_TIMEOUT_MS = 15_000;

/** R52 NB3 — after `score-start-match`, poll the ledger until `core.start`'s
 *  own row is there before the driver may take its next tap. */
export const START_ROW_POLL_INTERVAL_MS = 200;
export const START_ROW_POLL_ATTEMPTS = 50;

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** The pad URL a device link opens — built EXACTLY as the panel builds the URL
 *  it encodes into its QR code:
 *    apps/web/src/components/v2/device-link-panel.tsx:67
 *    const url = `${window.location.origin}/score/${link.secret}`
 *  `origin` is the organiser page's own origin, `secret` the mint response's. */
export function devicePadUrl(origin: string, secret: string): string {
  return `${origin}/score/${secret}`;
}

/** `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` —
 *  every segment is the SERVER's value (org slug, competition slug, division
 *  slug, `fixture_no`), never the pack's. */
export function consoleFixturePath(p: {
  readonly orgSlug: string;
  readonly competitionSlug: string;
  readonly divisionSlug: string;
  readonly fixtureNo: number;
}): string {
  const seg = encodeURIComponent;
  return `/o/${seg(p.orgSlug)}/c/${seg(p.competitionSlug)}/d/${seg(p.divisionSlug)}/f/${p.fixtureNo}`;
}

/** The mint's own response: a POST to this fixture's device-links route. */
export function isMintResponse(fixtureId: string): (response: TapResponse) => boolean {
  const path = `/api/v1/fixtures/${fixtureId}/device-links`;
  return (response) => {
    if (response.request().method() !== "POST") return false;
    try {
      return new URL(response.url()).pathname === path;
    } catch {
      return false;
    }
  };
}

/** `{ ok, data: { secret } }` — the v1 envelope `apiV1` unwraps in the panel. */
export function secretFromMintBody(body: unknown): string | undefined {
  const data = (body as { data?: { secret?: unknown } } | null)?.data;
  return typeof data?.secret === "string" && data.secret.length > 0 ? data.secret : undefined;
}

function errorCodeOf(body: unknown): string {
  const err = (body as { error?: { code?: unknown; feature_key?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : "(no code)";
  return typeof err?.feature_key === "string" ? `${code} (${err.feature_key})` : code;
}

/** One row of `GET /api/v1/divisions/{id}/fixtures`, as tap play reads it. */
export interface TapBoardRow {
  readonly id: string;
  readonly extKey: string | null;
  readonly roundNo: number | null;
  readonly fixtureNo: number | null;
  readonly status: string;
}

export function tapBoardRowsOf(rows: readonly unknown[]): readonly TapBoardRow[] {
  const out: TapBoardRow[] = [];
  for (const item of rows) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    out.push({
      id: r.id,
      extKey: typeof r.ext_key === "string" ? r.ext_key : null,
      roundNo: typeof r.round_no === "number" ? r.round_no : null,
      fixtureNo: typeof r.fixture_no === "number" ? r.fixture_no : null,
      // `(absent)`, never a plausible default — oracle.ts's convention.
      status: typeof r.status === "string" ? r.status : "(absent)",
    });
  }
  return out;
}

const TAP_ADAPTERS: ReadonlyMap<string, TapAdapter> = new Map([[genericAdapter.sport, genericAdapter]]);

/** `undefined` for a sport no adapter exists for — the caller reports it. */
export function adapterForSport(sportKey: string): TapAdapter | undefined {
  return TAP_ADAPTERS.get(sportKey);
}

/**
 * Rounds IN ORDER; the matches of one round in parallel, never more at once
 * than `cap` (the division's court count — a real venue cannot play more
 * matches at once than it has courts). Results keep job order.
 */
export async function playTapRounds<J, R>(
  rounds: readonly (readonly J[])[],
  cap: number,
  playOne: (job: J) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`tap: the parallelism cap must be a positive integer, got ${String(cap)}`);
  }
  const out: R[] = [];
  for (const round of rounds) {
    const results: R[] = new Array<R>(round.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < round.length) {
        const i = next;
        next += 1;
        results[i] = await playOne(round[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(cap, round.length) }, () => worker()));
    out.push(...results);
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The narrow browser surface. A real Playwright `Browser` is passed to
// `createTapPlayer` below by `browserTapPlayer` with NO cast, so tsc proves
// the assignability in production code itself.
// ---------------------------------------------------------------------------
export interface TapResponse {
  url(): string;
  status(): number;
  request(): { method(): string };
  json(): Promise<unknown>;
}

export interface TapPage extends PadPage {
  url(): string;
  reload(): Promise<unknown>;
  viewportSize(): { width: number; height: number } | null;
  waitForResponse(predicate: (response: TapResponse) => boolean, options?: { timeout?: number }): Promise<TapResponse>;
  close(): Promise<void>;
}

export interface TapContext {
  newPage(): Promise<TapPage>;
  /** `Promise<unknown>`: a real `BrowserContext.addInitScript` resolves a
   *  `Disposable`, which is not assignable to `void`. */
  addInitScript(script: (seed: ConsentSeed) => void, arg: ConsentSeed): Promise<unknown>;
  close(): Promise<void>;
}

export interface TapBrowser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<TapContext>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The seam.
// ---------------------------------------------------------------------------

/** One tapped fixture, fully resolved by the runner. */
export interface TapFixtureJob {
  readonly divisionRef: string;
  readonly fixtureExtKey: string;
  readonly fixtureId: string;
  /** The organiser console path for this fixture (`consoleFixturePath`). */
  readonly consolePath: string;
  readonly stream: PlayMatchStream;
  readonly adapter: TapAdapter;
  readonly cfg?: unknown;
  readonly refIdByKey: ReadonlyMap<string, string>;
}

export interface TapPlayer {
  /** Never rejects: every failure is a finding on the result. */
  playFixture(job: TapFixtureJob): Promise<PlayMatchResult>;
  close(): Promise<void>;
}

export interface TapPlayerContext {
  readonly base: string;
  /** The runner's own API session — ledger reads only. */
  readonly session: Session;
  /** The organiser's identity; the browser signs in as it. */
  readonly email: string;
  readonly ledger: LedgerTransport;
}

export type TapPlayerFactory = (ctx: TapPlayerContext) => Promise<TapPlayer>;

// ---------------------------------------------------------------------------
// Page wrappers — explicit method-by-method delegation, never a spread of a
// Playwright object (its methods live on the prototype and would not copy).
// ---------------------------------------------------------------------------
function delegateLocator(page: PadPage, selector: string): PadLocator {
  return {
    click: () => page.locator(selector).click(),
    fill: (value) => page.locator(selector).fill(value),
    waitFor: (options) => page.locator(selector).waitFor(options),
    count: () => page.locator(selector).count(),
  };
}

/** R52 NB3 — tapping `score-start-match` is not done until `core.start`'s own
 *  row is on the ledger. A throw here is recorded by the driver as a tap
 *  finding, so a start that never lands stops the match loudly. */
export function gateScoringOnStartRow(page: PadPage, waitForStartRow: () => Promise<void>): PadPage {
  const startSelector = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
  return {
    goto: (url) => page.goto(url),
    setViewportSize: (size) => page.setViewportSize(size),
    locator: (selector) => {
      const inner = delegateLocator(page, selector);
      if (selector !== startSelector) return inner;
      return {
        ...inner,
        click: async () => {
          await inner.click();
          await waitForStartRow();
        },
      };
    },
  };
}

/** R52 NB5 — the console polls its fixture only every 15s
 *  (`scorepad/use-fixture-stream.ts:21`), and `score-finalize` renders only
 *  once the page knows the match is decided (`fixture-console.tsx:1099`). A
 *  page opened before the scorer played therefore never shows it in time:
 *  reload first, then wait.
 *
 *  Fix round 1 (R59(c)) — the same page authors the organiser's forfeit, whose
 *  toggle IS on screen from the first load; but every console send carries
 *  `expected_seq` from the page's last load (`fixture-console.tsx:456`), and a
 *  console loaded before the scorer's `core.start` is answered SEQ_CONFLICT and
 *  writes nothing. So the FIRST control of each organiser action reloads too. */
export function reloadConsoleBeforeAction(page: TapPage): PadPage {
  const reloadFirst = new Set([FINALIZE_TESTID, FORFEIT_TESTID].map((testid) => selectorForTapStep({ kind: "testid", testid })));
  return {
    goto: (url) => page.goto(url),
    setViewportSize: (size) => page.setViewportSize(size),
    locator: (selector) => {
      const inner = delegateLocator(page, selector);
      if (!reloadFirst.has(selector)) return inner;
      return {
        ...inner,
        waitFor: async (options) => {
          await page.reload();
          await inner.waitFor(options);
        },
      };
    },
  };
}

export async function waitForStartRow(input: {
  readonly base: string;
  readonly session: Session;
  readonly fixtureId: string;
  readonly ledger: LedgerTransport;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; attempt < START_ROW_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await input.sleep(START_ROW_POLL_INTERVAL_MS);
    const rows = await fetchFixtureLedger(input.base, input.session, input.fixtureId, 0, input.ledger);
    if (rows.some((r) => r.type === "core.start")) return;
  }
  throw new Error(
    `core.start never reached the ledger within ${START_ROW_POLL_ATTEMPTS * START_ROW_POLL_INTERVAL_MS}ms of tapping ` +
      `${START_MATCH_TESTID} — the next tap would race it`,
  );
}

// ---------------------------------------------------------------------------
// The player.
// ---------------------------------------------------------------------------

export interface CreateTapPlayerInput {
  readonly browser: TapBrowser;
  /** A magic-link `login_url` for the organiser; consumed by the page. */
  readonly loginUrl: string;
  readonly base: string;
  readonly session: Session;
  readonly ledger: LedgerTransport;
  /** Defaults to the driver's own `ORGANISER_VIEWPORT` (≥768). */
  readonly organiserViewport?: { readonly width: number; readonly height: number };
  /** Test-only: a sleep that does not wait. Forwarded to the driver too. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Close `browser` when the player closes (the real factory owns it). */
  readonly ownsBrowser?: boolean;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTapPlayer(input: CreateTapPlayerInput): TapPlayer {
  const sleep = input.sleep ?? realSleep;
  const organiserViewport = input.organiserViewport ?? ORGANISER_VIEWPORT;
  let organiser: Promise<TapContext> | undefined;

  // ONE signed-in organiser context for the whole run, each fixture on its own
  // page in it. Consent is pre-answered here as well: the banner is fixed to
  // the viewport bottom and would sit over `score-finalize` just the same.
  function organiserContext(): Promise<TapContext> {
    organiser ??= (async () => {
      const context = await input.browser.newContext({
        viewport: { width: organiserViewport.width, height: organiserViewport.height },
      });
      await context.addInitScript(seedConsent, CONSENT_SEED);
      const login = await context.newPage();
      await login.goto(input.loginUrl);
      await login.close();
      return context;
    })();
    return organiser;
  }

  return {
    async playFixture(job) {
      const start = performance.now();
      const findings: string[] = [];
      let taps = 0;
      const early = (): PlayMatchResult => ({
        fixtureId: job.fixtureId,
        taps,
        wallMs: Math.round(performance.now() - start),
        findings,
        observations: [],
      });
      let orgPage: TapPage | undefined;
      let scorerContext: TapContext | undefined;
      try {
        orgPage = await (await organiserContext()).newPage();
        const viewport = orgPage.viewportSize();
        if (viewport === null || viewport.width < MD_BREAKPOINT_PX) {
          findings.push(
            `handover: the organiser page is ${viewport === null ? "(no viewport)" : `${viewport.width}px`} wide — ` +
              `the device hand-over is max-md:hidden below ${MD_BREAKPOINT_PX}px (fixture-console.tsx:851), so there ` +
              "is nothing to tap",
          );
          return early();
        }

        await orgPage.goto(`${input.base}${job.consolePath}`);
        const handover = orgPage.locator(DEVICE_HANDOVER_SELECTOR);
        await handover.waitFor({ state: "visible", timeout: CONSOLE_WAIT_TIMEOUT_MS });
        await handover.click();
        taps += 1;

        const mint = orgPage.locator(selectorForTapStep({ kind: "testid", testid: DEVICE_LINK_MINT_TESTID }));
        await mint.waitFor({ state: "visible", timeout: CONSOLE_WAIT_TIMEOUT_MS });
        // Registered BEFORE the tap, or a fast response is gone by the time
        // anything listens. The no-op catch keeps a rejection that lands while
        // the click itself is failing from going unhandled.
        const minted = orgPage.waitForResponse(isMintResponse(job.fixtureId), { timeout: MINT_RESPONSE_TIMEOUT_MS });
        minted.catch(() => undefined);
        await mint.click();
        taps += 1;
        const response = await minted;
        const body = await response.json().catch(() => undefined);
        if (response.status() !== 201) {
          findings.push(
            `handover: minting a device link for ${job.fixtureExtKey} answered HTTP ${response.status()} ` +
              `${errorCodeOf(body)} — no scorer could be handed this match`,
          );
          return early();
        }
        const secret = secretFromMintBody(body);
        if (secret === undefined) {
          findings.push(`handover: the device-link mint for ${job.fixtureExtKey} answered 201 with no secret`);
          return early();
        }
        const deviceUrl = devicePadUrl(new URL(orgPage.url()).origin, secret);

        scorerContext = await input.browser.newContext({
          viewport: { width: SCORER_VIEWPORT.width, height: SCORER_VIEWPORT.height },
        });
        await scorerContext.addInitScript(seedConsent, CONSENT_SEED);
        const scorerPage = await scorerContext.newPage();

        const result = await playMatchByTaps({
          scorerPage: gateScoringOnStartRow(scorerPage, () =>
            waitForStartRow({
              base: input.base,
              session: input.session,
              fixtureId: job.fixtureId,
              ledger: input.ledger,
              sleep,
            }),
          ),
          organiserPage: reloadConsoleBeforeAction(orgPage),
          deviceUrl,
          fixtureId: job.fixtureId,
          stream: job.stream,
          adapter: job.adapter,
          refIdByKey: job.refIdByKey,
          ledger: input.ledger,
          base: input.base,
          session: input.session,
          cfg: job.cfg,
          sleep,
        });
        return {
          fixtureId: job.fixtureId,
          taps: taps + result.taps,
          wallMs: Math.round(performance.now() - start),
          findings: [...findings, ...result.findings],
          observations: result.observations,
          // Minors batch B, row (a) (R79) — `result` came from actually
          // calling `playMatchByTaps` (never the `early()` pre-flight exit
          // above), so its `unreadRowsAfterFinalize` is always a real
          // measured number (0 or N), never the "not measured" `undefined`
          // `early()` returns. Dropping this line silently reverts to the
          // pre-fix shape: measured, but never forwarded.
          unreadRowsAfterFinalize: result.unreadRowsAfterFinalize,
        };
      } catch (err) {
        findings.push(`handover: ${job.fixtureExtKey} — ${messageOf(err)}`);
        return early();
      } finally {
        await scorerContext?.close().catch(() => undefined);
        await orgPage?.close().catch(() => undefined);
      }
    },
    async close() {
      try {
        if (organiser !== undefined) await (await organiser).close();
      } finally {
        if (input.ownsBrowser === true) await input.browser.close();
      }
    },
  };
}

/** The magic-link REQUEST, as `drivers/browser.ts`'s private
 *  `requestMagicLinkUrl` makes it (same route, same `call()`); the organiser
 *  page performs the consume by navigating to the URL. */
async function requestLoginUrl(base: string, email: string): Promise<string> {
  const data = (await call(base, newSession(), "/api/auth/magic-link", "POST", { email })) as { login_url?: string };
  if (typeof data?.login_url !== "string") {
    throw new Error(`tap: the magic-link request for the organiser returned no login_url`);
  }
  return data.login_url;
}

/** The production default: a real Chromium, signed in as the run's organiser. */
export const browserTapPlayer: TapPlayerFactory = async (ctx) => {
  const browser = await chromium.launch();
  try {
    const loginUrl = await requestLoginUrl(ctx.base, ctx.email);
    return createTapPlayer({
      browser,
      loginUrl,
      base: ctx.base,
      session: ctx.session,
      ledger: ctx.ledger,
      ownsBrowser: true,
    });
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
};
