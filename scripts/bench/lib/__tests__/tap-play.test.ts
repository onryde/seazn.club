// B07a T10 — the PLAYER half of tap mode (`lib/tap-play.ts`), driven against a
// fake browser and a fake product. The REAL `playMatchByTaps` and the REAL
// `genericAdapter` run unmodified, so every tap the driver takes lands on the
// fake pad below, and every ledger read it makes sees what those taps wrote.
//
// The fake product is deliberately stateful where the real one bites:
//   - the desktop hand-over is attached only at ≥768px (`max-md:hidden`);
//   - `score-finalize` is attached only if the console LOADED (goto/reload)
//     after the match was decided — the console polls every 15s, so a page
//     opened before play never shows it in time (R52 NB5);
//   - the pad is live only at `<origin>/score/<the secret the LAST mint
//     answered>` — any other URL is a dead pad;
//   - a cookie banner, computed with apps/web's own `needsConsentPrompt()`
//     against the page's storage after its init scripts ran, swallows every
//     tap until consent was pre-answered;
//   - `core.start`'s row can be made to land late (R52 NB3), and a row landed
//     after a late one stays invisible behind it, as a real ledger has no gaps.
import { describe, expect, it } from "vitest";
import * as webConsent from "../../../../apps/web/src/lib/consent.ts";
import type { LedgerTransport } from "../ledger.ts";
import { newSession } from "../http.ts";
import { genericAdapter } from "../drivers/adapters/generic.ts";
import { ORGANISER_VIEWPORT } from "../drivers/scorer.ts";
import {
  CONSENT_CHOICE,
  CONSENT_KEY,
  CONSENT_SEED,
  CONSENT_VERSION_KEY,
  COOKIE_POLICY_VERSION,
  DEVICE_HANDOVER_SELECTOR,
  MD_BREAKPOINT_PX,
  SCORER_VIEWPORT,
  createTapPlayer,
  devicePadUrl,
  isMintResponse,
  playTapRounds,
  secretFromMintBody,
  type ConsentSeed,
  type TapBrowser,
  type TapContext,
  type TapFixtureJob,
  type TapPage,
  type TapResponse,
} from "../tap-play.ts";

const ORIGIN = "http://bench.example";
const FIXTURE_ID = "fx-tap-1";
const CONSOLE_PATH = "/o/org-slug/c/comp-slug/d/div-slug/f/1";
const LOGIN_URL = `${ORIGIN}/api/auth/magic-link/consume?token=t`;
const HOME = "ent-home";
const AWAY = "ent-away";

const noSleep = async (): Promise<void> => {};

/** Runs `fn` with `globalThis.localStorage` backed by `store`, restoring
 *  whatever was there. `needsConsentPrompt` and `seedConsent` both read the
 *  global, exactly as they do in a page. */
function withLocalStorage<T>(store: Map<string, string>, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", previous);
  }
}

interface FakeWorldOptions {
  /** `core.start`'s row stays invisible until this many ledger reads after the tap. */
  startRowAfterReads?: number;
  /** The status a visible `core.start` moves the fixture to (a correct product: in_play). */
  statusAfterStart?: string;
  /** What the device-link mint answers (a correct, paid-for org: 201). */
  mintStatus?: number;
  /** Drop every `addInitScript` — the negative control for the banner model. */
  dropInitScripts?: boolean;
}

interface LedgerRowFake {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly visibleFromRead: number;
}

