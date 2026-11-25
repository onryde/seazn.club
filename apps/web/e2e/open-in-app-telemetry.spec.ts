// LOCAL PROBE, not run by CI (CI's e2e builds set no PostHog key, so the SDK never starts there). It answers the one
// question the "Open in app" buttons raise (spec 2026-11-25 §5.5): their hrefs are live credentials on pages that run
// analytics — does any of them leave the browser? It reads the REAL outgoing PostHog payloads, consent accepted, with
// autocapture, heatmaps, dead clicks and session recording all switched on, and every body decoded (gzip, base64, and
// the recorder's own inner gzip of snapshot frames).
//
// NOTHING REACHES POSTHOG: every /ingest/ request is answered here, the recorder script comes out of node_modules, and
// any other posthog.com request is aborted.
//
// Run: build with NEXT_PUBLIC_OPEN_IN_APP=1 and a DUMMY NEXT_PUBLIC_POSTHOG_KEY (NEXT_PUBLIC_POSTHOG_API_HOST unset, so
// the SDK posts to /ingest), then `E2E_POSTHOG_PROBE=1 npx playwright test e2e/open-in-app-telemetry.spec.ts`.
//
// The scrubber (`before_send`) is a second layer for autocapture only; replay has the class and nothing else.
//
// Anti-vacuity, in the same walk: the clicks on ordinary buttons beside each code DO arrive as $autocapture, the replay
// DOES carry the page around the blocks, and compressed frames ARE opened. The second test strips `ph-no-capture` from
// the block as it is drawn: the same detection then sees the Open in app anchor in both channels, and the replay then
// carries all four link secrets, so their absence in the first test is the class's doing and not a blind probe.
import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { activeOrg, competitionPath, fixturePath, TAG } from "./helpers";
import { waitForHydration } from "./directory-kit";
import { holdRemoteScoringOpen, openConsolePanel } from "./helpers/console-panels";
import { openCourtOnPhone, openPhoneTab, seedCourtInPlay, seedGenericDivision, seedStreamRig, seedYoutubeDestination } from "./helpers/open-in-app-seeds";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../src/lib/consent";

const STEP_MS = 20_000;
/** Longer than posthog-js's 3 s request batch and its recorder's 2 s buffer, with room. */
const FLUSH_MS = 8_000;
const DIST = fileURLToPath(new URL("../node_modules/posthog-js/dist/", import.meta.url));

test.skip(process.env.E2E_POSTHOG_PROBE !== "1", "local probe: needs a build with a dummy NEXT_PUBLIC_POSTHOG_KEY (see the header)");
test.use({ userAgent: devices["Pixel 7"].userAgent, viewport: { width: 390, height: 844 }, hasTouch: true });

interface PostHogEvent { event?: string; properties?: Record<string, unknown> }

interface Capture {
  /** Every ingest body, decoded to its final text (inner snapshot frames opened). */
  texts: string[];
  events: PostHogEvent[];
  /** How many compressed bodies and inner compressed strings were opened. */
  opened: { bodies: number; inner: number };
  /** Every request the context made, for the URL, header and third-party checks. */
  requests: { url: string; headers: Record<string, string>; body: string }[];
  paths: Set<string>;
}

/** The recorder gzips big frames INSIDE the event, as latin1 strings (gzip magic first): open every one, at any depth. */
function openInner(value: unknown, c: Capture): unknown {
  if (typeof value === "string") {
    if (value.length > 2 && value.charCodeAt(0) === 0x1f && value.charCodeAt(1) === 0x8b) {
      const raw = gunzipSync(Buffer.from(value, "latin1")).toString("utf8");
      c.opened.inner += 1;
      try {
        return openInner(JSON.parse(raw), c);
      } catch {
        return raw;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => openInner(v, c));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, openInner(v, c)]));
  return value;
}

function decodeBody(body: Buffer, c: Capture): string {
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    c.opened.bodies += 1;
    return gunzipSync(body).toString("utf8");
  }
  const text = body.toString("utf8");
  if (text.startsWith("data=")) {
    c.opened.bodies += 1;
    return Buffer.from(new URLSearchParams(text).get("data")!, "base64").toString("utf8");
  }
  return text;
}

