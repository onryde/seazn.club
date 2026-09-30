// The served build's hold window (W1c Task 8, carry M-6). Every browser budget
// is priced in HOLD_MS (class 20), and the harness reads HOLD_MS from its own
// shell (holdMsFromEnv). Nothing tied that to the value the SERVED bundle was
// baked with: a shell of 3000 against a build left at the default 10000 would
// under-budget every held tap by 7 s, and the timeout would read as a product
// NoProductResponse. So a browser run reads the value out of the served
// client chunk, and refuses a mismatch by name before any case runs.
//
// Expected values come from the product: its own resolveHoldMs is the oracle
// for what a literal resolves to, and the excerpt below is a real observation
// of a served chunk, never text generated from served-hold.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOLD_MS_DEFAULT as PRODUCT_DEFAULT, resolveHoldMs } from "../../../apps/web/src/components/v2/scorepad/queue.ts";
import { HOLD_ENV } from "../lib/browser/budget.ts";
import {
  HOLD_PROBE_PATH, HoldMismatch, ServedHoldUnreadable, assertHoldMatches, readServedHold, servedHoldFrom, type FetchText,
} from "../lib/browser/served-hold.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

/** OBSERVED 2026-09-30, W1c Task 8: `GET /_next/static/chunks/0-k87zb4klkbk.js`
 *  from the prod server seazn-env `w1ct8` (BUILD_ID ie9TXHOYm3KQV2q_VLwjC,
 *  built with NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000). The build inlines the env
 *  value as the string argument of queue.ts's resolveHoldMs, which the
 *  minifier turned into an immediately-applied function. */
const OBSERVED = 'let ut=function(e){if(void 0===e||""===e.trim())return 1e4;let t=Number(e);return!Number.isFinite(t)||t<500?1e4:t}("3000"),un=new WeakMap;';

/** The same observed function, applied to another argument text. */
const applied = (arg: string, fn = OBSERVED) => fn.replace('("3000")', `(${arg})`);
const chunk = (text: string, url = "/_next/static/chunks/a.js") => ({ url, text });

describe("servedHoldFrom: the hold window a served chunk was baked with", () => {
  it("reads the observed chunk as 3000, and reports what it scanned", () => {
    expect(servedHoldFrom([chunk(OBSERVED)])).toEqual({ holdMs: resolveHoldMs("3000"), found: 1, scanned: 1 });
  });

  it("a string literal resolves exactly as the product's resolveHoldMs does (blank, non-numeric, below the floor → the default)", () => {
    const literals = ["3000", "2500", "", " ", "abc", "499", "500", "12000.5"];
    for (const raw of literals) expect(servedHoldFrom([chunk(applied(JSON.stringify(raw)))]).holdMs).toBe(resolveHoldMs(raw));
    // single quotes are the same literal
    expect(servedHoldFrom([chunk(applied("'2500'"))]).holdMs).toBe(resolveHoldMs("2500"));
    // One case where the wrong answer (the default) differs from the right one.
    expect(resolveHoldMs("2500")).not.toBe(PRODUCT_DEFAULT);
    expect(literals.length).toBe(8);
  });

  it("an env left unset at build (the argument is undefined) is the product's default", () => {
    for (const arg of ["void 0", "undefined"]) expect(servedHoldFrom([chunk(applied(arg))]).holdMs).toBe(resolveHoldMs(undefined));
  });

  it("minified names do not matter: another identifier set, `$` included, reads the same", () => {
    const renamed = 'var $a=function(n){if(void 0===n||""===n.trim())return 1e4;let $r=Number(n);return!Number.isFinite($r)||$r<500?1e4:$r}("2500");';
    expect(servedHoldFrom([chunk(renamed)]).holdMs).toBe(2500);
  });

  it("an argument the harness cannot evaluate is refused by name, quoting it — never guessed as the default", () => {
    const e = (() => { try { servedHoldFrom([chunk(applied("n.env.NEXT_PUBLIC_SCOREPAD_HOLD_MS"))]); } catch (x) { return x; } return null; })();
    expect(e).toBeInstanceOf(ServedHoldUnreadable);
    expect(String((e as Error).message)).toContain("n.env.NEXT_PUBLIC_SCOREPAD_HOLD_MS");
  });

  it("empty cases: no chunk at all, or chunks none of which carries the resolver, are refused (zero checked is a failure)", () => {
    expect(() => servedHoldFrom([])).toThrow(ServedHoldUnreadable);
    expect(() => servedHoldFrom([chunk("let a=1;"), chunk("function b(){}")])).toThrow(/scanned 2 chunk\(s\), found 0/);
  });

  it("the resolver in two chunks agreeing is one value; disagreeing is refused as ambiguous", () => {
    expect(servedHoldFrom([chunk(OBSERVED, "/a.js"), chunk(OBSERVED, "/b.js")])).toEqual({ holdMs: 3000, found: 2, scanned: 2 });
    expect(() => servedHoldFrom([chunk(OBSERVED, "/a.js"), chunk(applied('"2500"'), "/b.js")])).toThrow(/3000.*2500|2500.*3000/);
  });

  it("a resolver whose constants are not the product's (default, floor) is refused: its rule is not the one holdMsFromEnv mirrors", () => {
    expect(() => servedHoldFrom([chunk(OBSERVED.replace("t<500", "t<700"))])).toThrow(ServedHoldUnreadable);
    expect(() => servedHoldFrom([chunk(OBSERVED.replace("return 1e4;", "return 2e4;"))])).toThrow(ServedHoldUnreadable);
    expect(() => servedHoldFrom([chunk(OBSERVED.replace("?1e4:t", "?2e4:t"))])).toThrow(ServedHoldUnreadable);
  });

  it("the product's resolveHoldMs still has the shape the reader keys on (a text pin: a rewrite moves this test before a live run)", () => {
    const q = src("apps/web/src/components/v2/scorepad/queue.ts");
    const body = q.slice(q.indexOf("export function resolveHoldMs"), q.indexOf("export const HOLD_MS ="));
    expect(body).toMatch(/raw === undefined \|\| raw\.trim\(\) === ""\) return HOLD_MS_DEFAULT;/);
    expect(body).toMatch(/const parsed = Number\(raw\);/);
    expect(body).toMatch(/!Number\.isFinite\(parsed\) \|\| parsed < MIN_HOLD_MS\) return HOLD_MS_DEFAULT;/);
    expect(q).toMatch(new RegExp(`export const HOLD_MS = resolveHoldMs\\(process\\.env\\.${HOLD_ENV}\\);`));
  });
});

