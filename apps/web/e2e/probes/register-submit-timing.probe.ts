// Registration redesign B0 Task 2: submit-latency probe for the PUBLIC register form (spec 2026-11-13-registration-redesign-design.md §3.2, §10).
//
// NOT a Playwright test. The name ends `.probe.ts`, so no project's testMatch selects it (the default is `*.spec|test.ts`; the only
// explicit matches in playwright.config.ts are auth.setup.ts, mobile.spec.ts, the serial spec list and `.capture.ts`). It is a plain
// script on the playwright library, kept in the repo, never run by CI:
//
//   cd apps/web && E2E_TARGET=https://stg.seazn.club ORG_SLUG=<org> COMP_SLUG=<comp> N=10 SHAPES=free1,card1,card3 \
//     node --experimental-strip-types e2e/probes/register-submit-timing.probe.ts
//
// It SUBMITS REAL REGISTRATIONS (N per shape). Point it only at stg, at a competition made for the purpose. Every registrant is
// `delivered+timing-<shape>-<i>@resend.dev` (Resend's sink: delivered, never bounced); the script refuses any other address.
//
// Env:
//   E2E_TARGET   origin of the app under test (required)
//   ORG_SLUG, COMP_SLUG   the default competition; per shape override with COMP_SLUG_<SHAPE> / ORG_SLUG_<SHAPE> (SHAPE upper-cased)
//   N            submits per shape (default 10)
//   SHAPES       comma list of: free1 (1 entry, free), card1 (1 entry, card), card3 (3 entries, card), offline1 (1 entry, offline pay)
//                default free1,card1,card3
//   PACE_MS      pause between submits, default 65000 (route limit: 5 per IP per competition per 300 s)
//   RAW_OUT      append every finished sample as a JSON line
//   START        first email index (default 1); CHANNEL=chrome uses installed Chrome (the bundled Chromium got no Turnstile token in a later run)
//   HEADLESS=1   run headless. DEFAULT IS HEADED: Cloudflare's interaction-only Turnstile yields no token to headless Chromium (measured
//                against stg 2026-11-13: 0 tokens in 30 s headless, a token in <15 s headed). Target must be the PUBLIC host
//                (stg.seazn.club): the site key is not authorised for the *.fly.dev host (widget error 110200).
//
// What it reads: the `Server-Timing` header of the register POST (stage names by name from server/timing.ts: rate_limit, turnstile,
// user, pre_tx.*, tx, mint.*, mail, total; Cloudflare may add its own entries, which are kept apart, not mixed in) and four client
// marks: click on Submit, request sent (the Turnstile token resolved: the POST leaves right after `token()`), response received,
// navigation committed to the status/Stripe URL.
import { appendFileSync } from "node:fs";
import { chromium, type Page, type Request, type Response } from "@playwright/test";

type Shape = "free1" | "card1" | "card3" | "offline1";
const SHAPE_ENTRIES: Record<Shape, number> = { free1: 1, card1: 1, card3: 3, offline1: 1 };

const TARGET = (process.env.E2E_TARGET ?? "").replace(/\/+$/, "");
const N = Number(process.env.N ?? "10");
const PACE_MS = Number(process.env.PACE_MS ?? "65000");
const START = Number(process.env.START ?? "1"); // first email index (to continue after a partial run)
const SHAPES = (process.env.SHAPES ?? "free1,card1,card3").split(",").map((s) => s.trim()) as Shape[];
if (!TARGET) throw new Error("E2E_TARGET is required");
if (!Number.isInteger(N) || N < 1) throw new Error(`N must be a positive integer, got ${process.env.N}`);
for (const s of SHAPES) if (!(s in SHAPE_ENTRIES)) throw new Error(`unknown shape ${s}; one of ${Object.keys(SHAPE_ENTRIES).join(", ")}`);

const SINK = /^delivered\+timing-[a-z0-9]+-\d+@resend\.dev$/;

function slugsFor(shape: Shape): { org: string; comp: string } {
  const up = shape.toUpperCase();
  const org = process.env[`ORG_SLUG_${up}`] ?? process.env.ORG_SLUG;
  const comp = process.env[`COMP_SLUG_${up}`] ?? process.env.COMP_SLUG;
  if (!org || !comp) throw new Error(`ORG_SLUG and COMP_SLUG (or ORG_SLUG_${up}/COMP_SLUG_${up}) are required for ${shape}`);
  return { org, comp };
}

