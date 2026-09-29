// A browser run (W1c Task 6): one chromium per run, one context and one
// BrowserDriver per case. run.ts loads this module LAZILY — a dynamic import
// in realDeps.openBrowserRun — so an L3 run never loads the browser layer
// (boundary.test.ts pins that dynamic edge as the only one into lib/browser).
//
// Its shapes are run.ts's BrowserRun / CaseDriverOptions, met structurally:
// this module never imports the runner.
import type { Browser } from "playwright";
import type { Session } from "../../../bench/lib/http.ts";
import { BrowserDriver, EMPTY_PADS, REAL_PAGES, type BrowserPages, type PadRegistry } from "../driver/browser-driver.ts";
import { HttpDriver, type Transport } from "../driver/http-driver.ts";
import type { PadPolicy } from "../driver/mixed.ts";
import type { CaseSpec } from "../scenarios/types.ts";
import type { BrowserWidth } from "../widths.ts";
import { holdMsFromEnv } from "./budget.ts";
import { Evidence } from "./evidence.ts";
import type { PageCtx } from "./pages/ctx.ts";
import { newCaseBrowser, openBrowser, type CaseBrowser } from "./session.ts";

export interface CaseOptions {
  base: string;
  session: Session;
  orgId: string;
  orgSlug: string;
  spec: CaseSpec;
  width: BrowserWidth;
  padPolicy: PadPolicy;
  /** The run's report directory: the case's shots go to <reportDir>/shots/<evidenceId>. */
  reportDir: string;
  evidenceId: string;
}

export interface CaseDriver { driver: BrowserDriver; close(): Promise<void> }
export interface OpenBrowserRun { caseDriver(o: CaseOptions): Promise<CaseDriver>; close(): Promise<void> }

/** The seams a browser run is built from; the unit suite fakes them. */
export interface BrowserRunDeps {
  launch(): Promise<Pick<Browser, "close">>;
  newCase(browser: Pick<Browser, "close">, o: { base: string; cookies: Readonly<Record<string, string>>; width: BrowserWidth }): Promise<CaseBrowser>;
  /** Where the build's hold window is read from (holdMsFromEnv). */
  env: Readonly<Record<string, string | undefined>>;
  pads: PadRegistry;
  /** The page objects (REAL_PAGES) and the HTTP side's transport (bench's raw
   *  when absent): the page/wire boundary a runner-level test fakes, so the
   *  wiring from the runner's case options to each driver runs for real (I-3). */
  pages?: BrowserPages;
  transport?: Transport;
}

const REAL: BrowserRunDeps = {
  launch: openBrowser,
  newCase: (browser, o) => newCaseBrowser(browser as Browser, o),
  env: process.env,
  pads: EMPTY_PADS,
  pages: REAL_PAGES,
};

export class BrowserRunClosed extends Error {
  constructor() {
    super("browser: this run's browser is already closed — no case can open a context on it");
    this.name = "BrowserRunClosed";
  }
}

/** Launches the run's browser. Each case gets a fresh context on the SAME
 *  session jar as the runner (its org cookie included), its width, and a
 *  BrowserDriver over a fresh HttpDriver on that session. A case whose
 *  driver cannot be built closes its context before the error leaves. */
export async function openBrowserRun(deps: BrowserRunDeps = REAL): Promise<OpenBrowserRun> {
  const browser = await deps.launch();
  let closed = false;
  return {
    async caseDriver(o) {
      if (closed) throw new BrowserRunClosed();
      const cb = await deps.newCase(browser, { base: o.base, cookies: o.session.cookies, width: o.width });
      try {
        const ctx: PageCtx = { page: cb.page, base: o.base, orgSlug: o.orgSlug, holdMs: holdMsFromEnv(deps.env), evidence: new Evidence(o.reportDir, o.evidenceId) };
        const http = new HttpDriver({ base: o.base, session: o.session, expectedOrgId: o.orgId, ...(deps.transport === undefined ? {} : { transport: deps.transport }) });
        const driver = new BrowserDriver({ http, ctx, spec: o.spec, padPolicy: o.padPolicy, pads: deps.pads, orgId: o.orgId, pages: deps.pages ?? REAL_PAGES });
        let done = false;
        return {
          driver,
          close: async () => {
            if (done) return;
            done = true;
            await cb.close();
          },
        };
      } catch (e) {
        await cb.close().catch(() => undefined);
        throw e;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
    },
  };
}
