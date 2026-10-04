// The runSlice test seams, shared (W1d Task 3, ruling T2-HELPERS): the fake
// RunDeps and the fake browser run that run-cli.test.ts built, hoisted out of
// it before a third file copied them (run-planned-marker.test.ts was the
// second copy). Every test that drives `runSlice` through the REAL runner
// builds its seams here, so a change to RunDeps is one edit.
// The fakes below implement RunDeps' and BrowserRun's promise-returning seams
// with no await of their own (a fake has nothing to wait for).
/* eslint-disable @typescript-eslint/require-await */
import { ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import type { FillerName } from "../lib/fillers.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import type { CheckResult } from "../lib/results.ts";
import type { BrowserRun, CaseDriverOptions, RunDeps } from "../run.ts";
import type { Session } from "../../bench/lib/http.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

type PrepareCtx = Parameters<RunDeps["prepareCaseOrg"]>[0];
export interface DriverCall { base: string; session: Session; orgId: string; driver: FakeLeagueDriver }
export type PrepareInput = Parameters<RunDeps["prepareCaseOrg"]>[1];
export type Deps = RunDeps & { order: string[]; orgs: PrepareInput[]; ctxs: PrepareCtx[]; emails: string[]; drivers: DriverCall[]; session: Session; planReads: string[] };

/** Every format gate the product declares, derived from the catalogue through the
 *  text-pinned gate map: the fake plan grants all of them unless a test says otherwise. */
export const ALL_GATES: readonly string[] = [...new Set(ROW_KEYS.flatMap((r) => { const g = expectedGate(stagesForRow(r)); return g === null ? [] : [g]; }))];

/** Every case gets its OWN org id (`org-<slug>`), and driverFor records what it
 *  was handed — so a stale, constant or empty org id cannot pass unseen.
 *  `failOrgAt`: the 1-based case whose org provision throws, so the case ends red. */
export function deps(over: Partial<RunDeps> = {}, o: { failOrgAt?: number } = {}): Deps {
  const order: string[] = [];
  const orgs: PrepareInput[] = [];
  const ctxs: PrepareCtx[] = [];
  const emails: string[] = [];
  const drivers: DriverCall[] = [];
  const session: Session = { cookies: {} };
  const planReads: string[] = [];
  const d: Deps = {
    order,
    orgs,
    ctxs,
    emails,
    drivers,
    session,
    planReads,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => { order.push("preflight"); return { ok: true, refusals: [] }; },
    openDb: async () => { order.push("openDb"); return {
      userIdForEmail: async (e: string) => { emails.push(`db ${e}`); return "u1"; },
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      planGrants: async (k: string) => { planReads.push(k); return [...ALL_GATES]; },
      planLimit: async () => null,
      dispose: async () => { order.push("dispose"); },
    }; },
    signIn: async (_b, e) => { order.push("signIn"); emails.push(`signIn ${e}`); return session; },
    prepareCaseOrg: async (ctx, i) => {
      orgs.push(i);
      ctxs.push(ctx);
      if (o.failOrgAt === orgs.length) throw new Error("org provision refused");
      return { orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [...(i.deny ?? [])] };
    },
    driverFor: (base, s, orgId) => { const driver = new FakeLeagueDriver(orgId); drivers.push({ base, session: s, orgId, driver }); return driver; },
    render: renderMatrix,
    ...over,
  };
  return d;
}

export interface FakeBrowserRun { run: BrowserRun; log: string[]; opts: CaseDriverOptions[]; opened: () => number }
/** A browser run whose case drivers are league fakes carrying one check of their own.
 *  `checksThrow`: reading the driver's checks throws (fix round 1, M-2).
 *  `fillersAt(i)`: what the i-th (0-based) case's driver reports as its setup
 *  filler — and only once it has made a call, so a read taken before the
 *  scenario ran (a stale read) sees nothing, exactly like the real ledger that
 *  BrowserDriver.fillers reads. Absent: the driver reports no `fillers` at all. */
export function fakeBrowserRun(o: { failCaseAt?: number; checksThrow?: boolean; fillersAt?: (i: number) => Readonly<Partial<Record<FillerName, number>>> } = {}): FakeBrowserRun {
  const log: string[] = [];
  const opts: CaseDriverOptions[] = [];
  const run: BrowserRun = {
    caseDriver: async (co) => {
      opts.push(co);
      if (o.failCaseAt === opts.length) throw new Error("browser: newContext refused");
      log.push(`open ${co.evidenceId}`);
      const i = opts.length - 1;
      const driver = Object.assign(new FakeLeagueDriver(co.orgId), {
        checks: (): CheckResult[] => {
          if (o.checksThrow) throw new Error("checks unreadable");
          return [{ id: "browser-probe", kind: "assertion", verdict: "pass", checked: 1, reason: `driver of ${co.evidenceId}`, evidence: [] }];
        },
      });
      const fillersAt = o.fillersAt;
      if (fillersAt !== undefined) Object.defineProperty(driver, "fillers", { get: () => (driver.callCount > 0 ? fillersAt(i) : {}) });
      return { driver, close: async () => { log.push(`close ${co.evidenceId}`); } };
    },
    close: async () => { log.push("run closed"); },
  };
  return { run, log, opts, opened: () => opts.length };
}