function fakeWorld(opts: FakeWorldOptions = {}) {
  const rows: LedgerRowFake[] = [];
  let reads = 0;
  const secrets: string[] = [];
  const record = {
    gotos: [] as string[],
    reloads: 0,
    handoverClicks: 0,
    mints: 0,
    contexts: [] as { viewport: { width: number; height: number }; seeds: ConsentSeed[] }[],
    closedContexts: 0,
    closedPages: 0,
    browserClosed: false,
  };

  const visibleRows = (): LedgerRowFake[] => {
    const out: LedgerRowFake[] = [];
    for (const r of rows) {
      if (r.visibleFromRead > reads) break;
      out.push(r);
    }
    return out;
  };
  const statusNow = (): string => {
    let status = "scheduled";
    for (const r of visibleRows()) {
      if (r.type === "core.start") status = opts.statusAfterStart ?? "in_play";
      else if (r.type === "generic.result") status = "decided";
      else if (r.type === "core.finalize") status = "finalized";
    }
    return status;
  };
  const append = (type: string, payload: unknown, delayReads = 0): void => {
    rows.push({ seq: rows.length + 1, type, payload, visibleFromRead: reads + delayReads });
  };

  const ledger: LedgerTransport = {
    async raw(_base, _s, path) {
      const events = new RegExp(`^/api/v1/fixtures/${FIXTURE_ID}/events\\?since_seq=(\\d+)$`).exec(path);
      if (events !== null) {
        reads += 1;
        const since = Number(events[1]);
        const data = visibleRows()
          .filter((r) => r.seq > since)
          .map((r) => ({ id: `ev-${r.seq}`, seq: r.seq, type: r.type, payload: r.payload }));
        return { status: 200, json: { ok: true, data } as never };
      }
      if (path === `/api/v1/fixtures/${FIXTURE_ID}/state`) {
        const visible = visibleRows();
        return {
          status: 200,
          json: { ok: true, data: { status: statusNow(), last_seq: visible.at(-1)?.seq ?? 0 } } as never,
        };
      }
      throw new Error(`fake ledger: unhandled ${path}`);
    },
  };

  interface FakeContextState {
    readonly viewport: { width: number; height: number };
    readonly scripts: { script: (seed: ConsentSeed) => void; arg: ConsentSeed }[];
    signedIn: boolean;
    readonly seeds: ConsentSeed[];
  }

  const makePage = (ctx: FakeContextState): TapPage => {
    let url = "about:blank";
    let viewport = { ...ctx.viewport };
    let snapshotStatus = "scheduled";
    let handoverOpen = false;
    let padLive = false;
    let started = false;
    let bannerShown = true;
    const storage = new Map<string, string>();
    const listeners: { pred: (r: TapResponse) => boolean; resolve: (r: TapResponse) => void }[] = [];

    const onConsole = (): boolean => ctx.signedIn && url === `${ORIGIN}${CONSOLE_PATH}`;
    const attached = (sel: string): boolean => {
      switch (sel) {
        case DEVICE_HANDOVER_SELECTOR:
          return onConsole() && viewport.width >= MD_BREAKPOINT_PX;
        case '[data-testid="device-link-mint"]':
          return onConsole() && handoverOpen;
        case '[data-testid="score-finalize"]':
          return onConsole() && snapshotStatus === "decided";
        case '[data-testid="score-start-match"]':
          return padLive && !started;
        case '[data-role="v3-scorebug-half"][data-side="home"]':
        case '[data-role="v3-scorebug-half"][data-side="away"]':
        case '[data-tile-id="settle"]':
          return padLive && started;
        default:
          return false;
      }
    };
    const clickOn = (sel: string): void => {
      switch (sel) {
        case DEVICE_HANDOVER_SELECTOR:
          record.handoverClicks += 1;
          handoverOpen = !handoverOpen;
          return;
        case '[data-testid="device-link-mint"]': {
          record.mints += 1;
          const status = opts.mintStatus ?? 201;
          let body: unknown;
          if (status === 201) {
            const secret = `dl_${Math.random().toString(36).slice(2)}`;
            secrets.push(secret);
            body = { ok: true, data: { id: `dl-${secrets.length}`, secret } };
          } else {
            body = { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "scoring.device_links" } };
          }
          const response: TapResponse = {
            url: () => `${ORIGIN}/api/v1/fixtures/${FIXTURE_ID}/device-links`,
            status: () => status,
            request: () => ({ method: () => "POST" }),
            json: async () => body,
          };
          for (const l of listeners.splice(0)) {
            if (l.pred(response)) l.resolve(response);
            else listeners.push(l);
          }
          return;
        }
        case '[data-testid="score-finalize"]':
          append("core.finalize", {});
          return;
        case '[data-testid="score-start-match"]':
          started = true;
          append("core.start", {}, opts.startRowAfterReads ?? 0);
          return;
        case '[data-role="v3-scorebug-half"][data-side="home"]':
          append("generic.score", { by: HOME, points: 1 });
          return;
        case '[data-role="v3-scorebug-half"][data-side="away"]':
          append("generic.score", { by: AWAY, points: 1 });
          return;
        case '[data-tile-id="settle"]':
          append("generic.result", {});
          return;
      }
    };

    return {
      url: () => url,
      viewportSize: () => ({ ...viewport }),
      async setViewportSize(size) {
        viewport = { width: size.width, height: size.height };
      },
      async goto(target) {
        url = target;
        record.gotos.push(target);
        withLocalStorage(storage, () => {
          for (const { script, arg } of ctx.scripts) script(arg);
        });
        bannerShown = withLocalStorage(storage, () => webConsent.needsConsentPrompt());
        if (target === LOGIN_URL) ctx.signedIn = true;
        if (onConsole()) snapshotStatus = statusNow();
        padLive = secrets.length > 0 && target === `${ORIGIN}/score/${secrets[secrets.length - 1]}`;
        return null;
      },
      async reload() {
        record.reloads += 1;
        if (onConsole()) snapshotStatus = statusNow();
        return null;
      },
      locator(sel) {
        return {
          async click() {
            if (!attached(sel)) throw new Error(`fake page: ${sel} is not attached`);
            if (bannerShown) throw new Error(`fake page: the cookie banner intercepts pointer events on ${sel}`);
            clickOn(sel);
          },
          async fill() {
            throw new Error(`fake page: fill is not modelled (${sel})`);
          },
          async waitFor() {
            if (!attached(sel)) throw new Error(`fake page: timeout waiting for ${sel}`);
          },
          async count() {
            return attached(sel) ? 1 : 0;
          },
        };
      },
      waitForResponse(pred) {
        return new Promise<TapResponse>((resolve) => listeners.push({ pred, resolve }));
      },
      async close() {
        record.closedPages += 1;
      },
    };
  };

  const browser: TapBrowser = {
    async newContext({ viewport }) {
      const ctx: FakeContextState = { viewport: { ...viewport }, scripts: [], signedIn: false, seeds: [] };
      record.contexts.push({ viewport: ctx.viewport, seeds: ctx.seeds });
      const context: TapContext = {
        async addInitScript(script, arg) {
          ctx.seeds.push(arg);
          if (opts.dropInitScripts !== true) ctx.scripts.push({ script, arg });
        },
        async newPage() {
          return makePage(ctx);
        },
        async close() {
          record.closedContexts += 1;
        },
      };
      return context;
    },
    async close() {
      record.browserClosed = true;
    },
  };

  return { ledger, browser, record, secrets, rows, statusNow };
}

