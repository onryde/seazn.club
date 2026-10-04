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
//
// Fix round 1 (R59) adds the three routes d-tiny needs, each as the product
// does it:
//   - a score-mode half tap is HELD behind a dock (`usesSoftCommit`,
//     pad-host.tsx:1232 — generic's dock always has amount chips); a new held
//     tap releases the previous one first (queue.ts `flushHeldBefore`); an
//     immediate submit queues BEHIND a held one; `pad-send-now` releases.
//   - the pad stamps a side's SOLE on-field player into the half tap
//     (generic.tsx:324-327) and offers person chips only for a side with more
//     than one (:702-705). `roster` absent ≡ no saved lineup — neither.
//   - THE DOCK RENDERS LATE. A hold's dock is not on screen the instant the tap
//     that made it returns: this fake re-renders it only when time passes (a
//     ledger read) or while a `waitFor` has to poll. A `count()`/`click()`
//     right after a tap therefore still sees the PREVIOUS dock, which is the
//     real race `releaseHold` exists for.
//   - the score-entry sheet: tile, then number + confirm per side, home first
//     (generic.tsx:554-578), then an immediate `generic.result`.
//   - the console's forfeit: toggle, per-side button, reason prompt (initial
//     "walkover", trimmed on submit), and the send carries `expected_seq` from
//     the page's last load — a stale console is refused (SEQ_CONFLICT,
//     fixture-console.tsx:456-469) and writes nothing. Finalize likewise.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  ORGANISER_TRACE_FILE_NAME,
  ORGANISER_VIDEO_FILE_NAME,
  SCORER_VIEWPORT,
  createTapPlayer,
  devicePadUrl,
  isMintResponse,
  playTapRounds,
  secretFromMintBody,
  tapTraceFileName,
  tapVideoFileName,
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

type Side = "home" | "away";

interface FakeWorldOptions {
  /** `core.start`'s row stays invisible until this many ledger reads after the tap. */
  startRowAfterReads?: number;
  /** The status a visible `core.start` moves the fixture to (a correct product: in_play). */
  statusAfterStart?: string;
  /** What the device-link mint answers (a correct, paid-for org: 201). */
  mintStatus?: number;
  /** Drop every `addInitScript` — the negative control for the banner model. */
  dropInitScripts?: boolean;
  /** On-field players per side, as the pad's squads carry them from a SAVED
   *  lineup. Absent ≡ no lineup saved — the bench's own d-tiny case. */
  roster?: { readonly home?: readonly string[]; readonly away?: readonly string[] };
}

interface LedgerRowFake {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly visibleFromRead: number;
}

interface PadSubmission {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const SEND_NOW = '[data-testid="pad-send-now"]';
const SIDE_ID: Record<Side, string> = { home: HOME, away: AWAY };

function fakeWorld(opts: FakeWorldOptions = {}) {
  const rows: LedgerRowFake[] = [];
  let reads = 0;
  const secrets: string[] = [];
  const renderers: (() => void)[] = [];
  const record = {
    gotos: [] as string[],
    reloads: 0,
    handoverClicks: 0,
    mints: 0,
    contexts: [] as {
      viewport: { width: number; height: number };
      seeds: ConsentSeed[];
      /** R86 — the RAW `recordVideo` option `newContext` was called with;
       *  `undefined` when the caller passed none (capture off for this
       *  context). Proves "absent from the newContext call when off". */
      recordVideo: { dir: string } | undefined;
    }[],
    closedContexts: 0,
    closedPages: 0,
    browserClosed: false,
    /** `console <selector>` / `pad <selector>` / `blank <selector>`, in order. */
    clicks: [] as string[],
    /** R86 — one entry per context whose `tracing.start`/`.stop` was
     *  actually called, in order. */
    tracingStarts: 0,
    tracingStops: [] as { path: string }[],
  };

  const visibleRows = (): LedgerRowFake[] => {
    const out: LedgerRowFake[] = [];
    for (const r of rows) {
      if (r.visibleFromRead > reads) break;
      out.push(r);
    }
    return out;
  };
  const tip = (): number => visibleRows().at(-1)?.seq ?? 0;
  const statusNow = (): string => {
    let status = "scheduled";
    for (const r of visibleRows()) {
      if (r.type === "core.start") status = opts.statusAfterStart ?? "in_play";
      else if (r.type === "generic.result") status = "decided";
      else if (r.type === "core.forfeit") status = "forfeited";
      else if (r.type === "core.finalize") status = "finalized";
    }
    return status;
  };
  const append = (type: string, payload: unknown, delayReads = 0): void => {
    rows.push({ seq: rows.length + 1, type, payload, visibleFromRead: reads + delayReads });
  };
  const roster = (side: Side): readonly string[] => opts.roster?.[side] ?? [];

  const ledger: LedgerTransport = {
    async raw(_base, _s, path) {
      // Time passes between reads: any dock a tap scheduled has rendered by now.
      for (const render of renderers) render();
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
        return { status: 200, json: { ok: true, data: { status: statusNow(), last_seq: tip() } } as never };
      }
      throw new Error(`fake ledger: unhandled ${path}`);
    },
  };

