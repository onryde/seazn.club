import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loginUi, withDb, TAG } from "./helpers";

// Revshare affiliate attribution, browser half (see lib/revshare.ts and lib/revshare-script.ts):
//   affiliate landing -> the browser adds tracking.js -> window.revshare_metadata.ref_code
//   -> <RevshareCapture> writes the first-party `rs_ref` cookie
//   -> a FRESH signup's org is stamped organizations.revshare_ref_code.
// The invoice -> Revshare half has no browser; it is pinned by
// revshare-sale-seam.test.ts (real runEvent) and the smoke suite.
//
// And what the script may SEE. The real file records the page's address and referrer and sends them to revshare.so,
// so it is added on affiliate landings only, never in front of a URL that holds a credential.
//
// NOTHING here reaches revshare.so: every request to it is answered at the network edge (stubRevshare), and the
// browser cannot resolve the host at all (the flag below), so a request the stub missed would fail, not leave. The
// stand-in script is deliberately NOSIER than the real one (it also watches every address change), so "it never saw a
// credential page" does not rest on the real file having no navigation hooks today.
//
// Every visitor is a genuinely anonymous context — the project storageState is
// the authed Pro owner, whose session would make each "signup" below vacuous.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP revshare.so 127.0.0.1:1, MAP *.revshare.so 127.0.0.1:1"] } });

const anon = (b: Browser) => b.newContext({ storageState: { cookies: [], origins: [] } });

const TRACKING_URL = "https://www.revshare.so/tracking.js";
const PROGRAM_ID = "6ac5012c6a42960a11fbb86b";
const VISITS_KEY = `revshare_visits_${PROGRAM_ID}`;
const BASE = new URL(process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000").origin;
const OLD_SECRET = `dl_${"s".repeat(43)}`;

const FAKE_TRACKER = `(function () {
  var pid = document.currentScript.getAttribute("data-program-id");
  var key = "revshare_visits_" + pid;
  var seen = function (how) { console.log("RS_SEEN " + how + " " + location.href); };
  seen("execute");
  var q = new URLSearchParams(location.search);
  var code = q.get("via") || q.get("ref");
  var history_ = localStorage.getItem(key);
  fetch("https://www.revshare.so/api/tracking/click", { method: "POST", mode: "cors", credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: location.href, referrer: document.referrer, previous_visits: history_ ? JSON.parse(history_) : [] }) });
  localStorage.setItem(key, JSON.stringify([{ url: location.href, referrer: document.referrer }]));
  if (code) document.cookie = "revshare_ref_" + pid + "=" + encodeURIComponent(code) + "; path=/";
  window.revshare_metadata = { ref_code: code };
  ["pushState", "replaceState"].forEach(function (m) {
    var write = history[m];
    history[m] = function () { var r = write.apply(this, arguments); seen(m); return r; };
  });
  addEventListener("popstate", function () { seen("popstate"); });
  setInterval(function () { seen("timer"); }, 20);
})();`;

interface Revshare {
  /** Every request any page of the context made to a revshare.so host. */
  requests: string[];
  /** The click payloads the stand-in script posted. */
  clicks: { url: string; referrer: string; previous_visits: unknown[] }[];
  /** Every address the stand-in script ever read, from any document of the context. */
  seen: string[];
  /** CSP violations naming revshare.so (reported in report-only and enforced alike). */
  blocked: string[];
  /** Let a held tracking.js through. */
  release: () => void;
}

async function stubRevshare(ctx: BrowserContext, opts: { hold?: boolean } = {}): Promise<Revshare> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    if (!opts.hold) resolve();
  });
  const rs: Revshare = { requests: [], clicks: [], seen: [], blocked: [], release: () => release() };
  await ctx.route(
    (url) => url.hostname === "revshare.so" || url.hostname.endsWith(".revshare.so"),
    async (route) => {
      const url = route.request().url();
      rs.requests.push(url);
      if (url === TRACKING_URL) {
        await gate;
        // The document that asked may be gone by now (a held script across a navigation).
        await route.fulfill({ contentType: "application/javascript", body: FAKE_TRACKER }).catch(() => {});
        return;
      }
      if (url.endsWith("/api/tracking/click")) rs.clicks.push(route.request().postDataJSON() as Revshare["clicks"][number]);
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: "{}" });
    },
  );
  ctx.on("console", (m) => {
    const text = m.text();
    if (text.startsWith("RS_SEEN ")) rs.seen.push(text.split(" ")[2]!);
    if (text.startsWith("RS_BLOCKED ")) rs.blocked.push(text);
  });
  await ctx.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.blockedURI.includes("revshare")) console.log(`RS_BLOCKED ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return rs;
}

/** Seed the history an earlier visit left behind, once per context: before any script of the first page runs. */
async function seedOldHistory(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(
    ([key, secret]) => {
      if (document.cookie.includes("rs_e2e_seeded=1")) return;
      document.cookie = "rs_e2e_seeded=1; path=/";
      localStorage.setItem(key!, JSON.stringify([{ url: `https://seazn.club/score/${secret}` }]));
      localStorage.setItem("rs_e2e_other", "keep");
    },
    [VISITS_KEY, OLD_SECRET],
  );
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const tags = (page: Page) => page.locator(`script[src="${TRACKING_URL}"]`);
const everythingSent = (rs: Revshare) => JSON.stringify([rs.requests, rs.clicks, rs.seen]);