/** "a;dur=1.5, b;dur=2" -> { a: 1.5, b: 2 }. Entries without a `dur` (Cloudflare's `cfEdge;desc=...`) go to `foreign`. */
export function parseServerTiming(header: string): { stages: Record<string, number>; foreign: string[] } {
  const stages: Record<string, number> = {};
  const foreign: string[] = [];
  for (const part of header.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...params] = part.split(";").map((p) => p.trim());
    const dur = params.find((p) => p.startsWith("dur="));
    if (name && dur && Number.isFinite(Number(dur.slice(4))) && /^[a-z_.]+$/.test(name)) stages[name] = Number(dur.slice(4));
    else foreign.push(part);
  }
  return { stages, foreign };
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};

type Sample = { stages: Record<string, number>; foreign: string[]; client: { token: number; server: number; nav: number; wall: number }; status: number };

async function runOne(browser: import("@playwright/test").Browser, shape: Shape, i: number): Promise<Sample> {
  const { org, comp } = slugsFor(shape);
  const email = `delivered+timing-${shape}-${i}@resend.dev`;
  if (!SINK.test(email)) throw new Error(`refusing non-sink email ${email}`);
  const name = `Timing Probe ${shape} ${i}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page: Page = await ctx.newPage();
  try {
    await page.goto(`${TARGET}/live/${org}/${comp}/register`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => null); // hydrate before filling, or the first Next lands on a dead handler
    const next = () => page.getByTestId("reg-next").click();

    // who
    await page.locator("#reg-who-name").fill(name);
    const emailBox = page.locator("#reg-who-email");
    if (await emailBox.isEditable()) {
      if (!SINK.test(email)) throw new Error("email assertion failed before fill");
      await emailBox.fill(email);
    }
    // "I'm playing" makes dob required and links the entry to the registrant; the probe leaves it off and names each entry itself.
    await next();

    // entries: a competition with ONE open division skips the pick (its entry is added already); more than one shows "Add an entry".
    const want = SHAPE_ENTRIES[shape];
    const add = page.getByRole("button", { name: "Add an entry" });
    const rosterNames = page.getByTestId("reg-roster-name");
    await add.or(rosterNames).first().waitFor({ state: "visible", timeout: 30_000 });
    if (await add.first().isVisible()) {
      // DIVS_<SHAPE> ("Open Singles,Masters Singles") picks the division cards by heading text; without it the first still-offered button is clicked.
      const divs = (process.env[`DIVS_${shape.toUpperCase()}`] ?? "").split(",").map((d) => d.trim()).filter(Boolean);
      for (let k = 0; k < want; k++) {
        const btn = divs.length
          ? page.locator(`xpath=//*[normalize-space(text())=${JSON.stringify(divs[k] ?? "")}]/ancestor::*[.//button[contains(.,'Add an entry')]][1]//button[contains(.,'Add an entry')]`).first()
          : page.getByRole("button", { name: "Add an entry" }).first();
        if ((await btn.count()) === 0) throw new Error(`entry ${k + 1} of ${want} could not be added (division ${divs[k] ?? "any"} not offered)`);
        await btn.click();
      }
      await next();
    } else if (want !== 1) {
      throw new Error(`shape ${shape} needs ${want} entries but the competition has one open division (no "Add an entry" step)`);
    }

    // roster names (the entry-details step may ask for a name per entry)
    await rosterNames.first().waitFor({ state: "visible", timeout: 20_000 });
    const rn = await rosterNames.count();
    for (let r = 0; r < rn; r++) if ((await rosterNames.nth(r).inputValue()) === "") await rosterNames.nth(r).fill(`${name} e${r + 1}`);
    await next();

    // consent
    await page.locator("#reg-consent-privacy").check({ timeout: 20_000 });
    await next();

    // review: wait for the submit button AND for the Turnstile widget to have had its chance to mint a token
    const submit = page.getByTestId("reg-submit");
    await submit.waitFor({ state: "visible", timeout: 20_000 });
    if (!SINK.test(email)) throw new Error("email assertion failed before submit");
    // Turnstile: wait (up to 45 s) for the widget's hidden input to hold a token, so the click measures the submit, not the challenge.
    const tokenDeadline = Date.now() + 45_000;
    let hasToken = false;
    while (Date.now() < tokenDeadline && !(hasToken = await page.evaluate(() => (document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value ?? "") !== ""))) await page.waitForTimeout(500);
    if (!hasToken) console.error("  debug:", await page.evaluate(() => ({ inputs: [...document.querySelectorAll("input")].map((i) => i.name).filter((n) => /turn|cf/i.test(n)), iframes: document.querySelectorAll("iframe").length, html: document.querySelector("[class*=turnstile],[data-testid*=turnstile],.cf-turnstile")?.outerHTML.slice(0, 300) })));
    if (!hasToken) throw new Error("no Turnstile token within 45 s (headless? wrong host? the probe will not submit without one)");

    const postPath = `/api/v1/public/orgs/${org}/competitions/${comp}/register`;
    const reqP = page.waitForRequest((r: Request) => r.url().endsWith(postPath) && r.method() === "POST", { timeout: 60_000 });
    const resP = page.waitForResponse((r: Response) => r.url().endsWith(postPath) && r.request().method() === "POST", { timeout: 60_000 });
    const navP = page.waitForURL((u) => !u.pathname.endsWith("/register") || u.search.includes("ref="), { timeout: 90_000, waitUntil: "commit" }).catch(() => null);

    const tClick = Date.now();
    await submit.click();
    const req = await reqP;
    const tReq = Date.now();
    const res = await resP;
    const tRes = Date.now();
    await navP;
    const tNav = Date.now();

    const hdr = (await res.allHeaders())["server-timing"] ?? "";
    const { stages, foreign } = parseServerTiming(hdr);
    if (Object.keys(stages).length === 0) throw new Error(`no Server-Timing stages on the register response (status ${res.status()}); is REGISTER_SERVER_TIMING=1 set on the target?`);
    if (!req.headers()["cf-turnstile-response"]) console.error(`  note: ${shape} #${i} POST carried no cf-turnstile-response (token missing; server may have skipped or refused)`);
    return { stages, foreign, client: { token: tReq - tClick, server: tRes - tReq, nav: tNav - tRes, wall: tNav - tClick }, status: res.status() };
  } finally {
    await ctx.close();
  }
}

