// The "Needs a decision" page object (W2a Task 14 Step 6; plan Task 11): what a browser is not needed to prove. The
// flow it drives is the plan's description of loop H's console — NEVER recorded from the real one (H does not exist
// yet), so the drive is Step 8's proof and the pin test below is red until H lands, by name.
//
// Expected values come from the plan's frozen testids and the engine's own SETTLE_METHODS, never from the page object.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTLE_METHODS } from "@seazn/engine/core";
import { describe, expect, it, vi } from "vitest";
import { Evidence, type EvidenceFs } from "../lib/browser/evidence.ts";
import { ScreenNeverShowed, type PageCtx } from "../lib/browser/pages/ctx.ts";
import { NEEDS_DECISION, NEEDS_DECISION_PINS, NeedsDecisionPage, SettleNeedsAWinner, UnknownSettleMethod, settleUi } from "../lib/browser/pages/needs-decision.ts";
import { NoProductResponse } from "../lib/browser/respond.ts";
import { RefusedCall } from "../lib/driver/types.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const reactDomClient = "apps/web/node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js";
const PRODUCT_PROPS_KEY = /\binternalPropsKey = "([^"]+)" \+ randomKey/.exec(src(reactDomClient))?.[1] ?? "(React's props key: unread)";
const BASE = "http://localhost:3999";
const FIXTURE = "fx-1";

interface Resp { request(): { method(): string }; url(): string; status(): number; json(): Promise<unknown> }
type W = { pred: (r: Resp) => boolean; resolve: (r: Resp) => void; timer: ReturnType<typeof setTimeout> };

/** A held console: the block is there (or not), every tap is logged, and the confirm answers the events route as
 *  `answer` says. `stuck` keeps the block on screen after the confirm (the screen did not change). */
function heldConsole(o: { held?: boolean; stuck?: boolean; answer?: { status: number; body: unknown }; eventsOf?: string } = {}) {
  const log: string[] = [];
  const waiters: W[] = [];
  const emit = (r: Resp) => { for (const w of [...waiters]) if (w.pred(r)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(r); } };
  const answer = o.answer ?? { status: 200, body: { ok: true, data: { seq: 4, status: "decided", outcome: null, event_id: "ev-4" } } };
  let shots = 0;
  const loc = (d: string) => ({
    d,
    first: () => loc(d),
    waitFor: async (w?: { state?: string }) => {
      log.push(`wait ${w?.state} ${d}`);
      const absent = o.held === false && d === `testid:${NEEDS_DECISION.block}` && w?.state !== "detached";
      const stillThere = o.stuck === true && d === `testid:${NEEDS_DECISION.block}` && w?.state === "detached";
      if (absent || stillThere) { const e = new Error("locator.waitFor: Timeout exceeded"); e.name = "TimeoutError"; throw e; }
    },
    elementHandles: async () => [{ d, isConnected: true, [`${PRODUCT_PROPS_KEY}b1`]: {}, dispose: async () => undefined }],
    click: async () => {
      log.push(`click ${d}`);
      if (d === `testid:${NEEDS_DECISION.confirm}`) {
        emit({ request: () => ({ method: () => "POST" }), url: () => `${BASE}/api/v1/fixtures/${o.eventsOf ?? FIXTURE}/events`, status: () => answer.status, json: () => Promise.resolve(answer.body) });
      }
    },
    check: async () => { log.push(`check ${d}`); },
    fill: async (v: string) => { log.push(`fill ${d}=${v}`); },
  });
  const page = {
    reload: async () => { log.push("reload"); },
    getByTestId: (id: string) => loc(`testid:${id}`),
    waitForResponse: (pred: (r: Resp) => boolean, t: { timeout: number }): Promise<Resp> => new Promise((resolveW, reject) => {
      const w: W = { pred, resolve: resolveW, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); const e = new Error("Timeout"); e.name = "TimeoutError"; reject(e); }, t.timeout) };
      waiters.push(w);
    }),
    waitForFunction: async (fn: (a: unknown) => unknown, arg: unknown) => ({ jsonValue: async () => fn(arg), dispose: async () => undefined }),
    evaluate: async () => ({ scrollWidth: 1280, clientWidth: 1280 }),
    screenshot: async () => new TextEncoder().encode(`screen ${shots++}`),
  };
  const files = new Map<string, Uint8Array>();
  const fs: EvidenceFs = {
    mkdir: () => undefined,
    writeFile: (p, data) => { log.push(`shot ${p.split("/").pop()!.replace(/\.png$/, "")}`); files.set(p, data); },
    readFile: (p) => { const f = files.get(p); if (f === undefined) throw new Error(`ENOENT ${p}`); return f; },
  };
  const evidence = new Evidence("/r", "case-1", fs);
  const ctx = { page: page as unknown as PageCtx["page"], base: BASE, orgSlug: "org", holdMs: 3000, evidence };
  return { ctx, log, evidence, ui: new NeedsDecisionPage(ctx, FIXTURE) };
}
const tid = (id: string) => `testid:${id}`;