const REMOTE_CONFIG = {
  supportedCompression: ["gzip-js"],
  autocapture_opt_out: false,
  captureDeadClicks: true,
  heatmaps: true,
  capturePerformance: { network_timing: true, web_vitals: false },
  sessionRecording: { endpoint: "/s/", consoleLogRecordingEnabled: false, recorderVersion: "v2", networkPayloadCapture: { recordBody: true, recordHeaders: true } },
  hasFeatureFlags: false,
  featureFlags: {},
  flags: {},
  surveys: false,
};

async function intercept(context: BrowserContext): Promise<Capture> {
  const c: Capture = { texts: [], events: [], opened: { bodies: 0, inner: 0 }, requests: [], paths: new Set() };
  context.on("request", (r) => {
    c.requests.push({ url: r.url(), headers: r.headers(), body: r.postDataBuffer()?.toString("latin1") ?? "" });
  });
  await context.route(/posthog\.com/, (route) => route.abort());
  await context.route("**/ingest/**", async (route) => {
    const url = new URL(route.request().url());
    c.paths.add(url.pathname.replace(/\/phc_[^/]+/, "/<key>"));
    if (url.pathname.includes("/static/")) {
      const file = join(DIST, url.pathname.split("/").pop()!);
      if (existsSync(file)) return route.fulfill({ contentType: "application/javascript", body: readFileSync(file) });
      return route.fulfill({ status: 404, body: "" });
    }
    if (url.pathname.endsWith("/config.js")) return route.fulfill({ status: 404, body: "" });
    const body = route.request().postDataBuffer();
    if (body !== null && !url.pathname.includes("/flags") && !url.pathname.includes("/decide")) {
      const parsed: unknown = JSON.parse(decodeBody(body, c));
      const opened = openInner(parsed, c);
      c.texts.push(JSON.stringify(opened));
      const batch = Array.isArray(opened) ? opened : ((opened as { batch?: unknown[] }).batch ?? [opened]);
      c.events.push(...(batch as PostHogEvent[]));
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(REMOTE_CONFIG) });
  });
  return c;
}

/** Consent accepted before any script runs; the automation flags posthog-js treats as a bot (and drops everything for)
 *  hidden; the two links held on the page, so the tap is recorded and the batch flushes from the same document. */
async function prepare(page: Page, strip: boolean): Promise<void> {
  await page.addInitScript(
    ([key, versionKey, version, stripClass]) => {
      localStorage.setItem(key as string, "accepted");
      localStorage.setItem(versionKey as string, version as string);
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
      document.addEventListener(
        "click",
        (e) => {
          if ((e.target as Element).closest?.('[data-testid="open-in-app"], [data-testid="score-in-browser-link"]')) e.preventDefault();
        },
        true,
      );
      if (stripClass) {
        // Registered before the recorder's own observer, so the class is gone before the block is ever serialised.
        const bare = () => document.querySelectorAll('[data-testid="open-in-app-block"], [data-testid="open-in-app-block"] .ph-no-capture').forEach((el) => el.classList.remove("ph-no-capture"));
        new MutationObserver(bare).observe(document, { childList: true, subtree: true });
      }
    },
    [CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION, strip] as const,
  );
}

/** Wait until the SDK and its recorder are running: a walk that started before them would find nothing and prove nothing.
 *  The recorder holds its frames until it sees someone use the page, so the pointer moves while we wait. */
async function recorderUp(c: Capture, page: Page, from: number): Promise<void> {
  let step = 0;
  await expect
    .poll(
      async () => {
        step += 1;
        await page.mouse.move(40 + (step % 7) * 12, 200 + (step % 5) * 12);
        return c.events.slice(from).some((e) => e.event === "$snapshot");
      },
      { message: "session recording is sending", timeout: 30_000 },
    )
    .toBe(true);
  await page.waitForTimeout(500);
}