function table(shape: Shape, samples: Sample[]): string {
  const names: string[] = [];
  for (const s of samples) for (const k of Object.keys(s.stages)) if (!names.includes(k)) names.push(k);
  const row = (label: string, xs: number[]) => `| ${label} | ${quantile(xs, 0.5).toFixed(1)} | ${quantile(xs, 0.9).toFixed(1)} | ${xs.length} |`;
  const lines = [`### ${shape} (n=${samples.length}, statuses ${[...new Set(samples.map((s) => s.status))].join("/")})`, "", "| metric (ms) | median | p90 | n |", "|---|---|---|---|"];
  for (const n of names) lines.push(row(`server ${n}`, samples.flatMap((s) => (n in s.stages ? [s.stages[n]!] : []))));
  lines.push(row("client click->request (token)", samples.map((s) => s.client.token)));
  lines.push(row("client request->response", samples.map((s) => s.client.server)));
  lines.push(row("client response->navigation", samples.map((s) => s.client.nav)));
  lines.push(row("client click->navigation (wall)", samples.map((s) => s.client.wall)));
  const foreign = [...new Set(samples.flatMap((s) => s.foreign))];
  if (foreign.length) lines.push("", `Non-app Server-Timing entries seen (not tabled): ${foreign.slice(0, 6).join("; ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1", channel: process.env.CHANNEL || undefined, ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] });
  const out: string[] = [`## Register submit timing, ${new Date().toISOString().slice(0, 10)}, target ${TARGET}`, ""];
  try {
    for (const shape of SHAPES) {
      const samples: Sample[] = [];
      for (let i = START; i < START + N; i++) {
        const s = await runOne(browser, shape, i);
        samples.push(s);
        if (process.env.RAW_OUT) appendFileSync(process.env.RAW_OUT, JSON.stringify({ shape, i, ...s }) + "\n"); // a later failure must not lose finished samples
        // The register route limits 5 submits per IP per competition per 300 s (route.ts): space them out or #6 is a 429.
        if (i < START + N - 1) await new Promise((r) => setTimeout(r, PACE_MS));
        console.error(`${shape} #${i}: server total ${s.stages.total ?? "?"} ms, wall ${s.client.wall} ms, HTTP ${s.status}`);
      }
      out.push(table(shape, samples), "");
    }
  } finally {
    await browser.close();
  }
  console.log(out.join("\n"));
}

// Run only as a script, never when imported (parseServerTiming is exported for a unit test).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) await main();