/** A fake wire: path → {status, text}. Records every url asked. */
function wire(pages: Record<string, { status: number; text: string }>): { fetchText: FetchText; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchText: async (url) => {
      asked.push(url);
      const p = pages[new URL(url).pathname];
      return p ?? { status: 404, text: "" };
    },
  };
}
const BASE = "http://localhost:3999";
const html = (...srcs: string[]) => `<!DOCTYPE html><html><head>${srcs.map((s) => `<script src="${s}" async=""></script>`).join("")}</head><body>dead link</body></html>`;

describe("readServedHold: the probe page's chunks, fetched from the server under test", () => {
  it("the probe is the device-link page for a dead token, which loads the scoring pad's chunks (text pin on the route)", () => {
    expect(HOLD_PROBE_PATH).toMatch(/^\/score\/[^/]+$/);
    const page = src("apps/web/src/app/score/[token]/page.tsx");
    expect(page).toMatch(/import \{[^}]*DeviceScorePad[^}]*\} from "@\/components\/v2\/device-score-pad";/);
    expect(page).toMatch(/return <DeadLink /);
  });

  it("fetches the probe page on the run's base, then each distinct chunk it loads, and reads the value", async () => {
    const w = wire({
      [HOLD_PROBE_PATH]: { status: 200, text: html("/_next/static/chunks/a.js", "/_next/static/chunks/pad.js", "/_next/static/chunks/a.js") },
      "/_next/static/chunks/a.js": { status: 200, text: "let a=1;" },
      "/_next/static/chunks/pad.js": { status: 200, text: OBSERVED },
    });
    expect(await readServedHold(BASE, w.fetchText)).toEqual({ holdMs: 3000, found: 1, scanned: 2 });
    expect(w.asked).toEqual([`${BASE}${HOLD_PROBE_PATH}`, `${BASE}/_next/static/chunks/a.js`, `${BASE}/_next/static/chunks/pad.js`]);
  });

  it("a probe page that does not answer 200, or loads no chunk, is refused by name", async () => {
    await expect(readServedHold(BASE, wire({ [HOLD_PROBE_PATH]: { status: 500, text: "" } }).fetchText)).rejects.toThrow(/HTTP 500/);
    await expect(readServedHold(BASE, wire({ [HOLD_PROBE_PATH]: { status: 200, text: html() } }).fetchText)).rejects.toThrow(ServedHoldUnreadable);
  });

  it("a chunk the page names but the server cannot serve is refused by name (a build whose static files were never staged)", async () => {
    const w = wire({ [HOLD_PROBE_PATH]: { status: 200, text: html("/_next/static/chunks/pad.js") } });
    await expect(readServedHold(BASE, w.fetchText)).rejects.toThrow(/\/_next\/static\/chunks\/pad\.js.*HTTP 404/);
  });
});

describe("assertHoldMatches: the shell's value against the served build's", () => {
  it("equal passes; unequal is refused by name with both values and the env var to fix", () => {
    expect(() => assertHoldMatches({ served: 3000, shell: 3000 })).not.toThrow();
    const e = (() => { try { assertHoldMatches({ served: PRODUCT_DEFAULT, shell: 3000 }); } catch (x) { return x; } return null; })();
    expect(e).toBeInstanceOf(HoldMismatch);
    expect(e).toMatchObject({ name: "HoldMismatch", served: PRODUCT_DEFAULT, shell: 3000 });
    expect(String((e as Error).message)).toContain(HOLD_ENV);
  });
});
