// The hold window the SERVED build was baked with (W1c Task 8, carry M-6).
//
// Every browser budget is priced in HOLD_MS (budget.ts, class 20), and the
// harness reads it from its own shell (holdMsFromEnv). The build bakes its own
// copy into the client bundle (queue.ts: `resolveHoldMs(process.env.
// NEXT_PUBLIC_SCOREPAD_HOLD_MS)`, the env value inlined as a string literal).
// When the two differ — a shell exporting 3000 against a build left at the
// default 10000 — every held tap is under-budgeted by 7 s, and the timeout
// reads as a product NoProductResponse. So a browser run reads the value out
// of the served chunk and refuses a mismatch by name before any case runs.
//
// Where it is read: the device-link page for a dead token. It renders the
// dead-link screen, and its HTML still loads the route's client chunks, the
// scoring pad's among them (observed on a prod build, W1c Task 8). It needs
// no session, no org and no fixture, so it can run before any case exists.
import { HOLD_ENV, HOLD_MS_DEFAULT, MIN_HOLD_MS, FLOOR_MS, holdMsFromEnv } from "./budget.ts";

/** /score/{token} with a token no link was ever issued for. */
export const HOLD_PROBE_PATH = "/score/dl_matrix-hold-probe";

/** The served build's hold value could not be read: the probe page or a chunk
 *  did not load, no chunk carries the resolver, two chunks disagree, or its
 *  argument is not a value the harness can evaluate. Never guessed. */
export class ServedHoldUnreadable extends Error {
  constructor(detail: string) {
    super(`browser: the served build's hold window (${HOLD_ENV}) could not be read — ${detail}`);
    this.name = "ServedHoldUnreadable";
  }
}

/** The harness shell and the served build disagree on the hold window. */
export class HoldMismatch extends Error {
  readonly served: number;
  readonly shell: number;
  constructor(served: number, shell: number) {
    super(`browser: the served build holds a tap for ${served} ms, but this shell's ${HOLD_ENV} resolves to ${shell} ms — every budget would be priced on the wrong window. Export the value the server was built with (or rebuild it with this one) and rerun.`);
    this.name = "HoldMismatch";
    this.served = served;
    this.shell = shell;
  }
}

const NUM = String.raw`(\d+(?:\.\d+)?(?:e\d+)?)`;
const ID = String.raw`[\w$]+`;
/** queue.ts's resolveHoldMs as the minifier writes it, applied at once to the
 *  inlined env value: `…""===e.trim())return 1e4;let t=Number(e);return!Number
 *  .isFinite(t)||t<500?1e4:t}("3000")`. Groups: the blank default, the parsed
 *  name, the floor, the fallback default, the argument text. */
const RESOLVER = new RegExp(String.raw`\.trim\(\)\)return ${NUM};let (${ID})=Number\(${ID}\);return!Number\.isFinite\(\2\)\|\|\2<${NUM}\?${NUM}:\2\}\(([^()]*)\)`, "g");

/** The value one applied argument resolves to, by the product's own rule
 *  (holdMsFromEnv mirrors resolveHoldMs; browser-budget.test.ts pins that). */
function argValue(arg: string): number {
  const a = arg.trim();
  const lit = /^"([^"\\]*)"$|^'([^'\\]*)'$/.exec(a);
  if (lit !== null) return holdMsFromEnv({ [HOLD_ENV]: lit[1] ?? lit[2] });
  if (a === "void 0" || a === "undefined") return holdMsFromEnv({});
  throw new ServedHoldUnreadable(`the resolver is applied to \`${a}\`, which is not a literal the harness can evaluate`);
}

export interface ServedHold { holdMs: number; found: number; scanned: number }

/** The hold value the given chunks were baked with. Every chunk is scanned;
 *  the resolver must appear at least once, with the product's constants, and
 *  every appearance must agree. */
export function servedHoldFrom(chunks: readonly { url: string; text: string }[]): ServedHold {
  const values = new Map<number, string>();
  let found = 0;
  for (const c of chunks) {
    for (const m of c.text.matchAll(RESOLVER)) {
      const [, blank, , floor, fallback, arg] = m;
      if (Number(blank) !== HOLD_MS_DEFAULT || Number(fallback) !== HOLD_MS_DEFAULT || Number(floor) !== MIN_HOLD_MS) {
        throw new ServedHoldUnreadable(`${c.url} carries the resolver with default ${blank}/${fallback} and floor ${floor}, not the product's ${HOLD_MS_DEFAULT} and ${MIN_HOLD_MS} — its rule is not the one holdMsFromEnv mirrors`);
      }
      found++;
      const v = argValue(arg ?? "");
      if (!values.has(v)) values.set(v, c.url);
    }
  }
  if (found === 0) throw new ServedHoldUnreadable(`scanned ${chunks.length} chunk(s), found 0 carrying the resolver`);
  if (values.size > 1) throw new ServedHoldUnreadable(`the chunks disagree: ${[...values].map(([v, u]) => `${v} ms in ${u}`).join(", ")}`);
  return { holdMs: [...values.keys()][0], found, scanned: chunks.length };
}

/** One GET: its status and body text. */
export type FetchText = (url: string) => Promise<{ status: number; text: string }>;

/** Global fetch, bounded by the navigation floor. */
export const fetchText: FetchText = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(FLOOR_MS), redirect: "follow" });
  return { status: r.status, text: await r.text() };
};

const CHUNK_SRC = /<script\b[^>]*\bsrc="(\/_next\/static\/chunks\/[^"]+\.js)"/g;

/** Reads the hold window from the server at `base`: the probe page, then every
 *  distinct chunk it loads, in page order. */
export async function readServedHold(base: string, get: FetchText = fetchText): Promise<ServedHold> {
  const origin = new URL(base).origin;
  const page = await get(`${origin}${HOLD_PROBE_PATH}`);
  if (page.status !== 200) throw new ServedHoldUnreadable(`GET ${HOLD_PROBE_PATH} answered HTTP ${page.status}`);
  const srcs = [...new Set([...page.text.matchAll(CHUNK_SRC)].map((m) => m[1]))];
  if (srcs.length === 0) throw new ServedHoldUnreadable(`GET ${HOLD_PROBE_PATH} loads no /_next/static/chunks script`);
  const chunks: { url: string; text: string }[] = [];
  for (const src of srcs) {
    const r = await get(`${origin}${src}`);
    if (r.status !== 200) throw new ServedHoldUnreadable(`GET ${src} (named by ${HOLD_PROBE_PATH}) answered HTTP ${r.status}`);
    chunks.push({ url: src, text: r.text });
  }
  return servedHoldFrom(chunks);
}

/** Refuses a shell whose hold window is not the served build's. */
export function assertHoldMatches(o: { served: number; shell: number }): void {
  if (o.served !== o.shell) throw new HoldMismatch(o.served, o.shell);
}