/** Sign a brand-new person up and return the stamped ref_code of the org they got. */
async function signUpAndReadStamp(page: Page, label: string): Promise<string | null> {
  const email = `delivered+rs-${label}-${TAG}@resend.dev`;
  await loginUi(page, email);
  // The org is auto-provisioned on the first console render.
  await page.goto("/dashboard");
  await expect
    .poll(
      async () =>
        withDb(async (sql) => {
          const rows = await sql<{ n: number }[]>`
            select count(*)::int as n from organizations o
              join users u on u.id = o.created_by where u.email = ${email}`;
          return rows[0].n;
        }),
      { message: "the new user should own exactly one org", timeout: 20_000 },
    )
    .toBe(1);
  return withDb(async (sql) => {
    // The ref_code lives on the billing GROUP the org pays through, not on the org.
    const rows = await sql<{ revshare_ref_code: string | null }[]>`
      select s.revshare_ref_code from organizations o
        join subscriptions s on s.id = o.subscription_id
        join users u on u.id = o.created_by where u.email = ${email}`;
    return rows[0].revshare_ref_code;
  });
}

const cookieValue = async (ctx: BrowserContext, name = "rs_ref") =>
  (await ctx.cookies()).find((c) => c.name === name)?.value;

// NEXT_PUBLIC_REVSHARE_ENABLED is baked at BUILD time and defaults off, and e2e.yml
// deliberately does not turn it on (every e2e affiliate landing would then ask for the real
// revshare.so script). So this spec runs only against a server built with the
// switch on — locally: NEXT_PUBLIC_REVSHARE_ENABLED=1 seazn-env rebuild — and the
// test process must carry the same value so it knows which build it is driving.
test.describe("revshare affiliate attribution", () => {
  test.skip(
    process.env.NEXT_PUBLIC_REVSHARE_ENABLED !== "1",
    "needs a server built with NEXT_PUBLIC_REVSHARE_ENABLED=1 (and the same value in this process)",
  );

  // A prefixed marketing page carries the nonce policy; "/" is the unprefixed rewrite; /blog has the fixed policy.
  for (const path of ["/", "/fr/pricing", "/blog"]) {
    test(`an affiliate landing on ${path} adds the tag, after the old history is purged, and the policy lets it post`, async ({ browser }) => {
      const ctx = await anon(browser);
      const rs = await stubRevshare(ctx);
      await seedOldHistory(ctx);
      const page = await ctx.newPage();
      await page.goto(`${path}?ref=aff_1`);
      const tag = page.locator(`head script[src="${TRACKING_URL}"]`);
      await expect(tag).toHaveCount(1);
      await expect(tag).toHaveAttribute("data-program-id", PROGRAM_ID);
      await expect(tag).toHaveAttribute("data-domain", ".seazn.club");
      await expect(tag).toHaveAttribute("data-cookie-duration", "30");
      await expect(tag).toHaveJSProperty("async", true);
      await expect.poll(() => rs.clicks.length).toBe(1);
      expect(rs.clicks[0]).toEqual({ url: `${BASE}${path}?ref=aff_1`, referrer: "", previous_visits: [] });
      expect(everythingSent(rs)).not.toContain(OLD_SECRET);
      expect(await stored(page, "rs_e2e_other"), "the seed ran, and only the visit history went").toBe("keep");
      expect(rs.blocked).toEqual([]);
      await expect.poll(() => cookieValue(ctx)).toBe("aff_1");

      // What the script stored on this landing is gone on the next load, which does not load it.
      expect(await stored(page, VISITS_KEY), "premise: the script stored a visit").toContain("aff_1");
      await page.goto("/pricing");
      await expect.poll(() => stored(page, VISITS_KEY)).toBeNull();
      await expect(tags(page)).toHaveCount(0);
      await ctx.close();
    });
  }

  // [name, the path to open, the referrer the browser reports (a path on this origin), if any]
  const REFUSED: [string, string, string?][] = [
    ["a public page with no affiliate parameter", "/"],
    ["a claim link with ?ref=", `/claim/pc_${"c".repeat(43)}?ref=aff_1`],
    ["a scoring link with ?ref=", `/score/dl_${"d".repeat(43)}?ref=aff_1`],
    ["a sign-in link with ?ref=", "/magic-link?token=not-a-real-token&ref=aff_1"],
    ["a public page with a secret in its query", "/pricing?ref=aff_1&token=abc123"],
    ["a public page that is not on the allow-list", "/legal/privacy?ref=aff_1"],
    ["an affiliate landing reached FROM a sign-in link", "/?ref=aff_1", "/magic-link?token=not-a-real-token"],
    ["an affiliate landing reached FROM a signed-in page", "/?ref=aff_1", "/dashboard"],
  ];
  for (const [name, path, referrer] of REFUSED) {
    test(`not loaded, old history still purged: ${name}`, async ({ browser }) => {
      const ctx = await anon(browser);
      const rs = await stubRevshare(ctx);
      await seedOldHistory(ctx);
      const page = await ctx.newPage();
      await page.goto(path, referrer ? { referer: `${BASE}${referrer}` } : {});
      // The purge and the decision are one synchronous call: once the purge shows, the tag would be there too.
      await expect.poll(() => stored(page, VISITS_KEY), { message: "the page must have mounted and purged" }).toBeNull();
      // Anti-vacuity: the page really is the one under test, with the referrer under test.
      expect(await stored(page, "rs_e2e_other")).toBe("keep");
      expect(new URL(page.url()).pathname).toBe(new URL(path, BASE).pathname);
      expect(await page.evaluate(() => document.referrer)).toBe(referrer ? `${BASE}${referrer}` : "");
      await expect(tags(page)).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      expect(rs.requests).toEqual([]);
      await ctx.close();
    });
  }

  test("not loaded on the staff GET form: /admin/capture-records?ref= as real staff", async ({ browser }) => {
    const email = `delivered+rs-staff-${TAG}@resend.dev`;
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx);
    const page = await ctx.newPage();
    await loginUi(page, email);
    await withDb((sql) => sql`update users set is_staff = true, staff_role = 'superadmin' where email = ${email}`);
    try {
      await page.evaluate((k) => localStorage.setItem(k, "[]"), VISITS_KEY);
      await page.goto("/admin/capture-records?ref=abc123");
      await expect.poll(() => stored(page, VISITS_KEY)).toBeNull();
      expect(new URL(page.url()).pathname, "staff really reached the page (not bounced to /login)").toBe("/admin/capture-records");
      expect(new URL(page.url()).search).toBe("?ref=abc123");
      await expect(tags(page)).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      expect(rs.requests).toEqual([]);
    } finally {
      await withDb((sql) => sql`update users set is_staff = false, staff_role = null where email = ${email}`);
    }
    await ctx.close();
  });

  /** Marks this document, so a later check can tell a client-side navigation from a new document. */
  const mark = (page: Page) => page.evaluate(() => void ((window as unknown as { rsDoc?: 1 }).rsDoc = 1));
  const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { rsDoc?: 1 }).rsDoc === 1);
  const signIn = (page: Page) => page.locator('header a[href="/login"]:visible').first();

  test("after a landing, the router stays client-side between public pages and takes a full load anywhere else", async ({ browser }) => {
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx);
    const page = await ctx.newPage();
    await page.goto("/en/pricing?ref=aff_1");
    await expect.poll(() => rs.clicks.length).toBe(1);
    await mark(page);

    // Public to public: the router's own pushState goes through, and the nosy script sees the new address.
    await page.locator('footer a[href="/affiliates"]').click();
    await expect(page).toHaveURL(/\/affiliates$/);
    await expect(page.getByTestId("affiliates-join")).toBeVisible();
    expect(await sameDocument(page), "positive pair: this was a client-side navigation").toBe(true);
    await expect.poll(() => rs.seen.some((u) => u.endsWith("/affiliates"))).toBe(true);

    // To a page it may not see: the same Link click is a new document, which does not load the script.
    await signIn(page).click();
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => sameDocument(page)).toBe(false);
    await expect(tags(page)).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(rs.seen.length, "premise: the script was reading addresses").toBeGreaterThan(2);
    expect(rs.seen.filter((u) => u.includes("/login"))).toEqual([]);
    expect(rs.requests.filter((u) => u === TRACKING_URL)).toHaveLength(1);
    await ctx.close();
  });

  test("after a landing, a history write to a credential URL never changes this document's address", async ({ browser }) => {
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx);
    const page = await ctx.newPage();
    await page.goto("/en/pricing?ref=aff_1");
    await expect.poll(() => rs.clicks.length).toBe(1);
    await mark(page);
    await page.evaluate(() => window.history.pushState(null, "", "/magic-link?token=e2e-secret-token&next=%2Fme"));
    await expect(page).toHaveURL(/\/magic-link/);
    await expect.poll(() => sameDocument(page)).toBe(false);
    await page.waitForLoadState("networkidle");
    expect(rs.seen.length).toBeGreaterThan(0);
    expect(everythingSent(rs)).not.toContain("e2e-secret-token");
    await ctx.close();
  });

  test("a navigation while the script is still loading: when it runs, it has not seen the new page", async ({ browser }) => {
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx, { hold: true });
    const page = await ctx.newPage();
    await page.goto("/en/pricing?ref=aff_1", { waitUntil: "domcontentloaded" });
    await expect(tags(page)).toHaveCount(1);
    await expect.poll(() => rs.requests.length).toBe(1);
    await mark(page);
    await signIn(page).click();
    await expect(page).toHaveURL(/\/login/);
    rs.release();
    await expect.poll(() => sameDocument(page)).toBe(false);
    await page.waitForLoadState("networkidle");
    expect(rs.seen.filter((u) => u.includes("/login"))).toEqual([]);
    expect(rs.clicks.filter((c) => c.url.includes("/login"))).toEqual([]);
    await ctx.close();
  });

  test("a later page without the script restores rs_ref from the script's first-click cookie", async ({ browser }) => {
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx);
    const page = await ctx.newPage();
    await page.goto("/?ref=aff_later");
    await expect.poll(() => cookieValue(ctx)).toBe("aff_later");
    await ctx.clearCookies({ name: "rs_ref" });
    expect(await cookieValue(ctx)).toBeUndefined();
    await page.goto("/start");
    await expect.poll(() => cookieValue(ctx)).toBe("aff_later");
    await expect(tags(page)).toHaveCount(0);
    expect(rs.requests.filter((u) => u === TRACKING_URL)).toHaveLength(1);
    await ctx.close();
  });

  test("an affiliate landing becomes a stamped org after a fresh signup", async ({ browser }) => {
    const ref = `aff_e2e_${TAG}`;
    const ctx = await anon(browser);
    await stubRevshare(ctx);
    const page = await ctx.newPage();
    await page.goto(`/?ref=${ref}`);
    await expect.poll(() => cookieValue(ctx), { message: "RevshareCapture should write rs_ref" }).toBe(ref);
    expect(await signUpAndReadStamp(page, "hit")).toBe(ref);
    await ctx.close();
  });

  test("no affiliate landing -> no cookie and an unstamped org (negative pair)", async ({ browser }) => {
    const ctx = await anon(browser);
    const rs = await stubRevshare(ctx);
    const page = await ctx.newPage();
    await page.goto("/");
    // RevshareCapture polls for 10s before giving up; give it a real chance to
    // (wrongly) write something, then assert nothing was written.
    await page.waitForTimeout(2_000);
    expect(await cookieValue(ctx)).toBeUndefined();
    expect(await signUpAndReadStamp(page, "miss")).toBeNull();
    expect(rs.requests).toEqual([]);
    await ctx.close();
  });

  // Chromium refuses to SET a cookie holding `;`, so those never reach the server
  // through a browser at all; what can arrive is a value Chromium accepts but our
  // alphabet does not — spaces, SQL-ish text, an over-long code.
  for (const [label, value] of [
    ["spaces and SQL-ish text", "x DROP TABLE organizations --"],
    ["65 chars (one over the limit)", "a".repeat(65)],
  ] as const) {
    test(`a hostile rs_ref cookie is never stored on the org: ${label}`, async ({ browser }) => {
      const ctx = await anon(browser);
      const base = new URL(BASE);
      await ctx.addCookies([{ name: "rs_ref", value, domain: base.hostname, path: "/" }]);
      // Anti-vacuity: the hostile cookie really is in the jar when the signup runs.
      expect(await cookieValue(ctx)).toBe(value);
      await stubRevshare(ctx);
      const page = await ctx.newPage();
      await page.goto("/");
      expect(await signUpAndReadStamp(page, `evil-${label.length}`)).toBeNull();
      await ctx.close();
    });
  }
});