  interface FakeContextState {
    readonly viewport: { width: number; height: number };
    readonly scripts: { script: (seed: ConsentSeed) => void; arg: ConsentSeed }[];
    signedIn: boolean;
    readonly seeds: ConsentSeed[];
    /** R86 — set from `newContext`'s own `recordVideo.dir`; `undefined` when
     *  the caller passed none. Drives whether pages opened in this context
     *  get a real backing file for `.video()` to report. */
    readonly recordVideoDir?: string;
  }

  let pageSerial = 0;
  const makePage = (ctx: FakeContextState): TapPage => {
    let url = "about:blank";
    let viewport = { ...ctx.viewport };
    // R86 — a REAL file on disk under `ctx.recordVideoDir`, hash-named the
    // way Playwright actually names one, so production's `rename()` call
    // does real filesystem work a test can observe (existence, not just a
    // call count). `undefined` when capture was off for this context —
    // matches a real Page's `.video()` returning `null` in that case.
    pageSerial += 1;
    const videoPath =
      ctx.recordVideoDir === undefined ? undefined : path.join(ctx.recordVideoDir, `hash-${pageSerial}.webm`);
    if (videoPath !== undefined) {
      mkdirSync(ctx.recordVideoDir!, { recursive: true });
      writeFileSync(videoPath, "FAKE VIDEO");
    }
    let snapshotStatus = "scheduled";
    let snapshotSeq = 0;
    let handoverOpen = false;
    let padLive = false;
    let started = false;
    let bannerShown = true;
    const storage = new Map<string, string>();
    const listeners: { pred: (r: TapResponse) => boolean; resolve: (r: TapResponse) => void }[] = [];

    // --- the pad ---
    let held: (PadSubmission & { readonly id: number }) | undefined;
    let heldIds = 0;
    const queued: PadSubmission[] = [];
    /** What the RENDERED dock shows — lags `held` (see the header). */
    let dock: { readonly id: number; readonly side: Side; readonly named: boolean } | undefined;
    let sheet: { step: Side; value: number; home: number } | undefined;
    // --- the console ---
    let menuOpen = false;
    let prompt: { side: Side; reason: string } | undefined;

    const render = (): void => {
      dock =
        held === undefined
          ? undefined
          : { id: held.id, side: held.payload.by === HOME ? "home" : "away", named: typeof held.payload.person === "string" };
    };
    renderers.push(render);

    const land = (s: PadSubmission): void => append(s.type, s.payload);
    const release = (): void => {
      if (held !== undefined) land(held);
      held = undefined;
      for (const s of queued.splice(0)) land(s);
    };
    const submitHeld = (s: PadSubmission): void => {
      release();
      heldIds += 1;
      held = { ...s, id: heldIds };
    };
    const submitImmediate = (s: PadSubmission): void => {
      if (held !== undefined) queued.push(s);
      else land(s);
    };
    const refreshConsole = (): void => {
      snapshotStatus = statusNow();
      snapshotSeq = tip();
      menuOpen = false;
      prompt = undefined;
    };

    const onConsole = (): boolean => ctx.signedIn && url === `${ORIGIN}${CONSOLE_PATH}`;
    const surface = (): string => (onConsole() ? "console" : padLive ? "pad" : "blank");
    const chipOf = (sel: string): string | undefined => /^\[data-testid="pad-dock-chip-(.+)"\]$/.exec(sel)?.[1];

    const attached = (sel: string): boolean => {
      switch (sel) {
        case DEVICE_HANDOVER_SELECTOR:
          return onConsole() && viewport.width >= MD_BREAKPOINT_PX;
        case '[data-testid="device-link-mint"]':
          return onConsole() && handoverOpen;
        case '[data-testid="score-finalize"]':
          return onConsole() && (snapshotStatus === "decided" || snapshotStatus === "forfeited");
        case '[data-testid="score-forfeit"]':
          return onConsole() && !["decided", "forfeited", "finalized"].includes(snapshotStatus);
        case '[data-testid="score-forfeit-home"]':
        case '[data-testid="score-forfeit-away"]':
          return onConsole() && menuOpen;
        case '[data-testid="score-prompt-reason"]':
        case '[data-testid="score-prompt-submit"]':
          return onConsole() && prompt !== undefined;
        case '[data-testid="score-start-match"]':
          return padLive && !started;
        case '[data-role="v3-scorebug-half"][data-side="home"]':
        case '[data-role="v3-scorebug-half"][data-side="away"]':
        case '[data-tile-id="settle"]':
          return padLive && started;
        case '[data-tile-id="scoreEntry"]':
          return padLive && started && sheet === undefined;
        case '[data-testid="pad-sheet-number"]':
        case '[data-testid="pad-sheet-confirm"]':
          return padLive && sheet !== undefined;
        case SEND_NOW:
          return padLive && dock !== undefined;
      }
      const chip = chipOf(sel);
      if (chip === undefined || !padLive || dock === undefined) return false;
      if (/^points:(2|3|5)$/.test(chip)) return true;
      const person = /^person:(.+)$/.exec(chip)?.[1];
      const players = roster(dock.side);
      return person !== undefined && !dock.named && players.length > 1 && players.includes(person);
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
          if (snapshotSeq !== tip()) return; // SEQ_CONFLICT: a stale console writes nothing
          append("core.finalize", {});
          return;
        case '[data-testid="score-forfeit"]':
          menuOpen = !menuOpen;
          return;
        case '[data-testid="score-forfeit-home"]':
        case '[data-testid="score-forfeit-away"]':
          menuOpen = false;
          prompt = { side: sel.includes("home") ? "home" : "away", reason: "walkover" };
          return;
        case '[data-testid="score-prompt-submit"]': {
          const { side, reason } = prompt!;
          prompt = undefined;
          if (reason.trim() === "" || snapshotSeq !== tip()) return;
          append("core.forfeit", { by: SIDE_ID[side], reason: reason.trim() });
          refreshConsole();
          return;
        }
        case '[data-testid="score-start-match"]':
          started = true;
          append("core.start", {}, opts.startRowAfterReads ?? 0);
          return;
        case '[data-role="v3-scorebug-half"][data-side="home"]':
        case '[data-role="v3-scorebug-half"][data-side="away"]': {
          const side: Side = sel.includes('"home"') ? "home" : "away";
          const players = roster(side);
          submitHeld({
            type: "generic.score",
            payload: { by: SIDE_ID[side], points: 1, ...(players.length === 1 ? { person: players[0] } : {}) },
          });
          return;
        }
        case '[data-tile-id="settle"]':
          submitImmediate({ type: "generic.result", payload: {} });
          return;
        case '[data-tile-id="scoreEntry"]':
          sheet = { step: "home", value: 0, home: 0 };
          return;
        case '[data-testid="pad-sheet-confirm"]':
          if (sheet!.step === "home") {
            sheet = { step: "away", value: 0, home: sheet!.value };
          } else {
            submitImmediate({ type: "generic.result", payload: { p1Score: sheet!.home, p2Score: sheet!.value } });
            sheet = undefined;
          }
          return;
        case SEND_NOW:
          // A dock still on screen for an entry that already went out
          // dismisses nothing.
          if (held !== undefined && held.id === dock?.id) release();
          return;
      }
      const chip = chipOf(sel);
      // A chip acts on the entry the RENDERED dock is for; a stale dock's chip
      // is a no-op (`mutateHeld` finds no held entry by that id).
      if (chip === undefined || held === undefined || held.id !== dock?.id) return;
      const points = /^points:(\d+)$/.exec(chip)?.[1];
      const person = /^person:(.+)$/.exec(chip)?.[1];
      if (points !== undefined) held = { ...held, payload: { ...held.payload, points: Number(points) } };
      if (person !== undefined) held = { ...held, payload: { ...held.payload, person } };
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
        if (onConsole()) refreshConsole();
        padLive = secrets.length > 0 && target === `${ORIGIN}/score/${secrets[secrets.length - 1]}`;
        return null;
      },
      async reload() {
        record.reloads += 1;
        if (onConsole()) refreshConsole();
        return null;
      },
      locator(sel) {
        return {
          async click() {
            if (!attached(sel)) throw new Error(`fake page: ${sel} is not attached`);
            if (bannerShown) throw new Error(`fake page: the cookie banner intercepts pointer events on ${sel}`);
            record.clicks.push(`${surface()} ${sel}`);
            clickOn(sel);
          },
          async fill(value) {
            if (!attached(sel)) throw new Error(`fake page: ${sel} is not attached`);
            if (sel === '[data-testid="pad-sheet-number"]') sheet!.value = Number(value);
            else if (sel === '[data-testid="score-prompt-reason"]') prompt!.reason = value;
            else throw new Error(`fake page: fill is not modelled (${sel})`);
          },
          async waitFor(options) {
            const wantAttached = options?.state !== "detached" && options?.state !== "hidden";
            if (attached(sel) === wantAttached) return;
            render(); // a real waitFor polls, so a pending render lands while it waits
            if (attached(sel) !== wantAttached) {
              throw new Error(`fake page: timeout waiting for ${sel}${wantAttached ? "" : " to detach"}`);
            }
          },
          async count() {
            return attached(sel) ? 1 : 0;
          },
        };
      },
      waitForResponse(pred) {
        return new Promise<TapResponse>((resolve) => listeners.push({ pred, resolve }));
      },
      // The fake's `goto` (above) models the magic-link consume as
      // synchronous — `signedIn`/`url` are already updated by the time it
      // resolves, unlike the real client-side consume this method exists to
      // wait out (tap-play.ts's `organiserContext` doc comment). So this
      // fake can resolve immediately once the predicate is satisfied, with
      // no polling loop to model.
      async waitForURL(predicate) {
        const current = new URL(url);
        if (!predicate(current)) throw new Error(`fake page: waitForURL predicate never satisfied for "${url}"`);
      },
      async close() {
        record.closedPages += 1;
      },
      // R86 — ALWAYS present (a real Playwright `Page` always has this
      // method too, returning `null` when recording was off), so production
      // code's `page.video?.()` exercises the SAME branch regardless of
      // whether this particular test turned capture on.
      video: () =>
        videoPath === undefined
          ? null
          : {
              async path() {
                return videoPath;
              },
              async delete() {
                rmSync(videoPath, { force: true });
              },
            },
    };
  };

  const browser: TapBrowser = {
    async newContext({ viewport, recordVideo }) {
      const ctx: FakeContextState = {
        viewport: { ...viewport },
        scripts: [],
        signedIn: false,
        seeds: [],
        ...(recordVideo === undefined ? {} : { recordVideoDir: recordVideo.dir }),
      };
      record.contexts.push({ viewport: ctx.viewport, seeds: ctx.seeds, recordVideo });
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
        // R86 — ALWAYS present, same "matches the real, always-there API"
        // reasoning as `TapPage.video` above; production code only ever
        // calls `.start()`/`.stop()` when `--trace` was actually on.
        tracing: {
          async start() {
            record.tracingStarts += 1;
          },
          async stop({ path: tracePath }) {
            record.tracingStops.push({ path: tracePath });
            mkdirSync(path.dirname(tracePath), { recursive: true });
            writeFileSync(tracePath, "FAKE TRACE");
          },
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

const START = { type: "core.start", payload: {} };

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
    // Minors batch B, row (a) (R79) — `playFixture`'s success-path return
    // used to drop `playMatchByTaps`'s own `unreadRowsAfterFinalize`
    // entirely, so this always read `undefined` here regardless of what the
    // driver actually measured. Asserted as the concrete number `0` (never
    // `toBeUndefined()`): the driver DID measure it on this clean run (0
    // rows landed after finalize) and this proves that measured value
    // crossed the wrapper — `drivers/scorer.ts`'s own `finish()` proves the
    // 0-vs-1 values (`scorer-driver.test.ts`); this proves they REACH here.
    expect(result.unreadRowsAfterFinalize).toBe(0);
    expect(world.statusNow()).toBe("finalized");
    expect(world.rows.map((r) => r.type)).toEqual(["core.start", "generic.score", "generic.result", "core.finalize"]);
    // hand-over + mint + one tap per event + the pad-send-now that releases
    // the held score (the settle queued behind it) + finalize.
    expect(result.taps).toBe(2 + FULL_MATCH.length + 1 + 1);
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

// ---------------------------------------------------------------------------
// R86 (owner: "watch the bench play a match", trace "for troubleshooting") —
// video/trace capture. Both OFF by default; `createTapPlayer`'s
// `recordVideoDir`/`traceDir` are what bench.ts's CLI resolves and threads
// down (bench-cli.test.ts covers that hop; this covers the seam itself).
// ---------------------------------------------------------------------------
describe("R86 — video/trace capture", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tmpCaptureDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "tap-play-capture-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("off by default: newContext gets no recordVideo, tracing is never started, and no artefacts are reported", async () => {
    const world = fakeWorld();
    const p = player(world);
    const result = await p.playFixture(job(FULL_MATCH));

    expect(result.findings).toEqual([]);
    expect(result.videoPath).toBeUndefined();
    expect(result.tracePath).toBeUndefined();
    // The mutant this kills: threading the option unconditionally instead
    // of gating on `recordVideoDir`/`traceDir` being set.
    for (const c of world.record.contexts) expect(c.recordVideo).toBeUndefined();
    expect(world.record.tracingStarts).toBe(0);
    expect(world.record.tracingStops).toEqual([]);

    await p.close();
    expect(p.artefacts?.()).toEqual({});
  });

  it("threads recordVideoDir into every newContext call when set — organiser AND scorer", async () => {
    const dir = tmpCaptureDir();
    const world = fakeWorld();
    const p = createTapPlayer({
      browser: world.browser,
      loginUrl: LOGIN_URL,
      base: ORIGIN,
      session: newSession(),
      ledger: world.ledger,
      sleep: noSleep,
      ownsBrowser: true,
      recordVideoDir: dir,
    });
    await p.playFixture(job(FULL_MATCH));

    expect(world.record.contexts).toHaveLength(2); // organiser, scorer
    for (const c of world.record.contexts) expect(c.recordVideo).toEqual({ dir });
    await p.close();
  });

  it("renames the fixture's video and trace to a watchable name DERIVED from the job, never a literal", async () => {
    const dir = tmpCaptureDir();
    const world = fakeWorld();
    const p = createTapPlayer({
      browser: world.browser,
      loginUrl: LOGIN_URL,
      base: ORIGIN,
      session: newSession(),
      ledger: world.ledger,
      sleep: noSleep,
      ownsBrowser: true,
      recordVideoDir: dir,
      traceDir: dir,
    });
    const theJob = job(FULL_MATCH);
    const result = await p.playFixture(theJob);

    const expectedVideo = path.join(dir, tapVideoFileName(theJob));
    const expectedTrace = path.join(dir, tapTraceFileName(theJob));
    expect(result.videoPath).toBe(expectedVideo);
    expect(result.tracePath).toBe(expectedTrace);
    expect(existsSync(expectedVideo)).toBe(true);
    expect(existsSync(expectedTrace)).toBe(true);
    // Trace stops BEFORE the scorer context closes (the pairing `TapTracing`
    // documents) — proven by the recorded call, not just the file.
    expect(world.record.tracingStops.map((s) => s.path)).toContain(expectedTrace);

    await p.close();
  });

  it("the organiser side is named flat (organiser.webm/.zip), populated only once close() has finished", async () => {
    const dir = tmpCaptureDir();
    const world = fakeWorld();
    const p = createTapPlayer({
      browser: world.browser,
      loginUrl: LOGIN_URL,
      base: ORIGIN,
      session: newSession(),
      ledger: world.ledger,
      sleep: noSleep,
      ownsBrowser: true,
      recordVideoDir: dir,
      traceDir: dir,
    });
    await p.playFixture(job(FULL_MATCH));

    // Before close(): the organiser context is still open, nothing renamed yet.
    expect(p.artefacts?.()).toEqual({});

    await p.close();
    const expectedVideo = path.join(dir, ORGANISER_VIDEO_FILE_NAME);
    const expectedTrace = path.join(dir, ORGANISER_TRACE_FILE_NAME);
    expect(p.artefacts?.()).toEqual({ videoPath: expectedVideo, tracePath: expectedTrace });
    expect(existsSync(expectedVideo)).toBe(true);
    expect(existsSync(expectedTrace)).toBe(true);
  });

  it("leaves NO hash-named files behind — the throwaway login page's video is deleted, not renamed", async () => {
    const dir = tmpCaptureDir();
    const world = fakeWorld();
    const p = createTapPlayer({
      browser: world.browser,
      loginUrl: LOGIN_URL,
      base: ORIGIN,
      session: newSession(),
      ledger: world.ledger,
      sleep: noSleep,
      ownsBrowser: true,
      recordVideoDir: dir,
      traceDir: dir,
    });
    const theJob = job(FULL_MATCH);
    await p.playFixture(theJob);
    await p.close();

    // Exactly the four watchable names — a run that also leaves hash-named
    // files (the login page's own video, or an un-renamed fixture/organiser
    // one) has NOT met R86's bar.
    const names = readdirSync(dir).sort();
    expect(names).toEqual(
      [ORGANISER_TRACE_FILE_NAME, ORGANISER_VIDEO_FILE_NAME, tapTraceFileName(theJob), tapVideoFileName(theJob)].sort(),
    );
  });

  // Found by this task's own live proof (a real 4-fixture, 2-court `_tiny`
  // run): each fixture opens its OWN organiser page in the one shared
  // organiser context (`organiserContext().newPage()`), so a run of MORE
  // THAN ONE fixture opens more than one org page. Only the LAST one may
  // become `organiser.webm`; every earlier one is a leaked hash-named file
  // unless it is explicitly deleted once closed. A single-fixture test
  // (above) cannot see this — it never opens a second org page.
  it("leaves NO hash-named files behind across MULTIPLE fixtures — every organiser page but the last is deleted, not leaked", async () => {
    const dir = tmpCaptureDir();
    // A refused mint (402) is enough to open + close an org page without
    // ever needing a second full match on the shared fake ledger — isolates
    // the organiser-page bookkeeping from the scorer side entirely.
    const world = fakeWorld({ mintStatus: 402 });
    const p = createTapPlayer({
      browser: world.browser,
      loginUrl: LOGIN_URL,
      base: ORIGIN,
      session: newSession(),
      ledger: world.ledger,
      sleep: noSleep,
      ownsBrowser: true,
      recordVideoDir: dir,
      traceDir: dir,
    });
    const jobA = job(FULL_MATCH);
    const jobB = { ...job(FULL_MATCH), fixtureExtKey: "rr-r2-c1" };

    await p.playFixture(jobA);
    await p.playFixture(jobB);
    await p.close();

    const names = readdirSync(dir).sort();
    // The mutant this kills: tracking only the LAST org page (dropping the
    // array) leaves the FIRST fixture's org page video as a stray
    // `hash-N.webm` (this harness's stand-in for Playwright's real
    // `page@<hash>.webm`) once a second fixture opens a second org page.
    for (const name of names) expect(name).not.toMatch(/^hash-/);
    expect(names).toContain(ORGANISER_VIDEO_FILE_NAME);
    expect(names).toContain(ORGANISER_TRACE_FILE_NAME);
  });
});

