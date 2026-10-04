// The browser run's wiring (W1c Task 6), against a structural fake browser:
// one context per case on the runner's own session jar and width, a
// BrowserDriver on it, every close exactly once, and a context whose driver
// cannot be built closed before the error leaves. The launch itself is
// proven live (Task 8).
import { describe, expect, it } from "vitest";
import type { Session } from "../../../scripts/bench/lib/http.ts";
import { FLOOR_MS, HOLD_ENV, HOLD_MS_DEFAULT, SLACK_MS, TAP_PACE_MS } from "../lib/browser/budget.ts";
import { BrowserRunClosed, REAL_RUN_DEPS, openBrowserRun, type BrowserRunDeps, type CaseOptions } from "../lib/browser/browser-run.ts";
import { HoldMismatch, ServedHoldUnreadable, readServedHold } from "../lib/browser/served-hold.ts";
import type { CaseBrowser } from "../lib/browser/session.ts";
import { BrowserDriver, EMPTY_PADS, REAL_PAGES } from "../lib/driver/browser-driver.ts";
import { PAD_ADAPTERS } from "../lib/pads/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";

const BASE = "http://localhost:3999";

interface Fake { deps: BrowserRunDeps; log: string[]; asked: { base: string; cookies: Readonly<Record<string, string>>; width: number }[]; defaults: number[] }
/** `served`: what the served build's chunk says (servedHold); `env`: the shell. */
function fake(o: { pageThrows?: boolean; served?: number; env?: Readonly<Record<string, string>> } = {}): Fake {
  const log: string[] = [];
  const asked: Fake["asked"] = [];
  const defaults: number[] = [];
  let n = 0;
  const deps: BrowserRunDeps = {
    servedHold: async (base) => { log.push(`served-hold ${base}`); return { holdMs: o.served ?? HOLD_MS_DEFAULT, found: 1, scanned: 1 }; },
    launch: async () => { log.push("launch"); return { close: async () => { log.push("browser closed"); } }; },
    newCase: async (_b, co) => {
      asked.push(co);
      const id = ++n;
      log.push(`context ${id}`);
      const page = { setDefaultTimeout: (ms: number) => { if (o.pageThrows) throw new Error("page gone"); defaults.push(ms); } };
      return { page: page as unknown as CaseBrowser["page"], close: async () => { log.push(`context ${id} closed`); } };
    },
    env: o.env ?? {},
    pads: EMPTY_PADS,
  };
  return { deps, log, asked, defaults };
}

const session: Session = { cookies: { seazn_session: "s", seazn_org: "o" } };
const spec: CaseSpec = { caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false };
const opts = (over: Partial<CaseOptions> = {}): CaseOptions =>
  ({ base: "http://localhost:3999", session, orgId: "org-1", orgSlug: "m-r-1", spec, width: 320, padPolicy: "first", reportDir: "/report/run", evidenceId: "case-1", ...over });

describe("openBrowserRun", () => {
  it("a real run scores on every registered pad adapter (W1c Task 7), through the real page objects and the process env", () => {
    expect(Object.keys(PAD_ADAPTERS).length).toBeGreaterThan(0);
    expect(REAL_RUN_DEPS.pads).toBe(PAD_ADAPTERS);
    expect(REAL_RUN_DEPS.pages).toBe(REAL_PAGES);
    expect(REAL_RUN_DEPS.env).toBe(process.env);
    // Carry M-6: a real run reads the SERVED build's hold window.
    expect(REAL_RUN_DEPS.servedHold).toBe(readServedHold);
  });

  it("carry M-6: a served build whose hold window is not the shell's is refused by name BEFORE the browser launches", async () => {
    const f = fake({ served: HOLD_MS_DEFAULT, env: { [HOLD_ENV]: "3000" } });
    const e = await openBrowserRun(BASE, f.deps).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(HoldMismatch);
    expect(e).toMatchObject({ served: HOLD_MS_DEFAULT, shell: 3000 });
    // Read on the run's own base, and nothing opened.
    expect(f.log).toEqual([`served-hold ${BASE}`]);
  });

  it("carry M-6: a served hold that cannot be read aborts before the launch, with its own error", async () => {
    const f = fake();
    const deps: BrowserRunDeps = { ...f.deps, servedHold: async () => { throw new ServedHoldUnreadable("scanned 3 chunk(s), found 0 carrying the resolver"); } };
    await expect(openBrowserRun(BASE, deps)).rejects.toThrow(ServedHoldUnreadable);
    expect(f.log).toEqual([]);
  });

  it("carry M-6: an equal window opens the run, once, on the run's base (the other direction: a matching shell is not refused)", async () => {
    const f = fake({ served: 3000, env: { [HOLD_ENV]: "3000" } });
    const run = await openBrowserRun(BASE, f.deps);
    await run.caseDriver(opts());
    expect(f.log).toEqual([`served-hold ${BASE}`, "launch", "context 1"]);
  });

  it("each case gets its own context on the runner's session jar and width, and a BrowserDriver whose page is bounded (ruling F)", async () => {
    const f = fake();
    const run = await openBrowserRun(BASE, f.deps);
    const a = await run.caseDriver(opts());
    const b = await run.caseDriver(opts({ width: 1280, evidenceId: "case-2" }));
    expect(a.driver).toBeInstanceOf(BrowserDriver);
    expect(b.driver).not.toBe(a.driver);
    expect(f.asked.map((x) => x.width)).toEqual([320, 1280]);
    // The same jar — the org cookie the runner's switch set rides into the context.
    expect(f.asked.every((x) => x.cookies === session.cookies)).toBe(true);
    expect(f.asked.map((x) => x.base)).toEqual(["http://localhost:3999", "http://localhost:3999"]);
    expect(f.defaults).toEqual([Math.max(FLOOR_MS, TAP_PACE_MS + SLACK_MS), Math.max(FLOOR_MS, TAP_PACE_MS + SLACK_MS)]);
    // Empty case: a driver that has done nothing reports its vacuous coverage.
    expect(a.driver.checks().find((c) => c.id === "mixed-driver-coverage")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(f.log).toEqual([`served-hold ${BASE}`, "launch", "context 1", "context 2"]);
  });

  it("every close runs once: a case's context, then the browser; a closed run opens no more contexts", async () => {
    const f = fake();
    const run = await openBrowserRun(BASE, f.deps);
    const a = await run.caseDriver(opts());
    await a.close();
    await a.close();
    await run.close();
    await run.close();
    expect(f.log).toEqual([`served-hold ${BASE}`, "launch", "context 1", "context 1 closed", "browser closed"]);
    await expect(run.caseDriver(opts())).rejects.toThrow(BrowserRunClosed);
    expect(f.log.filter((l) => l.startsWith("context"))).toHaveLength(2);
  });

  it("a context whose driver cannot be built is closed before the error leaves", async () => {
    const f = fake({ pageThrows: true });
    const run = await openBrowserRun(BASE, f.deps);
    await expect(run.caseDriver(opts())).rejects.toThrow(/page gone/);
    expect(f.log).toEqual([`served-hold ${BASE}`, "launch", "context 1", "context 1 closed"]);
  });

  it("a launch that fails leaves nothing open and rejects with the launch's error", async () => {
    const f = fake();
    const deps: BrowserRunDeps = { ...f.deps, launch: async () => { throw new Error("browserType.launch: Executable doesn't exist"); } };
    await expect(openBrowserRun(BASE, deps)).rejects.toThrow(/Executable doesn't exist/);
    expect(f.log).toEqual([`served-hold ${BASE}`]);
  });
});