function job(events: { type: string; payload: unknown }[]): TapFixtureJob {
  return {
    divisionRef: "d-tap",
    fixtureExtKey: "rr-r1-c1",
    fixtureId: FIXTURE_ID,
    consolePath: CONSOLE_PATH,
    stream: { home: "home", away: "away", events },
    adapter: genericAdapter,
    cfg: { resultMode: "score" },
    refIdByKey: new Map([
      ["home", HOME],
      ["away", AWAY],
    ]),
  };
}

function player(world: ReturnType<typeof fakeWorld>, organiserViewport?: { width: number; height: number }) {
  return createTapPlayer({
    browser: world.browser,
    loginUrl: LOGIN_URL,
    base: ORIGIN,
    session: newSession(),
    ledger: world.ledger,
    sleep: noSleep,
    ownsBrowser: true,
    ...(organiserViewport === undefined ? {} : { organiserViewport }),
  });
}

const FULL_MATCH = [
  { type: "core.start", payload: {} },
  { type: "generic.score", payload: { by: "@home", points: 1 } },
  { type: "generic.result", payload: {} },
];

describe("the consent pre-answer mirrors apps/web (R45)", () => {
  it("uses apps/web's own keys and policy version, and pre-answers 'rejected'", () => {
    expect(CONSENT_KEY).toBe(webConsent.CONSENT_KEY);
    expect(CONSENT_VERSION_KEY).toBe(webConsent.CONSENT_VERSION_KEY);
    expect(COOKIE_POLICY_VERSION).toBe(webConsent.COOKIE_POLICY_VERSION);
    expect(CONSENT_CHOICE).toBe("rejected");
    // The seed, applied, is what apps/web itself reads as "no prompt, no analytics".
    const store = new Map<string, string>();
    withLocalStorage(store, () => {
      expect(webConsent.needsConsentPrompt()).toBe(true);
    });
    withLocalStorage(store, () => {
      (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
        CONSENT_SEED.consentKey,
        CONSENT_SEED.choice,
      );
      (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
        CONSENT_SEED.versionKey,
        CONSENT_SEED.version,
      );
      expect(webConsent.needsConsentPrompt()).toBe(false);
      expect(webConsent.analyticsConsented()).toBe(false);
    });
  });
});

describe("pure helpers (B07a T10)", () => {
  it("builds the pad URL as device-link-panel.tsx:67 does", () => {
    expect(devicePadUrl("http://localhost:3000", "dl_abc")).toBe("http://localhost:3000/score/dl_abc");
  });

  it("recognises only this fixture's mint POST, and reads the secret off the envelope", () => {
    const response = (method: string, url: string): TapResponse => ({
      url: () => url,
      status: () => 201,
      request: () => ({ method: () => method }),
      json: async () => ({}),
    });
    const pred = isMintResponse("fx-1");
    expect(pred(response("POST", `${ORIGIN}/api/v1/fixtures/fx-1/device-links`))).toBe(true);
    expect(pred(response("GET", `${ORIGIN}/api/v1/fixtures/fx-1/device-links`))).toBe(false);
    expect(pred(response("POST", `${ORIGIN}/api/v1/fixtures/fx-2/device-links`))).toBe(false);
    expect(secretFromMintBody({ ok: true, data: { secret: "dl_x" } })).toBe("dl_x");
    expect(secretFromMintBody({ ok: false, error: { code: "PAYMENT_REQUIRED" } })).toBeUndefined();
  });

  it("plays rounds in order and never more than `cap` matches of a round at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const results = await playTapRounds([["a", "b", "c"], ["d"]], 2, async (j) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${j}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      order.push(`end:${j}`);
      return j.toUpperCase();
    });
    expect(results).toEqual(["A", "B", "C", "D"]);
    expect(maxInFlight).toBe(2);
    // Round 2 starts only after every match of round 1 ended.
    expect(order.indexOf("start:d")).toBeGreaterThan(Math.max(order.indexOf("end:a"), order.indexOf("end:b"), order.indexOf("end:c")));
    await expect(playTapRounds([["a"]], 0, async (j) => j)).rejects.toThrow("positive integer");
  });
});