/** Taps each of the block's links, then a QR neighbour, and lets everything flush. */
async function tapBlock(page: Page, testIds: string[]): Promise<void> {
  for (const id of testIds) {
    const link = page.getByTestId(id);
    await expect(link).toBeVisible({ timeout: STEP_MS });
    await link.tap();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(FLUSH_MS);
}

interface Secrets { name: string; value: string }
function secretsOfStream(href: string, surface: string): Secrets[] {
  const fragment = href.split("#")[1]!;
  const qr = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as { code: string; tok: string };
  return [
    { name: `${surface} link fragment`, value: fragment },
    { name: `${surface} QR token`, value: qr.tok },
    { name: `${surface} QR code`, value: qr.code },
  ];
}

/** The whole walk: all four codes, both links of the scoring block. Returns what must never leave, and what did. */
async function walk(page: Page, c: Capture): Promise<Secrets[]> {
  const secrets: Secrets[] = [];
  const hrefOf = async (id = "open-in-app") => (await page.getByTestId(id).getAttribute("href"))!;

  // 1. Remote scoring on the fixture console.
  const stream = await seedStreamRig(page);
  const scoring = await seedGenericDivision(page.request, "probe");
  await holdRemoteScoringOpen(page);
  let from = c.events.length;
  await page.goto(await fixturePath(page.request, scoring.fixtureId));
  await openConsolePanel(page, "handover");
  const panel = page.locator('[data-role="device-link-panel"]');
  await expect(panel.getByTestId("device-link-mint")).toBeVisible({ timeout: STEP_MS });
  await recorderUp(c, page, from);
  await panel.getByTestId("device-link-mint").click();
  await expect(panel.getByTestId("open-in-app")).toBeVisible({ timeout: STEP_MS });
  const scoreHref = await hrefOf();
  const secret = scoreHref.split("#")[1]!;
  expect(secret).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
  secrets.push({ name: "scoring link secret", value: secret });
  await tapBlock(page, ["open-in-app", "score-in-browser-link"]);

  // 2. The fixture's Phone stream card (the same fresh org).
  from = c.events.length;
  await page.goto(await fixturePath(page.request, stream.fixtureId));
  await openPhoneTab(page, STEP_MS);
  await expect(page.getByTestId("stream-code-card").getByTestId("open-in-app")).toBeVisible({ timeout: STEP_MS });
  await recorderUp(c, page, from);
  secrets.push(...secretsOfStream(await hrefOf(), "fixture stream"));
  await tapBlock(page, ["open-in-app"]);

  // 3 and 4. Match Day: the code sheet, then the court stream sheet, on a court of this org.
  const day = await seedCourtInPlay(page.request, "probe");
  const label = `Probe channel ${day.nonce} ${TAG}`;
  await seedYoutubeDestination((await activeOrg(page)).id, label);
  from = c.events.length;
  await page.goto(await competitionPath(page.request, day.competitionId, "/match-day"), { waitUntil: "load" });
  await waitForHydration(page.getByTestId("md-code-open"));
  await recorderUp(c, page, from);
  await page.getByTestId("md-code-open").click();
  await page.getByTestId("md-code-sheet").getByTestId("md-code-mint").click();
  await expect(page.getByTestId("md-code-sheet").getByTestId("open-in-app")).toBeVisible({ timeout: STEP_MS });
  const dayToken = (await hrefOf()).split("#")[1]!;
  expect(dayToken).toMatch(/^md_/);
  secrets.push({ name: "Match Day code token", value: dayToken });
  await tapBlock(page, ["open-in-app"]);

  from = c.events.length;
  await page.goto(await competitionPath(page.request, day.competitionId, "/match-day"), { waitUntil: "load" });
  await openCourtOnPhone(page, STEP_MS);
  await recorderUp(c, page, from);
  await page.getByTestId("md-cs-link").click();
  await page.getByTestId("md-cs-sheet").getByRole("radio", { name: label }).check();
  await page.getByTestId("md-cs-link-confirm").click();
  await expect(page.getByTestId("md-cs-qr-image")).toBeVisible({ timeout: STEP_MS });
  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("md-cs-qr-image") });
  await expect(dialog.getByTestId("open-in-app")).toBeVisible();
  secrets.push(...secretsOfStream(await hrefOf(), "court stream"));
  await tapBlock(page, ["open-in-app"]);

  for (const s of secrets) expect(s.value.length, `${s.name}: long enough that a hit is a hit`).toBeGreaterThanOrEqual(12); // the QR's own `code` is 12
  expect(secrets.length).toBe(8);
  return secrets;
}

const autocaptures = (c: Capture) => c.events.filter((e) => e.event === "$autocapture").map((e) => JSON.stringify(e.properties));
const snapshots = (c: Capture) => c.events.filter((e) => e.event === "$snapshot").map((e) => JSON.stringify(e.properties));
const hits = (haystacks: string[], needle: string) => haystacks.filter((h) => h.includes(needle) || h.includes(encodeURIComponent(needle))).length;

function summary(c: Capture) {
  const byEvent: Record<string, number> = {};
  for (const e of c.events) byEvent[e.event ?? "(none)"] = (byEvent[e.event ?? "(none)"] ?? 0) + 1;
  return { bodies: c.texts.length, byEvent, opened: c.opened, requests: c.requests.length, ingestPaths: [...c.paths].sort() };
}