describe("NeedsDecisionPage: the block and the settle dialog (plan Task 11's frozen testids)", () => {
  it("the testids are the plan's, character for character (the frozen contract loop H builds to)", () => {
    expect(NEEDS_DECISION).toEqual({
      block: "needs-decision", open: "settle-open", winnerPrefix: "settle-winner-", methodPrefix: "settle-method-",
      note: "settle-note", confirm: "settle-confirm", error: "settle-error",
    });
  });

  it("settle: reloads first, waits for the block, opens the dialog, picks the winner then the method, pictures before, confirms, takes the product's answer, waits for the block to go, pictures after", async () => {
    const g = heldConsole();
    const posted = await g.ui.settle("e-7", "lot");
    expect(posted).toMatchObject({ seq: 4, event_id: "ev-4" });
    expect(g.log).toEqual([
      "reload",
      `wait attached ${tid("needs-decision")}`,
      `wait visible ${tid("needs-decision")}`,
      `click ${tid("settle-open")}`,
      `click ${tid("settle-winner-e-7")}`,
      `check ${tid("settle-method-lot")}`,
      "shot 11-settle-before",
      `click ${tid("settle-confirm")}`,
      `wait detached ${tid("needs-decision")}`,
      "shot 11-settle",
    ]);
    expect(g.evidence.checks().find((c) => c.id === "visual-evidence")).toMatchObject({ verdict: "pass", checked: 2 });
  });

  it("a note is written before the confirm and only when given", async () => {
    const withNote = heldConsole();
    await withNote.ui.settle("e-7", "organiser", "referee's call");
    const at = (l: string) => withNote.log.indexOf(l);
    expect(at(`fill ${tid("settle-note")}=referee's call`)).toBeGreaterThan(at(`check ${tid("settle-method-organiser")}`));
    expect(at(`fill ${tid("settle-note")}=referee's call`)).toBeLessThan(at(`click ${tid("settle-confirm")}`));
    const without = heldConsole();
    await without.ui.settle("e-7", "organiser");
    expect(without.log.some((l) => l.startsWith("fill "))).toBe(false);
  });

  it("settleUi is the page object as the driver's seam takes it: the same flow for the same fixture, with the winner, method and note it was given", async () => {
    const g = heldConsole();
    const posted = await settleUi(g.ctx, FIXTURE, "e-7", "higher_seed", "by seed");
    expect(posted).toMatchObject({ seq: 4, event_id: "ev-4" });
    expect(g.log).toContain(`click ${tid("settle-winner-e-7")}`);
    expect(g.log).toContain(`check ${tid("settle-method-higher_seed")}`);
    expect(g.log).toContain(`fill ${tid("settle-note")}=by seed`);
  });

  it("settleUi waits for the answer of the fixture it was GIVEN: the seam passes the fixture id through, so the answer it returns is that fixture's and another's is NoProductResponse", async () => {
    // The product answers fx-2's events route only. Given fx-2 the seam returns that answer (the awaited value, not a
    // log of taps); given the fixture the console was opened on, nothing it waits for ever arrives.
    const asked = heldConsole({ eventsOf: "fx-2", answer: { status: 200, body: { ok: true, data: { seq: 9, status: "decided", outcome: null, event_id: "ev-9" } } } });
    const posted = await settleUi(asked.ctx, "fx-2", "e-7", "lot");
    expect(posted).toMatchObject({ seq: 9, event_id: "ev-9" });
    const wrong = heldConsole({ eventsOf: "fx-2" });
    vi.useFakeTimers();
    try {
      const settled = settleUi(wrong.ctx, FIXTURE, "e-7", "lot").then(() => null, (x: unknown) => x);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await settled).toBeInstanceOf(NoProductResponse);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every method the ENGINE declares has its radio, and the winner button is keyed by the entrant asked for", async () => {
    let driven = 0;
    for (const method of SETTLE_METHODS) {
      const g = heldConsole();
      await g.ui.settle(`entrant-${method}`, method);
      expect(g.log, method).toContain(`check ${tid(`settle-method-${method}`)}`);
      expect(g.log, method).toContain(`click ${tid(`settle-winner-entrant-${method}`)}`);
      driven++;
    }
    expect(driven).toBe(SETTLE_METHODS.length);
    expect(driven).toBeGreaterThan(0);
  });

  it("a method the engine does not declare, or no winner, is refused by name before any tap", async () => {
    const g = heldConsole();
    await expect(g.ui.settle("e-7", "coin_toss" as never)).rejects.toBeInstanceOf(UnknownSettleMethod);
    await expect(g.ui.settle("", "lot")).rejects.toBeInstanceOf(SettleNeedsAWinner);
    expect(g.log, "nothing was touched").toEqual([]);
  });

  it("the product's refusal (the match is no longer held) is the RefusedCall it answered, with its code, and no 'after' picture", async () => {
    const g = heldConsole({ answer: { status: 409, body: { ok: false, error: { code: "SETTLE_NOT_APPLICABLE", message: "This match is not waiting for a decision" } } } });
    const e = await g.ui.settle("e-7", "lot").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect(e).toMatchObject({ status: 409, code: "SETTLE_NOT_APPLICABLE" });
    expect(g.log.includes("shot 11-settle")).toBe(false);
    expect(g.log.some((l) => l.startsWith("wait detached"))).toBe(false);
  });

  it("another fixture's events answer is not this settle's: no answer for THIS fixture is NoProductResponse, not a pass", async () => {
    const g = heldConsole({ eventsOf: "fx-other" });
    vi.useFakeTimers(); // the wait is the page object's real budget; the clock is the test's
    try {
      const settled = g.ui.settle("e-7", "lot").then(() => null, (x: unknown) => x);
      await vi.advanceTimersByTimeAsync(300_000);
      const e = await settled;
      expect(e).toBeInstanceOf(NoProductResponse);
      expect(e).toMatchObject({ reason: "no-response" });
      expect(g.log.includes("shot 11-settle")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a console with no block (the match is not held) is ScreenNeverShowed, never a tap on nothing", async () => {
    const g = heldConsole({ held: false });
    await expect(g.ui.settle("e-7", "lot")).rejects.toBeInstanceOf(ScreenNeverShowed);
    expect(g.log.some((l) => l.startsWith("click"))).toBe(false);
  });

  it("a block that is still on screen after the settle is ScreenNeverShowed (the screen did not change), not a pass", async () => {
    const g = heldConsole({ stuck: true });
    await expect(g.ui.settle("e-7", "lot")).rejects.toBeInstanceOf(ScreenNeverShowed);
  });

  it("pins (loop H writes needs-decision.tsx; RED UNTIL IT LANDS): every testid appears in the file that renders it", () => {
    let checked = 0;
    const file = NEEDS_DECISION_PINS[0]!.file;
    const text = src(file);
    for (const p of NEEDS_DECISION_PINS) {
      expect(text, `${file} does not render '${p.needle}' (${p.name})`).toContain(p.needle);
      checked++;
    }
    expect(checked).toBe(Object.keys(NEEDS_DECISION).length);
  });
});