describe("createTapPlayer — hand-over, play, sign-off (B07a T10)", () => {
  it("hands a real device link over, plays the match on a 390x844 pad, and the organiser finalizes it", async () => {
    const world = fakeWorld();
    const p = player(world);
    const result = await p.playFixture(job(FULL_MATCH));

    expect(result.findings).toEqual([]);
    expect(world.statusNow()).toBe("finalized");
    expect(world.rows.map((r) => r.type)).toEqual(["core.start", "generic.score", "generic.result", "core.finalize"]);
    // hand-over + mint + one tap per event + finalize.
    expect(result.taps).toBe(2 + FULL_MATCH.length + 1);
    // R44 — the pad was opened at the secret the mint RESPONSE carried.
    expect(world.secrets).toHaveLength(1);
    expect(world.record.gotos).toContain(`${ORIGIN}/score/${world.secrets[0]}`);
    // R45 — an organiser context ≥768 and a scorer context at 390x844, both
    // consent-seeded with apps/web's keys.
    expect(world.record.contexts.map((c) => c.viewport)).toEqual([
      { width: ORGANISER_VIEWPORT.width, height: ORGANISER_VIEWPORT.height },
      { width: SCORER_VIEWPORT.width, height: SCORER_VIEWPORT.height },
    ]);
    for (const c of world.record.contexts) expect(c.seeds).toEqual([CONSENT_SEED]);
    // R52 NB5 — the console was reloaded before finalize was looked for.
    expect(world.record.reloads).toBeGreaterThanOrEqual(1);

    await p.close();
    expect(world.record.browserClosed).toBe(true);
  });

  it("the fake's cookie banner has teeth: without the consent pre-answer no tap lands", async () => {
    const world = fakeWorld({ dropInitScripts: true });
    const result = await player(world).playFixture(job(FULL_MATCH));
    expect(result.findings.join("\n")).toContain("cookie banner");
    expect(world.rows).toEqual([]);
  });

  it("waits for core.start's own row before the next tap, so a start that never went in_play is judged (R52 NB3)", async () => {
    const world = fakeWorld({ startRowAfterReads: 4, statusAfterStart: "scheduled" });
    const result = await player(world).playFixture(
      job([
        { type: "core.start", payload: {} },
        { type: "generic.result", payload: {} },
      ]),
    );
    expect(result.findings).toContain('status: expected "in_play" after core.start, got "scheduled"');
  });

  it("a correct start that is merely slow to land produces no finding", async () => {
    const world = fakeWorld({ startRowAfterReads: 4 });
    const result = await player(world).playFixture(job(FULL_MATCH));
    expect(result.findings).toEqual([]);
    expect(world.statusNow()).toBe("finalized");
  });

  it("an organiser page narrower than 768 cannot reach the hand-over: a finding, and nothing minted", async () => {
    const world = fakeWorld();
    const result = await player(world, { width: 390, height: 844 }).playFixture(job(FULL_MATCH));
    expect(result.findings.join("\n")).toContain(String(MD_BREAKPOINT_PX));
    expect(result.findings.join("\n")).toContain("hand-over");
    expect(world.record.handoverClicks).toBe(0);
    expect(world.record.mints).toBe(0);
    expect(world.rows).toEqual([]);
  });

  it("a refused mint is a finding naming the status and code, and no scorer is ever opened", async () => {
    const world = fakeWorld({ mintStatus: 402 });
    const result = await player(world).playFixture(job(FULL_MATCH));
    expect(result.findings.join("\n")).toContain("HTTP 402");
    expect(result.findings.join("\n")).toContain("PAYMENT_REQUIRED");
    expect(world.record.contexts.filter((c) => c.viewport.width === SCORER_VIEWPORT.width)).toHaveLength(0);
    expect(world.rows).toEqual([]);
  });
});