// ---------------------------------------------------------------------------
// Task 10 fix round 1 (R59) — d-tiny's three frozen shapes, played through the
// REAL driver and the REAL adapter against the fake product above. Every one
// is judged by the driver's own exact, two-way payload comparison.
// ---------------------------------------------------------------------------
describe("R59 — the three d-tiny routes, played through the real driver (fix round 1)", () => {
  const payloadsOf = (world: ReturnType<typeof fakeWorld>, type: string) => world.rows.filter((r) => r.type === type).map((r) => r.payload);

  it("(a) a typed final score goes in through the score-entry sheet, home's number first, and lands exactly", async () => {
    const world = fakeWorld();
    const result = await player(world).playFixture(job([START, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }]));

    expect(result.findings).toEqual([]);
    expect(payloadsOf(world, "generic.result")).toEqual([{ p1Score: 3, p2Score: 1 }]);
    expect(world.statusNow()).toBe("finalized");
  });

  it("(b) a dock-amended score naming its scorer lands exactly — a sole on-field player is stamped by the pad itself", async () => {
    const world = fakeWorld({ roster: { home: ["p-home"], away: ["p-away"] } });
    const result = await player(world).playFixture(
      job([
        START,
        { type: "generic.score", payload: { by: "@home", points: 2, person: "p-home" } },
        { type: "generic.score", payload: { by: "@away", points: 1, person: "p-away" } },
        { type: "generic.score", payload: { by: "@away", points: 1, person: "p-away" } },
        { type: "generic.result", payload: {} },
      ]),
    );

    expect(result.findings).toEqual([]);
    expect(payloadsOf(world, "generic.score")).toEqual([
      { by: HOME, points: 2, person: "p-home" },
      { by: AWAY, points: 1, person: "p-away" },
      { by: AWAY, points: 1, person: "p-away" },
    ]);
    expect(world.statusNow()).toBe("finalized");
  });

  it("(b) on a side with more than one player, the named scorer is CHOSEN from the dock", async () => {
    const world = fakeWorld({ roster: { home: ["p-h1", "p-h2"] } });
    const result = await player(world).playFixture(
      job([START, { type: "generic.score", payload: { by: "@home", points: 3, person: "p-h2" } }, { type: "generic.result", payload: {} }]),
    );

    expect(result.findings).toEqual([]);
    expect(payloadsOf(world, "generic.score")).toEqual([{ by: HOME, points: 3, person: "p-h2" }]);
  });

  it("(b) a ONE-point score naming one of several players: the scorer is chosen only once that tap's dock is open", async () => {
    const world = fakeWorld({ roster: { away: ["p-a1", "p-a2"] } });
    const result = await player(world).playFixture(
      job([START, { type: "generic.score", payload: { by: "@away", points: 1, person: "p-a1" } }, { type: "generic.result", payload: {} }]),
    );

    expect(result.findings).toEqual([]);
    expect(payloadsOf(world, "generic.score")).toEqual([{ by: AWAY, points: 1, person: "p-a1" }]);
  });

  it("(b) two amended holds back to back: the second amount lands on the second hold, never on the first's stale dock", async () => {
    const world = fakeWorld();
    const result = await player(world).playFixture(
      job([
        START,
        { type: "generic.score", payload: { by: "@home", points: 2 } },
        { type: "generic.score", payload: { by: "@away", points: 3 } },
        { type: "generic.result", payload: {} },
      ]),
    );

    expect(result.findings).toEqual([]);
    expect(payloadsOf(world, "generic.score")).toEqual([
      { by: HOME, points: 2 },
      { by: AWAY, points: 3 },
    ]);
  });

  it("(b) with NO saved lineup the pad can neither stamp nor offer a scorer — the ledger comparison says so, it is not waved through", async () => {
    const world = fakeWorld();
    const result = await player(world).playFixture(
      job([START, { type: "generic.score", payload: { by: "@home", points: 2, person: "p-home" } }, { type: "generic.result", payload: {} }]),
    );

    expect(result.findings).toEqual([
      'ledger: event 1 (generic.score) — payload key "person" mismatch: the pack meant "p-home", the server recorded undefined',
    ]);
    expect(payloadsOf(world, "generic.score")).toEqual([{ by: HOME, points: 2 }]);
  });

  it("(c) a forfeit is an ORGANISER action on a freshly loaded console — toggle, side, typed reason, submit — and lands exactly", async () => {
    const world = fakeWorld();
    const result = await player(world).playFixture(job([START, { type: "core.forfeit", payload: { by: "@away", reason: "retired hurt" } }]));

    expect(result.findings).toEqual([]);
    expect(world.rows.map((r) => [r.type, r.payload])).toEqual([
      ["core.start", {}],
      ["core.forfeit", { by: AWAY, reason: "retired hurt" }],
      ["core.finalize", {}],
    ]);
    expect(world.statusNow()).toBe("finalized");
    const forfeitClicks = world.record.clicks.filter((c) => c.includes("score-forfeit") || c.includes("score-prompt"));
    expect(forfeitClicks).toEqual([
      'console [data-testid="score-forfeit"]',
      'console [data-testid="score-forfeit-away"]',
      'console [data-testid="score-prompt-submit"]',
    ]);
    // Once before the forfeit (the console was loaded before play), once before finalize.
    expect(world.record.reloads).toBeGreaterThanOrEqual(2);
  });

  it("(c) a hold still open on the pad is released BEFORE the organiser acts, so the rows land in pack order", async () => {
    const world = fakeWorld();
    const result = await player(world).playFixture(
      job([
        START,
        { type: "generic.score", payload: { by: "@home", points: 2 } },
        { type: "core.forfeit", payload: { by: "@away", reason: "retired hurt" } },
      ]),
    );

    expect(result.findings).toEqual([]);
    expect(world.rows.map((r) => r.type)).toEqual(["core.start", "generic.score", "core.forfeit", "core.finalize"]);
  });
});