test("no PostHog payload, request URL, referrer or third-party body carries any code the buttons hold", async ({ page, context, baseURL }, info) => {
  test.setTimeout(420_000);
  const c = await intercept(context);
  await prepare(page, false);
  const secrets = await walk(page, c);
  const report = summary(c);
  console.log("PROBE", JSON.stringify(report));
  writeFileSync(info.outputPath("posthog-payloads.json"), c.texts.join("\n"));

  // Positive controls: the interception sees events, autocapture sees ordinary clicks beside the codes, the replay
  // carries the pages the codes are on, and compressed frames were opened.
  const auto = autocaptures(c);
  for (const ordinary of ["device-link-mint", "md-code-mint", "md-cs-link-confirm"]) {
    expect(hits(auto, ordinary), `autocapture saw the click on ${ordinary}`).toBeGreaterThan(0);
  }
  const replay = snapshots(c);
  expect(replay.length, "replay frames arrived").toBeGreaterThan(0);
  for (const around of ["device-link-panel", "stream-code-card", "md-code-sheet", "md-cs-qr"]) {
    expect(hits(replay, around), `the replay carries ${around}`).toBeGreaterThan(0);
  }
  expect(c.opened.bodies + c.opened.inner, "compressed payloads were opened").toBeGreaterThan(0);

  // The blocks themselves are invisible to both channels.
  expect(hits(auto, "open-in-app"), "no autocapture event names Open in app").toBe(0);
  expect(hits(auto, "score-in-browser-link"), "no autocapture event names Score in browser").toBe(0);
  expect(hits(replay, "/app/score#"), "no replay frame holds an app link").toBe(0);
  expect(hits(replay, "/app/stream#")).toBe(0);
  expect(hits(replay, "/app/day#")).toBe(0);

  // And no secret leaves, anywhere.
  const origin = new URL(baseURL!).origin;
  let checked = 0;
  const leaks: string[] = [];
  for (const s of secrets) {
    if (hits(c.texts, s.value) > 0) leaks.push(`${s.name}: in a decoded PostHog payload`);
    for (const r of c.requests) {
      if (r.url.includes(s.value)) leaks.push(`${s.name}: in a request URL (${new URL(r.url).host}${new URL(r.url).pathname.slice(0, 40)})`);
      if ((r.headers["referer"] ?? "").includes(s.value)) leaks.push(`${s.name}: in a Referer`);
      if (new URL(r.url).origin !== origin && (r.body.includes(s.value) || Object.values(r.headers).some((h) => h.includes(s.value)))) {
        leaks.push(`${s.name}: in a third-party request (${new URL(r.url).host})`);
      }
    }
    checked += 1;
  }
  expect(checked).toBe(secrets.length);
  expect(leaks, leaks.join("\n")).toEqual([]);
});

test("control: with ph-no-capture stripped from the block, autocapture and replay both see the Open in app anchor", async ({ page, context }) => {
  test.setTimeout(420_000);
  const c = await intercept(context);
  await prepare(page, true);
  const secrets = await walk(page, c);
  const auto = autocaptures(c);
  const replay = snapshots(c);
  const inAuto = hits(auto, "open-in-app");
  const inReplay = hits(replay, "open-in-app");
  console.log("CONTROL", JSON.stringify({ ...summary(c), inAuto, inReplay }));
  expect(inAuto, "autocapture records the anchor once the class is gone").toBeGreaterThan(0);
  expect(inReplay, "the replay records the block once the class is gone").toBeGreaterThan(0);

  // The two layers, told apart. Autocapture goes through `before_send`, whose scrubber takes the codes out even with the
  // class gone. Replay frames are compressed before `before_send` sees them, so the class is their ONLY guard: every
  // link's own secret (the fragment) is in them without it.
  let scrubbed = 0;
  for (const s of secrets) {
    expect(hits(auto, s.value), `${s.name}: the before_send scrubber keeps it out of autocapture`).toBe(0);
    scrubbed += 1;
  }
  expect(scrubbed).toBe(8);
  const links = secrets.filter((s) => /link (secret|fragment)$|Match Day code token$/.test(s.name));
  expect(links.length).toBe(4);
  for (const s of links) expect(hits(replay, s.value), `${s.name}: without the class the replay carries it`).toBeGreaterThan(0);
});
